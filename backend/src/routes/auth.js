const express = require('express');
const router = express.Router();
const usersRepo = require('../repo/users');
const password = require('../services/password');
const { requireAuth, setSessionCookie, clearSessionCookie } = require('../middleware/auth');

/**
 * Signing in and out.
 *
 * The only routes reachable without a session, which is what makes them the
 * ones worth being careful on.
 */

// --------------------------------------------------------------------------
// Throttling
// --------------------------------------------------------------------------
// A login endpoint on a public VPS gets guessed at. Without a limit, an
// attacker gets unlimited attempts at a password chosen by a human, which is a
// contest the human loses.
//
// In memory rather than in Postgres: only this process serves logins, the
// state is worthless a minute later, and a table would put a write on the path
// of every failed attempt — which is exactly the path an attacker controls the
// volume of. It resets on restart, which is a real limitation and an
// acceptable one; restarting the API to reset a lockout is not a shortcut
// anyone is going to find by accident.
const ATTEMPT_LIMIT = parseInt(process.env.LOGIN_ATTEMPT_LIMIT || '8', 10);
const ATTEMPT_WINDOW_MS = parseInt(process.env.LOGIN_ATTEMPT_WINDOW_MS || '900000', 10);
const attempts = new Map();

function attemptKey(req, email) {
  // Keyed on address AND account. On the address alone, one person fumbling
  // their password from an office locks out everyone behind that IP; on the
  // account alone, anybody can lock a colleague out by guessing at their email
  // on purpose.
  return `${req.ip}|${email}`;
}

function throttled(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= ATTEMPT_LIMIT;
}

function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.until) {
    attempts.set(key, { count: 1, until: now + ATTEMPT_WINDOW_MS });
    return;
  }
  entry.count += 1;
  // The window slides on each failure, so a steady trickle of guesses cannot
  // wait out a fixed window and resume.
  entry.until = now + ATTEMPT_WINDOW_MS;
}

// Bounded so a flood of invented emails cannot grow the map without limit —
// the throttle must not become the memory leak it is protecting against.
function sweepAttempts() {
  if (attempts.size < 10000) return;
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now > entry.until) attempts.delete(key);
  }
}

/**
 * A hash of a password nobody has, to spend time against when the account does
 * not exist.
 *
 * Without it, a missing account returns in a millisecond while a real one
 * takes the ~60ms scrypt costs — and that difference alone tells an attacker
 * which of your colleagues' emails are real, before they guess a single
 * password. Compared against on every miss so both paths cost the same.
 */
let decoyHash = null;
const decoyReady = password.hash(require('crypto').randomBytes(32).toString('hex'))
  .then((h) => { decoyHash = h; })
  .catch(() => {});

router.post('/login', async (req, res) => {
  try {
    const { email: rawEmail, password: plain } = req.body || {};
    const email = usersRepo.normaliseEmail(rawEmail);

    if (!email || !plain) {
      return res.status(400).json({ error: 'Email and password are both required.' });
    }

    const key = attemptKey(req, email);
    if (throttled(key)) {
      return res.status(429).json({
        error: 'Too many failed attempts. Wait a few minutes and try again.',
      });
    }

    const user = await usersRepo.findByEmail(email);

    await decoyReady;
    const ok = user
      ? await password.verify(plain, user.password_hash)
      // Still runs the hash, still throws the result away. See decoyHash.
      : await password.verify(plain, decoyHash || '');

    // One message for every failure: wrong password, no such account, disabled
    // account. Telling them apart is a favour to whoever is guessing — "no such
    // account" confirms which emails are worth attacking — and no help at all
    // to someone who simply mistyped.
    if (!ok || !user || user.disabled_at) {
      recordFailure(key);
      sweepAttempts();
      return res.status(401).json({ error: 'Those details were not recognised.' });
    }

    attempts.delete(key);
    const { token, expiresAt } = await usersRepo.createSession(user.id, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setSessionCookie(res, token, expiresAt);

    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('[auth] login failed:', err);
    res.status(500).json({ error: 'Could not sign in. Try again.' });
  }
});

/**
 * Clears the cookie AND deletes the row. Clearing only the cookie leaves a
 * working credential in the database that anyone who captured it can keep
 * using — which is the opposite of what the person clicking "sign out" asked
 * for.
 */
router.post('/logout', async (req, res) => {
  try {
    await usersRepo.destroySession(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] logout failed:', err);
    // The cookie goes regardless. A failed delete must not leave someone who
    // asked to sign out still signed in on this browser.
    clearSessionCookie(res);
    res.json({ ok: true });
  }
});

/**
 * Who the browser is, as far as the server is concerned.
 *
 * The app calls this on load to decide between the dashboard and the login
 * page. A 401 here is the normal, expected answer for a signed-out visitor,
 * not an error worth logging.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      lastLoginAt: req.user.last_login_at,
    },
  });
});

/** Signing out of every browser at once — the answer to a lost laptop. */
router.post('/logout-everywhere', requireAuth, async (req, res) => {
  try {
    await usersRepo.destroyAllForUser(req.user.id);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] logout-everywhere failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
