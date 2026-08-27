import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Notes from '../components/Notes';
import { MeetingStatus } from '../components/MeetingList';
import { formatDateTime, splitDateTime, joinDateTime, isPast, DEFAULT_MEETING_TIME } from '../lib/utils';

/**
 * One meeting, and the account of how it went.
 *
 * Three things share this page because they are three parts of one story: the
 * booking (who, when, what for), the running notes (rescheduled, second round
 * asked for, went quiet), and the conclusion. Read top to bottom it is the
 * history of a conversation — which is the thing that otherwise lives in one
 * person's head and leaves with them.
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
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState('');

  const load = useCallback(() => {
    fetch(`/api/meetings/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Meeting not found' : `Server error ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setMeeting(d);
        setOutcome(d.outcome || '');
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

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
        const detail = await response.json().catch(() => null);
        throw new Error((detail && detail.error) || `Server error ${response.status}`);
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

  async function close() {
    // The outcome travels with the close. They are one act — "how did it go" is
    // the question closing answers — and sending them separately leaves a
    // moment where the meeting is concluded with no record of how.
    if (await patch({ status: 'closed', outcome: outcome.trim() || null })) {
      setClosing(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this meeting and its notes? This cannot be undone.')) return;
    try {
      const response = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Server error ${response.status}`);
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
  const overdue = meeting.status === 'open' && isPast(meeting.scheduled_at);

  return (
    <div className="space-y-8">
      <Link to="/meetings" className="btn-quiet">← Meetings</Link>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="mono">{meeting.external_id}</p>
          <h1 className="page-title mt-1">{meeting.subject}</h1>
          <p className="page-sub">
            {formatDateTime(meeting.scheduled_at)}
            {meeting.created_by ? ` · booked by ${meeting.created_by}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MeetingStatus meeting={meeting} />
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

      {/* Said plainly rather than left to be inferred from the date: an open
          meeting whose date has passed is the only state here that needs
          someone to do something. */}
      {overdue && (
        <div className="callout">
          This meeting&apos;s date has passed and it was never closed. Record how it went
          below, or reschedule it.
        </div>
      )}

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

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink pb-2">
          <p className="micro">Outcome</p>
          {meeting.status === 'closed' ? (
            <button className="btn" disabled={saving} onClick={() => patch({ status: 'open' })}>
              {saving ? '…' : 'Reopen'}
            </button>
          ) : (
            <button className="btn-solid" onClick={() => setClosing((c) => !c)}>
              {closing ? 'Cancel' : 'Close meeting'}
            </button>
          )}
        </div>

        {meeting.status === 'closed' ? (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {meeting.outcome || 'Closed with no outcome recorded.'}
            </p>
            <p className="mono">Closed {formatDateTime(meeting.closed_at)}</p>
          </div>
        ) : closing ? (
          <div className="space-y-3 border border-rule px-4 py-4">
            <label className="block">
              <span className="micro">How did it go?</span>
              <textarea
                className="input mt-1.5 h-28 w-full"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                placeholder="Strong on the technical side, wants 30 LPA. Sending to the client."
              />
            </label>
            <button className="btn-solid" onClick={close} disabled={saving}>
              {saving ? 'Closing…' : 'Close meeting'}
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink-3">
            Still open. Close it when the conversation is concluded, and record how it went.
          </p>
        )}
      </section>

      {/* The timeline. The fields above say when it is and how it ended; these
          are what happened in between. */}
      <Notes
        basePath={`/api/meetings/${id}`}
        notes={meeting.notes || []}
        onChange={(notes) => setMeeting((current) => ({ ...current, notes }))}
        placeholder="Rescheduled to Friday at their request."
      />
    </div>
  );
}
