# Creator Video Partnership — go-live handoff

## Implemented in the website

1. Creator sends a request to a registered VicoPay business account.
2. Only that business can accept/reject, set the mutually agreed amount and currency, and fund the offer.
3. The business pays the exact agreed amount through a server-initialized Paystack checkout. The browser never receives the Paystack secret key.
4. Paystack webhook signatures are checked by the existing webhook route. The server also calls Paystack's transaction verification endpoint and checks status, reference, amount, currency, business email and partnership metadata before recording funds as verified.
5. When the creator chooses Marketplace delivery, the submitted video is published in the Creator Video Marketplace showcase on `vico-marketplace.html`. When Company-only delivery is chosen, the video is removed from public Vico Videos and can only be viewed by the creator and addressed business through an authenticated endpoint.
6. The creator's Vico Wallet now has a Creator Partnership tab showing pending, available and paid partnership amounts separately from spendable coins.
7. Bank payout starts only when the company funding is verified AND the business approves the video. NGN payouts use the creator's existing verified Paystack NUBAN recipient. Transfer references are unique; webhook/verification updates the wallet record, and uncertain transfers are checked against the same reference before a new attempt is allowed.
8. Refund/dispute webhooks flag the partnership and block a not-yet-sent payout pending investigation.

## Owner/admin setup still required

These are deployment/account controls, not website administration pages; the admin dashboard itself was deliberately left untouched.

- Set `PAYSTACK_SECRET_KEY` on the server (start with a Paystack test secret key).
- Set `APP_URL` to the public HTTPS site origin, for example `https://your-domain.example`.
- In Paystack Dashboard → Settings → API Keys & Webhooks, configure the webhook URL as `https://YOUR-DOMAIN/api/paystack/webhook`. Enable the charge and transfer events: `charge.success`, `charge.dispute.create`, `refund.processed`, `transfer.success`, `transfer.failed`, and `transfer.reversed`.
- Enable Paystack Transfers for the VicoPay merchant account and ensure the NGN Paystack balance has enough settled funds to cover transfers and fees. If Paystack requires transfer OTP confirmation, complete the account-level transfer authorization setup; the app will not bypass Paystack's security challenge.
- Creators must save a verified bank account in the existing `payout-setup.html` flow. The existing payout security cooldown is respected before partnership transfers.
- Run a full test-mode cycle: company request → acceptance → amount offer → Paystack funding → creator submits video → company approval → transfer webhook → Vico Wallet shows paid. Then switch to live keys only after test success.

## Important limits / escrow wording

Paystack checkout collects the company's payment into the VicoPay Paystack merchant balance. Paystack does not make this a legally segregated escrow/trust account. VicoPay records the amount as pending internally and only triggers the creator transfer after approval. If the business requires regulated/legal escrow, VicoPay must contract a regulated escrow provider and the payment flow must be changed to that provider.

Paystack's Nigerian NUBAN transfer recipient is NGN. NGN partnership payments can be paid automatically to Nigerian bank accounts. USD checkout is supported only if the Paystack account has USD acceptance enabled; USD earnings are shown as available in the USD partnership wallet, but automatic USD bank settlement is not enabled for Nigerian NUBAN recipients. An owner-approved USD payout provider/route is needed for that currency.
