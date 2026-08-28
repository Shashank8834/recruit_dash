import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Notes from '../components/Notes';
import { MeetingSequence, MeetingCadence } from '../components/MeetingList';
import { formatDateTime, formatRelative, daysBetween, splitDateTime, joinDateTime, ordinal, DEFAULT_MEETING_TIME } from '../lib/utils';
import { errorFrom } from '../lib/api';

/**
 * One meeting, and the account of how it went.
 *
 * Read top to bottom it is the history of a conversation: who it was with and
 * when, where it sits in the sequence of meetings with them, and then the
 * notes — rescheduled, second round asked for, went quiet, how it actually
 * went. That is the thing which otherwise lives in one person's head and
 * leaves with them.
 */
export default function MeetingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ subject: '', date: '', time: '' });
  const [missing, setMissing] = useState(null);
  // Every other meeting with the same person. Fetched separately from the
  // meeting itself because it is a fact about them rather than about this
  // record, and because it has to be re-read when this meeting is rescheduled
  // — moving a date can change which meeting is the second and which the third.
  const [siblings, setSiblings] = useState(null);

  const load = useCallback(() => {
    fetch(`/api/meetings/${id}`)
      .then(async (r) => {
        if (!r.ok) throw await errorFrom(r);
        return r.json();
      })
      .then(setMeeting)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!meeting || !meeting.person_ref) return undefined;

    let live = true;
    fetch(`/api/meetings/history?personRef=${encodeURIComponent(meeting.person_ref)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setSiblings(d); })
      .catch(() => {});
    return () => { live = false; };
    // Keyed on the scheduled time as well as the person: rescheduling this
    // meeting renumbers the sequence, and a stale list would keep calling it
    // the third after it became the first.
  }, [meeting && meeting.person_ref, meeting && meeting.scheduled_at]);

  async function patch(body) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw await errorFrom(response);
      }
      // Merged rather than replaced: PATCH returns the meeting row, which
      // carries no notes, and assigning it wholesale would empty the timeline.
      const updated = await response.json();
      setMeeting((current) => ({ ...current, ...updated }));
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveEdits(event) {
    event.preventDefault();

    // Reported rather than silently refused. A submit that does nothing and
    // says nothing is the same experience as a broken one.
    const gaps = [];
    if (!draft.subject.trim()) gaps.push('what it is about');
    if (!draft.date) gaps.push('a date');
    if (gaps.length) {
      setMissing(`Still needed: ${gaps.join(', ')}.`);
      return;
    }

    setMissing(null);
    if (await patch({
      subject: draft.subject,
      scheduledAt: joinDateTime(draft.date, draft.time),
    })) {
      setEditing(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this meeting and its notes? This cannot be undone.')) return;
    try {
      const response = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
      if (!response.ok) throw await errorFrom(response);
      navigate('/meetings', { replace: true });
    } catch (e) {
      setError(e.message);
    }
  }

  if (error && !meeting) return <div className="callout">{error}</div>;
  if (!meeting) return <div className="skeleton h-40" />;

  // Null when there is no page left to link to. A WhatsApp person is addressed
  // by their live classification's id, and deleting the applicant removes that
  // while leaving the contact — the meeting is kept on purpose, so it has to
  // render without the link rather than point at /candidates/null.
  const personPath = !meeting.person_ref
    ? null
    : meeting.person_source === 'candidate'
      ? `/talent/${meeting.person_ref}`
      : `/candidates/${meeting.person_ref}`;

  // The gap between this meeting and the one before it in the sequence. Null
  // when this is the first, or when the siblings have not loaded yet.
  const previous = siblings && meeting.person_meeting_number > 1
    ? (siblings.meetings || []).find(
        (m) => m.person_meeting_number === meeting.person_meeting_number - 1
      )
    : null;
  const gapFromPrevious = previous
    ? daysBetween(previous.scheduled_at, meeting.scheduled_at)
    : null;

  return (
    <div className="space-y-8">
      <Link to="/meetings" className="btn-quiet">← Meetings</Link>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="mono">{meeting.external_id}</p>
          <h1 className="page-title mt-1">{meeting.subject}</h1>
          <p className="page-sub">
            {formatDateTime(meeting.scheduled_at)}
            <span className="text-ink-2"> · {formatRelative(meeting.scheduled_at)}</span>
            {meeting.created_by ? ` · booked by ${meeting.created_by}` : ''}
          </p>
          {/* Booked and last-updated, said plainly. Without them there is no
              way to tell a meeting arranged months ago from one added this
              morning, and the two mean different things when the date has
              passed and nobody has closed it. */}
          <p className="mono mt-1">
            Booked {formatRelative(meeting.created_at)}
            {meeting.updated_at !== meeting.created_at
              ? ` · last changed ${formatRelative(meeting.updated_at)}`
              : ''}
            {meeting.closed_at ? ` · closed ${formatRelative(meeting.closed_at)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MeetingSequence meeting={meeting} />
          <button className="btn" onClick={() => {
            const when = splitDateTime(meeting.scheduled_at);
            setDraft({ subject: meeting.subject, date: when.date, time: when.time });
            setMissing(null);
            setEditing((e) => !e);
          }}>
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button className="btn" onClick={remove}>Delete</button>
        </div>
      </header>

      {error && <div className="notice-error">{error}</div>}

      {editing && (
        <form onSubmit={saveEdits} className="panel space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="micro">What it is about *</span>
              <input
                className="input mt-1.5 w-full"
                value={draft.subject}
                onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              />
            </label>
            {/* Two inputs, not one datetime-local: see joinDateTime. A single
                one reports nothing at all until both halves are complete. */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="micro">Date *</span>
                <input
                  className="input mt-1.5 w-full"
                  type="date"
                  value={draft.date}
                  onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="micro">Time</span>
                <input
                  className="input mt-1.5 w-full"
                  type="time"
                  value={draft.time}
                  onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                  placeholder={DEFAULT_MEETING_TIME}
                />
              </label>
            </div>
          </div>

          {missing && <div className="callout">{missing}</div>}

          <button className="btn-solid" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save meeting'}
          </button>
        </form>
      )}

      <section className="grid gap-8 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="micro">Who</p>
          {personPath ? (
            <Link
              to={personPath}
              className="block text-lg font-semibold text-ink hover:underline hover:underline-offset-4"
            >
              {meeting.person_name || meeting.person_ref}
            </Link>
          ) : (
            <p className="text-lg font-semibold text-ink">
              {meeting.person_name || 'Unknown person'}
            </p>
          )}
          <p className="mono">
            {meeting.person_ref ? `${meeting.person_ref} · ` : ''}
            {meeting.person_source === 'candidate' ? 'from the talent pool' : 'from WhatsApp'}
          </p>
          {!personPath && (
            <p className="text-xs text-ink-3">
              Their applicant record has been deleted. The meeting is kept.
            </p>
          )}
          {(meeting.person_designation || meeting.person_company) && (
            <p className="text-sm text-ink-2">
              {[meeting.person_designation, meeting.person_company].filter(Boolean).join(' · ')}
            </p>
          )}
          {meeting.person_phone && <p className="text-sm text-ink-2">{meeting.person_phone}</p>}
          {meeting.person_email && <p className="text-sm text-ink-2">{meeting.person_email}</p>}

          {siblings && (
            <div className="pt-1">
              <MeetingCadence
                last={siblings.lastMeetingAt}
                next={siblings.nextMeetingAt}
                total={siblings.total}
              />
            </div>
          )}

          {/* Straight into the booking form with them already tagged. Meeting
              the same person again is the common next step from this page —
              a second round, a client round — and sending someone back to the
              meetings list to search for a name they are already looking at is
              where that step gets skipped. */}
          {meeting.person_ref && (
            <Link
              to={`/meetings?book=${encodeURIComponent(meeting.person_ref)}`}
              className="btn mt-2 inline-block"
            >
              Book another with them
            </Link>
          )}
        </div>

        <div className="space-y-2">
          <p className="micro">Role</p>
          {meeting.job_ref ? (
            <Link
              to={`/roles/${meeting.job_ref}`}
              className="block text-lg font-semibold text-ink hover:underline hover:underline-offset-4"
            >
              {meeting.job_title}
            </Link>
          ) : (
            <p className="text-sm text-ink-2">
              Not about a specific role — a general conversation.
            </p>
          )}
          {/* The role link survives the role being deleted only as a blank:
              meetings outlive vacancies by design, so this says so rather than
              looking like missing data. */}
        </div>
      </section>

      {/* The other meetings with the same person.
          A placement is rarely one conversation — first round, client round,
          offer — and each of those is its own record with its own notes and
          its own notes. Without this they are only findable by going back to
          the list and searching the name, so the sequence they form is invisible
          from inside any one of them. */}
      {siblings && siblings.total > 1 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink pb-2">
            <p className="micro">
              All {siblings.total} meetings with {meeting.person_name || 'this person'}
            </p>
            <p className="text-xs text-ink-2">
              {siblings.held} already held · {siblings.upcoming} still to come
            </p>
          </div>

          {/* How long it had been since the one before. The number that says
              whether this was a follow-up or a restart — found by sequence
              rather than by list position, because the list puts open meetings
              first and "the previous one" is a fact about the dates. */}
          {gapFromPrevious !== null && (
            <p className="text-sm text-ink-2">
              {gapFromPrevious === 0
                ? 'Same day as the previous meeting.'
                : `${gapFromPrevious} day${gapFromPrevious === 1 ? '' : 's'} after the previous meeting.`}
            </p>
          )}

          <ul className="border border-rule">
            {siblings.meetings.map((other) => {
              const current = other.external_id === meeting.external_id;
              return (
                <li
                  key={other.external_id}
                  className={[
                    'flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-4 py-2.5 text-sm last:border-b-0',
                    // The one you are looking at, marked rather than linked —
                    // a link to the page you are already on reads as a
                    // different meeting until you click it.
                    current ? 'bg-surface' : '',
                  ].join(' ')}
                >
                  <span className="mono whitespace-nowrap">
                    {ordinal(other.person_meeting_number)}
                  </span>
                  <span className="whitespace-nowrap text-xs text-ink-2">
                    {formatDateTime(other.scheduled_at)}
                    <span className="ml-2 text-ink-3">
                      {formatRelative(other.scheduled_at)}
                    </span>
                  </span>
                  {current ? (
                    <span className="flex-1 truncate font-semibold text-ink">
                      {other.subject} <span className="text-ink-3">· this one</span>
                    </span>
                  ) : (
                    <Link
                      to={`/meetings/${other.external_id}`}
                      className="flex-1 truncate font-semibold hover:underline hover:underline-offset-4"
                      title={other.subject}
                    >
                      {other.subject}
                    </Link>
                  )}
                  {other.note_count > 0 && (
                    <span className="tnum whitespace-nowrap text-xs text-ink-3">
                      {other.note_count} note{other.note_count === 1 ? '' : 's'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* The record of the meeting. The fields above say who and when; this
          is everything that actually happened — including how it went, which
          used to live in an "outcome" field of its own and is just a note. */}
      <Notes
        basePath={`/api/meetings/${id}`}
        notes={meeting.notes || []}
        onChange={(notes) => setMeeting((current) => ({ ...current, notes }))}
        placeholder="Rescheduled to Friday at their request."
      />
    </div>
  );
}
