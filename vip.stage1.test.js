// Stage 1 checks for vip.js — runs with plain `node tests/vip.stage1.test.js` (no database needed:
// a tiny fake db answers the exact queries vip.js makes, so the RULES are tested, not PostgreSQL).
const assert = require("assert");
const routes = {};
const app = { get: (p, ...h) => (routes["GET " + p] = h), post: (p, ...h) => (routes["POST " + p] = h) };

const S = { enabled: "1", max: "3", elig: null, followers: 0, ms: 0, pos: 0, circ: 0, reports: 0, banned: 0, equipped: null, unlocks: [], saved: null };
const badges = [
  { id: "badge-silver", tier: "silver", minFollowers: 100, minLiveHours: 1, minStars: 6000, autoUnlock: 1, active: 1 },
  { id: "badge-gold", tier: "gold", minFollowers: 1000, minLiveHours: 5, minStars: 6000, autoUnlock: 1, active: 1 },
  { id: "badge-royal", tier: "royal", minFollowers: 10000, minLiveHours: 50, minStars: 0, autoUnlock: 0, active: 1 }
];
const frames = [
  { id: "frame-silver", tierRequired: "silver", style: "silver-shine", animated: 1, adminOnly: 0, active: 1 },
  { id: "frame-royal", tierRequired: "royal", style: "royal-flame", animated: 1, adminOnly: 0, active: 1 },
  { id: "frame-gift", tierRequired: "legend", style: "x", animated: 1, adminOnly: 1, active: 1 }
];
const db = {
  async get(sql, p) {
    if (/FROM vip_settings/.test(sql)) return { value: p[0] === "enabled" ? S.enabled : S.max };
    if (/FROM vip_eligibility WHERE user_id/.test(sql)) return S.elig;
    if (/COUNT\(\*\) AS c FROM follows/.test(sql)) return { c: S.followers };
    if (/FROM live_sessions/.test(sql)) return { ms: S.ms };
    if (/FROM reports/.test(sql)) return { c: S.reports };
    if (/FROM user_flags/.test(sql)) return { banned: S.banned };
    if (/SUM\(CASE WHEN r.amt/.test(sql)) return { v: S.circ };
    if (/FROM gift_transactions/.test(sql)) return { v: S.pos };
    if (/FROM vip_frames WHERE id/.test(sql)) return frames.find((f) => f.id === p[0]) || null;
    if (/FROM users WHERE/.test(sql)) return { email: "u@x.com" };
    return null;
  },
  async all(sql) {
    if (/FROM vip_badges/.test(sql)) return /auto_unlock = 1/.test(sql) ? badges.filter((b) => b.autoUnlock) : badges;
    if (/FROM vip_unlocks/.test(sql)) return S.unlocks;
    return [];
  },
  async run(sql, p) { if (/INSERT INTO vip_equipped/.test(sql)) S.saved = p; return { changes: 1 }; }
};
const requireAuth = (req, res, next) => { req.userEmail = "u@x.com"; next(); };
const requireAdmin = (req, res, next) => (req.headers["x-admin-key"] === "k" ? next() : res.status(403).json({ success: false }));
const vip = require("../vip")({ app, db, requireAuth, requireAdmin, store: { COINS_PER_STAR: 2 } });

function call(key, req) {
  return new Promise(async (resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, set() { return this; } };
    req.headers = req.headers || {}; req.body = req.body || {}; req.query = req.query || {};
    const hs = routes[key]; let i = 0;
    const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); };
    await next();
  });
}
const H = 3600000;
(async () => {
  // 1. values an admin types cannot smuggle markup/CSS
  const c = vip._test.cleanDecorValue;
  assert.strictEqual(c("name_color", "#ffc83d"), "#ffc83d");
  assert.strictEqual(c("name_color", "red;background:url(x)"), null);
  assert.strictEqual(c("name_color", "gradient:#fff,#000"), "gradient:#fff,#000");
  assert.strictEqual(c("title", "<img onerror=x>"), null);
  assert.strictEqual(c("crown", "👑"), "👑");
  assert.strictEqual(c("background", "url:https://x.com/a.png"), "url:https://x.com/a.png");
  assert.strictEqual(c("background", "url:javascript:alert(1)"), null);
  console.log("ok  admin-typed values are validated");

  // 2. eligibility from real records
  vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                         // ordinary user
  S.followers = 150; S.ms = 2 * H; S.pos = 12000; vip.dropCache(); vip._test.clearStars();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "silver");                       // earned silver
  S.followers = 150; S.ms = 0.5 * H; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                         // not enough live hours
  S.followers = 20000; S.ms = 500 * H; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "gold");
  S.pos = 11998; vip._test.clearStars(); vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                       // 5999 stars is not enough
  S.pos = 14000; S.circ = 4000; vip._test.clearStars(); vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                       // gifts sent round in a circle do not count
  S.circ = 0; S.pos = 12000; vip._test.clearStars(); vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "gold");                        // exactly 6000 stars                         // royal is admin-approved only, never automatic
  S.reports = 3; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                         // community standing blocks auto-VIP
  S.reports = 0; S.banned = 1; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                         // blocked accounts never VIP
  S.banned = 0; S.followers = 0; S.ms = 0; S.elig = { tier: "royal", status: "approved", verified: 0, expiresAt: null }; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "royal");                        // admin grant
  S.elig = { tier: "royal", status: "approved", verified: 0, expiresAt: Date.now() - 1000 }; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                         // expired grant
  S.followers = 20000; S.ms = 500 * H; S.elig = { tier: "none", status: "revoked", verified: 0, expiresAt: null }; vip.dropCache();
  assert.strictEqual((await vip.tierOf("u@x.com")).tier, "none");                         // revoke also blocks the automatic route
  console.log("ok  eligibility: earned / admin / expired / revoked / reports / banned");

  // 3. equip is decided on the server
  S.followers = 0; S.ms = 0; S.elig = { tier: "silver", status: "approved", verified: 0, expiresAt: null }; vip.dropCache();
  let r = await call("POST /api/vip/equip", { body: { slot: "frame", id: "frame-silver" } });
  assert.strictEqual(r.code, 200); assert.strictEqual(S.saved[1], "frame-silver");
  S.saved = null;
  r = await call("POST /api/vip/equip", { body: { slot: "frame", id: "frame-royal" } });
  assert.strictEqual(r.code, 403); assert.strictEqual(S.saved, null);                    // silver cannot take a royal frame
  r = await call("POST /api/vip/equip", { body: { slot: "frame", id: "frame-gift" } });
  assert.strictEqual(r.code, 403);                                                       // admin-only item
  r = await call("POST /api/vip/equip", { body: { slot: "coins", id: "x" } });
  assert.strictEqual(r.code, 400);                                                       // unknown slot
  S.unlocks = [{ t: "frame", i: "frame-gift" }];
  r = await call("POST /api/vip/equip", { body: { slot: "frame", id: "frame-gift" } });
  assert.strictEqual(r.code, 200);                                                       // admin unlocked it for this person
  S.unlocks = []; S.elig = null; vip.dropCache();
  r = await call("POST /api/vip/equip", { body: { slot: "frame", id: "frame-silver" } });
  assert.strictEqual(r.code, 403);                                                       // ordinary user cannot self-grant
  S.enabled = "0"; await new Promise((x) => setTimeout(x, 5100)); S.elig = { tier: "gold", status: "approved", verified: 0, expiresAt: null }; vip.dropCache();
  r = await call("POST /api/vip/equip", { body: { slot: "frame", id: "frame-silver" } });
  assert.strictEqual(r.code, 200);                                                       // the old global setting is ignored; only the person's approval matters
  console.log("ok  equip: tier checks, admin-only items, unlocks, self-grant blocked, no global switch");

  // 4. admin routes refuse everyone without the key
  for (const k of ["POST /api/admin/vip/grant", "POST /api/admin/vip/revoke", "POST /api/admin/vip/settings", "GET /api/admin/vip/users", "POST /api/admin/vip/items/:type", "POST /api/admin/vip/unlock"]) {
    assert.ok(routes[k], "missing route " + k);
    r = await call(k, { body: { user: "u@x.com", tier: "legend" } });
    assert.strictEqual(r.code, 403, k + " must need the admin key");
  }
  console.log("ok  all admin routes require the admin key");

  // 5. public endpoint never returns emails and returns nothing for ordinary users
  S.enabled = "1"; await new Promise((x) => setTimeout(x, 5100)); S.elig = null; S.followers = 0; vip.dropCache();
  r = await call("GET /api/vip/public", { query: { ids: "someone" } });
  assert.deepStrictEqual(r.body.users, {});
  console.log("ok  public lookup shows nothing for ordinary users");
  console.log("\nALL STAGE 1 CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
