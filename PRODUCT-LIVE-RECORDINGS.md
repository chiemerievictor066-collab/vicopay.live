# VicoPay competition email matching and product livestream recordings

## Competition email matching
- The public competition application form explains that the supplied email is the email to use for the VicoPay account.
- The competition event page asks the participant to confirm that email when joining.
- The `/api/campaigns/:id/join` endpoint compares the supplied confirmation with the authenticated VicoPay account email and rejects a mismatch. The participant is stored under the authenticated account email, so entries, votes, judging and competition records use one consistent identity.
- Admin enrolment continues to use the email supplied in the application.

## Product livestream recording
- `product-live.html` records the seller's local camera and microphone tracks with the browser `MediaRecorder` API. It creates a real WebM or MP4 video Blob; it is not a timer or a placeholder.
- When the seller ends the live, the page uploads the recording before ending the LiveKit room. If upload fails, the live remains open and the seller can retry without losing the in-memory recording.
- `product-live-recordings.js` verifies the authenticated seller owns the active room and that the room has a selected Marketplace product. It stores the binary video in PostgreSQL and associates it with the product listing.
- `vico-product.html` loads recordings for the product and displays playable video controls to customers after the live ends.
- The recording upload limit is 250 MB. The recording is stored in PostgreSQL `BYTEA`; production deployments should monitor database storage and backups. The seller must keep the live page open until the save confirmation appears.

## Files changed
- `campaign-apply.html`
- `campaign-event.html`
- `campaigns.js`
- `product-live.html`
- `product-live-recordings.js` (new)
- `server.js`
- `vico-product.html`

## Deployment
No new environment variables or third-party recording credentials are required. Deploy the updated project and restart the Node server. The new PostgreSQL table is created automatically at startup. Use HTTPS in production so camera, microphone and MediaRecorder browser APIs are available.
