// Vico Message phone verification — `node tests/vico-phone-push.test.js`
// Part 1: Infobip SMS request/response handling, Web Push encryption (checked against the RFC 8291 example), VAPID, Firebase login. Pure.
// Part 2: the real routes (SMS and push delivery of the SAME code, device registration, number-ownership rules) on Node's built-in SQLite.
process.removeAllListeners("warning");
const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const phone = require("../vico-phone");
const push = require("../vico-push");

// ---------- Part 1a: Infobip ----------
const IB = { INFOBIP_API_KEY: "KEY", INFOBIP_BASE_URL: "https://abc12.api.infobip.com/", APP_URL: "https://vicopay.live" };
assert.strictEqual(phone.providerName(IB), "infobip");
assert.strictEqual(phone.providerName({ ...IB, TERMII_API_KEY: "k" }), "infobip");                    // Infobip is used first when several are set
assert.strictEqual(phone.providerName({ ...IB, TERMII_API_KEY: "k", SMS_PROVIDER: "termii" }), "termii");
assert.strictEqual(phone.providerName({ INFOBIP_API_KEY: "KEY" }), "none");                            // a key without a base URL is not usable
assert.strictEqual(phone.providerName({ INFOBIP_API_KEY: "KEY", INFOBIP_BASE_URL: "not a host!" }), "none");
assert.strictEqual(phone.infobipHost({ INFOBIP_BASE_URL: "HTTP://xyz.api.infobip.com/sms/3/x?y=1" }), "xyz.api.infobip.com");
const iq = phone.buildSmsRequest("infobip", { to: "+2348012345678", text: phone.codeText("123456", IB) }, IB);
assert.strictEqual(iq.url, "https://abc12.api.infobip.com/sms/3/messages");
assert.strictEqual(iq.headers.Authorization, "App KEY");
assert.strictEqual(iq.data.messages[0].destinations[0].to, "2348012345678");                          // digits only, no +
assert.strictEqual(iq.data.messages[0].sender, "InfoSMS");
assert.strictEqual(phone.buildSmsRequest("infobip", { to: "+1", text: "x" }, { ...IB, INFOBIP_SENDER: "VicoPay" }).data.messages[0].sender, "VicoPay");
assert.ok(iq.data.messages[0].content.text.endsWith("@vicopay.live #123456"));                        // Web OTP autofill line
assert.ok(!phone.codeText("123456", {}).includes("@"));

// ---------- Part 1b: Web Push encryption (RFC 8291 section 5 / appendix A) ----------
{
  const ua = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth = "BTBZMqHH6r4Tts7J_aSIgg";
  const body = push.encryptWebPush("When I grow up, I want to be a watermelon", ua, auth,
    { asPrivate: push.unb64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: push.unb64u("DGv6ra1nlYgDCS1FRnbzlw") });
  const expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
  assert.strictEqual(push.b64u(body), expected);
  assert.strictEqual(push.decryptWebPush(push.unb64u(expected), push.unb64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), ua, auth).toString(), "When I grow up, I want to be a watermelon");
}
// random round trip, tamper detection, size limit
function browserKeys() { const e = crypto.createECDH("prime256v1"); e.generateKeys(); return { priv: e.getPrivateKey(), p256dh: push.b64u(e.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) }; }
{
  const k = browserKeys(), msg = JSON.stringify({ title: "Código ✓", code: "654321" });
  const body = push.encryptWebPush(msg, k.p256dh, k.auth);
  assert.strictEqual(push.decryptWebPush(body, k.priv, k.p256dh, k.auth).toString("utf8"), msg);
  assert.notStrictEqual(push.b64u(body), push.b64u(push.encryptWebPush(msg, k.p256dh, k.auth)));      // a fresh key and salt every time
  const bad = Buffer.from(body); bad[bad.length - 1] ^= 1; assert.throws(() => push.decryptWebPush(bad, k.priv, k.p256dh, k.auth));
  assert.throws(() => push.encryptWebPush("x".repeat(4100), k.p256dh, k.auth), /too large/);
  assert.throws(() => push.encryptWebPush("x", "AAAA", k.auth), /p256dh/);
}

