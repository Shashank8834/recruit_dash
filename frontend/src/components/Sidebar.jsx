import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';

/**
 * Two groups, not one list.
 *
 * The product has two halves that must not be confused: what a recruiter
 * curates here, and what arrives from the WhatsApp group on its own. They are
 * backed by separate tables, so the navigation says so — otherwise "Roles" and
 * "Roles" sit next to each other meaning different things, and the only way to
 * tell them apart is to click.
 *
 * Managed here comes first and carries the Overview, because the reviewed and
 * filtered side is the one the day is planned from. WhatsApp is a single
 * destination rather than three: postings, applicants and the review queue are
 * all the same inbox read three ways, and separating them made it a place you
 * had to visit repeatedly instead of one you check.
 */
const groups = [
  {
    label: 'Managed here',
    links: [
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
        to: '/roles',
        label: 'Open roles',
        icon: (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="square" d="M4 7h16v13H4zM9 7V4h6v3M12 12v4M10 14h4" />
          </svg>
        ),
      },
      {
        to: '/meetings',
        label: 'Meetings',
        badgeKey: 'meetings',
        icon: (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="square" d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" />
          </svg>
        ),
      },
      {
        to: '/talent',
        label: 'Talent pool',
        icon: (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="square" d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'From WhatsApp',
    links: [
      {
        to: '/whatsapp',
        label: 'WhatsApp messages',
        badgeKey: 'review',
        icon: (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="square" d="M4 4h16v12H8l-4 4z" />
          </svg>
        ),
      },
    ],
  },
];

export default function Sidebar({ open, onClose, dark, onToggleDark }) {
  const [reviewCount, setReviewCount] = useState(0);
  const [meetingCount, setMeetingCount] = useState(0);

  // Both counts only matter if you notice them climbing, so keep them live.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [review, meetings] = await Promise.all([
          fetch('/api/review/count').then((r) => (r.ok ? r.json() : null)),
          fetch('/api/meetings/summary').then((r) => (r.ok ? r.json() : null)),
        ]);
        if (cancelled) return;
        if (review) setReviewCount(review.count);
        // Meetings whose date has passed and were never closed. Not the count
        // of upcoming ones: a badge should mean "something is waiting for
        // you", and a meeting next Tuesday is not.
        if (meetings) setMeetingCount(meetings.overdue);
      } catch {
        // A transient fetch failure shouldn't surface in the nav.
      }
    }
    poll();
    const timer = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const badges = { review: reviewCount, meetings: meetingCount };

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

      <nav className="flex-1 overflow-y-auto py-3">
        {groups.map((group) => (
          <div key={group.label} className="mb-2">
            <p className="px-5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-micro text-ink-3">
              {group.label}
            </p>
            {group.links.map((link) => (
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
          </div>
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
