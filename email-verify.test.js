// Email verification (Resend) — `node tests/email-verify.test.js` (no network, no database)
const assert = require("assert"), crypto = require("crypto");
const { verifyWebhook, hashCode } = require("../email-verify");
// 1. Resend/Svix webhook signature
const secretBytes = crypto.randomBytes(24), secret = "whsec_" + secretBytes.toString("base64");
const body = Buffer.from(JSON.stringify({ type: "email.bounced", data: { to: ["a@b.com"] } })), id = "msg_1", ts = String(Math.floor(Date.now() / 1000));
const sig = "v1," + crypto.createHmac("sha256", secretBytes).update(id + "." + ts + "." + body.toString("utf8")).digest("base64");
assert.strictEqual(verifyWebhook({ secret, id, timestamp: ts, signature: sig, rawBody: body }), true);
assert.strictEqual(verifyWebhook({ secret, id, timestamp: ts, signature: "v1,AAAA " + sig, rawBody: body }), true);                      // several signatures: any one may match
assert.strictEqual(verifyWebhook({ secret, id, timestamp: ts, signature: sig, rawBody: Buffer.from(body + " ") }), false);                // changed body
assert.strictEqual(verifyWebhook({ secret: "whsec_" + crypto.randomBytes(24).toString("base64"), id, timestamp: ts, signature: sig, rawBody: body }), false); // wrong secret
assert.strictEqual(verifyWebhook({ secret, id, timestamp: String(Number(ts) - 4000), signature: sig, rawBody: body }), false);          // too old (replay)
assert.strictEqual(verifyWebhook({ secret: "", id, timestamp: ts, signature: sig, rawBody: body }), false);                              // no secret set: never accept
console.log("ok  Resend webhook signature: valid accepted; changed body, wrong secret, old message and missing secret refused");
// 2. code check
assert.notStrictEqual(hashCode("s1", "123456"), hashCode("s2", "123456"));
assert.strictEqual(hashCode("s1", " 123456 "), hashCode("s1", "123456"));
console.log("ok  verification codes are stored hashed with a per-code salt");

// 3. the full send -> wrong code -> right code flow with a fake database
(async () => {
  process.env.RESEND_API_KEY = ""; process.env.MAIL_FROM = "";          // no Resend: the code is printed to the server log instead
  const routes = {}, app = { get: (p, ...h) => (routes["GET " + p] = h), post: (p, ...h) => (routes["POST " + p] = h) };
  const row = {}; const logs = []; const origLog = console.log; console.log = (...a) => logs.push(a.join(" "));
  const db = { pool: { connect: async () => ({ query: async () => ({}), release() {} }) },
    async get(sql, p) {
      if (/FROM email_verifications/.test(sql)) return row.email ? { ...row } : null;
      if (/FROM email_delivery/.test(sql)) return null; return null; },
    async run(sql, p) {
      if (/INSERT INTO email_verifications/.test(sql)) Object.assign(row, { email: p[0], salt: p[1], code_hash: p[2], expires_at: p[3], wrong_tries: 0, last_sent_at: p[5], verified_at: null });
      else if (/wrong_tries = wrong_tries \+ 1/.test(sql)) row.wrong_tries++;
      else if (/SET verified_at/.test(sql)) { row.verified_at = p[0]; row.code_hash = null; } return {}; } };
  require("../email-verify")({ app, db, requireAuth: (q, r, n) => n() });
  const call = (key, req) => new Promise(async (resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    req.headers = {}; req.body = req.body || {}; req.userEmail = "new@user.com"; let i = 0; const next = async () => { const h = routes[key][i++]; if (h) await h(req, res, next); }; await next(); });
  await new Promise((r) => setTimeout(r, 20));
  let r = await call("POST /api/email-verify/send", {}); assert.strictEqual(r.body.sent, true);
  const code = (logs.find((l) => /VERIFICATION CODE/.test(l)) || "").split(": ").pop(); console.log = origLog; assert.ok(/^\d{6}$/.test(code));
  r = await call("POST /api/email-verify/send", {}); assert.strictEqual(r.code, 429);                                   // 60 second wait between codes
  r = await call("POST /api/email-verify/confirm", { body: { code: code === "000000" ? "111111" : "000000" } }); assert.strictEqual(r.body.success, false);
  r = await call("POST /api/email-verify/confirm", { body: { code } }); assert.strictEqual(r.body.verified, true);
  console.log("ok  send a code, wait between codes, wrong code refused, right code verifies the email");
})().then(forwardTest).catch((e) => { console.error(e); process.exit(1); });

// 4. incoming mail is forwarded to INBOX_FORWARD_TO (Resend Receiving API stubbed)
async function forwardTest() {
  const Module = require("module"), sent = [], gets = [];
  const orig = Module._load;
  Module._load = function (req, ...a) { if (req === "axios") return {
    get: async (u) => { gets.push(u); return { data: { from: "Ada <ada@x.com>", to: ["hello@vicopay.live"], subject: "Hi there", html: "<p>Hello</p>", attachments: [] } }; },
    post: async (u, body) => { sent.push(body); return { data: {} }; } }; return orig.call(this, req, ...a); };
  process.env.RESEND_API_KEY = "re_x"; process.env.MAIL_FROM = "Vico Pay <no-reply@vicopay.live>"; process.env.INBOX_FORWARD_TO = "me@gmail.com";
  const db = { pool: { connect: async () => ({ query: async () => ({}), release() {} }) } };
  const ev = require("../email-verify")({ app: { get() {}, post() {} }, db, requireAuth() {} });
  await ev.forwardReceived({ email_id: "abc", from: "Ada <ada@x.com>" });
  assert.strictEqual(gets[0], "https://api.resend.com/emails/receiving/abc");
  assert.deepStrictEqual([sent[0].to, sent[0].subject, sent[0].reply_to], [["me@gmail.com"], "Fwd: Hi there", "ada@x.com"]);
  const before = sent.length;
  Module._load = function (req, ...a) { if (req === "axios") return { get: async () => ({ data: { from: "Vico Pay <no-reply@vicopay.live>", subject: "x" } }), post: async (u, b) => { sent.push(b); return { data: {} }; } }; return orig.call(this, req, ...a); };
  await require("../email-verify")({ app: { get() {}, post() {} }, db, requireAuth() {} }).forwardReceived({ email_id: "loop" });
  assert.strictEqual(sent.length, before);                                                                              // our own mail is never forwarded back
  Module._load = orig;
  console.log("ok  incoming mail is fetched from Resend and forwarded to INBOX_FORWARD_TO with reply-to set to the sender");
  console.log("\nALL EMAIL VERIFICATION CHECKS PASSED"); process.exit(0);
}
