// Live promotion rules: `node tests/promo.test.js` (no network, no database)
const assert = require("assert");
const promo = require("../vico-promo");
const c = { minFollowers: 1000, minLikes: 1000000, minStars: 12000, minViews: 0 };
const full = { followers: 1000, likes: 1000000, stars: 12000, views: 0 };
assert.strictEqual(promo.meetsGoals(full, c), true);
for (const k of ["followers", "likes", "stars"]) assert.strictEqual(promo.meetsGoals({ ...full, [k]: full[k] - 1 }, c), false, k);   // every goal is needed
assert.strictEqual(promo.meetsGoals({ ...full, views: 5 }, { ...c, minViews: 100 }), false);
assert.strictEqual(promo.meetsGoals({ ...full, views: 100 }, { ...c, minViews: 100 }), true);
// price in the smallest unit: $12 = 1200, N19,000 = 1900000
delete process.env.PROMO_PRICE_USD; delete process.env.PROMO_PRICE_NGN;
assert.strictEqual(promo.minorFor(promo.cfg(), "USD"), 1200); assert.strictEqual(promo.minorFor(promo.cfg(), "NGN"), 1900000);
process.env.PROMO_PRICE_USD = "15"; assert.strictEqual(promo.minorFor(promo.cfg(), "USD"), 1500); delete process.env.PROMO_PRICE_USD;
assert.strictEqual(promo.cfg().months, 2);
assert.strictEqual(promo.cfg().days, 60);
const jan31 = new Date("2026-01-31T12:00:00.000Z").getTime();
assert.strictEqual(new Date(promo.addMonths(jan31, 2)).toISOString(), "2026-03-31T12:00:00.000Z");
const dec31 = new Date("2026-12-31T12:00:00.000Z").getTime();
assert.strictEqual(new Date(promo.addMonths(dec31, 2)).toISOString(), "2027-02-28T12:00:00.000Z");
// the story a streamer writes: plain text, short, no control characters
assert.strictEqual(promo.cleanStory("  Hi\u0000 there  "), "Hi there");
assert.strictEqual(promo.cleanStory("a\n\n\n\nb"), "a\n\nb");
assert.strictEqual(promo.cleanStory("x".repeat(900)).length, 500);
assert.strictEqual(promo.cleanStory(null), "");
console.log("promo tests passed");