// ---------- Part 1c: VAPID ----------
{
  const keys = push.generateVapidKeys(); assert.strictEqual(push.unb64u(keys.publicKey).length, 65); assert.strictEqual(push.unb64u(keys.privateKey).length, 32);
  assert.strictEqual(push.vapidFromEnv({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: "x" }), null);
  const v = push.vapidFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:a@b.com" });
  const h = push.vapidHeader("https://fcm.googleapis.com/fcm/send/abc", v, 1700000000);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h); assert.ok(m, h); assert.strictEqual(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], "base64url")); assert.deepStrictEqual(claims, { aud: "https://fcm.googleapis.com", exp: 1700000000 + 43200, sub: "mailto:a@b.com" });
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: push.b64u(v.pub.subarray(1, 33)), y: push.b64u(v.pub.subarray(33, 65)) }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")), "VAPID signature must verify");
}

// ---------- Part 1d: push addresses (only real push services) ----------
for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/abc"]) assert.ok(push.endpointOk(ok, {}), ok);
for (const no of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://127.0.0.1/x", "https://localhost/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "javascript:alert(1)", "", "https://[::1]/x"]) assert.ok(!push.endpointOk(no, {}), no);
assert.ok(push.endpointOk("https://push.example.org/x", { PUSH_EXTRA_HOSTS: "push.example.org" }));
{
  const k = browserKeys();
  assert.ok(push.validWebSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: k.p256dh, auth: k.auth } }, {}));
  assert.strictEqual(push.validWebSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "AAAA", auth: k.auth } }, {}), null);
  assert.strictEqual(push.validWebSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: k.p256dh, auth: "AAAA" } }, {}), null);
  assert.strictEqual(push.validWebSubscription(null, {}), null);
}

// ---------- Part 1e: Firebase service account ----------
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const saJson = JSON.stringify({ project_id: "vico-test", client_email: "svc@vico-test.iam.gserviceaccount.com", private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }) });
{
  const a = push.serviceAccountFromEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: saJson }), b = push.serviceAccountFromEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(saJson).toString("base64") });
  assert.ok(a && b && a.projectId === "vico-test" && b.clientEmail === a.clientEmail);
  assert.strictEqual(push.serviceAccountFromEnv({}), null); assert.strictEqual(push.serviceAccountFromEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: "{bad" }), null);
  assert.strictEqual(push.serviceAccountFromEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: saJson, FIREBASE_PROJECT_ID: "../evil" }), null);
  const jwt = push.serviceJwt(a, 1700000000).split("."); const claims = JSON.parse(Buffer.from(jwt[1], "base64url"));
  assert.strictEqual(claims.iss, a.clientEmail); assert.strictEqual(claims.scope, "https://www.googleapis.com/auth/firebase.messaging"); assert.strictEqual(claims.exp, 1700003600);
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(jwt[0] + "." + jwt[1]), rsa.publicKey, Buffer.from(jwt[2], "base64url")));
  assert.ok(push.validFcmToken("fAbC123_-:xyz.0123456789ABCDEF") && !push.validFcmToken("short") && !push.validFcmToken("has space in it 0123456789"));
}

