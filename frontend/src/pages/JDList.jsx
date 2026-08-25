import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DateRangeFilter from '../components/DateRangeFilter';
import { formatDate, toDateInput, toUnix, nowMinus, DEFAULT_RANGE_DAYS } from '../lib/utils';

function StatusTag({ status }) {
  return (
    <span
      className={[
        'inline-flex items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro',
        status === 'open'
          ? 'border-ink bg-ink text-paper'
          : 'border-rule bg-paper text-ink-3',
      ].join(' ')}
    >
      {status}
    </span>
  );
}

export default function JDList() {
  const [jds, setJds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [startDate, setStartDate] = useState(toDateInput(nowMinus(DEFAULT_RANGE_DAYS)));
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

  // No masthead of its own: this renders inside the WhatsApp messages page,
  // which supplies the title. Two headings stacked read as two screens.
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
          <span className="micro">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input"
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <p className="tnum text-sm text-ink-2">{jds.length} posted</p>
      </div>

      {error && <div className="notice-error">Error: {error}</div>}

      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr>
              {['Role', 'Posted', 'By', 'Status', 'Candidates'].map((h) => (
                <th key={h} className="th">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-rule">
                  {[...Array(5)].map((__, j) => (
                    <td key={j} className="px-4 py-4"><div className="skeleton h-4" /></td>
                  ))}
                </tr>
              ))
            ) : jds.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-16 text-center text-sm text-ink-3">
                  No roles found for the selected filters.
                </td>
              </tr>
            ) : (
              jds.map((jd) => (
                <tr
                  key={jd.JD_ID}
                  onClick={() => navigate(`/jds/${jd.JD_ID}`)}
                  className="row-link"
                >
                  <td className="td max-w-md">
                    <p className="font-medium leading-snug text-ink">
                      {jd.Title || (jd.JD_Text
                        ? jd.JD_Text.slice(0, 80) + (jd.JD_Text.length > 80 ? '…' : '')
                        : '—')}
                    </p>
                    <p className="mono-id mt-1">{jd.JD_ID}</p>
                  </td>
                  <td className="td whitespace-nowrap text-ink-2">{formatDate(jd.Date)}</td>
                  <td className="td whitespace-nowrap">{jd.Posted_By || '—'}</td>
                  <td className="td"><StatusTag status={jd.Status} /></td>
                  <td className="td tnum font-bold">{jd.candidateCount ?? 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
