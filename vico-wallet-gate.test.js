// Wallet page gate (PIN + email code) — `node tests/vico-wallet-gate.test.js`
// The real Express routes and the real wallet module on Node's built-in SQLite (no network, no PostgreSQL).
process.removeAllListeners("warning");
process.env.WALLET_SECURITY = "on"; delete process.env.RESEND_API_KEY; delete process.env.NODE_ENV;
const assert = require("assert");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const makeWallet = require("../vico-wallet");

(async () => {
  const sq = new DatabaseSync(":memory:");
  const tr = (s) => s.replace(/BIGSERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT").replace(/\bBIGINT\b/g, "INTEGER").replace(/\bSMALLINT\b/g, "INTEGER").replace(/ADD COLUMN IF NOT EXISTS/g, "ADD COLUMN");
  const exec = (sql, p) => { const st = sq.prepare(tr(sql)); p = (p || []).map((v) => (v === undefined ? null : v)); return /^\s*SELECT/i.test(sql) || /\bRETURNING\b/i.test(sql) ? { rows: st.all(...p).map((r) => ({ ...r })) } : { rows: [], changes: Number(st.run(...p).changes) }; };
  const api = { all: async (s, p) => exec(s, p).rows, get: async (s, p) => exec(s, p).rows[0], run: async (s, p) => { const r = exec(s, p); return { changes: r.changes === undefined ? r.rows.length : r.changes, rows: r.rows }; } };
  const db = { ...api, tx: async (fn) => { sq.exec("BEGIN"); try { const r = await fn({ ...api, lock: async () => {} }); sq.exec("COMMIT"); return r; } catch (e) { sq.exec("ROLLBACK"); throw e; } },
    pool: { connect: async () => ({ query: async (s) => { if (/pg_advisory/.test(s)) return; try { sq.exec(tr(s)); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }, release() {} }) } };
  // the Ad Center tables the business list reads
  for (const s of [
    `CREATE TABLE ad_job_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, tier TEXT, status TEXT)`,
    `CREATE TABLE ad_job_profiles (order_id INTEGER PRIMARY KEY, business_name TEXT, description TEXT, phone TEXT, whatsapp TEXT, city TEXT, country TEXT, complete INTEGER)`,
    `CREATE TABLE ad_job_identity (order_id INTEGER PRIMARY KEY, status TEXT)`,
    `CREATE TABLE company_verification_applications (order_id INTEGER, status TEXT)`]) sq.exec(s);

  const accounts = new Map();
  const add = (email, username, displayName) => accounts.set(email, { email, username, displayName: displayName || username, handle: username });
  const acct = (e) => accounts.get(String(e).toLowerCase());
  const store = { users: {
      resolveHandle: async (h) => { h = String(h).toLowerCase(); const a = [...accounts.values()].find((x) => x.email === h || x.handle === h); return a ? a.email : null; },
      warm: async () => {}, exists: async (e) => accounts.has(e),
      search: async (q) => [...accounts.values()].filter((a) => a.username.includes(String(q).toLowerCase()) || a.displayName.toLowerCase().includes(String(q).toLowerCase())),
      setDisplayName: async (e, n) => { acct(e).displayName = n; } },
    publicHandle: (e) => (acct(e) || { handle: "u" + e }).handle, displayNameOf: (e) => (acct(e) || { displayName: "User" }).displayName, avatarUrl: () => null };
  ["alice@x.com:alice:Alice A", "bob@x.com:bob:Bob B", "carol@x.com:carol:Carol C", "shop@x.com:shopowner:Mama Put", "vip@x.com:vipstar:VIP Star"].forEach((r) => { const [e, u, d] = r.split(":"); add(e, u, d); });
  const requireAuth = (req, res, next) => { const e = req.headers["x-test-user"]; if (!e || !accounts.has(e)) return res.status(401).json({ success: false, message: "Please sign in to continue." }); req.userEmail = e; next(); };
  let vipGate = false;
  const env = { NODE_ENV: "test", VM_DEV_ECHO_CODE: "1", LIVEKIT_URL: "wss://vico.livekit.example", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "s".repeat(40) };
  const app = express(); app.use(express.json());

  // the REAL wallet-security module on this database: its tables are created through a pool that runs on the same SQLite
  db.pool = { connect: async () => ({ query: async (q) => { if (!/pg_advisory/.test(q)) sq.exec(tr(q)); return {}; }, release() {} }) };
  const makeSec = require("../wallet-security");
  const sec = makeSec({ app, db, requireAuth, getAuthEmail: (req) => String(req.headers["x-test-user"] || "") });
  await sec.ready;
  const walletApp = app;
  const axios = { post: async () => ({ data: { status: true, data: { authorization_url: "https://pay/x", reference: "r1" } } }), get: async () => ({ data: { status: true, data: {} } }) };
  const wenv = { PAYSTACK_SECRET_KEY: "sk" };
  const wallet = makeWallet({ app: walletApp, db, requireAuth, axios, siteUrlOf: () => "http://site", env: wenv, walletSecurity: sec });
  await wallet.ready;
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (as, method, path, body, hdr) => { const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(as ? { "x-test-user": as + "@x.com" } : {}), ...(hdr || {}) }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json().catch(() => ({})); d.status = r.status; return d; };
  const GET = (as, p, h) => call(as, "GET", p, null, h), POST = (as, p, b, h) => call(as, "POST", p, b || {}, h);
  // the code the (dev) email would carry
  let lastMail = ""; const log = console.log; console.log = (...a) => { const t = a.join(" "); if (/WALLET EMAIL/.test(t)) lastMail = t; else if (!/VICO MESSAGE CODE/.test(t)) log(...a); };
  const codeFromMail = () => { const m = /code is (\d{6})/.exec(lastMail); assert.ok(m, "no code in mail: " + lastMail); return m[1]; };

  // 1) no PIN yet: every wallet door is shut and says a PIN is needed
  let r = await GET("alice", "/api/wallet/history"); assert.strictEqual(r.status, 428); assert.ok(r.walletAuthRequired && r.action === "wallet" && r.hasPin === false, JSON.stringify(r));
  r = await POST("alice", "/api/wallet/recharge/initialize", { amount: 500 }); assert.strictEqual(r.status, 428);
  // what stays open on purpose: the balance number (chat header) and the Paystack return check
  r = await GET("alice", "/api/wallet/balance"); assert.ok(r.success);
  r = await POST("alice", "/api/wallet/recharge/verify", { reference: "zzz" }); assert.notStrictEqual(r.status, 428);
  assert.strictEqual((await GET(null, "/api/wallet/history")).status, 401);   // not signed in: the sign-in check answers, as before

  // 2) create the PIN (the email code is needed for that)
  assert.ok((await POST("alice", "/api/wallet-security/otp/send", { purpose: "set_pin" })).success);
  r = await POST("alice", "/api/wallet-security/pin/set", { otp: codeFromMail(), pin: "2580", confirm: "2580" }); assert.ok(r.success, JSON.stringify(r));

  // 3) PIN alone does NOT open the wallet: the email code comes next, and the wrong PIN is refused
  r = await POST("alice", "/api/wallet-security/authorize", { action: "wallet", pin: "1111" }); assert.strictEqual(r.status, 403); assert.ok(r.wrongPin);
  r = await POST("alice", "/api/wallet-security/authorize", { action: "wallet", pin: "2580" });
  assert.ok(r.otpRequired && r.reason === "wallet" && !r.token, JSON.stringify(r));
  const wrongCode = codeFromMail() === "000000" ? "111111" : "000000";
  r = await POST("alice", "/api/wallet-security/authorize", { action: "wallet", pin: "2580", otp: wrongCode }); assert.strictEqual(r.status, 400); assert.ok(!r.token);
  assert.strictEqual((await GET("alice", "/api/wallet/history")).status, 428);   // still shut after the failed tries
  r = await POST("alice", "/api/wallet-security/authorize", { action: "wallet", pin: "2580", otp: codeFromMail() });
  assert.ok(r.success && r.token && r.expiresInSeconds === 600, JSON.stringify(r));
  const T = { "x-wallet-auth": r.token };

  // 4) with the proof the wallet opens, and it stays open for its 10 minutes (more than one request)
  r = await GET("alice", "/api/wallet/history", T); assert.ok(r.success, JSON.stringify(r));
  r = await GET("alice", "/api/wallet/history", T); assert.ok(r.success);
  r = await POST("alice", "/api/wallet/recharge/initialize", { amount: 500 }, T); assert.ok(r.success && r.authorization_url, JSON.stringify(r));
  // 5) the proof is for this person, for the wallet only, and it runs out
  await POST("bob", "/api/wallet-security/otp/send", { purpose: "set_pin" });
  assert.strictEqual((await GET("bob", "/api/wallet/history", T)).status, 428);                                  // someone else's proof
  const mine = await POST("alice", "/api/wallet-security/authorize", { action: "gift", pin: "2580" });           // a gift proof is not a wallet proof
  if (mine.success) assert.strictEqual((await GET("alice", "/api/wallet/history", { "x-wallet-auth": mine.token })).status, 428);
  assert.strictEqual((await GET("alice", "/api/wallet/history", { "x-wallet-auth": "not-a-real-token" })).status, 428);
  await db.run("UPDATE wallet_auth SET expires_at = ? WHERE email = ? AND action = 'wallet'", [Date.now() - 1000, "alice@x.com"]);
  assert.strictEqual((await GET("alice", "/api/wallet/history", T)).status, 428);                                // expired

  // 6) too many wrong PINs locks the wallet
  for (let i = 0; i < 5; i++) r = await POST("alice", "/api/wallet-security/authorize", { action: "wallet", pin: "9999" });
  assert.strictEqual(r.status, 423); assert.ok(r.locked);
  r = await POST("alice", "/api/wallet-security/authorize", { action: "wallet", pin: "2580" }); assert.strictEqual(r.status, 423);

  // 7) the emergency switch
  process.env.WALLET_SECURITY = "off"; assert.ok((await GET("alice", "/api/wallet/history")).success); process.env.WALLET_SECURITY = "on";

  console.log = log; server.close();
  console.log("vico wallet gate tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
