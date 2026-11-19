// =====================================================
// VicoPay Forex Academy — paid membership (Paystack) + members-only content
//   Public:   GET  /api/forex/plans, /api/forex/status, /api/forex/preview, /api/forex/glossary
//   Signed in: POST /api/forex/checkout        -> starts a Paystack payment ($9.99 or the Naira price)
//              GET  /api/forex/verify          -> confirms the payment and unlocks the Academy
//   Members:  GET  /api/forex/academy          -> all lessons
//             GET/POST /api/forex/state        -> saved lesson progress, practice-trading account, journal
//   Admin:    POST /api/admin/forex/grant      -> give someone access (x-admin-key header)
// A Paystack payment only counts as a membership when OUR server started it (metadata.type = "forex_membership"),
// so it can never be mixed up with a coin purchase, and a reference can only unlock access once.
// =====================================================
const { LESSONS, GLOSSARY, VIDEOS } = require("./forex-content");

module.exports = function (ctx) {
  const { app, db, axios, getAuthEmail, requireAuth, requireAdmin } = ctx;
  const lc = (v) => String(v || "").toLowerCase();
  const DAY = 86400000;

  // ---------- price & access length (change with environment variables on Render) ----------
  const PRICE_USD = Number(process.env.FOREX_PRICE_USD || 9.99);
  const NGN_PER_USD = Number(process.env.NGN_PER_USD || 1500);
  const PRICE_NGN = Number(process.env.FOREX_PRICE_NGN) || Math.ceil((PRICE_USD * NGN_PER_USD) / 100) * 100;
  // days of access per payment. 0 = lifetime access.
  const DAYS = process.env.FOREX_ACCESS_DAYS !== undefined && process.env.FOREX_ACCESS_DAYS !== "" ? Number(process.env.FOREX_ACCESS_DAYS) : 30;
  const minorFor = (cur) => (cur === "USD" ? Math.round(PRICE_USD * 100) : Math.round(PRICE_NGN * 100));

  const ok = (res, extra) => res.json({ success: true, ...extra });
  const fail = (res, code, message) => res.status(code).json({ success: false, message });

  // ---------- membership ----------
  async function memberRow(email) {
    return db.get("SELECT email, expires_at, lifetime FROM forex_members WHERE email = ?", [lc(email)]);
  }
  function describe(row) {
    if (!row) return { member: false };
    if (Number(row.lifetime) === 1) return { member: true, lifetime: true, expiresAt: null, daysLeft: null };
    const left = Number(row.expires_at) - Date.now();
    if (left <= 0) return { member: false, expired: true };
    return { member: true, lifetime: false, expiresAt: Number(row.expires_at), daysLeft: Math.ceil(left / DAY) };
  }
  async function isMember(email) { return describe(await memberRow(email)).member === true; }

  async function requireMember(req, res, next) {
    await requireAuth(req, res, async () => {
      try {
        if (!(await isMember(req.userEmail))) return fail(res, 403, "This is for Forex Academy members. Join to unlock it.");
        next();
      } catch (e) { console.error("forex member check:", e.message); fail(res, 500, "Could not check your membership."); }
    });
  }

  // Add access time (used by payments and by the admin grant). Safe to call inside or outside a transaction.
  async function extend(t, email, days, lifetime) {
    email = lc(email);
    const now = Date.now();
    const cur = await t.get("SELECT expires_at, lifetime FROM forex_members WHERE email = ?", [email]);
    const isLife = lifetime || Number(days) === 0 || (cur && Number(cur.lifetime) === 1);
    const base = cur ? Math.max(now, Number(cur.expires_at)) : now;
    const expires = isLife ? 0 : base + Number(days) * DAY;
    await t.run(
      "INSERT INTO forex_members (email, expires_at, lifetime, updated_at) VALUES (?,?,?,?) " +
      "ON CONFLICT (email) DO UPDATE SET expires_at = EXCLUDED.expires_at, lifetime = EXCLUDED.lifetime, updated_at = EXCLUDED.updated_at",
      [email, expires, isLife ? 1 : 0, now]);
    return { expiresAt: isLife ? null : expires, lifetime: isLife };
  }

  // Is this Paystack payment one of OUR membership payments, and was enough paid?
  function isForexPayment(payment) {
    const meta = payment && payment.metadata;
    return !!(meta && typeof meta === "object" && meta.type === "forex_membership");
  }
  function checkPayment(payment) {
    if (!payment || payment.status !== "success") return { ok: false, message: "Payment was not successful." };
    if (!isForexPayment(payment)) return { ok: false, message: "This payment is not a Forex Academy membership." };
    const cur = String(payment.currency || "").toUpperCase();
    if (cur !== "USD" && cur !== "NGN") return { ok: false, message: "Unsupported payment currency." };
    const paid = Number(payment.amount);
    // Paystack may add its own fee on top, so paying MORE is fine. Paying LESS never unlocks access.
    if (!(paid >= minorFor(cur))) return { ok: false, message: "The amount paid is lower than the membership price." };
    const email = lc(payment.customer && payment.customer.email);
    if (!email) return { ok: false, message: "Paystack did not return the customer's email." };
    return { ok: true, email, currency: cur, paid };
  }

  // Called by the payment page, the verify route and the Paystack webhook. Safe to call many times for one payment.
  async function activateFromPayment(payment) {
    const c = checkPayment(payment);
    if (!c.ok) return c;
    const reference = String(payment.reference || "");
    if (!reference) return { ok: false, message: "Payment reference is missing." };
    const before = describe(await memberRow(c.email));   // so we can tell "joined" from "added more time"
    const result = await db.tx(async (t) => {
      const ins = await t.get(
        "INSERT INTO forex_payments (reference, email, currency, amount_minor, days, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT (reference) DO NOTHING RETURNING reference",
        [reference, c.email, c.currency, c.paid, DAYS, Date.now()]);
      if (!ins) return { first: false };
      const e = await extend(t, c.email, DAYS, DAYS === 0);
      return { first: true, ...e };
    });
    const row = await memberRow(c.email);
    return { ok: true, email: c.email, activated: result.first, wasMember: !!before.member, daysBefore: before.daysLeft, addedDays: DAYS, ...describe(row) };
  }

  // ---------- public ----------
  app.get("/api/forex/plans", (req, res) => {
    ok(res, { usd: PRICE_USD, ngn: PRICE_NGN, days: DAYS, lifetime: DAYS === 0, lessons: LESSONS.length });
  });

  // Never answers 401: the forex page is public, and this tells it what to show.
  app.get("/api/forex/status", async (req, res) => {
    try {
      const email = getAuthEmail(req);
      if (!email) return ok(res, { signedIn: false, member: false });
      ok(res, { signedIn: true, ...describe(await memberRow(email)) });
    } catch (e) { console.error("forex status:", e.message); fail(res, 500, "Could not check membership."); }
  });

  const lessonOut = (l) => ({ id: l.id, module: l.module, title: l.title, minutes: l.minutes, blocks: l.blocks, takeaway: l.takeaway, quiz: l.quiz, video: VIDEOS[l.id] || null });
  app.get("/api/forex/preview", (req, res) => {
    ok(res, {
      lesson: lessonOut(LESSONS[0]),
      outline: LESSONS.map((l) => ({ id: l.id, module: l.module, title: l.title, minutes: l.minutes }))
    });
  });
  app.get("/api/forex/glossary", (req, res) => ok(res, { terms: GLOSSARY }));

  // ---------- pay ----------
  app.post("/api/forex/checkout", requireAuth, async (req, res) => {
    try {
      const currency = String((req.body && req.body.currency) || "NGN").toUpperCase();
      if (currency !== "USD" && currency !== "NGN") return fail(res, 400, "Choose USD or NGN.");
      const key = process.env.PAYSTACK_SECRET_KEY;
      if (!key) return fail(res, 500, "Payments are not set up yet (PAYSTACK_SECRET_KEY is missing).");

      const body = {
        email: req.userEmail,
        amount: minorFor(currency),
        currency,
        metadata: { type: "forex_membership", website: "Victopay", plan: DAYS === 0 ? "lifetime" : DAYS + "-days", currency },
        callback_url: `${process.env.APP_URL || "http://localhost:3000"}/forex.html?paid=1`
      };
      let r;
      try {
        r = await axios.post("https://api.paystack.co/transaction/initialize", body, {
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
        });
      } catch (e) {
        const msg = (e.response && e.response.data && e.response.data.message) || e.message;
        console.error("Forex checkout error:", msg);
        if (currency === "USD") return fail(res, 400, "Dollar payments are not available on this account right now. Please switch to Naira and try again.");
        return fail(res, 400, msg || "Could not start the payment.");
      }
      if (!r.data || !r.data.status) return fail(res, 400, (r.data && r.data.message) || "Could not start the payment.");
      ok(res, { authorization_url: r.data.data.authorization_url, reference: r.data.data.reference, currency, amount: currency === "USD" ? PRICE_USD : PRICE_NGN });
    } catch (e) { console.error("forex checkout:", e.message); fail(res, 500, "Could not start the payment."); }
  });

  app.get("/api/forex/verify", async (req, res) => {
    try {
      const reference = String(req.query.reference || req.query.trxref || "");
      if (!reference) return fail(res, 400, "Payment reference is missing.");
      const key = process.env.PAYSTACK_SECRET_KEY;
      if (!key) return fail(res, 500, "PAYSTACK_SECRET_KEY is not configured on the server.");
      let r;
      try {
        r = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${key}` } });
      } catch (e) { return fail(res, 400, "We could not confirm this payment with Paystack yet. Wait a moment and refresh."); }
      const payment = r.data && r.data.data;
      if (!r.data || !r.data.status || !payment) return fail(res, 400, "Payment could not be verified.");
      const out = await activateFromPayment(payment);
      if (!out.ok) return fail(res, 400, out.message);
      let message = "This payment was already applied.";
      if (out.activated && out.wasMember && !out.lifetime) message = out.addedDays + " more days were added to your remaining " + out.daysBefore + " days. You now have " + out.daysLeft + " days left.";
      else if (out.activated) message = "Welcome to the Forex Academy! Your access is now active.";
      ok(res, { message, member: out.member, lifetime: !!out.lifetime, daysLeft: out.daysLeft, expiresAt: out.expiresAt, added: !!(out.activated && out.wasMember) });
    } catch (e) { console.error("forex verify:", e.message); fail(res, 500, "Could not verify the payment."); }
  });

  // ---------- members only ----------
  app.get("/api/forex/academy", requireMember, (req, res) => ok(res, { lessons: LESSONS.map(lessonOut) }));

  app.get("/api/forex/state", requireMember, async (req, res) => {
    try {
      const row = await db.get("SELECT progress, paper, journal FROM forex_state WHERE email = ?", [req.userEmail]);
      const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
      ok(res, { progress: parse(row && row.progress), paper: parse(row && row.paper), journal: parse(row && row.journal) });
    } catch (e) { console.error("forex state get:", e.message); fail(res, 500, "Could not load your saved data."); }
  });

  app.post("/api/forex/state", requireMember, async (req, res) => {
    try {
      const b = req.body || {};
      const cols = {};
      for (const k of ["progress", "paper", "journal"]) {
        if (b[k] === undefined) continue;
        const s = JSON.stringify(b[k]);
        if (s.length > 150000) return fail(res, 413, "That is too much data to save.");
        cols[k] = s;
      }
      const keys = Object.keys(cols);
      if (!keys.length) return ok(res, {});
      const now = Date.now();
      const all = ["progress", "paper", "journal"];
      // only the parts that were sent are replaced; the rest stay as they were
      await db.run(
        "INSERT INTO forex_state (email, progress, paper, journal, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (email) DO UPDATE SET " +
        keys.map((k) => `${k} = EXCLUDED.${k}`).join(", ") + ", updated_at = EXCLUDED.updated_at",
        [req.userEmail, ...all.map((k) => (cols[k] !== undefined ? cols[k] : null)), now]);
      ok(res, {});
    } catch (e) { console.error("forex state save:", e.message); fail(res, 500, "Could not save."); }
  });

  // ---------- admin ----------
  app.post("/api/admin/forex/grant", requireAdmin, async (req, res) => {
    try {
      const email = lc(req.body && req.body.email);
      const days = Number(req.body && req.body.days);
      if (!email || !(days >= 0)) return fail(res, 400, "Send { email, days } (days 0 = lifetime).");
      const e = await db.tx((t) => extend(t, email, days, days === 0));
      ok(res, { email, ...e });
    } catch (e) { console.error("forex grant:", e.message); fail(res, 500, "Could not grant access."); }
  });

  return { activateFromPayment, isForexPayment, isMember, checkPayment, _minorFor: minorFor };
};
