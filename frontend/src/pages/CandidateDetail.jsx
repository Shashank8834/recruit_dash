import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import Notes from '../components/Notes';
import MessageThread from '../components/MessageThread';
import { formatDate, formatDateTime } from '../lib/utils';

const VERDICTS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'UNKNOWN'];
const RESULT_ORDER = { STRONG: 0, PARTIAL: 1, WEAK: 2, NEEDS_REVIEW: 3, NONE: 4, UNKNOWN: 5 };

export default function CandidateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [applicant, setApplicant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingVerdict, setSavingVerdict] = useState(null);

  function reload() {
    return fetch(`/api/applicants/${id}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then(setApplicant);
  }

  // A human decision is recorded next to the model's, not on top of it — the
  // model verdict stays visible so you can see what was corrected.
  async function setVerdict(verdict) {
    setSavingVerdict(verdict);
    try {
      const r = await fetch(`/api/review/classifications/${applicant.classificationId}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, reviewer: 'dashboard' }),
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      await reload();
    } catch (e) {
      setError(e.message);
    }
    setSavingVerdict(null);
  }

  async function clearVerdict() {
    setSavingVerdict('clear');
    try {
      const r = await fetch(`/api/review/classifications/${applicant.classificationId}/override`, {
        method: 'DELETE',
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      await reload();
    } catch (e) {
      setError(e.message);
    }
    setSavingVerdict(null);
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/applicants/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      navigate('/whatsapp?tab=applicants', { replace: true });
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

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="skeleton h-9 w-56" />
        <div className="skeleton h-64" />
      </div>
    );
  }
  if (error && !applicant) return <div className="notice-error">Error: {error}</div>;
  if (!applicant) return null;

  const sortedMatches = [...(applicant.matches || [])].sort(
    (a, b) => (RESULT_ORDER[a.Result] ?? 6) - (RESULT_ORDER[b.Result] ?? 6)
  );

  return (
    <div className="space-y-10">
      <button onClick={() => navigate(-1)} className="btn-quiet">
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="square" d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        All candidates
      </button>

      {/* Identity */}
      <header className="border-b-2 border-ink pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center border border-ink bg-ink text-lg font-bold text-paper">
              {(applicant.Name || applicant.Sender || '?')[0].toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="micro">{applicant.Applicant_ID} · {formatDateTime(applicant.Date)}</p>
              <h1 className="page-title mt-1.5">{applicant.Name || applicant.Sender}</h1>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
                {applicant.Phone && (
                  <a href={`tel:${applicant.Phone}`} className="font-mono hover:text-ink hover:underline hover:underline-offset-4">
                    {applicant.Phone}
                  </a>
                )}
                {applicant.Email && (
                  <a href={`mailto:${applicant.Email}`} className="hover:text-ink hover:underline hover:underline-offset-4">
                    {applicant.Email}
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <MatchBadge result={applicant.Result} overridden={!!applicant.overrideVerdict} />
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} className="btn">Delete</button>
            ) : (
              <span className="flex items-center gap-2 border border-ink px-3 py-1.5">
                <span className="text-xs text-ink">Delete candidate?</span>
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

      {error && <div className="notice-error">{error}</div>}

      {/* Message */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-2">
          <h2 className="micro">Message</h2>
          {applicant.thread?.length > 1 && (
            <span className="micro border border-ink px-1.5 py-0.5 text-ink">
              chained from {applicant.thread.length}
            </span>
          )}
        </div>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">
          {applicant.Message || 'No message content available.'}
        </pre>

        {applicant.thread?.length > 0 && (
          <details className="pt-2">
            <summary className="micro cursor-pointer select-none text-ink hover:text-ink-2">
              Original WhatsApp messages
            </summary>
            <div className="mt-4 border-l border-dashed border-rule pl-4">
              <MessageThread messages={applicant.thread} />
            </div>
          </details>
        )}
      </section>

      {/* Notes follow the person, not this verdict, so anything recorded here
          is on the page again the next time they apply to something else. */}
      <Notes
        basePath={`/api/applicants/${id}`}
        notes={applicant.notes || []}
        onChange={(notes) => setApplicant((current) => ({ ...current, notes }))}
        placeholder="Called — already placed elsewhere, asked us to keep them on file."
      />

      {/* Assessment */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-2">
          <h2 className="micro">Assessment</h2>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-3">
            {applicant.confidence !== null && (
              <span className="tnum">confidence {Number(applicant.confidence).toFixed(2)}</span>
            )}
            {applicant.model && <span className="font-mono">{applicant.model}</span>}
            {applicant.promptVersion && <span className="font-mono">{applicant.promptVersion}</span>}
          </div>
        </div>

        {applicant.JD_ID && applicant.JD_ID !== 'NONE' && (
          <button
            onClick={() => navigate(`/jds/${applicant.JD_ID}`)}
            className="font-mono text-sm text-ink underline underline-offset-4 hover:text-ink-2"
          >
            {applicant.JD_ID}
          </button>
        )}

        {applicant.Reason && (
          <p className="max-w-2xl text-sm leading-relaxed text-ink-2">{applicant.Reason}</p>
        )}

        {/* Human override */}
        <div className="border border-rule bg-surface px-5 py-4">
          {applicant.overrideVerdict ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-sm text-ink">
                Overridden to <strong>{applicant.overrideVerdict}</strong>
                {applicant.overrideReviewer && ` by ${applicant.overrideReviewer}`}. The model
                said <strong>{applicant.modelVerdict}</strong>.
              </p>
              <button onClick={clearVerdict} disabled={savingVerdict !== null} className="btn">
                {savingVerdict === 'clear' ? '…' : 'Revert to model'}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="micro mr-1">Correct this verdict</span>
              {VERDICTS.map((v) => (
                <button
                  key={v}
                  onClick={() => setVerdict(v)}
                  disabled={savingVerdict !== null || !applicant.classificationId}
                  className="btn !px-3 !py-1.5"
                >
                  {savingVerdict === v ? '…' : v}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Other roles */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between border-b border-rule pb-2">
          <h2 className="micro">All role matches</h2>
          <span className="tnum text-xs text-ink-3">{sortedMatches.length}</span>
        </div>

        {!sortedMatches.length ? (
          <p className="border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-3">
            No role matches recorded for this candidate.
          </p>
        ) : (
          <ul className="divide-y divide-rule border-b border-rule">
            {sortedMatches.map((match) => (
              <li key={match.applicant_id} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      onClick={() => navigate(`/jds/${match.JD_ID}`)}
                      className="font-mono text-sm text-ink underline underline-offset-4 hover:text-ink-2"
                    >
                      {match.JD_ID}
                    </button>
                    <p className="mono-id mt-1">
                      {formatDate(match.Date)}
                      {match.jdPostedBy && ` · ${match.jdPostedBy}`}
                      {match.jdStatus && ` · ${match.jdStatus}`}
                    </p>
                  </div>
                  <MatchBadge result={match.Result} size="sm" />
                </div>
                {match.Reason && (
                  <p className="mt-2 max-w-2xl text-sm text-ink-2">{match.Reason}</p>
                )}
                {match.jdText && (
                  <details className="mt-2">
                    <summary className="micro cursor-pointer select-none text-ink-2 hover:text-ink">
                      Role description
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap border-l border-rule pl-4 font-sans text-sm leading-relaxed text-ink-2">
                      {match.jdText}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
