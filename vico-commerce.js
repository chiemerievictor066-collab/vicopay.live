// =====================================================
// Vico Pay Live — COMMERCE: Paystack payments for ads and marketplace orders, product-seller wallet, withdrawals
// =====================================================
// Rules this file follows:
//  * Money is only ever counted after the SERVER asks Paystack "was this paid?" (never from the browser, never from the redirect).
//  * A payment is finalised exactly once (status pending -> paid inside a database transaction), so the return page and the
//    webhook can both arrive in any order without paying twice.
//  * Marketplace money is held: a sale goes to the seller's wallet as PENDING, becomes AVAILABLE when the buyer confirms delivery
//    or after the release period (default 7 days), unless the buyer reports a problem (then an admin decides).
//  * Vico does not ship anything. Buyer and seller deal directly (the buyer's address or phone is given to the seller).
//  * Withdrawals are requests; an admin pays them and marks them paid (no automatic bank transfer yet).
// New tables only: commerce_payments, market_orders, seller_wallet_entries, seller_withdrawals, commerce_settings.
// =====================================================
const crypto = require("crypto");
const DAY = 86400000;

// ---- pure rules (tested) ----
// Paystack counts kobo. Accept only a real Naira payment that covers what we asked for.
function amountOk(paidKobo, expectedNgn, currency) { return String(currency || "NGN").toUpperCase() === "NGN" && Number(paidKobo) >= Math.round(Number(expectedNgn) * 100) && Number(expectedNgn) > 0; }
function splitSale(grossNgn, commissionPercent) { const gross = Math.round(grossNgn), commission = Math.round(gross * (Number(commissionPercent) || 0) / 100); return { gross, commission, net: gross - commission }; }
function walletTotals(entries, withdrawals) {
  const sum = (arr, f) => arr.filter(f).reduce((a, e) => a + Number(e.net !== undefined ? e.net : e.amount), 0);
  const pending = sum(entries, (e) => e.status === "pending"), released = sum(entries, (e) => e.status === "available");
  const withdrawn = sum(withdrawals, (w) => w.status === "paid"), held = sum(withdrawals, (w) => w.status === "requested");
  return { pending, available: released - withdrawn - held, withdrawn, requested: held, lifetime: pending + released };
}
function cleanOrder(b) {
  b = b || {}; const method = String(b.method || ""), phone = String(b.phone || "").trim(), address = String(b.address || "").trim();
  if (!["address", "contact"].includes(method)) return { error: "Choose how you want to receive it: to my address, or by contacting the seller." };
  if (!/^\+?[0-9 ]{7,16}$/.test(phone)) return { error: "Enter a phone number the seller can reach." };
  if (method === "address" && (address.length < 8 || address.length > 200)) return { error: "Enter your full delivery address." };
  return { value: { method, phone, address: method === "address" ? address : "" } };
}
function cleanBank(b) {
  b = b || {}; const bank = String(b.bankName || "").trim(), num = String(b.accountNumber || "").replace(/\s/g, ""), name = String(b.accountName || "").trim();
  if (bank.length < 2 || bank.length > 60) return { error: "Enter your bank name." };
  if (!/^[0-9]{10}$/.test(num)) return { error: "Enter your 10-digit account number." };
  if (name.length < 3 || name.length > 80) return { error: "Enter the account name." };
  return { value: { bank, num, name } };
}

