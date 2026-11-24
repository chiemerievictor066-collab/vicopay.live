# Vico Message (WhatsApp-style chat + calls)

Page: `vico-messages.html` — three buttons: **Message**, **Chat**, **Call**.

| Button | What it does |
|---|---|
| **Message** | Find anyone by name, @username or phone number and send a message. Also lists **Businesses on Vico** (advertisers) with Message / Call / Phone buttons. |
| **Chat** | Your conversations: unread counts, ✓ sent, ✓✓ delivered, blue ✓✓ read, "typing…", online / last seen. |
| **Call** | Recent calls (incoming, outgoing, missed) with one-tap voice or video call-back. Search someone to call. |

## Before anyone can use it (email verification; no SMS required)
1. Log in to VicoPay.
2. Open Vico Message and request a six-digit code sent to the email address on the signed-in VicoPay account. This reuses the existing `/api/email-verify/send` and `/api/email-verify/confirm` endpoints in `email-verify.js` (Resend delivery).
3. Confirm the code and choose the name / about / privacy settings for Vico Message.

The email code confirms access to the email inbox. **It does not prove that the person owns a phone number.** New Vico Message accounts do not need to enter a phone number, and the interface does not request SMS. People can be found by display name or @username. Existing accounts that already completed SMS phone verification remain active and keep their existing verified-number features.

Email codes are six digits, hashed in the database, expire after 15 minutes, allow at most 5 wrong attempts, have a 60-second resend cooldown and a maximum of 5 sends per hour.

## You must set up (once)
1. **Resend email delivery** must already be configured: `RESEND_API_KEY` and `MAIL_FROM` using a domain verified in Resend. The Vico Message gate uses the same email verification module already used by the website.
2. Calls reuse your existing `LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET`. Calls need **https** (browsers block the microphone otherwise).
3. Deploy; the `email_verified_at` column is added automatically to `vm_profiles`. No Termii or Twilio credentials are required for new Vico Message activation.

## Link with advertiser registration (Ad Center)
* If the person already entered a business phone in Ad Center, it is offered as a one-tap suggestion when they verify.
* Advertisers with an **approved ID** (companies also need **verified company**) appear under **Businesses on Vico** with the contact details they entered.
* A green **Verified number** tag shows when the business phone equals the owner's verified Vico Message number.

## You must set up (once)
1. **SMS provider** for the code (nothing is sent without it; the site says "not switched on yet"):
   * Termii: `TERMII_API_KEY`, `TERMII_SENDER_ID` (+ optional `TERMII_CHANNEL=generic|dnd|whatsapp`), or
   * Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
   Register the sender ID with Termii first; Nigerian networks block unregistered ones.
2. Calls reuse your existing `LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET`. Calls need **https** (browsers block the microphone otherwise).
3. Deploy; tables are created automatically (`vm_profiles`, `vm_otps`, `vm_phone_throttle`, `vm_blocks`, `vm_calls`; 3 new columns on `dm_messages`).

Local testing without SMS: in `.env` set `VM_DEV_ECHO_CODE=1` (and not `NODE_ENV=production`); the code is shown on screen.

## Rules worth knowing
* Private **calls** to a VIP follow the same paid rule as live calls (`VM_VIP_CALL_GATE=off` makes them free). Messages are always free.
* People can block a contact; blocked people cannot message or call.
* Messages to someone who has not activated Vico Message wait for them; they cannot be called until they verify their account email and activate their profile.
* Realtime uses one open connection per tab (server-sent events); if it drops the page polls every 6 s. Render runs one instance, so this is fine; with several servers you would need a shared channel (e.g. Redis).

## Tests
`npm run test:message`
