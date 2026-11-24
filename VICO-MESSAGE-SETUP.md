# Vico Message (WhatsApp-style chat + calls)

Page: `vico-messages.html` — three buttons: **Message**, **Chat**, **Call**.

| Button | What it does |
|---|---|
| **Message** | Find anyone by name, @username or phone number and send a message. Also lists **Businesses on Vico** (advertisers) with Message / Call / Phone buttons. |
| **Chat** | Your conversations: unread counts, ✓ sent, ✓✓ delivered, blue ✓✓ read, "typing…", online / last seen. |
| **Call** | Recent calls (incoming, outgoing, missed) with one-tap voice or video call-back. Search someone to call. |

## Before anyone can use it (like WhatsApp)
1. Log in. 2. Enter phone number → SMS code. 3. Choose name / about / privacy. After that chat and calls unlock.
One verified number belongs to one account. Codes are hashed, expire in 10 minutes, allow 5 tries, 60 s between resends, 5 per hour per account and per number.

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
* Messages to someone who has not activated Vico Message wait for them; they cannot be called until they verify.
* Realtime uses one open connection per tab (server-sent events); if it drops the page polls every 6 s. Render runs one instance, so this is fine; with several servers you would need a shared channel (e.g. Redis).

## Tests
`npm run test:message`
