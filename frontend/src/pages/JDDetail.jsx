import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import { formatDate } from '../lib/utils';

export default function JDDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [jd, setJd] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/jds/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      navigate('/jds', { replace: true });
    } catch (e) {
      setError(e.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function toggleStatus() {
    setSavingStatus(true);
    try {
      const next = jd.Status === 'open' ? 'closed' : 'open';
      const r = await fetch(`/api/jds/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      setJd((prev) => ({ ...prev, Status: next }));
    } catch (e) {
      setError(e.message);
    }
    setSavingStatus(false);
  }

  useEffect(() => {
    fetch(`/api/jds/${id}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setJd(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [id]);

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="skeleton h-9 w-56" />
        <div className="skeleton h-64" />
      </div>
    );
  }
  if (error) return <div className="notice-error">Error: {error}</div>;
  if (!jd) return null;

  return (
    <div className="space-y-10">
      <button onClick={() => navigate(-1)} className="btn-quiet">
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="square" d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        All roles
      </button>

      <header className="border-b-2 border-ink pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="micro">{jd.JD_ID} · {formatDate(jd.Date)}</p>
            <h1 className="page-title mt-2">{jd.Title || 'Untitled role'}</h1>
            {jd.Posted_By && (
              <p className="page-sub">Posted by {jd.Posted_By}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={toggleStatus} disabled={savingStatus} className={jd.Status === 'open' ? 'btn-solid' : 'btn'}>
              {savingStatus ? 'Saving' : jd.Status}
            </button>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} className="btn">Delete</button>
            ) : (
              <span className="flex items-center gap-2 border border-ink px-3 py-1.5">
                <span className="text-xs text-ink">Delete this role?</span>
                <button onClick={handleDelete} disabled={deleting} className="btn-solid !px-2 !py-1">
                  {deleting ? '…' : 'Confirm'}
                </button>
                <button onClick={() => setConfirmDelete(false)} disabled={deleting} className="btn !px-2 !py-1">
                  Cancel
                </button>
              </span>
            )}
          </div>
        </div>
      </header>

      {jd.Requirements?.length > 0 && (
        <section className="space-y-3">
          <h2 className="micro border-b border-rule pb-2">Extracted requirements</h2>
          <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {jd.Requirements.map((r, i) => (
              <li key={i} className="flex items-baseline gap-2.5 text-sm text-ink">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 bg-ink" aria-hidden="true" />
                {r}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="micro border-b border-rule pb-2">Description</h2>
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">
          {jd.JD_Text || 'No description text available.'}
        </pre>
      </section>

      <section className="space-y-4">
        <div className="flex items-baseline justify-between border-b border-rule pb-2">
          <h2 className="micro">Candidates</h2>
          <span className="tnum text-xs text-ink-3">{jd.applicants?.length ?? 0}</span>
        </div>

        {!jd.applicants?.length ? (
          <p className="border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-3">
            No candidates matched to this role yet.
          </p>
        ) : (
          <ul className="divide-y divide-rule border-b border-rule">
            {jd.applicants.map((app) => (
              <li key={app.Applicant_ID}>
                <button
                  onClick={() => navigate(`/candidates/${app.Applicant_ID}`)}
                  className="group flex w-full items-start justify-between gap-5 py-4 text-left transition-colors hover:bg-surface"
                >
                  <div className="min-w-0 flex-1 px-1">
                    <p className="font-medium text-ink">{app.Name || app.Sender}</p>
                    <p className="mono-id mt-0.5">{app.Phone || app.Applicant_ID}</p>
                    {app.Reason && (
                      <p className="mt-1.5 line-clamp-2 max-w-xl text-sm text-ink-2">{app.Reason}</p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3 px-1 pt-0.5">
                    <MatchBadge result={app.Result} overridden={!!app.overrideVerdict} size="sm" />
                    <svg className="h-3.5 w-3.5 text-ink-3 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="square" d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
