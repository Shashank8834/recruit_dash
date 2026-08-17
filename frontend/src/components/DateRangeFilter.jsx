export default function DateRangeFilter({ startDate, endDate, onStartChange, onEndChange }) {
  return (
    <div className="flex flex-wrap items-center gap-5">
      <label className="flex items-center gap-2.5">
        <span className="micro">From</span>
        <input
          type="date"
          value={startDate}
          onChange={(e) => onStartChange(e.target.value)}
          className="input"
        />
      </label>
      <label className="flex items-center gap-2.5">
        <span className="micro">To</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => onEndChange(e.target.value)}
          className="input"
        />
      </label>
    </div>
  );
}
