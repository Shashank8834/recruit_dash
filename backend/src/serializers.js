/**
 * Maps Postgres rows onto the JSON shape the dashboard already consumes, so
 * the storage swap is invisible to existing frontend code. New fields
 * (confidence, evidence, override) are additive.
 */

function unix(value) {
  return value ? Math.floor(new Date(value).getTime() / 1000) : null;
}

function jd(row) {
  return {
    JD_ID: row.external_id,
    Date: unix(row.posted_at),
    Posted_By: row.posted_by || '',
    JD_Text: row.jd_text || '',
    Status: row.status,
    Title: row.title || null,
    Requirements: row.requirements || [],
    submissionId: row.submission_id || null,
    candidateCount:
      row.candidate_count !== undefined ? Number(row.candidate_count) : undefined,
  };
}

function applicant(row) {
  return {
    Applicant_ID: row.external_id,
    JD_ID: row.jd_external_id || 'NONE',
    Date: unix(row.created_at),
    Sender: row.sender || '',
    Message: row.message || '',
    Result: row.result,
    Reason: row.reason || '',
    Phone: row.phone || '',
    Email: row.email || '',
    Name: row.name || '',
    classificationId: row.classification_id,
    submissionId: row.submission_id,
    contactId: row.contact_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    evidence: row.evidence || [],
    modelVerdict: row.model_verdict,
    overrideVerdict: row.override_verdict || null,
    overrideReviewer: row.override_reviewer || null,
    overrideNote: row.override_note || null,
    model: row.model || null,
    promptVersion: row.prompt_version || null,
  };
}

/** A candidate's other verdicts, shown on their detail page. */
function match(row) {
  return {
    applicant_id: row.external_id,
    JD_ID: row.jd_external_id || 'NONE',
    Date: unix(row.created_at),
    Result: row.result,
    Reason: row.reason || '',
    confidence: row.confidence === null ? null : Number(row.confidence),
    evidence: row.evidence || [],
    jdText: row.jd_text || null,
    jdPostedBy: row.jd_posted_by || null,
    jdStatus: row.jd_status || null,
  };
}

module.exports = { jd, applicant, match, unix };
