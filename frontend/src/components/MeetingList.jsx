import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import Notes from './Notes';
import { formatDateTime, formatRelative, ordinal } from '../lib/utils';
import { readJson } from '../lib/api';

/**
 * Meetings as a table, on the Meetings page and on every record that has some.
 *
 * The state that matters is not open-versus-closed on its own — it is open
 * AND in the past. That is a conversation somebody had and never concluded,
 * and it is the only row here that needs chasing, so it is the only one marked.
 */

/**
 * Which meeting with this person this one is.
 *
 * Several meetings with the same person is the normal shape of a placement —
 * first round, client round, offer conversation — and once there are three of
 * them the rows are near-identical: same name, same role, subjects that all
 * say "discussion". The number is what tells them apart at a glance, and it is
 * the thing you actually want to know when you open the list.
 *
 * Rendered as "2nd of 4" rather than a bare "2" so it also says how far
 * through the sequence this one sits without opening the person's page.
 */
export function MeetingSequence({ meeting, className = '' }) {
  const number = meeting.person_meeting_number;
  const total = meeting.person_meeting_total;
  if (!number) return null;

  // A lone meeting has no sequence worth stating. Saying "1st of 1" on every
  // one-off conversation would put a number on every row and leave the ones
  // that matter no more visible than the ones that do not.
  if (total <= 1) return null;

  return (
    <span
      className={`inline-flex whitespace-nowrap items-center border border-rule bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro text-ink-2 ${className}`}
      title={`The ${ordinal(number)} of ${total} meetings with this person`}
    >
      {ordinal(number)} of {total}
    </span>
  );
}

/**
 * When this person was last seen, and when they are next due.
 *
 * The two dates every other screen makes you work out for yourself by reading
 * a list and doing the arithmetic. Shown together because they are one
 * question — "where are we with them" — and separately useless: a last meeting
 * four months ago is only alarming once you know nothing is booked.
 *
 * Both are rendered relative with the exact date beside them. The relative form
 * is what the judgement is made on; the absolute one is what gets repeated back
 * to a client, and dropping it would mean opening the meeting to read it.
 *
 * @param {string} [last]  the most recent meeting already in the past
 * @param {string} [next]  the soonest still ahead
 * @param {number} [total] how many there have been in all
 */
