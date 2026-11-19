# VicoPay Live

Live streaming with gifts, coins (bought with Paystack), PK battles, fan clubs and creator payouts.
Video runs on LiveKit Cloud. **All accounts, coins and transactions are stored in PostgreSQL**, so nothing is lost when the server restarts or you redeploy.

## 1. How your coins are kept safe
```
users            id, username, email, password_hash, created_at
balances         user_id, coins                       (the database refuses a balance below 0)
transactions     id, kind, sender_id, receiver_id, amount, reference, created_at
ledger_entries   one line per balance change, like a bank statement:
                    Victor  +1000  Bought 1000 coins
                    Victor   +200  (gift received)       Victor   -50  Sent Rose to Sarah
```
- Every money event (buy, gift, fan club, refund) is ONE database transaction: the balance, the transaction row and the statement lines are saved together, or not at all.
- Coins are only ever taken with `UPDATE ... WHERE coins >= price`, so two gifts at the same instant can never spend the same coins twice.
- A Paystack payment reference can be stored only once, so a payment can never be credited twice.
- Nothing is edited or deleted. A refund is a new row. `npm run db:verify` checks that every balance equals the sum of its statement lines.
- Users see their statement at `coin-history.html`.

## 2. Run it on your computer
```
npm install
cp .env.example .env          # Windows: copy .env.example .env
```
Install PostgreSQL (postgresql.org/download), create a database (`createdb vicopay`), then in `.env` set
`DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/vicopay` and `AUTH_SECRET` (generate with
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
```
npm start                     # tables are created automatically; open http://localhost:3000
npm run smoke                 # in a 2nd terminal: self-checks of the running site
npm run db:selftest           # proves the coin rules on your database (uses a throw-away schema)
```
Needs Node.js 18+. Camera and microphone only work on `http://localhost` or an `https://` address.

## 3. The .env settings
| Setting | What it is |
|---|---|
| `DATABASE_URL` | **Required.** Your PostgreSQL address. On Render use the database's *Internal Database URL*. |
| `AUTH_SECRET` | **Required.** Long random string that signs logins. |
| `ADMIN_KEY` | A long secret you choose. It is the password for `/admin.html`. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud, Settings, Keys. Without them nobody can broadcast or watch. |
| `PAYSTACK_SECRET_KEY` | Paystack, Settings, API Keys. `sk_test_...` first, `sk_live_...` only when ready. |
| `APP_URL` | Your public address, e.g. `https://yourdomain.com`. |
| `RESEND_API_KEY`, `MAIL_FROM` | Sends password-reset emails (resend.com). Without them the link is only printed in the server log. |
| `PAYOUT_HOLD_DAYS` | Days new gift stars are held before withdrawal (default 7). Protects you from chargebacks. |
| `NGN_PER_USD`, `SUPPORT_EMAIL` | Start-up payout check / optional support address. |
| `PGSSL`, `PG_POOL_MAX`, `USER_CACHE_MAX` | Optional database tuning. |

## 4. Put it online on Render (step by step)
1. **Database first.** Render dashboard, New, PostgreSQL. Choose a **paid** instance type.
   **Do not use the Free database for real users:** Render deletes free databases after 30 days and does not back them up at all.
   Region: pick the one closest to your users, and use the same region for the web service.
2. Open the database and copy **Internal Database URL**.
3. New, Web Service, connect your GitHub repo. Runtime Node. Build command `npm install`. Start command `npm start`. Health check path `/api/health`.
4. Environment: add `DATABASE_URL` (the internal URL), `AUTH_SECRET`, `ADMIN_KEY`, `APP_URL`, the LiveKit and Paystack keys, `RESEND_API_KEY`, `MAIL_FROM`.
5. Deploy. In the logs you should see `Ledger check OK`. Open `https://yourapp.onrender.com/api/health`.
6. Paystack, Settings, API & Webhooks: webhook URL `https://yourdomain.com/api/paystack/webhook`. Test with `sk_test_` first.
7. Run once from your computer, against the live site: `BASE_URL=https://yourdomain.com npm run smoke`.
8. Run the database proof once, using the database's *External* URL on your computer:
   `DATABASE_URL="postgres://...render.com/..." npm run db:selftest`
   (it builds and deletes its own throw-away schema; your data is not touched).

Use a web service plan that does not sleep (free web services stop when idle, which drops live streams).

## 5. Backups (do this before you announce)
- **Render, paid database:** continuous backups with point-in-time recovery (Render dashboard, your database, Recovery). The recovery window depends on your Render workspace plan. You can also "Create export" there (kept 7 days).
- **Your own copy, weekly:** from your computer, `npm run backup` (needs `DATABASE_URL` pointing at the External URL). It writes `backups/vicopay-DATE.ndjson.gz`. Keep it somewhere private (Google Drive, an external disk). It contains password hashes and bank details.
- **Restore** into a new, empty database: `npm run restore -- backups/vicopay-DATE.ndjson.gz`. It prints whether the books balance afterwards.
- **Test a restore once** into a scratch database before you trust it.
- `npm run db:verify` can be run any time; the server also checks the ledger at start-up and every hour (see Admin, Overview).

## 6. What is in the app
| Page | What it does |
|---|---|
| `live-room.html` | Grid of everyone live now (2 per row on phones). Categories, search, Following tab, Go Live button. |
| `live-feed.html` | Opens when you tap a live. Swipe up/down for the next live. Chat, gifts, hearts, follow, fan club, PK battles, share, report, Go Live. |
| `Go-Live.html` | Host studio: camera, microphone, effects, chat, PK challenges, fan club, earnings, followers. |
| `buy-coin.html`, `coin-history.html` | Buy coins with Paystack; see every coin movement. |
| `hosts.html`, `gifters.html`, `followers.html`, `fan-club.html`, `pk-battles.html`, `profile.html` | Rankings, social pages and profile photos. |
| `forgot-password.html`, `reset-password.html` | Self-service password reset by email. |
| `admin.html` | Needs `ADMIN_KEY`: stats, users (ban, reset link), lives (end), reports, withdrawals, ledger check. |

## 7. Money rules
- 10 coins cost ₦100. Hosts are paid $9 per 3,000 stars (about 41% of what buyers spent at ₦1,375/$). The server warns at start-up if a change would make self-gifting profitable.
- Stars are held `PAYOUT_HOLD_DAYS` days; stars two accounts sent to each other are not withdrawable.
- A chargeback or refund takes the coins back, removes the stars from hosts who received them, freezes the buyer and logs it in Admin, Reports.
- You pay hosts yourself (bank transfer). Nothing is sent automatically.

## 8. Honest limits (read before you plan for millions)
- **PostgreSQL makes the data permanent and consistent. It does not by itself make the site handle millions of people at once.** Live-room state (who is watching, gift pop-ups, PK timers) is held in this server's memory, so run **one** web service copy until that is moved to Redis. One copy handles a lot of viewers, but not millions.
- Video capacity is LiveKit's: plan and price it separately (each viewer is a stream).
- Grow in steps: bigger server and database first; then Redis for live state; then several web copies.
- `/privacy.html` and `/terms.html` should be reviewed by a lawyer. Gifts and payouts carry age and money rules in Nigeria and where your users live.

## 9. Before you announce it
- [ ] Paid database, `DATABASE_URL` set, `Ledger check OK` in the logs
- [ ] `npm run db:selftest` passes on the real database
- [ ] One Paystack test purchase credits coins, then one small real purchase
- [ ] Two phones: one goes live, one watches, sends a gift, joins a PK battle
- [ ] Redeploy the service and confirm balances are unchanged
- [ ] First backup taken and a restore tested

## 10. Troubleshooting
| You see | Meaning and fix |
|---|---|
| `Unexpected token '<' ... is not valid JSON` (older versions) or "The server sent back a web page instead of data" | The page asked the server for data and got a web page. Usually: (1) Render is waking up, so wait 30 seconds and refresh (pages now retry by themselves); (2) you opened the HTML file by double-clicking it or with Live Server. Always open the site at your server address (`http://localhost:3000` or your Render address); (3) the newest version is not deployed yet. |
| "Ledger check ... MISMATCH" in the logs | A balance does not match its statement. Run `npm run db:verify` and send me the output. Do not edit balances by hand. |
| Gifts or hearts do not appear on the host's screen | The host page must be open and live. Gifts show within about 2 seconds; hearts are bundled once per second. |

## 11. Paystack fees (your account passes the fee to customers)
- Your Paystack account is set so the **customer pays Paystack's fee**. So someone buying the ₦10,000 package is charged about ₦10,250, and you receive the full ₦10,000.
- The server works out the package from what was paid (`payments.js`). A payment is accepted only if the customer paid **at least the package price** and the extra looks like a normal Paystack fee (at most 4.5% + ₦200). Paying less never gets coins, and a payment cannot be used to claim a bigger package.
- The buy-coin page tells customers that Paystack adds a small fee at checkout.
- **A payment that matches no package** (for example the customer edited the amount) is never lost silently: it is written to the server log and to **Admin, Reports** with its reference.
- **Credit a customer who paid but got no coins** (for example before this fix): find the payment's reference in Paystack, Transactions, then open
  `https://yourdomain.com/api/paystack/verify?reference=THE_REFERENCE`
  The coins are added once, to the email on the Paystack payment. Opening it again does nothing.
- Only the coin packages in `server.js` (`coinPackages`) can be started. If you add a new package there, fees on it are handled automatically.


## Forex Academy (forex.html)

A paid membership page: live chart + global chat stay free; lessons 2-8, Practice Trading, calculators and the journal unlock after paying.

Settings (Render > Environment). All are optional except the Paystack key and APP_URL:

| Name | What it does | Default |
| --- | --- | --- |
| `PAYSTACK_SECRET_KEY` | already used for coins | required |
| `APP_URL` | your site address, Paystack sends people back to `APP_URL/forex.html` after paying | `http://localhost:3000` |
| `FOREX_PRICE_USD` | dollar price | `9.99` |
| `FOREX_PRICE_NGN` | naira price | `$ price x NGN_PER_USD`, rounded up to the next 100 (₦15,000) |
| `NGN_PER_USD` | exchange rate used for the naira price | `1500` |
| `FOREX_ACCESS_DAYS` | days of access per payment (`0` = lifetime) | `30` |

* Paying in **dollars** needs USD enabled on your Paystack account (ask Paystack support). If it is not enabled, the page tells the person to pay in naira.
* Give someone access without payment (admin key in the `x-admin-key` header):
  `POST /api/admin/forex/grant` with `{ "email": "person@example.com", "days": 30 }` (days `0` = lifetime).
* The Paystack webhook (`/api/paystack/webhook`) also unlocks access, so people are unlocked even if they close the page right after paying.

### Inside the Academy

* **AI video lessons** play after each quiz: an animated lesson with captions and an AI voice (the device's built-in voice, so no files or extra cost). To use a REAL recorded video for a lesson, put its address in `url` for that lesson in `forex-content.js` (`VIDEOS`): an `.mp4`/`.webm` link, or a YouTube/Vimeo embed link (`https://www.youtube.com/embed/...`).
* **Practice Trading** has a Trade Coach (trend, support/resistance, RSI, a step-by-step practice idea sized to 1% risk), a risk meter, and a written review of every closed trade.
* **Journal** logs every closed practice trade automatically, shows win rate, profit factor, average R, results curve and personal insights, and exports to CSV.
* **Calculators** use real exchange rates from `open.er-api.com` (updated daily). If that service cannot be reached, they fall back to approximate prices and say so.

## Help Center & Support (help-center.html)

Reached from **Settings → Help & Support** (and `help-center.html` directly). It has a searchable FAQ (28 answers), a "Check a payment" tool, a contact form that opens support tickets, and "My tickets" where people read your replies. Anyone can read the FAQ; contacting support needs a signed-in account.

* **Answering tickets:** open `/admin.html`, sign in with your `ADMIN_KEY`, and use the new **Support** tab. Tickets waiting for you are listed first. When you reply, the person gets a notification that opens their ticket.
* **Optional settings** (Render > Environment): `SUPPORT_EMAIL` (shown as an email button), `SUPPORT_WHATSAPP` (number with country code, e.g. `2348012345678`, shown as a WhatsApp button), `SUPPORT_REPLY_TIME` (a sentence such as "We usually reply within 24 hours.").
* **Limits that protect you from spam:** 5 new tickets per person per hour, 15 open tickets at once, 12 messages per ticket per hour.
* **"Check a payment"** re-checks a Paystack reference with Paystack and applies it only once, so it is safe for people to try more than once. It works for both coin purchases and Forex Academy payments.
* To change the questions and answers, edit the `FAQ` list near the top of the script in `help-center.html`.

## Host payout rules (current)

* **Normal host:** at least 3,000 Golden Stars in the month, **$9 per full 3,000 stars** (6,000 = $18, 9,000 = $27 ...).
* **VIP host:** at least 12,000 Golden Stars in the month, **$10.80 per full 3,000 stars** (12,000 = $43.20, 15,000 = $54.00, 18,000 = $64.80, 21,000 = $75.60, 24,000 = $86.40, 30,000 = $108.00). 13,000 or 14,500 stars are paid as 12,000.
* Payouts are always whole blocks of 3,000 stars; stars left over after the last complete block are not paid.
* **Both:** go live **every day of the month for at least 1 hour** and complete **at least 30 live hours in the month**. Only 1 hour per day is added to the monthly hours: after the hour a host is free to keep streaming (extra hours that day are not added, stars still count), and a new day starts a new hour (a live past midnight counts on both days).
* The numbers live in `CREATOR_RULES` / `VIP_RULES` near the top of `server.js` and in `live-hours.js` (shared by the wallet and the monthly payout engine). The pages and Help Center text were updated to match.

## Fan club membership (VIP fans)

* **Levels** (`fan-levels.js`), highest first: **Legend** (50,000 points), **Diamond** (10,000), **Gold** (2,000), **Silver** (500), **Bronze** (0). Every coin a member gifts to a host is 1 fan point for that host's club.
* **Badges** (`fan-badges.js`): five medals drawn in code, used on `fan-club.html`.
* **Missions** (`fans.js`): daily check-in (+5), daily gift of 10 coins (+10), weekly 300 coins (+50), monthly 2,000 coins (+200). Each can be claimed once per period (Nigeria time); the claim row has a primary key so a double tap cannot pay twice.
* **Leaderboards**: per club (all time by points, this week / this month by coins gifted) and the biggest clubs. `fan-club.html` has the tabs.
* **Entrance effect**: a fan club member who opens THEIR host's live gets: bike video (`gift-fan-entrance-bike.mp4`), then crown video (`gift-fan-entrance-crown.mp4`), then the name slides in from the right, stays 3 seconds and leaves to the left. The name colour follows the fan level.
* **Top supporter**: the member who gifted that host the most coins (mission points never count) gets the elephant (`gift-fan-top-supporter-elephant.mp4`) instead. If a gift makes someone the new top supporter during a live, the room sees the elephant at once.
* Missions, the entrance and the elephant follow the VIP switch in `admin-vip.html`. Levels, badges and leaderboards are always visible.
* Tests: `npm run test:vip` (includes `tests/fans.test.js`).

## Ad levels and priced jobs (Vico Ad Center)
Open `ad-sense-home.html` (also linked from `vico-ad-center.html`). The advertiser's path:
1. Choose a level: Personal ($4-$10), Small business ($10-$15), Big business ($18-$35), Company ($35-$100) or National ($100+).
2. Choose a job in that level. Every job has its own price (`ad-catalog.json`, in dollars; the pages show the same numbers and `npm run test:ads` fails if they ever differ).
3. Pay with Paystack (`ad-payment.html`). The naira amount = dollar price x `NGN_PER_USD`, calculated on the server.
4. Business information (`ad-business-information.html`): owner name, logo, description, contact, location, social link, product pictures (take picture or upload), promotional video (make video or upload, 30 MB at most).
5. Identity verification (`ad-identity-verification.html`): front of the ID (camera or upload), optional back, selfie. Name, phone, country and city must equal step 4 or the server refuses with the names of the fields that differ. Then the Vico team approves or rejects in `admin-ad-jobs.html`.
To change a price, edit `ad-catalog.json` AND the matching `data-price` on the level's page. New tables only: `ad_job_orders`, `ad_job_profiles`, `ad_job_media`, `ad_job_id_files`, `ad_job_identity` (created automatically). Needs `ID_DOC_KEY` in `.env` (same key the existing ID checks use). See `vico-ad-jobs.js`.

## Product Live, Save / Follow / Like / ⋯, ID check approval, Vico AI mascot

* **Product Live** (`product-live.html`): a seller picks one of their registered Marketplace products and goes live. It uses the SAME LiveKit account and the SAME `/api/live/create` as normal Go Live, so no second LiveKit key is needed. Viewers in `live-feed.html` see the product pinned with its price and a Buy Now button. Category "Shopping" was added to the live categories.
* **Follow / Like / Save / Share / ⋯** on short videos (`vico-videos.html`) and product pictures (`vico-product.html`). 
* **ID check approval**: `ID_APPROVER_EMAIL` in `.env` is emailed when an ID is submitted (never with the photo). An approved ID is required before selling in a live (`ID_REQUIRED_FOR_PRODUCT_LIVE=true`). See `id-approval.js`.
* **Vico AI** now also works with Groq (`AI_PROVIDER=groq`, `GROQ_API_KEY`). The Ad Center shows the Vico AI robot (`vico-ai-guide.gif`) as its launcher.
* Tests: `npm run test:engage`.

### Vico Pay High Business Center, Report on videos
* `vico-business-center.html` (opened from the Global Market Community menu): Company Products and National Products, search, Buy Now (Vico checkout), save (heart), features, support and quick links. Company = seller paid for Company / Big Business ads (or is a registered company advertiser); National = seller paid for National Ads. The badge shows a tick when the seller's ID check is approved. API: `GET /api/business/products?kind=company|national&q=`.
* Report a video (flag button on the video page): 3 different reports hide it; admins restore or remove it under admin-community.html -> Marketplace reports.
* Global Market Community menu: "Back to Home" replaces Live Streaming; Short Videos and VIP Membership tiles removed; Business Center is now "Vico Pay High Business Center".

### Vico Studio
`vico-studio.html` replaces the old "Promote with Ads" / promotional video entry. It has three big buttons (Live, Short Video, Upload Video & Picture) plus shortcuts. It opens from the Marketplace menu and from the Vico Studio tile in the Global Market Community. Deep links: `vico-videos.html?upload=1` opens the video upload, `vico-marketplace.html?sell=1` opens Sell an item.

### Live promotion, story, live clock, moving chat (Go Live + Watch Live)
* `vico-promo.js` (server) + `vico-live-panel.js` (browser). Under the moving chat: a blue **Processing Promotion** button (green **Promotion Successful** with a tick once promoted), then the streamer's story (first line, **Show more**), then the live start time and a ticking duration. Viewers see the same on `live-feed.html` and `vip-live-feed.html`.
* Promoted = reached all goals (followers, likes, Golden Stars) OR bought the Promotional Duration ($12, Paystack, `promotion-duration.html`) OR already VIP. Being promoted grants VIP (`vip_eligibility`). Settings: `PROMO_*` in `.env`. New table: `promo_purchases`. Webhook handled in `server.js` (`promo.isPromoPayment`).
* The payment opens in a separate tab so the live never stops; `promotion-return.html` verifies the payment with Paystack, tells the live tab (button turns green) and closes itself.
* Start Live asks "Tell people about yourself" first (stored with the live, shown to viewers).
* The live is never interrupted: the "Leave site?" prompt was removed and every link on Go-Live opens in a layer on top of the live (**Back to my live**). Only End Live ends it.
* Tests: `npm run test:promo`.

### Promotion Successful page
`promotion-return.html` is the page Paystack sends the person to. It confirms the payment with the server, then shows the celebration (amount paid, VIP benefits). **Go Back to Live Stream** returns to the live tab (still running); **Start Your VIP Live Now** returns to it and opens the VIP features. If the live tab is gone, both go to `Go-Live.html` (`?vip=1` opens the VIP features).


## Creator Video Partnership — payment and Marketplace flow

The Creator Video Partnership module is integrated with the existing Vico Videos, Vico Pay Marketplace, Paystack webhook and creator bank-recipient setup.

- A creator submits a partnership request; only the addressed VicoPay business account can accept/reject it and record the mutually agreed amount/currency.
- The business funds that exact agreement using a server-initialized Paystack checkout. The server verifies the Paystack transaction status, amount, currency, reference, business email and partnership metadata before marking it funded. The webhook is signature-checked by the existing `/api/paystack/webhook` route and the transaction is re-verified server-to-server.
- When the creator submits a video, `Marketplace` delivery publishes it in the Creator Video Marketplace section on `vico-marketplace.html`. `Company only` delivery is removed from the public Vico Videos feed and is streamed only to the creator and addressed business through an authenticated route.
- Only after BOTH company funding is verified AND the business approves the submitted video does the payout flow start. NGN payments use the creator's existing verified Paystack NUBAN recipient and Paystack Transfers. Transfer webhooks update the partnership wallet entry to paid/available/processing. Failed transfers can be checked and retried without reusing a transfer reference.
- USD checkout is supported when enabled on the Paystack account. Paystack's Nigerian NUBAN transfer recipients are NGN-only, so USD partnership earnings are recorded in the USD partnership wallet as available; an actual USD bank settlement route must be enabled separately before USD can be auto-transferred.

### Required deployment configuration (owner/admin action)

Use the same `PAYSTACK_SECRET_KEY` already used by VicoPay coin purchases, and set `APP_URL` to the public HTTPS website origin. Configure the Paystack webhook URL as `https://YOUR-DOMAIN/api/paystack/webhook` for `charge.success`, `transfer.success`, `transfer.failed`, and `transfer.reversed`. The creator must save a verified Nigerian bank recipient through the existing Payout Setup page before NGN bank payout can complete. Paystack Transfers must be enabled and the VicoPay Paystack NGN balance must have enough settled funds. Start with Paystack test keys and test transactions before switching to live keys.

**Escrow terminology:** Paystack checkout collects money into the VicoPay Paystack merchant balance; it does not create a legally segregated escrow or trust account. The application holds the payment as an internal pending partnership liability until approval. Obtain legal/accounting advice and a suitable regulated escrow arrangement if your business requires legally protected escrow.
