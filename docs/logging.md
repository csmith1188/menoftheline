# Production logging

Men of the Line uses [Pino](https://getpino.io/) for structured JSON logs on the server.

## LOG_LEVEL

| Value | Use |
| --- | --- |
| `info` (default) | Match lifecycle, auth outcomes, tickets/payments, admin actions, socket connect/disconnect, failures |
| `debug` | Significant unit commands, bot buy/posture decisions, chat rejects, ticket holds |
| `warn` / `error` / `fatal` | Abuse, failed ops, process-ending failures |

Set in `.env`:

```bash
LOG_LEVEL=info
# LOG_LEVEL=debug
```

Unset `LOG_LEVEL` also defaults to `info`.

## Development vs production

- **Production** (`NODE_ENV=production`): always JSON. Info/debug go to **stdout**; warn/error/fatal also to **stderr** (PM2 `*-error.log`).
- **Development**: when stdout is a TTY, logs are pretty-printed unless `LOG_PRETTY=0`. Set `LOG_PRETTY=1` to force pretty, or `LOG_PRETTY=0` for JSON locally.

Do not log passwords, PINs, session secrets, auth tokens, CSRF tokens, API keys, or mail bodies. Prefer fields like `matchId`, `userId`, `accountId`, `socketId`, `event`.

## PM2 log locations

With `pm2 start app.js --name motl -i 1` (keep **one** instance):

| Stream | Typical path |
| --- | --- |
| stdout | `~/.pm2/logs/motl-out.log` |
| stderr | `~/.pm2/logs/motl-error.log` |

Tail:

```bash
pm2 logs motl
# or
tail -f ~/.pm2/logs/motl-out.log ~/.pm2/logs/motl-error.log
```

## Searching by matchId / userId

Each line is JSON with an `event` field and contextual bindings.

```bash
# One match
rg '"matchId":"<uuid>"' ~/.pm2/logs/motl-out.log

# One user across matches
rg '"userId":"<id>"' ~/.pm2/logs/motl-*.log

# Structured filter with jq
rg '"matchId":"<uuid>"' ~/.pm2/logs/motl-out.log | jq -c 'select(.event=="match_ended")'
```

Useful events: `match_started`, `match_ended`, `player_disconnected`, `auth_failed`, `ticket_purchase`, `ticket_purchase_ambiguous`, `invalid_action`, `match_error`, `admin_action`.

## Admin event sink

High-value events are also written to the SQLite `admin_events` table for `/admin/logs` (auth failures, ticket failures, match lifecycle, admin actions). Retention defaults to 14 days (`ADMIN_EVENT_RETAIN_DAYS`). This is not a full Pino mirror and does not store sim ticks or high-volume socket traffic.

## Recommended pm2-logrotate

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

Keep `instances` at `1` unless you intentionally configure `WORKER_COUNT` (see `goals.md` / deploy notes). Match state is not shared across PM2 processes.
