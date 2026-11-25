// =====================================================
// Vico Pay Live — WALLET SECURITY: Wallet PIN, email OTP (through Resend), limits, new-device check
// =====================================================
// Order of protection (the order you chose):
//   1. Wallet PIN (4 digits)         create / confirm / change / verify; 5 wrong tries = temporary lock (and it grows if it repeats)
//   2. OTP by email (Resend)         the SAME Resend setup your server already uses (RESEND_API_KEY + MAIL_FROM); needed to create or reset the PIN,
//                                    and for high-risk actions: big withdrawals, a new device, or the first day after the PIN changed
//   3. Limits + final server check   per-withdrawal limit and 24-hour limit; the existing withdrawal code still checks balance and account status
//   4. New device                    a browser Vico has not seen for this account must pass an email OTP
// Fingerprint / Face ID is the next layer (needs passkeys), not part of this file.
//
// How money-out is protected without editing every page:
//   * POST /api/wallet-security/authorize checks PIN (+ OTP when needed) and returns a short-lived token.
//   * A guard in front of the money routes (withdrawals, paid gifts) refuses the request unless it carries that token (header x-wallet-auth).
//   * auth.js sees the "walletAuthRequired" answer on any page, opens the PIN screen (vico-pin.js), and repeats the request by itself.
//
// .env (all optional): WALLET_SECURITY=off (emergency switch), WALLET_MAX_WITHDRAW=500000, WALLET_DAILY_WITHDRAW=1000000, WALLET_OTP_ABOVE=20000
// New tables only: wallet_pins, wallet_otps, wallet_auth, wallet_devices, wallet_events.
// =====================================================
const crypto = require("crypto");

const OTP_MINUTES = 10, MAX_WRONG_OTP = 5, OTP_COOLDOWN_MS = 60 * 1000, MAX_OTP_PER_HOUR = 5, MAX_WRONG_PIN = 5;
const TOKEN_MS = { withdraw: 5 * 60000, gift: 10 * 60000, wallet: 10 * 60000 }, TOKEN_USES = { withdraw: 1, gift: 300, wallet: 5000 }, COOL_OFF_MS = 24 * 3600000;
const ACTIONS = ["withdraw", "gift", "wallet"];   // "wallet" = opening the VicoPay Wallet page (PIN + email code, then open for WALLET_OPEN minutes)

// ---- pure rules (tested) ----
function validPin(p) {
  p = String(p == null ? "" : p);
  if (!/^\d{4}$/.test(p)) return "Your PIN must be exactly 4 digits.";
  if (/^(\d)\1{3}$/.test(p)) return "Choose a PIN that is not the same digit four times.";
  if ("0123456789".includes(p) || "9876543210".includes(p)) return "Choose a PIN that is not a simple run like 1234.";
  return "";
}
const lockMinutes = (n) => Math.min(24 * 60, 30 * Math.pow(2, Math.max(0, (Number(n) || 1) - 1)));   // 30 min, then 1 h, 2 h ... up to 24 h
const maskEmail = (e) => { e = String(e || ""); const [u, d] = e.split("@"); return d ? u.slice(0, 2) + "•".repeat(Math.max(2, Math.min(6, u.length - 2))) + "@" + d : e; };
function limitError({ amount, maxTx, daily, usedToday }) {
  if (amount > maxTx) return "The most you can withdraw at one time is ₦" + maxTx.toLocaleString() + ".";
  if (usedToday + amount > daily) return "You have reached your 24-hour withdrawal limit of ₦" + daily.toLocaleString() + (usedToday ? " (₦" + usedToday.toLocaleString() + " already used)." : ".");
  return "";
}
// when a one-time code is also needed ("" = PIN is enough)
function otpReason({ action, amount, otpAbove, newDevice, justChanged }) {
  if (action === "wallet") return "wallet";   // opening the wallet always needs the email code as well as the PIN
  if (newDevice) return "device"; if (justChanged) return "cooloff";
  if (action === "withdraw" && amount >= otpAbove) return "amount"; return "";
}
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const scrypt = (pin, salt, pepper) => new Promise((ok, no) => crypto.scrypt(String(pin), salt + ":" + pepper, 32, { N: 16384 }, (e, k) => (e ? no(e) : ok(k.toString("hex")))));
const pepper = () => process.env.AUTH_SECRET || "vico-dev-pepper";

