VicoPay Vico Message — email-based activation patch

WHAT THIS CHANGES
- New Vico Message users verify the email address on their signed-in VicoPay account using the existing Resend email verification module.
- New Vico Message users do not need to enter a phone number or receive an SMS.
- Existing accounts that already completed SMS phone verification remain supported.
- A verified email does NOT mean the user owns a phone number. New accounts are activated by email, not marked as phone-verified.

FILES TO REPLACE IN YOUR EXISTING vicopay-website PROJECT ROOT
1. server.js
2. vico-messages.js
3. vico-messages-app.js
4. vico-messages.html

OPTIONAL SUPPORT FILES
- Replace VICO-MESSAGE-SETUP.md if you use the project's setup notes.
- Replace tests/vico-message.test.js if you want the updated email-activation test included.

IMPORTANT
- Make a backup copy of the four original files before replacing them.
- Do not replace package.json, .env, node_modules, or any other project files.
- Keep your existing Resend configuration: RESEND_API_KEY and MAIL_FROM. MAIL_FROM must use a domain verified in Resend.
- No Termii or Twilio SMS credentials are required for new Vico Message activation.
- The database adds the email_verified_at column automatically when the server starts.

TESTS RUN ON THE PATCH
- node --check server.js
- node --check vico-messages.js
- node --check vico-messages-app.js
- npm run test:message
- node tests/email-verify.test.js

All listed checks passed in the supplied project snapshot.
