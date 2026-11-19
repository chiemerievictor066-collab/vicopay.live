# Vico Pay Live — Shared live and marketplace calling

This project now uses its existing LiveKit livestream room for accepted viewer-to-streamer video calls. The caller joins the same room after the streamer accepts, so the stream continues and the caller is shown in the existing portrait picture-in-picture window.

## Access rules
- VIP caller to VIP host: free.
- Normal account to normal account: free.
- VIP caller to normal account: free.
- Normal account to VIP host: free after 9,000 lifetime earned stars; otherwise the caller may continue earning stars or pay $3 USD for one call request.
- A paid request only authorizes one call request. It does not guarantee acceptance and does not expose private contact information.

VIP status and stars are checked on the server using the existing VIP eligibility and gift records. Browser-supplied star counts are not trusted.

## Marketplace
The Marketplace seller form now includes “Allow buyers to request a video call when I am live.” When enabled, the product details page shows a Video Call button. It opens the seller's active livestream if one exists; otherwise the buyer can message the seller or use contact details the seller has chosen to share. Product Live uses the same live room and the same access checks.

## Payment configuration
The $3 call access checkout is initialized and verified server-side through Paystack in USD. Set `PAYSTACK_SECRET_KEY` and a correct public `APP_URL` on the backend. The merchant's Paystack account must be enabled to accept USD transactions; if USD is not enabled, the checkout will be rejected and no access will be granted. The payment callback returns to `vip-call-payment.html`, which verifies the reference with the backend.

## LiveKit configuration
Keep `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` on the backend only. The caller token is issued only after a matching call request has been accepted by the host.

## Database
On server startup, `vico-calls.js` creates `vico_call_requests` and `vico_call_payments`. The Marketplace migration adds `market_listings.call_enabled` with a default of enabled for existing listings.

## Test checklist
1. Test a normal-to-normal call: request, accept, picture-in-picture, mute, camera toggle, end.
2. Test a VIP-to-VIP call: no payment prompt.
3. Test a normal caller below 9,000 stars calling a VIP: show the $3 checkout or allow them to wait.
4. Verify a successful USD payment and confirm the payment grants only one request.
5. Verify declined, cancelled, missed and ended calls.
6. Post a Marketplace product with video calls enabled, start a product livestream, and use the product page's Video Call button.
7. Disable video calls on a listing and confirm the button is hidden.

## Deployment note
The website and Express backend must be deployed together, and `/api/*` must reach the Node backend. Vercel static hosting alone cannot run Express or the LiveKit media server. The LiveKit server and network bandwidth remain infrastructure costs.
