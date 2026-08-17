#!/usr/bin/env node
/**
 * Seeds the local database with the old mock fixtures so the dashboard has
 * something to render without a live WhatsApp connection.
 *
 *   npm run seed:dev
 */
require('dotenv').config();

const { pool, query, withTransaction } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { jds, applicants } = require('../src/services/mockData');

async function seed() {
  const { rows } = await query('SELECT COUNT(*)::int AS count FROM jds');
  if (rows[0].count > 0 && !process.argv.includes('--force')) {
    console.log('Database already has JDs. Re-run with --force to seed anyway.');
    return;
  }

  const jdIds = new Map();
  for (const jd of jds) {
    const { rows: inserted } = await query(
      `INSERT INTO jds (external_id, posted_by, jd_text, status, posted_at)
       VALUES ($1,$2,$3,$4,to_timestamp($5))
       ON CONFLICT (external_id) DO UPDATE SET jd_text = EXCLUDED.jd_text
       RETURNING id`,
      [jd.JD_ID, jd.Posted_By, jd.JD_Text, jd.Status, parseInt(jd.Date, 10)]
    );
    jdIds.set(jd.JD_ID, inserted[0].id);
  }

  for (const app of applicants) {
    await withTransaction(async (client) => {
      const { rows: contact } = await client.query(
        `INSERT INTO contacts (phone, push_name, name, email)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [app.Phone.replace(/\s+/g, ''), app.Sender, app.Name, app.Email]
      );

      const { rows: submission } = await client.query(
        `INSERT INTO submissions
           (chat_id, contact_id, combined_text, kind, status,
            window_start, window_end, created_at, classified_at)
         VALUES ($1,$2,$3,'application','classified',
                 to_timestamp($4),to_timestamp($4),to_timestamp($4),to_timestamp($4))
         RETURNING id`,
        [
          `${app.Phone.replace(/\s+/g, '')}@seed`,
          contact[0].id,
          app.Message,
          parseInt(app.Date, 10),
        ]
      );

      await client.query(
        `INSERT INTO classifications
           (submission_id, jd_id, verdict, confidence, reason, model, prompt_version, created_at)
         VALUES ($1,$2,$3,$4,$5,'seed','seed',to_timestamp($6))`,
        [
          submission[0].id,
          jdIds.get(app.JD_ID) || null,
          app.Result,
          0.9,
          app.Reason,
          parseInt(app.Date, 10),
        ]
      );
    });
  }

  console.log(`Seeded ${jds.length} JDs and ${applicants.length} applicants.`);
}

(async () => {
  await migrate();
  await seed();
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
