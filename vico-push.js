// =====================================================
// Vico Message — push delivery for verification codes
// =====================================================
//   Browsers (Chrome and other supported browsers):  Web Push  (RFC 8291 encryption + RFC 8292 VAPID, built with Node's own crypto)
//   Android app:                                      Firebase Cloud Messaging (HTTP v1 API, service-account login)
// No extra npm packages are needed. VicoPay still creates, hashes, expires and checks every code (vico-messages.js);
// this file only DELIVERS a message to the devices a signed-in person has registered.
//
// .env settings
//   Web Push:  VAPID_PUBLIC_KEY   VAPID_PRIVATE_KEY   VAPID_SUBJECT (mailto:you@yourdomain.com)
//              make the key pair once with:   node vico-push.js keys
//   Firebase:  FIREBASE_SERVICE_ACCOUNT_JSON   (the service-account JSON file, pasted as one line, or base64 of it)
//              [FIREBASE_PROJECT_ID]            (only if it is not inside that JSON)
// Nothing is sent, and the page offers no push option, until the matching settings exist.
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s == null ? "" : s), "base64url");
const HOUR = 3600 * 1000, MAX_DEVICES = 10;

// ---------------------------------------------------------------------------------------------
// Web Push message encryption: RFC 8291 "aes128gcm" (one record). Pure function, checked against the RFC's own test vector.
// ---------------------------------------------------------------------------------------------
function encryptWebPush(plaintext, uaPublicB64, authB64, opts) {
  opts = opts || {};
  const ua = unb64u(uaPublicB64), auth = unb64u(authB64);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error("bad p256dh key");
  if (auth.length !== 16) throw new Error("bad auth secret");
  const data = Buffer.concat([Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8"), Buffer.from([2])]);   // 0x02 = last (only) record
  if (data.length > 4096 - 16) throw new Error("push message too large");
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();   // a fresh sender key for every message
  const asPublic = ecdh.getPublicKey();                                                  // 65 bytes, uncompressed
  const secret = ecdh.computeSecret(ua);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), ua, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, keyInfo, 32));
  const salt = opts.salt || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPublic.length;   // salt | record size | key id length
  return Buffer.concat([head, asPublic, ct]);
}

// The browser's side of the same maths (only used by the tests, to prove a round trip).
function decryptWebPush(body, uaPrivate, uaPublicB64, authB64) {
  const salt = body.subarray(0, 16), idLen = body[20], asPublic = body.subarray(21, 21 + idLen), ct = body.subarray(21 + idLen);
  const ua = unb64u(uaPublicB64), auth = unb64u(authB64);
  const ecdh = crypto.createECDH("prime256v1"); ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), ua, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length; while (end > 0 && plain[end - 1] === 0) end--;
  if (end === 0 || plain[end - 1] !== 2) throw new Error("bad padding");
  return plain.subarray(0, end - 1);
}

// ---------------------------------------------------------------------------------------------
// VAPID (RFC 8292): proves to the browser's push service that the message comes from this website.
// ---------------------------------------------------------------------------------------------
function generateVapidKeys() {
  const e = crypto.createECDH("prime256v1"); e.generateKeys();
  const priv = e.getPrivateKey(); const padded = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(padded) };
}
function vapidFromEnv(env) {
  env = env || process.env;
  const pub = unb64u(env.VAPID_PUBLIC_KEY), priv = unb64u(env.VAPID_PRIVATE_KEY);
  if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return null;
  let subject = String(env.VAPID_SUBJECT || "").trim();
  if (!/^(mailto:|https:\/\/)/i.test(subject)) subject = "mailto:" + (String(env.SUPPORT_EMAIL || "").trim() || "admin@vicopay.live");
  return { publicB64: b64u(pub), pub, priv, subject };
}
function vapidHeader(endpoint, v, nowSec) {
  const aud = new URL(endpoint).origin;
  const input = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" })) + "." + b64u(JSON.stringify({ aud, exp: (nowSec || Math.floor(Date.now() / 1000)) + 12 * 3600, sub: v.subject }));
  const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64u(v.priv), x: b64u(v.pub.subarray(1, 33)), y: b64u(v.pub.subarray(33, 65)) }, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });   // raw r||s, as JWT ES256 requires
  return "vapid t=" + input + "." + b64u(sig) + ", k=" + v.publicB64;
}

