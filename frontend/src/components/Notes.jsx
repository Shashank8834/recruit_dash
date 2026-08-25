import { useState } from 'react';
import { formatDateTime } from '../lib/utils';

/**
 * Notes on whatever record the page is showing.
 *
 * The same component on a candidate, a role, a posting and an applicant,
 * because it is the same act in all four places: the fields hold what the
 * record states, and this holds what somebody learned. "Wants to stay in Pune",
 * "client pushed the salary band up", "poster never replied" — the things that
 * decide what to do next, and that no extraction or classifier can produce.
 *
 * Each note keeps its own date and author, because a note without a date is a
 * claim with no shelf life: "wants 20% more" reads very differently a year on.
 *
 * @param {string} basePath  the record's API path, e.g. `/api/roles/ROLE_1001`.
 *   Notes hang off `${basePath}/notes` on every entity, which is what lets one
 *   component serve all four.
 * @param {Array}  notes     the notes as last read from the server
 * @param {(notes: Array) => void} onChange  called with the fresh list after a write
 * @param {string} [placeholder]  an example note that suits this record type
 */
export default function Notes({ basePath, notes = [], onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState('');

  async function send(path, options) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, options);
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error((detail && detail.error) || `Server error ${response.status}`);
      }
      // Re-read rather than patching local state: the list is small and the
      // server owns the ordering and the timestamps.
      const fresh = await fetch(`${basePath}/notes`).then((r) => r.json());
      onChange(fresh);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    const ok = await send(`${basePath}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: draft, author: author.trim() || null }),
    });
    if (ok) setDraft('');
  }

  async function saveEdit(noteId) {
    if (!editBody.trim()) return;
    const ok = await send(`${basePath}/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: editBody }),
    });
    if (ok) setEditingId(null);
  }

  async function remove(noteId) {
    if (!window.confirm('Delete this note?')) return;
    await send(`${basePath}/notes/${noteId}`, { method: 'DELETE' });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between border-b border-ink pb-2">
        <p className="micro">Notes</p>
        <p className="tnum text-sm text-ink-2">{notes.length}</p>
      </div>

      {error && <div className="notice-error">{error}</div>}

      {notes.length === 0 ? (
        <p className="text-sm text-ink-3">
          Nothing recorded yet. Notes are carried into the spreadsheet exports.
        </p>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <li key={note.id} className="border border-rule bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="mono">
                  {formatDateTime(note.created_at)}
                  {note.author ? ` · ${note.author}` : ''}
                  {note.updated_at !== note.created_at ? ' · edited' : ''}
                </p>
                <div className="flex gap-3">
                  <button
                    className="btn-quiet text-xs"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(editingId === note.id ? null : note.id);
                      setEditBody(note.body);
                    }}
                  >
                    {editingId === note.id ? 'Cancel' : 'Edit'}
                  </button>
                  <button className="btn-quiet text-xs" disabled={busy} onClick={() => remove(note.id)}>
                    Delete
                  </button>
                </div>
              </div>

              {editingId === note.id ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    className="input h-24 w-full"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                  />
                  <button className="btn-solid" disabled={busy} onClick={() => saveEdit(note.id)}>
                    {busy ? 'Saving…' : 'Save note'}
                  </button>
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                  {note.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="space-y-3 border border-rule px-4 py-4">
        <textarea
          className="input h-24 w-full"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder || 'Add a note…'}
        />
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="input w-48"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name (optional)"
          />
          <button className="btn-solid" type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </form>
    </section>
  );
}
