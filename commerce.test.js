// Commerce + Ad Center flow — `node tests/commerce.test.js` (no network, no database)
const assert = require("assert");
const C = require("../vico-commerce"), ads = require("../vico-ads");

// ---- Paystack amount check: only a real Naira payment that covers the price ----
assert.strictEqual(C.amountOk(3500000, 35000, "NGN"), true); assert.strictEqual(C.amountOk(3499999, 35000, "NGN"), false);
assert.strictEqual(C.amountOk(3500000, 35000, "USD"), false); assert.strictEqual(C.amountOk(5000, 0, "NGN"), false);
assert.deepStrictEqual(C.splitSale(10000, 5), { gross: 10000, commission: 500, net: 9500 }); assert.deepStrictEqual(C.splitSale(10000, 0), { gross: 10000, commission: 0, net: 10000 });
// ---- seller wallet: pending vs available vs withdrawn ----
const t = C.walletTotals([{ net: 9500, status: "pending" }, { net: 20000, status: "available" }, { net: 5000, status: "reversed" }], [{ amount: 8000, status: "paid" }, { amount: 2000, status: "requested" }, { amount: 999, status: "rejected" }]);
assert.deepStrictEqual(t, { pending: 9500, available: 10000, withdrawn: 8000, requested: 2000, lifetime: 29500 });
assert.ok(C.cleanOrder({ method: "address", phone: "08012345678", address: "12 Market Road, Maiduguri" }).value); assert.ok(C.cleanOrder({ method: "contact", phone: "08012345678" }).value);
for (const b of [{ method: "x", phone: "08012345678" }, { method: "address", phone: "08012345678", address: "short" }, { method: "contact", phone: "abc" }]) assert.ok(C.cleanOrder(b).error);
assert.ok(C.cleanBank({ bankName: "GTBank", accountNumber: "0123456789", accountName: "Ada Obi" }).value); assert.ok(C.cleanBank({ bankName: "GTBank", accountNumber: "123", accountName: "Ada Obi" }).error);
console.log("ok  Commerce rules: Paystack amount check, sale split, seller wallet totals, order and bank details");

// ---- Ad Center: contact details, ID encryption, which step is next ----
assert.ok(ads.cleanContact({ phone: "08012345678", cState: "Borno", cCity: "Maiduguri", age: 30, marketAddress: "Monday Market, Stall 5" }).value);
for (const b of [{ phone: "1", cState: "Borno", cCity: "M", age: 30, marketAddress: "Monday Market, Stall 5" }, { phone: "08012345678", cState: "Borno", cCity: "Maiduguri", age: 17, marketAddress: "Monday Market, Stall 5" }, { phone: "08012345678", cState: "Borno", cCity: "Maiduguri", age: 30, marketAddress: "x" }]) assert.ok(ads.cleanContact(b).error);
const key = require("crypto").randomBytes(32), img = "data:image/png;base64,iVBORw0KGgo=";
const enc = ads.encryptDoc(key, img); assert.ok(!enc.enc.includes("iVBOR")); assert.strictEqual(ads.decryptDoc(key, enc), img);
assert.throws(() => ads.decryptDoc(require("crypto").randomBytes(32), enc));                       // the wrong key cannot read it
const F = (paid, placementsDone) => ({ paid, placementsDone });
assert.strictEqual(ads.flowStage({ status: "draft" }, F(0, 0), "none"), "payment");
assert.strictEqual(ads.flowStage({ status: "paid" }, F(1, 0), "none"), "identity");
assert.strictEqual(ads.flowStage({ status: "paid" }, F(1, 0), "pending"), "identity");
assert.strictEqual(ads.flowStage({ status: "paid" }, F(1, 0), "approved"), "placements");
assert.strictEqual(ads.flowStage({ status: "paid" }, F(1, 1), "approved"), "submit");
assert.strictEqual(ads.flowStage({ status: "under_review" }, F(1, 1), "approved"), "review");
assert.strictEqual(ads.flowStage({ status: "active" }, F(1, 1), "approved"), "live");
console.log("ok  Ad flow: details checked, ID photo encrypted (wrong key fails), next step follows pay -> ID -> placements -> review -> live");

