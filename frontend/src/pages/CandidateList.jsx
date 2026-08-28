import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import DateRangeFilter from '../components/DateRangeFilter';
import { formatDate, toDateInput, toUnix, nowMinus, DEFAULT_RANGE_DAYS } from '../lib/utils';
import { readJson } from '../lib/api';

const RESULT_OPTIONS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'NEEDS_REVIEW', 'UNKNOWN'];

export default function CandidateList() {
  const [applicants, setApplicants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState(toDateInput(nowMinus(DEFAULT_RANGE_DAYS)));
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
      .then(readJson)
      .then((d) => { setApplicants(Array.isArray(d) ? d : []); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [startDate, endDate, resultFilter]);

  // No masthead of its own: this renders inside the WhatsApp messages page,
  // which supplies the title.
  return (
    <div className="space-y-6">
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
        <p className="tnum text-sm text-ink-2">{applicants.length} in range</p>
      </div>

      {error && <div className="notice-error">{error}</div>}

      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr>
              {['Candidate', 'Received', 'Role', 'Confidence', 'Verdict'].map((h) => (
                <th key={h} className="th">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [...Array(6)].map((_, i) => (
                <tr key={i} className="border-b border-rule">
                  {[...Array(5)].map((__, j) => (
                    <td key={j} className="px-4 py-4"><div className="skeleton h-4" /></td>
                  ))}
                </tr>
              ))
            ) : applicants.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-16 text-center text-sm text-ink-3">
                  No candidates found for the selected filters.
                </td>
              </tr>
            ) : (
              applicants.map((app) => (
                <tr
                  key={app.Applicant_ID}
                  onClick={() => navigate(`/candidates/${app.Applicant_ID}`)}
                  className="row-link"
                >
                  <td className="td">
                    <p className="font-medium text-ink">{app.Name || app.Sender || '—'}</p>
                    <p className="mono-id mt-1">
                      {app.Phone || app.Applicant_ID}
                    </p>
                    {app.Email && (
                      <p className="mt-0.5 max-w-[220px] truncate text-xs text-ink-3">{app.Email}</p>
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-ink-2">{formatDate(app.Date)}</td>
                  <td className="td whitespace-nowrap font-mono text-xs text-ink-2">
                    {!app.JD_ID || app.JD_ID === 'NONE'
                      ? <span className="text-ink-3">—</span>
                      : app.JD_ID}
                  </td>
                  <td className="td tnum whitespace-nowrap text-ink-2">
                    {app.confidence === null || app.confidence === undefined
                      ? '—'
                      : Number(app.confidence).toFixed(2)}
                  </td>
                  <td className="td">
                    <MatchBadge
                      result={app.Result}
                      overridden={!!app.overrideVerdict}
                      size="sm"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
