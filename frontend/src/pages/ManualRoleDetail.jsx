import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import Notes from '../components/Notes';
import MeetingList from '../components/MeetingList';
import FileAttach from '../components/FileAttach';
import { STAGES, StageTag } from '../components/RoleStage';
import { formatDate } from '../lib/utils';

/**
 * One hand-written role and the candidates suggested for it.
 *
 * Suggestions draw on the talent pool only. A WhatsApp message is two lines of
 * text with no CV behind it, so a model scoring one is ranking a name and a job
 * title — and a STRONG on that evidence is not a claim anyone can act on. Rows
 * still carry their source label, because suggestions recorded before this was
 * narrowed are kept.
 */

function SourceTag({ source }) {
  const manual = source === 'manual';
  return (
    <span
      className={[
        'inline-flex items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro',
        manual ? 'border-ink bg-ink text-paper' : 'border-rule bg-paper text-ink-2',
      ].join(' ')}
      title={manual ? 'From the talent pool' : 'From a WhatsApp message'}
    >
      {manual ? 'CV' : 'WhatsApp'}
    </span>
  );
}

/** The role's own fields, as an editable form. */
function EditForm({ role, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    title: role.title || '',
    company: role.company || '',
    location: role.location || '',
    minExperienceYears:
      role.min_experience_years === null || role.min_experience_years === undefined
        ? ''
        : role.min_experience_years,
    requirements: (role.requirements || []).join('\n'),
    description: role.description || '',
  });

  function submit(event) {
    event.preventDefault();
    if (!form.title.trim()) return;
    onSave({
      title: form.title.trim(),
      // Trimmed to null rather than '': a cleared company is absent, and an
      // empty string reads downstream as a company with no name.
      company: form.company.trim() || null,
      location: form.location.trim() || null,
      description: form.description,
      minExperienceYears: form.minExperienceYears === '' ? null : Number(form.minExperienceYears),
      requirements: form.requirements.split('\n').map((r) => r.trim()).filter(Boolean),
    });
  }

  return (
    <form onSubmit={submit} className="panel space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="micro">Title *</span>
          <input
            className="input mt-1.5 w-full"
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="micro">Company</span>
          <input
            className="input mt-1.5 w-full"
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="micro">Location</span>
          <input
            className="input mt-1.5 w-full"
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="micro">Minimum experience (years)</span>
          <input
            className="input mt-1.5 w-full"
            type="number"
            min="0"
            step="0.5"
            value={form.minExperienceYears}
            onChange={(e) => setForm({ ...form, minExperienceYears: e.target.value })}
          />
        </label>
      </div>

      <label className="block">
        <span className="micro">Requirements — one per line</span>
        <textarea
          className="input mt-1.5 h-28 w-full"
          value={form.requirements}
          onChange={(e) => setForm({ ...form, requirements: e.target.value })}
        />
      </label>

      <label className="block">
        <span className="micro">Description</span>
        <textarea
          className="input mt-1.5 h-28 w-full"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </label>

      <div className="flex gap-3">
        <button className="btn-solid" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save role'}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>

      {/* Said plainly, because it is the surprising part: the requirements are
          what the matcher ranks on, so editing them changes what a re-run
          would return — while the suggestions already on the page were scored
          against the old wording. */}
      <p className="text-xs text-ink-3">
        Existing suggestions were scored against the requirements as they were. Re-run
        “Suggest matches” after changing them.
      </p>
    </form>
  );
}

