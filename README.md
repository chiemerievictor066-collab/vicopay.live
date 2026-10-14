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

* **3,000 Golden Stars = $9**, paid in complete blocks only: 6,000 = $18, 9,000 = $27, and so on. Stars left over after the last complete block (for example the extra 1,000 in 4,000 or 7,000) are not paid.
* A host must also go live **3 hours on every day of the month**.
* Both numbers live in `CREATOR_RULES` near the top of `server.js` (`minimumStars` and `dailyLiveHours`). The pages and Help Center text were updated to match.
