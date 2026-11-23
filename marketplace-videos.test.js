// Marketplace product pages, $2 / 2-month keep fee, ad product step, Vico Videos rules — `node tests/marketplace-videos.test.js` (no network, no database)
const assert = require("assert");
const market = require("../vico-market"), ads = require("../vico-ads"), videos = require("../vico-videos");
const DAY = 86400000;

// ---- phone / WhatsApp numbers ----
assert.strictEqual(market.waNumber("0803 123 4567"), "2348031234567"); assert.strictEqual(market.waNumber("+234 803 123 4567"), "2348031234567"); assert.strictEqual(market.waNumber("2348031234567"), "2348031234567");
// ---- discount, badges (only from real data) ----
assert.strictEqual(market.discountPct(12500, 25000), 50); assert.strictEqual(market.discountPct(100, 100), 0); assert.strictEqual(market.discountPct(100, 0), 0);
const now = Date.now(), base = { discount: 0, sales: 0, rcount: 0, ravg: 0, createdAt: now - 40 * DAY };
assert.strictEqual(market.badgeOf({ ...base, discount: 50 }, now), "Hot Deal"); assert.strictEqual(market.badgeOf({ ...base, sales: 5 }, now), "Best Seller");
assert.strictEqual(market.badgeOf({ ...base, rcount: 3, ravg: 4.6 }, now), "Top Rated"); assert.strictEqual(market.badgeOf({ ...base, rcount: 2, ravg: 5 }, now), "");
assert.strictEqual(market.badgeOf({ ...base, createdAt: now - DAY }, now), "New Arrival"); assert.strictEqual(market.badgeOf(base, now), "");
// ---- "other types of the same product" ----
const list = [{ id: 1, title: "Wireless Bluetooth Earbuds", category: "Electronics" }, { id: 2, title: "Bluetooth Speaker", category: "Electronics" }, { id: 3, title: "Wireless Earbuds Pro", category: "Electronics" }, { id: 4, title: "Wireless Earbuds", category: "Fashion" }, { id: 5, title: "Laptop", category: "Electronics" }];
assert.deepStrictEqual(market.rankSimilar(list[0], list, 12).map((x) => x.id), [3, 2, 5]);   // most shared words first, same category only, never itself
// ---- listing rules: old price, direct deals need a number ----
const ok = { title: "Earbuds", price: 12500, category: "Electronics" };
assert.ok(market.cleanListing({ ...ok, oldPrice: 25000 }).value.oldPrice === 25000); assert.ok(market.cleanListing({ ...ok, oldPrice: 100 }).error);
assert.ok(market.cleanListing({ ...ok, saleMode: "direct", contactMode: "whatsapp", contactNumber: "08031234567" }).value); assert.ok(market.cleanListing({ ...ok, saleMode: "direct" }).error);
assert.ok(market.cleanListing({ ...ok, category: "Books" }).value);
// ---- $2 every 2 months, paid once for the ad ----
assert.strictEqual(ads.KEEP_USD, 2); assert.strictEqual(market.KEEP_DAYS, 60); assert.strictEqual(ads.keepFeeNgn(1500, 2), 3000); assert.strictEqual(ads.keepFeeNgn(1620.4, 2), 3241);
assert.strictEqual(ads.extendKeep(0, now, 60), now + 60 * DAY);                                  // expired: 60 days from today
assert.strictEqual(ads.extendKeep(now + 10 * DAY, now, 60), now + 70 * DAY);                    // renewing early keeps the paid days
// ---- ad step 5: product details ----
const camp = { name: "Shoes", headline: "Fresh sneakers", body: "Size 42 to 45, brand new", image: "" };
assert.ok(ads.cleanProduct({ productCategory: "Fashion", price: 35000, saleMode: "vico", delivery: "address" }, camp).value);
assert.ok(ads.cleanProduct({ productCategory: "Fashion", price: 35000, saleMode: "direct", contactMode: "whatsapp", contactNumber: "08031234567" }, camp).value.contactNumber);
for (const b of [{ productCategory: "Fashion", price: 0, saleMode: "vico", delivery: "address" }, { productCategory: "Fashion", price: 35000, saleMode: "vico" }, { productCategory: "Fashion", price: 35000, saleMode: "direct", contactNumber: "1" }, { productCategory: "Nope", price: 5, saleMode: "vico", delivery: "address" }]) assert.ok(ads.cleanProduct(b, camp).error);
assert.ok(ads.PLACEMENTS.short_videos && ads.PLACEMENTS.marketplace);
// ---- videos ----
assert.ok(videos.cleanMeta({ title: "Shop smart", durationSec: 45, category: "Shopping" }).value); assert.ok(videos.cleanMeta({ title: "ab", durationSec: 45 }).error); assert.ok(videos.cleanMeta({ title: "Long one", durationSec: 120 }).error);
assert.ok(videos.cleanMeta({ title: "Counterfeit bags", durationSec: 20 }).error); assert.ok(videos.cleanMeta({ title: "Nice", durationSec: 20, thumb: "data:text/html;base64,AAAA" }).error);
assert.deepStrictEqual(videos.hashtagsOf("Shop #VicoPay #GreatDeals #VicoPay"), ["VicoPay", "GreatDeals"]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)]), webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
assert.strictEqual(videos.sniffVideo(mp4), "video/mp4"); assert.strictEqual(videos.sniffVideo(webm), "video/webm"); assert.strictEqual(videos.sniffVideo(Buffer.from("<html>not a video at all</html>")), "");
assert.deepStrictEqual(videos.parseRange("bytes=0-99", 1000), { start: 0, end: 99 }); assert.deepStrictEqual(videos.parseRange("bytes=500-", 1000), { start: 500, end: 999 }); assert.deepStrictEqual(videos.parseRange("bytes=-100", 1000), { start: 900, end: 999 });
assert.strictEqual(videos.parseRange("bytes=0-", 5 * 1024 * 1024).end, 1024 * 1024 - 1); assert.ok(videos.parseRange("bytes=900-100", 1000).bad); assert.strictEqual(videos.parseRange("", 1000), null);
console.log("ok  Marketplace + Videos: badges, discounts, similar products, phone/WhatsApp links, $2 per 2 months keep fee, ad product step, video upload and Range rules");
