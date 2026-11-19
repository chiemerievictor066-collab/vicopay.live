# Vico Pay Live — Appreciation Rewards

## Monthly appreciation
- Normally dispatches on the first day of each Nigeria-local calendar month (`PAYOUT_TZ_OFFSET_MIN`, default UTC+1); it retries during that month after downtime.
- Sends a notification to each streamer known to the server (`host_stats` or `live_sessions`).
- Opens `appreciation.html?type=monthly&month=YYYY-MM`.
- This is recognition only: no coins, stars, or wallet credit.

## Yearly consistency reward
- Runs during January for the completed previous calendar year (including catch-up after a restart).
- Checks each of the 12 months independently using the existing server-side monthly creator requirements:
  - the host's applicable normal/VIP minimum stars;
  - at least one hour live on every calendar day in that month;
  - at least 30 qualifying live hours in the month.
- If all 12 months pass, the server credits exactly 20 coins through the existing coin ledger and sends a yearly appreciation notification.
- The award table has a `(user_id, award_year)` primary key. The coin credit and award marker are committed in the same database transaction, preventing duplicate yearly credits after restarts or repeated scheduler runs.
- Opens `appreciation.html?type=yearly&year=YYYY`.

## Files added
- `appreciation.js`: server-side monthly dispatch and annual eligibility/reward logic.
- `appreciation.html`: recipient-facing appreciation page.
- `vico-monthly-appreciation.png`: monthly artwork.
- `vico-yearly-appreciation.png`: yearly 20-coin artwork.

## Deployment
No new environment variables are required. The feature uses the existing `DATABASE_URL`, `PAYOUT_TZ_OFFSET_MIN`, authentication, notification table, creator rules, and coin ledger. Restart/redeploy the server so `db.migrate()` creates the two new appreciation tables and the scheduler starts.

The scheduler checks once per Nigeria-local day. Monthly notifications are idempotent per streamer and month; yearly coin credits are idempotent per streamer and year. If the server is down on the first day, it catches up when the server next runs during that month.
