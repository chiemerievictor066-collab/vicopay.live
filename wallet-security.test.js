// Wallet PIN / OTP / limits / guard — `node tests/wallet-security.test.js` (no network, no database)
const assert = require("assert");
const W = require("../wallet-security");

// ---- PIN rules ----
assert.strictEqual(W.validPin("4821"), ""); for (const p of ["123", "12345", "abcd", "", null, "0000", "7777", "1234", "4321", "0123", "9876"]) assert.ok(W.validPin(p), "should refuse " + p);
// ---- lock grows when it repeats: 30 min, 1 h, 2 h ... never more than 24 h ----
assert.deepStrictEqual([1, 2, 3, 4, 10].map(W.lockMinutes), [30, 60, 120, 240, 1440]);
assert.strictEqual(W.maskEmail("example2562@gmail.com"), "ex••••••@gmail.com");
// ---- limits ----
const L = { maxTx: 500000, daily: 1000000 };
assert.strictEqual(W.limitError({ amount: 50000, ...L, usedToday: 0 }), ""); assert.ok(W.limitError({ amount: 600000, ...L, usedToday: 0 }).includes("500,000")); assert.ok(W.limitError({ amount: 400000, ...L, usedToday: 700000 }).includes("24-hour"));
// ---- when an email code is needed too ----
const base = { action: "withdraw", amount: 5000, otpAbove: 20000, newDevice: false, justChanged: false };
assert.strictEqual(W.otpReason(base), ""); assert.strictEqual(W.otpReason({ ...base, amount: 50000 }), "amount"); assert.strictEqual(W.otpReason({ ...base, newDevice: true }), "device");
assert.strictEqual(W.otpReason({ ...base, justChanged: true }), "cooloff"); assert.strictEqual(W.otpReason({ ...base, action: "gift", amount: 0 }), ""); assert.strictEqual(W.otpReason({ ...base, action: "gift", amount: 0, newDevice: true }), "device");

// ---- the guard in front of money routes (stub app + stub db) ----
(async () => {
  const routes = {}, app = { post: (p, h) => { if (p.startsWith("/api/creator") || p === "/api/seller/withdraw" || p === "/api/gifts/send" || p === "/api/live/send-gift") routes[p] = h; }, get() {} };
  const toks = {};   // token_hash -> {email, action, amount, uses, max}
  const crypto = require("crypto"), sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
  const db = {
    pool: { connect: async () => ({ query: async () => ({}), release() {} }) },
    get: async (sql, p) => {
      if (sql.startsWith("UPDATE wallet_auth SET uses = uses + 1")) { const [h, email, action, amount] = p, t = toks[h]; if (t && t.email === email && t.action === action && t.amount === amount && t.uses < t.max) { t.uses++; return { uses: t.uses }; } return null; }
      if (sql.includes("FROM wallet_pins")) return { salt: "s", hash: "h" };
      return null;
    },
    run: async (sql, p) => { if (sql.startsWith("UPDATE wallet_auth SET uses = GREATEST")) { const t = toks[p[0]]; if (t) t.uses = Math.max(0, t.uses - 1); } return { changes: 1 }; }
  };
  process.env.WALLET_SECURITY = "on";
  W({ app, db, requireAuth: () => {}, getAuthEmail: (req) => req.email }).guard();
  assert.ok(routes["/api/creator/withdrawal/request"] && routes["/api/seller/withdraw"] && routes["/api/gifts/send"] && routes["/api/live/send-gift"]);

  const call = (path, req) => new Promise((ok) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { ok({ status: this.statusCode, body: b, next: false }); return this; } };
    routes[path]({ headers: {}, body: {}, ...req }, res, () => ok({ next: true, res }));
  });
  // no token -> 428 asking for the PIN (and tells whether a PIN exists)
  let r = await call("/api/seller/withdraw", { email: "a@x.com", body: { amount: 50000 } }); assert.strictEqual(r.status, 428); assert.ok(r.body.walletAuthRequired && r.body.hasPin);
  // not signed in -> falls through so the route's own sign-in check answers
  assert.ok((await call("/api/seller/withdraw", { body: { amount: 1 } })).next);
  // a withdrawal token is for ONE amount and ONE use
  toks[sha("T1")] = { email: "a@x.com", action: "withdraw", amount: 50000, uses: 0, max: 1 };
  r = await call("/api/seller/withdraw", { email: "a@x.com", headers: { "x-wallet-auth": "T1" }, body: { amount: 60000 } }); assert.strictEqual(r.status, 428, "different amount refused");
  r = await call("/api/seller/withdraw", { email: "b@x.com", headers: { "x-wallet-auth": "T1" }, body: { amount: 50000 } }); assert.strictEqual(r.status, 428, "another person's token refused");
  r = await call("/api/seller/withdraw", { email: "a@x.com", headers: { "x-wallet-auth": "T1" }, body: { amount: 50000 } }); assert.ok(r.next, "right person, right amount: passes");
  r = await call("/api/seller/withdraw", { email: "a@x.com", headers: { "x-wallet-auth": "T1" }, body: { amount: 50000 } }); assert.strictEqual(r.status, 428, "second use refused");
  // a withdrawal that then fails (low balance) gives the token back
  toks[sha("T2")] = { email: "a@x.com", action: "withdraw", amount: 9000, uses: 0, max: 1 };
  r = await call("/api/seller/withdraw", { email: "a@x.com", headers: { "x-wallet-auth": "T2" }, body: { amount: 9000 } }); r.res.json({ success: false, message: "You only have ₦0 available" });
  assert.strictEqual(toks[sha("T2")].uses, 0);
  // a gift token works many times (a short session) but only for gifts
  toks[sha("G")] = { email: "a@x.com", action: "gift", amount: 0, uses: 0, max: 300 };
  assert.ok((await call("/api/gifts/send", { email: "a@x.com", headers: { "x-wallet-auth": "G" }, body: {} })).next); assert.ok((await call("/api/gifts/send", { email: "a@x.com", headers: { "x-wallet-auth": "G" }, body: {} })).next);
  assert.strictEqual((await call("/api/seller/withdraw", { email: "a@x.com", headers: { "x-wallet-auth": "G" }, body: { amount: 5 } })).status, 428, "gift token cannot withdraw");
  // emergency switch
  process.env.WALLET_SECURITY = "off"; assert.ok((await call("/api/seller/withdraw", { email: "a@x.com", body: { amount: 1 } })).next); process.env.WALLET_SECURITY = "on";
  console.log("ok  Wallet security: PIN rules, growing lock, limits, OTP triggers, guard (single-use withdrawal token bound to person and amount, gift session, token returned on failure)");
})().catch((e) => { console.error(e); process.exit(1); });
