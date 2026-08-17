import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import SummaryCard from '../components/SummaryCard';
import DateRangeFilter from '../components/DateRangeFilter';
import { toDateInput, toUnix, nowMinus } from '../lib/utils';

const RESULT_OPTIONS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'NEEDS_REVIEW', 'UNKNOWN'];

/**
 * Distribution as a stacked ink bar. Density does the ranking that colour
 * normally would: solid ink for STRONG down to a hairline outline for UNKNOWN.
 */
const BAND_FILL = {
  STRONG:       'bg-ink',
  PARTIAL:      'bg-ink/65',
  WEAK:         'bg-ink/40',
  NEEDS_REVIEW: 'bg-ink/25',
  NONE:         'bg-ink/12',
  UNKNOWN:      'bg-ink/5',
};

function Distribution({ rows, total }) {
  if (!total) {
    return <p className="text-sm text-ink-3">No classifications in this range.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex h-3 w-full overflow-hidden border border-ink">
        {rows.map(([key, value]) =>
          value > 0 ? (
            <span
              key={key}
              className={BAND_FILL[key]}
              style={{ width: `${(value / total) * 100}%` }}
              title={`${key}: ${value}`}
            />
          ) : null
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center gap-2.5 border-b border-rule pb-2">
            <span className={`h-2.5 w-2.5 flex-shrink-0 border border-ink ${BAND_FILL[key]}`} />
            <dt className="micro flex-1 truncate">{key.replace('_', ' ')}</dt>
            <dd className="tnum text-sm font-bold text-ink">{value}</dd>
            <dd className="tnum w-10 text-right text-xs text-ink-3">
              {total ? Math.round((value / total) * 100) : 0}%
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState(toDateInput(nowMinus(90)));
  const [endDate, setEndDate] = useState(toDateInput(Math.floor(Date.now() / 1000)));
  const [resultFilter, setResultFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({
      startDate: toUnix(startDate),
      endDate: toUnix(endDate, true),
    });
    if (resultFilter) params.set('result', resultFilter);

    setLoading(true);
    fetch(`/api/dashboard?${params}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setStats(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [startDate, endDate, resultFilter]);

  // Postgres is read live, so this is a re-fetch plus a nudge to push the
  // latest state out to the Google Sheet mirror.
  async function handleRefresh() {
    setRefreshing(true);
    const today = toDateInput(Math.floor(Date.now() / 1000));
    if (endDate < today) setEndDate(today);
    try {
      await fetch('/api/sheets/sync', { method: 'POST' });
      const params = new URLSearchParams({ startDate: toUnix(startDate), endDate: toUnix(today, true) });
      if (resultFilter) params.set('result', resultFilter);
      const data = await fetch(`/api/dashboard?${params}`).then((r) => r.json());
      setStats(data);
    } catch (e) {
      setError(e.message);
    }
    setRefreshing(false);
  }

  const rows = stats
    ? [
        ['STRONG', stats.strongMatches],
        ['PARTIAL', stats.partialMatches],
        ['WEAK', stats.weakMatches],
        ['NEEDS_REVIEW', stats.needsReview || 0],
        ['NONE', stats.noneMatches],
        ['UNKNOWN', stats.unknownMatches],
      ]
    : [];
  const total = rows.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="space-y-10">
      {/* Masthead */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Recruitment</p>
          <h1 className="page-title mt-1">Overview</h1>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} className="btn">
          <svg
            className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"
          >
            <path strokeLinecap="square" d="M20 12a8 8 0 10-2.3 5.7M20 5v5h-5" />
          </svg>
          {refreshing ? 'Syncing' : 'Sync sheet'}
        </button>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-6 border border-rule bg-surface px-5 py-4">
        <DateRangeFilter
          startDate={startDate}
          endDate={endDate}
          onStartChange={setStartDate}
          onEndChange={setEndDate}
        />
        <label className="flex items-center gap-2.5">
          <span className="micro">Match</span>
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value)}
            className="input"
          >
            <option value="">All</option>
            {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="notice-error">Error: {error}</div>}

      {loading ? (
        <div className="grid grid-cols-1 gap-px bg-rule sm:grid-cols-3">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-36" />)}
        </div>
      ) : stats ? (
        <>
          {/* Headline figures */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SummaryCard label="Open roles" value={stats.totalJDs} />
            <SummaryCard label="Candidates" value={stats.totalApplicants} />
            <SummaryCard
              label="Strong matches"
              value={stats.strongMatches}
              emphasis
              hint="Meets essentially all stated requirements"
            />
          </div>

          {/* Review queue call-out */}
          {stats.needsReview > 0 && (
            <Link
              to="/review"
              className="group flex items-center justify-between gap-6 border-2 border-dashed border-ink px-6 py-5 transition-colors hover:bg-surface"
            >
              <div className="flex items-baseline gap-5">
                <span className="tnum text-4xl font-bold leading-none text-ink">
                  {stats.needsReview}
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">Awaiting human review</p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    Classified below the confidence threshold
                  </p>
                </div>
              </div>
              <span className="micro flex items-center gap-2 text-ink">
                Open queue
                <svg className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="square" d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
            </Link>
          )}

          {/* Distribution */}
          <section className="space-y-5">
            <div className="flex items-baseline justify-between border-b border-rule pb-2">
              <h2 className="micro">Match distribution</h2>
              <span className="tnum text-xs text-ink-3">{total} classified</span>
            </div>
            <Distribution rows={rows} total={total} />
          </section>

          {/* Pipeline health */}
          {stats.pipeline && (
            <section className="space-y-4">
              <h2 className="micro border-b border-rule pb-2">Pipeline</h2>
              <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
                {[
                  ['Chats mid-batch', stats.pipeline.pending_batches],
                  ['Unclassified', stats.pipeline.pending_submissions],
                  ['Failed', stats.pipeline.failed_submissions],
                  ['Sheet backlog', stats.pipeline.sheet_backlog],
                ].map(([label, value]) => (
                  <div key={label} className="bg-paper px-4 py-4">
                    <p className="micro">{label}</p>
                    <p
                      className={`tnum mt-2 text-2xl font-bold leading-none ${
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
          )}
        </>
      ) : null}
    </div>
  );
}
