import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import JDList from './JDList';
import CandidateList from './CandidateList';
import Review from './Review';
import { errorFrom } from '../lib/api';

/**
 * Everything that arrived from the WhatsApp group, in one place.
 *
 * Postings, applicants and the review queue used to be three destinations in
 * the sidebar. They are three readings of the same inbox: the pipeline splits
 * one stream of messages into what looks like a role, what looks like an
 * application, and what it could not decide. Split across three screens, that
 * became a round you had to remember to walk, and the review queue in
 * particular only got attention when its badge caught someone's eye.
 *
 * As tabs, it is one place you check when you feel like checking, which is how
 * this side is actually worked: skim it, and promote anything worth keeping
 * into a role or a candidate on the managed side.
 */

const TABS = [
  { key: 'messages', label: 'Posted roles', hint: 'Messages the pipeline read as a job posting' },
  { key: 'applicants', label: 'Applicants', hint: 'Messages the pipeline read as an application' },
  { key: 'review', label: 'Review', hint: 'Messages it could not decide', badge: true },
];

/** The pipeline's own health, moved here with the rest of the WhatsApp side. */
function PipelineHealth() {
  const [pipeline, setPipeline] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/dashboard')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPipeline(d.pipeline); })
      // Ingest health is context, not the reason anyone opened this page. A
      // failed fetch here should leave the messages alone, not replace them
      // with an error.
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!pipeline) return null;

  const rows = [
    ['Chats mid-batch', pipeline.pending_batches],
    ['Unclassified', pipeline.pending_submissions],
    ['Failed', pipeline.failed_submissions],
    ['Sheet backlog', pipeline.sheet_backlog],
  ];

  return (
    <section className="space-y-3">
      <h2 className="micro border-b border-rule pb-2">Ingest</h2>
      <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="bg-paper px-4 py-3">
            <p className="micro">{label}</p>
            <p
              className={`tnum mt-1.5 text-xl font-bold leading-none ${
                label === 'Failed' && value > 0
                  ? 'text-ink underline decoration-2 underline-offset-4'
                  : 'text-ink'
              }`}
            >
              {value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function WhatsApp() {
  const [params, setParams] = useSearchParams();
  const [reviewCount, setReviewCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  async function syncSheet() {
    setSyncing(true);
    setSyncError(null);
    try {
      const response = await fetch('/api/sheets/sync', { method: 'POST' });
      if (!response.ok) throw await errorFrom(response);
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  }

  // In the URL, not in state alone: a tab you can link to is a tab you can
  // send someone, and coming back from a candidate's page should return you to
  // the list you were reading rather than the first one.
  const requested = params.get('tab');
  const active = TABS.some((t) => t.key === requested) ? requested : TABS[0].key;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/review/count')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setReviewCount(d.count); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active]);

  const current = TABS.find((t) => t.key === active);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div className="max-w-xl">
          <p className="micro">From WhatsApp</p>
          <h1 className="page-title mt-1">WhatsApp messages</h1>
          <p className="page-sub">
            Read the group as it arrives, then add anything worth keeping to Open roles or
            the Talent pool.
          </p>
        </div>
        {/* Moved here with the rest of the WhatsApp side: the mirror holds
            what the pipeline ingested, so the button belongs beside it. */}
        <button onClick={syncSheet} disabled={syncing} className="btn">
          <svg
            className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"
          >
            <path strokeLinecap="square" d="M20 12a8 8 0 10-2.3 5.7M20 5v5h-5" />
          </svg>
          {syncing ? 'Syncing' : 'Sync sheet'}
        </button>
      </header>

      {syncError && <div className="notice-error">Sheet sync failed: {syncError}</div>}

      <div className="flex flex-wrap items-center gap-px border border-rule bg-rule">
        {TABS.map((tab) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              onClick={() => setParams({ tab: tab.key }, { replace: true })}
              title={tab.hint}
              className={[
                'flex flex-1 items-center justify-center gap-2 px-5 py-3 text-[13px] font-semibold transition-colors',
                selected ? 'bg-ink text-paper' : 'bg-paper text-ink-2 hover:bg-surface hover:text-ink',
              ].join(' ')}
            >
              {tab.label}
              {tab.badge && reviewCount > 0 && (
                <span className="tnum border border-current px-1.5 py-px text-[10px] font-bold">
                  {reviewCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="micro">{current.hint}</p>

      {active === 'messages' && <JDList />}
      {active === 'applicants' && <CandidateList />}
      {active === 'review' && <Review onCountChange={setReviewCount} />}

      <PipelineHealth />
    </div>
  );
}
