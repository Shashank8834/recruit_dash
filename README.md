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
                        ├─▶ fetch attachments from Evolution, extract PDF/DOCX text
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

Container names and host ports are parameterised (`STACK_PREFIX`,
`BACKEND_HOST_PORT`, `FRONTEND_HOST_PORT`, `POSTGRES_HOST_PORT`) so this stack can
run alongside an existing deployment during migration. Defaults are
`recruitment-v2-*` on ports 3012 / 3013 / 5433.

If Evolution runs in a different compose project, set `EVOLUTION_NETWORK` to the
Docker network it is on and `EVOLUTION_NETWORK_EXTERNAL=true`. Both directions
depend on it: Evolution resolving this stack by container name, and the worker
calling Evolution back to fetch attachments.

Migrations run automatically on boot. Then point your Evolution instance's
`messages.upsert` webhook at:

```
http://<host>/webhook/whatsapp
```

Set `EVOLUTION_WEBHOOK_TOKEN` and send it as `x-webhook-token`, `apikey`, or
`Authorization: Bearer` if the endpoint is publicly reachable.

**Set `INGEST_ALLOWED_CHATS`.** Evolution delivers every inbound message on the
instance — group traffic, DMs, everything. Without an allowlist a personal DM
becomes a candidate row. Use full JIDs, comma-separated:

```
INGEST_ALLOWED_CHATS=120363412324850699@g.us
```

### Resume attachments

Evolution sends webhooks with `webhookBase64=false`, so attachments arrive as
metadata only and the bytes must be fetched back by message id. Set
`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, and `EVOLUTION_INSTANCE` and the worker
will pull each attachment, extract text from PDF, DOCX, or plain text, and feed
it to the classifier alongside the message.

Leave those unset and the feature is simply off: a resume reaches the classifier
as `[document: cv.pdf]` with no content, which sends the candidate to human
review rather than losing them. Images and audio are skipped. An extraction
failure never fails the batch, and the review queue's **Re-classify** button
retries the fetch and rebuilds the submission text — the recovery path for a
transient Evolution error.

### Cutting over from n8n

Evolution allows only **one** webhook URL per instance, so you cannot natively
deliver to both the old flow and this one. `WEBHOOK_FORWARD_URL` closes that gap:
point Evolution at this stack and set the variable to the old n8n webhook, and
every payload is relayed onward verbatim. Both pipelines then run on identical
live traffic for as long as you want to compare them.

The forward is fire-and-forget — it never delays the response or fails ingest.
Unset it once n8n is retired. Rollback at any point is one call re-pointing
Evolution's webhook back at n8n, so save the original URL before you start.

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
| `MEDIA_MAX_MB` | 15 | Candidates send resumes larger than 15MB |
| `MEDIA_MAX_CHARS` | 20000 | Long CVs are being truncated before the classifier sees the end |

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
