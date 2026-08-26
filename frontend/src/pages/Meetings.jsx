import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MeetingList from '../components/MeetingList';

/**
 * Meetings booked with candidates, and where each one got to.
 *
 * A meeting is not a note with a date on it. It is arranged before it happens,
 * it has a state that changes, and it ends with an outcome that does not exist
 * when it is created — so it needs a record of its own, or nobody can answer
 * "who am I seeing on Thursday" and "which conversations did I never close".
 *
 * Those two questions are what the filters are for. Everything else is the
 * running account on each meeting's own page.
 */

const VIEWS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open', query: 'status=open' },
  { key: 'upcoming', label: 'Upcoming', query: 'status=open&when=upcoming' },
  // Open and already past: a conversation that happened and was never
  // concluded. The one view that is a to-do list rather than a record.
  { key: 'needs-closing', label: 'Needs closing', query: 'status=open&when=past' },
  { key: 'closed', label: 'Closed', query: 'status=closed' },
];

const BLANK = { personRef: '', jobRef: '', scheduledAt: '', subject: '', createdBy: '' };

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

export default function Meetings() {
  const [meetings, setMeetings] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [booking, setBooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [roles, setRoles] = useState([]);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const view = VIEWS.some((v) => v.key === params.get('view')) ? params.get('view') : '';
  const query = (VIEWS.find((v) => v.key === view) || {}).query || '';

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/meetings?${query}`).then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json();
      }),
      fetch('/api/meetings/summary').then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([rows, counts]) => {
        setMeetings(Array.isArray(rows) ? rows : []);
        if (counts) setSummary(counts);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [query]);

  useEffect(load, [load]);

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

  async function book(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
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

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Managed here</p>
          <h1 className="page-title mt-1">Meetings</h1>
          <p className="page-sub">
            Who you are seeing, what it is about, and how each conversation ended.
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

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="micro">When *</span>
              <input
                className="input mt-1.5 w-full"
                type="datetime-local"
                required
                value={form.scheduledAt}
                onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
              />
            </label>
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

          <label className="block">
            <span className="micro">What the meeting is about *</span>
            <input
              className="input mt-1.5 w-full"
              required
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="First round — background and expectations"
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

          <button
            className="btn-solid"
            type="submit"
            disabled={saving || !form.personRef || !form.subject.trim() || !form.scheduledAt}
          >
            {saving ? 'Booking…' : 'Book meeting'}
          </button>
        </form>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
          {[
            ['Upcoming', summary.upcoming],
            // Underlined rather than coloured, matching how the pipeline panel
            // marks a failure: this is the number that means work is pending.
            ['Needs closing', summary.overdue, true],
            ['Closed', summary.closed],
            ['Total', summary.total],
          ].map(([label, value, mark]) => (
            <div key={label} className="bg-paper px-4 py-4">
              <p className="micro">{label}</p>
              <p
                className={`tnum mt-2 text-2xl font-bold leading-none text-ink ${
                  mark && value > 0 ? 'underline decoration-2 underline-offset-4' : ''
                }`}
              >
                {value}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-px border border-rule bg-rule">
        {VIEWS.map((option) => (
          <button
            key={option.key}
            onClick={() => setParams(option.key ? { view: option.key } : {}, { replace: true })}
            className={[
              'flex-1 px-4 py-2.5 text-[13px] font-semibold transition-colors',
              option.key === view
                ? 'bg-ink text-paper'
                : 'bg-paper text-ink-2 hover:bg-surface hover:text-ink',
            ].join(' ')}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : (
        <MeetingList
          meetings={meetings}
          empty={
            view
              ? 'Nothing in this view.'
              : 'No meetings yet. Book one against anyone in the talent pool.'
          }
        />
      )}
    </div>
  );
}
