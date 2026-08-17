import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';

const links = [
  {
    to: '/dashboard',
    label: 'Overview',
    icon: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="square" d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />
      </svg>
    ),
  },
  {
    to: '/jds',
    label: 'Roles',
    icon: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="square" d="M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h8" />
      </svg>
    ),
  },
  {
    to: '/candidates',
    label: 'Candidates',
    icon: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="square" d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0" />
      </svg>
    ),
  },
  {
    to: '/review',
    label: 'Review',
    badgeKey: 'review',
    icon: (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="square" d="M4 4h16v16H4zM8 12l3 3 5-6" />
      </svg>
    ),
  },
];

export default function Sidebar({ open, onClose, dark, onToggleDark }) {
  const [reviewCount, setReviewCount] = useState(0);

  // The queue only matters if you notice it filling up, so keep the count live.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch('/api/review/count');
        if (!r.ok) return;
        const { count } = await r.json();
        if (!cancelled) setReviewCount(count);
      } catch {
        // A transient fetch failure shouldn't surface in the nav.
      }
    }
    poll();
    const timer = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const badges = { review: reviewCount };

  return (
    <aside
      className={[
        'fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-rule bg-paper',
        'transition-transform duration-200 lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      ].join(' ')}
    >
      {/* Wordmark */}
      <div className="flex items-center justify-between border-b border-rule px-5 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center bg-ink text-[13px] font-bold text-paper">
            R
          </span>
          <span className="text-[13px] font-bold uppercase tracking-micro text-ink">
            Recruiter
          </span>
        </div>
        <button
          className="text-ink-2 transition-colors hover:text-ink lg:hidden"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="square" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 py-3">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            onClick={onClose}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-5 py-3 text-[13px] font-medium transition-colors',
                isActive
                  ? 'bg-ink text-paper'
                  : 'text-ink-2 hover:bg-surface hover:text-ink',
              ].join(' ')
            }
          >
            {link.icon}
            <span className="flex-1">{link.label}</span>
            {link.badgeKey && badges[link.badgeKey] > 0 && (
              <span className="tnum border border-current px-1.5 py-px text-[10px] font-bold">
                {badges[link.badgeKey]}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-rule px-5 py-4">
        <button
          onClick={onToggleDark}
          className="flex w-full items-center gap-2.5 text-[11px] font-semibold uppercase tracking-micro text-ink-2 transition-colors hover:text-ink"
        >
          <span className="flex h-4 w-4 items-center justify-center border border-current">
            <span className={dark ? 'h-2 w-2 bg-current' : 'h-2 w-2'} />
          </span>
          {dark ? 'Dark' : 'Light'}
        </button>
      </div>
    </aside>
  );
}
