# VicoPay Super Admin Enforcement & Control Centre

This upgrade adds individual administrator identities, role permissions, TOTP MFA, account enforcement, sign-in fingerprint blocks, creator payout holds and an administrator action audit trail to the existing Express + PostgreSQL application.

## New page

- `/super-admin-control-center.html`

## First-time owner setup

1. Deploy the updated project and keep `DATABASE_URL`, `ADMIN_KEY`, and a stable `AUTH_SECRET` (at least 24 characters) configured.
2. Start the server. Startup creates the additional tables additively.
3. Open `/super-admin-control-center.html` and enter the existing `ADMIN_KEY` in the owner key field.
4. Create staff accounts with unique emails and passwords of at least 12 characters.
5. Securely deliver each one-time MFA secret to its owner. They add it to an authenticator app and sign in using password + current six-digit TOTP.
6. Do not share the owner `ADMIN_KEY` with staff. Disable a staff account immediately when access is no longer required.

## Roles

- `super_admin`: owner key only; full access.
- `security_analyst`: dashboard, alert review, customer suspension and sign-in fingerprint blocking.
- `finance_admin`: dashboard, alert review, payout hold/release and payout hold listing.
- `support_admin`: dashboard, alert review and customer suspension.

Staff sessions expire after 8 hours. Active status and role are rechecked on each protected request. Five failed staff logins from one IP within 15 minutes trigger a temporary 15-minute rate limit.

## Enforcement endpoints

All staff endpoints require `Authorization: Bearer <staff-session>` and the role permission listed below. Owner endpoints use the existing `x-admin-key` header.

- `POST /api/admin/control/operators` (owner): create a staff account; returns its MFA secret once.
- `GET /api/admin/control/operators` (owner): list staff.
- `POST /api/admin/control/operators/:email/disable` (owner): disable staff access.
- `POST /api/admin/control/login`: staff password + TOTP login.
- `GET /api/admin/control/overview`: operational counters and latest audit entries.
- `POST /api/admin/control/users/:email/suspend`: suspend an existing customer with a reason.
- `POST /api/admin/control/users/:email/restore`: restore a suspended customer.
- `POST /api/admin/control/payout-holds/:creatorId`: place a creator-level payout hold.
- `DELETE /api/admin/control/payout-holds/:creatorId`: release an active payout hold.
- `GET /api/admin/control/payout-holds`: list holds.
- `POST /api/admin/control/block-fingerprint`: block future sign-ins by IP or exact browser user-agent string.
- `GET /api/admin/control/audit`: read recent action audit entries.

## Payout safety

An active administrator hold is checked while evaluating a payout and again inside the atomic queued-item claim transaction immediately before a Paystack transfer is submitted. The queued item is moved to `held` instead of being sent. Releasing the creator-level hold does not automatically re-queue a previously held payout; finance staff must review it through the existing payout workflow. A transfer already submitted to Paystack cannot be recalled by this feature.

## Important limits and production requirements

- Customer suspension uses the existing `user_flags` table and shared in-memory ban cache.
- IP/user-agent blocks apply to new password sign-ins. They do not terminate already-issued stateless customer tokens; full session revocation requires introducing server-side session tracking/token-version checks.
- Device matching uses the browser's user-agent string, not a durable hardware identifier. IP blocks can affect other people sharing the same network; use cautiously.
- MFA uses RFC 6238 TOTP (30-second period, six digits, ±1 time-step tolerance). Protect the one-time secret and require staff to enroll it before sharing the account.
- Audit entries are append-only through this application's API; database owners with direct SQL access can still alter database contents. For tamper-evident compliance logs, export to an external append-only/WORM log service.
- This module does not automatically approve payouts, move money, reverse coin purchases or ban accounts based on fraud scores. Staff actions are explicit and logged.
- Deployment to the hosted VicoPay service and validation against the production database/Paystack account have not been performed by this package build.
