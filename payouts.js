// =====================================================================================================================
// VicoPay Live — MONTHLY CREATOR PAYOUTS  (Node.js / Express / PostgreSQL / Paystack Transfers)
// =====================================================================================================================
// HOW MONEY MOVES (every step is guarded so a creator can never be paid twice, and nothing is paid without YOUR OK):
//
//   1. Creator saves bank details            -> Paystack verifies the account name + creates a transfer recipient.
//   2. Month ends (+ the chargeback hold)    -> CALCULATE: stars >= 3,000, 3 live hours EVERY day, $9 per full 3,000 stars.
//   3. You review the batch                  -> admin-payouts.html shows every creator, their stars, live days and amount.
//   4. REQUEST APPROVAL                      -> a one-time code is emailed to PAYOUT_APPROVER_EMAIL (your Gmail).
//   5. You type the code in the dashboard    -> the batch becomes "approved". No code = no money moves. (Needs ADMIN_KEY too.)
//   6. Transfers are sent one by one         -> each creator has ONE row; a transfer reference is created once per attempt.
//   7. Paystack webhooks                     -> transfer.success / transfer.failed / transfer.reversed update the records.
//
// DUPLICATE PROTECTION (several independent layers):
//   * one batch per month (UNIQUE month) and one item per creator per month (UNIQUE month + creator)
//   * an item is "claimed" with a conditional UPDATE (status queued -> sending): only ONE worker can win it
//   * the stars are deducted in that same claim, under the same per-creator lock the old withdrawal route uses
//   * the Paystack transfer reference is unique per attempt, and Paystack itself rejects a repeated reference
//   * webhooks are stored once (UNIQUE event key) and only ever move an item forward; stars are refunded exactly once
// =====================================================================================================================
"use strict";

