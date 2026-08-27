import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import SummaryCard from '../components/SummaryCard';
import { STAGES, stageLabel } from '../components/RoleStage';
import MeetingList from '../components/MeetingList';
import { formatDate } from '../lib/utils';

/**
 * The overview of the side a recruiter curates.
 *
 * It reports on Open roles and the Talent pool, and on nothing else. Those are
 * the two sets that have been reviewed and filtered by a person, so they are
 * the only ones whose totals mean anything — a count that mixes them with
 * unreviewed WhatsApp traffic answers a question nobody asked. The pipeline's
 * own health moved to the WhatsApp messages page, next to the messages it
 * describes.
 *
 * No date filter, deliberately. A talent pool accumulates: a CV uploaded in
 * March is exactly as useful in August, and a seven-day window on this screen
 * would report a shrinking pool that is in fact growing. "Added this week" is
 * offered as one figure among many rather than as a lens over all of them.
 */

/**
 * Where a note's subject lives, so a note is one click from the record it is
 * about. Notes are written on four different screens; a feed that only shows
 * the text turns every entry into a hunt for what it referred to.
 */
const NOTE_LINK = {
  candidate: (ref) => `/talent/${ref}`,
  role:      (ref) => `/roles/${ref}`,
  posting:   (ref) => `/jds/${ref}`,
  applicant: (ref) => `/candidates/${ref}`,
  meeting:   (ref) => `/meetings/${ref}`,
};

const NOTE_LABEL = {
  candidate: 'Candidate',
  role: 'Role',
  posting: 'Posting',
  applicant: 'Applicant',
  meeting: 'Meeting',
};

