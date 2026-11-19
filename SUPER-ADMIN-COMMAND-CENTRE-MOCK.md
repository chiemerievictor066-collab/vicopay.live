# VicoPay Super Admin Command Centre — Mock

## Open the prototype
Open `super-admin-command-center-mock.html` in a modern browser, or serve the website folder using the project's normal web server and visit `/super-admin-command-center-mock.html`.

## What is demonstrated
- Live-style streamer table with changing viewer counts, session start time, duration and heartbeat health.
- Simulated viewer activity trend.
- Fraud triage queue covering repeated payment failures, duplicate payment references, gifting velocity and new-device withdrawals.
- Security alert queue with acknowledge actions.
- Simulated fraud scan and manual test-alert generator.
- Recent security event stream and response playbook.

## Safety and limitations
This is a front-end demonstration using hard-coded, randomly changing sample data. All names, references, IP fragments, counts and amounts are fictional. Acknowledge/review actions only change browser memory for the current page session. The page does not call production APIs, access PostgreSQL, change user accounts, block logins, pause streams, hold payouts, or reverse/credit payments. It is not proof of real-time production monitoring or fraud prevention.

## Production integration still required
1. Replace demo telemetry with authenticated server-side stream/viewer events and heartbeat records.
2. Define trusted payment state transitions from verified Paystack webhooks; enforce idempotency on payment references.
3. Implement server-side risk rules with auditable evidence and configurable thresholds.
4. Add role-based permissions and approval gates for account restrictions, stream moderation and payout holds.
5. Persist alert lifecycle, assignment, notes and immutable audit events in PostgreSQL.
6. Add rate limits, retention rules, privacy controls and operational monitoring.
7. Test with staging accounts and payment-provider test mode before production rollout.
