// VIP entrance checks — `node tests/vip.entrance.test.js` (fake db; tests the RULES)
const assert = require("assert");
const routes = {};
const app = { get: (p, ...h) => (routes["GET " + p] = h), post: (p, ...h) => (routes["POST " + p] = h) };
const S = { enabled: "1", elig: { tier: "silver", status: "approved", verified: 0, expiresAt: null }, saved: null,
  fx: [{ id: "fx-vip", minTier: "silver", videos: "vip-entrance-car,vip-entrance-crown", notice: "{name} joined the exclusive room" }] };
const db = {
  async get(sql, p) {
    if (/FROM vip_settings/.test(sql)) return { value: p[0] === "enabled" ? S.enabled : "3" };
    if (/FROM vip_eligibility WHERE user_id/.test(sql)) return S.elig;
    if (/COUNT\(\*\) AS c FROM follows/.test(sql)) return { c: 0 };
    if (/FROM live_sessions/.test(sql)) return { ms: 0 };
    if (/FROM reports/.test(sql)) return { c: 0 };
    if (/FROM user_flags/.test(sql)) return { banned: 0 };
    return null;
  },
  async all(sql) { if (/FROM vip_effects WHERE active/.test(sql)) return S.fx; return []; },
  async run(sql, p) { if (/INSERT INTO vip_effects/.test(sql)) S.saved = p; return { changes: 1 }; }
};
const requireAdmin = (req, res, next) => (req.headers["x-admin-key"] === "k" ? next() : res.status(403).json({ success: false }));
const vip = require("../vip")({ app, db, requireAuth: (q, r, n) => n(), requireAdmin, store: { COINS_PER_STAR: 2, displayNameOf: (e) => "Ada" }, giftPrices: {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function call(key, req) {
  return new Promise(async (resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, set() { return this; } };
    req.headers = req.headers || {}; req.body = req.body || {}; req.query = req.query || {};
    const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
  });
}
(async () => {
  const got = []; const push = (room, ev) => got.push({ room, ev });
  const room = { roomId: "r1", hostId: "host@x.com" };

  await vip.onViewerJoin(room, "ada@x.com", push);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].ev.type, "vip_join");
  assert.deepStrictEqual(got[0].ev.videos, ["gift-vip-entrance-car.mp4", "gift-vip-entrance-crown.mp4"]);   // car FIRST, crown second
  assert.strictEqual(got[0].ev.text, "Ada joined the exclusive room");
  console.log("ok  VIP join -> one event: car first, then crown, with the notice text");

  await vip.onViewerJoin(room, "ada@x.com", push);
  assert.strictEqual(got.length, 1);                                    // same person, same live, within 2 minutes: no replay
  await vip.onViewerJoin(room, "host@x.com", push);
  assert.strictEqual(got.length, 1);                                    // the host never gets an entrance
  console.log("ok  no replay inside 2 minutes; host excluded");

  S.elig = null; vip.dropCache();
  await vip.onViewerJoin(room, "plain@x.com", push);
  assert.strictEqual(got.length, 1);                                    // ordinary user: nothing
  console.log("ok  ordinary users get no entrance");

  S.elig = { tier: "royal", status: "approved", verified: 0, expiresAt: null }; vip.dropCache();
  S.fx = [{ id: "a", minTier: "silver", videos: "vip-a", notice: "{name} hi" }, { id: "b", minTier: "royal", videos: "vip-b", notice: "{name} royal" }, { id: "c", minTier: "legend", videos: "vip-c", notice: "{name} legend" }];
  await wait(15100);                                                    // effects are cached for 15s
  await vip.onViewerJoin(room, "bob@x.com", push);
  assert.strictEqual(got[1].ev.effect, "b");                            // highest entrance the person qualifies for
  console.log("ok  highest qualifying entrance is chosen");

  S.enabled = "0"; await wait(5100);                                    // the old global setting no longer matters
  const n = got.length;
  await vip.onViewerJoin({ roomId: "r2", hostId: "h@x.com" }, "cy@x.com", push);
  assert.strictEqual(got.length, n + 1);                                // still works: only a person's own approval / revoke decides
  S.enabled = "1"; await wait(5100);
  console.log("ok  old global VIP setting is ignored -> entrances keep working");

  // flood limit: 20 per minute per live
  const flood = { roomId: "r3", hostId: "h@x.com" }; let c = 0;
  for (let i = 0; i < 30; i++) { const before = got.length; await vip.onViewerJoin(flood, "u" + i + "@x.com", push); c += got.length - before; }
  assert.strictEqual(c, 20);
  console.log("ok  at most 20 entrances a minute per live");

  // admin validation
  const A = { headers: { "x-admin-key": "k" } };
  let r = await call("POST /api/admin/vip/effects", { body: { id: "x", name: "x", minTier: "silver", videos: "vip-a", notice: "{name} in" } });
  assert.strictEqual(r.code, 403);
  r = await call("POST /api/admin/vip/effects", { ...A, body: { id: "x", name: "x", minTier: "silver", videos: "../../etc/passwd", notice: "{name} in" } });
  assert.strictEqual(r.code, 400);
  r = await call("POST /api/admin/vip/effects", { ...A, body: { id: "x", name: "x", minTier: "silver", videos: "vip-a", notice: "no placeholder" } });
  assert.strictEqual(r.code, 400);
  r = await call("POST /api/admin/vip/effects", { ...A, body: { id: "x", name: "x", minTier: "silver", videos: "vip-a", notice: "<b>{name}</b>" } });
  assert.strictEqual(r.code, 400);
  r = await call("POST /api/admin/vip/effects", { ...A, body: { id: "x", name: "x", minTier: "none", videos: "vip-a", notice: "{name} in" } });
  assert.strictEqual(r.code, 400);
  r = await call("POST /api/admin/vip/effects", { ...A, body: { id: "x", name: "x", minTier: "gold", videos: "vip-entrance-car,vip-entrance-crown", notice: "{name} joined the exclusive room" } });
  assert.strictEqual(r.code, 200);
  console.log("ok  admin entrance rules: key required, video names, notice must hold {name} and no markup");
  console.log("\nALL ENTRANCE CHECKS PASSED"); process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
