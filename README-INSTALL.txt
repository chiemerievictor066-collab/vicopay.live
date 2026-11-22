VicoPay Google Sign-In patch

Files to replace in your existing vicopay-website folder:
- server.js
- db.js
- join-now.html
- env.example (reference template only; do not overwrite your real .env)

Then:
1. In your real local .env, add GOOGLE_CLIENT_ID=your Google OAuth Web Client ID.
2. In Render -> VicoPay Web Service -> Environment, add GOOGLE_CLIENT_ID with the same value.
3. In Google Cloud Console, open the OAuth 2.0 Client ID of type Web application.
   Authorized JavaScript origins:
     https://vicopay.live
     http://localhost:3000
   Do not put a path such as /join-now.html in the origins.
4. Save environment changes and redeploy on Render.
5. Visit https://vicopay.live/join-now.html and test.

How this works:
- The Google button appears only when GOOGLE_CLIENT_ID is set on the server.
- The server validates Google's ID token with Google's tokeninfo endpoint and checks the audience and verified email.
- It only signs in an email that already exists in VicoPay.
- The first successful Google sign-in for that existing email links the Google identity in a new PostgreSQL table.
- Google sign-in does not create a new VicoPay account.
- Existing email/password login is unchanged.

Database safety:
- db.js adds one CREATE TABLE IF NOT EXISTS migration for google_identities.
- It does not delete, reset, or modify existing VicoPay account or wallet records.
- Keep your actual .env private. Never send your Google client secret (if one exists) or other server secrets.
