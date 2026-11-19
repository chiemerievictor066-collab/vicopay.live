# VicoPay Super Admin Command Centre — integration

This upgrade is integrated into the existing VicoPay Express + PostgreSQL + LiveKit application.

## What is connected

- `GET /api/admin/command-center/overview` reads customer totals, coin payments, gift activity, active PostgreSQL live-session heartbeats, current server live rooms, and fraud alerts.
- When `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are configured, the backend queries LiveKit RoomService for active rooms and participant counts. The configured `LIVEKIT_URL` may be `wss://`; it is normalized to HTTPS for the RoomService API.
- Login success/failure events are recorded in PostgreSQL with IP and user-agent/device metadata. Passwords and authentication tokens are never stored in these records.
- Fraud scans run every 60 seconds and can also be started manually. Rules flag repeated failed sign-ins from an IP, rapid gifting bursts, duplicate purchase references in transaction records, and repeated pending withdrawal requests.
- Alerts can be acknowledged, resolved, or dismissed with an investigation note.
- The UI is served at `/super-admin-command-center.html` and uses the existing `x-admin-key` / `ADMIN_KEY` protection.

## Deploy

1. Replace the deployed project with this project version (or merge the changed files: `server.js`, `admin-command-center.js`, `super-admin-command-center.html`, and this guide).
2. Keep the existing `DATABASE_URL`, `ADMIN_KEY`, `AUTH_SECRET`, and LiveKit environment variables. Do not put secrets in browser code or commit `.env`.
3. Confirm `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are the API credentials for the same LiveKit project used by Go Live.
4. Install dependencies with `npm ci` and start with `npm start`.
5. Startup runs the additive PostgreSQL migrations for the command-centre tables. No existing business tables are dropped or rewritten.
6. Open `/super-admin-command-center.html`, select **Set admin key**, and enter the existing `ADMIN_KEY`.

## API actions

All endpoints below require `x-admin-key: <ADMIN_KEY>`.

- `GET /api/admin/command-center/overview`
- `GET /api/admin/command-center/events`
- `POST /api/admin/command-center/scan`
- `POST /api/admin/command-center/alerts/:id/review` with `{ "status": "reviewed|resolved|dismissed", "note": "..." }`

## Safety and known limits

- Fraud detection is signal generation, not a verdict. The system deliberately does not automatically ban customers, hold payouts, or reverse payments. Staff must investigate and use existing audited admin workflows for consequential actions.
- LiveKit viewer count is based on connected room participants minus the broadcaster. A second publisher/caller in the room may be counted as a viewer; if your product uses multi-publisher rooms, refine this using participant metadata/roles.
- If LiveKit credentials are absent or its RoomService API is unreachable, the dashboard reports the fallback source and uses the server's in-memory room list. It does not claim that fallback is authoritative.
- Failed Paystack initialization and verification attempts are recorded by the VicoPay server and included in the dashboard and repeated-failure rule. This is not a webhook-based feed for every abandoned checkout; a customer who opens checkout and simply leaves may not generate a failure event.
- The legacy `ADMIN_KEY` is a shared-secret gate. For production staff use, add individual admin accounts, role-based permissions, MFA, and immutable admin-action audit trails before granting access to multiple operators.
