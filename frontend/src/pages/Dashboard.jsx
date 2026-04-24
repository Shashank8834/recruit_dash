import { useState, useEffect } from 'react';
import SummaryCard from '../components/SummaryCard';
import DateRangeFilter from '../components/DateRangeFilter';
import { toDateInput, toUnix, nowMinus } from '../lib/utils';

const RESULT_OPTIONS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'UNKNOWN'];

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

  async function handleRefresh() {
    setRefreshing(true);
    const today = toDateInput(Math.floor(Date.now() / 1000));
    if (endDate < today) setEndDate(today);
    await fetch('/api/refresh', { method: 'POST' });
    const params = new URLSearchParams({ startDate: toUnix(startDate), endDate: toUnix(today, true) });
    if (resultFilter) params.set('result', resultFilter);
    const data = await fetch(`/api/dashboard?${params}`).then((r) => r.json());
    setStats(data);
    setRefreshing(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Recruitment overview</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <svg className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh data
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <DateRangeFilter
          startDate={startDate}
          endDate={endDate}
          onStartChange={setStartDate}
          onEndChange={setEndDate}
        />
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600 dark:text-gray-400">Match</label>
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          >
            <option value="">All</option>
            {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          Error: {error}
        </div>
      )}

      {/* Summary cards */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-800" />
          ))}
        </div>
      ) : stats ? (
        <>
          {/* Top 3 KPI cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SummaryCard
              label="Total Job Descriptions"
              value={stats.totalJDs}
              color="indigo"
              icon={<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
            />
            <SummaryCard
              label="Total Applicants"
              value={stats.totalApplicants}
              color="indigo"
              icon={<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
            />
            <SummaryCard
              label="Strong Matches"
              value={stats.strongMatches}
              color="green"
              icon={<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
            />
          </div>

          {/* Match breakdown row */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Partial</p>
              <p className="mt-1 text-xl font-bold text-amber-600 dark:text-amber-400">{stats.partialMatches}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Weak</p>
              <p className="mt-1 text-xl font-bold text-orange-600 dark:text-orange-400">{stats.weakMatches}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">No Match</p>
              <p className="mt-1 text-xl font-bold text-red-600 dark:text-red-400">{stats.noneMatches}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Unknown</p>
              <p className="mt-1 text-xl font-bold text-gray-500 dark:text-gray-400">{stats.unknownMatches}</p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
