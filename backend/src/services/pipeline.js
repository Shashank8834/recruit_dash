const { withTransaction } = require('../db');
const messagesRepo = require('../repo/messages');
const submissionsRepo = require('../repo/submissions');
const jdsRepo = require('../repo/jds');
const classificationsRepo = require('../repo/classifications');
const contactsRepo = require('../repo/contacts');
const batchesRepo = require('../repo/batches');
const sheetMirror = require('./sheetMirror');
const classifier = require('./classifier');
const media = require('./media');

const CONTEXT_MESSAGES = parseInt(process.env.CLASSIFIER_CONTEXT_MESSAGES || '12', 10);
const OPEN_JD_LIMIT = parseInt(process.env.MATCH_JD_LIMIT || '25', 10);

/**
 * Turns one closed batch into a submission and a verdict.
 *
 * The batch is only removed once the work has committed, so a crash halfway
 * through leaves the batch claimed-but-unflushed and the stale-claim reaper
 * picks it up again.
 */
async function flushBatch(batch) {
  const chatId = batch.chat_id;
  const pending = await messagesRepo.unbatchedForChat(chatId);

  if (pending.length === 0) {
    await batchesRepo.remove(chatId);
    return { chatId, status: 'empty' };
  }

  // Pull resume text out of any attachments before the submission text is
  // assembled, so the classifier sees the CV rather than "[document: cv.pdf]".
  await media.hydrate(pending);

  const submission = await withTransaction((client) =>
    submissionsRepo.create(
      { chatId, contactId: batch.contact_id, messages: pending },
      client
    )
  );

  try {
    const result = await classifySubmission(submission, pending);
    await batchesRepo.remove(chatId);
    return { chatId, submissionId: submission.id, ...result };
  } catch (err) {
    await submissionsRepo.markFailed(submission.id, err.message);
    // Keep the batch so the work is retried rather than silently lost.
    await batchesRepo.releaseWithBackoff(chatId, 120);
    throw err;
  }
}

async function classifySubmission(submission, batchMessages) {
  const firstId = batchMessages[0].id;
  const context = await messagesRepo.recentForChat(
    submission.chat_id,
    CONTEXT_MESSAGES,
    firstId
  );

  const routed = await classifier.route({
    text: submission.combined_text,
    contextMessages: context,
  });

  if (routed.kind === 'job_posting') {
    return handleJobPosting(submission, routed);
  }
  if (routed.kind === 'application') {
    return handleApplication(submission, routed);
  }
  return handleNonActionable(submission, routed);
}

async function handleJobPosting(submission, routed) {
  const jd = await jdsRepo.create({
    submissionId: submission.id,
    title: routed.job.title,
    postedBy: routed.job.posted_by,
    jdText: submission.combined_text,
    requirements: routed.job.requirements || [],
    postedAt: submission.window_end,
  });

  await submissionsRepo.markClassified(submission.id, {
    kind: routed.kind,
    kindConfidence: routed.confidence,
  });
  await sheetMirror.enqueue('jd', jd.id, 'upsert');

  return { kind: 'job_posting', jdExternalId: jd.external_id };
}

async function handleApplication(submission, routed) {
  // A continuation carries the earlier text with it, so the matcher sees the
  // whole application rather than just the follow-up fragment.
  let matchText = submission.combined_text;
  let continuesId = null;

  if (routed.continuesPrevious) {
    const previous = await submissionsRepo.latestApplicationForChat(
      submission.chat_id,
      submission.id
    );
    if (previous) {
      continuesId = previous.id;
      matchText = `${previous.combined_text}\n\n${submission.combined_text}`;
    }
  }

  const openJds = await jdsRepo.listOpen(OPEN_JD_LIMIT);
  const raw = await classifier.match({ text: matchText, jds: openJds });
  const scored = classifier.applyConfidenceFloor(raw);

  const jd = scored.jdExternalId
    ? await jdsRepo.findByExternalId(scored.jdExternalId)
    : null;

  const classification = await withTransaction(async (client) => {
    // The combined submission now owns the verdict; retire the fragment's.
    if (continuesId) {
      await classificationsRepo.supersede(continuesId, client);
    }
    return classificationsRepo.record(
      {
        submissionId: submission.id,
        jdId: jd ? jd.id : null,
        verdict: scored.verdict,
        confidence: scored.confidence,
        reason: scored.reason,
        evidence: scored.evidence,
        model: scored.model,
        promptVersion: classifier.PROMPT_VERSION,
      },
      client
    );
  });

  if (submission.contact_id && (routed.person.name || routed.person.email)) {
    await contactsRepo.updateDetails(submission.contact_id, {
      name: routed.person.name,
      email: routed.person.email,
    });
  }

  await submissionsRepo.markClassified(submission.id, {
    kind: routed.kind,
    kindConfidence: routed.confidence,
    continuesSubmissionId: continuesId,
  });
  await sheetMirror.enqueue('applicant', classification.id, 'upsert');
  if (continuesId) {
    await sheetMirror.enqueue('applicant', continuesId, 'delete');
  }

  return {
    kind: 'application',
    verdict: scored.verdict,
    modelVerdict: scored.modelVerdict,
    confidence: scored.confidence,
    jdExternalId: scored.jdExternalId,
    continuesSubmissionId: continuesId,
  };
}

async function handleNonActionable(submission, routed) {
  // Chatter is stored and then left alone. "unclear" gets a real row so it
  // surfaces in the review queue instead of disappearing.
  if (routed.kind === 'unclear') {
    const classification = await classificationsRepo.record({
      submissionId: submission.id,
      jdId: null,
      verdict: 'NEEDS_REVIEW',
      confidence: routed.confidence,
      reason: routed.reason || 'Router could not categorise this message.',
      evidence: [],
      model: routed.model,
      promptVersion: classifier.PROMPT_VERSION,
    });
    await sheetMirror.enqueue('applicant', classification.id, 'upsert');
  }

  await submissionsRepo.markClassified(submission.id, {
    kind: routed.kind,
    kindConfidence: routed.confidence,
  });

  return { kind: routed.kind };
}

/**
 * Re-runs the current prompts over an already-classified submission. Existing
 * verdicts are demoted, not deleted, and a human override still wins.
 */
async function reclassify(submissionId) {
  const submission = await submissionsRepo.findById(submissionId);
  if (!submission) throw new Error(`submission ${submissionId} not found`);

  const batchMessages = await messagesRepo.forSubmission(submissionId);

  // Retry any attachment that failed to extract the first time — a transient
  // Evolution error is exactly the case the review queue's Re-classify button
  // is there to recover from. If new text appears, rebuild the submission.
  const before = batchMessages.map((m) => m.media_text || '').join('|');
  await media.hydrate(batchMessages);
  const after = batchMessages.map((m) => m.media_text || '').join('|');

  let current = submission;
  if (before !== after) {
    const rebuilt = submissionsRepo.buildCombinedText(batchMessages);
    current = await submissionsRepo.updateCombinedText(submissionId, rebuilt);
    console.log(`[pipeline] submission ${submissionId} text rebuilt after attachment retry`);
  }

  return classifySubmission(current, batchMessages);
}

module.exports = { flushBatch, classifySubmission, reclassify };
