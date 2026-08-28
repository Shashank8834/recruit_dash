import { useState } from 'react';

/**
 * A list that shows the first few entries and folds the rest behind a count.
 *
 * The talent pool's skills column is why this exists. Extraction was changed
 * to keep every skill a CV names rather than the ten it liked best, which is
 * right for search — a skill that is not stored cannot be searched for — and
 * wrong for a table. A CFO's thirty skills wrapped into a cell five hundred
 * pixels tall, so one candidate filled the screen and the columns either side
 * of it were unreadable.
 *
 * Folding in the renderer rather than storing fewer keeps both properties: the
 * search still matches on all of them, the row stays the height of a row, and
 * nothing is lost — the rest are one click away.
 */
export default function TruncatedList({ items, limit = 5, empty = '—' }) {
  const [expanded, setExpanded] = useState(false);

  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return <span className="text-ink-3">{empty}</span>;

  const hidden = list.length - limit;
  const shown = expanded ? list : list.slice(0, limit);

  return (
    <>
      {shown.join(', ')}
      {hidden > 0 && (
        <button
          type="button"
          // The row this sits in navigates on click. A click meant for the
          // toggle should open the rest of the list, not the candidate.
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(!expanded);
          }}
          // Its own line, always. Left inline it fitted after the last entry
          // for a short list and wrapped for a long one, so the control moved
          // between rows and read as a stray fragment of the list rather than
          // as a thing to press. `w-fit` keeps the underline on the label
          // instead of stretching it across the column.
          className="btn-quiet mt-1 flex w-fit text-xs"
          // The count is in the label, but a screen reader reaching it out of
          // context should still know what is being counted.
          aria-label={expanded ? 'Show fewer' : `Show ${hidden} more`}
          aria-expanded={expanded}
        >
          {expanded ? 'Less' : `+${hidden} more`}
        </button>
      )}
    </>
  );
}
