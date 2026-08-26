import { Link } from 'react-router-dom';
import { formatDateTime, isPast } from '../lib/utils';

/**
 * Meetings as a table, on the Meetings page and on every record that has some.
 *
 * The state that matters is not open-versus-closed on its own — it is open
 * AND in the past. That is a conversation somebody had and never concluded,
 * and it is the only row here that needs chasing, so it is the only one marked.
 */

export function MeetingStatus({ meeting }) {
  const overdue = meeting.status === 'open' && isPast(meeting.scheduled_at);
  const label = meeting.status === 'closed' ? 'Closed' : overdue ? 'Needs closing' : 'Open';
  return (
    <span
      className={[
        'inline-flex whitespace-nowrap items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro',
        meeting.status === 'closed'
          ? 'border-rule bg-paper text-ink-3'
          : overdue
            ? 'border-ink bg-ink text-paper'
            : 'border-ink bg-paper text-ink',
      ].join(' ')}
      title={
        overdue
          ? 'The date has passed and it was never closed'
          : meeting.status === 'closed'
            ? 'Concluded'
            : 'Still to happen'
      }
    >
      {label}
    </span>
  );
}

/** Where the person came from, so a curated candidate is not read as a stray message. */
function PersonTag({ source }) {
  const curated = source === 'candidate';
  return (
    <span
      className={[
        'inline-flex items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro',
        curated ? 'border-ink bg-ink text-paper' : 'border-rule bg-paper text-ink-2',
      ].join(' ')}
      title={curated ? 'From the talent pool' : 'From a WhatsApp message'}
    >
      {curated ? 'Talent' : 'WhatsApp'}
    </span>
  );
}

/**
 * The page for the person, or null when there is no longer one to link to.
 *
 * A WhatsApp person is addressed by the id of their live classification, and
 * that can disappear from under a meeting — deleting an applicant removes the
 * classification but leaves the contact, and the meeting is deliberately kept.
 * The name is still known, so the row stays readable; only the link goes.
 */
function personPath(meeting) {
  if (!meeting.person_ref) return null;
  return meeting.person_source === 'candidate'
    ? `/talent/${meeting.person_ref}`
    : `/candidates/${meeting.person_ref}`;
}

function PersonName({ meeting }) {
  const path = personPath(meeting);
  const label = meeting.person_name || meeting.person_ref || 'Unknown person';
  if (!path) return <span className="font-semibold">{label}</span>;
  return (
    <Link to={path} className="font-semibold hover:underline hover:underline-offset-4">
      {label}
    </Link>
  );
}

/**
 * @param {Array}   meetings
 * @param {boolean} [hidePerson]  on a person's own page, their name in every row is noise
 * @param {boolean} [hideRole]    likewise on a role's page
 * @param {string}  [empty]       what to say when there are none
 */
export default function MeetingList({ meetings = [], hidePerson, hideRole, empty }) {
  if (meetings.length === 0) {
    return (
      <p className="border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-3">
        {empty || 'No meetings yet.'}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">When</th>
            {!hidePerson && <th className="th">Who</th>}
            <th className="th">About</th>
            {!hideRole && <th className="th">Role</th>}
            <th className="th">Status</th>
            <th className="th">Notes</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((meeting) => (
            <tr key={meeting.external_id} className="border-b border-rule hover:bg-surface">
              <td className="td whitespace-nowrap">
                <Link
                  to={`/meetings/${meeting.external_id}`}
                  className="font-semibold hover:underline hover:underline-offset-4"
                >
                  {formatDateTime(meeting.scheduled_at)}
                </Link>
                <span className="mono block">{meeting.external_id}</span>
              </td>

              {!hidePerson && (
                <td className="td">
                  {/* The row itself does not navigate, so the cell's links can
                      coexist without one swallowing the other. */}
                  <PersonName meeting={meeting} />
                  <span className="mt-0.5 block">
                    <PersonTag source={meeting.person_source} />
                  </span>
                  {meeting.person_designation && (
                    <span className="block text-xs text-ink-2">{meeting.person_designation}</span>
                  )}
                </td>
              )}

              <td className="td max-w-sm">{meeting.subject}</td>

              {!hideRole && (
                <td className="td whitespace-nowrap text-sm">
                  {meeting.job_ref ? (
                    <Link
                      to={`/roles/${meeting.job_ref}`}
                      className="hover:underline hover:underline-offset-4"
                    >
                      {meeting.job_title}
                    </Link>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
              )}

              <td className="td">
                <MeetingStatus meeting={meeting} />
                {meeting.outcome && (
                  <span className="mt-1 block max-w-xs text-xs text-ink-2">{meeting.outcome}</span>
                )}
              </td>

              <td className="td tnum text-xs text-ink-2">{meeting.note_count || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
