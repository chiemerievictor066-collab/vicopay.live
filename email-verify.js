// =====================================================
// Vico Pay Live — EMAIL VERIFICATION (through Resend)
// =====================================================
// Replaces phone/SMS verification. A signed-in user asks for a 6-digit code, it is emailed with Resend, and typing it proves the inbox is real.
// Used by Invite Friends: an invited friend only qualifies after their email is verified.
//
// .env settings (the ones you already have for password-reset emails):
//   RESEND_API_KEY          your Resend API key
//   MAIL_FROM               the sender, e.g.  Vico Pay <no-reply@yourdomain.com>   (a domain verified in Resend)
//   RESEND_WEBHOOK_SECRET   the signing secret ("whsec_...") of your Resend webhook  (also accepted: RESEND_WEBHOOK_SIGNING_SECRET)
//   INBOX_FORWARD_TO        your real inbox: mail sent to your Resend receiving address is forwarded here (email.received)
//
// Resend webhook: in the Resend dashboard add ONE webhook to   https://YOUR-SITE/api/resend/webhook   with the events
//   email.received, email.delivered, email.bounced, email.complained.
// A bounced or complained address is recorded, and a pending referral that used it is rejected (a fake email can never qualify).
//
// New tables only: email_verifications, email_delivery. Nothing in `users` is changed.
// =====================================================
const crypto = require("crypto");

const CODE_MINUTES = 15, MAX_WRONG = 5, RESEND_COOLDOWN_MS = 60 * 1000, MAX_SENDS_PER_HOUR = 5, WEBHOOK_TOLERANCE_S = 300;

// ---- pure helpers (tested) ----
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const hashCode = (salt, code) => sha(salt + ":" + String(code).trim());
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Resend signs webhooks with Svix:  signature = base64( HMAC-SHA256( secretBytes, id + "." + timestamp + "." + rawBody ) ), header "v1,<sig> v1,<sig2>"
function verifyWebhook({ secret, id, timestamp, signature, rawBody, nowMs }) {
  if (!secret || !id || !timestamp || !signature || !rawBody) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(((nowMs || Date.now()) / 1000) - ts) > WEBHOOK_TOLERANCE_S) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(id + "." + timestamp + "." + rawBody.toString("utf8")).digest("base64");
  return String(signature).split(" ").some((part) => { const [v, sig] = part.split(","); return v === "v1" && sig && safeEq(sig, expected); });
}