// ---------- Part 2: routes ----------
function boot(envExtra, axiosMock) {
  const sq = new DatabaseSync(":memory:");
  const tr = (s) => s.replace(/BIGSERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT").replace(/\bBIGINT\b/g, "INTEGER").replace(/\bSMALLINT\b/g, "INTEGER").replace(/ADD COLUMN IF NOT EXISTS/g, "ADD COLUMN");
  const exec = (sql, p) => { const st = sq.prepare(tr(sql)); p = (p || []).map((v) => (v === undefined ? null : v)); return /^\s*SELECT/i.test(sql) || /\bRETURNING\b/i.test(sql) ? { rows: st.all(...p).map((r) => ({ ...r })) } : { rows: [], changes: Number(st.run(...p).changes) }; };
  const api = { all: async (s, p) => exec(s, p).rows, get: async (s, p) => exec(s, p).rows[0], run: async (s, p) => { const r = exec(s, p); return { changes: r.changes === undefined ? r.rows.length : r.changes, rows: r.rows }; } };
  const db = { ...api, tx: async (fn) => { sq.exec("BEGIN"); try { const r = await fn(api); sq.exec("COMMIT"); return r; } catch (e) { sq.exec("ROLLBACK"); throw e; } },
    pool: { connect: async () => ({ query: async (s) => { if (/pg_advisory/.test(s)) return; try { sq.exec(tr(s)); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }, release() {} }) } };
  for (const s of [`CREATE TABLE ad_job_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, tier TEXT, status TEXT)`,
    `CREATE TABLE ad_job_profiles (order_id INTEGER PRIMARY KEY, business_name TEXT, description TEXT, phone TEXT, whatsapp TEXT, city TEXT, country TEXT, complete INTEGER)`,
    `CREATE TABLE ad_job_identity (order_id INTEGER PRIMARY KEY, status TEXT)`, `CREATE TABLE company_verification_applications (order_id INTEGER, status TEXT)`]) sq.exec(s);
  const accounts = new Map();
  ["alice", "bob", "carol", "dave"].forEach((u) => accounts.set(u + "@x.com", { email: u + "@x.com", username: u, displayName: u, handle: u }));
  const store = { users: { resolveHandle: async (h) => { h = String(h).toLowerCase(); const a = [...accounts.values()].find((x) => x.email === h || x.handle === h); return a ? a.email : null; }, warm: async () => {}, exists: async (e) => accounts.has(e),
      search: async (q) => [...accounts.values()].filter((a) => a.username.includes(String(q).toLowerCase())), setDisplayName: async () => {} },
    publicHandle: (e) => (accounts.get(e) || { handle: "u" }).handle, displayNameOf: (e) => (accounts.get(e) || { displayName: "User" }).displayName, avatarUrl: () => null };
  const requireAuth = (req, res, next) => { const e = req.headers["x-test-user"]; if (!e || !accounts.has(e)) return res.status(401).json({ success: false, message: "Please sign in." }); req.userEmail = e; next(); };
  const verifiedEmails = new Set();
  const env = { NODE_ENV: "test", VM_DEV_ECHO_CODE: "1", ...envExtra };
  const app = express(); app.use(express.json());
  const origLog = console.log; console.log = () => {};
  const vm = require("../vico-messages")({ app, db, requireAuth, store, env, axios: axiosMock, isEmailVerified: async (e) => verifiedEmails.has(e), callAccess: async () => ({ requiresPayment: false }), wallet: null });
  return vm.migrate.then(async () => {
    const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
    const base = "http://127.0.0.1:" + server.address().port;
    const call = async (as, method, path, body) => { const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(as ? { "x-test-user": as + "@x.com" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return { ...j, status: r.status }; };
    return { GET: (as, p) => call(as, "GET", p), POST: (as, p, b) => call(as, "POST", p, b || {}), db, verifiedEmails, close: () => { server.close(); console.log = origLog; } };
  });
}

(async () => {
  const realErr = console.error; console.error = () => {};
  // ----- A: web push + SMS(console) on one backend -----
  const keys = push.generateVapidKeys(), posts = []; let webStatus = 201;
  const axiosA = { post: async (url, data, opts) => { posts.push({ url, data, opts }); return { status: webStatus, data: {} }; } };
  const A = await boot({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:t@x.com" }, axiosA);
  const NUM = "08012345678", E164 = "+2348012345678";

  let st = await A.GET("alice", "/api/vm/status");
  assert.strictEqual(st.push.web, true); assert.strictEqual(st.push.fcm, false); assert.strictEqual(st.push.publicKey, keys.publicKey); assert.strictEqual(st.phoneRequired, false); assert.strictEqual(st.phoneVerified, false);
  assert.strictEqual((await A.GET(null, "/api/vm/push/config")).status, 401);
  assert.strictEqual((await A.GET("alice", "/api/vm/push/config")).publicKey, keys.publicKey);

  // push code before any device is registered: refused cleanly, nothing consumed
  let r = await A.POST("alice", "/api/vm/phone/send", { phone: NUM, country: "NG", channel: "push" });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.noPushDevice, true); assert.strictEqual(r.useSms, true);

  // registering devices: bad ones are refused
  const k = browserKeys(), good = { endpoint: "https://fcm.googleapis.com/fcm/send/alice-device", keys: { p256dh: k.p256dh, auth: k.auth } };
  assert.strictEqual((await A.POST("alice", "/api/vm/push/subscribe", { subscription: { ...good, endpoint: "https://169.254.169.254/x" } })).status, 400);
  assert.strictEqual((await A.POST("alice", "/api/vm/push/subscribe", { subscription: { ...good, keys: { p256dh: "AAAA", auth: k.auth } } })).status, 400);
  assert.strictEqual((await A.POST("alice", "/api/vm/push/subscribe", {})).status, 400);
  assert.strictEqual((await A.POST("alice", "/api/vm/push/fcm", { token: "x".repeat(30) })).status, 503);          // Firebase not configured here
  assert.strictEqual((await A.POST(null, "/api/vm/push/subscribe", { subscription: good })).status, 401);
  assert.ok((await A.POST("alice", "/api/vm/push/subscribe", { subscription: good })).success);
  assert.ok((await A.POST("alice", "/api/vm/push/subscribe", { subscription: good })).success);                    // same device again: still one row
  assert.strictEqual((await A.GET("alice", "/api/vm/push/config")).devices.web, 1);

  // push delivery: the browser can decrypt the message and the code in it verifies
  r = await A.POST("alice", "/api/vm/phone/send", { phone: NUM, country: "NG", channel: "push" });
  assert.ok(r.success && r.sent && r.channel === "push" && r.via === "web", JSON.stringify(r));
  assert.strictEqual(posts.length, 1); const p = posts[0];
  assert.strictEqual(p.url, good.endpoint); assert.ok(/^vapid t=.+, k=/.test(p.opts.headers.Authorization)); assert.strictEqual(p.opts.headers["Content-Encoding"], "aes128gcm"); assert.strictEqual(p.opts.maxRedirects, 0);
  const msg = JSON.parse(push.decryptWebPush(p.data, k.priv, k.p256dh, k.auth).toString("utf8"));
  assert.ok(/^\d{6}$/.test(msg.data.code) && msg.body.includes(msg.data.code) && msg.data.type === "vm_phone_code", JSON.stringify(msg));
  assert.ok(!JSON.stringify(r).includes(msg.data.code), "the API response must not leak the code");
  r = await A.POST("alice", "/api/vm/phone/verify", { code: msg.data.code === "000000" ? "000001" : "000000" }); assert.strictEqual(r.success, false);   // a wrong code fails
  r = await A.POST("alice", "/api/vm/phone/verify", { code: msg.data.code });
  assert.ok(r.success && r.verified && r.via === "push", JSON.stringify(r));
  st = await A.GET("alice", "/api/vm/status"); assert.ok(st.activated && st.phoneVerified && st.phoneVerifiedVia === "push");
  // the same code cannot be used twice
  assert.strictEqual((await A.POST("alice", "/api/vm/phone/verify", { code: msg.data.code })).success, false);

  // a push-verified number is not searchable and not a "verified number" badge
  A.verifiedEmails.add("carol@x.com");
  assert.strictEqual((await A.GET("carol", "/api/vm/contacts/search?q=" + encodeURIComponent(E164))).people.length, 0);

  // a number proven only by push can be claimed by whoever receives an SMS on it (stops squatting)
  r = await A.POST("bob", "/api/vm/phone/send", { phone: NUM, country: "NG", channel: "push" }); assert.strictEqual(r.status, 409);   // push cannot take a number that is taken
  r = await A.POST("bob", "/api/vm/phone/send", { phone: NUM, country: "NG" });
  assert.ok(r.success && r.channel === "sms" && r.devCode, JSON.stringify(r));
  r = await A.POST("bob", "/api/vm/phone/verify", { code: r.devCode }); assert.ok(r.success && r.via === "sms", JSON.stringify(r));
  st = await A.GET("alice", "/api/vm/status"); assert.strictEqual(st.phoneVerified, false);
  st = await A.GET("bob", "/api/vm/status"); assert.ok(st.phoneVerified && st.phoneVerifiedVia === "sms");
  assert.strictEqual((await A.GET("carol", "/api/vm/contacts/search?q=" + encodeURIComponent(E164))).people.length, 1);          // SMS-verified: searchable
  // an SMS-verified number can NOT be taken over by anyone
  assert.strictEqual((await A.POST("dave", "/api/vm/phone/send", { phone: NUM, country: "NG" })).status, 409);
  assert.strictEqual((await A.POST("dave", "/api/vm/phone/send", { phone: NUM, country: "NG", channel: "push" })).status, 409);

  // push to a dead device: 410 removes it; the person is told to use SMS and can do so straight away
  assert.ok((await A.POST("dave", "/api/vm/push/subscribe", { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/dave-device", keys: { p256dh: k.p256dh, auth: k.auth } } })).success);
  webStatus = 410;
  r = await A.POST("dave", "/api/vm/phone/send", { phone: "08099990000", country: "NG", channel: "push" });
  assert.strictEqual(r.status, 502); assert.strictEqual(r.useSms, true);
  assert.strictEqual((await A.GET("dave", "/api/vm/push/config")).devices.web, 0);
  r = await A.POST("dave", "/api/vm/phone/send", { phone: "08099990000", country: "NG" }); assert.ok(r.success && r.devCode, JSON.stringify(r));
  // a temporary push-service error keeps the device
  await A.db.run("UPDATE vm_otps SET last_sent_at = 0 WHERE email = ?", ["dave@x.com"]);   // as if the 60-second resend wait had passed
  webStatus = 500; assert.ok((await A.POST("dave", "/api/vm/push/subscribe", { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/dave-2", keys: { p256dh: k.p256dh, auth: k.auth } } })).success);
  r = await A.POST("dave", "/api/vm/phone/send", { phone: "08099990000", country: "NG", channel: "push" }); assert.strictEqual(r.status, 502);
  assert.strictEqual((await A.GET("dave", "/api/vm/push/config")).devices.web, 1);
  // unsubscribe
  assert.ok((await A.POST("dave", "/api/vm/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/dave-2" })).success);
  assert.strictEqual((await A.GET("dave", "/api/vm/push/config")).devices.web, 0);
  // at most 10 devices per person
  for (let i = 0; i < 12; i++) await A.POST("carol", "/api/vm/push/subscribe", { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/c" + i, keys: { p256dh: k.p256dh, auth: k.auth } } });
  assert.strictEqual((await A.GET("carol", "/api/vm/push/config")).devices.web, 10);
  A.close();

  // ----- B: Android (Firebase) delivery -----
  const fposts = [];
  const axiosB = { post: async (url, data, opts) => {
    fposts.push({ url, data, opts });
    if (url === "https://oauth2.googleapis.com/token") return { status: 200, data: { access_token: "ya29.test", expires_in: 3600 } };
    if (/UNREG/.test(JSON.stringify(data))) return { status: 404, data: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } };
    return { status: 200, data: { name: "projects/vico-test/messages/1" } };
  } };
  const B = await boot({ FIREBASE_SERVICE_ACCOUNT_JSON: saJson }, axiosB);
  st = await B.GET("alice", "/api/vm/status"); assert.strictEqual(st.push.fcm, true); assert.strictEqual(st.push.web, false);
  assert.strictEqual((await B.POST("alice", "/api/vm/push/subscribe", { subscription: good })).status, 503);              // no VAPID keys here
  assert.strictEqual((await B.POST("alice", "/api/vm/push/fcm", { token: "bad token" })).status, 400);
  const tok = "fAbC123_-:android0123456789ABCDEF";
  assert.ok((await B.POST("alice", "/api/vm/push/fcm", { token: tok })).success);
  r = await B.POST("alice", "/api/vm/phone/send", { phone: NUM, country: "NG", channel: "push" });
  assert.ok(r.success && r.via === "fcm", JSON.stringify(r));
  assert.strictEqual(fposts.length, 2);
  assert.ok(/grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/.test(fposts[0].data));
  const f = fposts[1]; assert.strictEqual(f.url, "https://fcm.googleapis.com/v1/projects/vico-test/messages:send"); assert.strictEqual(f.opts.headers.Authorization, "Bearer ya29.test");
  assert.strictEqual(f.data.message.token, tok); assert.strictEqual(f.data.message.android.priority, "HIGH"); assert.strictEqual(f.data.message.data.type, "vm_phone_code"); assert.ok(/^\d{6}$/.test(f.data.message.data.code));
  r = await B.POST("alice", "/api/vm/phone/verify", { code: f.data.message.data.code }); assert.ok(r.success && r.via === "push");
  // the access token is reused for the next message
  assert.ok((await B.POST("bob", "/api/vm/push/fcm", { token: "UNREG-fAbC123_-:android0123456789" })).success);
  r = await B.POST("bob", "/api/vm/phone/send", { phone: "08077770000", country: "NG", channel: "push" }); assert.strictEqual(r.status, 502);
  assert.strictEqual(fposts.filter((x) => x.url.includes("oauth2")).length, 1);
  assert.strictEqual((await B.GET("bob", "/api/vm/push/config")).devices.fcm, 0);                                     // UNREGISTERED token forgotten
  B.close();

  // ----- C: push not configured, and VM_REQUIRE_PHONE=on -----
  const C = await boot({ VM_REQUIRE_PHONE: "on" }, { post: async () => ({ status: 200, data: {} }) });
  C.verifiedEmails.add("carol@x.com");
  st = await C.GET("carol", "/api/vm/status"); assert.strictEqual(st.phoneRequired, true); assert.strictEqual(st.push.web, false);
  r = await C.GET("carol", "/api/dm/threads"); assert.strictEqual(r.status, 403); assert.strictEqual(r.needsPhoneVerification, true);   // email alone is not enough
  r = await C.POST("carol", "/api/vm/phone/send", { phone: NUM, country: "NG", channel: "push" }); assert.strictEqual(r.status, 503); assert.strictEqual(r.useSms, true);
  r = await C.POST("carol", "/api/vm/phone/send", { phone: NUM, country: "NG" }); assert.ok(r.success && r.devCode);
  assert.ok((await C.POST("carol", "/api/vm/phone/verify", { code: r.devCode })).success);
  assert.strictEqual((await C.GET("carol", "/api/dm/threads")).status, 200);                                            // now it works
  C.close();

  // ----- D: Infobip really is called through the route, with the code in the text -----
  const iposts = [];
  const D = await boot({ NODE_ENV: "test", VM_DEV_ECHO_CODE: "", INFOBIP_API_KEY: "KEY", INFOBIP_BASE_URL: "abc12.api.infobip.com", INFOBIP_SENDER: "VicoPay" },
    { post: async (url, data, opts) => { iposts.push({ url, data, opts }); return { status: 200, data: { messages: [{ status: { groupId: 1, name: "PENDING_ACCEPTED" } }] } }; } });
  r = await D.POST("alice", "/api/vm/phone/send", { phone: NUM, country: "NG" });
  assert.ok(r.success && r.via === "infobip" && !r.devCode, JSON.stringify(r));
  assert.strictEqual(iposts[0].url, "https://abc12.api.infobip.com/sms/3/messages"); assert.strictEqual(iposts[0].data.messages[0].destinations[0].to, "2348012345678");
  const sms = iposts[0].data.messages[0].content.text, sent = /\b(\d{6})\b/.exec(sms)[1];
  assert.ok(D.POST && (await D.POST("alice", "/api/vm/phone/verify", { code: sent })).success);
  D.close();
  const E = await boot({ NODE_ENV: "test", VM_DEV_ECHO_CODE: "", INFOBIP_API_KEY: "KEY", INFOBIP_BASE_URL: "abc12.api.infobip.com" },
    { post: async () => ({ status: 200, data: { messages: [{ status: { groupId: 5, name: "REJECTED_NOT_ENOUGH_CREDITS" } }] } }) });
  r = await E.POST("alice", "/api/vm/phone/send", { phone: NUM, country: "NG" }); assert.strictEqual(r.success, false);   // a rejected SMS is reported, never pretended
  E.close();

  console.error = realErr;
  console.log("vico phone + push tests passed");
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + "\n"); process.exit(1); });
