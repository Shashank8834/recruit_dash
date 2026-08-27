import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Notes from '../components/Notes';
import MeetingList from '../components/MeetingList';
import { formatDate } from '../lib/utils';

/**
 * One candidate, with their extracted fields editable and their notes beside
 * them.
 *
 * Editing is not a nice-to-have here. Extraction is a model reading a document
 * a human formatted freely, and it will sometimes take a referee's name or an
 * employer's city. The person looking at this page can see the source text, so
 * they are the one best placed to fix it — and a field they cannot correct is
 * one they stop trusting entirely.
 */

const FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'currentCompany', column: 'current_company', label: 'Current company' },
  { key: 'currentDesignation', column: 'current_designation', label: 'Current designation' },
  { key: 'location', label: 'Location' },
  { key: 'age', label: 'Age', type: 'number' },
  { key: 'experienceYears', column: 'experience_years', label: 'Total experience (years)', type: 'number' },
  // One salary field, as the CV states it. The comparable number the filters
  // use is derived from this string on save — two inputs for one fact can
  // disagree, and nothing on screen would say which of them was right.
  { key: 'salaryText', column: 'salary_text', label: 'Current salary' },
];

const LISTING_OPTIONS = [
  { value: '', label: 'Not established' },
  { value: 'listed', label: 'Listed' },
  { value: 'unlisted', label: 'Unlisted' },
];

