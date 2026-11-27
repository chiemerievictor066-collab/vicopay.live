// =====================================================
// Vico Pay Live — LIVE PROMOTION ("Processing Promotion" -> "Promotion Successful") and the $12 Promotional Duration
// =====================================================
// A streamer is PROMOTED when ANY of these is true:
//   1. they bought the Promotional Duration (USD 12 by default, paid through Paystack, valid PROMO_DURATION_DAYS days; 0 = forever)
//   2. they reached ALL the free goals: followers, likes, Golden Stars (and views, if PROMO_MIN_VIEWS is more than 0)
//   3. they already have VIP (an admin gave it to them, or it was earned)
// Being promoted gives the streamer VIP (a row in vip_eligibility), so every VIP feature built before (entrance, frames,
// badges, VIP gifts, VIP rooms) switches on by itself. The live page shows a blue "Processing Promotion" button until then,
// and a green "Promotion Successful" button afterwards.
// New table only: promo_purchases. Nothing else is changed.
// .env (all optional):  PROMO_PRICE_USD=12  PROMO_PRICE_NGN=19000  PROMO_DURATION_DAYS=30
//                       PROMO_MIN_FOLLOWERS=1000  PROMO_MIN_LIKES=1000000  PROMO_MIN_STARS=9000  PROMO_MIN_VIEWS=0
// =====================================================
const TYPE = "live_promotion";
const num = (k, d) => { const v = process.env[k] === undefined || process.env[k] === "" ? NaN : Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const cfg = () => ({ priceUsd: num("PROMO_PRICE_USD", 12), priceNgn: num("PROMO_PRICE_NGN", 19000), days: num("PROMO_DURATION_DAYS", 30),
  minFollowers: num("PROMO_MIN_FOLLOWERS", 1000), minLikes: num("PROMO_MIN_LIKES", 1000000), minStars: num("PROMO_MIN_STARS", 9000), minViews: num("PROMO_MIN_VIEWS", 0) });
const minorFor = (c, currency) => Math.round((currency === "USD" ? c.priceUsd : c.priceNgn) * 100);
// the "about me" text a streamer writes when starting a live: plain text only, short
function cleanStory(v) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 500);
}
// is the streamer inside the free goals?
function meetsGoals(f, c) {
  return f.followers >= c.minFollowers && f.likes >= c.minLikes && f.stars >= c.minStars && (c.minViews === 0 || f.views >= c.minViews);
}

