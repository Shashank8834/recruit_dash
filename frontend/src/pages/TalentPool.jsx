import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../lib/utils';

/**
 * The talent pool: CVs uploaded here, and candidates typed in by hand.
 *
 * Deliberately its own screen, with its own table, kept apart from the
 * WhatsApp candidate list. The two hold different things — a curated record
 * versus an inbound message — and mixing them would make it impossible to tell
 * at a glance which is which.
 *
 * Two ways in, because there are two ways candidates actually arrive. A CV is
 * a document to parse; a referral is a name and a number someone was told over
 * the phone. Only supporting the first pushed the second into a private
 * spreadsheet, where the matcher could never see it.
 */

const BLANK = {
  name: '', email: '', phone: '', currentCompany: '', currentDesignation: '',
  location: '', age: '', experienceYears: '', qualifications: '', note: '',
};

export default function TalentPool() {
  const [candidates, setCandidates] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [minExperience, setMinExperience] = useState('');

  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileInput = useRef(null);

  const [entering, setEntering] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);

  const navigate = useNavigate();

  const params = () => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (minExperience) p.set('minExperience', minExperience);
    return p;
  };

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/candidates?${params()}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setCandidates(d.candidates || []); setTotal(d.total || 0); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, minExperience]);

  // Debounced: typing in the search box should not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function onUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    // Named for what it is rather than `form`, which is now the hand-entry
    // form's state a few lines up.
    const payload = new FormData();
    files.forEach((f) => payload.append('files', f));

    setUploading(true);
    setUploadResult(null);
    try {
      const response = await fetch('/api/candidates', { method: 'POST', body: payload });
      // Not every failure comes from the app. A file over the proxy's limit is
      // rejected by nginx with an HTML error page, and calling .json() on that
      // throws a parse error that tells the user nothing about the real cause.
      const body = await response.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error(
          response.status === 413
            ? 'That file is too large for the server to accept.'
            : `Upload failed (HTTP ${response.status}).`
        );
      }
      // 207 means some files worked and some did not, so the result is
      // reported either way rather than treated as a plain success or failure.
      setUploadResult(data);
      load();
    } catch (err) {
      setUploadResult({ stored: 0, failed: files.length, errors: [{ file: '', error: err.message }] });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function createManual(event) {
    event.preventDefault();
    if (!form.name.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/candidates/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          age: form.age === '' ? null : Number(form.age),
          experienceYears: form.experienceYears === '' ? null : Number(form.experienceYears),
          // One per line, as they are typed.
          qualifications: form.qualifications.split('\n').map((q) => q.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error((detail && detail.error) || `Server error ${response.status}`);
      }
      const candidate = await response.json();
      // Straight to the profile: a hand-entered candidate is usually missing
      // something the person typing it already knows, and the detail page is
      // where they add it.
      navigate(`/talent/${candidate.external_id}`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  function field(key, label, props = {}) {
    return (
      <label className="block">
        <span className="micro">{label}</span>
        <input
          className="input mt-1.5 w-full"
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          {...props}
        />
      </label>
    );
  }

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Managed here</p>
          <h1 className="page-title mt-1">Talent pool</h1>
          <p className="page-sub">
            Upload a CV and the fields are filled in for you, or enter someone by hand.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a className="btn" href={`/api/candidates/export.csv?${params()}`}>
            Export CSV
          </a>
          <button
            className="btn"
            onClick={() => { setEntering((e) => !e); setUploadResult(null); }}
          >
            {entering ? 'Cancel' : 'Add by hand'}
          </button>
          <button
            className="btn-solid"
            disabled={uploading}
            onClick={() => fileInput.current && fileInput.current.click()}
          >
            {uploading ? 'Reading CVs…' : 'Upload CVs'}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.rtf,.md"
            className="hidden"
            onChange={onUpload}
          />
        </div>
      </header>

      {error && <div className="notice-error">{error}</div>}

      {entering && (
        <form onSubmit={createManual} className="panel space-y-5">
          <p className="text-sm text-ink-2">
            Only a name is required. Everything else can be filled in later from the
            candidate's profile.
          </p>

          <div className="grid gap-5 sm:grid-cols-2">
            {field('name', 'Name *', { required: true, placeholder: 'Priya Raman' })}
            {field('phone', 'Phone')}
            {field('email', 'Email', { type: 'email' })}
            {field('location', 'Location')}
            {field('currentDesignation', 'Current designation')}
            {field('currentCompany', 'Current company')}
            {field('experienceYears', 'Total experience (years)', {
              type: 'number', min: '0', step: '0.5',
            })}
            {field('age', 'Age', { type: 'number', min: '0', step: '1' })}
          </div>

          <label className="block">
            <span className="micro">Qualifications — one per line</span>
            <textarea
              className="input mt-1.5 h-24 w-full"
              value={form.qualifications}
              onChange={(e) => setForm({ ...form, qualifications: e.target.value })}
              placeholder={'B.Tech, Computer Science\nAWS Solutions Architect'}
            />
          </label>

          <label className="block">
            <span className="micro">First note — where they came from, what was said</span>
            <textarea
              className="input mt-1.5 h-24 w-full"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Referred by Anil. Open to relocating, notice period 30 days."
            />
          </label>

          <button className="btn-solid" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Add candidate'}
          </button>
        </form>
      )}

      {uploadResult && (
        <div className="callout space-y-2">
          <p>
            <strong>{uploadResult.stored}</strong> CV(s) added
            {uploadResult.failed > 0 && <>, <strong>{uploadResult.failed}</strong> could not be read</>}.
          </p>
          {(uploadResult.errors || []).map((e, i) => (
            <p key={i} className="text-xs text-ink-2">
              {e.file}: {e.error}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-6 border border-rule bg-surface px-5 py-4">
        <label className="flex flex-1 items-center gap-2.5">
          <span className="micro">Search</span>
          <input
            className="input flex-1"
            placeholder="Name, company, designation, location…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="micro">Min years</span>
          <input
            className="input w-20"
            type="number"
            min="0"
            step="0.5"
            value={minExperience}
            onChange={(e) => setMinExperience(e.target.value)}
          />
        </label>
        <p className="tnum text-sm text-ink-2">{total} total</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : candidates.length === 0 ? (
        <div className="panel text-center">
          <p className="text-sm text-ink-2">
            Nobody here yet. Upload PDFs or Word documents, or add a candidate by hand.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Current role</th>
                <th className="th">Location</th>
                <th className="th">Experience</th>
                <th className="th">Contact</th>
                <th className="th">CV</th>
                <th className="th">Notes</th>
                <th className="th">Added</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.external_id}
                  className="row"
                  onClick={() => navigate(`/talent/${c.external_id}`)}
                >
                  <td className="td">
                    <span className="font-semibold">{c.name || '—'}</span>
                    <span className="mono block">{c.external_id}</span>
                  </td>
                  <td className="td">
                    {c.current_designation || '—'}
                    {c.current_company && (
                      <span className="block text-xs text-ink-2">{c.current_company}</span>
                    )}
                  </td>
                  <td className="td">{c.location || '—'}</td>
                  <td className="td tnum">
                    {c.experience_years === null || c.experience_years === undefined
                      ? '—'
                      : `${c.experience_years} yr`}
                  </td>
                  <td className="td">
                    {c.email && <span className="block text-xs">{c.email}</span>}
                    {c.phone && <span className="block text-xs text-ink-2">{c.phone}</span>}
                    {!c.email && !c.phone && '—'}
                  </td>
                  <td className="td">
                    {c.has_file ? (
                      // stopPropagation: the row navigates, and a click meant
                      // for the document should open the document.
                      <a
                        className="btn-quiet text-xs"
                        href={`/api/candidates/${c.external_id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-ink-3">
                        {c.entry_mode === 'manual' ? 'By hand' : '—'}
                      </span>
                    )}
                  </td>
                  <td className="td tnum text-xs text-ink-2">{c.note_count || '—'}</td>
                  <td className="td text-xs text-ink-2">{formatDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
