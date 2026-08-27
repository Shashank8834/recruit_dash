const usersRepo = require('../repo/users');

/**
 * The gate in front of the API.
 *
 * The dashboard holds CVs, phone numbers, salary figures and private notes
 * about named people, and until this existed all of it was readable by anyone
 * who found the port. A login screen on its own would not have changed that —
 * it hides pages, not data — so the check that matters is this one, on the
 * server, in front of every route that returns any of it.
 */

const COOKIE_NAME = 'rd_session';

// Secure cookies need HTTPS, and setting the flag unconditionally would break
// the login on a plain-http VPS in a way that gives no clue why: the browser
// accepts the response, silently discards the cookie, and the next request is
// a 401. So it follows the deployment rather than being hardcoded either way.
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';

/**
 * Reads one cookie out of the request header.
 *
 * Hand-rolled rather than pulling in cookie-parser: this needs exactly one
 * value, and `cookie` is only present in node_modules today as a transitive
 * dependency of express — depending on it without declaring it is the kind of
 * thing that breaks on an unrelated upgrade.
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed cookie is not a session. Falling through to null makes it
      // a clean 401 rather than a 500 on every request until it is cleared.
      return null;
    }
  }
  return null;
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie(COOKIE_NAME, token, {
    // httpOnly is what keeps the token out of reach of any script on the page.
    // Held in localStorage instead, a single XSS anywhere in the dashboard
    // reads it and the session walks out of the building.
    httpOnly: true,
    // 'lax' still sends the cookie on ordinary navigation to the app, but not
    // on a cross-site form post — which is what stops another site from making
    // authenticated writes with the browser's own credentials.
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    expires: expiresAt,
    path: '/',
  });
}

function clearSessionCookie(res) {
  // The attributes have to match the ones it was set with or the browser keeps
  // the original cookie and "sign out" does nothing.
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, path: '/',
  });
}

/**
 * Attaches `req.user` when the request carries a live session, and does not
 * refuse anything. Mounted app-wide so routes that merely want to KNOW who is
 * asking — notes, stamping an author — can read it without every one of them
 * repeating the lookup.
 */
async function attachUser(req, _res, next) {
  try {
    const token = readCookie(req, COOKIE_NAME);
    if (token) {
      const user = await usersRepo.findBySessionToken(token);
      if (user) {
        req.user = user;
        req.sessionToken = token;
        // Deliberately not awaited. It is bookkeeping for a "last seen"
        // column, and making every authenticated request wait on a second
        // round trip to the database to record that it happened is a poor
        // trade. A lost write here costs an inaccurate timestamp.
        usersRepo.touchSession(token).catch(() => {});
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Refuses anything without a session. This is the actual gate.
 *
 * 401 and a JSON body, never a redirect: every caller is fetch() from a
 * single-page app, and a 302 to /login would be followed transparently and
 * arrive as an HTML page where JSON was expected — which surfaces as a parse
 * error somewhere unrelated instead of "you are signed out".
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in to continue.', code: 'unauthenticated' });
  }
  next();
}

module.exports = {
  COOKIE_NAME, attachUser, requireAuth, setSessionCookie, clearSessionCookie, readCookie,
};
