import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import MeetingList, { MeetingCadence } from '../components/MeetingList';
import {
  joinDateTime, formatDateTime, formatRelative, ordinal, DEFAULT_MEETING_TIME,
  MEETING_PERIODS, periodRange, customRange, describeRange,
} from '../lib/utils';

/**
 * Meetings booked with candidates, in date order.
 *
 * A meeting is a record of its own rather than a note with a date on it: it is
 * arranged before it happens, it belongs to a person you will meet again, and
 * what was said in it has to survive the person who was in the room.
 *
 * There is no status. A meeting either has happened or has not, which its date
 * already says, and everything that came out of it is in its notes.
 */

const BLANK = {
  personRef: '', jobRef: '', subject: '', createdBy: '',
  // Two fields, not one datetime-local. See joinDateTime: a single one reports
  // an empty value until both halves are filled, so a date typed without a
  // time reads as nothing entered at all.
  scheduledDate: '', scheduledTime: '',
};

/**
 * Picks a person by name rather than by id.
 *
 * Nobody knows a candidate's CAND_ id, so a bare id field would mean opening
 * the talent pool in another tab to look one up before every booking. Typing a
 * name and choosing from what comes back is how the record is actually
 * identified; the id is what gets sent.
 *
 * A WhatsApp applicant's APP_ id can be typed straight in, because that is the
 * id you have in your hand when you are looking at their page. It is still
 * confirmed by a click on a result rather than accepted as you type: typing
 * "APP_12" passes through "APP_1" on the way, and committing on the first
 * match booked the meeting with the wrong person and took the input away
 * before the second digit could be typed.
 */
