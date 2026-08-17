import { formatDateTime } from '../lib/utils';

/**
 * The individual WhatsApp messages chained into one submission, on a timeline
 * rule. When a verdict looks wrong the cause is usually visible here — a batch
 * that closed too early, or an unrelated message swept into the window.
 */
export default function MessageThread({ messages }) {
  if (!messages?.length) {
    return (
      <p className="text-sm text-ink-3">
        No individual messages stored (imported or seeded record).
      </p>
    );
  }

  return (
    <ol className="relative">
      {/* The spine */}
      <span
        className="absolute left-[7px] top-2 bottom-2 w-px bg-rule"
        aria-hidden="true"
      />
      {messages.map((m, i) => (
        <li key={m.id} className="relative pl-7 pb-5 last:pb-0">
          <span
            className="absolute left-0 top-1.5 flex h-[15px] w-[15px] items-center justify-center border border-ink bg-paper text-[9px] font-bold text-ink"
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <p className="micro text-ink-3">{formatDateTime(m.sentAt)}</p>
          {m.body && (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {m.body}
            </p>
          )}
          {m.mediaType && (
            <span className="mt-1.5 inline-flex items-center gap-1.5 border border-dashed border-rule px-2 py-0.5 font-mono text-[11px] text-ink-2">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="square" d="M5 3h9l5 5v13H5zM14 3v5h5" />
              </svg>
              {m.mediaFilename || m.mediaType}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
