# Account deletion

Self-service soft delete for authenticated accounts. Product defaults for v1:

| Topic | Policy |
|-------|--------|
| Method | Soft delete: keep `accounts.id`, set `deleted_at`, scrub PII |
| Public name | **Fallen Soldier** |
| Unused tickets | Forfeited after explicit confirmation (ledger `kind=account_delete`) |
| PayPal / Digipog cash refund | Not automatic; settle or cancel open purchases before delete |
| Historical display name | Staff-only in `deleted_account_identity.former_name` for **730 days**, then cleared |
| Public profile | Remains viewable as Fallen Soldier with historical stats |
| Leaderboard | Tombstones remain listed as Fallen Soldier |
| UGC bodies | Chat / suggestions / wiki / reports keep message bodies; identity fields anonymized |

Publish site Terms / Privacy / Refund copy separately so players see the same forfeiture rules before confirming.

## Flow

1. Profile → Delete account → confirmation page (what is removed / retained).
2. Re-auth: password if local credentials exist; otherwise fresh login within 10 minutes (`session.reauthAt`).
3. Type `DELETE`, submit (CSRF on web; Bearer session on `POST /api/v1/account/delete`).
4. Transaction scrub + session wipe; login with old email/OAuth fails; same email may create a **new** account id.

## Staff access

Admins and moderators may see `former_name` and the historical account id on the admin user page. Email and OAuth ids are not retained after deletion.

## Ops

SQLite backups may retain pre-deletion PII until aged out. Provider-side PayPal / Discord / Formbar data is outside this erase path.