export default function ManualRoleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [note, setNote] = useState(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/roles/${id}`)
      .then((r) => { if (!r.ok) throw new Error(r.status === 404 ? 'Role not found' : `Server error ${r.status}`); return r.json(); })
      .then(setRole)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  async function patch(body) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/roles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error((detail && detail.error) || `Server error ${response.status}`);
      }
      // Merged rather than replaced: PATCH returns the role row, which carries
      // no suggestions, and assigning it wholesale would empty the list below.
      const updated = await response.json();
      setRole((current) => ({ ...current, ...updated }));
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveEdits(body) {
    if (await patch(body)) setEditing(false);
  }

  async function remove() {
    if (!window.confirm(
      'Delete this role and its suggested matches? The candidates themselves are not affected.'
    )) return;
    try {
      const response = await fetch(`/api/roles/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      navigate('/roles', { replace: true });
    } catch (e) {
      setError(e.message);
    }
  }

  async function suggest() {
    setSuggesting(true);
    setNote(null);
    try {
      // No pool parameter: suggestions come from the talent pool, which is the
      // only source with a CV behind it. See the route.
      const params = '';
      const response = await fetch(`/api/roles/${id}/suggest${params}`, { method: 'POST' });
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      const data = await response.json();
      setNote(
        data.note ||
        `Considered ${data.considered} candidate(s) and scored ${data.suggestions.length}.`
      );
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSuggesting(false);
    }
  }

  if (error && !role) return <div className="callout">{error}</div>;
  if (!role) return <div className="skeleton h-40" />;

  const suggestions = role.suggestions || [];

  return (
    <div className="space-y-8">
      <Link to="/roles" className="btn-quiet">← Open roles</Link>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="mono">
            {role.external_id} · Created {formatDate(role.created_at)}
          </p>
          <h1 className="page-title mt-1">{role.title}</h1>
          <p className="page-sub">
            {[role.company, role.location].filter(Boolean).join(' · ') || 'No company or location set'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* The JD as the client actually sent it. This used to sit beside a
              "Download JD text" button that re-exported the description typed
              into this page; two buttons a step apart offering different
              documents under near-identical names is a way to send a client
              the wrong one, and the real file is what anybody wanted. */}
          {role.has_file && (
            <>
              <a
                className="btn"
                href={`/api/roles/${id}/file`}
                target="_blank"
                rel="noreferrer"
              >
                View JD file
              </a>
              <a className="btn" href={`/api/roles/${id}/file?download=1`}>
                Download JD file
              </a>
            </>
          )}
          <FileAttach
            basePath={`/api/roles/${id}`}
            hasFile={role.has_file}
            label="JD file"
            accept=".pdf,.doc,.docx,.txt,.rtf"
            onDone={load}
          />
          <button className="btn" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
          <button className="btn" onClick={remove}>Delete</button>
        </div>
      </header>

      {error && <div className="notice-error">{error}</div>}

      {/* The stage sits on its own line, above the matching controls. It is the
          field that changes most often and the one someone else reads first,
          so it should not be a menu tucked among the buttons. */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 border border-rule bg-surface px-5 py-4">
        <span className="micro">Stage</span>
        <div className="flex flex-wrap gap-2">
          {STAGES.map((stage) => {
            const current = role.status === stage.key;
            return (
              <button
                key={stage.key}
                disabled={saving || current}
                onClick={() => patch({ status: stage.key })}
                className={[
                  'border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-micro transition-colors',
                  current
                    ? 'border-ink bg-ink text-paper'
                    : 'border-rule bg-paper text-ink-2 hover:border-ink hover:text-ink disabled:opacity-40',
                ].join(' ')}
              >
                {stage.label}
              </button>
            );
          })}
        </div>
        <span className="ml-auto"><StageTag status={role.status} /></span>
      </section>

      {editing ? (
        <EditForm
          role={role}
          onSave={saveEdits}
          onCancel={() => setEditing(false)}
          saving={saving}
        />
      ) : (
        <section className="grid gap-8 lg:grid-cols-3">
          <div className="space-y-2 lg:col-span-1">
            <p className="micro">Requirements</p>
            {(role.requirements || []).length === 0 ? (
              <p className="text-sm text-ink-2">None listed — matching will rely on the title alone.</p>
            ) : (
              <ul className="space-y-1">
                {role.requirements.map((r, i) => (
                  <li key={i} className="border border-rule bg-surface px-3 py-2 text-sm">{r}</li>
                ))}
              </ul>
            )}
            {role.min_experience_years !== null && (
              <p className="text-sm text-ink-2">Minimum {role.min_experience_years} years.</p>
            )}
          </div>

          {role.description && (
            <div className="space-y-2 lg:col-span-2">
              <p className="micro">Description</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{role.description}</p>
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-end justify-between border-b border-ink pb-2">
          <p className="micro">Meetings for this role</p>
          <Link to="/meetings" className="btn-quiet text-xs">Book one</Link>
        </div>
        <MeetingList
          meetings={role.meetings || []}
          hideRole
          empty="Nobody has been met for this role yet."
        />
      </section>

      <Notes
        basePath={`/api/roles/${id}`}
        notes={role.notes || []}
        onChange={(notes) => setRole((current) => ({ ...current, notes }))}
        placeholder="Client wants someone who can start within a month; band raised to 30 LPA."
      />

      {note && <div className="callout">{note}</div>}

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink pb-2">
          <p className="micro">Suggested candidates · {suggestions.length}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-solid" onClick={suggest} disabled={suggesting}>
              {suggesting ? 'Searching…' : 'Suggest matches'}
            </button>
            {suggestions.length > 0 && (
              <a className="btn" href={`/api/roles/${id}/export.csv`}>Export CSV</a>
            )}
          </div>
        </div>

        {suggestions.length === 0 ? (
          <div className="panel text-center">
            <p className="text-sm text-ink-2">
              No suggestions yet. Press “Suggest matches” to search the database.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Candidate</th>
                  <th className="th">Source</th>
                  <th className="th">Current role</th>
                  <th className="th">Experience</th>
                  <th className="th">Match</th>
                  <th className="th">Why</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={s.id} className="border-b border-rule">
                    <td className="td">
                      <span className="font-semibold">{s.name || '—'}</span>
                      {s.source === 'manual' ? (
                        <Link to={`/talent/${s.candidate_ref}`} className="mono block hover:text-ink">
                          {s.candidate_ref}
                        </Link>
                      ) : (
                        <span className="mono block">{s.candidate_ref}</span>
                      )}
                      {s.email && <span className="block text-xs text-ink-2">{s.email}</span>}
                      {s.phone && <span className="block text-xs text-ink-2">{s.phone}</span>}
                    </td>
                    <td className="td"><SourceTag source={s.source} /></td>
                    <td className="td">
                      {s.current_designation || '—'}
                      {s.current_company && (
                        <span className="block text-xs text-ink-2">{s.current_company}</span>
                      )}
                    </td>
                    <td className="td tnum">
                      {s.experience_years === null || s.experience_years === undefined
                        ? '—'
                        : `${s.experience_years} yr`}
                    </td>
                    <td className="td"><MatchBadge result={s.verdict} /></td>
                    <td className="td max-w-md text-xs leading-relaxed text-ink-2">{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
