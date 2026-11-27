// =====================================================
// Vico Message — WhatsApp-style chat + calls for Vico Pay Live
// =====================================================
// 1. Activation: a person verifies their VicoPay account email (using the existing email-verify / Resend flow) and sets a name.
//    Email verification confirms control of the email address; it does not verify ownership of a phone number.
//    Existing accounts with a previously SMS-verified phone remain active.
// 2. Chat: private one-to-one messages in PostgreSQL, delivered instantly through a server-sent-events stream (/api/vm/stream),
//    with sent / delivered / read ticks, "typing…", online / last seen and block. The page falls back to polling if the stream drops.
//    Phone verification (the "verify your number" step): VicoPay creates, hashes, expires and checks ONE six-digit code for every delivery
//    method. SMS goes out through Infobip (vico-phone.js). Push goes to the person's registered browser / Android devices (vico-push.js).
// 3. Calls: voice and video through LiveKit. See vico-message-calls.js.
// 4. Business contacts: advertisers who finished Ad Center registration (payment + business information + approved ID) appear in the
//    "Businesses" list with the contact details they entered, so buyers can message or call them.
//
// Old routes /api/dm/threads, /api/dm/with/:handle keep working (Marketplace "Message seller" links use them).
// Tables (new ones only): vm_profiles, vm_otps, vm_phone_throttle, vm_blocks, vm_calls. dm_messages gets 3 new nullable columns.
const crypto = require("crypto");
const phoneLib = require("./vico-phone");
const makeMessageCalls = require("./vico-message-calls");
const makePush = require("./vico-push");

const HOUR = 3600 * 1000, RESEND_MS = 60 * 1000, MAX_SENDS_PER_HOUR = 5, MAX_WRONG = 5, MAX_BODY = 2000;

