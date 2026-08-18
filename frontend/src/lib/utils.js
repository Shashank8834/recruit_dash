export function formatDate(unixTs) {
  if (!unixTs) return '—';
  return new Date(unixTs * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(unixTs) {
  if (!unixTs) return '—';
  return new Date(unixTs * 1000).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
