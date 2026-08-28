import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatDate } from '../lib/utils';
import { STAGES, StageTag } from '../components/RoleStage';
import { readJson, errorFrom } from '../lib/api';

/**
 * Roles a recruiter writes by hand.
 *
 * Separate from the WhatsApp postings, which are what the pipeline parsed out
 * of messages. A role here is something someone decided to hire for; a role
 * there is something someone happened to post in a group.
 */
export default function ManualRoles() {
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    title: '', company: '', location: '', minExperienceYears: '', requirements: '', description: '',
  });
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // In the URL so the Overview's stage breakdown can link straight to one
  // stage, and so a filtered list is a link someone can send.
  const status = params.get('status') || '';

  const load = useCallback(() => {
    setLoading(true);
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    fetch(`/api/roles${q}`)
      .then(readJson)
      .then((d) => { setRoles(Array.isArray(d) ? d : []); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [status]);

  useEffect(load, [load]);

  async function create(event) {
    event.preventDefault();
    if (!form.title.trim()) return;
    try {
      const response = await fetch('/api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          minExperienceYears: form.minExperienceYears === '' ? null : Number(form.minExperienceYears),
          // One requirement per line is how people actually type them, and each
          // is graded separately by the matcher.
          requirements: form.requirements.split('\n').map((r) => r.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) throw await errorFrom(response);
      const role = await response.json();
      navigate(`/roles/${role.external_id}`);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Managed here</p>
          <h1 className="page-title mt-1">Open roles</h1>
          <p className="page-sub">Write a role, then let the tool suggest matches from the database.</p>
        </div>
        <button className="btn-solid" onClick={() => setCreating((c) => !c)}>
          {creating ? 'Cancel' : 'New role'}
        </button>
      </header>

      {error && <div className="notice-error">{error}</div>}

      {creating && (
        <form onSubmit={create} className="panel space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="micro">Title *</span>
              <input
                className="input mt-1.5 w-full"
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Senior Backend Engineer"
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
              placeholder={'4+ years with Node.js\nPostgreSQL\nBengaluru or remote'}
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

          <button className="btn-solid" type="submit">Create role</button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-6 border border-rule bg-surface px-5 py-4">
        <label className="flex items-center gap-2.5">
          <span className="micro">Stage</span>
          <select
            className="input"
            value={status}
            onChange={(e) => {
              const next = e.target.value;
              setParams(next ? { status: next } : {}, { replace: true });
            }}
          >
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </label>
        <p className="tnum text-sm text-ink-2">{roles.length} shown</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : roles.length === 0 ? (
        <div className="panel text-center">
          <p className="text-sm text-ink-2">
            {status
              ? 'No roles at this stage.'
              : 'No roles yet. Create one to start matching.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Role</th>
                <th className="th">Stage</th>
                <th className="th">Location</th>
                <th className="th">Min experience</th>
                <th className="th">Matches</th>
                <th className="th">Notes</th>
                <th className="th">Created</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.external_id} className="row" onClick={() => navigate(`/roles/${role.external_id}`)}>
                  <td className="td">
                    <span className="font-semibold">{role.title}</span>
                    {role.company && <span className="block text-xs text-ink-2">{role.company}</span>}
                    <span className="mono block">{role.external_id}</span>
                  </td>
                  <td className="td"><StageTag status={role.status} /></td>
                  <td className="td">{role.location || '—'}</td>
                  <td className="td tnum">
                    {role.min_experience_years === null ? '—' : `${role.min_experience_years} yr`}
                  </td>
                  <td className="td tnum">{role.match_count || 0}</td>
                  <td className="td tnum text-xs text-ink-2">{role.note_count || '—'}</td>
                  <td className="td text-xs text-ink-2">{formatDate(role.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
