# PayPal ticket checkout

Men of the Line sells fixed USD ticket packages through PayPal Checkout (Orders API v2 + JavaScript SDK). Digipog packs via Formbar are unchanged.

## Packages (server-authoritative)

| Package id | Price | Tickets |
|------------|-------|---------|
| `pack_5` | $5.00 USD | 20 |
| `pack_20` | $20.00 USD | 100 |
| `pack_50` | $50.00 USD | 300 |

Clients may only send `packageId`. Amounts and ticket counts are never taken from the browser.

## Eligibility

PayPal checkout is **enabled** only when:

1. `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set, and
2. `LOCAL_ACCOUNTS` or `DISCORD_LOGIN` is on.

It is **unavailable** for:

- Guests and unverified local emails (same rule as other account features when `AUTH_EMAIL` is on)
- Any account with `formbar_id` set (those accounts use Digipogs on `/buy`)

If only Formbar login is enabled, PayPal stays off for everyone.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PAYPAL_MODE` | `sandbox` (default) or `live` |
| `PAYPAL_CLIENT_ID` | Public REST app client id (also loaded by the JS SDK) |
| `PAYPAL_CLIENT_SECRET` | REST secret — **server only**, never expose to the browser |
| `PAYPAL_WEBHOOK_ID` | Webhook id from the Developer Dashboard (signature verify) |
| `PAYPAL_MERCHANT_ID` | Optional merchant id; when set, captures must match this payee |

Copy from `.env.template`. Do not commit `.env`.

## Developer Dashboard setup

1. Create (or open) an app at [PayPal Developer](https://developer.paypal.com/dashboard/).
2. Use **Sandbox** credentials while testing; switch to **Live** for production and set `PAYPAL_MODE=live`.
3. Copy Client ID and Secret into `.env`.
4. Under the app, add a webhook:
   - URL: `{THIS_URL}/webhooks/paypal` (must be HTTPS in production)
   - Events:
     - `CHECKOUT.ORDER.APPROVED`
     - `PAYMENT.CAPTURE.COMPLETED`
     - `PAYMENT.CAPTURE.DENIED`
     - `PAYMENT.CAPTURE.REFUNDED`
     - `PAYMENT.CAPTURE.REVERSED`
5. Copy the webhook **ID** into `PAYPAL_WEBHOOK_ID`.
6. Optionally set `PAYPAL_MERCHANT_ID` from account settings so captures are checked against your merchant id.

Local sandbox testing often needs a tunnel (ngrok, Cloudflare Tunnel, etc.) so PayPal can reach `/webhooks/paypal`. Browser capture still credits when the user stays on the page; webhooks recover disconnects.

## Flow

1. Buyer opens `/buy` (or profile ticket section) and clicks a PayPal button.
2. Browser `POST /api/paypal/orders` with `{ packageId }` + CSRF header.
3. Server creates a PayPal order for the catalog amount and inserts `paypal_purchases` (`status=created`).
4. Buyer approves in PayPal; browser `POST /api/paypal/orders/:orderId/capture`.
5. Server captures, verifies amount/currency/merchant/status, then credits tickets once (`status=credited`) and writes `ticket_ledger` (`kind=purchase`, `ref_type=paypal_purchase`).
6. If the browser drops after approve, `CHECKOUT.ORDER.APPROVED` / `PAYMENT.CAPTURE.COMPLETED` webhooks run the same settlement path.
7. Refunds/reversals claw back free tickets (`kind=paypal_clawback`). If the account has too few free tickets (held for a match), the shortfall is stored on the purchase row for admin review — balances never go below held.

## Admin

- User detail: PayPal purchases table (order/capture ids, status, clawback shortfall)
- Ops: lookup by order/capture id, reconcile stale rows, CSV export `paypal_purchases.csv`

## Sandbox testing checklist

1. Set sandbox credentials and webhook (or rely on capture-only for a first smoke test).
2. Log in with a **non-Formbar** local or Discord account.
3. Open `/buy`, buy each package with a sandbox personal account.
4. Confirm balance and purchase history update; confirm admin user page shows the row.
5. Repeat capture/webhook (PayPal webhook simulator) and confirm tickets are not double-credited.
6. Issue a sandbox refund and confirm clawback / shortfall behavior.

## Out of scope

Subscriptions, vaulted payment methods, automatic reloads, and native `/api/v1` PayPal checkout are not implemented.
