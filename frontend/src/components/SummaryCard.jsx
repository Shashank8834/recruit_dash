/**
 * A stat card with no chrome: the number is the object, the label is a tracked
 * micro-caption, and a single hairline rule separates them. `emphasis` inverts
 * the card to solid ink for the one figure that should dominate the row.
 */
export default function SummaryCard({ label, value, icon, emphasis = false, hint }) {
  return (
    <div
      className={[
        'border p-5',
        emphasis ? 'border-ink bg-ink text-paper' : 'border-rule bg-paper text-ink',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className={[
            'text-[11px] font-semibold uppercase tracking-micro',
            emphasis ? 'text-paper/70' : 'text-ink-2',
          ].join(' ')}
        >
          {label}
        </p>
        {icon && <span className={emphasis ? 'text-paper/60' : 'text-ink-3'}>{icon}</span>}
      </div>

      <p className="tnum mt-6 text-4xl font-bold leading-none tracking-tight">{value}</p>

      {hint && (
        <p
          className={[
            'mt-3 border-t pt-3 text-xs',
            emphasis ? 'border-paper/20 text-paper/70' : 'border-rule text-ink-3',
          ].join(' ')}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
