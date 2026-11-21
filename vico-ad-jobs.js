// =====================================================
// Vico Pay Live — VICO AD CENTER: advertising levels and priced jobs
// =====================================================
// The advertiser flow (see ad-sense-home.html):
//   1. choose a level: Personal, Small business, Big business, Company or National
//   2. choose a job in that level (each job has its own price, e.g. Personal $4-$10)
//   3. PAY with Paystack            (ad-payment.html)
//   4. business information          (ad-business-information.html): owner name, logo, description, contact, location, social link,
//                                    product pictures (take or upload), promotional video (make or upload)
//   5. identity verification         (ad-identity-verification.html): the ID details must EXACTLY match step 4, then the Vico team reviews
// Rules this file follows:
//  * The price comes ONLY from ad-catalog.json on the server (dollars) x NGN_PER_USD. The browser never sets an amount.
//  * Money is only believed after the server asks Paystack (vico-commerce.js does that; this file only registers the purpose "adjob").
//  * ID photos are encrypted (AES-256-GCM, key ID_DOC_KEY in .env), only the Vico team can see them, and they are deleted as soon as the team decides.
//  * Name, phone, country and city on the ID form must equal the business information (letters, spaces and capitals are ignored, nothing else).
// New tables only: ad_job_orders, ad_job_profiles, ad_job_media, ad_job_id_files, ad_job_identity. Nothing existing is changed.
// =====================================================
const crypto = require("crypto");
const CATALOG = require("./ad-catalog.json");
const DAY = 86400000;
const ID_TYPES = ["National identity card", "International passport", "Driver's licence", "Voter's card"];
const PLACEMENT_CHOICES = ["TikTok", "Vico Short Video", "Marketplace", "Vico Live"];
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PRODUCT_PICS = 8, MAX_IMAGE_BYTES = 6 * 1024 * 1024, MAX_VIDEO_BYTES = 30 * 1024 * 1024, MAX_ID_BYTES = 8 * 1024 * 1024;
const ngnPerUsd = () => Number(process.env.NGN_PER_USD) || 1500;