module.exports = function makeWalletSecurity({ app, db, requireAuth, getAuthEmail }) {
  const now = () => Date.now(), lc = (v) => String(v || "").trim().toLowerCase();
  const bad = (res, code, msg, extra) => res.status(code).json({ success: false, message: msg, ...(extra || {}) });
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const cfg = () => ({ enabled: process.env.WALLET_SECURITY !== "off", maxTx: num(process.env.WALLET_MAX_WITHDRAW, 500000), daily: num(process.env.WALLET_DAILY_WITHDRAW, 1000000), otpAbove: num(process.env.WALLET_OTP_ABOVE, 20000) });
  const notify = (email, text) => db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [email, String(text).slice(0, 200), "vico-wallet.html", now()]).catch(() => {});
  const audit = (email, event, detail, req) => db.run("INSERT INTO wallet_events (email, event, detail, ip, created_at) VALUES (?,?,?,?,?)", [email, event, String(detail || "").slice(0, 200), req && req.ip ? String(req.ip).slice(0, 60) : null, now()]).catch(() => {});
  const deviceOf = (req) => { const d = String(req.headers["x-device-id"] || "").trim(); return /^[a-zA-Z0-9_-]{16,80}$/.test(d) ? sha("dev:" + d) : ""; };

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS wallet_pins (email TEXT PRIMARY KEY, salt TEXT NOT NULL, pin_hash TEXT NOT NULL, failed INTEGER NOT NULL DEFAULT 0, lock_count INTEGER NOT NULL DEFAULT 0, locked_until BIGINT NOT NULL DEFAULT 0, pin_changed_at BIGINT NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wallet_otps (email TEXT NOT NULL, purpose TEXT NOT NULL, salt TEXT, code_hash TEXT, expires_at BIGINT, wrong_tries INTEGER NOT NULL DEFAULT 0, sends_hour_start BIGINT NOT NULL DEFAULT 0, sends_in_hour INTEGER NOT NULL DEFAULT 0, last_sent_at BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (email, purpose))`,
    `CREATE TABLE IF NOT EXISTS wallet_auth (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, action TEXT NOT NULL, amount BIGINT NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_wallet_auth_email ON wallet_auth(email, action, created_at)`,
    `CREATE TABLE IF NOT EXISTS wallet_devices (email TEXT NOT NULL, device_hash TEXT NOT NULL, first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL, PRIMARY KEY (email, device_hash))`,
    `CREATE TABLE IF NOT EXISTS wallet_events (id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, event TEXT NOT NULL, detail TEXT, ip TEXT, created_at BIGINT NOT NULL)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727284)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727284)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("WALLET SECURITY MIGRATE ERROR:", e); });

  // ---- email through Resend (same settings as password reset / email verification) ----
  const mailReady = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
  async function sendMail(to, subject, html, text) {
    if (!mailReady()) { if (process.env.NODE_ENV === "production") { const e = new Error("mail not set up"); e.code = "no_mail"; throw e; } console.log("WALLET EMAIL (Resend is not set up) to " + to + ": " + text); return "console"; }
    await require("axios").post("https://api.resend.com/emails", { from: process.env.MAIL_FROM, to: [to], subject, html, text }, { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY }, timeout: 12000 }); return "email";
  }
  const shell = (title, body) => '<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;background:#0b2a5b;color:#fff;padding:26px;border-radius:18px;text-align:center"><h2 style="margin:0 0 6px;color:#9fd3ff">Vico Wallet</h2><p style="color:#cfe6ff;margin:0 0 8px">' + title + "</p>" + body + "</div>";
  const WHY = { set_pin: "create your Wallet PIN", change_pin: "change your Wallet PIN", reset_pin: "reset your Wallet PIN", authorize: "approve a wallet transaction" };
  async function sendOtp(email, purpose, extra) {
    await ready; const t = now(), row = await db.get("SELECT last_sent_at, sends_hour_start, sends_in_hour FROM wallet_otps WHERE email = ? AND purpose = ?", [email, purpose]);
    if (row) {
      const wait = Number(row.last_sent_at) + OTP_COOLDOWN_MS - t; if (wait > 0) return { wait: Math.ceil(wait / 1000) };
      if (t - Number(row.sends_hour_start) < 3600000 && Number(row.sends_in_hour) >= MAX_OTP_PER_HOUR) return { tooMany: true };
    }
    const code = makeCode(), salt = crypto.randomBytes(12).toString("hex"), newHour = !row || t - Number(row.sends_hour_start) >= 3600000;
    await db.run(`INSERT INTO wallet_otps (email, purpose, salt, code_hash, expires_at, wrong_tries, sends_hour_start, sends_in_hour, last_sent_at) VALUES (?,?,?,?,?,0,?,1,?)
      ON CONFLICT (email, purpose) DO UPDATE SET salt = EXCLUDED.salt, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, wrong_tries = 0, sends_hour_start = ?, sends_in_hour = ?, last_sent_at = EXCLUDED.last_sent_at`,
      [email, purpose, salt, sha(salt + ":" + code), t + OTP_MINUTES * 60000, t, t, newHour ? t : Number(row.sends_hour_start), newHour ? 1 : Number(row.sends_in_hour) + 1]);
    const why = WHY[purpose] + (extra ? " (" + extra + ")" : "");
    await sendMail(email, "Your Vico Wallet code " + code,
      shell("Use this code to " + why, '<div style="font-size:38px;font-weight:900;letter-spacing:8px;background:#1d4fa8;border-radius:12px;padding:14px;margin:12px 0">' + code + '</div><p style="color:#cfe6ff;font-size:13px">It works for ' + OTP_MINUTES + " minutes. Vico will never call or message you to ask for this code. If you did not ask for it, ignore this email and do not share it.</p>"),
      "Your Vico Wallet code is " + code + " (to " + why + "). It works for " + OTP_MINUTES + " minutes. Never share it.");
    return { sent: true };
  }
  async function checkOtp(email, purpose, code) {   // consumes the code when it is right
    await ready; code = String(code || "").trim(); if (!/^\d{6}$/.test(code)) return { error: "Enter the 6-digit code from your email." };
    const r = await db.get("SELECT salt, code_hash, expires_at, wrong_tries FROM wallet_otps WHERE email = ? AND purpose = ?", [email, purpose]);
    if (!r || !r.code_hash) return { error: "Ask for a code first." }; if (now() > Number(r.expires_at)) return { error: "That code has expired. Ask for a new one." };
    if (Number(r.wrong_tries) >= MAX_WRONG_OTP) return { error: "Too many wrong tries. Ask for a new code." };
    if (!safeEq(sha(r.salt + ":" + code), r.code_hash)) { await db.run("UPDATE wallet_otps SET wrong_tries = wrong_tries + 1 WHERE email = ? AND purpose = ?", [email, purpose]); return { error: "That code is not right." }; }
    await db.run("UPDATE wallet_otps SET code_hash = NULL, salt = NULL WHERE email = ? AND purpose = ?", [email, purpose]); return { ok: true };
  }
  const mailErr = (res, e) => { console.error("WALLET OTP ERROR:", e.response ? JSON.stringify(e.response.data) : e.message); return bad(res, e.code === "no_mail" ? 503 : 502, e.code === "no_mail" ? "Email is not set up yet, so a code cannot be sent." : "We could not send the email right now. Please try again in a moment."); };
  const alertMail = (email, subject, line) => sendMail(email, subject, shell(subject, '<p style="font-size:15px">' + line + '</p><p style="color:#cfe6ff;font-size:13px">If this was not you, change your password and contact Vico support now.</p>'), subject + ". " + line).catch(() => {});

  // ---- PIN helpers ----
  const pinRow = (email) => db.get("SELECT salt, pin_hash AS hash, failed, lock_count AS locks, locked_until AS until, pin_changed_at AS changed FROM wallet_pins WHERE email = ?", [email]);
  async function savePin(email, pin) {
    const salt = crypto.randomBytes(12).toString("hex"), hash = await scrypt(pin, salt, pepper()), t = now();
    await db.run(`INSERT INTO wallet_pins (email, salt, pin_hash, failed, lock_count, locked_until, pin_changed_at, created_at) VALUES (?,?,?,0,0,0,?,?)
      ON CONFLICT (email) DO UPDATE SET salt = EXCLUDED.salt, pin_hash = EXCLUDED.pin_hash, failed = 0, lock_count = 0, locked_until = 0, pin_changed_at = EXCLUDED.pin_changed_at`, [email, salt, hash, t, t]);
  }
  // returns {ok} | {locked, until} | {wrong, left, justLocked}
  async function tryPin(email, row, pin) {
    if (Number(row.until) > now()) return { locked: true, until: Number(row.until) };
    const good = /^\d{4}$/.test(String(pin)) && safeEq(await scrypt(pin, row.salt, pepper()), row.hash);
    if (good) { if (Number(row.failed) || Number(row.locks)) await db.run("UPDATE wallet_pins SET failed = 0, lock_count = 0 WHERE email = ?", [email]); return { ok: true }; }
    const failed = Number(row.failed) + 1;
    if (failed >= MAX_WRONG_PIN) {
      const locks = Number(row.locks) + 1, until = now() + lockMinutes(locks) * 60000;
      await db.run("UPDATE wallet_pins SET failed = 0, lock_count = ?, locked_until = ? WHERE email = ?", [locks, until, email]);
      alertMail(email, "Your Wallet PIN is locked", "There were " + MAX_WRONG_PIN + " wrong PIN tries on your Vico Wallet. It is locked for " + lockMinutes(locks) + " minutes.");
      return { wrong: true, left: 0, justLocked: true, until };
    }
    await db.run("UPDATE wallet_pins SET failed = ? WHERE email = ?", [failed, email]); return { wrong: true, left: MAX_WRONG_PIN - failed };
  }
  const pinFail = (res, r) => r.locked || r.justLocked ? bad(res, 423, "Too many wrong PINs. Your wallet is locked for " + Math.max(1, Math.ceil((r.until - now()) / 60000)) + " minutes.", { locked: true, lockedUntil: r.until })
    : bad(res, 403, "That PIN is not right. " + r.left + " " + (r.left === 1 ? "try" : "tries") + " left before a temporary lock.", { wrongPin: true, attemptsLeft: r.left });
  const touchDevice = (email, dev) => dev ? db.run("INSERT INTO wallet_devices (email, device_hash, first_seen, last_seen) VALUES (?,?,?,?) ON CONFLICT (email, device_hash) DO UPDATE SET last_seen = EXCLUDED.last_seen", [email, dev, now(), now()]) : null;
  const pinsOk = (b) => { const e = validPin(b.newPin != null ? b.newPin : b.pin); if (e) return e; if (String(b.confirm) !== String(b.newPin != null ? b.newPin : b.pin)) return "The two PINs do not match."; return ""; };

  // ---- endpoints ----
  app.get("/api/wallet-security/status", requireAuth, async (req, res) => {
    try { await ready; const c = cfg(), r = await pinRow(req.userEmail), dev = deviceOf(req);
      const known = dev ? await db.get("SELECT 1 AS x FROM wallet_devices WHERE email = ? AND device_hash = ?", [req.userEmail, dev]) : null;
      res.json({ success: true, enabled: c.enabled, hasPin: !!r, locked: !!(r && Number(r.until) > now()), lockedUntil: r ? Number(r.until) : 0, deviceKnown: !!known, maskedEmail: maskEmail(req.userEmail), limits: { maxTx: c.maxTx, daily: c.daily, otpAbove: c.otpAbove }, mailReady: mailReady() });
    } catch (e) { bad(res, 500, "Could not load wallet security."); } });

  app.post("/api/wallet-security/otp/send", requireAuth, async (req, res) => {
    try { const purpose = String((req.body && req.body.purpose) || ""); if (!WHY[purpose]) return bad(res, 400, "Unknown request.");
      await ready; const has = !!(await pinRow(req.userEmail));
      if (purpose === "set_pin" && has) return bad(res, 400, "You already have a Wallet PIN."); if ((purpose === "change_pin" || purpose === "reset_pin") && !has) return bad(res, 400, "Create a Wallet PIN first.");
      const r = await sendOtp(req.userEmail, purpose, null);
      if (r.wait) return bad(res, 429, "Please wait " + r.wait + " seconds before asking for another code.", { waitSeconds: r.wait }); if (r.tooMany) return bad(res, 429, "Too many codes requested. Please try again in an hour.");
      res.json({ success: true, sent: true, maskedEmail: maskEmail(req.userEmail), cooldownSeconds: OTP_COOLDOWN_MS / 1000 });
    } catch (e) { mailErr(res, e); } });

  app.post("/api/wallet-security/pin/set", requireAuth, async (req, res) => {   // create + confirm (the email code stops a stolen login from setting its own PIN)
    try { await ready; const b = req.body || {}; if (await pinRow(req.userEmail)) return bad(res, 400, "You already have a Wallet PIN.");
      const e = pinsOk(b); if (e) return bad(res, 400, e); const o = await checkOtp(req.userEmail, "set_pin", b.otp); if (o.error) return bad(res, 400, o.error);
      await savePin(req.userEmail, String(b.pin)); await touchDevice(req.userEmail, deviceOf(req)); audit(req.userEmail, "pin_created", "", req);
      alertMail(req.userEmail, "Your Wallet PIN was created", "A Wallet PIN was created on your Vico Wallet."); res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your PIN."); } });

  app.post("/api/wallet-security/pin/change", requireAuth, async (req, res) => {   // current PIN + email code
    try { await ready; const b = req.body || {}, row = await pinRow(req.userEmail); if (!row) return bad(res, 400, "Create a Wallet PIN first.");
      const e = pinsOk({ newPin: b.newPin, confirm: b.confirm }); if (e) return bad(res, 400, e);
      if (String(b.newPin) === String(b.currentPin)) return bad(res, 400, "Your new PIN must be different from the old one.");
      const r = await tryPin(req.userEmail, row, b.currentPin); if (!r.ok) return pinFail(res, r);
      const o = await checkOtp(req.userEmail, "change_pin", b.otp); if (o.error) return bad(res, 400, o.error);
      await savePin(req.userEmail, String(b.newPin)); audit(req.userEmail, "pin_changed", "", req);
      alertMail(req.userEmail, "Your Wallet PIN was changed", "Your Vico Wallet PIN was changed. For your safety, withdrawals need an email code for the next 24 hours."); res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not change your PIN."); } });

  app.post("/api/wallet-security/pin/reset", requireAuth, async (req, res) => {   // forgot PIN: email code only, then 24 hours of extra checks
    try { await ready; const b = req.body || {}; if (!(await pinRow(req.userEmail))) return bad(res, 400, "Create a Wallet PIN first.");
      const e = pinsOk({ newPin: b.newPin, confirm: b.confirm }); if (e) return bad(res, 400, e); const o = await checkOtp(req.userEmail, "reset_pin", b.otp); if (o.error) return bad(res, 400, o.error);
      await savePin(req.userEmail, String(b.newPin)); audit(req.userEmail, "pin_reset", "", req);
      alertMail(req.userEmail, "Your Wallet PIN was reset", "Your Vico Wallet PIN was reset with an email code. For your safety, withdrawals need an email code for the next 24 hours."); res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not reset your PIN."); } });

  app.post("/api/wallet-security/pin/verify", requireAuth, async (req, res) => {
    try { await ready; const row = await pinRow(req.userEmail); if (!row) return bad(res, 400, "Create a Wallet PIN first.", { needPinSetup: true });
      const r = await tryPin(req.userEmail, row, req.body && req.body.pin); if (!r.ok) return pinFail(res, r); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not check your PIN."); } });

  // the main gate: PIN -> (OTP) -> limits -> short-lived token
  app.post("/api/wallet-security/authorize", requireAuth, async (req, res) => {
    try { await ready; const c = cfg(), b = req.body || {}, action = b.action, email = req.userEmail, amount = Math.floor(Number(b.amount) || 0);
      if (!ACTIONS.includes(action)) return bad(res, 400, "Unknown request."); if (action === "withdraw" && !(amount > 0)) return bad(res, 400, "Enter the amount first.");
      const row = await pinRow(email); if (!row) return bad(res, 400, "Create your Wallet PIN first.", { needPinSetup: true });
      const r = await tryPin(email, row, b.pin); if (!r.ok) return pinFail(res, r);
      if (action === "withdraw") {
        const used = await db.get("SELECT COALESCE(SUM(amount),0) AS s FROM wallet_auth WHERE email = ? AND action = 'withdraw' AND uses > 0 AND created_at > ?", [email, now() - 24 * 3600000]);
        const le = limitError({ amount, maxTx: c.maxTx, daily: c.daily, usedToday: Number(used.s) }); if (le) return bad(res, 400, le, { limit: true });
      }
      const dev = deviceOf(req), known = dev ? await db.get("SELECT 1 AS x FROM wallet_devices WHERE email = ? AND device_hash = ?", [email, dev]) : null;
      const recent = await db.get("SELECT 1 AS x FROM wallet_events WHERE email = ? AND event IN ('pin_changed','pin_reset') AND created_at > ?", [email, now() - COOL_OFF_MS]);
      const reason = otpReason({ action, amount, otpAbove: c.otpAbove, newDevice: !known, justChanged: !!recent });
      if (reason) {
        if (!b.otp) {
          const s = await sendOtp(email, "authorize", action === "withdraw" ? "withdrawal of ₦" + amount.toLocaleString() : action === "wallet" ? "opening your wallet" : "paid gift");
          return res.json({ success: false, otpRequired: true, reason, maskedEmail: maskEmail(email), cooldownSeconds: s.wait || OTP_COOLDOWN_MS / 1000, tooMany: !!s.tooMany });
        }
        const o = await checkOtp(email, "authorize", b.otp); if (o.error) return bad(res, 400, o.error, { wrongOtp: true });
      }
      await touchDevice(email, dev);
      const token = crypto.randomBytes(32).toString("hex");
      await db.run("INSERT INTO wallet_auth (token_hash, email, action, amount, expires_at, uses, max_uses, created_at) VALUES (?,?,?,?,?,0,?,?)", [sha(token), email, action, action === "withdraw" ? amount : 0, now() + TOKEN_MS[action], TOKEN_USES[action], now()]);
      audit(email, "authorized_" + action, amount ? "₦" + amount : "", req);
      res.json({ success: true, token, expiresInSeconds: TOKEN_MS[action] / 1000 });
    } catch (e) { if (e && e.code === "no_mail") return mailErr(res, e); console.error(e); bad(res, 500, "Could not check your security details."); } });

  // ---- the guard in front of money-out routes ----
  const GUARDED = [["/api/creator/withdrawal/request", "withdraw"], ["/api/seller/withdraw", "withdraw"], ["/api/gifts/send", "gift"], ["/api/live/send-gift", "gift"]];
  function guard() {
    for (const [path, action] of GUARDED) {
      app.post(path, async (req, res, next) => {
        try {
          if (!cfg().enabled) return next();
          const email = getAuthEmail(req); if (!email) return next();   // not signed in: the route's own check answers
          await ready; const need = (extra) => res.status(428).json({ success: false, walletAuthRequired: true, action, hasPin: !!extra.hasPin, message: extra.message || "Enter your Wallet PIN to continue." });
          const raw = String(req.headers["x-wallet-auth"] || "");
          if (!raw) return need({ hasPin: !!(await pinRow(email)) });
          const amount = action === "withdraw" ? Math.floor(Number(req.body && req.body.amount) || 0) : 0, h = sha(raw);
          const got = await db.get("UPDATE wallet_auth SET uses = uses + 1 WHERE token_hash = ? AND email = ? AND action = ? AND amount = ? AND expires_at > ? AND uses < max_uses RETURNING uses", [h, email, action, amount, now()]);
          if (!got) return need({ hasPin: true, message: "Please confirm with your Wallet PIN again." });
          const json = res.json.bind(res);   // a request that fails afterwards (e.g. low balance) gives the single-use token back
          res.json = function (body) {
            try {
              if (!body || body.success === false || res.statusCode >= 400) { if (action === "withdraw") db.run("UPDATE wallet_auth SET uses = GREATEST(0, uses - 1) WHERE token_hash = ?", [h]).catch(() => {}); }
              else if (action === "withdraw") { notify(email, "Your withdrawal request of ₦" + amount.toLocaleString() + " was received.");
                alertMail(email, "Withdrawal request received", "We received your withdrawal request of ₦" + amount.toLocaleString() + " from your Vico Wallet at " + new Date().toUTCString() + "."); audit(email, "withdraw_requested", "₦" + amount, req); }
            } catch (_) { /* never block the answer */ }
            return json(body);
          };
          return next();
        } catch (e) { console.error("WALLET GUARD ERROR:", e); return res.status(503).json({ success: false, message: "Wallet security is not available right now. Please try again." }); }
      });
    }
  }
  // Door for the VicoPay Wallet page (used by vico-wallet.js): the request must carry a "wallet" token that came from PIN + email code.
  // Unlike the money-out guard the token is reusable for its 10 minutes, so the page can load its balance, history and recharge without asking again.
  function unlock(action) {
    return async (req, res, next) => {
      try {
        if (!cfg().enabled) return next();
        const email = lc(req.userEmail || (getAuthEmail && getAuthEmail(req))); if (!email) return next();   // not signed in: the route's own check answers
        await ready;
        const need = async (message) => res.status(428).json({ success: false, walletAuthRequired: true, action, hasPin: !!(await pinRow(email)), message: message || "Enter your Wallet PIN to open your wallet." });
        const raw = String(req.headers["x-wallet-auth"] || ""); if (!raw) return need();
        const got = await db.get("UPDATE wallet_auth SET uses = uses + 1 WHERE token_hash = ? AND email = ? AND action = ? AND expires_at > ? AND uses < max_uses RETURNING uses", [sha(raw), email, action, now()]);
        if (!got) return need("Your wallet was locked. Enter your PIN again.");
        return next();
      } catch (e) { console.error("WALLET UNLOCK ERROR:", e); return res.status(503).json({ success: false, message: "Wallet security is not available right now. Please try again." }); }
    };
  }
  return { ready, guard, unlock };
};
Object.assign(module.exports, { validPin, lockMinutes, maskEmail, limitError, otpReason });
