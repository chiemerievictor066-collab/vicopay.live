# VicoPay Market Community, Messages, and Calls update

## Files updated
- `gm-nav.js`: removed Vico AI from the shared bottom navigation and stopped the floating Vico AI mascot overlay from appearing on Market Community pages.
- `global-market-community.html`: removed the Vico AI homepage button, mascot and AI card.
- `vico-messages.html`: added people search by display name or username. Product pages continue to open the correct Vico Message conversation directly.
- `live-feed.html`: moved the viewer video-call action into a visible button in the bottom chat bar.
- `Go-Live.html`: attaches caller audio as well as caller video on the host side.
- `vico-product.html`: labels the in-app chat action as Vico Message and adds a private seller-contact action for listings configured for direct contact.
- `vip-profile.html`: explains that VIP is switched off separately from a temporary server failure.

## VIP activation
The project initializes VIP with `enabled=0` and exposes the admin switch at `/admin-vip.html`. Open that page on the live site, enter the `ADMIN_KEY` from the Render environment settings, then press **Turn ON**. Do not share the key in chat. Turning on the global VIP system does not itself mark an individual user as VIP; user eligibility and admin approvals remain controlled by the VIP rules.

## Seller contact information
The Marketplace already stores the contact number and WhatsApp/phone preference when the seller chooses the **direct deal** option. The contact endpoint only reveals that number to a signed-in buyer for that active listing. Vico Message uses the seller's VicoPay account/handle and does not require exposing a phone number publicly.

## Video-call behavior
A viewer opens a live stream and presses the new bottom **📹 Call** button. The streamer must accept in the Go Live studio. The caller camera/microphone are only published after acceptance. Both parties need camera/microphone permissions and a working LiveKit configuration. These source changes do not prove a live two-device call until deployed and tested with two separate accounts/devices.

## Deployment safety
Replace only the files in this update. Keep `.env`, `node_modules`, `package.json`, and the existing PostgreSQL database. No database reset is required.
