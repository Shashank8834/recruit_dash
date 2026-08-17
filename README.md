# Recruitment Dashboard

WhatsApp-driven recruitment pipeline: Evolution API → Express webhook → Postgres →
Gemini classification → React dashboard. **No n8n.**

## How it works

```
Evolution API ──webhook──▶ POST /webhook/whatsapp
                             │
                             ├─▶ INSERT messages          (raw, immutable, idempotent)
                             └─▶ UPSERT pending_batches   (flush_at = now + 60s)

worker (polls 5s) ──▶ claim due batches
                        │
                        ├─▶ submissions      (chained messages as one unit)
                        ├─▶ stage 1: route   (job_posting | application | chatter | unclear)
                        ├─▶ stage 2: match   (verdict + confidence + quoted evidence)
                        └─▶ classifications  (append-only)

                    sheet mirror (30s) ──▶ Google Sheet (read-only copy)
```

Three design decisions carry most of the weight:

**Raw messages are never mutated, and verdicts are append-only.** A re-run inserts a
new classification and demotes the old one. You can change a prompt, re-run it over
historical submissions, and diff the results without destroying anything.

**The debounce window lives in Postgres, not in a `setTimeout`.** Every inbound
message slides that chat's `flush_at` forward; the batch closes only after the sender
goes quiet. A restart mid-window loses nothing, and several workers can run
concurrently (`FOR UPDATE SKIP LOCKED`).

**A human override is a separate row.** It outranks the model in every read, but the
model's original verdict stays visible so you can see what was corrected — and so
re-running the classifier can never clobber a review.

## Setup

```bash
cp .env.example .env      # fill in GEMINI_API_KEY at minimum
docker compose up -d --build
```

Migrations run automatically on boot. Then point your Evolution instance's
`messages.upsert` webhook at:

```
http://<host>/webhook/whatsapp
```

Set `EVOLUTION_WEBHOOK_TOKEN` and send it as `x-webhook-token`, `apikey`, or
`Authorization: Bearer` if the endpoint is publicly reachable.

### Migrating off the existing Google Sheet

```bash
docker compose exec backend npm run import:sheets            # dry run
docker compose exec backend npm run import:sheets -- --write
```

Imported rows are tagged `model='imported:sheet'` so they're distinguishable from
anything the pipeline produced — exclude them when measuring accuracy.

After the import, Postgres is the source of truth and the sheet becomes a read-only
mirror, rewritten in full whenever anything changes. Leave `GOOGLE_SHEET_ID` blank to
turn mirroring off entirely.

### Local development

```bash
cd backend && npm install && npm run migrate && npm run seed:dev
npm run dev          # API on :3001
npm run worker:dev   # batching + classification worker

cd ../frontend && npm install && npm run dev   # :5173, proxies /api and /webhook
```

## Measuring classification accuracy

This is the part that makes prompt changes tractable rather than guesswork.

```bash
npm run eval:load    # load eval/golden.json into the DB
npm run eval         # confusion matrix + per-class precision/recall/F1
```

Run it **before and after** every prompt edit and compare. `eval/golden.json` ships
with 12 cases covering the failure modes this pipeline was built to fix — split
messages, informal JD postings, confident-sounding but evidence-free applications.
Add your own real misclassifications to it as you find them; a golden set of 50+ cases
drawn from your actual traffic is worth far more than any prompt tweak made blind.

## Tuning

| Setting | Default | Raise it when |
|---|---|---|
| `BATCH_QUIET_SECONDS` | 60 | Applications are still getting split across submissions |
| `BATCH_MAX_WINDOW_SECONDS` | 600 | Long back-and-forth threads flush too early |
| `CONFIDENCE_FLOOR` | 0.6 | Too many wrong verdicts are slipping through as confident |
| `MATCH_JD_LIMIT` | 25 | You routinely have more than 25 roles open at once |

The dashboard's **Pipeline** panel (chats mid-batch / unclassified / failed / sheet
backlog) is the fastest way to spot a stuck worker or a failing sheet sync.

## Swapping the model provider

`backend/src/services/llm.js` is the only file that talks to a provider. It takes
`(system, prompt, schema)` and returns parsed JSON, so replacing Gemini means
rewriting that one file. `GEMINI_MODEL` is env-configurable because model IDs get
renamed and retired — a 404 from the classifier should be a config change, not a
code change.

Likewise, `backend/src/services/evolution.js` is the only file that knows Evolution's
webhook format. Moving to Baileys or the WhatsApp Cloud API means rewriting it and
nothing downstream.

## API

| Endpoint | Purpose |
|---|---|
| `POST /webhook/whatsapp` | Evolution inbound messages |
| `GET /api/dashboard` | Summary counts + pipeline health |
| `GET /api/jds`, `GET /api/jds/:id` | Job descriptions and their candidates |
| `PATCH /api/jds/:id` | Open/close a role |
| `GET /api/applicants`, `GET /api/applicants/:id` | Candidates; detail includes the message thread, evidence, and verdict history |
| `GET /api/review/queue` | Everything below the confidence floor |
| `POST /api/review/classifications/:id/override` | Record a human verdict |
| `POST /api/review/submissions/:id/reclassify` | Re-run current prompts on one submission |
| `POST /api/sheets/sync` | Force a sheet mirror rewrite |
| `GET /api/health` | Liveness + DB status |
