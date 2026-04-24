import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import DateRangeFilter from '../components/DateRangeFilter';
import { formatDate, toDateInput, toUnix, nowMinus } from '../lib/utils';

export default function JDList() {
  const [jds, setJds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState(toDateInput(nowMinus(30)));
  const [endDate, setEndDate] = useState(toDateInput(Math.floor(Date.now() / 1000)));
  const [statusFilter, setStatusFilter] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams({
      startDate: toUnix(startDate),
      endDate: toUnix(endDate, true),
    });
    if (statusFilter) params.set('status', statusFilter);

    setLoading(true);
    fetch(`/api/jds?${params}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setJds(Array.isArray(d) ? d : []); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [startDate, endDate, statusFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Job Descriptions</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">{jds.length} JDs found</p>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <DateRangeFilter
          startDate={startDate}
          endDate={endDate}
          onStartChange={setStartDate}
          onEndChange={setEndDate}
        />
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-600 dark:text-gray-400">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          Error: {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                {['Job Summary', 'Date', 'Posted By', 'Status', 'Candidates'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(5)].map((__, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : jds.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                    No job descriptions found for the selected filters.
                  </td>
                </tr>
              ) : (
                jds.map((jd) => (
                  <tr
                    key={jd.JD_ID}
                    onClick={() => navigate(`/jds/${jd.JD_ID}`)}
                    className="cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60"
                  >
                    <td className="px-4 py-3 max-w-sm">
                      <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-2">
                        {jd.JD_Text ? jd.JD_Text.slice(0, 80) + (jd.JD_Text.length > 80 ? '…' : '') : '—'}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-indigo-500 dark:text-indigo-400">{jd.JD_ID}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                      {formatDate(jd.Date)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">{jd.Posted_By}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        jd.Status === 'open'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {jd.Status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                      {jd.candidateCount}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
