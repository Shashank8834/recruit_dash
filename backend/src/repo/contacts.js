const { query } = require('../db');

/**
 * Contacts are keyed on phone number, which is the only identifier that
 * survives a user changing their WhatsApp display name.
 */
async function upsertByPhone({ phone, waJid, pushName }, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO contacts (phone, wa_jid, push_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE
       SET wa_jid     = COALESCE(EXCLUDED.wa_jid, contacts.wa_jid),
           push_name  = COALESCE(EXCLUDED.push_name, contacts.push_name),
           updated_at = now()
     RETURNING *`,
    [phone, waJid, pushName]
  );
  return rows[0];
}

async function updateDetails(id, { name, email }, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `UPDATE contacts
        SET name       = COALESCE($2, name),
            email      = COALESCE($3, email),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, name || null, email || null]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM contacts WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = { upsertByPhone, updateDetails, findById };