export default function TalentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [candidate, setCandidate] = useState(null);
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSource, setShowSource] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/candidates/${id}`)
      .then((r) => { if (!r.ok) throw new Error(r.status === 404 ? 'Candidate not found' : `Server error ${r.status}`); return r.json(); })
      .then((d) => { setCandidate(d); setNotes(d.notes || []); })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  function value(field) {
    if (draft[field.key] !== undefined) return draft[field.key];
    const raw = candidate ? candidate[field.column || field.key] : null;
    return raw === null || raw === undefined ? '' : raw;
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      // Empty string means "clear this field", which has to reach the server as
      // null — an empty string in a phone column reads as a value that exists.
      const body = {};
      for (const [key, raw] of Object.entries(draft)) {
        body[key] = raw === '' ? null : raw;
      }
      const response = await fetch(`/api/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      // Merged, not replaced. The PATCH response omits raw_text — list columns
      // deliberately exclude it, since it is the whole document — so assigning
      // the response wholesale blanked the CV text the moment anyone corrected
      // a field, exactly when they most want to check it against the source.
      const updated = await response.json();
      setCandidate((current) => ({ ...current, ...updated }));
      setDraft({});
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this candidate, their CV and their notes? This cannot be undone.')) return;
    await fetch(`/api/candidates/${id}`, { method: 'DELETE' });
    navigate('/talent');
  }

  if (error && !candidate) return <div className="callout">{error}</div>;
  if (!candidate) return <div className="skeleton h-40" />;

  const dirty = Object.keys(draft).length > 0;
  const byHand = candidate.entry_mode === 'manual';

  return (
    <div className="space-y-8">
      <Link to="/talent" className="btn-quiet">← Talent pool</Link>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="mono">
            {candidate.external_id} · Added {formatDate(candidate.created_at)}
          </p>
          <h1 className="page-title mt-1">{candidate.name || 'Unnamed candidate'}</h1>
          <p className="page-sub">
            {byHand
              ? 'Entered by hand — no CV on file.'
              : candidate.file_name
                ? `From ${candidate.file_name}`
                : 'From an uploaded CV.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {/* Requested explicitly: the extracted fields never cover everything,
              and the document answers the rest without a message to whoever
              sent it. Absent for older uploads stored before the file was
              kept, so the buttons are conditional rather than always-there
              links to a 404. */}
          {candidate.has_file && (
            <>
              <a
                className="btn"
                href={`/api/candidates/${id}/file`}
                target="_blank"
                rel="noreferrer"
              >
                View CV
              </a>
              <a className="btn" href={`/api/candidates/${id}/file?download=1`}>
                Download CV
              </a>
            </>
          )}
          {/* No stored file, but text was extracted: this is a CV uploaded
              before the document itself was kept. Offering the text beats a
              profile with no way to read the CV at all. */}
          {!candidate.has_file && candidate.raw_text && (
            <a
              className="btn"
              href={`/api/candidates/${id}/cv.txt`}
              title="The original file was not kept for this upload — this is the extracted text"
            >
              Download CV text
            </a>
          )}
          {dirty && (
            <button className="btn-solid" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
          <button className="btn" onClick={remove}>Delete</button>
        </div>
      </header>

      {error && <div className="notice-error">{error}</div>}
      {saved && !dirty && <div className="callout">Saved.</div>}

      {candidate.extraction_notes && (
        <div className="callout">
          <p className="micro mb-1">Extraction note</p>
          <p>{candidate.extraction_notes}</p>
        </div>
      )}

      <section className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <label key={field.key} className="block">
            <span className="micro">{field.label}</span>
            <input
              className="input mt-1.5 w-full"
              type={field.type || 'text'}
              step={field.type === 'number' ? '0.1' : undefined}
              value={value(field)}
              placeholder={byHand ? 'Not entered' : 'Not found in the CV'}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  [field.key]:
                    field.type === 'number' && e.target.value !== ''
                      ? Number(e.target.value)
                      : e.target.value,
                }))
              }
            />
          </label>
        ))}
      </section>

      <section className="grid gap-8 sm:grid-cols-2">
        <label className="block">
          <span className="micro">Employer listed</span>
          <select
            className="input mt-1.5 w-full"
            value={
              draft.companyListingStatus !== undefined
                ? draft.companyListingStatus || ''
                : candidate.company_listing_status || ''
            }
            onChange={(e) =>
              setDraft((d) => ({ ...d, companyListingStatus: e.target.value || null }))
            }
          >
            {LISTING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="micro">Skills — one per line</span>
          <textarea
            className="input mt-1.5 h-24 w-full"
            value={
              draft.skills !== undefined
                ? draft.skills.join('\n')
                : (candidate.skills || []).join('\n')
            }
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                skills: e.target.value.split('\n').map((v) => v.trim()).filter(Boolean),
              }))
            }
            placeholder={'IFRS\nTreasury management'}
          />
        </label>

        <label className="block">
          <span className="micro">Domain expertise — one per line</span>
          <textarea
            className="input mt-1.5 h-24 w-full"
            value={
              draft.domainExpertise !== undefined
                ? draft.domainExpertise.join('\n')
                : (candidate.domain_expertise || []).join('\n')
            }
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                domainExpertise: e.target.value.split('\n').map((v) => v.trim()).filter(Boolean),
              }))
            }
            placeholder={'BFSI\nManufacturing'}
          />
        </label>
      </section>

      <section className="space-y-2">
        <p className="micro">Qualifications</p>
        {(candidate.qualifications || []).length === 0 ? (
          <p className="text-sm text-ink-2">None recorded.</p>
        ) : (
          <ul className="space-y-1">
            {candidate.qualifications.map((q, i) => (
              <li key={i} className="border border-rule bg-surface px-3 py-2 text-sm">{q}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between border-b border-ink pb-2">
          <p className="micro">
            Meetings
            {/* Said here as well as in the rows, because this is the page you
                are on when you decide whether to book another. */}
            {(candidate.meetings || []).length > 0 && (
              <span className="ml-2 font-normal normal-case tracking-normal text-ink-2">
                {candidate.meetings.length} so far
              </span>
            )}
          </p>
          {/* Prefilled with this candidate rather than dropping you on an empty
              meetings page to search for the name you are already looking at. */}
          <Link
            to={`/meetings?book=${encodeURIComponent(candidate.external_id)}`}
            className="btn-quiet text-xs"
          >
            {(candidate.meetings || []).length > 0 ? 'Book another' : 'Book one'}
          </Link>
        </div>
        <MeetingList
          meetings={candidate.meetings || []}
          hidePerson
          empty="No meetings with this candidate yet."
        />
      </section>

      <Notes
        basePath={`/api/candidates/${id}`}
        notes={notes}
        onChange={setNotes}
        placeholder="Spoke today — 60 days' notice, wants a hybrid role in Chennai."
      />

      {candidate.raw_text && (
        <section className="space-y-3">
          <button className="btn-quiet" onClick={() => setShowSource((s) => !s)}>
            {showSource ? 'Hide' : 'Show'} CV text
          </button>
          {showSource && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap border border-rule bg-surface p-4 text-xs leading-relaxed text-ink-2">
              {candidate.raw_text}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}
