import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { formatDate } from '../lib/utils';

/**
 * One uploaded CV, with its extracted fields editable.
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
];

export default function TalentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [candidate, setCandidate] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    fetch(`/api/candidates/${id}`)
      .then((r) => { if (!r.ok) throw new Error(r.status === 404 ? 'Candidate not found' : `Server error ${r.status}`); return r.json(); })
      .then(setCandidate)
      .catch((e) => setError(e.message));
  }, [id]);

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
      setCandidate(await response.json());
      setDraft({});
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this candidate and their CV text? This cannot be undone.')) return;
    await fetch(`/api/candidates/${id}`, { method: 'DELETE' });
    navigate('/talent');
  }

  if (error) return <div className="callout">{error}</div>;
  if (!candidate) return <div className="skeleton h-40" />;

  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="space-y-8">
      <Link to="/talent" className="btn-quiet">← Talent pool</Link>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="mono">{candidate.external_id} · {formatDate(candidate.created_at)}</p>
          <h1 className="page-title mt-1">{candidate.name || 'Unnamed candidate'}</h1>
          {candidate.file_name && <p className="page-sub">From {candidate.file_name}</p>}
        </div>
        <div className="flex gap-3">
          {dirty && (
            <button className="btn-solid" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
          <button className="btn" onClick={remove}>Delete</button>
        </div>
      </header>

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
              placeholder="Not found in the CV"
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

      <section className="space-y-2">
        <p className="micro">Qualifications</p>
        {(candidate.qualifications || []).length === 0 ? (
          <p className="text-sm text-ink-2">None found.</p>
        ) : (
          <ul className="space-y-1">
            {candidate.qualifications.map((q, i) => (
              <li key={i} className="border border-rule bg-surface px-3 py-2 text-sm">{q}</li>
            ))}
          </ul>
        )}
      </section>

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
    </div>
  );
}
