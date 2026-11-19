# VicoPay Master Admin Centre

## What this stage adds

`super-admin-master.html` is the unified, read-only entry point for VicoPay operations. It consolidates customer, live-session, coin purchase, gifting, creator withdrawal, payout-hold, marketplace, staff, and security-alert summaries. It links to the existing specialist admin workspaces rather than duplicating their action forms.

The server adds `GET /api/admin/master/overview` in `admin-control-center.js`. It uses the existing administrator authorization model and returns aggregate metrics plus short recent queues. Optional subsystem queries are isolated so a missing marketplace/commerce table does not break the entire overview. Recent withdrawal rows are returned only to roles with `payouts.read`; alert rows are returned only to roles with `alerts.read`.

## Access

1. Deploy the updated project and start the server with the existing PostgreSQL configuration.
2. Open `/super-admin-master.html`.
3. Staff sign in with their provisioned administrator email, password, and six-digit authenticator code.
4. The platform owner can switch to Owner key and enter the existing `ADMIN_KEY`.
5. The page keeps its staff token or owner key in `sessionStorage` for the current browser tab/session. Sign out clears those values.

Staff accounts are still created and managed from `super-admin-control-center.html` using the existing owner-key workflow. Do not share `ADMIN_KEY` with ordinary staff.

## Data interpretation

- Coin purchases use successful rows in `payments` with status `ok` over the previous 24 hours.
- Gift volume uses `gift_transactions` timestamps and coin totals.
- Active live sessions use the stored `live_sessions` heartbeat window. For LiveKit room-level information, open the Live Command Centre.
- Withdrawal totals use `withdrawal_requests`; the dashboard does not approve, reject, or submit a payout.
- Marketplace totals use `market_orders`; the dashboard does not update order states.
- Some optional query failures return empty/zero summaries so the central page remains available. Verify the corresponding specialist module before treating a zero as proof that no activity exists.

## Safety and deployment notes

- This page is a monitoring overview, not a replacement for specialist workflows or role checks.
- The existing command centre, enforcement centre, payout module, and marketplace modules remain separate.
- No payment is initialized, reversed, refunded, or paid by this dashboard.
- No account is suspended and no order or withdrawal is modified by this dashboard.
- The new code has been syntax-checked and the ZIP archive checked. It has not been connected to the production database, deployed to hosting, or tested with live Paystack credentials in this environment.


## Action Centre (this update)

Open `/super-admin-action-centre.html` after deploying. It adds bounded customer email search for permitted security/support roles, account suspend/restore controls using the existing account-ban service, a pending-withdrawal read queue for finance roles, creator payout holds, and recent administrator audit history. The Master dashboard links to this workspace.

The customer search returns email, account creation time, and suspension status only. Payout holds stop queued transfers before Paystack submission; they cannot recall transfers already submitted. Marketplace order state changes and withdrawal approval/rejection are intentionally not added until the marketplace and payout state-transition rules are confirmed from the live deployment schema.
