import { createContext, useContext, useEffect, useState, useCallback } from 'react';

/**
 * Who is signed in, for the whole app.
 *
 * The server is the authority — every /api route checks the session cookie
 * itself — so this holds no secret and grants no access. The cookie is
 * httpOnly and unreadable from here by design; all this does is ask the server
 * who it thinks we are, and decide which screen to show. Nothing here can be
 * defeated to reach data, because there is nothing here to defeat.
 */

const AuthContext = createContext(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

export function AuthProvider({ children }) {
  // Three states, not two. "Checking" is genuinely distinct from "signed out",
  // and collapsing them flashes the login page for a moment on every load for
  // somebody who is already signed in.
  const [status, setStatus] = useState('checking');
  const [user, setUser] = useState(null);

  const signedOut = useCallback(() => {
    setUser(null);
    setStatus('anonymous');
  }, []);

  const check = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me');
      if (!response.ok) return signedOut();
      const data = await response.json();
      setUser(data.user);
      setStatus('authenticated');
    } catch {
      // A network failure is not proof of being signed out, but there is
      // nothing useful to render either way, and the login screen at least
      // offers an action.
      signedOut();
    }
  }, [signedOut]);

  useEffect(() => { check(); }, [check]);

  /**
   * A session that expires mid-use must not leave the app sitting on a
   * dashboard full of stale numbers, silently failing every refresh.
   *
   * Every page in this app calls fetch() directly, so the alternative to
   * intercepting here is threading an error handler through fifteen screens
   * and remembering it in the sixteenth. This is deliberately narrow: it reads
   * the status of same-origin /api responses, acts only on 401, and passes
   * everything else through untouched — including the response object itself,
   * so callers see exactly what they would have seen.
   */
  useEffect(() => {
    const original = window.fetch;

    window.fetch = async (...args) => {
      const response = await original(...args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        // The login endpoint answers 401 for a wrong password. Treating that
        // as a session expiry would be harmless but confusing — it would clear
        // a user who was never signed in, and the login page handles it.
        const isAuthCall = url.includes('/api/auth/');
        if (response.status === 401 && url.includes('/api/') && !isAuthCall) {
          signedOut();
        }
      } catch {
        // Never let bookkeeping break a request that otherwise succeeded.
      }
      return response;
    };

    // Restored on unmount so the patch cannot outlive the provider or stack up
    // across hot reloads in development.
    return () => { window.fetch = original; };
  }, [signedOut]);

  async function signIn(email, password) {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Could not sign in. Try again.');
    }
    setUser(data.user);
    setStatus('authenticated');
    return data.user;
  }

  async function signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // Regardless of what the server said. Someone who clicked sign out
      // should not still be looking at the dashboard because the request
      // failed.
      signedOut();
    }
  }

  return (
    <AuthContext.Provider
      value={{ status, user, signIn, signOut, recheck: check }}
    >
      {children}
    </AuthContext.Provider>
  );
}
