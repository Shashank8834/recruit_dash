/**
 * Reading a failed API response.
 *
 * Every screen used to do this itself, and most of them did it by throwing
 * away the answer: `Server error ${r.status}` discards a body the server took
 * the trouble to write. The visible cost was a panel reading "Error: Server
 * error 401" when what the server actually said was "Sign in to continue." —
 * a number where there was a sentence, on the one screen that most needed to
 * explain itself.
 *
 * Every route in this API returns `{ error: "..." }` on failure. This reads it.
 */

/**
 * What a bare status code means, when there is no body to read.
 *
 * Reached only when a response has no JSON at all — nginx refusing a request
 * before it ever gets to the app, a proxy timing out, a container that is not
 * up yet. The app's own errors always carry a message, so anything landing
 * here is infrastructure, and the wording says so rather than blaming the
 * thing the user just clicked.
 */
function statusMessage(status) {
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return 'You do not have access to that.';
  if (status === 404) return 'Not found.';
  if (status === 413) return 'That file is too large.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (status >= 500) return 'The server failed on that request. Try again.';
  return `The request failed (${status}).`;
}

/**
 * The Error to throw for a failed response, with the server's own words in it.
 *
 * Async because reading the body is: callers do `throw await errorFrom(r)`, or
 * hand the whole thing to readJson below. The body is consumed here, so a
 * caller that has already read it must not call this.
 */
export async function errorFrom(response) {
  const detail = await response.json().catch(() => null);
  const message = detail && typeof detail.error === 'string' && detail.error.trim();
  return new Error(message || statusMessage(response.status));
}

/**
 * A response's JSON, or a throw carrying the server's message.
 *
 * `fetch(url).then(readJson)` replaces the four-line ok-check that every page
 * had written out by hand — and had written slightly differently, which is how
 * some of them ended up reporting a status code and others a sentence.
 */
export async function readJson(response) {
  if (!response.ok) throw await errorFrom(response);
  return response.json();
}
