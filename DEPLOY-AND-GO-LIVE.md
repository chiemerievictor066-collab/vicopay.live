# Vico Pay Live — deployment and final setup

This project now includes a Render Blueprint (`render.yaml`) and a safe deployment configuration checker (`npm run check:deploy`). The Blueprint deploys the Node.js web service and uses your EXISTING PostgreSQL database URL; it does not create, migrate, or replace your database provider. The app runs its database migrations at startup.

## What is already prepared in the project

- Render build command: `npm install`
- Render start command: `npm start`
- Health check: `/api/health`
- Environment variable slots for PostgreSQL, Paystack, Resend, Admin access and LiveKit
- Existing Paystack webhook route: `https://YOUR-DOMAIN/api/paystack/webhook`
- The invoice webhook handler for `paymentrequest.success`
- Safe preflight check: `npm run check:deploy` (prints missing variable NAMES only, never secret values)

## What the project owner must supply or click

These actions require access to your hosting, database, Paystack and Resend accounts. They cannot safely be completed from this ZIP without your account authorization and secret values.

### A. Deploy on Render

1. Push this project to a PRIVATE GitHub repository. Do not upload `.env`, API keys, passwords, database dumps containing real customer data, or credentials. The repository `.gitignore` should exclude `.env`.
2. In Render, choose **New + → Blueprint** and connect that private repository.
3. Render detects `render.yaml`. Review the service name and select **Apply**.
4. When prompted, fill the environment values listed below. For `APP_URL`, initially use the Render service URL after it is assigned, or deploy and then set it to the final custom domain. Save the environment changes and redeploy.
5. After deployment, open `https://YOUR-RENDER-SERVICE.onrender.com/api/health`. A healthy response should contain `"success":true` and `"database":"ok"`.
6. If you use a custom domain, add it in Render and update `APP_URL` to that HTTPS domain, then redeploy.

This Blueprint selects Render's Free web-service plan. Free services may sleep when idle and are not a suitable guarantee for uninterrupted livestream production. Upgrade the service plan when you need always-on production availability. Continue using the existing managed PostgreSQL database (such as Neon) rather than accidentally creating a second database.

### B. Environment values to enter in Render

Required for the whole application:

- `DATABASE_URL`: your existing PostgreSQL connection string from your database provider. Use the provider's recommended pooled/runtime URL and SSL settings.
- `APP_URL`: your final public HTTPS website address, without a trailing slash.
- `AUTH_SECRET`: generate a new long random secret. Render Blueprint can generate this automatically.
- `ADMIN_KEY`: a new, private admin access key. Render Blueprint can generate this automatically; store it securely.
- `PAYSTACK_SECRET_KEY`: use `sk_test_...` while testing. Change to `sk_live_...` only after successful tests and approval to go live.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: values from your LiveKit project.

For Vico Pay to email enquiry replies:

- `RESEND_API_KEY`: your Resend API key.
- `MAIL_FROM`: a sender identity on a domain verified in Resend, for example `Vico Pay <no-reply@your-verified-domain.com>`.

The invoice email notification is requested from Paystack itself. Resend is used for Vico Pay's own enquiry response email. Verify the sending domain in Resend before relying on email delivery.

Do not paste any secret into chat, source code, a public repository, or a browser page. Enter secrets only in the hosting provider's private Environment settings.

### C. Configure the Paystack webhook

In Paystack Dashboard, open **Settings → API Keys & Webhooks** (the exact dashboard wording can vary). Set/confirm the webhook URL as:

`https://YOUR-FINAL-DOMAIN/api/paystack/webhook`

Keep the existing webhook URL if it is already the same endpoint; do not create a second competing webhook unnecessarily. Ensure the **Payment Request Successful** event (`paymentrequest.success`) is subscribed/enabled alongside your existing transaction events. Save the webhook settings.

The code verifies the Paystack HMAC signature using `PAYSTACK_SECRET_KEY`. Use the matching test secret with test transactions and the matching live secret for live transactions.

### D. Test before going live

1. Confirm `/api/health` returns a healthy database response.
2. Open `/global-market-community.html` and submit a test enquiry using an email address you control.
3. Open `/admin-global-enquiries.html`, sign in using the configured admin key, and review the enquiry.
4. Send a response. Confirm the email arrives if Resend is configured and the sender domain is verified.
5. Create a small Paystack test invoice and complete the test payment using Paystack's test payment method.
6. Confirm the webhook is received and the invoice changes to paid/success in the Vico Pay database/admin view.
7. Confirm ordinary checkout for coins, VIP, promotions and advertising still works. Do not switch to live keys until all relevant tests pass.

## What is deliberately left for you

- Connect the private GitHub repository to Render and click Apply/Deploy.
- Paste your own database, Paystack, LiveKit and Resend credentials into Render's private Environment screen.
- Confirm the final public domain and set `APP_URL`.
- Open Paystack Dashboard and enable `paymentrequest.success` on the existing webhook.
- Run the live account verification and approve any live-payment switch yourself.

These are account-owner actions. This project archive cannot deploy itself, access your hosting account, verify your secret keys, or change Paystack dashboard settings.
