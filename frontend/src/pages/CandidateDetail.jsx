import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import { formatDate, formatDateTime } from '../lib/utils';

export default function CandidateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [applicant, setApplicant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/applicants/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      navigate('/candidates', { replace: true });
    } catch (e) {
      setError(e.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  useEffect(() => {
    fetch(`/api/applicants/${id}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setApplicant(d); setLoading(false); })
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

  if (!applicant) return null;

  const RESULT_ORDER = { STRONG: 0, PARTIAL: 1, WEAK: 2, NONE: 3, UNKNOWN: 4 };
  const sortedMatches = [...(applicant.matches || [])].sort(
    (a, b) => (RESULT_ORDER[a.Result] ?? 5) - (RESULT_ORDER[b.Result] ?? 5)
  );

  return (
    <div className="space-y-6">
      {/* Back */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Candidates
      </button>

      {/* Contact card */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            {/* Avatar initial */}
            <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xl font-bold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              {(applicant.Name || applicant.Sender || '?')[0].toUpperCase()}
            </div>
            <div>
              {applicant.Name && (
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">{applicant.Name}</h1>
              )}
              <p className={`font-medium ${applicant.Name ? 'text-sm text-gray-500 dark:text-gray-400' : 'text-xl text-gray-900 dark:text-white'}`}>
                @{applicant.Sender}
              </p>
              <p className="mt-0.5 font-mono text-xs text-gray-400 dark:text-gray-500">{applicant.Applicant_ID}</p>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{formatDateTime(applicant.Date)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <MatchBadge result={applicant.Result} />
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
                <span className="text-sm text-red-700 dark:text-red-300">Delete applicant?</span>
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

        {/* Contact details row */}
        {(applicant.Phone || applicant.Email || applicant.PDF_URL) && (
          <div className="mt-4 flex flex-wrap gap-4 border-t border-gray-100 pt-4 dark:border-gray-800">
            {applicant.Phone && (
              <a
                href={`tel:${applicant.Phone}`}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <svg className="h-4 w-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                {applicant.Phone}
              </a>
            )}
            {applicant.Email && (
              <a
                href={`mailto:${applicant.Email}`}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <svg className="h-4 w-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {applicant.Email}
              </a>
            )}
            {applicant.PDF_URL && (
              <a
                href={applicant.PDF_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                View PDF
              </a>
            )}
          </div>
        )}
      </div>

      {/* Message / Resume */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Message / Resume
        </h2>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-gray-800 dark:text-gray-200 font-sans">
          {applicant.Message || 'No message content available.'}
        </pre>
      </div>

      {/* AI Match result for primary JD */}
      {applicant.JD_ID && applicant.JD_ID !== 'NONE' && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Primary Match
          </h2>
          <p className="font-mono text-sm text-indigo-600 dark:text-indigo-400">{applicant.JD_ID}</p>
          {applicant.Reason && (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium">AI Reason: </span>{applicant.Reason}
            </p>
          )}
        </div>
      )}

      {/* All JD matches */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
          All JD Matches{' '}
          <span className="ml-1 text-sm font-normal text-gray-500 dark:text-gray-400">
            ({applicant.matches?.length ?? 0})
          </span>
        </h2>

        {!applicant.matches?.length ? (
          <p className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            No JD matches recorded for this candidate.
          </p>
        ) : (
          <div className="space-y-3">
            {sortedMatches.map((match) => (
              <div
                key={match.applicant_id}
                className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <button
                      onClick={() => navigate(`/jds/${match.JD_ID}`)}
                      className="font-mono text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                    >
                      {match.JD_ID}
                    </button>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{formatDate(match.Date)}</p>
                    {match.jdPostedBy && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">Posted by {match.jdPostedBy}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <MatchBadge result={match.Result} />
                    {match.jdStatus && (
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        match.jdStatus === 'open'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {match.jdStatus}
                      </span>
                    )}
                  </div>
                </div>
                {match.Reason && (
                  <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-300">AI Reason: </span>
                    {match.Reason}
                  </p>
                )}
                {match.jdText && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                      View JD text
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm leading-relaxed text-gray-800 dark:bg-gray-800 dark:text-gray-200 font-sans">
                      {match.jdText}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