// Only the real browser push services are ever contacted. A person cannot register an address that points at one of OUR internal servers.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/i, /(^|\.)push\.services\.mozilla\.com$/i, /(^|\.)notify\.windows\.com$/i, /(^|\.)push\.apple\.com$/i];
function endpointOk(raw, env) {
  let u; try { u = new URL(String(raw)); } catch (_) { return false; }
  if (String(raw).length > 1000 || u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.indexOf(":") >= 0) return false;
  const extra = String((env || process.env).PUSH_EXTRA_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return PUSH_HOSTS.some((re) => re.test(h)) || extra.indexOf(h) >= 0;
}
function validWebSubscription(sub, env) {
  if (!sub || typeof sub !== "object" || !sub.keys) return null;
  const endpoint = String(sub.endpoint || ""), p256dh = String(sub.keys.p256dh || ""), auth = String(sub.keys.auth || "");
  const k = unb64u(p256dh), a = unb64u(auth);
  if (!endpointOk(endpoint, env) || k.length !== 65 || k[0] !== 4 || a.length !== 16) return null;
  return { endpoint, p256dh: b64u(k), auth: b64u(a) };
}

// ---------------------------------------------------------------------------------------------
// Firebase Cloud Messaging (HTTP v1). The login is a service-account JWT exchanged for a short-lived access token.
// ---------------------------------------------------------------------------------------------
function serviceAccountFromEnv(env) {
  env = env || process.env;
  let raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    if (raw[0] !== "{") raw = Buffer.from(raw, "base64").toString("utf8");
    const j = JSON.parse(raw);
    const projectId = String(env.FIREBASE_PROJECT_ID || j.project_id || "").trim();
    if (!j.client_email || !j.private_key || !projectId || !/^[a-z0-9-]+$/i.test(projectId)) return null;
    return { clientEmail: j.client_email, privateKey: String(j.private_key).replace(/\\n/g, "\n"), projectId, tokenUri: "https://oauth2.googleapis.com/token" };   // the token address is fixed on purpose
  } catch (_) { return null; }
}
function serviceJwt(sa, nowSec) {
  const iat = nowSec || Math.floor(Date.now() / 1000);
  const input = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64u(JSON.stringify({ iss: sa.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: sa.tokenUri, iat, exp: iat + 3600 }));
  return input + "." + b64u(crypto.sign("RSA-SHA256", Buffer.from(input), sa.privateKey));
}
const validFcmToken = (t) => typeof t === "string" && t.length >= 20 && t.length <= 4096 && /^[A-Za-z0-9_:.\-]+$/.test(t);

// ---------------------------------------------------------------------------------------------
// The service the rest of the site uses
// ---------------------------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vm_push_devices (id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT, auth TEXT, created_at BIGINT NOT NULL, last_ok_at BIGINT, fails INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_vm_push_endpoint ON vm_push_devices(endpoint)`,
  `CREATE INDEX IF NOT EXISTS idx_vm_push_email ON vm_push_devices(email)`
];

