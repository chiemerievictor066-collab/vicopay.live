# VicoPay Creator Video Partnership

## Included in this project
- `creator-partnership.html`: creator and business dashboard; currency choice follows the site's `VicoCurrency` preference.
- `creator-partnership.js`: authenticated API and PostgreSQL workflow.
- `server.js`: registers the partnership API.
- `home.html`, `vico-videos.html`, `vico-wallet.html`: navigation entry points.

## Workflow
1. Creator sends a request to a company's registered VicoPay account email.
2. Only that business account can accept or reject.
3. After acceptance, the business records the amount and currency agreed by both parties.
4. The offer is shown as pending in the creator's partnership wallet.
5. Creator uploads the promotional video through the existing Vico Videos uploader, then enters its video ID on the partnership page.
6. Creator chooses `VicoPay Marketplace` distribution or `company only` delivery.
7. The business reviews and approves or rejects the submitted video.
8. Business approval changes the work status to approved, but the amount stays pending until an administrator verifies that the business actually funded it. The admin-only funding confirmation endpoint then inserts one idempotent partnership wallet entry. Rejection leaves the amount pending and allows a revised video to be submitted.

## Important implementation notes
- Amounts are creator/business negotiated; VicoPay does not set a default fee.
- NGN/USD selection is shared with the site's existing `vico-currency.js`.
- Video submissions must reference an active video owned by the signed-in creator.
- All actions are authenticated and ownership-checked server-side.
- The partnership wallet is a separate fiat-denominated partnership earnings ledger. It is **not yet connected to automatic Paystack escrow collection or bank payout/withdrawal**. A business offer records an agreed pending obligation; it does not prove that the business has funded escrow. Available balance is credited only after an administrator verifies external funding. Marketplace selection is saved with the submission; public Marketplace publication still needs its own publishing integration.
