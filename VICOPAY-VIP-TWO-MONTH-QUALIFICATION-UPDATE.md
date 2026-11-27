# VicoPay VIP two-month qualification update

## New rule
- A verified $12 Promotional Duration payment grants Silver VIP immediately.
- The paid VIP period lasts exactly two calendar months from the verified payment time.
- The streamer must earn at least 9,000 Golden Stars from gifts received after that payment and before the two-month expiry.
- Reaching 9,000 qualifying stars converts the promotion to permanent VIP (no expiry).
- If the deadline passes before 9,000 qualifying stars are reached, the paid promotion expires and the account returns to normal live-streamer status.
- After an unsuccessful expiry, another verified $12 payment is required to start a new two-month qualification period.
- The payment button is hidden while a promotion is active; a second payment cannot be made early to extend the current period.

## Files in this patch
- `vico-promo.js` — server-side payment, qualification, two-calendar-month expiry, star accounting and automatic expiry checks.
- `promotion-duration.html` — explains the rule to streamers and displays qualifying stars earned since payment.
- `tests/promo.test.js` — updated tests for the two-month calendar duration.

## Install
1. Make a backup of your current project folder.
2. Extract this ZIP.
3. Copy the two root files into the root of your existing `vicopay-website` project, replacing those two files.
4. Copy `tests/promo.test.js` into your existing `tests` folder, replacing that file.
5. Do not replace `.env`, `node_modules`, `package.json`, or database files.
6. In the project terminal run:
   - `node --check vico-promo.js`
   - `npm run test:promo`
7. Commit and push the three changed files to GitHub. Wait for Render to finish deploying, then test with a new/eligible account.

## Important
Existing still-active paid promotions created under the old 30-day setting are migrated to two calendar months from their original verified payment time. Promotions that already expired are not extended.

The existing `PROMO_DURATION_DAYS` environment variable is no longer used. The duration is fixed in server code at two calendar months. The $12 price remains controlled by the existing `PROMO_PRICE_USD` / `PROMO_PRICE_NGN` settings.

The 9,000-star target is measured using qualifying gifts received after the successful payment, excluding circular/self-gifting using the project's existing netting approach. This is a server-side check; a browser message alone cannot grant VIP.