function PersonPicker({ value, onChange }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState(null);

  useEffect(() => {
    const query = term.trim();
    if (!query) {
      setResults([]);
      return undefined;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      // An APP_ id is looked up directly rather than searched for — the talent
      // pool does not contain WhatsApp applicants, so searching it would come
      // back empty and read as "no such person".
      const lookup = /^APP_\d+$/i.test(query)
        ? fetch(`/api/applicants/${query.toUpperCase()}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((applicant) =>
              applicant
                ? [{
                    external_id: applicant.Applicant_ID,
                    name: applicant.Name || applicant.Sender,
                    current_designation: 'WhatsApp applicant',
                    current_company: applicant.Phone,
                  }]
                : []
            )
        : fetch(`/api/candidates?search=${encodeURIComponent(query)}&limit=8`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => (d && d.candidates) || []);

      lookup
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);

    return () => clearTimeout(timer);
  }, [term]);

  function choose(person) {
    setChosen(person);
    setResults([]);
    setTerm('');
    onChange(person.external_id);
  }

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-3 border border-ink px-3 py-2">
        {/* The name only when it is known and is not just the id again —
            otherwise the chosen person read as "APP_12   APP_12". */}
        {chosen && chosen.name && chosen.name !== value && (
          <span className="text-sm font-semibold text-ink">{chosen.name}</span>
        )}
        <span className="mono">{value}</span>
        <button
          type="button"
          className="btn-quiet ml-auto text-xs"
          onClick={() => { setChosen(null); onChange(''); }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        className="input w-full"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search the talent pool by name, or type an APP_ id"
      />
      {results.length > 0 ? (
        <ul className="max-h-56 overflow-y-auto border border-rule">
          {results.map((person) => (
            <li key={person.external_id}>
              <button
                type="button"
                onClick={() => choose(person)}
                className="flex w-full items-baseline justify-between gap-3 border-b border-rule px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-surface"
              >
                <span className="font-semibold">{person.name || 'Unnamed'}</span>
                <span className="flex-1 truncate text-xs text-ink-2">
                  {[person.current_designation, person.current_company]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="mono">{person.external_id}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        term.trim() && !searching && (
          <p className="text-xs text-ink-3">
            Nobody found. Search the talent pool by name, or use an applicant&apos;s
            APP_ id from their page.
          </p>
        )
      )}
    </div>
  );
}

/**
 * What has already happened with the person being booked.
 *
 * Booking a second, third or fourth meeting with the same person is the normal
 * shape of a placement — first round, client round, offer conversation — so
 * nothing stops you. What was missing is the other half: at the moment you are
 * booking, you cannot see that you already met them twice, and a "first round
 * screening" gets booked with somebody who was screened in March.
 *
 * So the earlier meetings are shown here, in the form, while there is still
 * time for them to change what gets typed into it. Counts first, because
 * "3 already" is the part that stops the mistake; the meetings themselves
 * under it, because "which three" is the next question.
 */
function PersonHistory({ history, loading }) {
  if (loading) return <div className="skeleton h-16" />;
  if (!history) return null;

  if (history.total === 0) {
    return (
      <p className="border border-dashed border-rule px-4 py-3 text-sm text-ink-3">
        No meetings with this person yet — this will be their first.
      </p>
    );
  }

  return (
    <div className="border border-ink">
      <div className="space-y-2 border-b border-rule px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <p className="text-sm font-semibold text-ink">
            {history.total} meeting{history.total === 1 ? '' : 's'} already with this person
          </p>
          <p className="text-xs text-ink-2">
            {history.held} already held · {history.upcoming} still to come
          </p>
          <p className="mono ml-auto">
            This will be their {ordinal(history.nextNumber)}
          </p>
        </div>
        {/* The question actually being asked at this moment is "when did I last
            see them", and a list of five dates is not an answer to it. */}
        <MeetingCadence last={history.lastMeetingAt} next={history.nextMeetingAt} />
      </div>

      <ul className="max-h-48 overflow-y-auto">
        {history.meetings.map((meeting) => (
          <li
            key={meeting.external_id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-4 py-2 text-sm last:border-b-0"
          >
            <span className="mono whitespace-nowrap">
              {ordinal(meeting.person_meeting_number)}
            </span>
            <span className="whitespace-nowrap text-xs text-ink-2">
              {formatDateTime(meeting.scheduled_at)}
              <span className="ml-2 text-ink-3">{formatRelative(meeting.scheduled_at)}</span>
            </span>
            <Link
              to={`/meetings/${meeting.external_id}`}
              className="flex-1 truncate font-semibold hover:underline hover:underline-offset-4"
              title={meeting.subject}
            >
              {meeting.subject}
            </Link>
          </li>
        ))}
      </ul>

    </div>
  );
}

export default function Meetings() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [booking, setBooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [missing, setMissing] = useState(null);
  const [roles, setRoles] = useState([]);
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // ?book=CAND_1004 — arriving from a person's page or from a meeting with
  // them, wanting the next one. Read once into the form rather than kept as
  // the source of truth, so clearing the person in the picker actually clears
  // it instead of being reinstated from the URL on the next render.
  const bookFor = params.get('book') || '';
  // The committed search — what the list is actually filtered by. The box below
  // holds its own draft and only writes here once typing has settled, so every
  // keystroke does not become a request and a history entry.
  const search = params.get('q') || '';
  const [term, setTerm] = useState(search);

  // The window being looked at. A named period, or 'custom' plus two dates.
  // Both live in the URL so a filtered view is a link somebody can send.
  const period = MEETING_PERIODS.some((option) => option.key === params.get('period'))
    || params.get('period') === 'custom'
    ? params.get('period')
    : '';
  const customFrom = params.get('from') || '';
  const customTo = params.get('to') || '';

  const range = useMemo(
    () => (period === 'custom' ? customRange(customFrom, customTo) : periodRange(period)),
    [period, customFrom, customTo]
  );

  const query = useMemo(() => {
    const built = new URLSearchParams();
    if (search.trim()) built.set('search', search.trim());
    // Sent as instants, not dates: the boundary was worked out here, where the
    // local timezone is known, and an ISO instant is the one form the server
    // cannot misread.
    if (range.from) built.set('from', range.from.toISOString());
    if (range.to) built.set('to', range.to.toISOString());
    return built.toString();
  }, [search, range]);

  // Every filter lives in the URL, so setting one has to carry the others.
  const setQuery = useCallback((next) => {
    const merged = { q: search, period, from: customFrom, to: customTo, ...next };
    const cleaned = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value) cleaned[key] = value;
    }
    setParams(cleaned, { replace: true });
  }, [search, period, customFrom, customTo, setParams]);

  // 300ms, matching the person picker. Skipped when the draft already equals
  // what is committed, so arriving on the page with ?q= in the URL does not
  // immediately rewrite it.
  useEffect(() => {
    if (term === search) return undefined;
    const timer = setTimeout(() => setQuery({ q: term }), 300);
    return () => clearTimeout(timer);
  }, [term, search, setQuery]);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/meetings?${query}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json();
      })
      .then((rows) => {
        setMeetings(Array.isArray(rows) ? rows : []);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [query]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!bookFor) return;
    setBooking(true);
    setForm((current) => ({ ...current, personRef: bookFor }));
    // Dropped from the URL immediately: left there, pressing Cancel and
    // reopening the form would silently re-tag the same person.
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('book');
      return next;
    }, { replace: true });
  }, [bookFor, setParams]);

  // Only the roles worth booking against. A closed role in the dropdown is a
  // way to attach a meeting to something nobody is hiring for any more.
  useEffect(() => {
    fetch('/api/roles')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRoles((Array.isArray(d) ? d : []).filter(
        (role) => role.status === 'open' || role.status === 'reviewing'
      )))
      .catch(() => {});
  }, []);

  /**
   * The chosen person's earlier meetings, re-read whenever the person changes.
   *
   * Cleared first rather than left showing the last person's meetings while
   * the new ones load — a stale count under a different name is worse than no
   * count, because it reads as an answer.
   */
  useEffect(() => {
    if (!form.personRef) {
      setHistory(null);
      return undefined;
    }

    let live = true;
    setHistory(null);
    setHistoryLoading(true);
    fetch(`/api/meetings/history?personRef=${encodeURIComponent(form.personRef)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setHistory(d); })
      .catch(() => {})
      .finally(() => { if (live) setHistoryLoading(false); });

    // A second person chosen before the first request lands must not overwrite
    // the newer answer with the older one.
    return () => { live = false; };
  }, [form.personRef]);

  async function book(event) {
    event.preventDefault();

    // Checked here and reported, rather than by disabling the button. A
    // disabled submit that never says why is indistinguishable from a broken
    // one: you fill the form, press it, nothing happens, and there is nothing
    // on screen to read.
    const gaps = [];
    if (!form.personRef) gaps.push('who the meeting is with');
    if (!form.subject.trim()) gaps.push('what it is about');
    if (!form.scheduledDate) gaps.push('a date');
    if (gaps.length) {
      setMissing(`Still needed: ${gaps.join(', ')}.`);
      return;
    }

    setMissing(null);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personRef: form.personRef,
          jobRef: form.jobRef,
          subject: form.subject,
          createdBy: form.createdBy,
          scheduledAt: joinDateTime(form.scheduledDate, form.scheduledTime),
        }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error((detail && detail.error) || `Server error ${response.status}`);
      }
      const meeting = await response.json();
      // Straight to the meeting: the next thing anyone does is record what it
      // is for, and that lives on its page.
      navigate(`/meetings/${meeting.external_id}`);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  // What the meeting is likely to be called, given how many came before. Only
  // ever a placeholder: it is a guess about the shape of the process, and a
  // guess must not end up saved as though somebody typed it.
  const subjectHint =
    history && history.nextNumber > 1
      ? `${ordinal(history.nextNumber)} round — following up on the last conversation`
      : 'First round — background and expectations';

  // What is actually on screen, counted. "How many meetings last week" is
  // half the question the filter exists to answer, and counting the rows by
  // eye is the part nobody does.
  const shown = meetings.length;
  const people = new Set(
    meetings.map((m) => m.person_ref || m.person_name).filter(Boolean)
  ).size;
  const activePeriod = MEETING_PERIODS.find((option) => option.key === period);
  const rangeText = describeRange(range.from, range.to);

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Managed here</p>
          <h1 className="page-title mt-1">Meetings</h1>
          <p className="page-sub">
            Who you are seeing, when, and what was said. The record of each one is in its notes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a className="btn" href={`/api/meetings/export.csv?${query}`}>Export CSV</a>
          <button className="btn-solid" onClick={() => setBooking((b) => !b)}>
            {booking ? 'Cancel' : 'Book a meeting'}
          </button>
        </div>
      </header>

      {error && <div className="notice-error">{error}</div>}

      {booking && (
        <form onSubmit={book} className="panel space-y-5">
          <label className="block">
            <span className="micro">Who is coming *</span>
            <div className="mt-1.5">
              <PersonPicker
                value={form.personRef}
                onChange={(personRef) => setForm({ ...form, personRef })}
              />
            </div>
          </label>

          {/* Nothing here blocks a repeat booking. Meeting the same person
              three times is the process working, not a duplicate — this only
              makes sure the third one is booked knowing about the first two. */}
          {form.personRef && <PersonHistory history={history} loading={historyLoading} />}

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="micro">Date *</span>
                <input
                  className="input mt-1.5 w-full"
                  type="date"
                  value={form.scheduledDate}
                  onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="micro">Time</span>
                <input
                  className="input mt-1.5 w-full"
                  type="time"
                  value={form.scheduledTime}
                  onChange={(e) => setForm({ ...form, scheduledTime: e.target.value })}
                  placeholder={DEFAULT_MEETING_TIME}
                />
              </label>
            </div>
            <label className="block">
              <span className="micro">About which role</span>
              <select
                className="input mt-1.5 w-full"
                value={form.jobRef}
                onChange={(e) => setForm({ ...form, jobRef: e.target.value })}
              >
                <option value="">Not about a specific role</option>
                {roles.map((role) => (
                  <option key={role.external_id} value={role.external_id}>
                    {role.title}{role.company ? ` — ${role.company}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* No `required` attribute anywhere on this form, deliberately.
              Native validation aborts the submit event before onSubmit runs, so
              the handler below never gets to say what is missing — and the one
              field that is most often the missing one, the person, is not a
              native input at all and would produce no browser warning either.
              One check, in one place, reporting everything at once. */}
          <label className="block">
            <span className="micro">
              What the meeting is about *
              {history && history.nextNumber > 1 && (
                <span className="ml-2 font-normal normal-case tracking-normal text-ink-2">
                  their {ordinal(history.nextNumber)} meeting
                </span>
              )}
            </span>
            <input
              className="input mt-1.5 w-full"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder={subjectHint}
            />
          </label>

          <label className="block">
            <span className="micro">Your name (optional)</span>
            <input
              className="input mt-1.5 w-48"
              value={form.createdBy}
              onChange={(e) => setForm({ ...form, createdBy: e.target.value })}
            />
          </label>

          {missing && <div className="callout">{missing}</div>}

          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Booking…' : 'Book meeting'}
            </button>
            <p className="text-xs text-ink-3">
              Leave the time blank and it defaults to {DEFAULT_MEETING_TIME}.
            </p>
          </div>
        </form>
      )}

      {/* Searched on the server rather than filtered in the browser: the list is
          capped at 200 rows, so filtering what arrived would search a page
          rather than the meetings, and a person met last year would not be
          found by the box that says it finds people. */}
      <div className="space-y-2">
        <label className="block">
          <span className="micro">Find a meeting</span>
          <input
            className="input mt-1.5 w-full"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Name, email, phone, subject or MEET_ id"
          />
        </label>
        {search && (
          <p className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
            <span>Matching “{search}”</span>
            <button type="button" className="btn-quiet text-xs" onClick={() => setTerm('')}>
              Clear
            </button>
          </p>
        )}
      </div>

      {/* The window. Presets rather than two date boxes, because "last week"
          is how the question is asked — being made to work out that last week
          began on the 17th is the reason nobody asks it. The two boxes are
          still there behind Custom for the ranges a preset cannot name. */}
      <div className="space-y-3">
        {/* A grid rather than a wrapping flex row. With flex-1 the last row
            takes whatever is left over, so on a phone the single "Custom"
            chip stretched the full width and read as a heading rather than as
            one option among eight. A grid keeps every cell the same size
            however they wrap. */}
        <div className="grid grid-cols-3 gap-px border border-rule bg-rule sm:grid-cols-4 lg:grid-cols-8">
          {[...MEETING_PERIODS, { key: 'custom', label: 'Custom' }].map((option) => (
            <button
              key={option.key}
              onClick={() => setQuery({
                period: option.key,
                // Dropped when leaving Custom, so a stale hand-picked range
                // cannot sit in the URL narrowing a preset nobody expects it to.
                from: option.key === 'custom' ? customFrom : '',
                to: option.key === 'custom' ? customTo : '',
              })}
              className={[
                'px-3 py-2.5 text-[13px] font-semibold transition-colors',
                option.key === period
                  ? 'bg-ink text-paper'
                  : 'bg-paper text-ink-2 hover:bg-surface hover:text-ink',
              ].join(' ')}
            >
              {option.label}
            </button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="flex flex-wrap items-end gap-4 border border-rule px-4 py-3">
            <label className="block">
              <span className="micro">From</span>
              <input
                className="input mt-1.5"
                type="date"
                value={customFrom}
                onChange={(e) => setQuery({ from: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="micro">To</span>
              <input
                className="input mt-1.5"
                type="date"
                value={customTo}
                onChange={(e) => setQuery({ to: e.target.value })}
              />
            </label>
            <p className="text-xs text-ink-3">
              {/* Said out loud because an inclusive end date is the thing
                  people check twice. */}
              Both days are included. Leave either blank for an open end.
            </p>
          </div>
        )}

        {/* The count. This is what the filter is for — the list answers
            "which meetings", this answers "how many". */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-l-2 border-ink px-4 py-2">
          {loading ? (
            <p className="text-sm text-ink-3">Counting…</p>
          ) : (
            <>
              <p className="text-sm">
                <span className="tnum text-lg font-bold text-ink">{shown}</span>
                <span className="text-ink"> meeting{shown === 1 ? '' : 's'}</span>
                {activePeriod && activePeriod.key
                  ? <span className="text-ink-2"> {activePeriod.label.toLowerCase()}</span>
                  : period === 'custom' && rangeText
                    ? <span className="text-ink-2"> in this range</span>
                    : <span className="text-ink-2"> in all</span>}
              </p>
              {people > 0 && (
                <p className="text-xs text-ink-2">
                  with {people} {people === 1 ? 'person' : 'different people'}
                </p>
              )}
              {rangeText && <p className="mono ml-auto">{rangeText}</p>}
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : (
        <MeetingList
          meetings={meetings}
          empty={
            search
              ? `Nobody and nothing matching “${search}”${rangeText ? ` in ${rangeText}` : ''}.`
              : rangeText
                ? `No meetings in ${rangeText}.`
                : 'No meetings yet. Book one against anyone in the talent pool.'
          }
        />
      )}
    </div>
  );
}
