/**
 * Colour normally does the work of ranking these five verdicts at a glance.
 * With a monochrome palette that job falls to two other channels:
 *
 *   1. Ink density — STRONG is a solid ink block, and each step down sheds
 *      weight until NONE is barely present on the page.
 *   2. A three-segment meter — filled segments give an ordinal read that
 *      survives greyscale, printing, and colour-blind vision alike.
 *
 * The two unranked states use border style instead: dashed reads as
 * "unresolved" for NEEDS_REVIEW, dotted as "absent" for UNKNOWN.
 */
const VARIANTS = {
  STRONG:       { rank: 3, cls: 'border-ink bg-ink text-paper' },
  PARTIAL:      { rank: 2, cls: 'border-ink bg-paper text-ink' },
  WEAK:         { rank: 1, cls: 'border-ink-3 bg-paper text-ink-2' },
  NONE:         { rank: 0, cls: 'border-transparent bg-surface text-ink-3' },
  NEEDS_REVIEW: { rank: null, glyph: '?', cls: 'border-dashed border-ink bg-paper text-ink' },
  UNKNOWN:      { rank: null, glyph: '–', cls: 'border-dotted border-ink-3 bg-paper text-ink-3' },
};

const LABELS = { NEEDS_REVIEW: 'Needs review' };

function Meter({ rank }) {
  return (
    <span className="flex items-center gap-[2px]" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={
            i < rank
              ? 'h-2 w-[3px] bg-current'
              : 'h-2 w-[3px] border border-current opacity-40'
          }
        />
      ))}
    </span>
  );
}

export default function MatchBadge({ result, overridden, size = 'md' }) {
  const key = VARIANTS[result] ? result : 'UNKNOWN';
  const { rank, glyph, cls } = VARIANTS[key];
  const label = LABELS[key] || key.replace(/_/g, ' ').toLowerCase();

  return (
    <span
      className={[
        'inline-flex items-center gap-2 border font-semibold uppercase tracking-micro',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
        cls,
      ].join(' ')}
      title={overridden ? 'Set by a human reviewer' : undefined}
    >
      {rank !== null ? <Meter rank={rank} /> : <span aria-hidden="true">{glyph}</span>}
      {label}
      {overridden && (
        <span
          className="ml-0.5 border-l border-current pl-1.5 text-[9px] opacity-70"
          title="Human override"
        >
          HUMAN
        </span>
      )}
    </span>
  );
}