module.exports = function makeCommerce({ app, db, requireAuth, requireAdmin, store, axios }) {
  const { publicHandle, displayNameOf } = store;
  const now = () => Date.now();
  const bad = (res, code, msg, extra) => res.status(code).json({ success: false, message: msg, ...(extra || {}) });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS commerce_payments (reference TEXT PRIMARY KEY, purpose TEXT NOT NULL, ref_id BIGINT NOT NULL, payer_email TEXT NOT NULL, amount_ngn BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', paid_kobo BIGINT, created_at BIGINT NOT NULL, paid_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_commerce_pay_ref ON commerce_payments(purpose, ref_id)`,
    `CREATE TABLE IF NOT EXISTS market_orders (id BIGSERIAL PRIMARY KEY, listing_id BIGINT NOT NULL, seller TEXT NOT NULL, buyer TEXT NOT NULL, title TEXT NOT NULL, amount_ngn BIGINT NOT NULL, method TEXT NOT NULL, buyer_phone TEXT, buyer_address TEXT, status TEXT NOT NULL DEFAULT 'pending_payment', dispute_reason TEXT, created_at BIGINT NOT NULL, paid_at BIGINT, shipped_at BIGINT, completed_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_buyer ON market_orders(buyer, id DESC)`, `CREATE INDEX IF NOT EXISTS idx_orders_seller ON market_orders(seller, id DESC)`,
    `CREATE TABLE IF NOT EXISTS seller_wallet_entries (id BIGSERIAL PRIMARY KEY, seller TEXT NOT NULL, order_id BIGINT NOT NULL UNIQUE, gross BIGINT NOT NULL, commission BIGINT NOT NULL, net BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', release_at BIGINT NOT NULL, created_at BIGINT NOT NULL, released_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_swe_seller ON seller_wallet_entries(seller, status)`,
    `CREATE TABLE IF NOT EXISTS seller_withdrawals (id BIGSERIAL PRIMARY KEY, seller TEXT NOT NULL, amount BIGINT NOT NULL, bank_name TEXT, account_number TEXT, account_name TEXT, status TEXT NOT NULL DEFAULT 'requested', admin_ref TEXT, created_at BIGINT NOT NULL, decided_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS commerce_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727200)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727200)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("COMMERCE MIGRATE ERROR:", e); });

  const DEFAULTS = { commissionPercent: "0", releaseDays: "7", minWithdrawal: "1000" };
  async function settings() { const rows = await db.all("SELECT key, value FROM commerce_settings"); const s = { ...DEFAULTS }; rows.forEach((r) => { s[r.key] = r.value; });
    return { commissionPercent: Math.min(50, Math.max(0, Number(s.commissionPercent) || 0)), releaseDays: Math.min(60, Math.max(1, Number(s.releaseDays) || 7)), minWithdrawal: Math.max(100, Number(s.minWithdrawal) || 1000) }; }
  const base = (req) => (process.env.PUBLIC_URL || process.env.APP_URL || (req.protocol + "://" + req.get("host"))).replace(/\/+$/, "");
  const key = () => process.env.PAYSTACK_SECRET_KEY;
  const notify = (email, text, link) => db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [email, String(text).slice(0, 200), link || "vico-wallet.html", now()]).catch(() => {});

  app.get("/api/currency/rate", (req, res) => res.json({ success: true, ngnPerUsd: Number(process.env.NGN_PER_USD) || 1500 }));

  // ---------- payments ----------
  const purposes = {};                                   // purpose -> async (t, paymentRow) => optional async "after commit" function
  function registerPurpose(name, fn) { purposes[name] = fn; }
  async function initPayment({ purpose, refId, email, amountNgn, req, back }) {
    if (!key()) { const e = new Error("PAYSTACK_SECRET_KEY is not set"); e.code = "no_key"; throw e; }
    await ready;
    const reference = (purpose === "ad" || purpose === "adjob" ? "VAD-" : "VMK-") + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString("hex").toUpperCase();
    await db.run("INSERT INTO commerce_payments (reference, purpose, ref_id, payer_email, amount_ngn, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)", [reference, purpose, refId, email, amountNgn, now()]);
    const r = await axios.post("https://api.paystack.co/transaction/initialize", {
      email, amount: Math.round(amountNgn * 100), currency: "NGN", reference, callback_url: base(req) + "/commerce-return.html?back=" + encodeURIComponent(back || "vico-wallet.html"),
      metadata: { vico_purpose: purpose, ref_id: refId }
    }, { headers: { Authorization: "Bearer " + key() }, timeout: 20000 });
    return { reference, url: r.data && r.data.data && r.data.data.authorization_url };
  }
  const isCommercePayment = (p) => !!(p && p.metadata && p.metadata.vico_purpose && purposes[p.metadata.vico_purpose]) || /^V(AD|MK)-/.test(String((p && p.reference) || ""));

  // the one place a payment becomes "paid": asks Paystack, checks the amount, flips pending -> paid once, then runs the purpose
  async function finalize(reference) {
    await ready;
    const row = await db.get("SELECT reference, purpose, ref_id AS \"refId\", payer_email AS payer, amount_ngn AS amount, status FROM commerce_payments WHERE reference = ?", [reference]);
    if (!row) return { ok: false, message: "Unknown payment." };
    if (row.status === "paid") return { ok: true, already: true, purpose: row.purpose, refId: Number(row.refId) };
    let data; try { data = (await axios.get("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), { headers: { Authorization: "Bearer " + key() }, timeout: 20000 })).data.data; }
    catch (e) { return { ok: false, message: "Could not check the payment with Paystack. Please try again." }; }
    if (!data || data.status !== "success") return { ok: false, message: "The payment was not completed." };
    if (!amountOk(data.amount, row.amount, data.currency)) { console.error("COMMERCE AMOUNT MISMATCH", reference, data.amount, row.amount); return { ok: false, message: "The amount paid does not match. Please contact support." }; }
    let after = null;
    const done = await db.tx(async (t) => {
      const upd = await t.get("UPDATE commerce_payments SET status = 'paid', paid_kobo = ?, paid_at = ? WHERE reference = ? AND status = 'pending' RETURNING reference", [Number(data.amount), now(), reference]);
      if (!upd) return false;                                      // someone else already finalised it
      const fn = purposes[row.purpose]; if (fn) after = await fn(t, row);
      return true;
    });
    if (done && after) { try { await after(); } catch (e) { console.error("COMMERCE AFTER-PAID ERROR:", e.message); } }
    return { ok: true, already: !done, purpose: row.purpose, refId: Number(row.refId) };
  }
  app.get("/api/commerce/verify", requireAuth, async (req, res) => {
    const ref = String(req.query.reference || "");
    const own = ref && await db.get("SELECT 1 AS x FROM commerce_payments WHERE reference = ? AND payer_email = ?", [ref, req.userEmail]);
    if (!own) return bad(res, 404, "Payment not found.");
    const r = await finalize(ref); return res.status(r.ok ? 200 : 400).json({ success: r.ok, message: r.message, purpose: r.purpose, refId: r.refId });
  });

  // ---------- orders (marketplace) ----------
  registerPurpose("order", async (t, pay) => {
    const o = await t.get("SELECT id, listing_id AS \"listingId\", seller, buyer, title, amount_ngn AS amount, method FROM market_orders WHERE id = ?", [pay.refId]);
    if (!o) return null;
    const lst = await t.get("UPDATE market_listings SET status = 'sold', updated_at = ? WHERE id = ? AND status = 'active' RETURNING id", [now(), o.listingId]);
    if (!lst) { await t.run("UPDATE market_orders SET status = 'refund_due', paid_at = ? WHERE id = ?", [now(), o.id]); return async () => notify(o.buyer, "The item was sold to someone else first. You will be refunded.", "vico-wallet.html"); }
    const S = await settings(), sp = splitSale(o.amount, S.commissionPercent);
    await t.run("UPDATE market_orders SET status = 'paid', paid_at = ? WHERE id = ?", [now(), o.id]);
    await t.run("INSERT INTO seller_wallet_entries (seller, order_id, gross, commission, net, status, release_at, created_at) VALUES (?,?,?,?,?, 'pending', ?, ?) ON CONFLICT (order_id) DO NOTHING", [o.seller, o.id, sp.gross, sp.commission, sp.net, now() + S.releaseDays * DAY, now()]);
    return async () => {   // after the money is safely recorded: tell the seller in Vico Messages
      const text = "🛍️ I paid ₦" + Number(o.amount).toLocaleString() + " for “" + o.title + "”. " + (o.method === "address" ? "Please send it to my address (see My Sales in Vico Wallet)." : "Please contact me to arrange delivery (see My Sales in Vico Wallet).");
      const a = o.seller < o.buyer ? [o.seller, o.buyer] : [o.buyer, o.seller], t2 = now();
      const th = await db.get("INSERT INTO dm_threads (user_a, user_b, last_message_at) VALUES (?,?,?) ON CONFLICT (user_a, user_b) DO UPDATE SET last_message_at = EXCLUDED.last_message_at RETURNING id", [a[0], a[1], t2]);
      await db.run("INSERT INTO dm_messages (thread_id, sender, body, created_at) VALUES (?,?,?,?)", [th.id, o.buyer, text, t2]);
      await notify(o.seller, "New paid order: " + o.title, "vico-wallet.html");
    };
  });

  app.post("/api/market/orders", requireAuth, async (req, res) => {
    try { await ready;
      const c = cleanOrder(req.body); if (c.error) return bad(res, 400, c.error);
      const id = Math.floor(Number(req.body.listingId));
      const l = Number.isFinite(id) && await db.get("SELECT id, seller, title, price_ngn AS price, status FROM market_listings WHERE id = ?", [id]);
      if (!l || l.status !== "active") return bad(res, 404, "This item is no longer available.");
      if (l.seller === req.userEmail) return bad(res, 400, "You cannot buy your own item.");
      const n = await db.get("SELECT COUNT(*) AS n FROM market_orders WHERE buyer = ? AND status = 'pending_payment'", [req.userEmail]);
      if (Number(n.n) >= 10) return bad(res, 429, "You have unpaid orders waiting. Please finish or wait for them to expire.");
      const o = await db.get("INSERT INTO market_orders (listing_id, seller, buyer, title, amount_ngn, method, buyer_phone, buyer_address, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'pending_payment', ?) RETURNING id", [l.id, l.seller, req.userEmail, l.title, l.price, c.value.method, c.value.phone, c.value.address, now()]);
      let p; try { p = await initPayment({ purpose: "order", refId: Number(o.id), email: req.userEmail, amountNgn: Number(l.price), req, back: "vico-wallet.html#purchases" }); }
      catch (e) { console.error("ORDER PAYMENT INIT ERROR:", e.response ? JSON.stringify(e.response.data) : e.message); return bad(res, 502, e.code === "no_key" ? "Payments are not switched on yet." : "Could not start the payment. Please try again."); }
      if (!p.url) return bad(res, 502, "Could not start the payment. Please try again.");
      res.json({ success: true, orderId: Number(o.id), url: p.url });
    } catch (e) { console.error(e); bad(res, 500, "Could not place your order."); }
  });

  const shapeOrder = (r, role) => ({ id: Number(r.id), title: r.title, amount: Number(r.amount), status: r.status, method: r.method, createdAt: Number(r.createdAt), paidAt: r.paidAt ? Number(r.paidAt) : null,
    other: { handle: publicHandle(role === "buyer" ? r.seller : r.buyer), displayName: displayNameOf(role === "buyer" ? r.seller : r.buyer) },
    ...(role === "seller" ? { buyerPhone: r.phone, buyerAddress: r.address } : {}) });
  app.get("/api/market/orders", requireAuth, async (req, res) => {
    try { await ready; const role = req.query.role === "seller" ? "seller" : "buyer";
      const rows = await db.all(`SELECT id, seller, buyer, title, amount_ngn AS amount, method, buyer_phone AS phone, buyer_address AS address, status, created_at AS "createdAt", paid_at AS "paidAt" FROM market_orders WHERE ${role} = ? AND status <> 'pending_payment' ORDER BY id DESC LIMIT 100`, [req.userEmail]);
      await store.users.warm(rows.map((r) => r.seller).concat(rows.map((r) => r.buyer)));
      res.json({ success: true, orders: rows.map((r) => shapeOrder(r, role)) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load your orders."); }
  });
  const myOrder = async (id, email, col) => { id = Math.floor(Number(id)); return Number.isFinite(id) ? db.get(`SELECT id, seller, buyer, title, status FROM market_orders WHERE id = ? AND ${col} = ?`, [id, email]) : null; };
  app.post("/api/market/orders/:id/shipped", requireAuth, async (req, res) => {    // seller: "I have sent it / delivered it"
    try { await ready; const o = await myOrder(req.params.id, req.userEmail, "seller"); if (!o || o.status !== "paid") return bad(res, 400, "This order cannot be marked as sent.");
      await db.run("UPDATE market_orders SET status = 'shipped', shipped_at = ? WHERE id = ?", [now(), o.id]); notify(o.buyer, "The seller says “" + o.title + "” was sent. Confirm when you receive it.", "vico-wallet.html#purchases"); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not update the order."); } });
  app.post("/api/market/orders/:id/confirm", requireAuth, async (req, res) => {    // buyer: "I received it" -> money becomes available
    try { await ready; const o = await myOrder(req.params.id, req.userEmail, "buyer"); if (!o || !["paid", "shipped"].includes(o.status)) return bad(res, 400, "This order cannot be confirmed.");
      await db.tx(async (t) => { await t.run("UPDATE market_orders SET status = 'completed', completed_at = ? WHERE id = ?", [now(), o.id]); await t.run("UPDATE seller_wallet_entries SET status = 'available', released_at = ? WHERE order_id = ? AND status = 'pending'", [now(), o.id]); });
      notify(o.seller, "The buyer confirmed “" + o.title + "”. Your money is available to withdraw.", "vico-wallet.html"); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not confirm."); } });
  app.post("/api/market/orders/:id/dispute", requireAuth, async (req, res) => {    // buyer: "there is a problem" -> money stays held for an admin
    try { await ready; const o = await myOrder(req.params.id, req.userEmail, "buyer"); const why = String((req.body && req.body.reason) || "").trim().slice(0, 300);
      if (!o || !["paid", "shipped"].includes(o.status)) return bad(res, 400, "This order cannot be reported now."); if (why.length < 5) return bad(res, 400, "Tell us what went wrong.");
      await db.run("UPDATE market_orders SET status = 'disputed', dispute_reason = ? WHERE id = ?", [why, o.id]); notify(o.seller, "The buyer reported a problem with “" + o.title + "”. Vico will review it.", "vico-wallet.html"); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not send your report."); } });

  // time-based release of held money (not for disputed or refunded orders)
  async function sweep() { try { await ready;
    await db.run(`UPDATE seller_wallet_entries SET status = 'available', released_at = ? WHERE status = 'pending' AND release_at <= ? AND order_id IN (SELECT id FROM market_orders WHERE status IN ('paid','shipped','completed'))`, [now(), now()]);
  } catch (e) { console.error("COMMERCE SWEEP ERROR:", e.message); } }
  const timer = setInterval(sweep, 10 * 60 * 1000); if (timer.unref) timer.unref();

  // ---------- seller wallet ----------
  async function walletOf(email) {
    const entries = await db.all("SELECT order_id AS \"orderId\", net, status, release_at AS \"releaseAt\", created_at AS \"createdAt\" FROM seller_wallet_entries WHERE seller = ? ORDER BY id DESC LIMIT 200", [email]);
    const ws = await db.all("SELECT id, amount, status, created_at AS \"createdAt\", bank_name AS bank FROM seller_withdrawals WHERE seller = ? ORDER BY id DESC LIMIT 50", [email]);
    return { entries, ws, totals: walletTotals(entries.map((e) => ({ net: Number(e.net), status: e.status })), ws.map((w) => ({ amount: Number(w.amount), status: w.status }))) };
  }
  app.get("/api/seller/wallet", requireAuth, async (req, res) => {
    try { await ready; const w = await walletOf(req.userEmail), S = await settings();
      res.json({ success: true, totals: w.totals, settings: { releaseDays: S.releaseDays, minWithdrawal: S.minWithdrawal, commissionPercent: S.commissionPercent },
        entries: w.entries.map((e) => ({ orderId: Number(e.orderId), net: Number(e.net), status: e.status, releaseAt: Number(e.releaseAt), createdAt: Number(e.createdAt) })),
        withdrawals: w.ws.map((x) => ({ id: Number(x.id), amount: Number(x.amount), status: x.status, createdAt: Number(x.createdAt), bank: x.bank })) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load your wallet."); } });
  app.post("/api/seller/withdraw", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), amount = Math.round(Number(req.body && req.body.amount)), c = cleanBank(req.body);
      if (c.error) return bad(res, 400, c.error);
      if (!(amount >= S.minWithdrawal)) return bad(res, 400, "The smallest withdrawal is ₦" + S.minWithdrawal.toLocaleString() + ".");
      const r = await db.tx(async (t) => {
        await t.lock("sw:" + req.userEmail);                    // two requests at once cannot both spend the same money
        const e = await t.all("SELECT net, status FROM seller_wallet_entries WHERE seller = ?", [req.userEmail]), w = await t.all("SELECT amount, status FROM seller_withdrawals WHERE seller = ?", [req.userEmail]);
        const tot = walletTotals(e.map((x) => ({ net: Number(x.net), status: x.status })), w.map((x) => ({ amount: Number(x.amount), status: x.status })));
        if (amount > tot.available) return { error: "You only have ₦" + Math.max(0, tot.available).toLocaleString() + " available to withdraw." };
        await t.run("INSERT INTO seller_withdrawals (seller, amount, bank_name, account_number, account_name, status, created_at) VALUES (?,?,?,?,?, 'requested', ?)", [req.userEmail, amount, c.value.bank, c.value.num, c.value.name, now()]);
        return { ok: true };
      });
      if (r.error) return bad(res, 400, r.error); res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not send your withdrawal request."); } });

  // ---------- admin ----------
  app.get("/api/admin/commerce/overview", requireAdmin, async (req, res) => {
    try { await ready; const S = await settings();
      const orders = await db.all(`SELECT id, seller, buyer, title, amount_ngn AS amount, status, dispute_reason AS reason, created_at AS "createdAt" FROM market_orders WHERE status IN ('disputed','refund_due') ORDER BY id DESC LIMIT 100`);
      const ws = await db.all(`SELECT id, seller, amount, bank_name AS bank, account_number AS "accountNumber", account_name AS "accountName", status, created_at AS "createdAt" FROM seller_withdrawals WHERE status = 'requested' ORDER BY id LIMIT 100`);
      const tot = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS gmv FROM market_orders WHERE status IN ('paid','shipped','completed')");
      res.json({ success: true, settings: S, paidOrders: Number(tot.n), salesTotal: Number(tot.gmv),
        orders: orders.map((o) => ({ ...o, id: Number(o.id), amount: Number(o.amount), createdAt: Number(o.createdAt) })), withdrawals: ws.map((w) => ({ ...w, id: Number(w.id), amount: Number(w.amount), createdAt: Number(w.createdAt) })) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load."); } });
  app.post("/api/admin/commerce/orders/:id/resolve", requireAdmin, async (req, res) => {       // release = pay the seller · refund = money goes back to the buyer (you refund in the Paystack dashboard)
    try { await ready; const id = Math.floor(Number(req.params.id)), a = String((req.body && req.body.action) || "");
      if (!["release", "refund"].includes(a)) return bad(res, 400, "Choose release or refund.");
      const o = Number.isFinite(id) && await db.get("SELECT id, seller, buyer, status FROM market_orders WHERE id = ?", [id]); if (!o || !["disputed", "refund_due"].includes(o.status)) return bad(res, 400, "This order is not waiting for a decision.");
      await db.tx(async (t) => {
        if (a === "release" && o.status === "disputed") { await t.run("UPDATE market_orders SET status = 'completed', completed_at = ? WHERE id = ?", [now(), id]); await t.run("UPDATE seller_wallet_entries SET status = 'available', released_at = ? WHERE order_id = ? AND status = 'pending'", [now(), id]); }
        else { await t.run("UPDATE market_orders SET status = 'refunded' WHERE id = ?", [id]); await t.run("UPDATE seller_wallet_entries SET status = 'reversed' WHERE order_id = ? AND status = 'pending'", [id]); }
      });
      notify(o.buyer, a === "refund" ? "Your order was refunded." : "Your order was completed.", "vico-wallet.html"); notify(o.seller, a === "refund" ? "An order was refunded to the buyer." : "Your money for an order is available.", "vico-wallet.html");
      res.json({ success: true, note: a === "refund" ? "Now send the refund from your Paystack dashboard." : "" });
    } catch (e) { console.error(e); bad(res, 500, "Could not save the decision."); } });
  app.post("/api/admin/commerce/withdrawals/:id", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), a = String((req.body && req.body.action) || ""), ref = String((req.body && req.body.reference) || "").slice(0, 80);
      if (!["paid", "reject"].includes(a)) return bad(res, 400, "Choose paid or reject.");
      const w = Number.isFinite(id) && await db.get("SELECT id, seller, amount, status FROM seller_withdrawals WHERE id = ?", [id]); if (!w || w.status !== "requested") return bad(res, 400, "This request was already decided.");
      await db.run("UPDATE seller_withdrawals SET status = ?, admin_ref = ?, decided_at = ? WHERE id = ?", [a === "paid" ? "paid" : "rejected", ref, now(), id]);
      notify(w.seller, a === "paid" ? "Your withdrawal of ₦" + Number(w.amount).toLocaleString() + " was paid." : "Your withdrawal request was declined. The money is back in your wallet.", "vico-wallet.html"); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not update the withdrawal."); } });
  app.post("/api/admin/commerce/settings", requireAdmin, async (req, res) => {
    try { await ready; const b = req.body || {}, put = (k, v) => db.run("INSERT INTO commerce_settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, String(v)]);
      for (const k of ["commissionPercent", "releaseDays", "minWithdrawal"]) if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) return bad(res, 400, "Enter a valid number for " + k + "."); await put(k, n); }
      res.json({ success: true, settings: await settings() }); } catch (e) { bad(res, 500, "Could not save."); } });

  return { initPayment, finalize, registerPurpose, isCommercePayment, ready };
};
module.exports.amountOk = amountOk; module.exports.splitSale = splitSale; module.exports.walletTotals = walletTotals; module.exports.cleanOrder = cleanOrder; module.exports.cleanBank = cleanBank;
