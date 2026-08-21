import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import MatchBadge from '../components/MatchBadge';
import { formatDate } from '../lib/utils';

/**
 * One hand-written role and the candidates suggested for it.
 *
 * Suggestions draw on both pools — uploaded CVs and WhatsApp applicants — and
 * every row is labelled with where it came from. That label is the whole point
 * of showing them together: a recruiter treats a parsed CV and a two-line
 * WhatsApp message differently, and needs to know which one they are reading.
 */

function SourceTag({ source }) {
  const manual = source === 'manual';
  return (
    <span
      className={[
        'inline-flex items-center border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-micro',
        manual ? 'border-ink bg-ink text-paper' : 'border-rule bg-paper text-ink-2',
      ].join(' ')}
      title={manual ? 'From an uploaded CV' : 'From a WhatsApp message'}
    >
      {manual ? 'CV' : 'WhatsApp'}
    </span>
  );
}

export default function ManualRoleDetail() {
  const { id } = useParams();
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [note, setNote] = useState(null);
  const [pool, setPool] = useState('all');

  const load = useCallback(() => {
    fetch(`/api/roles/${id}`)
      .then((r) => { if (!r.ok) throw new Error(r.status === 404 ? 'Role not found' : `Server error ${r.status}`); return r.json(); })
      .then(setRole)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  async function suggest() {
    setSuggesting(true);
    setNote(null);
    try {
      const params = pool === 'manual' ? '?pool=manual' : '';
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

  if (error) return <div className="callout">{error}</div>;
  if (!role) return <div className="skeleton h-40" />;

  const suggestions = role.suggestions || [];

  return (
    <div className="space-y-8">
      <Link to="/roles" className="btn-quiet">← Open roles</Link>

      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="mono">{role.external_id} · {formatDate(role.created_at)}</p>
          <h1 className="page-title mt-1">{role.title}</h1>
          <p className="page-sub">
            {[role.company, role.location].filter(Boolean).join(' · ') || 'No company or location set'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select className="input" value={pool} onChange={(e) => setPool(e.target.value)}>
            <option value="all">Both sources</option>
            <option value="manual">Uploaded CVs only</option>
          </select>
          <button className="btn-solid" onClick={suggest} disabled={suggesting}>
            {suggesting ? 'Searching…' : 'Suggest matches'}
          </button>
          {suggestions.length > 0 && (
            <a className="btn" href={`/api/roles/${id}/export.csv`}>Export CSV</a>
          )}
        </div>
      </header>

      {note && <div className="callout">{note}</div>}

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

      <section className="space-y-4">
        <div className="flex items-end justify-between border-b border-ink pb-2">
          <p className="micro">Suggested candidates</p>
          <p className="tnum text-sm text-ink-2">{suggestions.length}</p>
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