export function MeetingCadence({ last, next, total }) {
  if (!last && !next) {
    return (
      <p className="text-sm text-ink-3">
        Never met. Nothing booked.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
      <span className="text-sm">
        <span className="micro">Last met </span>
        {last ? (
          <>
            <span className="font-semibold text-ink">{formatRelative(last)}</span>
            <span className="text-ink-2"> · {formatDateTime(last)}</span>
          </>
        ) : (
          // Distinguished from "never met" above: there IS a booking, it just
          // has not happened yet, which is a different position to be in.
          <span className="text-ink-3">not yet</span>
        )}
      </span>

      <span className="text-sm">
        <span className="micro">Next </span>
        {next ? (
          <>
            <span className="font-semibold text-ink">{formatRelative(next)}</span>
            <span className="text-ink-2"> · {formatDateTime(next)}</span>
          </>
        ) : (
          // The state worth noticing: met before, nothing arranged since.
          <span className="text-ink-3">nothing booked</span>
        )}
      </span>

      {total > 0 && (
        <span className="text-xs text-ink-2">
          {total} meeting{total === 1 ? '' : 's'} in all
        </span>
      )}
    </div>
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
 * The notes on one meeting, opened in place under its row.
 *
 * Comments belong to every meeting, not only to the one you happened to open.
 * Requiring a page load to write "he asked to move it to Friday" is the reason
 * that sentence ends up in somebody's head instead of in the record — so the
 * same editor that lives on the meeting's page opens here, against the same
 * endpoint.
 *
 * Fetched when it is expanded rather than with the list: a page of thirty
 * meetings would otherwise pull thirty sets of notes nobody has asked to read.
 * The count in the closed row comes from the list query, which already carries
 * it, so the button says how many there are before anything is fetched.
 */
function MeetingNotes({ meetingId, onCountChange }) {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    fetch(`/api/meetings/${meetingId}/notes`)
      .then(readJson)
      .then((rows) => setNotes(Array.isArray(rows) ? rows : []))
      .catch((e) => setError(e.message));
  }, [meetingId]);

  useEffect(load, [load]);

  if (error) return <div className="notice-error">{error}</div>;
  if (notes === null) return <div className="skeleton h-24" />;

  return (
    <Notes
      basePath={`/api/meetings/${meetingId}`}
      notes={notes}
      onChange={(fresh) => {
        setNotes(fresh);
        // The closed row's count has to follow, or collapsing after adding a
        // note shows the number it had before you wrote it.
        if (onCountChange) onCountChange(fresh.length);
      }}
      placeholder="Rescheduled to Friday at their request."
    />
  );
}

/**
 * @param {Array}   meetings
 * @param {boolean} [hidePerson]  on a person's own page, their name in every row is noise
 * @param {boolean} [hideRole]    likewise on a role's page
 * @param {string}  [empty]       what to say when there are none
 */
export default function MeetingList({ meetings = [], hidePerson, hideRole, empty }) {
  // Which row's notes are open, and the counts that have moved since the list
  // was fetched. Kept here rather than in each row so opening one closes the
  // last: two open editors side by side is a way to write a note against the
  // wrong meeting.
  const [openNotes, setOpenNotes] = useState(null);
  const [counts, setCounts] = useState({});

  if (meetings.length === 0) {
    return (
      <p className="border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-3">
        {empty || 'No meetings yet.'}
      </p>
    );
  }

  // Header cells, minus the ones this caller hides. Counted rather than
  // written as a literal because the expanded notes row spans it, and a
  // hardcoded number silently misaligns the drawer on the pages that pass
  // hidePerson or hideRole.
  // When, About and Notes are always there; Who and Role are not.
  const columnCount = 3 + (hidePerson ? 0 : 1) + (hideRole ? 0 : 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">When</th>
            {!hidePerson && <th className="th">Who</th>}
            <th className="th">About</th>
            {!hideRole && <th className="th">Role</th>}
            <th className="th">Notes</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((meeting) => {
            const noteCount = counts[meeting.external_id] ?? (meeting.note_count || 0);
            const expanded = openNotes === meeting.external_id;

            return [
              <tr key={meeting.external_id} className="border-b border-rule hover:bg-surface">
                <td className="td whitespace-nowrap">
                  <Link
                    to={`/meetings/${meeting.external_id}`}
                    className="font-semibold hover:underline hover:underline-offset-4"
                  >
                    {formatDateTime(meeting.scheduled_at)}
                  </Link>
                  {/* Both, always. The absolute date is what goes in a diary;
                      the relative one is what you judge by — "Mar 10" does not
                      tell you somebody has gone cold, "5 months ago" does. */}
                  <span className="block text-xs text-ink-2">
                    {formatRelative(meeting.scheduled_at)}
                  </span>
                  <span className="mono block">{meeting.external_id}</span>
                  {/* On a person's own page the name is hidden but the
                      sequence is the whole point of the list, so it moves up
                      here where it is always visible. */}
                  {hidePerson && (
                    <span className="mt-1 block">
                      <MeetingSequence meeting={meeting} />
                    </span>
                  )}
                </td>

                {!hidePerson && (
                  <td className="td">
                    {/* The row itself does not navigate, so the cell's links can
                        coexist without one swallowing the other. */}
                    <PersonName meeting={meeting} />
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <PersonTag source={meeting.person_source} />
                      <MeetingSequence meeting={meeting} />
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
                  {/* A button rather than the bare count it used to be. The
                      number was already here and was the one thing on the row
                      that looked like it should open something and did not. */}
                  <button
                    type="button"
                    className="btn-quiet whitespace-nowrap text-xs"
                    onClick={() => setOpenNotes(expanded ? null : meeting.external_id)}
                    title={expanded ? 'Hide the notes' : 'Read and add notes on this meeting'}
                  >
                    {expanded ? 'Hide notes' : noteCount ? `${noteCount} note${noteCount === 1 ? '' : 's'}` : 'Add note'}
                  </button>
                </td>
              </tr>,

              expanded && (
                <tr key={`${meeting.external_id}-notes`} className="border-b border-rule bg-surface">
                  <td className="px-4 py-5" colSpan={columnCount}>
                    <p className="micro mb-3">
                      Notes on {meeting.external_id}
                      {meeting.person_name ? ` · ${meeting.person_name}` : ''}
                    </p>
                    <MeetingNotes
                      meetingId={meeting.external_id}
                      onCountChange={(count) =>
                        setCounts((current) => ({ ...current, [meeting.external_id]: count }))
                      }
                    />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