/** Stage mix as a stacked ink bar, densest at the stage needing most attention. */
function StageBar({ stages, total }) {
  if (!total) return <p className="text-sm text-ink-3">No roles yet.</p>;

  return (
    <div className="space-y-5">
      <div className="flex h-3 w-full overflow-hidden border border-ink">
        {STAGES.map(({ key, label, bar }) =>
          stages[key] > 0 ? (
            <span
              key={key}
              className={bar}
              style={{ width: `${(stages[key] / total) * 100}%` }}
              title={`${label}: ${stages[key]}`}
            />
          ) : null
        )}
      </div>

      {/* Each entry links to the list filtered to that stage — the number is
          only interesting if you can get to what it counts. */}
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        {STAGES.map(({ key, label, bar }) => (
          <Link
            key={key}
            to={`/roles?status=${key}`}
            className="flex items-center gap-2.5 border-b border-rule pb-2 transition-colors hover:border-ink"
          >
            <span className={`h-2.5 w-2.5 flex-shrink-0 border border-ink ${bar}`} />
            <dt className="micro flex-1 truncate">{label}</dt>
            <dd className="tnum text-sm font-bold text-ink">{stages[key] || 0}</dd>
          </Link>
        ))}
      </dl>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/dashboard/managed')
      .then((r) => { if (!r.ok) throw new Error(`Server error ${r.status}`); return r.json(); })
      .then((d) => { setStats(d); setError(null); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(load, [load]);

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Managed here</p>
          <h1 className="page-title mt-1">Overview</h1>
          <p className="page-sub">Your open roles and the talent pool you curate.</p>
        </div>
        <button onClick={load} disabled={loading} className="btn">
          <svg
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"
          >
            <path strokeLinecap="square" d="M20 12a8 8 0 10-2.3 5.7M20 5v5h-5" />
          </svg>
          Refresh
        </button>
      </header>

      {error && <div className="notice-error">Error: {error}</div>}

      {loading && !stats ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-36" />)}
        </div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              label="Roles in play"
              value={stats.roles.active}
              hint={`${stats.roles.stages.placed} placed · ${stats.roles.stages.closed} closed`}
            />
            <SummaryCard
              label="Meetings booked"
              value={(stats.meetings || {}).upcoming || 0}
              hint={`${(stats.meetings || {}).held || 0} already held`}
            />
            <SummaryCard
              label="Talent pool"
              value={stats.talent.total}
              hint={`${stats.talent.uploaded} from CVs · ${stats.talent.hand_entered} entered by hand`}
            />
            <SummaryCard
              label="Strong matches"
              value={stats.matches.strong}
              emphasis
              hint={`${stats.matches.partial} partial, across ${stats.matches.total} suggestions`}
            />
          </div>

          {(stats.upcomingMeetings || []).length > 0 && (
            <section className="space-y-3">
              <div className="flex items-baseline justify-between border-b border-rule pb-2">
                <h2 className="micro">Next meetings</h2>
                <Link to="/meetings" className="btn-quiet text-xs">All meetings</Link>
              </div>
              <MeetingList meetings={stats.upcomingMeetings} />
            </section>
          )}

          <section className="space-y-5">
            <div className="flex items-baseline justify-between border-b border-rule pb-2">
              <h2 className="micro">Roles by stage</h2>
              <Link to="/roles" className="btn-quiet text-xs">All roles</Link>
            </div>
            <StageBar stages={stats.roles.stages} total={stats.roles.total} />
          </section>

          <section className="space-y-4">
            <div className="flex items-baseline justify-between border-b border-rule pb-2">
              <h2 className="micro">Talent pool</h2>
              <Link to="/talent" className="btn-quiet text-xs">Open</Link>
            </div>
            <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
              {[
                ['Added this week', stats.talent.added_7d],
                ['Added this month', stats.talent.added_30d],
                ['With a CV on file', stats.talent.with_cv],
                ['With notes', stats.talent.with_notes],
              ].map(([label, value]) => (
                <div key={label} className="bg-paper px-4 py-4">
                  <p className="micro">{label}</p>
                  <p className="tnum mt-2 text-2xl font-bold leading-none text-ink">{value}</p>
                </div>
              ))}
            </div>
          </section>

          {(stats.recentNotes || []).length > 0 && (
            <section className="space-y-3">
              <h2 className="micro border-b border-rule pb-2">Latest notes</h2>
              <ul className="space-y-2">
                {stats.recentNotes.map((note) => (
                  <li key={note.id} className="border border-rule bg-surface px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link
                        to={NOTE_LINK[note.target](note.ref)}
                        className="text-sm font-semibold text-ink hover:underline hover:underline-offset-4"
                      >
                        {note.subject || note.ref}
                      </Link>
                      <p className="mono">
                        {NOTE_LABEL[note.target]} · {formatDate(note.created_at)}
                        {note.author ? ` · ${note.author}` : ''}
                      </p>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-sm text-ink-2">{note.body}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid gap-8 lg:grid-cols-2">
            <section className="space-y-3">
              <h2 className="micro border-b border-rule pb-2">Latest roles</h2>
              {stats.recentRoles.length === 0 ? (
                <p className="text-sm text-ink-3">
                  No roles yet. <Link to="/roles" className="btn-quiet text-sm">Create one</Link>
                </p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {stats.recentRoles.map((role) => (
                      <tr
                        key={role.external_id}
                        className="row"
                        onClick={() => navigate(`/roles/${role.external_id}`)}
                      >
                        <td className="td">
                          <span className="font-semibold">{role.title}</span>
                          {role.company && (
                            <span className="block text-xs text-ink-2">{role.company}</span>
                          )}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-ink-2">
                          {stageLabel(role.status)}
                        </td>
                        <td className="td tnum whitespace-nowrap text-xs text-ink-2">
                          {role.match_count} match{role.match_count === 1 ? '' : 'es'}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-ink-2">
                          {formatDate(role.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="space-y-3">
              <h2 className="micro border-b border-rule pb-2">Latest candidates</h2>
              {stats.recentCandidates.length === 0 ? (
                <p className="text-sm text-ink-3">
                  Nobody yet. <Link to="/talent" className="btn-quiet text-sm">Add a candidate</Link>
                </p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {stats.recentCandidates.map((c) => (
                      <tr
                        key={c.external_id}
                        className="row"
                        onClick={() => navigate(`/talent/${c.external_id}`)}
                      >
                        <td className="td">
                          <span className="font-semibold">{c.name || 'Unnamed'}</span>
                          {c.current_designation && (
                            <span className="block text-xs text-ink-2">
                              {c.current_designation}
                              {c.current_company ? ` · ${c.current_company}` : ''}
                            </span>
                          )}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-ink-2">
                          {c.entry_mode === 'manual' ? 'Entered by hand' : 'From a CV'}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-ink-2">
                          {formatDate(c.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
