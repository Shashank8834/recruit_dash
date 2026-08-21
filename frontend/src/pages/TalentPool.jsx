import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../lib/utils';

/**
 * Uploaded CVs.
 *
 * Deliberately its own screen, with its own table, kept apart from the
 * WhatsApp candidate list. The two hold different things — a curated document
 * versus an inbound message — and mixing them would make it impossible to tell
 * at a glance which is which.
 */
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

    const form = new FormData();
    files.forEach((f) => form.append('files', f));

    setUploading(true);
    setUploadResult(null);
    try {
      const response = await fetch('/api/candidates', { method: 'POST', body: form });
      const data = await response.json();
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

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Uploaded manually</p>
          <h1 className="page-title mt-1">Talent pool</h1>
          <p className="page-sub">
            CVs you upload here are parsed into fields and kept separate from WhatsApp.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a className="btn" href={`/api/candidates/export.csv?${params()}`}>
            Export CSV
          </a>
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

      {error && <div className="callout">{error}</div>}

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : candidates.length === 0 ? (
        <div className="panel text-center">
          <p className="text-sm text-ink-2">
            No CVs yet. Upload PDFs or Word documents and the details are filled in for you.
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