// ---- pure rules (tested) ----
const LEVEL_BY_LABEL = {}; Object.keys(CATALOG.tiers).forEach((k) => { LEVEL_BY_LABEL[CATALOG.tiers[k].label.toLowerCase()] = k; LEVEL_BY_LABEL[k] = k; });
function findJob(level, category) {
  const key = LEVEL_BY_LABEL[String(level || "").trim().toLowerCase()]; if (!key) return null;
  const want = String(category || "").trim().toLowerCase(); if (!want) return null;
  const job = CATALOG.tiers[key].jobs.find((j) => j.name.toLowerCase() === want); if (!job) return null;
  return { tier: key, label: CATALOG.tiers[key].label, job: job.name, group: job.group, usd: job.usd };
}
// the amount Paystack is asked for, in naira (the commerce file turns naira into kobo)
function quoteFor(level, category, rate) {
  const j = findJob(level, category); if (!j) return null;
  const r = Number(rate) > 0 ? Number(rate) : 1500;
  return { ...j, ngn: Math.round(j.usd * r), kobo: Math.round(j.usd * r) * 100, currency: "NGN", rate: r };
}
// "John  O. Doe" and "john o. doe" are the same person; "Jon Doe" is not
const normText = (s) => String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/[\s]+/g, " ").trim();
function normPhone(s) {   // 0801 234 5678, +234 801 234 5678 and 2348012345678 are one number
  let d = String(s == null ? "" : s).replace(/[^0-9]/g, ""); if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1);
  return d;
}
function compareIdentity(profile, id) {
  const miss = [];
  if (normText(profile.ownerName) !== normText(id.legalName)) miss.push("name");
  if (!normPhone(profile.phone) || normPhone(profile.phone) !== normPhone(id.phone)) miss.push("phone number");
  if (normText(profile.country) !== normText(id.country)) miss.push("country");
  if (normText(profile.city) !== normText(id.city)) miss.push("city / state");
  return { ok: miss.length === 0, mismatches: miss };
}
// which step the advertiser is on, from what is really recorded
function stageOf(order, profileComplete, idStatus) {
  if (!order) return "none";
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "pending_payment") return "payment";
  if (!profileComplete) return "profile";
  if (idStatus === "approved") return "verified";
  if (idStatus === "pending") return "review";
  return "identity";   // not submitted yet, or rejected (the reason is shown)
}
function sniffImage(buf, allowPdf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (allowPdf && buf.slice(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return "";
}
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf.slice(4, 8).toString("latin1") === "ftyp") return /^qt/.test(buf.slice(8, 10).toString("latin1")) ? "video/quicktime" : "video/mp4";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return "";
}
function idKey() { const k = String(process.env.ID_DOC_KEY || "").trim(); if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex"); try { const b = Buffer.from(k, "base64"); return b.length === 32 ? b : null; } catch (_) { return null; } }
function encryptBuf(key, buf) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv), enc = Buffer.concat([c.update(buf), c.final()]); return { enc, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") }; }
function decryptBuf(key, p) { const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64")); d.setAuthTag(Buffer.from(p.tag, "base64")); return Buffer.concat([d.update(p.enc), d.final()]); }
function cleanProfile(b, linkProblem) {
  b = b || {}; const s = (k, n) => String(b[k] == null ? "" : b[k]).trim().slice(0, n);
  const p = { ownerName: s("ownerName", 80), businessName: s("businessName", 120), description: s("description", 2500), phone: s("phone", 20), email: s("email", 120), whatsapp: s("whatsapp", 120),
    address: s("address", 200), country: s("country", 40), city: s("city", 60), socialLink: s("socialLink", 300), social: s("social", 1200), products: s("products", 2500), logo: b.logo ? String(b.logo) : "" };
  p.placements = [...new Set([].concat(b.placements || []).map(String))].filter((x) => PLACEMENT_CHOICES.includes(x));
  if (p.ownerName.length < 3) return { error: "Enter your full name (the person who owns this advert)." };
  if (p.businessName.length < 2) return { error: "Enter your business or advertiser name." };
  if (p.description.length < 10) return { error: "Describe your business (at least 10 letters)." };
  if (!/^\+?[0-9 ]{7,16}$/.test(p.phone)) return { error: "Enter a valid phone number." };
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return { error: "The business email is not valid." };
  if (p.address.length < 8) return { error: "Enter your business address or operating location." };
  if (p.country.length < 2) return { error: "Enter your country." };
  if (p.city.length < 2) return { error: "Enter your city / state." };
  if (!p.placements.length) return { error: "Choose at least one place where your advert should appear." };
  const lp = linkProblem(p.socialLink); if (!p.socialLink || lp) return { error: lp || "Add your main social media link (starting with https://)." };
  if (p.products.length < 3) return { error: "List the products or services you want to advertise." };
  if (p.logo && (p.logo.length > 330000 || !IMG_RE.test(p.logo))) return { error: "The logo must be a JPG, PNG or WebP picture." };
  return { value: p };
}
function cleanIdentity(b) {
  b = b || {}; const s = (k, n) => String(b[k] == null ? "" : b[k]).trim().slice(0, n);
  const v = { legalName: s("legalName", 80), dateOfBirth: s("dateOfBirth", 10), idType: s("idType", 40), idNumber: s("idNumber", 40), residentialAddress: s("residentialAddress", 250), phone: s("phone", 20), country: s("country", 40), city: s("city", 60) };
  if (v.legalName.length < 3) return { error: "Type your full legal name exactly as printed on your ID." };
  if (!ID_TYPES.includes(v.idType)) return { error: "Choose which ID document you are using." };
  const dob = Date.parse(v.dateOfBirth + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.dateOfBirth) || !Number.isFinite(dob)) return { error: "Enter your date of birth." };
  if ((Date.now() - dob) / (365.25 * DAY) < 18) return { error: "You must be 18 or older to advertise." };
  if (v.residentialAddress.length < 8) return { error: "Enter your residential address." };
  if (!/^\+?[0-9 ]{7,16}$/.test(v.phone)) return { error: "Enter your phone number." };
  return { value: v };
}

module.exports = function makeAdJobs({ app, db, requireAuth, requireAdmin, commerce, linkProblem }) {
  const express = require("express");
  const now = () => Date.now();
  const bad = (res, code, msg, extra) => res.status(code).json({ success: false, message: msg, ...(extra || {}) });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS ad_job_orders (id BIGSERIAL PRIMARY KEY, user_email TEXT NOT NULL, tier TEXT NOT NULL, job TEXT NOT NULL, usd INTEGER NOT NULL, amount_ngn BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_payment', payment_ref TEXT, paid_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ad_job_orders_user ON ad_job_orders(user_email, id DESC)`,
    `CREATE TABLE IF NOT EXISTS ad_job_profiles (order_id BIGINT PRIMARY KEY, owner_name TEXT NOT NULL, business_name TEXT NOT NULL, logo TEXT, description TEXT, phone TEXT, email TEXT, whatsapp TEXT, address TEXT, country TEXT, city TEXT, placements TEXT, social_link TEXT, social TEXT, products TEXT, complete SMALLINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ad_job_media (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, data BYTEA NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ad_job_media_order ON ad_job_media(order_id, kind)`,
    `CREATE TABLE IF NOT EXISTS ad_job_id_files (order_id BIGINT NOT NULL, part TEXT NOT NULL, mime TEXT NOT NULL, enc BYTEA NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (order_id, part))`,
    `CREATE TABLE IF NOT EXISTS ad_job_identity (order_id BIGINT PRIMARY KEY, legal_name TEXT, dob TEXT, id_type TEXT, id_number TEXT, residential_address TEXT, phone TEXT, country TEXT, city TEXT, status TEXT NOT NULL DEFAULT 'pending', reason TEXT, created_at BIGINT NOT NULL, reviewed_at BIGINT)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727200)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727200)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("AD JOBS MIGRATE ERROR:", e); });
  const audit = (orderId, actor, action, detail) => db.run("INSERT INTO ad_audit (campaign_id, actor, action, detail, created_at) VALUES (NULL,?,?,?,?)", [actor, "job_" + action, ("order #" + orderId + " " + (detail || "")).slice(0, 300), now()]).catch(() => {});
  const notify = (email, text, link) => db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [email, String(text).slice(0, 200), link || "ad-sense-home.html", now()]).catch(() => {});
  const ownOrder = async (id, email) => { id = Math.floor(Number(id)); return Number.isFinite(id) && id > 0 ? db.get(`SELECT id, user_email AS email, tier, job, usd, amount_ngn AS "amountNgn", status, paid_at AS "paidAt" FROM ad_job_orders WHERE id = ? AND user_email = ?`, [id, email]) : null; };
  const idRowOf = (orderId) => db.get(`SELECT status, reason FROM ad_job_identity WHERE order_id = ?`, [orderId]);

  // ---- public price list (the tier pages show the same numbers; a test keeps them equal) ----
  app.get("/api/ads/tiers", (req, res) => {
    const r = ngnPerUsd();
    res.json({ success: true, ngnPerUsd: r, tiers: Object.keys(CATALOG.tiers).map((k) => ({ key: k, ...CATALOG.tiers[k], jobs: CATALOG.tiers[k].jobs.map((j) => ({ ...j, ngn: Math.round(j.usd * r) })) })) });
  });
  // ---- step 3a: the official price (server only) ----
  app.get("/api/ads/quote", requireAuth, (req, res) => {
    const q = quoteFor(req.query.level, req.query.category, ngnPerUsd());
    if (!q) return bad(res, 404, "That job is not in the Vico price list. Please choose it again.");
    res.json({ success: true, amount: q.kobo, currency: q.currency, usd: q.usd, ngn: q.ngn, ngnPerUsd: q.rate, package: q.label + " — " + q.job, level: q.label, category: q.job });
  });
  // ---- step 3b: PAY. The order is saved first, then Paystack is asked for the server's amount ----
  commerce.registerPurpose("adjob", async (t, pay) => {
    await t.run("UPDATE ad_job_orders SET status = 'paid', payment_ref = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment'", [pay.reference, now(), now(), pay.refId]);
    return async () => { await audit(pay.refId, pay.payer, "paid", "₦" + Number(pay.amount).toLocaleString()); await notify(pay.payer, "Payment received. Next, add your business information.", "ad-business-information.html"); };
  });
  app.post("/api/ads/paystack/initialize", requireAuth, async (req, res) => {
    try { await ready;
      const q = quoteFor((req.body || {}).level, (req.body || {}).category, ngnPerUsd());
      if (!q) return bad(res, 404, "That job is not in the Vico price list. Please choose it again.");
      const open = await db.get(`SELECT COUNT(*) AS n FROM ad_job_orders WHERE user_email = ? AND status = 'pending_payment' AND created_at > ?`, [req.userEmail, now() - DAY]);
      let order = await db.get("SELECT id FROM ad_job_orders WHERE user_email = ? AND tier = ? AND job = ? AND status = 'pending_payment' AND amount_ngn = ? ORDER BY id DESC LIMIT 1", [req.userEmail, q.tier, q.job, q.ngn]);
      if (!order) {
        if (Number(open.n) >= 10) return bad(res, 429, "You have many unpaid orders. Please pay or wait a day before starting another.");
        order = await db.get("INSERT INTO ad_job_orders (user_email, tier, job, usd, amount_ngn, status, created_at, updated_at) VALUES (?,?,?,?,?, 'pending_payment', ?, ?) RETURNING id", [req.userEmail, q.tier, q.job, q.usd, q.ngn, now(), now()]);
      }
      let p; try { p = await commerce.initPayment({ purpose: "adjob", refId: Number(order.id), email: req.userEmail, amountNgn: q.ngn, req, back: "ad-business-information.html" }); }
      catch (e) { console.error("AD JOB PAYMENT INIT ERROR:", e.response ? JSON.stringify(e.response.data) : e.message); return bad(res, 502, e.code === "no_key" ? "Payments are not switched on yet." : "Could not start the payment. Please try again."); }
      if (!p.url) return bad(res, 502, "Could not start the payment. Please try again.");
      res.json({ success: true, authorization_url: p.url, url: p.url, total: q.ngn });
    } catch (e) { console.error(e); bad(res, 500, "Could not start the payment."); }
  });

  // ---- where is this advertiser? (the pages ask this instead of trusting the browser) ----
  app.get("/api/ads/orders/current", requireAuth, async (req, res) => {
    try { await ready;
      const o = await db.get(`SELECT id, tier, job, usd, amount_ngn AS "amountNgn", status, paid_at AS "paidAt" FROM ad_job_orders WHERE user_email = ? AND status <> 'cancelled' AND status <> 'pending_payment' ORDER BY id DESC LIMIT 1`, [req.userEmail]);
      if (!o) return res.json({ success: true, order: null, stage: "none" });
      const pr = await db.get(`SELECT owner_name AS "ownerName", business_name AS "businessName", description, phone, email, whatsapp, address, country, city, placements, social_link AS "socialLink", social, products, complete, (logo IS NOT NULL AND logo <> '') AS "hasLogo" FROM ad_job_profiles WHERE order_id = ?`, [o.id]);
      const m = await db.all("SELECT kind, COUNT(*) AS n FROM ad_job_media WHERE order_id = ? GROUP BY kind", [o.id]); const cnt = {}; m.forEach((r) => { cnt[r.kind] = Number(r.n); });
      const idr = await idRowOf(o.id), files = await db.all("SELECT part FROM ad_job_id_files WHERE order_id = ?", [o.id]);
      const isOrganisationAdvert = ["big-business", "company", "national"].includes(o.tier);
      let organisation = null, stage = stageOf(o, !!(pr && Number(pr.complete)), idr ? idr.status : "none");
      if (isOrganisationAdvert) {
        const table = await db.get("SELECT to_regclass('public.company_verification_applications') AS name");
        const app = table && table.name ? await db.get("SELECT id,status,admin_note,organisation_type,legal_name FROM company_verification_applications WHERE order_id=?",[o.id]) : null;
        organisation = { required: true, type: o.tier === "national" ? "government" : "company", status: app ? app.status : "not_submitted", applicationId: app ? app.id : null, legalName: app ? app.legal_name : null, note: app ? (app.admin_note || "") : "" };
        if (pr && Number(pr.complete)) {
          if (app && app.status === "verified") stage = "verified";
          else if (app && app.status === "suspended") stage = "suspended";
          else if (app && ["submitted","under_review"].includes(app.status)) stage = "review";
          else stage = "organisation"; // not submitted, rejected, or more documents requested
        }
      }
      const label = CATALOG.tiers[o.tier] ? CATALOG.tiers[o.tier].label : o.tier;
      res.json({ success: true, stage, order: { id: Number(o.id), tier: o.tier, level: label, job: o.job, usd: Number(o.usd), amountNgn: Number(o.amountNgn), status: o.status, paidAt: Number(o.paidAt) },
        profile: pr ? { ...pr, complete: !!Number(pr.complete), placements: pr.placements ? pr.placements.split("|") : [] } : null, media: { products: cnt.product || 0, video: (cnt.video || 0) > 0 },
        identity: { status: idr ? idr.status : "none", reason: (idr && idr.reason) || "", files: files.map((f) => f.part) }, organisation });
    } catch (e) { console.error(e); bad(res, 500, "Could not load your order."); }
  });

  // ---- step 4: BUSINESS INFORMATION (text + logo here; pictures and video are sent next, one file at a time) ----
  app.post("/api/ads/business-profile", requireAuth, async (req, res) => {
    try { await ready;
      const o = await db.get(`SELECT id, status FROM ad_job_orders WHERE user_email = ? AND status <> 'cancelled' AND status <> 'pending_payment' ORDER BY id DESC LIMIT 1`, [req.userEmail]);
      if (!o) return bad(res, 403, "Pay for your advert first. Choose a level and job, then pay.");
      const idr = await idRowOf(o.id); if (idr && (idr.status === "pending" || idr.status === "approved")) return bad(res, 400, "Your identity is already " + (idr.status === "pending" ? "being checked" : "verified") + ", so the business information can no longer be changed.");
      const r = cleanProfile(req.body, linkProblem); if (r.error) return bad(res, 400, r.error);
      const p = r.value, old = await db.get("SELECT logo FROM ad_job_profiles WHERE order_id = ?", [o.id]), logo = p.logo || (old && old.logo) || "";
      if (!logo) return bad(res, 400, "Add your business logo.");
      await db.run(`INSERT INTO ad_job_profiles (order_id, owner_name, business_name, logo, description, phone, email, whatsapp, address, country, city, placements, social_link, social, products, complete, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0, ?, ?)
        ON CONFLICT (order_id) DO UPDATE SET owner_name = EXCLUDED.owner_name, business_name = EXCLUDED.business_name, logo = EXCLUDED.logo, description = EXCLUDED.description, phone = EXCLUDED.phone, email = EXCLUDED.email, whatsapp = EXCLUDED.whatsapp, address = EXCLUDED.address, country = EXCLUDED.country, city = EXCLUDED.city, placements = EXCLUDED.placements, social_link = EXCLUDED.social_link, social = EXCLUDED.social, products = EXCLUDED.products, complete = 0, updated_at = EXCLUDED.updated_at`,
        [o.id, p.ownerName, p.businessName, logo, p.description, p.phone, p.email, p.whatsapp, p.address, p.country, p.city, p.placements.join("|"), p.socialLink, p.social, p.products, now(), now()]);
      res.json({ success: true, orderId: Number(o.id) });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your business information."); }
  });
  const mediaGate = async (req, res, next) => {   // the order must be the caller's own, paid, and its business information saved
    try { await ready; const o = await ownOrder(req.params.id, req.userEmail); if (!o || o.status === "pending_payment" || o.status === "cancelled") return bad(res, 404, "Order not found.");
      const pr = await db.get("SELECT 1 AS x FROM ad_job_profiles WHERE order_id = ?", [o.id]); if (!pr) return bad(res, 400, "Save your business information first.");
      const idr = await idRowOf(o.id); if (idr && (idr.status === "pending" || idr.status === "approved")) return bad(res, 400, "This order can no longer be changed.");
      req.order = o; next();
    } catch (e) { bad(res, 500, "Could not check your order."); }
  };
  const tooBig = (e, res, what) => bad(res, e && e.type === "entity.too.large" ? 413 : 500, e && e.type === "entity.too.large" ? "That " + what + " is too big." : "Could not save it.");
  app.put("/api/ads/orders/:id/media/product", requireAuth, mediaGate, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), async (req, res) => {
    try { const buf = req.body, mime = sniffImage(buf, false); if (!mime) return bad(res, 400, "Product pictures must be JPG, PNG or WebP images.");
      const n = await db.get("SELECT COUNT(*) AS n FROM ad_job_media WHERE order_id = ? AND kind = 'product'", [req.order.id]); if (Number(n.n) >= MAX_PRODUCT_PICS) return bad(res, 400, "You can add " + MAX_PRODUCT_PICS + " product pictures at most.");
      await db.run("UPDATE ad_job_profiles SET complete = 0 WHERE order_id = ?", [req.order.id]);
      const r = await db.get("INSERT INTO ad_job_media (order_id, kind, mime, size, data, created_at) VALUES (?, 'product', ?, ?, ?, ?) RETURNING id", [req.order.id, mime, buf.length, buf, now()]);
      res.json({ success: true, id: Number(r.id), count: Number(n.n) + 1 });
    } catch (e) { console.error(e); tooBig(e, res, "picture"); } });
  app.put("/api/ads/orders/:id/media/video", requireAuth, mediaGate, express.raw({ type: () => true, limit: MAX_VIDEO_BYTES }), async (req, res) => {
    try { const buf = req.body, mime = sniffVideo(buf); if (!mime) return bad(res, 400, "That file is not an MP4, MOV or WebM video.");
      await db.tx(async (t) => { await t.run("DELETE FROM ad_job_media WHERE order_id = ? AND kind = 'video'", [req.order.id]); await t.run("INSERT INTO ad_job_media (order_id, kind, mime, size, data, created_at) VALUES (?, 'video', ?, ?, ?, ?)", [req.order.id, mime, buf.length, buf, now()]); });
      res.json({ success: true });
    } catch (e) { console.error(e); tooBig(e, res, "video (30 MB at most)"); } });
  app.post("/api/ads/orders/:id/media/product/clear", requireAuth, mediaGate, async (req, res) => {   // start the product pictures again
    try { await db.run("DELETE FROM ad_job_media WHERE order_id = ? AND kind = 'product'", [req.order.id]); await db.run("UPDATE ad_job_profiles SET complete = 0 WHERE order_id = ?", [req.order.id]); res.json({ success: true }); } catch (e) { bad(res, 500, "Could not clear the pictures."); } });
  app.post("/api/ads/orders/:id/profile/complete", requireAuth, mediaGate, async (req, res) => {
    try { const n = await db.all("SELECT kind, COUNT(*) AS n FROM ad_job_media WHERE order_id = ? GROUP BY kind", [req.order.id]); const c = {}; n.forEach((r) => { c[r.kind] = Number(r.n); });
      if (!c.product) return bad(res, 400, "Add at least one product picture (take a picture or upload one).");
      if (!c.video) return bad(res, 400, "Add your business promotional video (make a video or upload one).");
      await db.run("UPDATE ad_job_profiles SET complete = 1, updated_at = ? WHERE order_id = ?", [now(), req.order.id]);
      await db.run("UPDATE ad_job_orders SET status = 'profile_saved', updated_at = ? WHERE id = ? AND status = 'paid'", [now(), req.order.id]);
      await audit(req.order.id, req.userEmail, "profile_saved", "");
      const nextUrl = ["big-business","company","national"].includes(req.order.tier) ? "ad-organisation-verification.html" : "ad-identity-verification.html";
      res.json({ success: true, next_url: nextUrl });
    } catch (e) { console.error(e); bad(res, 500, "Could not finish saving."); } });

  // ---- step 5: IDENTITY. Photos are encrypted the moment they arrive; the details must equal the business information ----
  const idGate = async (req, res, next) => {
    try { await ready;
      const o = req.params.id ? await ownOrder(req.params.id, req.userEmail) : await db.get(`SELECT id, tier, status FROM ad_job_orders WHERE user_email = ? AND status <> 'cancelled' AND status <> 'pending_payment' ORDER BY id DESC LIMIT 1`, [req.userEmail]);
      if (!o) return bad(res, 404, "Order not found.");
      if (["big-business","company","national"].includes(o.tier)) return bad(res, 403, "This advert requires company or national organisation verification, not personal ID verification.", { next_url: "ad-organisation-verification.html" });
      if (!idKey()) return bad(res, 503, "Identity checks are not switched on yet. Please try again soon.");
      const pr = await db.get(`SELECT owner_name AS "ownerName", phone, country, city, complete FROM ad_job_profiles WHERE order_id = ?`, [o.id]);
      if (!pr || !Number(pr.complete)) return bad(res, 400, "Finish your business information first.", { next_url: "ad-business-information.html" });
      const idr = await idRowOf(o.id); if (idr && idr.status === "approved") return bad(res, 400, "Your identity is already verified."); if (idr && idr.status === "pending") return bad(res, 400, "Your documents are already being checked.");
      req.order = o; req.profile = pr; next();
    } catch (e) { bad(res, 500, "Could not check your order."); }
  };
  app.put("/api/ads/orders/:id/identity/:part", requireAuth, (req, res, next) => ["front", "back", "selfie"].includes(req.params.part) ? next() : bad(res, 400, "Unknown document part."), idGate, express.raw({ type: () => true, limit: MAX_ID_BYTES }), async (req, res) => {
    try { const part = req.params.part, mime = sniffImage(req.body, part === "front"); if (!mime) return bad(res, 400, "Please use a JPG, PNG or WebP photo" + (part === "front" ? " (or a PDF)." : "."));
      const e = encryptBuf(idKey(), req.body);
      await db.run(`INSERT INTO ad_job_id_files (order_id, part, mime, enc, iv, tag, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (order_id, part) DO UPDATE SET mime = EXCLUDED.mime, enc = EXCLUDED.enc, iv = EXCLUDED.iv, tag = EXCLUDED.tag, created_at = EXCLUDED.created_at`, [req.order.id, part, mime, e.enc, e.iv, e.tag, now()]);
      res.json({ success: true });
    } catch (e) { console.error(e); tooBig(e, res, "photo"); } });
  app.post("/api/ads/identity-verification", requireAuth, idGate, async (req, res) => {
    try { const r = cleanIdentity(req.body); if (r.error) return bad(res, 400, r.error);
      const files = (await db.all("SELECT part FROM ad_job_id_files WHERE order_id = ?", [req.order.id])).map((f) => f.part);
      if (!files.includes("front")) return bad(res, 400, "Take or upload the front of your ID."); if (!files.includes("selfie")) return bad(res, 400, "Take or upload your selfie.");
      const cmp = compareIdentity(req.profile, r.value);
      if (!cmp.ok) { await audit(req.order.id, req.userEmail, "identity_mismatch", cmp.mismatches.join(",")); return bad(res, 422, "These details must match the business information you saved exactly. Please correct: " + cmp.mismatches.join(", ") + ".", { mismatches: cmp.mismatches }); }
      const v = r.value, key = idKey(), num = v.idNumber ? encryptBuf(key, Buffer.from(v.idNumber, "utf8")) : null;
      await db.run(`INSERT INTO ad_job_identity (order_id, legal_name, dob, id_type, id_number, residential_address, phone, country, city, status, reason, created_at, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?, 'pending', NULL, ?, NULL)
        ON CONFLICT (order_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, dob = EXCLUDED.dob, id_type = EXCLUDED.id_type, id_number = EXCLUDED.id_number, residential_address = EXCLUDED.residential_address, phone = EXCLUDED.phone, country = EXCLUDED.country, city = EXCLUDED.city, status = 'pending', reason = NULL, created_at = EXCLUDED.created_at, reviewed_at = NULL`,
        [req.order.id, v.legalName, v.dateOfBirth, v.idType, num ? JSON.stringify({ e: num.enc.toString("base64"), i: num.iv, t: num.tag }) : null, v.residentialAddress, v.phone, v.country, v.city, now()]);
      await db.run("UPDATE ad_job_orders SET status = 'id_pending', updated_at = ? WHERE id = ?", [now(), req.order.id]);
      await audit(req.order.id, req.userEmail, "identity_submitted", v.idType);
      require("./id-approval").notifyIdSubmitted({ who: v.legalName + " (" + req.userEmail + ")", docLabel: v.idType, source: "Ad level order #" + req.order.id });
      res.json({ success: true, status: "pending", message: "Documents submitted. Your verification is pending review. The Vico team usually replies within 24 hours, but this is a target, not a promise." });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your documents."); } });

  // ---- admin (x-admin-key, same as the rest of /admin): compare the documents with what the advertiser typed, then decide ----
  app.get("/api/admin/ad-jobs", requireAdmin, async (req, res) => {
    try { await ready; const st = ["id_pending", "profile_saved", "paid", "verified", "id_rejected", "all"].includes(req.query.status) ? req.query.status : "id_pending", where = st === "all" ? "WHERE o.status <> 'pending_payment'" : "WHERE o.status = ?";
      const rows = await db.all(`SELECT o.id, o.user_email AS email, o.tier, o.job, o.usd, o.amount_ngn AS "amountNgn", o.status, o.paid_at AS "paidAt", p.owner_name AS "ownerName", p.business_name AS "businessName", p.description, p.phone, p.email AS "bizEmail", p.whatsapp, p.address, p.country, p.city, p.placements, p.social_link AS "socialLink", p.social, p.products, p.complete,
          i.legal_name AS "legalName", i.dob, i.id_type AS "idType", i.residential_address AS "residentialAddress", i.phone AS "idPhone", i.country AS "idCountry", i.city AS "idCity", i.status AS "idStatus", i.reason, i.created_at AS "idAt"
        FROM ad_job_orders o LEFT JOIN ad_job_profiles p ON p.order_id = o.id LEFT JOIN ad_job_identity i ON i.order_id = o.id ${where} ORDER BY o.id DESC LIMIT 100`, st === "all" ? [] : [st]);
      const out = []; for (const r of rows) {
        const media = await db.all("SELECT id, kind, mime, size FROM ad_job_media WHERE order_id = ? ORDER BY id", [r.id]), files = await db.all("SELECT part FROM ad_job_id_files WHERE order_id = ?", [r.id]);
        const cmp = r.legalName ? compareIdentity({ ownerName: r.ownerName, phone: r.phone, country: r.country, city: r.city }, { legalName: r.legalName, phone: r.idPhone, country: r.idCountry, city: r.idCity }) : null;
        out.push({ ...r, id: Number(r.id), amountNgn: Number(r.amountNgn), paidAt: r.paidAt ? Number(r.paidAt) : null, idAt: r.idAt ? Number(r.idAt) : null, level: CATALOG.tiers[r.tier] ? CATALOG.tiers[r.tier].label : r.tier, placements: r.placements ? r.placements.split("|") : [], match: cmp, idFiles: files.map((f) => f.part), media: media.map((m) => ({ id: Number(m.id), kind: m.kind, mime: m.mime, size: Number(m.size) })) }); }
      res.json({ success: true, orders: out });
    } catch (e) { console.error(e); bad(res, 500, "Could not load the orders."); } });
  app.get("/api/admin/ad-jobs/:id/logo", requireAdmin, async (req, res) => {
    try { await ready; const r = await db.get("SELECT logo FROM ad_job_profiles WHERE order_id = ?", [Math.floor(Number(req.params.id))]); const m = r && r.logo && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.logo); if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64")); } catch (e) { res.sendStatus(500); } });
  app.get("/api/admin/ad-jobs/:id/media/:mid", requireAdmin, async (req, res) => {
    try { await ready; const r = await db.get("SELECT mime, data FROM ad_job_media WHERE id = ? AND order_id = ?", [Math.floor(Number(req.params.mid)), Math.floor(Number(req.params.id))]); if (!r) return res.sendStatus(404);
      res.set({ "Content-Type": r.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" }).send(r.data); } catch (e) { res.sendStatus(500); } });
  app.get("/api/admin/ad-jobs/:id/id/:part", requireAdmin, async (req, res) => {
    try { await ready; const key = idKey(); if (!key) return res.sendStatus(503); const id = Math.floor(Number(req.params.id));
      const r = ["front", "back", "selfie"].includes(req.params.part) && await db.get("SELECT mime, enc, iv, tag FROM ad_job_id_files WHERE order_id = ? AND part = ?", [id, req.params.part]); if (!r) return res.sendStatus(404);
      await audit(id, "admin", "identity_viewed", req.params.part);                                  // every look at an ID is logged
      res.set({ "Content-Type": r.mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(decryptBuf(key, r)); } catch (e) { res.sendStatus(500); } });
  app.post("/api/admin/ad-jobs/:id/decision", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), d = String((req.body && req.body.decision) || ""), reason = String((req.body && req.body.reason) || "").trim().slice(0, 300);
      if (!["approve", "reject"].includes(d)) return bad(res, 400, "Choose approve or reject."); if (d === "reject" && reason.length < 5) return bad(res, 400, "Write the reason (the advertiser will read it).");
      const o = Number.isFinite(id) && await db.get("SELECT user_email AS email, status FROM ad_job_orders WHERE id = ?", [id]); const idr = o && await idRowOf(id);
      if (!o || !idr || idr.status !== "pending") return bad(res, 400, "There are no pending documents for this order.");
      await db.tx(async (t) => {
        await t.run("UPDATE ad_job_identity SET status = ?, reason = ?, reviewed_at = ?, id_number = NULL WHERE order_id = ?", [d === "approve" ? "approved" : "rejected", d === "reject" ? reason : null, now(), id]);
        await t.run("DELETE FROM ad_job_id_files WHERE order_id = ?", [id]);                                // the photos are deleted as soon as a decision is made
        await t.run("UPDATE ad_job_orders SET status = ?, updated_at = ? WHERE id = ?", [d === "approve" ? "verified" : "id_rejected", now(), id]); });
      await audit(id, "admin", "identity_" + d, reason);
      await notify(o.email, d === "approve" ? "Your identity is verified. The Vico team will now prepare your advert." : "Your identity could not be verified: " + reason, "ad-identity-verification.html");
      res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not save the decision."); } });
  return { ready };
};
Object.assign(module.exports, { findJob, quoteFor, normText, normPhone, compareIdentity, stageOf, sniffImage, sniffVideo, cleanProfile, cleanIdentity, encryptBuf, decryptBuf, CATALOG, ID_TYPES, PLACEMENT_CHOICES });
