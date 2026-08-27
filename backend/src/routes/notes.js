const express = require('express');
const notesRepo = require('../repo/notes');

/**
 * The notes endpoints, as a router any entity can mount under its own path.
 *
 * Written once and mounted four times rather than copied into each route file.
 * The handlers are identical apart from how an external id becomes an internal
 * one, so that difference is the only thing a caller supplies.
 *
 * Mounted with `mergeParams` so `:id` from the parent path is visible here —
 * without it every handler would see an empty params object and resolve the
 * wrong record.
 *
 * @param {string} target  a key of notesRepo.TARGETS
 * @param {(externalId: string) => Promise<{id: number}|null>} resolve
 *   Turns the id in the URL into the row the notes hang off. Returning null
 *   is a 404 — the caller decides what "not found" means for its own ids.
 */
function notesRouter(target, resolve) {
  const router = express.Router({ mergeParams: true });

  /** Trims and nulls a submitted string; '' from a blank input is not a value. */
  function text(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
  }

  async function owner(req, res) {
    const row = await resolve(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    return row;
  }

  router.get('/', async (req, res) => {
    try {
      const row = await owner(req, res);
      if (!row) return;
      res.json(await notesRepo.list(target, row.id));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const body = text((req.body || {}).body);
      if (!body) return res.status(400).json({ error: 'A note cannot be empty.' });

      const row = await owner(req, res);
      if (!row) return;
      // The author is the signed-in user, not a name the client sends.
      //
      // It used to be a free-text box beside the note, which made attribution
      // a matter of whether somebody bothered to fill it in — and left it
      // trivially deniable when they did, since anyone could type anyone's
      // name. A note is a record of who learned what, so it is stamped from
      // the session and req.body.author is ignored entirely.
      res.status(201).json(
        await notesRepo.add(target, row.id, { body, author: req.user ? req.user.name : null })
      );
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:noteId', async (req, res) => {
    try {
      const body = text((req.body || {}).body);
      if (!body) return res.status(400).json({ error: 'A note cannot be empty.' });

      const row = await owner(req, res);
      if (!row) return;
      const updated = await notesRepo.update(
        target, row.id, parseInt(req.params.noteId, 10), { body }
      );
      if (!updated) return res.status(404).json({ error: 'Note not found' });
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:noteId', async (req, res) => {
    try {
      const row = await owner(req, res);
      if (!row) return;
      const removed = await notesRepo.remove(
        target, row.id, parseInt(req.params.noteId, 10)
      );
      if (!removed) return res.status(404).json({ error: 'Note not found' });
      res.json({ deleted: removed.id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { notesRouter };
