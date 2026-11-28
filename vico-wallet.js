// =====================================================
// VicoPay Wallet: ONE central naira balance for paid messaging, voice calls, video calls and later paid services.
// =====================================================
// Separate from coins and Golden Stars (those stay exactly as they are for gifts). This wallet is whole naira.
//  * Recharge: Paystack payment of 100 / 200 / 500 / 1,000 / 1,500 / 2,000 / 4,000 / 5,000 / 10,000 naira. Credited ONCE per Paystack reference,
//    by the verify call from wallet.html and/or the Paystack webhook (whichever arrives first; the other is a harmless no-op).
//  * Charge: charge() takes naira off the balance in a single statement that can never go below zero, and writes one ledger line.
//    Stage 2 (vico-messages.js / vico-message-calls.js) calls charge() for chat messages and call minutes.
// New tables only: vp_wallets, vp_wallet_entries.
const { maxFeeFor } = require("./payments");

const TYPE = "vico_wallet_recharge";
const AMOUNTS = [100, 200, 500, 1000, 1500, 2000, 4000, 5000, 10000];
const RATES = { firstMessage: 3, message: 1, callMinute: 1 };   // naira; edit here to change prices

module.exports = function makeWallet({ app, db, requireAuth, axios, siteUrlOf, env, walletSecurity }) {
  env = env || process.env;
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const bad = (res, code, message, extra) => res.status(code).json({ success: false, message, ...(extra || {}) });

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS vp_wallets (email TEXT PRIMARY KEY, balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0), updated_at BIGINT NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS vp_wallet_entries (id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, delta BIGINT NOT NULL, balance_after BIGINT NOT NULL, kind TEXT NOT NULL, ref TEXT, memo TEXT, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_vp_wallet_entries_email ON vp_wallet_entries(email, id DESC)`,
    // one ledger line per (kind, ref): this is what makes a recharge or a charge impossible to apply twice
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_vp_wallet_entries_ref ON vp_wallet_entries(kind, ref) WHERE ref IS NOT NULL`
  ];
  const ready = (async () => {
    const c = await db.pool.connect();
    try { await c.query("SELECT pg_advisory_lock(727292)"); for (const q of SCHEMA) await c.query(q); }
    finally { try { await c.query("SELECT pg_advisory_unlock(727292)"); } catch (_) { /* ignore */ } c.release(); }
  })().catch((e) => { console.error("VICO WALLET MIGRATE ERROR:", e); });

  async function balanceOf(email) {
    await ready;
    const r = await db.get("SELECT balance FROM vp_wallets WHERE email = ?", [lc(email)]);
    return r ? Number(r.balance) : 0;
  }

  // Add naira. ref makes it idempotent: the same (kind, ref) is applied once. Returns { ok, applied, balance }.
  async function credit({ email, amount, kind, ref, memo }) {
    await ready;
    email = lc(email); amount = Math.floor(Number(amount));
    if (!email || !(amount > 0)) return { ok: false, message: "Invalid amount." };
    return db.tx(async (t) => {
      if (ref) {
        await t.lock("vpw:" + kind + ":" + ref);
        const seen = await t.get("SELECT id FROM vp_wallet_entries WHERE kind = ? AND ref = ?", [kind, String(ref)]);
        if (seen) { const b = await t.get("SELECT balance FROM vp_wallets WHERE email = ?", [email]); return { ok: true, applied: false, balance: b ? Number(b.balance) : 0 }; }
      }
      const at = now();
      const w = await t.get("INSERT INTO vp_wallets(email, balance, updated_at) VALUES(?,?,?) ON CONFLICT (email) DO UPDATE SET balance = vp_wallets.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at RETURNING balance", [email, amount, at]);
      await t.run("INSERT INTO vp_wallet_entries(email, delta, balance_after, kind, ref, memo, created_at) VALUES(?,?,?,?,?,?,?)", [email, amount, Number(w.balance), kind, ref ? String(ref) : null, memo || null, at]);
      return { ok: true, applied: true, balance: Number(w.balance) };
    });
  }

  // Take naira off the balance. One UPDATE with "balance >= amount": two messages sent at the same instant can never overspend.
  // Returns { ok:true, balance } or { ok:false, insufficient:true, balance }. Pass t (a db.tx handle) to make the charge part of a larger transaction.
  async function charge({ email, amount, kind, ref, memo }, t) {
    await ready;
    email = lc(email); amount = Math.floor(Number(amount));
    if (!email || !(amount > 0)) return { ok: false, message: "Invalid amount." };
    const run = async (x) => {
      if (ref) { const seen = await x.get("SELECT balance_after FROM vp_wallet_entries WHERE kind = ? AND ref = ?", [kind, String(ref)]); if (seen) return { ok: true, applied: false, balance: Number(seen.balance_after) }; }
      const at = now();
      const w = await x.get("UPDATE vp_wallets SET balance = balance - ?, updated_at = ? WHERE email = ? AND balance >= ? RETURNING balance", [amount, at, email, amount]);
      if (!w) { const b = await x.get("SELECT balance FROM vp_wallets WHERE email = ?", [email]); return { ok: false, insufficient: true, balance: b ? Number(b.balance) : 0 }; }
      await x.run("INSERT INTO vp_wallet_entries(email, delta, balance_after, kind, ref, memo, created_at) VALUES(?,?,?,?,?,?,?)", [email, -amount, Number(w.balance), kind, ref ? String(ref) : null, memo || null, at]);
      return { ok: true, applied: true, balance: Number(w.balance) };
    };
    return t ? run(t) : db.tx(run);
  }

  // ---------- Paystack recharge ----------
  const isWalletPayment = (payment) => !!(payment && payment.metadata && payment.metadata.type === TYPE);

  // Always re-checks the payment with Paystack itself, then credits the amount chosen on OUR server. Safe to call many times.
  async function finalize(reference) {
    const key = env.PAYSTACK_SECRET_KEY;
    if (!key) return { ok: false, message: "Payments are not switched on yet." };
    let payment;
    try {
      const r = await axios.get("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + key } });
      if (!r.data || !r.data.status) return { ok: false, message: "Payment could not be checked." };
      payment = r.data.data;
    } catch (e) { return { ok: false, pending: true, message: "Could not reach Paystack. Try again in a moment." }; }
    if (!payment || payment.status !== "success") return { ok: false, pending: true, message: "This payment has not completed." };
    if (!isWalletPayment(payment)) return { ok: false, message: "This is not a wallet recharge." };
    if (String(payment.currency || "NGN").toUpperCase() !== "NGN") return { ok: false, message: "Wallet recharge is in naira only." };
    const amount = Number(payment.metadata.amount), paid = Number(payment.amount) / 100;
    const email = lc(payment.metadata.userEmail);
    if (!AMOUNTS.includes(amount) || !email) return { ok: false, message: "Unknown recharge amount." };
    // the customer may be charged Paystack's fee on top; they must have paid at least the amount and only a believable fee extra
    if (!(paid >= amount) || paid - amount > maxFeeFor(amount)) return { ok: false, message: "The amount paid does not match the recharge. Contact support with reference " + reference + "." };
    const r = await credit({ email, amount, kind: "recharge", ref: payment.reference || reference, memo: "Recharge by card" });
    return { ok: r.ok, applied: r.applied, balance: r.balance, amount, message: r.message };
  }

  // ---------- routes ----------
  // The wallet page's own data (history, recharge) is behind the Wallet PIN + email code ("wallet" unlock, see wallet-security.js).
  // The balance number stays open because the chat header shows it, and the Paystack return check stays open because the person has already paid.
  const open = walletSecurity && walletSecurity.unlock ? walletSecurity.unlock("wallet") : (req, res, next) => next();
  app.get("/api/wallet/balance", requireAuth, async (req, res) => {
    try { res.json({ success: true, balance: await balanceOf(req.userEmail), amounts: AMOUNTS, rates: RATES }); }
    catch (e) { console.error("WALLET BALANCE:", e); bad(res, 500, "Could not load your wallet."); }
  });

  app.get("/api/wallet/history", requireAuth, open, async (req, res) => {
    try {
      await ready;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
      const rows = await db.all("SELECT id, delta, balance_after, kind, memo, created_at FROM vp_wallet_entries WHERE email = ? ORDER BY id DESC LIMIT " + limit, [lc(req.userEmail)]);
      res.json({ success: true, entries: rows.map((r) => ({ id: Number(r.id), delta: Number(r.delta), balance: Number(r.balance_after), kind: r.kind, memo: r.memo, at: Number(r.created_at) })) });
    } catch (e) { console.error("WALLET HISTORY:", e); bad(res, 500, "Could not load your history."); }
  });

  // Recharging only ADDS money, so it opens without the PIN: a low-balance person must be able to reach Paystack in one tap. History stays behind the PIN.
  app.post("/api/wallet/recharge/initialize", requireAuth, async (req, res) => {
    try {
      const amount = Number(req.body && req.body.amount);
      if (!AMOUNTS.includes(amount)) return bad(res, 400, "Choose one of the recharge amounts.");
      if (!env.PAYSTACK_SECRET_KEY) return bad(res, 503, "Payments are not switched on yet.");
      const email = lc(req.userEmail);
      const r = await axios.post("https://api.paystack.co/transaction/initialize", {
        email, amount: amount * 100, currency: "NGN",
        metadata: { website: "Victopay", type: TYPE, amount, userEmail: email },
        callback_url: siteUrlOf(req) + "/wallet.html"
      }, { headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY, "Content-Type": "application/json" } });
      if (!r.data || !r.data.status) return bad(res, 400, (r.data && r.data.message) || "Could not start the payment.");
      res.json({ success: true, authorization_url: r.data.data.authorization_url, reference: r.data.data.reference, amount });
    } catch (e) { console.error("WALLET INIT:", (e.response && e.response.data) || e.message); bad(res, 500, "Could not start the payment."); }
  });

  // wallet.html calls this when Paystack sends the person back (?reference=...)
  app.post("/api/wallet/recharge/verify", requireAuth, async (req, res) => {
    try {
      const reference = String((req.body && req.body.reference) || "").trim();
      if (!reference) return bad(res, 400, "Payment reference is missing.");
      const r = await finalize(reference);
      if (!r.ok) return bad(res, r.pending ? 202 : 400, r.message, { pending: !!r.pending });
      // the credit goes to the account named in the payment; make sure it is the signed-in one
      const mine = await balanceOf(req.userEmail);
      res.json({ success: true, alreadyProcessed: !r.applied, amount: r.amount, balance: mine });
    } catch (e) { console.error("WALLET VERIFY:", e); bad(res, 500, "Could not confirm the payment."); }
  });

  return { ready, balanceOf, credit, charge, finalize, isWalletPayment, AMOUNTS, RATES };
};
module.exports.AMOUNTS = AMOUNTS; module.exports.RATES = RATES; module.exports.TYPE = TYPE;
