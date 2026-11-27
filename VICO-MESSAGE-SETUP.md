# Vico Message (WhatsApp-style chat + calls)

Page: `vico-messages.html` — three buttons: **Message**, **Chat**, **Call**.

| Button | What it does |
|---|---|
| **Message** | Find anyone by name, @username or phone number and send a message. Also lists **Businesses on Vico** (advertisers) with Message / Call / Phone buttons. |
| **Chat** | Your conversations: unread counts, ✓ sent, ✓✓ delivered, blue ✓✓ read, "typing…", online / last seen. |
| **Call** | Recent calls (incoming, outgoing, missed) with one-tap voice or video call-back. Search someone to call. |

## Verification steps (phone first, then the others)
1. **Phone number.** The person picks a country, types the number and VicoPay sends a six-digit code. They type the code and the number is marked verified.
2. **Email.** They continue to the email code (`/api/email-verify/*`, Resend delivery).
3. **Profile.** They choose name / about / privacy and start messaging.

One backend (`vico-messages.js`) creates, hashes, expires and checks the code for **every** delivery method. Codes are six digits, hashed with a per-code salt, expire after 10 minutes, allow 5 wrong tries, have a 60-second resend wait, at most 5 sends per hour per person, and per phone number and connection limits.

| Delivery | Used for | Needs |
|---|---|---|
| **SMS through Infobip** | Backup for people without internet data; also the only method that proves the SIM is theirs | `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_SENDER` |
| **Browser push** (Web Push) | Code arrives as a notification and fills the box by itself | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (make them with `npm run push:keys`) |
| **Android app push** (Firebase) | Server side is ready; the app is a later build | `FIREBASE_SERVICE_ACCOUNT_JSON` |

Accounts activated earlier by email only keep working. Set `VM_REQUIRE_PHONE=on` if you want phone verification to be compulsory for everybody.

**Push codes and trust.** A push code is delivered to a browser/app the person is already signed in on, so it proves control of that device, **not** that the number is theirs. For that reason a number verified only by push is stored as `phone_verified_via = 'push'`: it is not searchable by phone number, does not earn the green *Verified number* tag, and can be claimed by whoever later receives an SMS code on it. SMS-verified numbers cannot be taken over.

## Setting up Infobip (once)
1. Create the account at infobip.com. In the portal copy your **API key** and your **base URL** (`xxxxx.api.infobip.com`).
2. Render -> Environment: `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_SENDER` (and `APP_URL=https://vicopay.live`). Deploy.
3. **Free trial limits:** Infobip only sends to the phone number you registered with, and only from the sender `InfoSMS`. Before real customers, top up and register your own sender ID for Nigeria (and other countries that require it); unregistered senders are blocked there.
4. The site calls Infobip's current `POST /sms/3/messages` API with `Authorization: App <key>`. A message Infobip rejects (for example no credit) is shown to the person as "could not send"; it is never reported as sent.

## Setting up browser push (once)
1. Run `npm run push:keys` on your computer and put the three lines it prints in Render -> Environment. Keep the private key secret.
2. Deploy. The service worker is `/vico-sw.js`. The page offers "Send the code to this device instead" only when these keys exist and the browser supports push.
3. iPhone/iPad Safari only supports web push for sites added to the Home Screen.

## Android app push (later build)
The server side is already there. When you build the Android app:
1. Firebase console: create the project, add the Android app, generate a service-account key and put it in `FIREBASE_SERVICE_ACCOUNT_JSON`.
2. In the app, get the token with `FirebaseMessaging.getInstance().token` and send it to `POST /api/vm/push/fcm` with body `{"token":"..."}` using the same signed-in session as the website.
3. VicoPay then sends the code as a notification with data `type=vm_phone_code` and `code=123456`, so the app can fill the code box. `POST /api/vm/push/unsubscribe` with `{"token":"..."}` on sign-out.

## Link with advertiser registration (Ad Center)
* If the person already entered a business phone in Ad Center, it is offered as a one-tap suggestion when they verify.
* Advertisers with an **approved ID** (companies also need **verified company**) appear under **Businesses on Vico** with the contact details they entered.
* A green **Verified number** tag shows when the business phone equals the owner's verified Vico Message number.

## You must set up (once)
1. An SMS provider (Infobip above) and, if you want the notification method, the push keys above. Nothing is sent without them; the site says "not switched on yet".
2. Calls reuse your existing `LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET`. Calls need **https** (browsers block the microphone otherwise).
3. Deploy; tables are created automatically (`vm_profiles`, `vm_otps`, `vm_phone_throttle`, `vm_push_devices`, `vm_blocks`, `vm_calls`; new columns `vm_profiles.phone_verified_via`, `vm_otps.channel`).

Local testing without SMS: in `.env` set `VM_DEV_ECHO_CODE=1` (and not `NODE_ENV=production`); the code is shown on screen.

## Rules worth knowing
* Private **calls** to a VIP follow the same paid rule as live calls (`VM_VIP_CALL_GATE=off` makes them free). Messages are always free.
* People can block a contact; blocked people cannot message or call.
* Messages to someone who has not activated Vico Message wait for them; they cannot be called until they verify their account email and activate their profile.
* Realtime uses one open connection per tab (server-sent events); if it drops the page polls every 6 s. Render runs one instance, so this is fine; with several servers you would need a shared channel (e.g. Redis).

## Tests
`npm run test:message` (chat rules, then phone verification: Infobip, push encryption against the RFC 8291 example, device registration, number-ownership rules)
