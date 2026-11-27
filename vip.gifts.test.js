// VIP gift checks — `node tests/vip.gifts.test.js` (fake db; tests the RULES, not PostgreSQL)
const assert = require("assert");
const routes = {};
const app = { get: (p, ...h) => (routes["GET " + p] = h), post: (p, ...h) => (routes["POST " + p] = h) };
const S = { enabled: "1", saved: null, rows: [
  { name: "Golden Rose", coins: 250, active: 1 }, { name: "Golden Galaxy", coins: 0, active: 0 }, { name: "Royal Dragon", coins: 5000, active: 0 }] };
const giftPrices = { Rose: 100, Lion: 15000 };           // normal gifts that must never be touched
const db = {
  async get(sql, p) {
    if (/FROM vip_settings/.test(sql)) return { value: p[0] === "enabled" ? S.enabled : "3" };
    if (/FROM vip_gifts WHERE id/.test(sql)) return S.rows.find((r) => "vg-" + r.name.toLowerCase().replace(/ /g, "-") === p[0]) || null;
    return null;
  },
  async all(sql) { if (/FROM vip_gifts/.test(sql) && /price_coins AS coins/.test(sql)) return S.rows; if (/FROM vip_gifts/.test(sql)) return S.rows.map((r) => ({ id: "vg-x", name: r.name, videoSlug: "vip-x", priceNgn: 0, priceCoins: r.coins, sort: 1, active: r.active })); return []; },
  async run(sql, p) { if (/INSERT INTO vip_gifts/.test(sql)) S.saved = p; return { changes: 1 }; }
};
const requireAdmin = (req, res, next) => (req.headers["x-admin-key"] === "k" ? next() : res.status(403).json({ success: false }));
const vip = require("../vip")({ app, db, requireAuth: (q, r, n) => n(), requireAdmin, store: { COINS_PER_STAR: 2 }, giftPrices });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function call(key, req) {
  return new Promise(async (resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, set() { return this; } };
    req.headers = req.headers || {}; req.body = req.body || {}; req.query = req.query || {};
    const hs = routes[key]; let i = 0; const next = async () => { const h = hs[i++]; if (h) await h(req, res, next); }; await next();
  });
}
(async () => {
  await vip.syncGifts();
  assert.strictEqual(giftPrices["Golden Rose"], 250);                  // active + priced + VIP on -> sellable
  assert.strictEqual(giftPrices["Golden Galaxy"], undefined);          // no price -> not sellable
  assert.strictEqual(giftPrices["Royal Dragon"], undefined);           // switched off -> not sellable
  assert.strictEqual(giftPrices.Rose, 100); assert.strictEqual(giftPrices.Lion, 15000);   // normal gifts untouched
  console.log("ok  only active, priced VIP gifts are sellable; normal gifts untouched");

  S.enabled = "0"; await wait(5100); await vip.syncGifts();
  assert.strictEqual(giftPrices["Golden Rose"], 250);                  // the old global setting is ignored: VIP gifts stay on sale
  assert.strictEqual(giftPrices.Rose, 100);
  console.log("ok  old global VIP setting is ignored -> VIP gifts stay on sale");

  S.enabled = "1"; await wait(5100);
  let r = await call("GET /api/vip/gifts", {});
  assert.strictEqual(r.body.gifts.length, 3);                          // (fake returns rows; real SQL filters on active and price)
  r = await call("POST /api/admin/vip/gifts", { body: { id: "vg-new", name: "Rose", videoSlug: "vip-new", priceCoins: 50, active: true } });
  assert.strictEqual(r.code, 403);                                     // needs admin key
  r = await call("POST /api/admin/vip/gifts", { headers: { "x-admin-key": "k" }, body: { id: "vg-new", name: "Rose", videoSlug: "vip-new", priceCoins: 50, active: true } });
  assert.strictEqual(r.code, 400);                                     // cannot reuse a normal gift's name
  r = await call("POST /api/admin/vip/gifts", { headers: { "x-admin-key": "k" }, body: { id: "vg-new", name: "Pink Swan", videoSlug: "../../etc", priceCoins: 50, active: true } });
  assert.strictEqual(r.code, 400);                                     // video name is validated
  r = await call("POST /api/admin/vip/gifts", { headers: { "x-admin-key": "k" }, body: { id: "vg-new", name: "Pink Swan", videoSlug: "vip-pink-swan", priceCoins: -5, active: true } });
  assert.strictEqual(r.code, 400);                                     // no negative prices
  r = await call("POST /api/admin/vip/gifts", { headers: { "x-admin-key": "k" }, body: { id: "vg-pink-swan", name: "Pink Swan", videoSlug: "vip-pink-swan", priceNgn: 0, priceCoins: 0, active: true } });
  assert.strictEqual(r.body.active, false);                            // "on" without a price stays off
  r = await call("POST /api/admin/vip/gifts", { headers: { "x-admin-key": "k" }, body: { id: "vg-pink-swan", name: "Pink Swan", videoSlug: "vip-pink-swan", priceNgn: 1000, priceCoins: 100, active: true } });
  assert.strictEqual(r.body.active, true);
  console.log("ok  admin gift pricing: key required, name clash, bad video name, negative price, no-price stays off");
  console.log("\nALL GIFT CHECKS PASSED"); process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
