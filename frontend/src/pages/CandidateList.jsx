import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import DateRangeFilter from '../components/DateRangeFilter';
import { formatDate, toDateInput, toUnix, nowMinus } from '../lib/utils';

const RESULT_OPTIONS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'UNKNOWN'];

export default function CandidateList() {
  const [applicants, setApplicants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState(toDateInput(nowMinus(30)));
  const [endDate, setEndDate] = useState(toDateInput(Math.floor(Date.now() / 1000)));
  const [resultFilter, setResultFilter] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams({
      startDate: toUnix(startDate),
      endDate: toUnix(endDate, true),
    });
    if (resultFilter) params.set('result', resultFilter);

    setLoading(true);
    fetch(`/api/applicants?${params}`)
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setApplicants(Array.isArray(d) ? d : []); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [startDate, endDate, resultFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Candidates</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">{applicants.length} applicants found</p>
      </div>

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

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr>
                {['Applicant ID', 'Name', 'Date', 'Matched JD', 'Result'].map((h) => (
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
              ) : applicants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                    No applicants found for the selected filters.
                  </td>
                </tr>
              ) : (
                applicants.map((app) => {
                  const rowColor =
                    app.Result === 'STRONG'
                      ? 'bg-green-50 hover:bg-green-100 dark:bg-green-900/10 dark:hover:bg-green-900/20'
                      : app.Result === 'PARTIAL'
                      ? 'bg-yellow-50 hover:bg-yellow-100 dark:bg-yellow-900/10 dark:hover:bg-yellow-900/20'
                      : app.Result === 'NONE'
                      ? 'bg-red-50 hover:bg-red-100 dark:bg-red-900/10 dark:hover:bg-red-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/60';
                  return (
                  <tr
                    key={app.Applicant_ID}
                    onClick={() => navigate(`/candidates/${app.Applicant_ID}`)}
                    className={`cursor-pointer transition-colors ${rowColor}`}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono font-medium text-indigo-600 dark:text-indigo-400">
                      {app.Applicant_ID}
                    </td>
                    <td className="px-4 py-3">
                      {app.Name ? (
                        <p className="text-sm font-semibold text-gray-900 dark:text-white">{app.Name}</p>
                      ) : null}
                      <p className={`text-sm ${app.Name ? 'text-gray-500 dark:text-gray-400' : 'font-medium text-gray-900 dark:text-white'}`}>
                        {app.Sender}
                      </p>
                      {app.Phone && (
                        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{app.Phone}</p>
                      )}
                      {app.Email && (
                        <p className="mt-0.5 max-w-[200px] truncate text-xs text-gray-400 dark:text-gray-500">{app.Email}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                      {formatDate(app.Date)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-600 dark:text-gray-400">
                      {app.JD_ID === 'NONE' || !app.JD_ID ? (
                        <span className="text-gray-400 dark:text-gray-600">—</span>
                      ) : app.JD_ID}
                    </td>
                    <td className="px-4 py-3">
                      <MatchBadge result={app.Result} />
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
