import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import MessageThread from '../components/MessageThread';
import { formatDateTime } from '../lib/utils';

const VERDICTS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'UNKNOWN'];

function ReviewCard({ item, index, onResolved }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);
  const [reclassifying, setReclassifying] = useState(false);

  async function toggleThread() {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) {
      try {
        const r = await fetch(`/api/review/submissions/${item.submission_id}`);
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        setDetail(await r.json());
      } catch (e) {
        setError(e.message);
      }
    }
  }

  async function decide(verdict) {
    setSaving(verdict);
    setError(null);
    try {
      const r = await fetch(`/api/review/classifications/${item.classification_id}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, reviewer: 'dashboard' }),
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      onResolved(item.classification_id);
    } catch (e) {
      setError(e.message);
      setSaving(null);
    }
  }

  async function handleReclassify() {
    setReclassifying(true);
    setError(null);
    try {
      const r = await fetch(`/api/review/submissions/${item.submission_id}/reclassify`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      onResolved(item.classification_id);
    } catch (e) {
      setError(e.message);
      setReclassifying(false);
    }
  }

  const confidence = item.confidence === null ? null : Number(item.confidence);
  const busy = saving !== null || reclassifying;

  return (
    <article className="border border-ink">
      {/* Header band */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-surface px-5 py-3">
        <div className="flex items-baseline gap-3">
          <span className="tnum text-[11px] font-bold text-ink-3">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">
              {item.name || item.sender || 'Unknown sender'}
            </p>
            <p className="mono-id mt-0.5">
              {item.phone || '—'} · {formatDateTime(item.ts)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {confidence !== null && (
            <span className="micro tnum text-ink-3">conf {confidence.toFixed(2)}</span>
          )}
          <MatchBadge result="NEEDS_REVIEW" size="sm" />
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap border-l-2 border-ink pl-4 font-sans text-sm leading-relaxed text-ink">
          {item.message || '(no text)'}
        </pre>

        {item.reason && (
          <div>
            <p className="micro">Why it stalled</p>
            <p className="mt-1.5 text-sm text-ink-2">{item.reason}</p>
          </div>
        )}

        {item.jd_external_id && item.jd_external_id !== 'NONE' && (
          <div>
            <p className="micro">Proposed role</p>
            <button
              onClick={() => navigate(`/jds/${item.jd_external_id}`)}
              className="mt-1 font-mono text-sm text-ink underline underline-offset-4 hover:text-ink-2"
            >
              {item.jd_external_id}
            </button>
          </div>
        )}

        <div>
          <button onClick={toggleThread} className="btn-quiet text-xs">
            {expanded ? 'Hide' : 'Show'} original messages
          </button>
          {expanded && (
            <div className="mt-4 border border-dashed border-rule p-4">
              {detail ? (
                <MessageThread messages={detail.messages} />
              ) : (
                <p className="text-sm text-ink-3">Loading…</p>
              )}
            </div>
          )}
        </div>

        {error && <div className="notice-error">{error}</div>}
      </div>

      {/* Decision bar */}
      <div className="flex flex-wrap items-center gap-2 border-t border-rule bg-surface px-5 py-3">
        <span className="micro mr-1">Set verdict</span>
        {VERDICTS.map((v) => (
          <button key={v} onClick={() => decide(v)} disabled={busy} className="btn !px-3 !py-1.5">
            {saving === v ? '…' : v}
          </button>
        ))}
        <button
          onClick={handleReclassify}
          disabled={busy}
          className="btn-quiet ml-auto text-xs"
          title="Run the current prompts over this submission again"
        >
          {reclassifying ? 'Re-running…' : 'Re-classify'}
        </button>
      </div>
    </article>
  );
}

/**
 * @param {(count: number) => void} [onCountChange]
 *   Lets the page around this one keep its own badge honest. Clearing an item
 *   here is the commonest way the queue shrinks, and without this the tab
 *   still advertised the old number until a reload.
 */
export default function Review({ onCountChange }) {
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/review/queue')
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => {
        setItems(d.items);
        setCount(d.count);
        if (onCountChange) onCountChange(d.count);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [onCountChange]);

  useEffect(load, [load]);

  function handleResolved(classificationId) {
    setItems((prev) => prev.filter((i) => i.classification_id !== classificationId));
    setCount((c) => {
      const next = Math.max(0, c - 1);
      if (onCountChange) onCountChange(next);
      return next;
    });
  }

  // No masthead of its own: this renders inside the WhatsApp messages page,
  // which supplies the title.
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border border-rule bg-surface px-5 py-4">
        <p className="max-w-xl text-sm text-ink-2">
          Messages the classifier wasn't confident enough to decide. Your verdict is
          stored alongside the model's and always wins.
        </p>
        <button onClick={load} className="btn">Refresh</button>
      </div>

      {error && <div className="notice-error">Error: {error}</div>}

      {loading ? (
        <div className="space-y-5">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-56" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="border border-dashed border-rule px-6 py-20 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center border-2 border-ink">
            <svg className="h-5 w-5 text-ink" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="square" d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <p className="mt-5 text-sm font-semibold text-ink">Nothing waiting</p>
          <p className="mt-1 text-sm text-ink-3">
            Every classification currently meets the confidence threshold.
          </p>
        </div>
      ) : (
        <>
          <p className="micro">
            {items.length} of {count} · lowest confidence first
          </p>
          <div className="space-y-6">
            {items.map((item, i) => (
              <ReviewCard
                key={item.classification_id}
                item={item}
                index={i}
                onResolved={handleResolved}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
