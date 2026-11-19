# Vico Pay Global Enquiries & Invoice Billing

## What was added
- `global-enquiry.html`: public enquiry form and reference-based status checker. No Vico Pay account is required to submit an enquiry.
- `admin-global-enquiries.html`: protected administration page for reviewing submissions, sending a response, and creating a Paystack invoice.
- `global-enquiries.js`: PostgreSQL-backed enquiry and invoice APIs.
- `global-market-community.html`: adds the "Make an Enquiry" entry button in the Global Market Community hero.
- `server.js`: registers the module, runs its migrations, and forwards Paystack `paymentrequest.success` webhooks to the invoice status updater.

## Public flow
1. Visitor opens Global Market Community and selects **Make an Enquiry**.
2. Visitor submits contact, organisation type, country, category, subject and enquiry details.
3. Vico Pay saves the request and returns a unique reference (`VGE-...`).
4. Visitor can use the reference and their email address to check the response.

## Admin flow
1. Open `/admin-global-enquiries.html`.
2. Enter the existing `ADMIN_KEY` value (sent as `x-admin-key`).
3. Load and review enquiries.
4. Write a response and choose a status. If `RESEND_API_KEY` and `MAIL_FROM` are configured, Vico Pay attempts to email the response.
5. To bill the customer, enter a description, amount in NGN and optional due date, then select **Create & email invoice**.

## Paystack invoice setup
- The server uses the existing `PAYSTACK_SECRET_KEY`.
- The server creates/looks up the Paystack customer and creates a Payment Request using `POST https://api.paystack.co/paymentrequest`.
- Paystack is asked to email the invoice to the enquiry email address.
- The existing `/api/paystack/webhook` endpoint already validates Paystack's HMAC signature. It now also processes `paymentrequest.success` to mark the matching Vico Pay invoice as paid.
- Keep the same webhook URL in Paystack: `https://YOUR-DOMAIN/api/paystack/webhook`.
- In Paystack webhook event subscriptions, ensure **Payment Request Successful** (`paymentrequest.success`) is enabled in addition to your existing payment events.

## Important deployment steps
1. Deploy the updated project folder.
2. Confirm `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, `ADMIN_KEY`, `APP_URL`, `RESEND_API_KEY`, and `MAIL_FROM` are configured in the hosting environment. Resend settings are optional for storing admin responses, but needed for Vico Pay to email its own response. Paystack sends the invoice email through its own notification.
3. Restart the service. The app runs the new PostgreSQL migrations automatically.
4. Test with a Paystack test secret key and a test customer before using live payments.
5. Configure/confirm the Paystack webhook event `paymentrequest.success`.

## Existing payments
Normal Paystack checkout remains unchanged. Continue using it for coins, VIP upgrades, promotions, boosts and standard package purchases. Use invoices for negotiated/custom business billing and partnership enquiries.

## Security
- Never place `PAYSTACK_SECRET_KEY` or `ADMIN_KEY` in browser JavaScript.
- The admin page requires the existing admin key for every protected request.
- Enquiry references are random and status lookups also require the original email address.
- This feature does not automatically activate ads or other paid services after an invoice is paid; a staff member must still review and fulfil the agreed service unless a separate fulfilment workflow is added.
