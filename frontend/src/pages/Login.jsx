import { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth';

/**
 * The way in.
 *
 * Rendered instead of the whole app rather than as a route inside it, so there
 * is no arrangement of the URL bar that puts a signed-out person in front of a
 * screen that will try to load candidate data. It also means no Layout: no
 * sidebar to nowhere, no dark-mode toggle, nothing to click but the one thing
 * there is to do.
 *
 * The monochrome token set carries the whole design here as it does everywhere
 * else — ink on paper, one hard rule, no colour standing in for hierarchy.
 */
export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The login screen has no theme toggle of its own, but it must not be the one
  // white page in a dark app. Reads the same key Layout writes, falling back to
  // the OS preference exactly as Layout does.
  useEffect(() => {
    const saved = localStorage.getItem('darkMode');
    const dark = saved !== null
      ? saved === 'true'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // No navigation and no state reset on success: the provider flips to
      // authenticated and this component stops being rendered at all.
    } catch (e) {
      setError(e.message);
      // The email is left in place. Getting the password wrong should not cost
      // you the field you typed correctly.
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 border-b border-ink pb-5">
          <h1 className="page-title">Recruitment</h1>
          <p className="page-sub">Sign in to continue.</p>
        </div>

        {error && (
          <div className="notice-error mb-5" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="email" className="micro block">
              Email
            </label>
            <input
              id="email"
              className="input w-full"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              // The cursor starts where the typing starts.
              autoFocus
              autoComplete="username"
              required
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="micro block">
              Password
            </label>
            <input
              id="password"
              className="input w-full"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // Named so a password manager can offer to fill and to save it.
              // Without it people pick passwords they can retype, which are
              // the ones worth guessing.
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </div>

          <button
            className="btn-solid w-full justify-center"
            type="submit"
            disabled={busy || !email.trim() || !password}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-8 text-xs leading-relaxed text-ink-3">
          Accounts are created by whoever runs the server. If you need one, or
          you are locked out, ask them.
        </p>
      </div>
    </div>
  );
}