module.exports = function makePromo({ app, db, requireAuth, store, vip, liveRooms }) {
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const fail = (res, code, message, extra) => res.status(code).json({ success: false, message, ...(extra || {}) });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS promo_purchases (reference TEXT PRIMARY KEY, user_email TEXT NOT NULL, currency TEXT NOT NULL, amount_minor BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at BIGINT NOT NULL, paid_at BIGINT, expires_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_promo_user ON promo_purchases(user_email, status)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727292)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727292)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("PROMO MIGRATE ERROR:", e); });

  async function facts(email) {
    const [f, s] = await Promise.all([
      db.get("SELECT COUNT(*) AS c FROM follows WHERE host_id = ?", [email]),
      db.get("SELECT loves, viewers FROM host_stats WHERE host_id = ?", [email])
    ]);
    let stars = 0; try { stars = await vip.lifetimeStars(email); } catch (_) { /* vip module not ready */ }
    return { followers: Number(f.c), likes: Number((s && s.loves) || 0), views: Number((s && s.viewers) || 0), stars };
  }
  async function activePurchase(email) {
    return db.get("SELECT reference, paid_at AS \"paidAt\", expires_at AS \"expiresAt\" FROM promo_purchases WHERE user_email = ? AND status = 'paid' AND (expires_at IS NULL OR expires_at > ?) ORDER BY paid_at DESC LIMIT 1", [email, now()]);
  }
  // give the streamer VIP (silver) so the VIP features turn on. Never lowers a higher VIP and never overrides an admin "revoked".
  async function grantVip(email, reason, expiresAt) {
    try {
      const row = await db.get("SELECT tier, status, expires_at AS \"expiresAt\" FROM vip_eligibility WHERE user_id = ?", [email]);
      if (row && row.status === "revoked") return { blocked: true };
      const active = row && row.status === "approved" && (!row.expiresAt || Number(row.expiresAt) > now());
      if (active && vip.rankOf(row.tier) >= vip.rankOf("silver") && (!expiresAt || (row.expiresAt && Number(row.expiresAt) >= expiresAt) || !row.expiresAt)) return { kept: true };
      await db.run(`INSERT INTO vip_eligibility (user_id, tier, status, verified_streamer, reason, granted_by, granted_at, expires_at) VALUES (?, 'silver', 'approved', 0, ?, 'promotion', ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET tier = CASE WHEN vip_eligibility.status = 'approved' AND vip_eligibility.tier <> 'none' THEN vip_eligibility.tier ELSE 'silver' END, status = 'approved', reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at`,
        [email, reason, now(), expiresAt || null]);
      vip.dropCache(email);
      return { granted: true };
    } catch (e) { console.error("PROMO VIP GRANT:", e.message); return { error: true }; }   // VIP tables not there yet: the promotion still counts
  }

  async function evaluate(email) {
    email = lc(email); await ready;
    const c = cfg(), f = await facts(email), paid = await activePurchase(email);
    let source = "none", expiresAt = null;
    if (paid) { source = "paid"; expiresAt = paid.expiresAt ? Number(paid.expiresAt) : null; }
    else if (meetsGoals(f, c)) source = "earned";
    else { try { const t = await vip.tierOf(email); if (t && t.rank > 0) source = "vip"; } catch (_) { /* not ready */ } }
    return { promoted: source !== "none", source, expiresAt, facts: f, goals: { followers: c.minFollowers, likes: c.minLikes, stars: c.minStars, views: c.minViews }, priceUsd: c.priceUsd, priceNgn: c.priceNgn, days: c.days };
  }
  const cache = new Map();   // email -> { at, v }
  async function isPromoted(email) {
    email = lc(email); const hit = cache.get(email);
    if (hit && now() - hit.at < 20000) return hit.v;
    let v = false;
    try { const s = await evaluate(email); v = s.promoted; if (s.source === "earned") grantVip(email, "Reached the Vico Pay Live promotion goals", null).catch(() => {}); } catch (e) { v = false; }
    cache.set(email, { at: now(), v }); if (cache.size > 5000) cache.clear();
    return v;
  }
  const drop = (email) => cache.delete(lc(email));

  // ---------- status ----------
  app.get("/api/promo/plans", (req, res) => { const c = cfg(); res.json({ success: true, priceUsd: c.priceUsd, priceNgn: c.priceNgn, days: c.days, goals: { followers: c.minFollowers, likes: c.minLikes, stars: c.minStars, views: c.minViews } }); });
  app.get("/api/promo/status", requireAuth, async (req, res) => {
    try { drop(req.userEmail); const s = await evaluate(req.userEmail); res.set("Cache-Control", "no-store"); res.json({ success: true, ...s, vipOn: await vip.isEnabled().catch(() => false) }); }
    catch (e) { console.error("promo status:", e.message); fail(res, 500, "Could not check your promotion."); }
  });

  // ---------- pay ----------
  app.post("/api/promo/initialize", requireAuth, async (req, res) => {
    try {
      await ready; const c = cfg(), currency = String((req.body && req.body.currency) || "USD").toUpperCase();
      if (currency !== "USD" && currency !== "NGN") return fail(res, 400, "Choose USD or NGN.");
      const key = process.env.PAYSTACK_SECRET_KEY; if (!key) return fail(res, 500, "Payments are not set up yet (PAYSTACK_SECRET_KEY is missing).");
      const s = await evaluate(req.userEmail);
      if (s.promoted && s.source !== "paid") return fail(res, 400, "You are already promoted. You do not need to pay.", { already: true });
      const host = String(req.get("host") || "").trim();
      const site = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? req.protocol + "://" + host : String(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
      const axios = require("axios");
      let r;
      try {
        r = await axios.post("https://api.paystack.co/transaction/initialize", {
          email: req.userEmail, amount: minorFor(c, currency), currency,
          metadata: { type: TYPE, website: "Victopay", currency, days: c.days },
          callback_url: site + "/promotion-return.html"
        }, { headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, timeout: 20000 });
      } catch (e) {
        const msg = (e.response && e.response.data && e.response.data.message) || e.message;
        console.error("PROMO INIT ERROR:", msg);
        return fail(res, 400, currency === "USD" ? "Dollar payments are not available on this account right now. Please switch to Naira and try again." : (msg || "Could not start the payment."));
      }
      const d = r.data && r.data.data; if (!r.data || !r.data.status || !d) return fail(res, 400, (r.data && r.data.message) || "Could not start the payment.");
      await db.run("INSERT INTO promo_purchases (reference, user_email, currency, amount_minor, status, created_at) VALUES (?,?,?,?, 'pending', ?) ON CONFLICT (reference) DO NOTHING", [d.reference, req.userEmail, currency, minorFor(c, currency), now()]);
      res.json({ success: true, authorization_url: d.authorization_url, reference: d.reference, currency, amount: currency === "USD" ? c.priceUsd : c.priceNgn });
    } catch (e) { console.error("promo initialize:", e.message); fail(res, 500, "Could not start the payment."); }
  });

  // verify with Paystack (never trusts the browser), apply once, grant VIP
  async function confirm(reference, expectEmail) {
    await ready;
    reference = String(reference || "").slice(0, 120); if (!reference) return { ok: false, message: "Payment reference is missing." };
    const key = process.env.PAYSTACK_SECRET_KEY; if (!key) return { ok: false, message: "PAYSTACK_SECRET_KEY is not configured on the server." };
    let p;
    try { const r = await require("axios").get("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + key }, timeout: 20000 }); p = r.data && r.data.status && r.data.data; }
    catch (e) { return { ok: false, pending: true, message: "We could not confirm this payment with Paystack yet. Wait a moment and try again." }; }
    if (!p) return { ok: false, message: "Payment could not be verified." };
    if (p.status !== "success") return { ok: false, pending: p.status === "pending" || p.status === "ongoing", message: "This payment was not completed." };
    const meta = p.metadata || {}; if (meta.type !== TYPE) return { ok: false, message: "This payment is not a Promotional Duration." };
    const email = lc(p.customer && p.customer.email); if (!email) return { ok: false, message: "This payment has no buyer." };
    if (expectEmail && lc(expectEmail) !== email) return { ok: false, message: "This payment belongs to another account." };
    const c = cfg(), currency = String(p.currency || "").toUpperCase();
    if ((currency !== "USD" && currency !== "NGN") || Number(p.amount) < minorFor(c, currency)) return { ok: false, message: "The amount paid does not match the Promotional Duration price." };
    const row = await db.get("SELECT status FROM promo_purchases WHERE reference = ?", [reference]);
    if (row && row.status === "paid") { drop(email); return { ok: true, already: true, email }; }
    // extend from the end of a running promotion
    const cur = await activePurchase(email), t = now();
    const base = cur && cur.expiresAt ? Math.max(t, Number(cur.expiresAt)) : t;
    const expiresAt = c.days > 0 ? base + c.days * 86400000 : null;
    const upd = await db.run("UPDATE promo_purchases SET status = 'paid', paid_at = ?, expires_at = ? WHERE reference = ? AND status <> 'paid'", [t, expiresAt, reference]);
    if (!upd.changes) await db.run("INSERT INTO promo_purchases (reference, user_email, currency, amount_minor, status, created_at, paid_at, expires_at) VALUES (?,?,?,?, 'paid', ?, ?, ?) ON CONFLICT (reference) DO NOTHING", [reference, email, currency, Number(p.amount), t, t, expiresAt]);
    const g = await grantVip(email, "Bought the Promotional Duration", expiresAt);
    drop(email); refreshRooms().catch(() => {});
    return { ok: true, email, expiresAt, vipBlocked: !!g.blocked };
  }
  app.get("/api/promo/verify", requireAuth, async (req, res) => {
    try {
      const out = await confirm(req.query.reference || req.query.trxref, req.userEmail);
      if (!out.ok) return fail(res, out.pending ? 202 : 400, out.message, { pending: !!out.pending });
      const s = await evaluate(req.userEmail);
      const row = await db.get("SELECT currency, amount_minor AS \"minor\" FROM promo_purchases WHERE reference = ?", [String(req.query.reference || req.query.trxref).slice(0, 120)]);
      res.json({ success: true, paid: row ? { currency: row.currency, amount: Number(row.minor) / 100 } : null, already: !!out.already, vipBlocked: !!out.vipBlocked, promoted: s.promoted, expiresAt: s.expiresAt, message: out.vipBlocked ? "Your payment was received, but VIP is blocked on this account. Please contact support." : "Promotion successful!" });
    } catch (e) { console.error("promo verify:", e.message); fail(res, 500, "Could not verify the payment."); }
  });
  const isPromoPayment = (payment) => !!(payment && payment.metadata && payment.metadata.type === TYPE);

  // keep the "promoted" flag of every running live fresh (viewers see it change without refreshing)
  async function refreshRooms() { for (const room of Array.from(liveRooms.values())) { try { room.promoted = await isPromoted(room.hostId); } catch (_) { /* keep */ } } }
  const timer = setInterval(() => refreshRooms().catch(() => {}), 15000); if (timer.unref) timer.unref();

  return { ready, isPromoted, evaluate, confirm, isPromoPayment, cleanStory, drop };
};
module.exports.cleanStory = cleanStory; module.exports.meetsGoals = meetsGoals; module.exports.minorFor = minorFor; module.exports.cfg = cfg;
