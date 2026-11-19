# VicoPay Campaigns & Competitions — setup

This update adds a PostgreSQL-backed first release of the VicoPay event and competition area.

## Pages
- `campaigns.html` — public event discovery, category filters, event notices and sponsor enquiry form.
- `campaign-event.html?id=EVENT_ID` — event details, event view count, participants, likes and one-account/one-vote flow.
- `admin-campaigns.html` — Super Admin event creator, event status control, calendar, in-app announcements and sponsor enquiry review.

The public landing page and existing `admin.html` now link to the new feature.

## Run locally (Windows)
1. Extract this project folder.
2. Open Command Prompt in the `vicopay-website` folder — the folder that contains `server.js` and `package.json`.
3. Keep your existing `.env` file in this folder. Do not replace it with the example file. Confirm `DATABASE_URL`, `AUTH_SECRET`, and `ADMIN_KEY` are set.
4. Run:

   ```bat
   npm install
   node --check server.js
   node --check campaigns.js
   npm start
   ```

5. Open `http://localhost:3000/campaigns.html` to see the public page.
6. Open `http://localhost:3000/admin-campaigns.html` to create events. Enter the same `ADMIN_KEY` value configured in `.env`.
7. Create an event as a draft. Review its dates, rules, banner/promo URLs and prize details. In the admin event list, change its status to `published` to make it public.
8. To announce an event, open **Notifications**, choose the event or all streamers, and publish the message. It appears in the in-app campaign announcements feed.

## Current first-release behaviour and important boundaries
- Event records, participant registrations, votes, event views/likes, announcements and sponsor enquiries are stored in PostgreSQL. The tables are created automatically when the server starts.
- Each signed-in account can register once and vote once per event. Each signed-in account can like an event once.
- The view counter records event-page visits. It is not a count of simultaneous live viewers.
- The live URL field can link to a VicoPay stream, but automatic LiveKit room creation and real-time concurrent viewer counts are not connected yet.
- Banner and promo video fields currently accept URLs; direct media upload is not included in this release.
- Notifications are published to the in-app announcement feed. Browser push, SMS and email broadcast delivery are not connected yet.
- Sponsor submissions are enquiries only. Sponsor payment collection, escrow and automatic prize funding are not connected yet.
- Bracket format and bracket size can be configured, but automatic match generation, round advancement and judge scoring are a subsequent stage.
- Participant cards show follower counts and aggregate VicoPay gift coins/supporter counts received during the event window. Gift totals are displayed as support statistics only; they are not automatically added to vote scores or used to decide winners. No coins are charged by this feature.

Do not publish a paid competition or promise cash prizes until entry rules, judging, payout funding, dispute handling and all relevant legal/payment-provider requirements have been reviewed.

## Competition engine update
- `campaign-competition-admin.html` is the Super Admin control room for generating knockout brackets, recording match winners, assigning judges, reviewing disputes and finalizing winners.
- Brackets are generated once per event from registered participants. Odd-sized brackets automatically advance bye participants. Confirming a match result creates the next round when the current round is complete.
- Judges are assigned by the Super Admin using the judge's VicoPay account email. Assigned judges can submit a score from 0 to 100 for either participant in an unfinished match using the scoring API.
- The public event page now displays the bracket, score leaderboard and dispute submission form.
- Leaderboard formula: 1 point per verified event vote + 1 point per 100 gift coins received during the event + average judge score (0–100). Gift values are read from the existing `gift_transactions` table; no coins are deducted or charged by scoring.
- The admin finalization action uses the completed knockout final winner when a bracket exists. For open-format events, it selects the highest weighted leaderboard score, with judge score, votes and gift coins as tie-breakers. Open disputes block finalization.
- Finalization marks the event completed and records its winning participant. It does not send prize money or trigger Paystack transfers.

## Competition livestream, watch page and audience feedback

The competition livestream uses the existing VicoPay LiveKit setup and the normal Go Live studio:

1. A creator signs in and joins a published competition.
2. From the event page, the creator opens **Start competition live** (`campaign-live.html?id=EVENT_ID`).
3. The creator opens the existing Go Live studio. The studio creates the normal VicoPay LiveKit room and attaches that room to the creator's competition entry using `/api/campaigns/:id/live/attach`.
4. Viewers open `campaign-watch.html?id=EVENT_ID&entry=ENTRY_ID`. The watch page requests a viewer-only LiveKit token and subscribes to the participant's live video/audio.
5. The watch page includes event likes, creator follow, share, event voting, comments, viewer assessments (1–10), and a Send Gift link into the existing VicoPay live-feed experience for that same room.
6. The event administrator opens `campaign-feedback-admin.html`, enters the existing `ADMIN_KEY`, and switches between Viewer comments and Viewer assessments. These audience assessments are stored for admin review and do not silently alter the official bracket/judge score.

New PostgreSQL tables: `campaign_viewer_comments` and `campaign_viewer_judgements`. The migration runs with the existing campaign migration on server startup. `campaign_entries.live_room_id` links each registered creator to their active LiveKit room.

The viewer count on the watch page is the LiveKit room's connected remote participants excluding the host. It is a live connected-participant count, not a historical unique-view count. Actual streaming requires valid `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` server environment values.

## VicoPay Watch discovery integration

The normal Watch Live feed and VIP Watch feed now load `vico-watch-discovery.js`. It adds a shared top navigation for All Live, Trending, Followers, Dancers, VIP Live, Short Videos, Pictures/Marketplace, Competitions, Global Market and Vico Studio. As viewers scroll, a discovery panel is inserted after the first few live rooms (or after the available rooms when fewer are live). It loads published/live competitions from `/api/campaigns`, active short videos from `/api/videos?tab=trending`, and active product picture listings from `/api/market/listings`.

Normal Watch Live already discovers all active live rooms, including VIP hosts; the VIP feed remains a filtered VIP-only view. VIP viewing remains available from the normal feed, while membership/join actions continue to use the existing VIP access checks. Product livestreams started from Vico Studio are displayed in the normal live cards through the existing `room.product` / Product Live integration.
