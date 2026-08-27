const crypto = require('crypto');
const { query } = require('../db');
const password = require('../services/password');

/**
 * Accounts and the sessions they hold.
 *
 * The session half deliberately lives here beside the user half: every read of
 * a session immediately needs the user behind it, and splitting them would put
 * a join across two files for no gain.
 */

// How long a login lasts before it has to be done again. Long enough not to be
// a daily irritation on a tool someone uses all day, short enough that a
// forgotten browser does not stay open indefinitely.
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '30', 10);

// 32 bytes from the CSPRNG. This is the whole credential — anyone holding it is
// the user — so it has to be unguessable, not merely unique. Date.now() or a
// counter would be both unique and trivially forged.
const TOKEN_BYTES = 32;

/** Sessions are stored by hash; this is the one place that mapping is defined. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * The shape every caller gets. Never the password hash, and never the session
 * token — a serialiser that has to remember to strip a secret is one `SELECT *`
 * away from leaking it, so the secret never enters the object at all.
 */
const PUBLIC_FIELDS = 'id, email, name, disabled_at, last_login_at, created_at';

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function create({ email, name, password: plain }) {
  const hash = await password.hash(plain);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3)
     RETURNING ${PUBLIC_FIELDS}`,
    [normaliseEmail(email), String(name).trim(), hash]
  );
  return rows[0];
}

async function findByEmail(email) {
  const { rows } = await query(
    `SELECT ${PUBLIC_FIELDS}, password_hash FROM users WHERE email = $1`,
    [normaliseEmail(email)]
  );
  return rows[0] || null;
}

async function list() {
  const { rows } = await query(
    `SELECT ${PUBLIC_FIELDS} FROM users ORDER BY disabled_at NULLS FIRST, name`
  );
  return rows;
}

async function setPassword(email, plain) {
  const hash = await password.hash(plain);
  const { rows } = await query(
    `UPDATE users SET password_hash = $2, updated_at = now()
      WHERE email = $1 RETURNING ${PUBLIC_FIELDS}`,
    [normaliseEmail(email), hash]
  );
  return rows[0] || null;
}

/**
 * Disabling also drops the live sessions.
 *
 * Flipping the flag alone would leave whoever is already signed in signed in —
 * for up to SESSION_DAYS — which is exactly the window you are trying to close
 * when you disable somebody. The requireAuth middleware re-checks the flag on
 * every request as a second line, but the sessions go now.
 */
async function setDisabled(email, disabled) {
  const { rows } = await query(
    `UPDATE users SET disabled_at = $2, updated_at = now()
      WHERE email = $1 RETURNING ${PUBLIC_FIELDS}`,
    [normaliseEmail(email), disabled ? new Date() : null]
  );
  const user = rows[0] || null;
  if (user && disabled) await destroyAllForUser(user.id);
  return user;
}

/**
 * Issues a session and returns the raw token — the only moment it exists in
 * readable form. The caller puts it in a cookie; the database keeps the hash.
 */
async function createSession(userId, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5)`,
    [hashToken(token), userId, expiresAt, userAgent || null, ip || null]
  );
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { token, expiresAt };
}

/**
 * The user behind a token, or null.
 *
 * Expiry is enforced in the WHERE clause rather than by comparing dates in
 * JavaScript afterwards. The database's clock is the one the row was written
 * against, and a check that runs in the query cannot be forgotten by a caller.
 *
 * A disabled account is refused here too, so revoking access takes effect on
 * the next request even for a session issued before it.
 */
async function findBySessionToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.disabled_at, u.last_login_at, u.created_at,
            s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.disabled_at IS NULL`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

/** Cheap enough to run per request, and it is what makes an idle session visible. */
async function touchSession(token) {
  await query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1',
    [hashToken(token)]);
}

async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function destroyAllForUser(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/**
 * Expired rows are dead weight, not a security problem — findBySessionToken
 * already refuses them. This only keeps the table from growing forever.
 */
async function pruneSessions() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at <= now()');
  return rowCount;
}

async function count() {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM users WHERE disabled_at IS NULL'
  );
  return rows[0].total;
}

module.exports = {
  create, findByEmail, list, setPassword, setDisabled, count,
  createSession, findBySessionToken, touchSession,
  destroySession, destroyAllForUser, pruneSessions,
  normaliseEmail, hashToken,
  SESSION_DAYS,
};
