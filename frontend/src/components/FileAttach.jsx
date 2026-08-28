import { useRef, useState } from 'react';
import { errorFrom } from '../lib/api';

/**
 * Attach a document to a record that has none, or replace the one it has.
 *
 * The same control on a candidate's CV and on a role's JD, because it is the
 * same act in both places: the record exists, the file it should be carrying
 * does not, and the only way to fix that used to be deleting the record and
 * creating it again through an upload form.
 *
 * A hidden input driven by a button rather than a bare <input type="file">.
 * The native control renders as a grey box with "No file chosen" beside it,
 * which is the one thing on the page that cannot be styled to match anything
 * around it — and its label never says what the file is for.
 *
 * @param {string} basePath   the record's API path, e.g. `/api/roles/ROLE_1001`.
 *   The file hangs off `${basePath}/file` on both, which is what lets one
 *   component serve them.
 * @param {boolean} hasFile   whether something is already attached
 * @param {string} label      what the document is called here — "CV", "JD"
 * @param {string} [accept]   the accept attribute for the picker
 * @param {() => void} onDone called after a successful upload, to re-read
 */
export default function FileAttach({ basePath, hasFile, label, accept, onDone }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function send(file) {
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      // No Content-Type header: fetch sets it from the FormData, including the
      // multipart boundary. Setting it by hand omits the boundary and the
      // server parses nothing.
      const response = await fetch(`${basePath}/file`, { method: 'POST', body });
      if (!response.ok) {
        throw await errorFrom(response);
      }
      if (onDone) onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      // Cleared so picking the same file twice still fires a change event —
      // after a failed upload, retrying with the identical file is the most
      // likely next thing anyone does.
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => send(e.target.files && e.target.files[0])}
      />
      <button
        type="button"
        className={hasFile ? 'btn' : 'btn-solid'}
        disabled={busy}
        onClick={() => input.current && input.current.click()}
        title={
          hasFile
            ? `Replace the stored ${label} with a different file`
            : `Attach a ${label} to this record`
        }
      >
        {busy ? 'Uploading…' : hasFile ? `Replace ${label}` : `Upload ${label}`}
      </button>
      {error && <span className="text-xs text-ink-2">{error}</span>}
    </>
  );
}