// ---- a payment is finalised ONCE, even if the return page and the webhook both arrive ----
(async () => {
  const pay = { reference: "VMK-1", purpose: "order", refId: 1, payer: "buyer@x.com", amount: 35000, status: "pending" };
  const orders = { 1: { id: 1, listingId: 7, seller: "seller@x.com", buyer: "buyer@x.com", title: "Shoes", amount: 35000, method: "address", status: "pending_payment" } };
  const listing = { 7: "active" }; const entries = []; const dm = []; let verifies = 0;
  const run = async (sql, p) => {
    if (/UPDATE commerce_payments SET status = 'paid'/.test(sql)) { if (pay.status !== "pending") return null; pay.status = "paid"; return { reference: pay.reference }; }
    if (/FROM market_orders WHERE id/.test(sql)) return orders[p[0]];
    if (/UPDATE market_listings SET status = 'sold'/.test(sql)) { if (listing[p[1]] !== "active") return null; listing[p[1]] = "sold"; return { id: p[1] }; }
    if (/UPDATE market_orders SET status = 'paid'/.test(sql)) { orders[p[1]].status = "paid"; return {}; }
    if (/INSERT INTO seller_wallet_entries/.test(sql)) { if (!entries.some((e) => e.orderId === p[1])) entries.push({ seller: p[0], orderId: p[1], net: p[4], status: "pending" }); return {}; }
    if (/FROM commerce_settings/.test(sql)) return [];
    if (/FROM commerce_payments WHERE reference/.test(sql)) return { ...pay };
    if (/INSERT INTO dm_threads/.test(sql)) return { id: 1 }; if (/INSERT INTO dm_messages/.test(sql)) { dm.push(p[2]); return {}; }
    return {};
  };
  const mk = (r) => ({ get: (sql, p) => r(sql, p), run: (sql, p) => r(sql, p), all: (sql, p) => r(sql, p) });
  const db = { pool: { connect: async () => ({ query: async () => ({}), release() {} }) }, ...mk(run), tx: async (fn) => fn(mk(run)) };
  db.all = async (sql, p) => (/commerce_settings/.test(sql) ? [] : []);
  process.env.PAYSTACK_SECRET_KEY = "sk_test_x";
  const axios = { get: async () => { verifies++; return { data: { data: { status: "success", amount: 3500000, currency: "NGN", reference: "VMK-1" } } }; }, post: async () => ({ data: {} }) };
  const store = { publicHandle: (e) => e, displayNameOf: (e) => e, users: { warm: async () => {} } };
  const app = { get() {}, post() {} };
  const com = C({ app, db, requireAuth() {}, requireAdmin() {}, store, axios });
  await new Promise((r) => setTimeout(r, 20));
  const [a, b] = await Promise.all([com.finalize("VMK-1"), com.finalize("VMK-1")]);                 // return page and webhook at the same moment
  assert.ok(a.ok && b.ok); assert.strictEqual(entries.length, 1);                                    // the seller is credited once
  assert.strictEqual(entries[0].net, 35000); assert.strictEqual(entries[0].status, "pending");       // held until delivery is confirmed
  assert.strictEqual(listing[7], "sold"); assert.strictEqual(orders[1].status, "paid");
  assert.ok(dm.length === 1 && /paid/.test(dm[0]));                                                  // the seller gets a message in Vico Messages
  const again = await com.finalize("VMK-1"); assert.ok(again.ok && again.already); assert.strictEqual(entries.length, 1);
  // a wrong amount is never accepted
  pay.status = "pending"; pay.reference = "VMK-2"; axios.get = async () => ({ data: { data: { status: "success", amount: 100, currency: "NGN" } } });
  const bad = await com.finalize("VMK-2"); assert.strictEqual(bad.ok, false);
  console.log("ok  Payments: finalised once even if two confirmations arrive together; seller credited as pending; seller messaged; wrong amount refused");
  console.log("\nALL COMMERCE CHECKS PASSED"); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