function makePush({ db, axios, env }) {
  env = env || process.env;
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const http = () => axios || require("axios");
  const vapid = vapidFromEnv(env), sa = serviceAccountFromEnv(env);
  let fcmToken = { value: "", exp: 0 };

  const webReady = () => !!vapid, fcmReady = () => !!sa;

  async function fcmAccess() {
    if (fcmToken.value && fcmToken.exp - 60000 > now()) return fcmToken.value;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceJwt(sa) }).toString();
    const r = await http().post(sa.tokenUri, body, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    if (!r.data || !r.data.access_token) throw new Error("Firebase gave no access token");
    fcmToken = { value: r.data.access_token, exp: now() + Number(r.data.expires_in || 3600) * 1000 };
    return fcmToken.value;
  }

  // Each sender returns "ok" | "gone" (the device is no longer valid: forget it) | "fail" (try again later)
  async function sendWeb(d, payload) {
    const body = encryptWebPush(JSON.stringify(payload), d.p256dh, d.auth);
    const r = await http().post(d.endpoint, body, { timeout: 10000, maxRedirects: 0, validateStatus: () => true,
      headers: { Authorization: vapidHeader(d.endpoint, vapid), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "600", Urgency: "high" } });
    if (r.status >= 200 && r.status < 300) return "ok";
    if (r.status === 404 || r.status === 410) return "gone";
    console.error("VICO PUSH (web) status", r.status);
    return "fail";
  }
  async function sendFcm(d, payload) {
    const data = {}; for (const k of Object.keys(payload.data || {})) data[k] = String(payload.data[k]);
    const token = await fcmAccess();
    const r = await http().post("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(sa.projectId) + "/messages:send",
      { message: { token: d.endpoint, notification: { title: payload.title, body: payload.body }, data, android: { priority: "HIGH", ttl: "600s", notification: { tag: payload.tag || "vm" } } } },
      { timeout: 10000, validateStatus: () => true, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (r.status >= 200 && r.status < 300) return "ok";
    const err = r.data && r.data.error, codes = [err && err.status].concat(((err && err.details) || []).map((x) => x && x.errorCode)).filter(Boolean);
    if (r.status === 404 || codes.indexOf("UNREGISTERED") >= 0 || codes.indexOf("NOT_FOUND") >= 0) return "gone";
    if (r.status === 401) fcmToken = { value: "", exp: 0 };
    console.error("VICO PUSH (fcm) status", r.status, codes.join(","));
    return "fail";
  }

  async function devices(email) { return db.all("SELECT id, kind, endpoint, p256dh, auth FROM vm_push_devices WHERE email = ? ORDER BY id DESC LIMIT " + MAX_DEVICES, [lc(email)]); }
  async function trim(email) {
    const rows = await db.all("SELECT id FROM vm_push_devices WHERE email = ? ORDER BY id DESC", [lc(email)]);
    for (const r of rows.slice(MAX_DEVICES)) await db.run("DELETE FROM vm_push_devices WHERE id = ?", [r.id]);
  }
  async function upsert(email, kind, endpoint, p256dh, auth) {
    const t = now();
    // the same browser signing in with another account moves the registration to that account
    await db.run(`INSERT INTO vm_push_devices (email, kind, endpoint, p256dh, auth, created_at, last_ok_at, fails) VALUES (?,?,?,?,?,?,NULL,0)
      ON CONFLICT (endpoint) DO UPDATE SET email = EXCLUDED.email, kind = EXCLUDED.kind, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, fails = 0`, [lc(email), kind, endpoint, p256dh || null, auth || null, t]);
    await trim(email);
  }

  return {
    SCHEMA, webReady, fcmReady, anyReady: () => webReady() || fcmReady(), publicKey: () => (vapid ? vapid.publicB64 : ""),
    async addWeb(email, subscription) { const s = validWebSubscription(subscription, env); if (!s) return false; await upsert(email, "web", s.endpoint, s.p256dh, s.auth); return true; },
    async addFcm(email, token) { if (!validFcmToken(token)) return false; await upsert(email, "fcm", token, null, null); return true; },
    async remove(email, endpoint) { await db.run("DELETE FROM vm_push_devices WHERE email = ? AND endpoint = ?", [lc(email), String(endpoint || "")]); },
    async counts(email) {
      const rows = await devices(email);
      return { web: webReady() ? rows.filter((r) => r.kind === "web").length : 0, fcm: fcmReady() ? rows.filter((r) => r.kind === "fcm").length : 0 };
    },
    // Sends one message to every device this person registered. Returns { sent, tried, kinds }.
    async sendToUser(email, payload) {
      const rows = (await devices(email)).filter((r) => (r.kind === "web" && webReady()) || (r.kind === "fcm" && fcmReady()));
      const out = { sent: 0, tried: rows.length, kinds: [] };
      await Promise.all(rows.map(async (d) => {
        let res; try { res = d.kind === "web" ? await sendWeb(d, payload) : await sendFcm(d, payload); } catch (e) { console.error("VICO PUSH ERROR (" + d.kind + "):", e.message); res = "fail"; }
        if (res === "ok") { out.sent++; if (out.kinds.indexOf(d.kind) < 0) out.kinds.push(d.kind); await db.run("UPDATE vm_push_devices SET last_ok_at = ?, fails = 0 WHERE id = ?", [now(), d.id]); }
        else if (res === "gone") await db.run("DELETE FROM vm_push_devices WHERE id = ?", [d.id]);
        else await db.run("UPDATE vm_push_devices SET fails = fails + 1 WHERE id = ?", [d.id]);
      }));
      return out;
    }
  };
}

module.exports = makePush;
Object.assign(module.exports, { SCHEMA, encryptWebPush, decryptWebPush, generateVapidKeys, vapidFromEnv, vapidHeader, endpointOk, validWebSubscription, serviceAccountFromEnv, serviceJwt, validFcmToken, b64u, unb64u, MAX_DEVICES, HOUR });

// node vico-push.js keys   -> prints a new VAPID key pair for the .env file
if (require.main === module) {
  if (process.argv[2] === "keys") {
    const k = generateVapidKeys();
    console.log("Add these three lines to your .env file (and to the Render Environment screen):\n\nVAPID_PUBLIC_KEY=" + k.publicKey + "\nVAPID_PRIVATE_KEY=" + k.privateKey + "\nVAPID_SUBJECT=mailto:you@yourdomain.com\n\nKeep the private key secret. If you ever change it, everyone must allow notifications again.");
  } else console.log("Usage: node vico-push.js keys");
}