module.exports = function makeMessages({ app, db, requireAuth, store, callAccess, axios, env, wallet, isEmailVerified }) {
  env = env || process.env;
  const { users, publicHandle, displayNameOf, avatarUrl } = store;
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const bad = (res, code, message, extra) => res.status(code).json({ success: false, message, ...(extra || {}) });
  // Paid messaging (VicoPay Wallet, vico-wallet.js): the SENDER pays. A first message to a new person costs RATES.firstMessage naira, every
  // message after that (sending or replying) RATES.message. Calls cost RATES.callMinute per minute (see vico-message-calls.js).
  // No wallet passed in, or VM_CHARGING=off in .env, means everything stays free.
  const charging = () => !!(wallet && env.VM_CHARGING !== "off");
  const WALLET_URL = "wallet.html";
  const lowBalance = (res, needed, balance, what) => res.status(402).json({ success: false, insufficient: true, needed, balance, walletUrl: WALLET_URL,
    message: "Your VicoPay Wallet balance is too low to " + what + " (₦" + needed + " needed, you have ₦" + balance + "). Recharge your wallet to continue." });
  const isUnique = (e) => e && (e.code === "23505" || /UNIQUE constraint/i.test(String(e.message)));

  const push = makePush({ db, axios, env });
  const SCHEMA = [
    ...push.SCHEMA,
    `CREATE TABLE IF NOT EXISTS dm_conversations (id BIGSERIAL PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, UNIQUE(user_a,user_b), CHECK(user_a <> user_b))`,
    `CREATE INDEX IF NOT EXISTS idx_dm_conversations_a ON dm_conversations(user_a,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dm_conversations_b ON dm_conversations(user_b,updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS dm_messages (id BIGSERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, read_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation ON dm_messages(conversation_id,id)`,
    // Vico Message additions: delivery ticks, call entries in the chat
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS delivered_at BIGINT`,
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS kind TEXT`,
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS meta TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_dm_messages_recipient ON dm_messages(recipient_id, read_at)`,
    // Stage 4: delete for everyone leaves an empty "deleted" row (deleted_at); delete for me hides one message from one person only
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT`,
    `CREATE TABLE IF NOT EXISTS vm_msg_hidden (message_id BIGINT NOT NULL, email TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (message_id, email))`,
    // one row per activated person: the VERIFIED number is stored here only after the code was confirmed
    `CREATE TABLE IF NOT EXISTS vm_profiles (email TEXT PRIMARY KEY, phone TEXT, phone_verified_at BIGINT, email_verified_at BIGINT, about TEXT NOT NULL DEFAULT '', discoverable SMALLINT NOT NULL DEFAULT 1, show_online SMALLINT NOT NULL DEFAULT 1, last_seen_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `ALTER TABLE vm_profiles ADD COLUMN IF NOT EXISTS email_verified_at BIGINT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_vm_profiles_phone ON vm_profiles(phone)`,
    // how the number was proven: "sms" (a code that reached the phone number itself) or "push" (a code sent to the person's own signed-in device).
    // Older rows have no value and were always SMS.
    `ALTER TABLE vm_profiles ADD COLUMN IF NOT EXISTS phone_verified_via TEXT`,
    // the pending code (hashed, never stored in clear)
    `CREATE TABLE IF NOT EXISTS vm_otps (email TEXT PRIMARY KEY, phone TEXT NOT NULL, salt TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at BIGINT NOT NULL, wrong_tries INTEGER NOT NULL DEFAULT 0, last_sent_at BIGINT NOT NULL DEFAULT 0, sends_hour_start BIGINT NOT NULL DEFAULT 0, sends_in_hour INTEGER NOT NULL DEFAULT 0)`,
    `ALTER TABLE vm_otps ADD COLUMN IF NOT EXISTS channel TEXT`,
    // stops one phone number being flooded with codes from many accounts
    `CREATE TABLE IF NOT EXISTS vm_phone_throttle (phone TEXT PRIMARY KEY, hour_start BIGINT NOT NULL, sends INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vm_blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (blocker, blocked))`,
    // photos and voice notes (Stage 3): the bytes live in PostgreSQL like avatars do, so a redeploy never loses a chat's pictures
    `CREATE TABLE IF NOT EXISTS vm_media (id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id BIGINT NOT NULL, message_id BIGINT, kind TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, duration INTEGER, data BYTEA NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_vm_media_message ON vm_media(message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_vm_media_conv ON vm_media(conversation_id)`
  ];
  const ready = (async () => {
    const c = await db.pool.connect();
    try { await c.query("SELECT pg_advisory_lock(727291)"); for (const q of SCHEMA) await c.query(q); }
    finally { try { await c.query("SELECT pg_advisory_unlock(727291)"); } catch (_) { /* ignore */ } c.release(); }
  })().catch((e) => { console.error("VICO MESSAGE MIGRATE ERROR:", e); });

  // ---------- small in-memory helpers (a restart only resets the counters) ----------
  const buckets = new Map();
  function allow(key, max, windowMs) {
    const t = now(); let b = buckets.get(key);
    if (!b || t - b.s >= windowMs) { b = { s: t, n: 0, w: windowMs }; buckets.set(key, b); }
    b.n++;
    if (buckets.size > 20000) for (const [k, v] of buckets) if (t - v.s >= v.w) buckets.delete(k);
    return b.n <= max;
  }

  // ---------- realtime hub: one open stream per browser tab ----------
  const conns = new Map();   // email -> Set<res>
  const hub = {
    push(email, event, data) {
      const set = conns.get(lc(email)); if (!set || !set.size) return false;
      const frame = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
      for (const r of set) { try { r.write(frame); } catch (_) { /* closed; its close handler removes it */ } }
      return true;
    },
    online: (email) => { const s = conns.get(lc(email)); return !!(s && s.size); }
  };

  // ---------- accounts ----------
  const profile = (email) => db.get("SELECT email, phone, phone_verified_at, phone_verified_via, email_verified_at, about, discoverable, show_online, last_seen_at FROM vm_profiles WHERE email = ?", [lc(email)]);
  async function emailIsVerified(email) {
    if (typeof isEmailVerified !== "function") return false;
    try { return !!(await isEmailVerified(lc(email))); } catch (e) { console.error("VM EMAIL STATUS:", e.message); return false; }
  }
  async function ensureEmailProfile(email) {
    const me = lc(email), t = now();
    await db.run(
      `INSERT INTO vm_profiles (email, email_verified_at, created_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT (email) DO UPDATE SET email_verified_at = COALESCE(vm_profiles.email_verified_at, EXCLUDED.email_verified_at), updated_at = EXCLUDED.updated_at`,
      [me, t, t, t]);
    return profile(me);
  }
  const requireActivated = async (req, res, next) => {
    try {
      await ready;
      const me = lc(req.userEmail);
      let p = await profile(me);
      // Keep existing SMS-verified accounts working; new accounts activate through verified email.
      if (p && p.phone) { req.vm = p; return next(); }
      // VM_REQUIRE_PHONE=on in .env: nobody can use Vico Message until their phone number is verified (default off: email alone still works)
      if (env.VM_REQUIRE_PHONE === "on") return bad(res, 403, "Verify your phone number to use Vico Message.", { needsVerification: true, needsPhoneVerification: true });
      if (!(await emailIsVerified(me))) return bad(res, 403, "Verify your VicoPay account email to use Vico Message.", { needsVerification: true, needsEmailVerification: true });
      p = await ensureEmailProfile(me);
      req.vm = p; return next();
    } catch (e) { next(e); }
  };
  async function target(handle) { const email = await users.resolveHandle(String(handle || "").replace(/^@/, "")); return email ? lc(email) : null; }
  const isBlocked = async (a, b) => !!(await db.get("SELECT 1 AS x FROM vm_blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)", [lc(a), lc(b), lc(b), lc(a)]));
  async function conversation(me, other, create) {
    const a = [lc(me), lc(other)].sort();
    if (create) await db.run(`INSERT INTO dm_conversations(user_a,user_b,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_a,user_b) DO NOTHING`, [a[0], a[1], now(), now()]);
    return db.get("SELECT id FROM dm_conversations WHERE user_a = ? AND user_b = ?", a);
  }
  async function presenceOf(other) {
    const p = await profile(other);
    if (!p || Number(p.show_online) === 0) return { visible: false };
    return hub.online(other) ? { visible: true, online: true } : { visible: true, online: false, lastSeen: Number(p.last_seen_at) || null };
  }
  const person = (email, p) => ({ handle: publicHandle(email), displayName: displayNameOf(email), avatar: avatarUrl(email), about: (p && p.about) || "", activated: !!(p && (p.phone || p.email_verified_at)) });
  // only these fields of a media message's meta ever reach a browser
  function mediaMeta(raw) {
    let m = {}; try { m = JSON.parse(raw || "{}"); } catch (_) { /* ignore */ }
    return { mediaId: String(m.mediaId || ""), mime: String(m.mime || ""), duration: Number(m.duration) || 0, w: Number(m.w) || 0, h: Number(m.h) || 0, size: Number(m.size) || 0 };
  }
  const MSG_COLS = `id, sender_id AS "senderId", body, kind, meta, created_at AS at, delivered_at AS "deliveredAt", read_at AS "readAt", deleted_at AS "deletedAt"`;
  const NOT_HIDDEN = "NOT EXISTS (SELECT 1 FROM vm_msg_hidden h WHERE h.message_id = $T.id AND h.email = ?)";   // $T = the table alias; one ? = the viewer
  function msgOut(m, me) {
    const mine = lc(m.senderId) === me;
    if (m.deletedAt) return { id: Number(m.id), body: "", at: Number(m.at), mine, kind: "deleted" };   // deleted for everyone: only a marker is left
    const kind = m.kind || "text";
    const o = { id: Number(m.id), body: m.body, at: Number(m.at), mine, kind };
    if (kind === "call") { try { o.meta = JSON.parse(m.meta || "{}"); } catch (_) { o.meta = {}; } }
    if (kind === "image" || kind === "voice") o.meta = mediaMeta(m.meta);
    if (mine) o.state = m.readAt ? "read" : m.deliveredAt ? "delivered" : "sent";
    return o;
  }
  // The advertiser's business phone from Ad Center registration (used to pre-fill the verification and to badge verified businesses)
  async function businessProfileOf(email) {
    try {
      return await db.get(`SELECT p.phone AS phone, p.business_name AS "businessName" FROM ad_job_orders o JOIN ad_job_profiles p ON p.order_id = o.id
        WHERE o.user_email = ? AND o.status <> 'cancelled' AND o.status <> 'pending_payment' ORDER BY o.id DESC LIMIT 1`, [lc(email)]);
    } catch (_) { return null; }   // the Ad Center tables do not exist yet
  }

  // =====================================================
  // 1. ACTIVATION (verified account email + profile; legacy SMS verification routes remain for existing users)
  // =====================================================
  app.get("/api/vm/status", requireAuth, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail); await users.warm([me]);
      let p = await profile(me);
      const emailVerified = await emailIsVerified(me);
      if (emailVerified) p = await ensureEmailProfile(me);
      const biz = await businessProfileOf(me);
      let suggested = null;
      if (biz && biz.phone) { const n = phoneLib.normalizePhone(biz.phone); if (n.ok) suggested = { phone: n.e164, businessName: biz.businessName || "" }; }
      const phoneVerified = !!(p && p.phone);
      const provider = phoneLib.providerName(env);
      res.json({
        success: true, activated: !!(p && (p.phone || p.email_verified_at)), emailVerified, email: me,
        phoneVerified, phone: phoneVerified ? p.phone : "", phoneMasked: phoneVerified ? phoneLib.maskPhone(p.phone) : "",
        me: { ...person(me, p) }, discoverable: p ? Number(p.discoverable) !== 0 : true, showOnline: p ? Number(p.show_online) !== 0 : true,
        phoneVerifiedVia: phoneVerified ? (p.phone_verified_via || "sms") : "", phoneRequired: env.VM_REQUIRE_PHONE === "on", codeMinutes: phoneLib.CODE_MINUTES,
        push: { web: push.webReady(), fcm: push.fcmReady(), publicKey: push.publicKey(), devices: await push.counts(me) },
        suggestedPhone: phoneVerified ? null : suggested, countries: phoneLib.COUNTRIES,
        smsReady: provider !== "none" || env.NODE_ENV !== "production", callsReady: !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET)
      });
    } catch (e) { console.error("VM STATUS:", e); bad(res, 500, "Could not load Vico Message."); }
  });

  app.post("/api/vm/phone/send", requireAuth, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail), t = now(), body = req.body || {};
      const channel = String(body.channel || "sms").toLowerCase() === "push" ? "push" : "sms";
      const n = phoneLib.normalizePhone(body.phone, body.country);
      if (!n.ok) return bad(res, 400, n.message);
      const owner = await db.get("SELECT email, phone_verified_via FROM vm_profiles WHERE phone = ?", [n.e164]);
      if (owner && lc(owner.email) === me) return res.json({ success: true, alreadyVerified: true, phone: n.e164 });
      // A number proven only by a push code (sent to someone's own device, not to the SIM) can be claimed by whoever receives an SMS on it.
      const claimable = owner && owner.phone_verified_via === "push" && channel === "sms";
      if (owner && !claimable) return bad(res, 409, "This number is already linked to another Vico account. Use a different number, or sign in to the account that owns it.");
      if (!allow("otp-ip:" + req.ip, 20, HOUR)) return bad(res, 429, "Too many attempts from this connection. Please try again later.");
      if (channel === "push") {
        if (!push.anyReady()) return bad(res, 503, "Push codes are not switched on yet. Please use SMS.", { notConfigured: true, useSms: true });
        const c = await push.counts(me);
        if (!c.web && !c.fcm) return bad(res, 409, "This device is not set up for push codes yet. Allow notifications, or use SMS.", { noPushDevice: true, useSms: true });
      }
      const row = await db.get("SELECT * FROM vm_otps WHERE email = ?", [me]);
      if (row) {
        const wait = Number(row.last_sent_at) + RESEND_MS - t;
        if (wait > 0) return bad(res, 429, "Please wait " + Math.ceil(wait / 1000) + " seconds before asking for another code.", { waitSeconds: Math.ceil(wait / 1000) });
        if (t - Number(row.sends_hour_start) < HOUR && Number(row.sends_in_hour) >= MAX_SENDS_PER_HOUR) return bad(res, 429, "Too many codes requested. Please try again in an hour.");
      }
      const pt = await db.get("SELECT * FROM vm_phone_throttle WHERE phone = ?", [n.e164]);
      const ptOpen = pt && t - Number(pt.hour_start) < HOUR;
      if (ptOpen && Number(pt.sends) >= MAX_SENDS_PER_HOUR) return bad(res, 429, "Too many codes were sent to this number. Please try again in an hour.");

      const code = phoneLib.makeCode(), salt = phoneLib.makeSalt();
      const newHour = !row || t - Number(row.sends_hour_start) >= HOUR;
      await db.run(
        `INSERT INTO vm_otps (email, phone, salt, code_hash, expires_at, wrong_tries, last_sent_at, sends_hour_start, sends_in_hour, channel) VALUES (?,?,?,?,?,0,?,?,?,?)
         ON CONFLICT (email) DO UPDATE SET phone = EXCLUDED.phone, salt = EXCLUDED.salt, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, wrong_tries = 0, last_sent_at = EXCLUDED.last_sent_at, sends_hour_start = EXCLUDED.sends_hour_start, sends_in_hour = EXCLUDED.sends_in_hour, channel = EXCLUDED.channel`,
        [me, n.e164, salt, phoneLib.hashCode(salt, me, n.e164, code), t + phoneLib.CODE_MINUTES * 60000, t, newHour ? t : Number(row.sends_hour_start), newHour ? 1 : Number(row.sends_in_hour) + 1, channel]);
      await db.run(
        `INSERT INTO vm_phone_throttle (phone, hour_start, sends) VALUES (?,?,1) ON CONFLICT (phone) DO UPDATE SET hour_start = ?, sends = ?`,
        [n.e164, t, ptOpen ? Number(pt.hour_start) : t, ptOpen ? Number(pt.sends) + 1 : 1]);

      let via;
      if (channel === "push") {
        const r = await push.sendToUser(me, { title: "VicoPay verification code", body: "Your Vico Message code is " + code + ". Do not share it. It expires in " + phoneLib.CODE_MINUTES + " minutes.", tag: "vm-code", url: "vico-messages.html",
          data: { type: "vm_phone_code", code, url: "vico-messages.html" } });
        if (!r.sent) { await db.run("UPDATE vm_otps SET last_sent_at = 0 WHERE email = ?", [me]); return bad(res, 502, "We could not reach your device. Please use SMS instead.", { useSms: true }); }
        via = r.kinds.join("+");
      } else try { via = (await phoneLib.sendSms({ to: n.e164, text: phoneLib.codeText(code, env), axios, env })).via; }
      catch (e) {
        await db.run("UPDATE vm_otps SET last_sent_at = 0 WHERE email = ?", [me]);   // the person may try again straight away
        return e.code === "not_configured"
          ? bad(res, 503, "Phone verification is not switched on yet. The site owner needs to connect an SMS service.", { notConfigured: true })
          : bad(res, 502, "We could not send the SMS right now. Please check the number and try again in a moment.");
      }
      const out = { success: true, sent: true, channel, phone: n.e164, phoneMasked: phoneLib.maskPhone(n.e164), cooldownSeconds: RESEND_MS / 1000, expiresMinutes: phoneLib.CODE_MINUTES, via };
      if (via === "console" && env.NODE_ENV !== "production" && env.VM_DEV_ECHO_CODE === "1") out.devCode = code;   // local testing only
      res.json(out);
    } catch (e) { console.error("VM PHONE SEND:", e); bad(res, 500, "Could not send the code."); }
  });

  app.post("/api/vm/phone/verify", requireAuth, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail), t = now();
      const code = String((req.body && req.body.code) || "").replace(/\D/g, "");
      if (code.length !== 6) return bad(res, 400, "Enter the 6-digit code.");
      const row = await db.get("SELECT * FROM vm_otps WHERE email = ?", [me]);
      if (!row) return bad(res, 400, "Request a code first.");
      if (Number(row.expires_at) < t) return bad(res, 400, "This code has expired. Request a new one.", { expired: true });
      if (Number(row.wrong_tries) >= MAX_WRONG) return bad(res, 429, "Too many wrong codes. Request a new one.", { expired: true });
      if (!phoneLib.safeEq(phoneLib.hashCode(row.salt, me, row.phone, code), row.code_hash)) {
        await db.run("UPDATE vm_otps SET wrong_tries = wrong_tries + 1 WHERE email = ?", [me]);
        const left = MAX_WRONG - Number(row.wrong_tries) - 1;
        return bad(res, 400, left > 0 ? "That code is not correct. " + left + (left === 1 ? " try" : " tries") + " left." : "Too many wrong codes. Request a new one.", { expired: left <= 0 });
      }
      try {
        await db.tx(async (tx) => {
          const via = row.channel === "push" ? "push" : "sms";
          // an SMS code that reached the number itself outranks an earlier push-only claim on the same number
          if (via === "sms") await tx.run("UPDATE vm_profiles SET phone = NULL, phone_verified_at = NULL, phone_verified_via = NULL WHERE phone = ? AND email <> ? AND phone_verified_via = 'push'", [row.phone, me]);
          await tx.run(
            `INSERT INTO vm_profiles (email, phone, phone_verified_at, phone_verified_via, created_at, updated_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT (email) DO UPDATE SET phone = EXCLUDED.phone, phone_verified_at = EXCLUDED.phone_verified_at, phone_verified_via = EXCLUDED.phone_verified_via, updated_at = EXCLUDED.updated_at`,
            [me, row.phone, t, via, t, t]);
          await tx.run("DELETE FROM vm_otps WHERE email = ?", [me]);
        });
      } catch (e) {
        if (isUnique(e)) return bad(res, 409, "This number was just linked to another Vico account.");
        throw e;
      }
      res.json({ success: true, verified: true, via: row.channel === "push" ? "push" : "sms", phone: row.phone, phoneMasked: phoneLib.maskPhone(row.phone) });
    } catch (e) { console.error("VM PHONE VERIFY:", e); bad(res, 500, "Could not verify the code."); }
  });

  // ---- push devices: a browser (Web Push) or the Android app (Firebase) registers itself, so a code can be sent to it ----
  app.get("/api/vm/push/config", requireAuth, async (req, res) => {
    try { await ready; res.json({ success: true, web: push.webReady(), fcm: push.fcmReady(), publicKey: push.publicKey(), devices: await push.counts(lc(req.userEmail)) }); }
    catch (e) { bad(res, 500, "Could not load push settings."); }
  });
  app.post("/api/vm/push/subscribe", requireAuth, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail);
      if (!push.webReady()) return bad(res, 503, "Browser notifications are not switched on yet.", { notConfigured: true });
      if (!allow("push-reg:" + me, 30, HOUR)) return bad(res, 429, "Too many attempts. Please try again later.");
      if (!(await push.addWeb(me, (req.body || {}).subscription))) return bad(res, 400, "That browser subscription is not valid.");
      res.json({ success: true });
    } catch (e) { console.error("VM PUSH SUBSCRIBE:", e); bad(res, 500, "Could not save this device."); }
  });
  // For the Android app (built later): after Firebase gives the app a token, it sends it here with the signed-in session.
  app.post("/api/vm/push/fcm", requireAuth, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail);
      if (!push.fcmReady()) return bad(res, 503, "Android notifications are not switched on yet.", { notConfigured: true });
      if (!allow("push-reg:" + me, 30, HOUR)) return bad(res, 429, "Too many attempts. Please try again later.");
      if (!(await push.addFcm(me, (req.body || {}).token))) return bad(res, 400, "That device token is not valid.");
      res.json({ success: true });
    } catch (e) { console.error("VM PUSH FCM:", e); bad(res, 500, "Could not save this device."); }
  });
  app.post("/api/vm/push/unsubscribe", requireAuth, async (req, res) => {
    try { await ready; const b = req.body || {}; await push.remove(lc(req.userEmail), b.endpoint || b.token); res.json({ success: true }); }
    catch (e) { bad(res, 500, "Could not remove this device."); }
  });

  app.post("/api/vm/profile", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), b = req.body || {};
      if (b.displayName !== undefined) {
        const name = String(b.displayName).replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
        if (name.length < 2 || name.length > 40) return bad(res, 400, "Your name must be 2 to 40 characters.");
        await users.setDisplayName(me, name);
      }
      const about = b.about === undefined ? null : String(b.about).replace(/[\u0000-\u001f\u007f<>]/g, " ").trim().slice(0, 139);
      await db.run("UPDATE vm_profiles SET about = COALESCE(?, about), discoverable = COALESCE(?, discoverable), show_online = COALESCE(?, show_online), updated_at = ? WHERE email = ?",
        [about, b.discoverable === undefined ? null : (b.discoverable ? 1 : 0), b.showOnline === undefined ? null : (b.showOnline ? 1 : 0), now(), me]);
      await users.warm([me]);
      res.json({ success: true });
    } catch (e) { console.error("VM PROFILE:", e); bad(res, 500, "Could not save your profile."); }
  });

  // =====================================================
  // 2. FINDING PEOPLE AND BUSINESSES
  // =====================================================
  app.get("/api/vm/contacts/search", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), q = String(req.query.q || "").trim().slice(0, 60);
      if (q.length < 2) return res.json({ success: true, people: [] });
      let list = [];
      if (/^\+?[\d\s().-]{7,}$/.test(q)) {
        // find a person by phone number (only people who allow it); limited so numbers cannot be guessed in bulk
        if (!allow("lookup:" + me, 30, HOUR)) return bad(res, 429, "Too many number searches. Try again later.");
        const n = phoneLib.normalizePhone(q, req.query.country);
        if (n.ok) { const r = await db.get("SELECT email FROM vm_profiles WHERE phone = ? AND discoverable = 1 AND COALESCE(phone_verified_via, 'sms') = 'sms'", [n.e164]); if (r) list = [lc(r.email)]; }
      } else {
        const found = await users.search(q.replace(/^@/, ""), 20); list = found.map((u) => lc(u.email));
      }
      list = list.filter((e) => e !== me);
      const out = [];
      for (const e of list) {
        if (await isBlocked(me, e)) continue;
        await users.warm([e]); out.push(person(e, await profile(e)));
      }
      res.json({ success: true, people: out });
    } catch (e) { console.error("VM SEARCH:", e); bad(res, 500, "Could not search right now."); }
  });

  // Advertisers with a finished, approved Ad Center registration: their business contact is public on purpose (it is their advert).
  app.get("/api/vm/businesses", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), q = "%" + String(req.query.q || "").toLowerCase().replace(/[\\%_]/g, " ").trim().slice(0, 40) + "%";
      const rows = await db.all(
        `SELECT o.id AS "orderId", o.user_email AS email, o.tier, p.business_name AS "businessName", p.description, p.phone, p.whatsapp, p.city, p.country
         FROM ad_job_orders o JOIN ad_job_profiles p ON p.order_id = o.id JOIN ad_job_identity i ON i.order_id = o.id
         WHERE o.status <> 'cancelled' AND o.status <> 'pending_payment' AND p.complete = 1 AND i.status = 'approved'
           AND (LOWER(p.business_name) LIKE ? OR LOWER(p.city) LIKE ? OR LOWER(p.description) LIKE ?) ORDER BY o.id DESC LIMIT 120`, [q, q, q]);
      const seen = new Set(), out = [];
      for (const r of rows) {
        const e = lc(r.email); if (seen.has(e) || e === me) continue;
        if (["big-business", "company", "national"].includes(r.tier)) {   // organisations must also be verified as a company
          let ok = false; try { const a = await db.get("SELECT status FROM company_verification_applications WHERE order_id = ?", [r.orderId]); ok = !!(a && a.status === "verified"); } catch (_) { ok = false; }
          if (!ok) continue;
        }
        if (await isBlocked(me, e)) continue;
        seen.add(e);
        const p = await profile(e); await users.warm([e]);
        out.push({ ...person(e, p), businessName: r.businessName, description: String(r.description || "").slice(0, 140), city: r.city || "", country: r.country || "",
          phone: r.phone || "", whatsapp: r.whatsapp || "", canCall: !!(p && (p.phone || p.email_verified_at)), numberVerified: !!(p && p.phone && (p.phone_verified_via || "sms") === "sms" && phoneLib.samePhone(p.phone, r.phone)) });
        if (out.length >= 40) break;
      }
      res.json({ success: true, businesses: out });
    } catch (e) {
      if (/relation .* does not exist|no such table/i.test(String(e.message))) return res.json({ success: true, businesses: [] });
      console.error("VM BUSINESSES:", e); bad(res, 500, "Could not load businesses.");
    }
  });

  app.post("/api/vm/block", requireAuth, requireActivated, async (req, res) => {
    try { const me = lc(req.userEmail), other = await target(req.body && req.body.handle);
      if (!other || other === me) return bad(res, 400, "That contact cannot be blocked.");
      await db.run("INSERT INTO vm_blocks (blocker, blocked, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING", [me, other, now()]); res.json({ success: true });
    } catch (e) { console.error("VM BLOCK:", e); bad(res, 500, "Could not block this contact."); }
  });
  app.post("/api/vm/unblock", requireAuth, requireActivated, async (req, res) => {
    try { const me = lc(req.userEmail), other = await target(req.body && req.body.handle);
      if (!other) return bad(res, 404, "That user was not found.");
      await db.run("DELETE FROM vm_blocks WHERE blocker = ? AND blocked = ?", [me, other]); res.json({ success: true });
    } catch (e) { console.error("VM UNBLOCK:", e); bad(res, 500, "Could not unblock this contact."); }
  });

  // =====================================================
  // 3. REALTIME STREAM (messages, ticks, typing, incoming calls)
  // =====================================================
  // A message that reached a phone that is online counts as delivered; when someone comes online the waiting ones are marked too.
  async function deliverPending(me) {
    const rows = await db.all("SELECT sender_id, MAX(id) AS top FROM dm_messages WHERE recipient_id = ? AND delivered_at IS NULL AND read_at IS NULL GROUP BY sender_id", [me]);
    if (!rows.length) return;
    await db.run("UPDATE dm_messages SET delivered_at = ? WHERE recipient_id = ? AND delivered_at IS NULL", [now(), me]);
    await users.warm([me]);
    for (const r of rows) hub.push(r.sender_id, "receipt", { by: publicHandle(me), state: "delivered", upTo: Number(r.top) });
  }

  app.get("/api/vm/stream", requireAuth, requireActivated, async (req, res) => {
    const me = lc(req.userEmail);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    if (res.flushHeaders) res.flushHeaders();
    res.write("retry: 4000\n\nevent: hello\ndata: {}\n\n");
    let set = conns.get(me); if (!set) { set = new Set(); conns.set(me, set); }
    if (set.size >= 6) { const oldest = set.values().next().value; set.delete(oldest); try { oldest.end(); } catch (_) { /* gone */ } }
    set.add(res);
    const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) { /* closed */ } }, 20000);
    req.on("close", () => {
      clearInterval(beat); set.delete(res);
      if (!set.size) { conns.delete(me); db.run("UPDATE vm_profiles SET last_seen_at = ? WHERE email = ?", [now(), me]).catch(() => {}); }
    });
    try { await deliverPending(me); } catch (e) { console.error("VM DELIVER:", e.message); }
  });

  app.post("/api/vm/typing", requireAuth, requireActivated, async (req, res) => {
    const me = lc(req.userEmail), other = await target(req.body && req.body.handle);
    if (other && other !== me && allow("typing:" + me + ">" + other, 1, 1500)) { await users.warm([me]); hub.push(other, "typing", { from: publicHandle(me) }); }
    res.json({ success: true });
  });

  // =====================================================
  // 4. CHAT (same routes as before, now with ticks, blocks and call entries)
  // =====================================================
  app.get("/api/dm/unread", requireAuth, async (req, res) => {   // the red number on the Messages button (works before activation: it is simply 0)
    try { await ready; const r = await db.get("SELECT COUNT(*) AS n FROM dm_messages d WHERE d.recipient_id = ? AND d.read_at IS NULL AND d.deleted_at IS NULL AND "+NOT_HIDDEN.replace("$T","d"), [lc(req.userEmail), lc(req.userEmail)]); res.json({ success: true, unread: Number(r.n) || 0 }); }
    catch (e) { res.json({ success: true, unread: 0 }); }
  });

  app.get("/api/dm/threads", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail);
      deliverPending(me).catch(() => {});
      const rows = await db.all(
        `SELECT c.id, CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END AS other_id, c.updated_at AS "lastAt",
                m.body AS preview, m.kind AS kind, m.meta AS meta, m.sender_id AS sender_id, m.delivered_at AS "deliveredAt", m.read_at AS "readAt", m.deleted_at AS "deletedAt",
                (SELECT COUNT(*) FROM dm_messages u WHERE u.conversation_id = c.id AND u.recipient_id = ? AND u.read_at IS NULL AND u.deleted_at IS NULL AND ${NOT_HIDDEN.replace("$T", "u")}) AS unread
         FROM dm_conversations c LEFT JOIN dm_messages m ON m.id = (SELECT MAX(z.id) FROM dm_messages z WHERE z.conversation_id = c.id AND ${NOT_HIDDEN.replace("$T", "z")})
         WHERE (c.user_a = ? OR c.user_b = ?) AND EXISTS (SELECT 1 FROM dm_messages v WHERE v.conversation_id = c.id AND ${NOT_HIDDEN.replace("$T", "v")})
         ORDER BY c.updated_at DESC LIMIT 100`, [me, me, me, me, me, me, me]);
      await users.warm(rows.map((x) => x.other_id));
      const blocked = new Set((await db.all("SELECT blocked FROM vm_blocks WHERE blocker = ?", [me])).map((b) => b.blocked));
      res.json({ success: true, threads: rows.map((x) => {
        const o = lc(x.other_id), mine = lc(x.sender_id) === me, kind = x.deletedAt ? "deleted" : (x.kind || "text");
        if (x.deletedAt) x.preview = "🚫 This message was deleted";
        let meta; if (kind === "call") { try { meta = JSON.parse(x.meta || "{}"); } catch (_) { meta = {}; } }
        return { handle: publicHandle(o), displayName: displayNameOf(o), avatar: avatarUrl(o), preview: String(x.preview || "").slice(0, 120), kind, meta, mine,
          state: mine ? (x.readAt ? "read" : x.deliveredAt ? "delivered" : "sent") : undefined, lastAt: Number(x.lastAt), unread: Number(x.unread) || 0, online: hub.online(o), blocked: blocked.has(o) };
      }) });
    } catch (e) { console.error("DM THREADS:", e); bad(res, 500, "Could not load your messages."); }
  });

  app.get("/api/dm/with/:handle", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), other = await target(req.params.handle);
      if (!other) return bad(res, 404, "That user was not found.");
      if (other === me) return bad(res, 400, "You cannot message yourself.");
      await users.warm([me, other]);
      const peer = await profile(other), who = person(other, peer), presence = await presenceOf(other);
      const blockedByMe = !!(await db.get("SELECT 1 AS x FROM vm_blocks WHERE blocker = ? AND blocked = ?", [me, other]));
      const c = await conversation(me, other, false);
      if (!c) return res.json({ success: true, with: who, presence, blockedByMe, messages: [], states: [] });
      const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
      const rows = after
        ? await db.all(`SELECT ${MSG_COLS} FROM dm_messages d WHERE d.conversation_id = ? AND d.id > ? AND ${NOT_HIDDEN.replace("$T", "d")} ORDER BY d.id ASC LIMIT 200`, [c.id, after, me])
        : (await db.all(`SELECT ${MSG_COLS} FROM dm_messages d WHERE d.conversation_id = ? AND ${NOT_HIDDEN.replace("$T", "d")} ORDER BY d.id DESC LIMIT 200`, [c.id, me])).reverse();
      const t = now();
      const seen = await db.run("UPDATE dm_messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE conversation_id = ? AND recipient_id = ? AND read_at IS NULL", [t, t, c.id, me]);
      if (seen.changes) { const top = await db.get("SELECT MAX(id) AS m FROM dm_messages WHERE conversation_id = ? AND recipient_id = ?", [c.id, me]); hub.push(other, "receipt", { by: publicHandle(me), state: "read", upTo: Number(top.m) }); }
      const mineRows = await db.all(`SELECT id, delivered_at AS "deliveredAt", read_at AS "readAt" FROM dm_messages WHERE conversation_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 60`, [c.id, me]);
      res.json({ success: true, with: who, presence, blockedByMe, messages: rows.map((m) => msgOut(m, me)),
        states: mineRows.map((m) => ({ id: Number(m.id), state: m.readAt ? "read" : m.deliveredAt ? "delivered" : "sent" })) });
    } catch (e) { console.error("DM OPEN:", e); bad(res, 500, "Could not open this chat."); }
  });

  // One place that prices, saves and delivers a message of any kind (text, photo, voice note).
  // Returns { ok:true, message, charged, balance } or { low:true, cost, have, first }.
  async function deliver({ me, other, kind, body, meta, media }) {
    await users.warm([me, other]);
    let cost = 0, first = false;
    if (charging()) {
      const c0 = await conversation(me, other, false);
      const prior = c0 ? await db.get("SELECT id FROM dm_messages WHERE conversation_id = ? AND (kind IS NULL OR kind IN ('text','image','voice')) LIMIT 1", [c0.id]) : null;
      first = !prior; cost = first ? wallet.RATES.firstMessage : wallet.RATES.message;
      const have = await wallet.balanceOf(me);
      if (have < cost) return { low: true, cost, have, first };
    }
    const c = await conversation(me, other, true), at = now(), online = hub.online(other), metaJson = meta ? JSON.stringify(meta) : null;
    // charge, message and media bytes are saved in ONE transaction: nothing is ever saved unpaid, and a failed save is never charged
    const out = await db.tx(async (t) => {
      let ch = null;
      if (cost > 0) {
        ch = await wallet.charge({ email: me, amount: cost, kind: first && cost !== wallet.RATES.message ? "first_message" : "message", ref: "dm:" + crypto.randomUUID(), memo: (kind === "image" ? "Photo to @" : kind === "voice" ? "Voice note to @" : "Message to @") + publicHandle(other) }, t);
        if (!ch.ok) return { ch };
      }
      const r = await t.get("INSERT INTO dm_messages(conversation_id, sender_id, recipient_id, body, kind, meta, created_at, delivered_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id", [c.id, me, other, body, kind, metaJson, at, online ? at : null]);
      if (media) await t.run("INSERT INTO vm_media(id, owner, conversation_id, message_id, kind, mime, size, duration, data, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", [media.id, me, c.id, Number(r.id), kind, media.mime, media.data.length, media.duration || null, media.data, at]);
      return { ch, r };
    });
    if (out.ch && !out.ch.ok) return { low: true, cost, have: out.ch.balance, first };
    await db.run("UPDATE dm_conversations SET updated_at = ? WHERE id = ?", [at, c.id]);
    const message = { id: Number(out.r.id), body, at, mine: true, kind, state: online ? "delivered" : "sent" };
    if (kind === "image" || kind === "voice") message.meta = mediaMeta(metaJson);
    hub.push(other, "message", { with: publicHandle(me), name: displayNameOf(me), message: { ...message, mine: false, state: undefined } });
    return { ok: true, message, charged: cost, balance: out.ch ? out.ch.balance : null };
  }
  const sent = (res, r, what) => r.low ? lowBalance(res, r.cost, r.have, r.first ? "message someone new" : what)
    : res.json({ success: true, message: r.message, ...(r.charged > 0 ? { charged: r.charged, balance: r.balance } : {}) });

  app.post("/api/dm/with/:handle", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), other = await target(req.params.handle);
      if (!other) return bad(res, 404, "That user was not found.");
      if (other === me) return bad(res, 400, "You cannot message yourself.");
      const body = String((req.body && req.body.body) || "").replace(/\u0000/g, "").trim();
      if (!body) return bad(res, 400, "Write a message first.");
      if (body.length > MAX_BODY) return bad(res, 400, "Messages can contain up to " + MAX_BODY.toLocaleString("en-US") + " characters.");
      if (!allow("send:" + me, 40, 60 * 1000)) return bad(res, 429, "You are sending messages too fast. Wait a moment.");
      if (await isBlocked(me, other)) return bad(res, 403, "This message could not be sent.");
      sent(res, await deliver({ me, other, kind: "text", body }), "send this message");
    } catch (e) { console.error("DM SEND:", e); bad(res, 500, "Could not send your message."); }
  });

  // A photo or voice file nobody can see any more is erased: when BOTH people have hidden its message, the bytes are no use to anyone.
  async function purgeHiddenMedia(conversationId) {
    await db.run(`DELETE FROM vm_media WHERE conversation_id = ? AND message_id IS NOT NULL
                  AND (SELECT COUNT(DISTINCT h.email) FROM vm_msg_hidden h WHERE h.message_id = vm_media.message_id) >= 2`, [conversationId]);
  }

  // Delete the whole chat, for ME only: every message in it is hidden from me (the other person keeps their copy) and the chat leaves my list.
  // If they write again later, a fresh chat shows only the new messages.
  app.post("/api/dm/with/:handle/delete", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), other = await target(req.params.handle);
      if (!other) return bad(res, 404, "That user was not found.");
      if (other === me) return bad(res, 400, "You cannot message yourself.");
      if (!allow("delchat:" + me, 20, 60 * 1000)) return bad(res, 429, "You are deleting too fast. Wait a moment.");
      const c = await conversation(me, other, false);
      if (!c) return res.json({ success: true, hidden: 0 });
      const r = await db.run("INSERT INTO vm_msg_hidden(message_id, email, created_at) SELECT id, ?, ? FROM dm_messages WHERE conversation_id = ? ON CONFLICT (message_id, email) DO NOTHING", [me, now(), c.id]);
      await purgeHiddenMedia(Number(c.id));
      hub.push(me, "chat_deleted", { with: publicHandle(other) });   // my other tabs and phones close this chat too
      res.json({ success: true, hidden: r && r.changes ? Number(r.changes) : 0 });
    } catch (e) { console.error("DM CHAT DELETE:", e); bad(res, 500, "Could not delete this chat."); }
  });

  // ---------- delete ----------
  // scope "me": the message disappears for the person who asked and stays for the other person (either side may do this).
  // scope "everyone": only the SENDER, and for text, photos and voice notes (not call records). The words are wiped and a photo or voice
  // file is erased from the database; both people then see "This message was deleted". Naira already paid for a message is not refunded.
  app.post("/api/dm/message/:id/delete", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail), id = Math.floor(Number(req.params.id));
      const scope = req.body && req.body.scope === "everyone" ? "everyone" : req.body && req.body.scope === "me" ? "me" : "";
      if (!(id > 0) || !scope) return bad(res, 400, "Choose what to delete.");
      if (!allow("del:" + me, 60, 60 * 1000)) return bad(res, 429, "You are deleting too fast. Wait a moment.");
      const row = await db.get("SELECT id, sender_id, recipient_id, kind, deleted_at FROM dm_messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)", [id, me, me]);
      if (!row) return bad(res, 404, "That message was not found.");
      if (scope === "me") {
        await db.run("INSERT INTO vm_msg_hidden(message_id, email, created_at) VALUES(?,?,?) ON CONFLICT (message_id, email) DO NOTHING", [id, me, now()]);
        const mc = await db.get("SELECT conversation_id AS c FROM dm_messages WHERE id = ?", [id]);
        if (mc) await purgeHiddenMedia(Number(mc.c));
        hub.push(me, "message_hidden", { with: publicHandle(lc(row.sender_id) === me ? lc(row.recipient_id) : lc(row.sender_id)), id });   // my other tabs and phones drop it too
        return res.json({ success: true, scope, id });
      }
      if (lc(row.sender_id) !== me) return bad(res, 403, "You can only delete your own messages for everyone.");
      if (row.kind === "call") return bad(res, 400, "Call records cannot be deleted for everyone.");
      if (!row.deleted_at) {
        await db.tx(async (t) => {
          await t.run("UPDATE dm_messages SET body = '', meta = NULL, deleted_at = ? WHERE id = ?", [now(), id]);
          await t.run("DELETE FROM vm_media WHERE message_id = ?", [id]);
        });
        hub.push(lc(row.recipient_id), "message_deleted", { with: publicHandle(me), id, mine: false });
        hub.push(me, "message_deleted", { with: publicHandle(lc(row.recipient_id)), id, mine: true });   // the sender's other open tabs and phones update live
      }
      res.json({ success: true, scope, id });
    } catch (e) { console.error("DM DELETE:", e); bad(res, 500, "Could not delete that message."); }
  });

  // ---------- photos and voice notes ----------
  // The browser posts the raw file: POST /api/vm/media/:handle?kind=image|voice[&duration=SECONDS&w=&h=]. The type is decided from the
  // file's own first bytes, never from what the browser claims, and only these formats are accepted (no SVG, no HTML, nothing runnable).
  const MAX_IMAGE = 4 * 1024 * 1024, MAX_VOICE = 2 * 1024 * 1024, MAX_VOICE_SECONDS = 180;
  const startsWith = (b, arr, off) => arr.every((v, i) => b[(off || 0) + i] === v);
  function sniff(b) {
    if (!b || b.length < 12) return null;
    if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
    if (startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return { kind: "image", mime: "image/gif" };
    if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "image", mime: "image/webp" };
    if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "voice", mime: "audio/webm" };
    if (startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return { kind: "voice", mime: "audio/ogg" };
    if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return { kind: "voice", mime: "audio/mp4" };
    if (startsWith(b, [0x49, 0x44, 0x33]) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: "voice", mime: "audio/mpeg" };
    return null;
  }
  const rawBody = require("express").raw({ type: () => true, limit: MAX_IMAGE + 1024 });
  const clampInt = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const mm = (secs) => Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");

  app.post("/api/vm/media/:handle", requireAuth, requireActivated, rawBody, async (req, res) => {
    try {
      const me = lc(req.userEmail), other = await target(req.params.handle);
      if (!other) return bad(res, 404, "That user was not found.");
      if (other === me) return bad(res, 400, "You cannot message yourself.");
      const kind = req.query.kind === "voice" ? "voice" : req.query.kind === "image" ? "image" : "";
      if (!kind) return bad(res, 400, "Choose a photo or a voice note.");
      const data = Buffer.isBuffer(req.body) ? req.body : null;
      if (!data || !data.length) return bad(res, 400, "No file was received.");
      const found = sniff(data);
      if (!found || found.kind !== kind) return bad(res, 415, kind === "image" ? "Send a JPG, PNG, WebP or GIF photo." : "That voice note could not be read.");
      if (data.length > (kind === "image" ? MAX_IMAGE : MAX_VOICE)) return bad(res, 413, kind === "image" ? "That photo is too large (4 MB at most)." : "That voice note is too long.");
      const duration = kind === "voice" ? clampInt(req.query.duration, MAX_VOICE_SECONDS) : 0;
      if (kind === "voice" && !duration) return bad(res, 400, "That voice note is empty.");
      if (!allow("media:" + me, 20, 60 * 1000)) return bad(res, 429, "You are sending too fast. Wait a moment.");
      if (await isBlocked(me, other)) return bad(res, 403, "This message could not be sent.");
      const id = crypto.randomUUID();
      const meta = { mediaId: id, mime: found.mime, size: data.length, duration, w: kind === "image" ? clampInt(req.query.w, 10000) : 0, h: kind === "image" ? clampInt(req.query.h, 10000) : 0 };
      const body = kind === "image" ? "📷 Photo" : "🎤 Voice note " + mm(duration);
      sent(res, await deliver({ me, other, kind, body, meta, media: { id, mime: found.mime, data, duration } }), kind === "image" ? "send this photo" : "send this voice note");
    } catch (e) {
      if (e && e.type === "entity.too.large") return bad(res, 413, "That file is too large.");
      console.error("DM MEDIA SEND:", e); bad(res, 500, "Could not send that file.");
    }
  });

  // Only the two people in the conversation can ever open a file. The browser asks with its sign-in token and shows the bytes from memory.
  app.get("/api/vm/media/:id", requireAuth, requireActivated, async (req, res) => {
    try {
      const me = lc(req.userEmail);
      const row = await db.get("SELECT m.id, m.kind, m.mime, m.data FROM vm_media m JOIN dm_conversations c ON c.id = m.conversation_id WHERE m.id = ? AND (c.user_a = ? OR c.user_b = ?) AND NOT EXISTS (SELECT 1 FROM vm_msg_hidden h WHERE h.message_id = m.message_id AND h.email = ?)", [String(req.params.id || ""), me, me, me]);
      if (!row) return bad(res, 404, "File not found.");
      const buf = Buffer.from(row.data);
      res.set({ "Content-Type": row.mime, "Content-Length": buf.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox" });
      res.end(buf);
    } catch (e) { console.error("DM MEDIA GET:", e); bad(res, 500, "Could not load that file."); }
  });

  // =====================================================
  // 5. CALLS
  // =====================================================
  // A finished call becomes a line in the chat ("Voice call · 2:31", "Missed video call"); a missed one counts as unread.
  async function logCall({ call, status, duration }) {
    const a = lc(call.caller), b = lc(call.callee), c = await conversation(a, b, true), t = now();
    const meta = { callId: call.id, kind: call.kind, status, duration };
    const label = call.kind === "video" ? "Video call" : "Voice call", missed = status === "missed" || status === "cancelled";
    const row = await db.get("INSERT INTO dm_messages(conversation_id, sender_id, recipient_id, body, kind, meta, created_at, delivered_at, read_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
      [c.id, a, b, label, "call", JSON.stringify(meta), t, t, missed ? null : t]);
    await db.run("UPDATE dm_conversations SET updated_at = ? WHERE id = ?", [t, c.id]);
    await users.warm([a, b]);
    const base = { id: Number(row.id), body: label, at: t, kind: "call", meta };
    hub.push(a, "message", { with: publicHandle(b), name: displayNameOf(b), message: { ...base, mine: true, state: "delivered" } });
    hub.push(b, "message", { with: publicHandle(a), name: displayNameOf(a), message: { ...base, mine: false } });
  }
  const calls = makeMessageCalls({ app, db, requireAuth, requireActivated, store, hub, isBlocked, logCall, callAccess, env, wallet: charging() ? wallet : null });

  return { migrate: ready, hub, calls };
};
module.exports.phone = phoneLib;
module.exports.push = makePush;
