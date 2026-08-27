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

/**
 * "1st", "2nd", "3rd", "11th" — for numbering a person's meetings.
 *
 * The teens are the whole reason this is a function rather than a lookup on the
 * last digit: 11, 12 and 13 take "th" while 21, 22 and 23 do not, so a naive
 * version renders somebody's 11th meeting as their "11st".
 */
export function ordinal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  const tens = num % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' }[num % 10] || 'th');
  return `${num}${suffix}`;
}

/**
 * How long ago, or how far off — "3 days ago", "in 2 weeks", "today".
 *
 * A date on its own does not answer the question anybody is actually asking.
 * "Mar 10" tells you nothing about whether that person has gone cold; "5
 * months ago" tells you immediately, and it is the same fact. So dates on
 * meetings are shown both ways: the absolute one because it is what you put in
 * a calendar, the relative one because it is what you judge by.
 *
 * Thresholds are deliberately coarse. Nobody schedules around "37 days ago" —
 * "over a month ago" is the unit the decision is actually made in.
 */
export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return '';

  const ms = date.getTime() - Date.now();
  const future = ms > 0;
  const mins = Math.round(Math.abs(ms) / 60000);

  if (mins < 1) return 'just now';
  if (mins < 60) return future ? `in ${mins} min` : `${mins} min ago`;

  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return future
      ? `in ${hours} hour${hours === 1 ? '' : 's'}`
      : `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  // Whole calendar days apart, not 24-hour blocks: a meeting at 9am tomorrow
  // is "tomorrow" even when it is 20 hours away, which is how anyone reading a
  // schedule means it.
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);

  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';

  const away = Math.abs(days);
  if (away < 7) return future ? `in ${away} days` : `${away} days ago`;

  if (away < 31) {
    const weeks = Math.round(away / 7);
    return future
      ? `in ${weeks} week${weeks === 1 ? '' : 's'}`
      : `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }

  if (away < 365) {
    const months = Math.round(away / 30);
    return future
      ? `in ${months} month${months === 1 ? '' : 's'}`
      : `${months} month${months === 1 ? '' : 's'} ago`;
  }

  const years = Math.round(away / 365);
  return future
    ? `in ${years} year${years === 1 ? '' : 's'}`
    : `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Whole days between two timestamps, for the gap between one meeting and the
 * next. Null when either end is missing, so a caller renders nothing rather
 * than "NaN days".
 */
export function daysBetween(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
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
