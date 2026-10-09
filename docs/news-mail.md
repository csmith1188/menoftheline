# News editor and newsletter

Landing news lives in `data/news.json` (git-tracked). Admins edit it under **Admin → News** and may optionally email opted-in users through a SQLite-backed drip queue.

## News entry shape

```json
{
  "id": "2026-10-05-cavalry-skirmishers",
  "date": "2026-10-05",
  "title": "…",
  "category": "balance",
  "emailSubject": "Men Of The Line — …",
  "summary": "Markdown blurb",
  "body": "Optional longer markdown",
  "items": ["bullet", "…"]
}
```

Legacy `{ date, title, summary, items }` entries still load. Missing `id` values are assigned on admin list/save. `npm run patch-notes` prepends with a generated `id` and does not strip other entries’ fields.

Categories: `patch`, `balance`, `feature`, `announcement`, `other`.

## Subscriptions

- Profile → **Send news to my email** (verified email required).
- Default is **off** for existing and new accounts.
- One-click unsubscribe: `/unsubscribe/news?token=…` (no login; CSRF-exempt POST for List-Unsubscribe).
- Eligible send: verified email, opted in, not banned.

## Sending (DreamHost SMTP)

Transactional verify/reset and news mail share Nodemailer/`SMTP_*`. DreamHost authenticated SMTP allows about **100 recipients/hour**. Defaults:

| Env | Default | Role |
|-----|---------|------|
| `NEWS_MAIL_DELAY_MS` | `60000` | Pause between messages |
| `NEWS_MAIL_MAX_PER_HOUR` | `70` | Soft cap under provider limit |
| `NEWS_MAIL_BATCH_SIZE` | `1` | Rows per worker tick |
| `NEWS_MAIL_CONCURRENCY` | `1` | Parallel sends |
| `NEWS_MAIL_MAX_ATTEMPTS` | `5` | Transient retries |

Also set `NEWS_MAIL_PHYSICAL_ADDRESS` (and optionally `NEWS_MAIL_FROM`, `NEWS_MAIL_SENDER_NAME`, `NEWS_MAIL_REPLY_TO`) for CAN-SPAM footer / From override.

Quota errors pause the campaign for one hour. Growth beyond a few hundred subscribers should move news to a dedicated ESP; keep DreamHost for account mail.

## Admin flow

1. Create/edit entry (markdown + bullets) or raw JSON.
2. Preview website / email HTML / plain text.
3. Save without sending.
4. Test send → admin’s verified email only.
5. Confirm + type `send` to queue a campaign.
6. Pause / resume / cancel; history on the News index.

At most one active (`queued` / `sending` / `paused`) campaign per news `id`.

## Code map

| Module | Role |
|--------|------|
| `server/newsStore.js` | Load/validate/upsert/`news.json` lock |
| `server/newsRender.js` | Website / email / plain renderers |
| `server/newsMailer.js` | Queue worker, test send, campaign start |
| `server/admin/news.js` | Admin helpers |
| `server/mail.js` | `sendNewsEmail` + List-Unsubscribe headers |
| `server/db.js` | Opt-in, tokens, campaigns, outbox |