module.exports = function payoutsModule(ctx) {
  const { app, db, store, axios, crypto, requireAuth, requireAdmin } = ctx;

  const lc = (v) => String(v || "").toLowerCase();
  const ok = (res, extra) => res.json({ success: true, ...(extra || {}) });
  const fail = (res, code, message, extra) => res.status(code).json({ success: false, message, ...(extra || {}) });
  const DAY = 86400000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------------------------------------- settings
  const rules = () => ({
    minimumStars: Number((ctx.rules && ctx.rules.minimumStars) || 3000),
    dailyLiveHours: Number((ctx.rules && ctx.rules.dailyLiveHours) || 3),
    usdPerBlock: Number((ctx.rules && ctx.rules.usdPerBlock) || 9)
  });
  const cfg = () => ({
    approverEmail: String(process.env.PAYOUT_APPROVER_EMAIL || "vicopay.live@gmail.com").trim().toLowerCase(),
    ngnPerUsd: Number(process.env.NGN_PER_USD || 1500),
    tzOffsetMin: Number(process.env.PAYOUT_TZ_OFFSET_MIN || 60),                 // Nigeria = UTC+1, no daylight saving
    holdDays: Number(ctx.holdDays != null ? ctx.holdDays : process.env.PAYOUT_HOLD_DAYS || 7),
    maxItemUsd: Number(process.env.PAYOUT_MAX_ITEM_USD || 500),                  // one creator can never be paid more than this
    maxBatchUsd: Number(process.env.PAYOUT_MAX_BATCH_USD || 10000),              // a batch above this cannot be approved
    recipientCooldownH: Number(process.env.PAYOUT_RECIPIENT_COOLDOWN_HOURS || 72),
    approvalMinutes: Number(process.env.PAYOUT_APPROVAL_MINUTES || 30),
    autoCalculate: String(process.env.PAYOUT_AUTO_CALCULATE || "false").toLowerCase() === "true",
    autoApproveMaxUsd: Number(process.env.PAYOUT_AUTO_APPROVE_MAX_USD || 0),     // 0 = auto-approval is OFF (recommended)
    secret: String(process.env.PAYOUT_APPROVAL_SECRET || process.env.PAYSTACK_SECRET_KEY || "")
  });
  const PREFIX = "vicopay";

  // ------------------------------------------------------------------------------------------------- schema
  async function migrate() {
    const pk = db.isPg ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
    const stmts = [
      `CREATE TABLE IF NOT EXISTS payout_recipients (
         creator_id TEXT PRIMARY KEY, bank_code TEXT NOT NULL, bank_name TEXT, account_number TEXT NOT NULL,
         account_name TEXT, recipient_code TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_recipient_account ON payout_recipients(bank_code, account_number)`,
      `CREATE TABLE IF NOT EXISTS payout_batches (
         id ${pk}, month TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'draft',
         usd_rate DOUBLE PRECISION NOT NULL, item_count INTEGER NOT NULL DEFAULT 0,
         total_usd DOUBLE PRECISION NOT NULL DEFAULT 0, total_kobo BIGINT NOT NULL DEFAULT 0,
         fingerprint TEXT, approval_hash TEXT, approval_expires_at BIGINT, approval_attempts INTEGER NOT NULL DEFAULT 0,
         approval_sent_at BIGINT, approved_at BIGINT, completed_at BIGINT, created_at BIGINT NOT NULL, rules_json TEXT)`,
      `CREATE TABLE IF NOT EXISTS payout_items (
         id ${pk}, batch_id BIGINT NOT NULL, month TEXT NOT NULL, creator_id TEXT NOT NULL,
         stars BIGINT NOT NULL, stars_spent BIGINT NOT NULL DEFAULT 0, units INTEGER NOT NULL DEFAULT 0,
         live_days INTEGER NOT NULL DEFAULT 0, days_in_month INTEGER NOT NULL DEFAULT 0,
         usd DOUBLE PRECISION NOT NULL DEFAULT 0, amount_kobo BIGINT NOT NULL DEFAULT 0,
         status TEXT NOT NULL, reason TEXT, recipient_code TEXT, bank_name TEXT, account_last4 TEXT, account_name TEXT,
         attempt INTEGER NOT NULL DEFAULT 0, transfer_reference TEXT, transfer_code TEXT, paystack_status TEXT,
         stars_deducted SMALLINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
         sent_at BIGINT, finished_at BIGINT)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_item_month_creator ON payout_items(month, creator_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_item_reference ON payout_items(transfer_reference)`,
      `CREATE INDEX IF NOT EXISTS idx_payout_items_batch ON payout_items(batch_id, status)`,
      `CREATE TABLE IF NOT EXISTS payout_events (
         id ${pk}, event_key TEXT NOT NULL UNIQUE, event TEXT NOT NULL, reference TEXT, payload TEXT, received_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS payout_audit (
         id ${pk}, at BIGINT NOT NULL, actor TEXT, action TEXT NOT NULL, batch_id BIGINT, item_id BIGINT, detail TEXT)`
    ];
    for (const s of stmts) await db.run(s);
  }
  const audit = (actor, action, batchId, itemId, detail) =>
    db.run("INSERT INTO payout_audit (at, actor, action, batch_id, item_id, detail) VALUES (?,?,?,?,?,?)",
      [Date.now(), actor || "system", action, batchId || null, itemId || null, detail ? String(detail).slice(0, 500) : null])
      .catch((e) => console.error("payout audit:", e.message));

  // ------------------------------------------------------------------------------------------------- Paystack client
  function paystackClient() {
    if (ctx.paystack) return ctx.paystack;                       // tests inject a fake
    return {
      async request(method, path, data) {
        const key = process.env.PAYSTACK_SECRET_KEY;
        if (!key) { const e = new Error("PAYSTACK_SECRET_KEY is not set."); e.config = true; throw e; }
        try {
          const r = await axios({
            method, url: "https://api.paystack.co" + path, data, timeout: 25000,
            headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, validateStatus: () => true
          });
          return { status: r.status, body: r.data || {} };
        } catch (e) { const err = new Error("network: " + e.message); err.network = true; throw err; }
      }
    };
  }
  const ps = () => paystackClient();

  // ------------------------------------------------------------------------------------------------- email
  let transporter = null;
  const mailConfigured = () => !!(ctx.sendMail || process.env.SMTP_HOST || process.env.RESEND_API_KEY);
  async function sendMail({ to, subject, text, html }) {
    if (ctx.sendMail) return ctx.sendMail({ to, subject, text, html });
    const from = process.env.MAIL_FROM || process.env.SMTP_USER || "VicoPay <no-reply@vicopay.local>";
    if (process.env.SMTP_HOST) {
      if (!transporter) {
        let nodemailer; try { nodemailer = require("nodemailer"); } catch (e) { throw new Error("Run: npm install   (nodemailer is needed to send the approval email)"); }
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465),
          secure: String(process.env.SMTP_SECURE || (Number(process.env.SMTP_PORT || 465) === 465)) === "true",
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
      }
      return transporter.sendMail({ from, to, subject, text, html });
    }
    if (process.env.RESEND_API_KEY) {
      const r = await axios.post("https://api.resend.com/emails", { from, to: [to], subject, text, html },
        { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY }, timeout: 20000 });
      return r.data;
    }
    throw new Error("Email is not set up. Add SMTP_HOST / SMTP_USER / SMTP_PASS (or RESEND_API_KEY) to your .env so the approval code can be emailed.");
  }
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  const naira = (kobo) => "₦" + (Number(kobo || 0) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const notify = (email, text) =>
    db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [lc(email), String(text).slice(0, 200), "payout-setup.html", Date.now()])
      .catch(() => { });
  async function mailApprover(subject, text, html) {
    try { await sendMail({ to: cfg().approverEmail, subject, text, html }); return true; }
    catch (e) { console.error("Payout email failed:", e.message); return false; }
  }

  // ------------------------------------------------------------------------------------------------- month maths
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  function monthWindow(month) {
    const [y, m] = month.split("-").map(Number), off = cfg().tzOffsetMin * 60000;
    const startMs = Date.UTC(y, m - 1, 1) - off, endMs = Date.UTC(y, m, 1) - off;
    return { startMs, endMs, days: Math.round((endMs - startMs) / DAY), startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
  }
  const currentMonth = () => { const d = new Date(Date.now() + cfg().tzOffsetMin * 60000); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"); };
  const previousMonth = () => { const [y, m] = currentMonth().split("-").map(Number); return m === 1 ? (y - 1) + "-12" : y + "-" + String(m - 1).padStart(2, "0"); };
  // a month can only be paid once it has ended AND the chargeback hold has passed (so every gift in it is withdrawable)
  const matureAt = (month) => monthWindow(month).endMs + cfg().holdDays * DAY;
  const isMature = (month) => Date.now() >= matureAt(month);

  // Hours broadcast on each day of the month. Overlapping sessions are merged (two rooms at once never count double),
  // a session that never closed is only counted up to its last heartbeat, and one session counts at most 24 hours.
  function liveHoursPerDay(sessions, win) {
    const iv = [];
    for (const s of sessions) {
      const start = Number(s.started_at), endRaw = s.ended_at != null ? Number(s.ended_at) : (s.last_beat != null ? Number(s.last_beat) : start);
      const end = Math.min(endRaw, start + DAY);
      if (end > start) iv.push([Math.max(start, win.startMs), Math.min(end, win.endMs)]);
    }
    iv.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const x of iv) { if (x[1] <= x[0]) continue; const last = merged[merged.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else merged.push([x[0], x[1]]); }
    const hours = new Array(win.days).fill(0);
    for (const [a, b] of merged) {
      let cur = a;
      while (cur < b) {
        const idx = Math.min(win.days - 1, Math.floor((cur - win.startMs) / DAY)), dayEnd = win.startMs + (idx + 1) * DAY, seg = Math.min(b, dayEnd);
        hours[idx] += (seg - cur) / 3600000; cur = seg;
      }
    }
    return hours;
  }
  const calcUnits = (stars) => Math.floor(Math.max(0, stars) / rules().minimumStars);     // 3000 -> 1, 5500 -> 1, 6000 -> 2, 9000 -> 3
  const calcUsd = (stars) => calcUnits(stars) * rules().usdPerBlock;                       // $9, $9, $18, $27 ...

  // ------------------------------------------------------------------------------------------------- eligibility
  async function evaluateCreator(host, win, rate) {
    const R = rules(), C = cfg();
    const earned = Number((await db.get("SELECT COALESCE(SUM(coin),0) AS v FROM gift_transactions WHERE host_id = ? AND created_at >= ? AND created_at < ?", [host, win.startIso, win.endIso])).v);
    const circ = Number((await db.get(
      `SELECT COALESCE(SUM(CASE WHEN r.amt < s.amt THEN r.amt ELSE s.amt END),0) AS v
         FROM (SELECT sender_id AS other, SUM(coin) AS amt FROM gift_transactions WHERE host_id = ? AND created_at >= ? AND created_at < ? GROUP BY sender_id HAVING SUM(coin) > 0) r
         JOIN (SELECT host_id AS other, SUM(coin) AS amt FROM gift_transactions WHERE sender_id = ? AND created_at >= ? AND created_at < ? GROUP BY host_id HAVING SUM(coin) > 0) s ON s.other = r.other`,
      [host, win.startIso, win.endIso, host, win.startIso, win.endIso])).v);
    const bd = await store.starBreakdown(host);                                            // never pay stars already paid or still on hold
    const stars = Math.max(0, Math.min(earned - circ, bd.withdrawable));
    const sessions = await db.all("SELECT started_at, ended_at, last_beat FROM live_sessions WHERE host_id = ? AND started_at < ? AND COALESCE(ended_at, last_beat, started_at) > ?", [host, win.endMs, win.startMs]);
    const hours = liveHoursPerDay(sessions, win);
    const liveDays = hours.filter((h) => h >= R.dailyLiveHours - 1e-9).length;

    const units = calcUnits(stars), usd = calcUsd(stars), starsSpent = units * R.minimumStars;
    const flag = await db.get("SELECT banned FROM user_flags WHERE email = ?", [host]);
    const sec = await db.get("SELECT banned, disqualified FROM withdrawal_security WHERE creator_id = ?", [host]);
    const rec = await db.get("SELECT * FROM payout_recipients WHERE creator_id = ?", [host]);

    let status = "ready", reason = null;
    if (stars < R.minimumStars) { status = "ineligible"; reason = `Only ${stars.toLocaleString()} stars (needs ${R.minimumStars.toLocaleString()})`; }
    else if (liveDays < win.days) { status = "ineligible"; reason = `Live ${R.dailyLiveHours}h on ${liveDays}/${win.days} days (needs every day)`; }
    else if ((flag && Number(flag.banned)) || (sec && (Number(sec.banned) || Number(sec.disqualified)))) { status = "held"; reason = "Account is banned or disqualified"; }
    else if (usd > C.maxItemUsd) { status = "held"; reason = `Amount ${money(usd)} is above the per-creator safety limit (${money(C.maxItemUsd)})`; }
    else if (!rec) { status = "held"; reason = "No verified bank account yet"; }
    else if (Date.now() - Number(rec.updated_at) < C.recipientCooldownH * 3600000) { status = "held"; reason = `Bank details changed in the last ${C.recipientCooldownH}h`; }
    return {
      creator_id: host, stars, earned, circular: circ, units, usd, starsSpent, liveDays, daysInMonth: win.days, status, reason,
      amount_kobo: Math.round(usd * rate * 100),
      recipient_code: rec ? rec.recipient_code : null, bank_name: rec ? rec.bank_name : null,
      account_last4: rec ? String(rec.account_number).slice(-4) : null, account_name: rec ? rec.account_name : null
    };
  }

  async function evaluateMonth(month) {
    const win = monthWindow(month), R = rules(), rate = cfg().ngnPerUsd;
    const hosts = await db.all(
      "SELECT host_id FROM gift_transactions WHERE created_at >= ? AND created_at < ? GROUP BY host_id HAVING SUM(coin) >= ?", [win.startIso, win.endIso, R.minimumStars]);
    const rows = [];
    for (const h of hosts) rows.push(await evaluateCreator(lc(h.host_id), win, rate));
    rows.sort((a, b) => b.usd - a.usd || a.creator_id.localeCompare(b.creator_id));
    return { month, win, rate, rows };
  }
  const fingerprintOf = (items) => crypto.createHash("sha256").update(JSON.stringify(
    items.filter((i) => i.status === "ready").map((i) => [i.creator_id, Number(i.stars_spent != null ? i.stars_spent : i.starsSpent), Number(i.amount_kobo), i.recipient_code]).sort())).digest("hex");

  // Saves (or re-saves, while still a draft) the batch for a month.
  async function calculateAndSave(month, actor) {
    if (!MONTH_RE.test(month)) throw httpErr(400, "Month must look like 2026-09.");
    if (!isMature(month)) throw httpErr(400, `${month} cannot be paid yet. It can be calculated from ${new Date(matureAt(month)).toISOString().slice(0, 10)} (month end + ${cfg().holdDays}-day safety hold). You can still preview it.`);
    const ev = await evaluateMonth(month);
    return db.tx(async (t) => {
      if (t.lock) await t.lock("payout-batch:" + month);
      let batch = await t.get("SELECT * FROM payout_batches WHERE month = ?", [month]);
      if (batch && !["draft", "awaiting_approval", "cancelled"].includes(batch.status)) throw httpErr(409, `The ${month} batch is already ${batch.status}; it can no longer be recalculated.`);
      const now = Date.now();
      if (!batch) {
        batch = await t.get("INSERT INTO payout_batches (month, status, usd_rate, created_at, rules_json) VALUES (?,?,?,?,?) RETURNING *", [month, "draft", ev.rate, now, JSON.stringify({ ...rules(), holdDays: cfg().holdDays })]);
      } else {
        await t.run("DELETE FROM payout_items WHERE batch_id = ? AND status <> 'sending'", [batch.id]);
        await t.run("UPDATE payout_batches SET usd_rate = ?, status = 'draft', approval_hash = NULL, approval_expires_at = NULL, approval_attempts = 0 WHERE id = ?", [ev.rate, batch.id]);
      }
      for (const r of ev.rows) {
        await t.run(
          `INSERT INTO payout_items (batch_id, month, creator_id, stars, stars_spent, units, live_days, days_in_month, usd, amount_kobo, status, reason,
                                     recipient_code, bank_name, account_last4, account_name, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [batch.id, month, r.creator_id, r.stars, r.status === "ready" ? r.starsSpent : 0, r.units, r.liveDays, r.daysInMonth, r.usd, r.amount_kobo, r.status, r.reason,
          r.recipient_code, r.bank_name, r.account_last4, r.account_name, now, now]);
      }
      const items = await t.all("SELECT * FROM payout_items WHERE batch_id = ?", [batch.id]);
      const ready = items.filter((i) => i.status === "ready");
      await t.run("UPDATE payout_batches SET item_count = ?, total_usd = ?, total_kobo = ?, fingerprint = ? WHERE id = ?",
        [ready.length, ready.reduce((s, i) => s + Number(i.usd), 0), ready.reduce((s, i) => s + Number(i.amount_kobo), 0), fingerprintOf(items), batch.id]);
      return t.get("SELECT * FROM payout_batches WHERE id = ?", [batch.id]);
    }).then(async (b) => { await audit(actor, "calculate", b.id, null, `${month}: ${b.item_count} payable, ${money(b.total_usd)}`); return b; });
  }

  function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

  // ------------------------------------------------------------------------------------------------- approval by email
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const makeCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const codeHash = (batchId, fingerprint, code) => crypto.createHmac("sha256", cfg().secret || "no-secret").update(`${batchId}:${fingerprint}:${normCode(code)}`).digest("hex");
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function requestApproval(batchId, actor) {
    if (!cfg().secret) throw httpErr(500, "PAYSTACK_SECRET_KEY (or PAYOUT_APPROVAL_SECRET) must be set.");
    if (!mailConfigured()) throw httpErr(500, "Email is not set up, so the approval code cannot be sent. Add SMTP_* settings to .env.");
    const batch = await db.get("SELECT * FROM payout_batches WHERE id = ?", [batchId]);
    if (!batch) throw httpErr(404, "Batch not found.");
    if (!["draft", "awaiting_approval"].includes(batch.status)) throw httpErr(409, `This batch is already ${batch.status}.`);
    if (!isMature(batch.month)) throw httpErr(400, "This month is not mature yet.");
    if (batch.approval_sent_at && Date.now() - Number(batch.approval_sent_at) < 60000) throw httpErr(429, "An approval email was just sent. Wait a minute before asking for another.");
    const items = await db.all("SELECT * FROM payout_items WHERE batch_id = ? ORDER BY usd DESC, creator_id", [batchId]);
    const ready = items.filter((i) => i.status === "ready");
    if (!ready.length) throw httpErr(400, "There is nothing payable in this batch.");
    const fp = fingerprintOf(items);
    if (fp !== batch.fingerprint) throw httpErr(409, "The batch changed since it was calculated. Recalculate it first.");
    const totalUsd = ready.reduce((s, i) => s + Number(i.usd), 0), totalKobo = ready.reduce((s, i) => s + Number(i.amount_kobo), 0);
    if (totalUsd > cfg().maxBatchUsd) throw httpErr(400, `Batch total ${money(totalUsd)} is above the safety limit of ${money(cfg().maxBatchUsd)} (PAYOUT_MAX_BATCH_USD).`);
    const code = makeCode(), expires = Date.now() + cfg().approvalMinutes * 60000;

    // save the code FIRST, so a code can only exist if it is stored
    await db.run("UPDATE payout_batches SET status = 'awaiting_approval', approval_hash = ?, approval_expires_at = ?, approval_attempts = 0, approval_sent_at = ? WHERE id = ? AND status IN ('draft','awaiting_approval')",
      [codeHash(batchId, fp, code), expires, Date.now(), batchId]);
    const lines = ready.slice(0, 60).map((i) => `${i.creator_id} | ${Number(i.stars).toLocaleString()} stars | ${money(i.usd)} (${naira(i.amount_kobo)}) | ${i.bank_name || "?"} ****${i.account_last4 || "?"}`);
    const text = [
      `VicoPay payout approval — ${batch.month}`, "",
      `${ready.length} creators will be paid ${money(totalUsd)} in total (${naira(totalKobo)} at ₦${batch.usd_rate}/$1).`, "",
      `YOUR APPROVAL CODE:  ${code.slice(0, 4)}-${code.slice(4)}`, "",
      `Enter it in admin-payouts.html to release the money. The code works once, for ${cfg().approvalMinutes} minutes, and only for this exact list.`,
      `If you did not ask for this, do NOT enter the code; change your ADMIN_KEY.`, "", "Creators:", ...lines,
      ready.length > 60 ? `...and ${ready.length - 60} more` : "", "", `Batch fingerprint: ${fp.slice(0, 16)}`
    ].join("\n");
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px"><h2>VicoPay payout approval — ${esc(batch.month)}</h2>
      <p><b>${ready.length}</b> creators will be paid <b>${money(totalUsd)}</b> (${naira(totalKobo)} at ₦${batch.usd_rate}/$1).</p>
      <p style="font-size:30px;letter-spacing:4px;background:#f3f4f6;padding:14px 18px;border-radius:10px;display:inline-block"><b>${code.slice(0, 4)}-${code.slice(4)}</b></p>
      <p>Enter this code in <b>admin-payouts.html</b> to release the money. It works once, for ${cfg().approvalMinutes} minutes, and only for this exact list.<br>If you did not ask for this, do <b>not</b> enter it and change your ADMIN_KEY.</p>
      <table cellpadding="6" style="border-collapse:collapse;font-size:13px"><tr style="background:#eee"><th align="left">Creator</th><th>Stars</th><th>USD</th><th>NGN</th><th align="left">Account</th></tr>
      ${ready.slice(0, 60).map((i) => `<tr><td>${esc(i.creator_id)}</td><td align="right">${Number(i.stars).toLocaleString()}</td><td align="right">${money(i.usd)}</td><td align="right">${naira(i.amount_kobo)}</td><td>${esc(i.bank_name)} ****${esc(i.account_last4)}</td></tr>`).join("")}</table>
      ${ready.length > 60 ? `<p>…and ${ready.length - 60} more</p>` : ""}<p style="color:#666;font-size:12px">Fingerprint ${fp.slice(0, 16)}</p></div>`;
    try { await sendMail({ to: cfg().approverEmail, subject: `[VicoPay] Approve ${batch.month} payouts: ${money(totalUsd)} to ${ready.length} creators`, text, html }); }
    catch (e) {
      await db.run("UPDATE payout_batches SET approval_hash = NULL, approval_expires_at = NULL, approval_sent_at = NULL WHERE id = ?", [batchId]);
      throw httpErr(502, "The approval email could not be sent: " + e.message);
    }
    await audit(actor, "approval_requested", batchId, null, `emailed ${cfg().approverEmail}`);
    return { sentTo: cfg().approverEmail, expiresAt: expires, count: ready.length, totalUsd };
  }

  async function confirmApproval(batchId, code, actor) {
    // count the attempt BEFORE checking, so guessing is limited to 5 tries per emailed code
    const claim = await db.run("UPDATE payout_batches SET approval_attempts = approval_attempts + 1 WHERE id = ? AND status = 'awaiting_approval' AND approval_hash IS NOT NULL AND approval_attempts < 5 RETURNING *", [batchId]);
    const batch = claim.rows && claim.rows[0];
    if (!batch) {
      const b = await db.get("SELECT status, approval_attempts FROM payout_batches WHERE id = ?", [batchId]);
      if (b && b.status === "awaiting_approval" && Number(b.approval_attempts) >= 5) throw httpErr(429, "Too many wrong codes. Request a new approval email.");
      throw httpErr(409, "This batch is not waiting for approval. Request an approval email first.");
    }
    if (Date.now() > Number(batch.approval_expires_at)) throw httpErr(410, "That code has expired. Request a new approval email.");
    const items = await db.all("SELECT * FROM payout_items WHERE batch_id = ?", [batchId]);
    const fp = fingerprintOf(items);
    if (fp !== batch.fingerprint) throw httpErr(409, "The batch changed after the email was sent. Request a new approval email.");
    if (!safeEq(codeHash(batchId, fp, code), batch.approval_hash)) { await audit(actor, "approval_wrong_code", batchId); throw httpErr(403, `Wrong code. ${4 - Number(batch.approval_attempts)} tries left.`); }

    const done = await db.tx(async (t) => {
      const u = await t.run("UPDATE payout_batches SET status = 'approved', approved_at = ?, approval_hash = NULL, approval_expires_at = NULL WHERE id = ? AND status = 'awaiting_approval' AND approval_hash = ?", [Date.now(), batchId, batch.approval_hash]);
      if (u.changes !== 1) return false;
      await t.run("UPDATE payout_items SET status = 'queued', updated_at = ? WHERE batch_id = ? AND status = 'ready'", [Date.now(), batchId]);
      return true;
    });
    if (!done) throw httpErr(409, "This batch was already approved.");
    await audit(actor, "approved", batchId, null, "email code confirmed");
    return db.get("SELECT * FROM payout_batches WHERE id = ?", [batchId]);
  }

  // ------------------------------------------------------------------------------------------------- sending transfers
  const running = new Set();
  const refOf = (item, attempt) => `${PREFIX}-${item.month}-i${item.id}-a${attempt}`;

  // Atomically takes ONE queued item and deducts its stars. Only one worker anywhere can win this.
  async function claimItem(itemId) {
    return db.tx(async (t) => {
      const cur = await t.get("SELECT * FROM payout_items WHERE id = ?", [itemId]);
      if (!cur || cur.status !== "queued") return null;
      if (t.lock) await t.lock("withdraw:" + cur.creator_id);                  // same lock the normal withdrawal route uses
      const hold = async (why) => { await t.run("UPDATE payout_items SET status = 'held', reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [why, Date.now(), itemId]); return null; };
      const flag = await t.get("SELECT banned FROM user_flags WHERE email = ?", [cur.creator_id]);
      const sec = await t.get("SELECT banned, disqualified FROM withdrawal_security WHERE creator_id = ?", [cur.creator_id]);
      if ((flag && Number(flag.banned)) || (sec && (Number(sec.banned) || Number(sec.disqualified)))) return hold("Account is banned or disqualified");
      const rec = await t.get("SELECT * FROM payout_recipients WHERE creator_id = ?", [cur.creator_id]);
      if (!rec || rec.recipient_code !== cur.recipient_code) return hold("Bank details changed after approval. Re-check and re-approve.");
      const bd = await store.starBreakdown(cur.creator_id, t);
      if (bd.withdrawable < Number(cur.stars_spent)) return hold(`Creator no longer has ${Number(cur.stars_spent).toLocaleString()} withdrawable stars`);
      const attempt = Number(cur.attempt) + 1, reference = refOf(cur, attempt);
      const u = await t.run("UPDATE payout_items SET status = 'sending', attempt = ?, transfer_reference = ?, stars_deducted = 1, sent_at = ?, updated_at = ?, reason = NULL WHERE id = ? AND status = 'queued'", [attempt, reference, Date.now(), Date.now(), itemId]);
      if (u.changes !== 1) return null;
      await t.run("INSERT INTO host_stats (host_id, withdrawn_stars) VALUES (?, ?) ON CONFLICT (host_id) DO UPDATE SET withdrawn_stars = host_stats.withdrawn_stars + EXCLUDED.withdrawn_stars", [cur.creator_id, Number(cur.stars_spent)]);
      return { ...cur, attempt, transfer_reference: reference, recipient: rec };
    });
  }

  // moves an item to a new status, but only from the statuses allowed; refunds the stars exactly once for failed/reversed
  async function transition(itemId, fromStatuses, to, fields) {
    return db.tx(async (t) => {
      const cur = await t.get("SELECT * FROM payout_items WHERE id = ?", [itemId]);
      if (!cur || !fromStatuses.includes(cur.status)) return { changed: false, item: cur };
      if (t.lock) await t.lock("withdraw:" + cur.creator_id);
      const f = fields || {}, now = Date.now(), refund = (to === "failed" || to === "reversed" || f.refund) && Number(cur.stars_deducted) === 1;
      const marks = fromStatuses.map(() => "?").join(",");
      const u = await t.run(
        `UPDATE payout_items SET status = ?, reason = ?, paystack_status = COALESCE(?, paystack_status), transfer_code = COALESCE(?, transfer_code),
                stars_deducted = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status IN (${marks})`,
        [to, f.reason != null ? f.reason : null, f.paystackStatus || null, f.transferCode || null, refund ? 0 : Number(cur.stars_deducted), now,
          ["success", "failed", "reversed"].includes(to) ? now : null, itemId, ...fromStatuses]);
      if (u.changes !== 1) return { changed: false, item: cur };
      if (refund) await t.run("UPDATE host_stats SET withdrawn_stars = CASE WHEN withdrawn_stars >= ? THEN withdrawn_stars - ? ELSE 0 END WHERE host_id = ?", [Number(cur.stars_spent), Number(cur.stars_spent), cur.creator_id]);
      return { changed: true, item: { ...cur, status: to }, refunded: refund };
    });
  }
  const afterChange = async (res, kind) => {
    if (!res.changed) return res;
    const it = res.item;
    await audit("paystack", kind, it.batch_id, it.id, `${it.creator_id} ${it.transfer_reference || ""}`);
    if (kind === "success") await notify(it.creator_id, `Your ${it.month} payout of ${money(it.usd)} was sent to your bank account.`);
    if (kind === "failed" || kind === "reversed") {
      await notify(it.creator_id, `Your ${it.month} payout could not be completed (${kind}). Your stars were returned. Please check your bank details.`);
      await mailApprover(`[VicoPay] Payout ${kind}: ${it.creator_id} (${it.month})`, `The ${it.month} payout of ${money(it.usd)} to ${it.creator_id} ${kind}.\nReference: ${it.transfer_reference}\nStars were returned to the creator. Open admin-payouts.html to retry or investigate.`);
    }
    return res;
  };

  // Handles whatever Paystack says about a transfer (from the send response, a webhook or a verify call).
  async function applyPaystackStatus(item, psStatus, extra) {
    const x = extra || {}, s = String(psStatus || "").toLowerCase();
    if (x.amount != null && Number(x.amount) !== Number(item.amount_kobo)) {
      await audit("paystack", "amount_mismatch", item.batch_id, item.id, `paystack ${x.amount} vs ours ${item.amount_kobo}`);
      return transition(item.id, ["sending", "processing", "success", "needs_review"], "needs_review", { reason: `Amount mismatch: Paystack ${x.amount} vs ${item.amount_kobo}`, paystackStatus: s, transferCode: x.transferCode });
    }
    if (s === "success") {
      const r = await transition(item.id, ["sending", "processing", "queued", "needs_review"], "success", { paystackStatus: s, transferCode: x.transferCode, reason: null });
      if (r.changed) return afterChange(r, "success");
      // money really left but we already wrote the transfer off: never auto-fix, a human decides
      if (r.item && ["failed", "reversed"].includes(r.item.status)) {
        return transition(item.id, ["failed", "reversed"], "needs_review", { reason: "Paystack later reported SUCCESS after we marked this failed. Check Paystack before retrying (the stars were already returned).", paystackStatus: s, transferCode: x.transferCode });
      }
      return r;
    }
    if (s === "failed") return afterChange(await transition(item.id, ["sending", "processing", "needs_review"], "failed", { reason: x.reason || "Paystack reported the transfer failed", paystackStatus: s, transferCode: x.transferCode }), "failed");
    if (s === "reversed") return afterChange(await transition(item.id, ["sending", "processing", "success", "needs_review"], "reversed", { reason: x.reason || "Paystack reversed the transfer", paystackStatus: s, transferCode: x.transferCode }), "reversed");
    if (s === "otp") return transition(item.id, ["sending", "processing"], "needs_review", { reason: "Paystack is waiting for an OTP. Turn OFF 'Confirm transfers before sending' in Paystack Settings > Preferences, then press Check on this row.", paystackStatus: s, transferCode: x.transferCode });
    // pending / processing / received / queued
    return transition(item.id, ["sending"], "processing", { paystackStatus: s || "pending", transferCode: x.transferCode });
  }

  async function sendOne(itemId) {
    const item = await claimItem(itemId);
    if (!item) return { sent: false };
    const body = {
      source: "balance", amount: Number(item.amount_kobo), recipient: item.recipient_code, currency: "NGN",
      reference: item.transfer_reference, reason: `VicoPay creator payout ${item.month}`
    };
    let resp;
    try { resp = await ps().request("POST", "/transfer", body); }
    catch (e) {
      // we do not know if Paystack got it: leave it 'sending' (stars stay deducted); reconcile() settles it safely
      await audit("system", "send_unknown", item.batch_id, item.id, e.message);
      return { sent: true, unknown: true };
    }
    const b = resp.body || {}, msg = String(b.message || "");
    if (resp.status >= 200 && resp.status < 300 && b.status === true && b.data) {
      await applyPaystackStatus(item, b.data.status, { transferCode: b.data.transfer_code, amount: b.data.amount });
      return { sent: true };
    }
    if (resp.status >= 500 || resp.status === 408) { await audit("system", "send_unknown", item.batch_id, item.id, `HTTP ${resp.status}`); return { sent: true, unknown: true }; }
    if (/reference/i.test(msg) && /(exist|duplicate|already)/i.test(msg)) { await reconcileItem(item.id, true); return { sent: true }; }
    // Paystack clearly said no. Money did not move. Put the item back and stop on account-wide problems.
    const halting = resp.status === 401 || resp.status === 403 || resp.status === 429 || /balance|insufficient|ip.*whitelist|not allowed|starter business/i.test(msg);
    if (halting) {
      await transition(item.id, ["sending"], "queued", { refund: true, reason: "Stopped: " + msg.slice(0, 200) });
      await audit("paystack", "batch_halted", item.batch_id, item.id, msg);
      return { sent: false, halt: msg || `HTTP ${resp.status}` };
    }
    await afterChange(await transition(item.id, ["sending"], "failed", { reason: msg.slice(0, 250) || `HTTP ${resp.status}`, paystackStatus: "rejected" }), "failed");
    return { sent: false };
  }

  async function executeBatch(batchId, actor) {
    if (running.has(batchId)) return { skipped: true };
    running.add(batchId);
    try {
      const moved = await db.run("UPDATE payout_batches SET status = 'running' WHERE id = ? AND status IN ('approved','running')", [batchId]);
      if (moved.changes !== 1) return { skipped: true };
      await audit(actor, "run_started", batchId);
      let halt = null, sent = 0;
      const queued = await db.all("SELECT id FROM payout_items WHERE batch_id = ? AND status = 'queued' ORDER BY id", [batchId]);
      for (const q of queued) {
        const r = await sendOne(q.id);
        if (r.sent) sent++;
        if (r.halt) { halt = r.halt; break; }
        await sleep(Number(process.env.PAYOUT_SEND_DELAY_MS || 400));
      }
      if (halt) {
        await db.run("UPDATE payout_batches SET status = 'approved' WHERE id = ? AND status = 'running'", [batchId]);
        await mailApprover("[VicoPay] Payout run STOPPED", `The payout run was stopped by Paystack: ${halt}\nNothing was lost; unsent creators are still queued. Fix it (for example top up your Paystack balance), then press Run in admin-payouts.html.`);
        return { sent, halted: halt };
      }
      await finishBatchIfDone(batchId);
      return { sent };
    } finally { running.delete(batchId); }
  }

  async function finishBatchIfDone(batchId) {
    const open = await db.get("SELECT COUNT(*) AS c FROM payout_items WHERE batch_id = ? AND status IN ('queued','sending','processing')", [batchId]);
    if (Number(open.c) > 0) return false;
    const u = await db.run("UPDATE payout_batches SET status = 'completed', completed_at = ? WHERE id = ? AND status IN ('running','approved')", [Date.now(), batchId]);
    if (u.changes !== 1) return false;
    const batch = await db.get("SELECT * FROM payout_batches WHERE id = ?", [batchId]);
    const rows = await db.all("SELECT status, COUNT(*) AS c, COALESCE(SUM(usd),0) AS usd FROM payout_items WHERE batch_id = ? GROUP BY status", [batchId]);
    const line = rows.map((r) => `${r.status}: ${r.c} (${money(r.usd)})`).join("\n");
    await audit("system", "completed", batchId, null, line.replace(/\n/g, "; "));
    await mailApprover(`[VicoPay] ${batch.month} payouts finished`, `The ${batch.month} payout batch has finished.\n\n${line}\n\nAnything marked failed, reversed or needs_review is waiting for you in admin-payouts.html.`);
    return true;
  }

  // Asks Paystack what really happened to a transfer. Used by the admin "Check" button, the scheduler and duplicate-reference replies.
  async function reconcileItem(itemId, force) {
    const item = await db.get("SELECT * FROM payout_items WHERE id = ?", [itemId]);
    if (!item || !item.transfer_reference || !["sending", "processing", "needs_review"].includes(item.status)) return { checked: false };
    let resp;
    try { resp = await ps().request("GET", "/transfer/verify/" + encodeURIComponent(item.transfer_reference)); } catch (e) { return { checked: false, error: e.message }; }
    const b = resp.body || {};
    if (resp.status === 200 && b.status === true && b.data) {
      await applyPaystackStatus(item, b.data.status, { transferCode: b.data.transfer_code, amount: b.data.amount, reason: b.data.reason });
      return { checked: true, paystackStatus: b.data.status };
    }
    if (resp.status === 404) {
      // Paystack has no such transfer. Only trust that after waiting, so a request still in flight can't be missed.
      const age = Date.now() - Number(item.sent_at || 0);
      if (item.status === "sending" && (force || age > 10 * 60000)) {
        if (age < 2 * 60000 && !force) return { checked: true, notFoundYet: true };
        await afterChange(await transition(item.id, ["sending"], "failed", { reason: "Paystack has no record of this transfer (never created).", paystackStatus: "not_found" }), "failed");
        return { checked: true, notFound: true };
      }
      return { checked: true, notFoundYet: true };
    }
    return { checked: false, status: resp.status };
  }

  // ------------------------------------------------------------------------------------------------- webhook (called from server.js)
  async function handleTransferEvent(event) {
    const d = (event && event.data) || {}, name = String(event.event || "");
    if (!/^transfer\.(success|failed|reversed)$/.test(name)) return { ignored: true };
    const ref = String(d.reference || "");
    if (!ref.startsWith(PREFIX + "-")) return { ignored: true };                    // not one of ours
    const key = [name, ref, d.transfer_code || d.id || "", d.updated_at || d.transferred_at || ""].join("|");
    const ins = await db.run("INSERT OR IGNORE INTO payout_events (event_key, event, reference, payload, received_at) VALUES (?,?,?,?,?)", [key, name, ref, JSON.stringify(event).slice(0, 4000), Date.now()]);
    if (ins.changes === 0) return { duplicate: true };
    const item = await db.get("SELECT * FROM payout_items WHERE transfer_reference = ?", [ref]);
    if (!item) { await audit("paystack", "webhook_unknown_reference", null, null, ref); return { unknown: true }; }
    const status = name.split(".")[1];
    const r = await applyPaystackStatus(item, status, { transferCode: d.transfer_code, amount: d.amount, reason: d.reason || (d.gateway_response) });
    await finishBatchIfDone(item.batch_id).catch(() => { });
    return { handled: true, changed: !!(r && r.changed) };
  }

  // ------------------------------------------------------------------------------------------------- creator recipient setup
  const attempts = new Map();
  const tooMany = (k, max, ms) => { const now = Date.now(), a = (attempts.get(k) || []).filter((t) => now - t < ms); if (a.length >= max) { attempts.set(k, a); return true; } a.push(now); attempts.set(k, a); return false; };
  let bankCache = { at: 0, list: [] };
  async function listBanks() {
    if (Date.now() - bankCache.at < 6 * 3600000 && bankCache.list.length) return bankCache.list;
    const r = await ps().request("GET", "/bank?country=nigeria&currency=NGN&perPage=200&use_cursor=false");
    if (!(r.body && r.body.status && Array.isArray(r.body.data))) throw httpErr(502, "Could not load the bank list from Paystack.");
    bankCache = { at: Date.now(), list: r.body.data.filter((b) => b && b.code && b.name && !b.is_deleted).map((b) => ({ code: String(b.code), name: String(b.name) })).sort((a, b) => a.name.localeCompare(b.name)) };
    return bankCache.list;
  }
  async function saveRecipient(email, bankCode, accountNumber) {
    email = lc(email); bankCode = String(bankCode || "").trim(); accountNumber = String(accountNumber || "").replace(/\s/g, "");
    if (!/^\d{10}$/.test(accountNumber)) throw httpErr(400, "Enter your 10-digit account number.");
    if (!/^[0-9]{2,10}$/.test(bankCode)) throw httpErr(400, "Choose your bank.");
    const bank = (await listBanks()).find((b) => b.code === bankCode);
    if (!bank) throw httpErr(400, "That bank is not supported.");
    const sec = await db.get("SELECT banned, disqualified FROM withdrawal_security WHERE creator_id = ?", [email]);
    if (sec && (Number(sec.banned) || Number(sec.disqualified))) throw httpErr(403, "This account cannot receive payouts.");
    const taken = await db.get("SELECT creator_id FROM payout_recipients WHERE bank_code = ? AND account_number = ? AND creator_id <> ?", [bankCode, accountNumber, email]);
    if (taken) throw httpErr(409, "This bank account is already linked to another creator.");
    // 1) Paystack checks the account really exists and tells us the real account holder name
    const rs = await ps().request("GET", `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
    if (!(rs.body && rs.body.status && rs.body.data && rs.body.data.account_name)) throw httpErr(422, "Paystack could not verify that account. Check the bank and number.");
    const accountName = String(rs.body.data.account_name);
    // 2) the transfer recipient Paystack will pay
    const rc = await ps().request("POST", "/transferrecipient", { type: "nuban", name: accountName, account_number: accountNumber, bank_code: bankCode, currency: "NGN" });
    const code = rc.body && rc.body.data && rc.body.data.recipient_code;
    if (!(rc.body && rc.body.status && code)) throw httpErr(502, "Paystack could not create the payout recipient: " + String((rc.body && rc.body.message) || "unknown error"));
    const now = Date.now(), prev = await db.get("SELECT * FROM payout_recipients WHERE creator_id = ?", [email]);
    const changed = !prev || prev.recipient_code !== code;
    await db.run(
      `INSERT INTO payout_recipients (creator_id, bank_code, bank_name, account_number, account_name, recipient_code, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (creator_id) DO UPDATE SET bank_code = EXCLUDED.bank_code, bank_name = EXCLUDED.bank_name, account_number = EXCLUDED.account_number,
         account_name = EXCLUDED.account_name, recipient_code = EXCLUDED.recipient_code, updated_at = ?`,
      [email, bankCode, bank.name, accountNumber, accountName, code, now, now, changed ? now : Number(prev.updated_at)]);
    if (changed) { await audit(email, "recipient_saved", null, null, `${bank.name} ****${accountNumber.slice(-4)}`); if (prev) await mailApprover(`[VicoPay] ${email} changed payout bank details`, `${email} changed their payout account to ${bank.name} ****${accountNumber.slice(-4)} (${accountName}). Payouts for this creator are held for ${cfg().recipientCooldownH} hours.`); }
    return { bankName: bank.name, accountLast4: accountNumber.slice(-4), accountName, cooldownHours: changed && prev ? cfg().recipientCooldownH : 0 };
  }

  // ------------------------------------------------------------------------------------------------- routes
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { if (e.status) return fail(res, e.status, e.message); console.error("payouts:", e.stack || e.message); fail(res, 500, "Something went wrong."); }
  };
  const idParam = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n < 1) throw httpErr(400, "Bad id."); return n; };
  const batchOut = (b) => b && ({
    id: b.id, month: b.month, status: b.status, usdRate: b.usd_rate, itemCount: b.item_count, totalUsd: b.total_usd, totalKobo: b.total_kobo,
    approvalSentAt: b.approval_sent_at, approvalExpiresAt: b.approval_expires_at, approvalAttemptsLeft: Math.max(0, 5 - Number(b.approval_attempts || 0)), approvedAt: b.approved_at, completedAt: b.completed_at, createdAt: b.created_at
  });
  const itemOut = (i) => ({
    id: i.id, creatorId: i.creator_id, stars: i.stars, starsSpent: i.stars_spent, liveDays: i.live_days, daysInMonth: i.days_in_month, usd: i.usd, amountKobo: i.amount_kobo,
    status: i.status, reason: i.reason, bankName: i.bank_name, accountLast4: i.account_last4, accountName: i.account_name, attempt: i.attempt, reference: i.transfer_reference, paystackStatus: i.paystack_status, finishedAt: i.finished_at
  });

  // creator side
  app.get("/api/payouts/banks", requireAuth, wrap(async (req, res) => ok(res, { banks: await listBanks() })));
  app.get("/api/payouts/recipient", requireAuth, wrap(async (req, res) => {
    const r = await db.get("SELECT bank_name, account_number, account_name, updated_at FROM payout_recipients WHERE creator_id = ?", [req.userEmail]);
    ok(res, { recipient: r ? { bankName: r.bank_name, accountLast4: String(r.account_number).slice(-4), accountName: r.account_name, updatedAt: r.updated_at } : null, rules: rules() });
  }));
  app.post("/api/payouts/recipient", requireAuth, wrap(async (req, res) => {
    if (tooMany("rcpt:" + req.userEmail, 5, 3600000)) throw httpErr(429, "Too many tries. Please wait an hour.");
    ok(res, { recipient: await saveRecipient(req.userEmail, req.body && req.body.bankCode, req.body && req.body.accountNumber) });
  }));
  app.get("/api/payouts/history", requireAuth, wrap(async (req, res) => {
    const rows = await db.all("SELECT * FROM payout_items WHERE creator_id = ? AND status <> 'ineligible' ORDER BY month DESC LIMIT 24", [req.userEmail]);
    ok(res, { payouts: rows.map((i) => ({ month: i.month, stars: i.stars, usd: i.usd, status: i.status, reason: ["held", "needs_review"].includes(i.status) ? i.reason : null, finishedAt: i.finished_at })) });
  }));

  // admin side (x-admin-key)
  app.get("/api/admin/payouts/status", requireAdmin, wrap(async (req, res) => {
    const C = cfg();
    ok(res, {
      rules: rules(), month: { current: currentMonth(), payable: previousMonth(), matureAt: matureAt(previousMonth()) }, holdDays: C.holdDays, ngnPerUsd: C.ngnPerUsd,
      approverEmail: C.approverEmail.replace(/^(.).*(@.*)$/, "$1***$2"), emailReady: mailConfigured(), paystackKeySet: !!process.env.PAYSTACK_SECRET_KEY,
      limits: { perCreatorUsd: C.maxItemUsd, perBatchUsd: C.maxBatchUsd }, autoCalculate: C.autoCalculate, autoApprove: C.autoApproveMaxUsd > 0
    });
  }));
  app.get("/api/admin/payouts/balance", requireAdmin, wrap(async (req, res) => {
    const r = await ps().request("GET", "/balance");
    const ngn = ((r.body && r.body.data) || []).find((b) => b.currency === "NGN");
    ok(res, { ngnKobo: ngn ? ngn.balance : null });
  }));
  app.get("/api/admin/payouts/batches", requireAdmin, wrap(async (req, res) => ok(res, { batches: (await db.all("SELECT * FROM payout_batches ORDER BY month DESC LIMIT 36")).map(batchOut) })));
  app.get("/api/admin/payouts/batches/:id", requireAdmin, wrap(async (req, res) => {
    const id = idParam(req), b = await db.get("SELECT * FROM payout_batches WHERE id = ?", [id]);
    if (!b) throw httpErr(404, "Batch not found.");
    const items = await db.all("SELECT * FROM payout_items WHERE batch_id = ? ORDER BY CASE status WHEN 'ineligible' THEN 1 ELSE 0 END, usd DESC, creator_id", [id]);
    const log = await db.all("SELECT at, actor, action, item_id, detail FROM payout_audit WHERE batch_id = ? ORDER BY id DESC LIMIT 60", [id]);
    ok(res, { batch: batchOut(b), items: items.map(itemOut), audit: log });
  }));
  // preview = just show the numbers (works any time); save = create the batch (only for a finished month)
  app.post("/api/admin/payouts/calculate", requireAdmin, wrap(async (req, res) => {
    const month = String((req.body && req.body.month) || previousMonth());
    if (!MONTH_RE.test(month)) throw httpErr(400, "Month must look like 2026-09.");
    if (req.body && req.body.preview) {
      const ev = await evaluateMonth(month);
      return ok(res, { preview: true, month, mature: isMature(month), matureAt: matureAt(month), items: ev.rows.map((r) => ({ creatorId: r.creator_id, stars: r.stars, liveDays: r.liveDays, daysInMonth: r.daysInMonth, usd: r.usd, amountKobo: r.amount_kobo, status: r.status, reason: r.reason, bankName: r.bank_name, accountLast4: r.account_last4 })) });
    }
    ok(res, { batch: batchOut(await calculateAndSave(month, "admin")) });
  }));
  app.post("/api/admin/payouts/batches/:id/request-approval", requireAdmin, wrap(async (req, res) => ok(res, await requestApproval(idParam(req), "admin"))));
  app.post("/api/admin/payouts/batches/:id/confirm", requireAdmin, wrap(async (req, res) => {
    const id = idParam(req), b = await confirmApproval(id, req.body && req.body.code, "admin");
    setImmediate(() => executeBatch(id, "admin").catch((e) => console.error("payout run:", e.message)));   // money starts moving only after the code is right
    ok(res, { batch: batchOut(b), message: "Approved. Sending transfers now." });
  }));
  app.post("/api/admin/payouts/batches/:id/run", requireAdmin, wrap(async (req, res) => {
    const id = idParam(req), b = await db.get("SELECT status FROM payout_batches WHERE id = ?", [id]);
    if (!b || !["approved", "running"].includes(b.status)) throw httpErr(409, "Only an approved batch can be run.");
    setImmediate(() => executeBatch(id, "admin").catch((e) => console.error("payout run:", e.message)));
    ok(res, { message: "Run started." });
  }));
  app.post("/api/admin/payouts/batches/:id/cancel", requireAdmin, wrap(async (req, res) => {
    const id = idParam(req), u = await db.run("UPDATE payout_batches SET status = 'cancelled', approval_hash = NULL WHERE id = ? AND status IN ('draft','awaiting_approval')", [id]);
    if (u.changes !== 1) throw httpErr(409, "Only a batch that is not yet approved can be cancelled.");
    await audit("admin", "cancelled", id); ok(res, {});
  }));
  app.post("/api/admin/payouts/items/:id/check", requireAdmin, wrap(async (req, res) => ok(res, await reconcileItem(idParam(req), true))));
  app.post("/api/admin/payouts/items/:id/retry", requireAdmin, wrap(async (req, res) => {
    const id = idParam(req), it = await db.get("SELECT i.*, b.status AS batch_status FROM payout_items i JOIN payout_batches b ON b.id = i.batch_id WHERE i.id = ?", [id]);
    if (!it) throw httpErr(404, "Not found.");
    if (!["approved", "running", "completed"].includes(it.batch_status)) throw httpErr(409, "The batch is not approved.");
    if (!["failed", "reversed", "held"].includes(it.status)) throw httpErr(409, "Only failed, reversed or held payouts can be retried.");
    if (Number(it.attempt) >= 3) throw httpErr(409, "Already tried 3 times. Investigate in Paystack first.");
    const u = await db.run("UPDATE payout_items SET status = 'queued', reason = NULL, updated_at = ?, finished_at = NULL WHERE id = ? AND status IN ('failed','reversed','held') AND stars_deducted = 0", [Date.now(), id]);
    if (u.changes !== 1) throw httpErr(409, "This payout cannot be retried right now.");
    await db.run("UPDATE payout_batches SET status = 'approved', completed_at = NULL WHERE id = ? AND status = 'completed'", [it.batch_id]);
    await audit("admin", "retry", it.batch_id, id);
    setImmediate(() => executeBatch(it.batch_id, "admin").catch((e) => console.error("payout run:", e.message)));
    ok(res, { message: "Queued again." });
  }));

  // ------------------------------------------------------------------------------------------------- background jobs
  async function tick() {
    // settle transfers that never got a webhook
    const stale = await db.all("SELECT id FROM payout_items WHERE status IN ('sending','processing') AND updated_at < ? LIMIT 50", [Date.now() - 5 * 60000]);
    for (const s of stale) { await reconcileItem(s.id, false).catch(() => { }); await sleep(200); }
    // resume batches interrupted by a restart
    const live = await db.all("SELECT id FROM payout_batches WHERE status IN ('running','approved')");
    for (const b of live) { await finishBatchIfDone(b.id).catch(() => { }); }
    const C = cfg();
    if (C.autoCalculate) {
      const month = previousMonth();
      if (isMature(month) && !(await db.get("SELECT 1 AS x FROM payout_batches WHERE month = ?", [month]))) {
        const b = await calculateAndSave(month, "scheduler");
        if (b.item_count > 0) {
          if (C.autoApproveMaxUsd > 0 && Number(b.total_usd) <= C.autoApproveMaxUsd) await autoApprove(b.id);
          else await requestApproval(b.id, "scheduler");
        }
      }
    }
  }
  // Only used when PAYOUT_AUTO_APPROVE_MAX_USD is set. Still capped, still audited, and you are still emailed.
  async function autoApprove(batchId) {
    const u = await db.run("UPDATE payout_batches SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'draft'", [Date.now(), batchId]);
    if (u.changes !== 1) return;
    await db.run("UPDATE payout_items SET status = 'queued', updated_at = ? WHERE batch_id = ? AND status = 'ready'", [Date.now(), batchId]);
    await audit("scheduler", "auto_approved", batchId, null, `under ${money(cfg().autoApproveMaxUsd)} cap`);
    await mailApprover("[VicoPay] Payouts auto-approved", `Batch ${batchId} was within your auto-approval limit and is being sent now.`);
    setImmediate(() => executeBatch(batchId, "scheduler").catch(() => { }));
  }
  function start() {
    const t = setInterval(() => tick().catch((e) => console.error("payout tick:", e.message)), 10 * 60000); t.unref();
    setTimeout(() => tick().catch((e) => console.error("payout tick:", e.message)), 45000).unref();
  }

  return {
    migrate, start, handleTransferEvent, isPayoutReference: (ref) => String(ref || "").startsWith(PREFIX + "-"),
    // exported for tests
    _t: { calcUnits, calcUsd, liveHoursPerDay, monthWindow, evaluateMonth, calculateAndSave, requestApproval, confirmApproval, executeBatch, reconcileItem, saveRecipient, applyPaystackStatus, tick, finishBatchIfDone }
  };
};
