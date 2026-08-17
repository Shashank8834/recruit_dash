/**
 * Requirement status without colour: a filled/half/empty/hollow marker plus a
 * tracked caption. The quote is the substance, so it gets the visual weight —
 * indented behind a hard ink rule, in italic, like a pull-quote.
 */
const MARKERS = {
  met:         { fill: 'bg-ink border-ink', label: 'Met' },
  partial:     { fill: 'bg-gradient-to-r from-ink from-50% to-transparent to-50% border-ink', label: 'Partial' },
  unmet:       { fill: 'bg-paper border-ink', label: 'Unmet' },
  unaddressed: { fill: 'bg-paper border-ink-3 border-dotted', label: 'Unaddressed' },
};

export default function EvidenceList({ evidence }) {
  if (!evidence?.length) {
    return (
      <p className="border border-dashed border-rule px-4 py-3 text-sm text-ink-3">
        No evidence recorded — the model could not quote support for any requirement.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {evidence.map((item, i) => {
        const marker = MARKERS[item.status] || MARKERS.unaddressed;
        const muted = item.status === 'unaddressed';

        return (
          <li key={`${item.requirement}-${i}`} className="py-3.5">
            <div className="flex items-baseline gap-3">
              <span
                className={`mt-1 h-2.5 w-2.5 flex-shrink-0 border ${marker.fill}`}
                aria-hidden="true"
              />
              <span
                className={`flex-1 text-sm font-medium ${muted ? 'text-ink-3' : 'text-ink'}`}
              >
                {item.requirement}
              </span>
              <span className="micro flex-shrink-0 text-ink-3">{marker.label}</span>
            </div>

            {item.quote ? (
              <blockquote className="mt-2 border-l-2 border-ink pl-4 text-sm italic leading-relaxed text-ink-2">
                {item.quote}
              </blockquote>
            ) : (
              <p className="mt-1.5 pl-[22px] text-xs text-ink-3">
                Not addressed in the candidate's message.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
