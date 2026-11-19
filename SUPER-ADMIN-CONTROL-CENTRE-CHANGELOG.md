# Control Centre upgrade changelog

- Added individual admin operator accounts with scrypt password hashing and RFC 6238 TOTP MFA.
- Added role scopes for security, finance, and support staff; owner-only staff provisioning and disabling.
- Added 8-hour signed staff sessions with active-role revalidation and per-IP failed-login throttling.
- Added customer suspend/restore actions using VicoPay's existing ban storage/cache.
- Added creator-level payout holds, checked at payout preview and again atomically before queued Paystack transfer submission.
- Added IP and user-agent fingerprint blocks for future password sign-ins.
- Added append-only application audit records for administrator actions and sign-ins.
- Added `/super-admin-control-center.html` responsive administration UI.
- No existing business tables are dropped; all new storage is additive.
