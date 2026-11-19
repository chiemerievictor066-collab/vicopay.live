# Master Admin Centre – Change Log

- Added `super-admin-master.html`, a responsive central operations dashboard with staff MFA and owner-key sign-in.
- Added `GET /api/admin/master/overview` to consolidate metrics from the existing PostgreSQL user, payment, gift, live-session, withdrawal, fraud-alert, payout-hold, staff, and marketplace tables.
- Added recent marketplace order, creator withdrawal, and security-alert summaries.
- Kept the master page read-only and linked existing admin specialist pages for actions.
- Restricted recent withdrawal rows to administrators with `payouts.read` and alert rows to administrators with `alerts.read`.
- Added setup and interpretation notes in `SUPER-ADMIN-MASTER-CENTRE-SETUP.md`.
