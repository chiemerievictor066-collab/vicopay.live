# VicoPay monthly creator payouts — setup

## What was added
| File | Purpose |
|---|---|
| `payouts.js` | All payout logic: bank recipients, monthly eligibility, email approval, Paystack transfers, webhooks, duplicate protection |
| `server.js` | 14 changed lines: loads `payouts.js`, handles `transfer.*` webhooks, creates the tables at start |
| `admin-payouts.html` | Your review + approval dashboard (opens with your `ADMIN_KEY`) |
| `payout-setup.html` | Creators save their bank account and see their payout history |
| `admin.html` | Adds a "Payouts" button |
| `package.json` | Adds `nodemailer` (run `npm install`) |

## 1. Environment variables (Render → Environment)
```
PAYSTACK_SECRET_KEY=sk_live_...          (you already have this)
ADMIN_KEY=...                            (you already have this)
NGN_PER_USD=1500                         (rate used to turn $9 into naira — check it every month)

# the email that receives the approval code (this is the default, set it only to change it)
PAYOUT_APPROVER_EMAIL=vicopay.live@gmail.com

# how the approval email is sent — choose ONE
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=your-16-letter-gmail-APP-password   (Google Account → Security → 2-Step Verification → App passwords)
MAIL_FROM="VicoPay <yourgmail@gmail.com>"
#   or:  RESEND_API_KEY=re_...   and   MAIL_FROM="VicoPay <payouts@yourdomain.com>"

# optional safety limits (these are the defaults)
PAYOUT_HOLD_DAYS=7                       (stars must be 7 days old before they can be paid)
PAYOUT_MAX_ITEM_USD=500                  (no creator can be paid more than this)
PAYOUT_MAX_BATCH_USD=10000               (a batch above this cannot be approved)
PAYOUT_RECIPIENT_COOLDOWN_HOURS=72       (pause after a creator changes bank details)
```

## 2. Paystack dashboard (Settings)
1. **Webhook URL**: `https://YOUR-SITE/api/paystack/webhook` (the same one you already use; it now also receives `transfer.success`, `transfer.failed`, `transfer.reversed`).
2. **Preferences → Transfers**: turn **OFF** "Confirm transfers before sending" (the OTP). With it on, API transfers wait for an OTP and show as *needs review*.
3. **API Keys & Webhooks → Live IP whitelist**: add your Render server's outbound IP if Paystack asks for it.
4. Make sure **Transfers** are enabled on your business and your **NGN balance is funded** before you approve a batch (the dashboard has a balance check).

## 3. The monthly routine (manual, recommended at first)
1. Open `admin-payouts.html`, sign in with `ADMIN_KEY`.
2. Pick the month → **Preview** (any time) → **Save batch** (only once the month has ended **and** the 7-day hold has passed; September can be saved from 8 October).
3. Review every creator: stars, live days (must be all days), amount in $ and ₦, bank account.
4. **Email me the approval code** → an 8-character code arrives at your Gmail.
5. Type the code → **Approve & send money**. The transfers go out one by one.
6. Watch the table: *processing → success*. Failed or reversed payouts return the stars and email you; press **Retry**.

No code, no money. The code works once, expires in 30 minutes, allows 5 tries, and is tied to the exact list you reviewed (if anything changes, it stops working).

## 4. Rules implemented exactly as you described
* Stars: at least **3,000 earned in that month** (gifts received during the month, minus gifts passed back and forth between two accounts).
* Live: **3 hours on every day** of the month (Nigeria time). Overlapping rooms are not double counted; a live that crashed only counts up to its last heartbeat.
* Pay: **$9 for every full 3,000 stars** — 3,000 / 4,000 / 5,000 / 5,500 = $9, 6,000 = $18, 9,000 = $27.
* Stars are deducted when each transfer is claimed (3,000 for $9 even if the creator had 5,500), and returned automatically if the transfer fails or is reversed.

## 5. Going automatic later
* `PAYOUT_AUTO_CALCULATE=true`: the server builds last month's batch by itself once it is payable and emails you the code. You still approve.
* `PAYOUT_AUTO_APPROVE_MAX_USD=300`: only after weeks of clean tests. Batches at or below that total are sent without a code (you still get an email). Leave it unset to keep human approval forever.

## 6. Test first
Use your Paystack **test** secret key and a test creator first. Then do one live batch with a single real creator before the full month.
