# VicoPay Fraud Prevention & Risk Intelligence Centre

## Included
- `super-admin-risk-intelligence.html`: authenticated admin workspace for risk metrics, alert review and recent security events.
- Uses existing endpoints from `admin-command-center.js`:
  - `GET /api/admin/command-center/overview`
  - `GET /api/admin/command-center/events`
  - `POST /api/admin/command-center/scan`
  - `POST /api/admin/command-center/alerts/:id/review`
- Added a link from `super-admin-master.html`.

## Setup
1. Merge this project update into the deployed VicoPay website.
2. Ensure `ADMIN_KEY` is configured and the existing command-centre migrations have run.
3. Open `/super-admin-risk-intelligence.html` and enter the admin key.
4. Run a scan manually or allow the existing server-side scheduled scan to run.

## Safety and interpretation
Alerts are explainable signals, not proof of fraud. Shared IPs, shared devices, legitimate gifting campaigns, retries and business payout schedules can create false positives. Verify evidence in the relevant payment, account or ledger records before acting. This screen does not automatically ban users, block devices, reverse payments or freeze funds.

The dashboard is protected by the existing `requireAdmin` / `x-admin-key` mechanism. It is not yet wired to the individual staff-role MFA token permissions. Restrict access to trusted administrators and use HTTPS. No production database, Paystack account or hosting deployment was accessed during this build.
