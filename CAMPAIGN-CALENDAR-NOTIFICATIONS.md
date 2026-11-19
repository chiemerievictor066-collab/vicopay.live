# VicoPay Campaign Calendar & Notifications

## Calendar
- Public Campaigns page: published, live and completed events appear in the calendar.
- Admin Event Creator Studio: all event statuses appear, including drafts.
- Calendar supports Day, Month and Year views. Choose a month from Year view, then choose a day from Month view.
- Calendar dates and times use the visitor's browser local time zone.

## In-app notifications
- Publishing an event sends one schedule notification to every registered VicoPay account in the `users` table.
- Changing an event to Live sends a separate live-now notification to every registered VicoPay account.
- Admin announcements broadcast to every registered VicoPay customer and streamer account.
- Notifications are stored in the existing PostgreSQL `notifications` table and appear in the VicoPay notification bell after the user signs in.
- These are in-app notifications. Email, SMS and browser push delivery are not configured by this change.

## Install
1. Back up the existing project folder.
2. Copy the updated project files into the existing `vicopay-website` folder.
3. Keep the existing `.env` file and all secret values.
4. Restart the server with `npm start`.
5. The campaign module adds the notification timestamps to `campaign_events` automatically during its database migration.

## Test
1. Open `admin-campaigns.html` and sign in with the configured `ADMIN_KEY`.
2. Create an event with a start and end date, then save it.
3. Open Event calendar and check Year, Month and Day views.
4. Change the event status to Published. Check the admin response for the number of account notifications delivered.
5. Change the status to Live. A separate live-now notification is sent once.
6. Sign in with a customer or streamer account, open the notification bell and confirm the event alert is present.
7. Publish an announcement from the Notifications tab and confirm it is broadcast to all registered accounts.

The project files pass Node.js syntax checks. A live PostgreSQL deployment and multi-account delivery test still needs to be performed in the user's environment.
