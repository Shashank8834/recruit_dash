/**
 * A role as a document you can send someone.
 *
 * A role lives here as a set of columns, which is right for matching and
 * useless for the thing a recruiter actually does with it next: paste it into
 * an email, attach it to a message, hand it to a client. Rebuilding it by hand
 * from a screen is how the version people receive drifts from the version the
 * matcher scored against.
 *
 * Plain text rather than PDF or DOCX. It opens everywhere, pastes into an email
 * without carrying formatting nobody asked for, and needs no library — and the
 * content here is a title and some paragraphs, which is exactly what plain text
 * is for.
 */

/** A heading with its content, or nothing at all when there is no content. */
function section(heading, body) {
  if (!body || (Array.isArray(body) && body.length === 0)) return null;
  const lines = Array.isArray(body) ? body.map((item) => `  - ${item}`) : [String(body).trim()];
  return `${heading}\n${'-'.repeat(heading.length)}\n${lines.join('\n')}`;
}

/**
 * Title, its underline, and an optional subtitle — as ONE block.
 *
 * The parts are joined with a blank line between them, so the underline has to
 * be part of the same string as the title or it floats a line below it.
 */
function heading(title, subtitle) {
  const rule = '='.repeat(title.length);
  return subtitle ? `${title}\n${rule}\n${subtitle}` : `${title}\n${rule}`;
}

/** Everything below the sections: what this is and whether it is still live. */
function footer(reference, status) {
  return `Reference: ${reference}\nStatus: ${status}`;
}

/** Drops the omitted sections and separates what is left by one blank line. */
function assemble(parts) {
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

/** Hand-written roles. */
function forRole(role) {
  return assemble([
    heading(role.title, [role.company, role.location].filter(Boolean).join(' · ')),
    section('Requirements', role.requirements || []),
    role.min_experience_years === null || role.min_experience_years === undefined
      ? null
      : section('Experience', `Minimum ${role.min_experience_years} years.`),
    section('Description', role.description),
    footer(role.external_id, role.status),
  ]);
}

/** Roles the pipeline parsed out of a WhatsApp message. */
function forPosting(jd) {
  return assemble([
    heading(jd.title || 'Untitled posting', jd.posted_by ? `Posted by ${jd.posted_by}` : ''),
    section('Requirements', jd.requirements || []),
    // The original message, not a summary of it. This is the only record of
    // what was actually posted, and the parsed fields above are an
    // interpretation of it that can be wrong.
    section('As posted', jd.jd_text),
    footer(jd.external_id, jd.status),
  ]);
}

/** A filename that survives a Content-Disposition header and a filesystem. */
function fileNameFor(label, reference) {
  const stem = String(label || reference || 'role')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || reference}-JD.txt`;
}

module.exports = { forRole, forPosting, fileNameFor };
