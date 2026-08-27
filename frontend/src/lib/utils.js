/**
 * Two timestamp shapes reach this file, and both have to work.
 *
 * The WhatsApp screens read serialized rows, where every date is unix seconds.
 * The manual screens read Postgres rows straight out of the repo, where a
 * TIMESTAMPTZ arrives as an ISO string. Multiplying that string by 1000 gives
 * NaN, and `new Date(NaN)` renders as "Invalid Date" — which is why the Added
 * and Created columns on the talent pool and the roles list showed nothing
 * useful. Both are dates; neither caller was wrong; so this is where they meet.
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  // A number (or a numeric string) is unix seconds; anything else is a date
  // string Date already knows how to read.
  const date =
    typeof value === 'number' || /^\d+$/.test(String(value))
      ? new Date(Number(value) * 1000)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A value for `<input type="datetime-local">`, which wants local wall-clock
 * time as `YYYY-MM-DDTHH:mm` and no timezone at all.
 *
 * toISOString() cannot be used here: it converts to UTC, so a meeting booked
 * for 10:30 in India renders in the form as 05:00 the same morning, and every
 * edit that touches the field silently moves the meeting.
 */
export function toDateTimeInput(value) {
  const date = toDate(value);
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Splits a timestamp into the two halves a form edits separately.
 *
 * A single `datetime-local` looks tidier and is a trap: it reports an EMPTY
 * value until BOTH halves are complete, so a half-filled date is
 * indistinguishable from an untouched field. Anything gating on it then blocks
 * a form the user believes they have filled in, with nothing on screen to say
 * what is missing.
 */
export function splitDateTime(value) {
  const date = toDate(value);
  if (!date) return { date: '', time: '' };
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/**
 * The two halves back into what the API takes.
 *
 * The date is what someone actually knows when they book — the time is often
 * "sometime that morning" — so a missing time defaults rather than blocking.
 * No timezone suffix: this is local wall-clock time, and appending Z would
 * move every meeting by the offset.
 */
export const DEFAULT_MEETING_TIME = '10:00';

export function joinDateTime(date, time) {
  if (!date) return '';
  return `${date}T${time || DEFAULT_MEETING_TIME}`;
}

/** Whether a scheduled time has already passed. */
export function isPast(value) {
  const date = toDate(value);
  return date ? date.getTime() < Date.now() : false;
}

export function toDateInput(unixTs) {
  const d = new Date(unixTs * 1000);
  return d.toISOString().split('T')[0];
}

export function toUnix(dateStr, endOfDay = false) {
  const d = new Date(dateStr);
  if (endOfDay) {
    d.setHours(23, 59, 59, 999);
  }
  return Math.floor(d.getTime() / 1000);
}

export function nowMinus(days) {
  return Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
}

/**
 * Days of history the lists open on.
 *
 * Every page sends an explicit startDate, so the server's default window is
 * never consulted — changing it there alone had no effect on what anyone
 * sees. This is the value that actually decides it, which is why it lives in
 * one place rather than as a literal in each page: they had drifted to 30, 30
 * and 90 days, so the dashboard's totals covered a different period than the
 * list you reached by clicking through them.
 */
export const DEFAULT_RANGE_DAYS = 7;
