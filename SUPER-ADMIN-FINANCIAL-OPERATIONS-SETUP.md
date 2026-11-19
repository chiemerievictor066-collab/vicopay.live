# VicoPay Super Admin Financial Operations Centre

## Included
- `super-admin-financial-operations.html`: administrator workspace for marketplace disputes, seller withdrawal requests, and commerce settings.
- Uses the existing protected commerce endpoints in `vico-commerce.js`:
  - `GET /api/admin/commerce/overview`
  - `POST /api/admin/commerce/orders/:id/resolve`
  - `POST /api/admin/commerce/withdrawals/:id`
  - `POST /api/admin/commerce/settings`
- Linked from `super-admin-master.html`.

## Use
1. Deploy the complete project update using the same deployment process as the current VicoPay app.
2. Ensure the commerce module has run its database migration and the admin key is configured.
3. Sign in at `/super-admin-financial-operations.html` using the existing admin key.
4. Refresh before making a decision so you are acting on current server data.

## Important financial safeguards
- The `refund` order action changes the marketplace order and wallet-entry status. It does **not** issue a Paystack refund. Send the actual refund through Paystack and reconcile it separately.
- The `paid` seller-withdrawal action records that a bank transfer has been completed. The page does not initiate a bank transfer. Verify the transfer before marking it paid.
- Releasing disputed seller funds makes the wallet entry available; it does not itself transfer money to a bank.
- Marketplace settings change commission, release period, and minimum withdrawal values. Confirm policy and test with small amounts before changing them.
- This page uses the existing `requireAdmin` / `x-admin-key` protection. It does not replace it with staff MFA/RBAC. Restrict access to trusted administrators and use HTTPS.
- The page does not expose buyer delivery addresses; it displays only the seller/buyer account identifiers and dispute reason.

## Verification status
The HTML/JavaScript syntax and ZIP integrity were checked. This update was not deployed and was not tested against a live PostgreSQL database, Paystack, or production user accounts.