module.exports = function makeEmailVerify({ app, db, requireAuth, onBounce }) {
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const bad = (res, msg, code, extra) => res.status(code || 400).json({ success: false, message: msg, ...(extra || {}) });

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS email_verifications (
      email TEXT PRIMARY KEY,
      salt TEXT, code_hash TEXT, expires_at BIGINT, wrong_tries INTEGER NOT NULL DEFAULT 0,
      sends_hour_start BIGINT NOT NULL DEFAULT 0, sends_in_hour INTEGER NOT NULL DEFAULT 0, last_sent_at BIGINT NOT NULL DEFAULT 0,
      verified_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS email_delivery (email TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT, updated_at BIGINT NOT NULL)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(727200)");
      for (const sql of SCHEMA) await client.query(sql);
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(727200)"); } catch (_) { /* ignore */ }
      client.release();
    }
  })().catch((e) => { console.error("EMAIL VERIFY MIGRATE ERROR:", e); });

  const mailReady = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
  async function sendCodeMail(email, code) {
    if (!mailReady()) { console.log("EMAIL VERIFICATION CODE (Resend is not set up) for " + email + ": " + code); return "console"; }
    const html =
      '<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;background:#0b0620;color:#fff;padding:26px;border-radius:16px;text-align:center">' +
      '<h2 style="margin:0 0 6px;color:#f5c542">Vico Pay Live</h2><p style="color:#d6c7ff">Your email verification code is</p>' +
      '<div style="font-size:38px;font-weight:900;letter-spacing:8px;background:#2d1370;border-radius:12px;padding:14px;margin:12px 0">' + code + '</div>' +
      '<p style="color:#c9b8f0;font-size:13px">It works for ' + CODE_MINUTES + ' minutes. If you did not ask for it, you can ignore this email.</p></div>';
    const axios = require("axios");   // already in package.json; loaded only when an email is really sent
    await axios.post("https://api.resend.com/emails", {
      from: process.env.MAIL_FROM, to: [email], subject: "Your Vico Pay Live verification code " + code,
      html, text: "Your Vico Pay Live email verification code is " + code + ". It works for " + CODE_MINUTES + " minutes."
    }, { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY }, timeout: 12000 });
    return "email";
  }

  async function isVerified(email) {
    await ready;
    const r = await db.get("SELECT verified_at FROM email_verifications WHERE email = ?", [lc(email)]);
    return !!(r && r.verified_at);
  }

  app.get("/api/email-verify/status", requireAuth, async (req, res) => {
    try { return res.json({ success: true, verified: await isVerified(req.userEmail), email: req.userEmail }); }
    catch (e) { return bad(res, "Could not check your email status.", 500); }
  });

  app.post("/api/email-verify/send", requireAuth, async (req, res) => {
    try {
      await ready;
      const email = lc(req.userEmail), t = now();
      if (await isVerified(email)) return res.json({ success: true, verified: true });
      const bounced = await db.get("SELECT status FROM email_delivery WHERE email = ?", [email]);
      if (bounced && (bounced.status === "bounced" || bounced.status === "complained")) return bad(res, "We could not deliver email to this address. Please use a working email address.");
      const row = await db.get("SELECT last_sent_at, sends_hour_start, sends_in_hour FROM email_verifications WHERE email = ?", [email]);
      if (row) {
        const wait = Number(row.last_sent_at) + RESEND_COOLDOWN_MS - t;
        if (wait > 0) return bad(res, "Please wait " + Math.ceil(wait / 1000) + " seconds before asking for another code.", 429, { waitSeconds: Math.ceil(wait / 1000) });
        if (t - Number(row.sends_hour_start) < 3600000 && Number(row.sends_in_hour) >= MAX_SENDS_PER_HOUR) return bad(res, "Too many codes requested. Please try again in an hour.", 429);
      }
      const code = makeCode(), salt = crypto.randomBytes(12).toString("hex");
      const newHour = !row || t - Number(row.sends_hour_start) >= 3600000;
      await db.run(
        `INSERT INTO email_verifications (email, salt, code_hash, expires_at, wrong_tries, sends_hour_start, sends_in_hour, last_sent_at)
         VALUES (?,?,?,?,0,?,1,?)
         ON CONFLICT (email) DO UPDATE SET salt = EXCLUDED.salt, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, wrong_tries = 0,
           sends_hour_start = ?, sends_in_hour = ?, last_sent_at = EXCLUDED.last_sent_at`,
        [email, salt, hashCode(salt, code), t + CODE_MINUTES * 60000, t, t, newHour ? t : Number(row.sends_hour_start), newHour ? 1 : Number(row.sends_in_hour) + 1]);
      let via; try { via = await sendCodeMail(email, code); } catch (e) { console.error("RESEND SEND ERROR:", e.response ? JSON.stringify(e.response.data) : e.message); return bad(res, "We could not send the email right now. Please try again in a moment.", 502); }
      return res.json({ success: true, sent: true, via, cooldownSeconds: RESEND_COOLDOWN_MS / 1000 });
    } catch (e) { console.error("EMAIL VERIFY SEND ERROR:", e); return bad(res, "Could not send the code.", 500); }
  });

  app.post("/api/email-verify/confirm", requireAuth, async (req, res) => {
    try {
      await ready;
      const email = lc(req.userEmail), code = String((req.body && req.body.code) || "").trim();
      if (!/^\d{6}$/.test(code)) return bad(res, "Enter the 6-digit code from your email.");
      const row = await db.get("SELECT salt, code_hash, expires_at, wrong_tries, verified_at FROM email_verifications WHERE email = ?", [email]);
      if (row && row.verified_at) return res.json({ success: true, verified: true });
      if (!row || !row.code_hash) return bad(res, "Ask for a code first.");
      if (now() > Number(row.expires_at)) return bad(res, "That code has expired. Ask for a new one.");
      if (Number(row.wrong_tries) >= MAX_WRONG) return bad(res, "Too many wrong tries. Ask for a new code.", 429);
      if (!safeEq(hashCode(row.salt, code), row.code_hash)) {
        await db.run("UPDATE email_verifications SET wrong_tries = wrong_tries + 1 WHERE email = ?", [email]);
        return bad(res, "That code is not right.");
      }
      await db.run("UPDATE email_verifications SET verified_at = ?, code_hash = NULL, salt = NULL WHERE email = ?", [now(), email]);
      return res.json({ success: true, verified: true });
    } catch (e) { console.error("EMAIL VERIFY CONFIRM ERROR:", e); return bad(res, "Could not check the code.", 500); }
  });

  // ---- incoming mail: forward what arrives at your Resend receiving address to your real inbox (INBOX_FORWARD_TO) ----
  // The webhook only carries who/subject, so the message itself is fetched with the Receiving API, then sent on with Resend.
  async function forwardReceived(data) {
    const to = String(process.env.INBOX_FORWARD_TO || "").trim();
    if (!to || !mailReady() || !data.email_id) return;
    const axios = require("axios");
    const auth = { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY }, timeout: 15000 };
    const got = (await axios.get("https://api.resend.com/emails/receiving/" + encodeURIComponent(data.email_id), auth)).data || {};
    const from = String(got.from || data.from || ""), addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim();
    const mine = (process.env.MAIL_FROM.match(/<([^>]+)>/) || [null, process.env.MAIL_FROM])[1].trim().toLowerCase();
    if (addr.toLowerCase() === mine) return;                                   // never forward our own mail back (no loops)
    const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const subject = String(got.subject || data.subject || "(no subject)");
    const head = "<p style=\"font-family:Arial;font-size:13px;color:#555\">Forwarded from your Vico Pay Live address.<br>From: " + esc(from) + "<br>To: " + esc([].concat(got.to || data.to || []).join(", ")) + "</p><hr>";
    const nAtt = [].concat(got.attachments || []).length;
    await axios.post("https://api.resend.com/emails", {
      from: process.env.MAIL_FROM, to: [to], reply_to: addr || undefined, subject: "Fwd: " + subject,
      html: head + (got.html || "<pre style=\"font-family:Arial\">" + esc(got.text || "") + "</pre>") + (nAtt ? "<hr><p>This message had " + nAtt + " attachment(s). Open it in your Resend dashboard (Emails, Receiving) to download them.</p>" : ""),
      text: "Forwarded. From: " + from + "\n\n" + (got.text || "")
    }, auth);
  }

  // ---- Resend webhook (incoming mail + delivery results) ----
  app.post("/api/resend/webhook", async (req, res) => {
    try {
      await ready;
      const secret = process.env.RESEND_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SIGNING_SECRET;
      if (!secret) return res.status(503).json({ success: false, message: "RESEND_WEBHOOK_SECRET is not set." });
      const ok = verifyWebhook({ secret, id: req.headers["svix-id"], timestamp: req.headers["svix-timestamp"], signature: req.headers["svix-signature"], rawBody: req.rawBody });
      if (!ok) return res.sendStatus(400);
      const ev = req.body || {}, type = String(ev.type || ""), data = ev.data || {};
      if (type === "email.received") { await forwardReceived(data); return res.json({ success: true }); }
      const status = type === "email.bounced" ? "bounced" : type === "email.complained" ? "complained" : type === "email.delivered" ? "delivered" : null;
      if (status) {
        for (const to of [].concat(data.to || [])) {
          const addr = lc(String(to).replace(/^.*<|>.*$/g, ""));
          if (!addr) continue;
          // a later "delivered" never hides an earlier bounce/complaint
          await db.run(
            `INSERT INTO email_delivery (email, status, detail, updated_at) VALUES (?,?,?,?)
             ON CONFLICT (email) DO UPDATE SET status = CASE WHEN email_delivery.status IN ('bounced','complained') AND EXCLUDED.status = 'delivered' THEN email_delivery.status ELSE EXCLUDED.status END,
               detail = EXCLUDED.detail, updated_at = EXCLUDED.updated_at`,
            [addr, status, String((data.bounce && data.bounce.message) || type).slice(0, 200), now()]);
          if (status !== "delivered" && onBounce) { try { await onBounce(addr, status); } catch (e) { console.error("BOUNCE HOOK ERROR:", e.message); } }
        }
      }
      return res.json({ success: true });
    } catch (e) { console.error("RESEND WEBHOOK ERROR:", e); return res.sendStatus(500); }
  });

  return { isVerified, forwardReceived, ready };
};
module.exports.verifyWebhook = verifyWebhook;
module.exports.hashCode = hashCode;
