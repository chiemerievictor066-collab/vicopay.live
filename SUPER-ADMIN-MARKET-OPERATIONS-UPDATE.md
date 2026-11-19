# VicoPay Marketplace Operations update

This update extends `super-admin-action-centre.html` with a marketplace operations workspace.

## Added
- Marketplace listing queue by status (active, hidden, sold, removed).
- Report-count visibility for each listing.
- Audited listing moderation actions: hide, remove, restore. A reason is required.
- Marketplace order monitor with buyer, seller, amount, status, and dispute reason.
- Staff permissions: `security_analyst` can read and moderate listings; `support_admin` can read marketplace data; `finance_admin` does not receive marketplace access by default. `super_admin` retains all permissions.

## API
- `GET /api/admin/actions/market/listings?status=active`
- `GET /api/admin/actions/market/orders`
- `POST /api/admin/actions/market/listings/:id/moderate` with `{ "action": "hide|remove|restore", "reason": "..." }`

All endpoints use the existing administrator token / owner-key authorization. Successful moderation is recorded in `admin_action_audit`.

## Safety boundaries
- The order monitor is read-only. It does not mark orders paid, shipped, completed, refunded, or cancelled.
- Listing moderation does not suspend the seller's entire account.
- A listing restoration clears no reports through this new route; it only changes the listing status.
- Marketplace migrations and schema must already be applied by the existing marketplace module.
- This is code-level work only. It has not been run against the production database, payment provider, or live deployment. Test with a staging database and non-production accounts before release.
