import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import { formatDate, formatDateTime } from '../lib/utils';

export default function JDDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [jd, setJd] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  useEffect(() => {
    fetch(`/api/jds/${id}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setJd(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [id]);

  if (loading) return (
    <div className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
      <div className="h-64 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-800" />
    </div>
  );

  if (error) return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
      Error: {error}
    </div>
  );

  if (!jd) return null;

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div>
        <button
          onClick={() => navigate(-1)}
          className="mb-2 flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to JDs
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-mono text-xl font-bold text-gray-900 dark:text-white">{jd.JD_ID}</h1>
            <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{formatDate(jd.Date)}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${
              jd.Status === 'open'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
            }`}>
              {jd.Status}
            </span>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete
              </button>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 dark:border-red-700 dark:bg-red-900/20">
                <span className="text-sm text-red-700 dark:text-red-300">Delete this JD?</span>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {deleting ? 'Deleting…' : 'Confirm'}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Posted By — prominent */}
        <div className="mt-3 flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
            {(jd.Posted_By || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">Posted by</p>
            <p className="text-base font-semibold text-gray-900 dark:text-white">{jd.Posted_By}</p>
          </div>
        </div>
      </div>

      {/* JD Text */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Job Description</h2>
        <pre className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-200 font-sans">
          {jd.JD_Text || 'No job description text available.'}
        </pre>
      </div>

      {/* Applicants */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
          Applicants <span className="ml-1 text-sm font-normal text-gray-500 dark:text-gray-400">({jd.applicants?.length ?? 0})</span>
        </h2>

        {!jd.applicants?.length ? (
          <p className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            No applicants matched to this JD yet.
          </p>
        ) : (
          <div className="space-y-2">
            {jd.applicants.map((app) => (
              <div
                key={app.Applicant_ID}
                onClick={() => navigate(`/candidates/${app.Applicant_ID}`)}
                className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 transition-colors hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 dark:text-white">
                    {app.Name || app.Sender}
                  </p>
                  {app.Name && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">{app.Sender}</p>
                  )}
                  {app.Phone && (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{app.Phone}</p>
                  )}
                  {app.Email && (
                    <p className="mt-0.5 max-w-xs truncate text-xs text-gray-500 dark:text-gray-400">{app.Email}</p>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-3">
                  <MatchBadge result={app.Result} />
                  {app.Reason && (
                    <p className="hidden max-w-xs truncate text-sm text-gray-500 dark:text-gray-400 sm:block">
                      {app.Reason}
                    </p>
                  )}
                  <svg className="h-4 w-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
