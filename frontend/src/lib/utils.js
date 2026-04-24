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
