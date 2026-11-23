// Market Community (Vico AI, Marketplace, Ad Center rules) — `node tests/market-community.test.js` (no network, no database)
const assert = require("assert");
const ai = require("../vico-ai"), market = require("../vico-market"), ads = require("../vico-ads");

// ---- Vico AI: provider requests keep the key on the server side and read both providers' answers ----
let rq = ai.providerRequest({ provider: "anthropic", model: "m", key: "K", system: "S", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
assert.ok(rq.url.startsWith("https://api.anthropic.com/") && rq.headers["x-api-key"] === "K" && rq.body.system === "S");
rq = ai.providerRequest({ provider: "openai", model: "m", key: "K", system: "S", messages: [{ role: "user", content: "hi" }], maxTokens: 100, baseUrl: "https://x.test/v1/" });
assert.strictEqual(rq.url, "https://x.test/v1/chat/completions"); assert.strictEqual(rq.body.messages[0].role, "system");
assert.deepStrictEqual(ai.readReply("anthropic", { content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 5, output_tokens: 7 } }), { text: "Hello", input: 5, output: 7 });
assert.deepStrictEqual(ai.readReply("openai", { choices: [{ message: { content: "Yo" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { text: "Yo", input: 2, output: 3 });
assert.deepStrictEqual(ai.cleanHistory([{ role: "assistant", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }, { role: "assistant", content: "d" }]), [{ role: "user", content: "b\nc" }, { role: "assistant", content: "d" }]);
assert.ok(/never make a payment/i.test(ai.SYSTEM_PROMPT));
console.log("ok  Vico AI: provider requests and answers for both providers; chat history is cleaned; the safety instruction is built in");

// ---- Vico AI chat route: no key, daily limit, other people's chats ----
(async () => {
  const routes = {}; const app = { get: (p, ...h) => (routes["GET " + p] = h), post: (p, ...h) => (routes["POST " + p] = h) };
  const convs = { 1: "other@x.com" }, usage = [], msgs = []; const sentTo = [];
  const db = { pool: { connect: async () => ({ query: async () => ({}), release() {} }) },
    async all(sql) { if (/FROM ai_messages/.test(sql)) return []; return []; },
    async get(sql, p) {
      if (/COUNT\(\*\) AS n FROM ai_usage/.test(sql)) return { n: usage.filter((u) => u === p[0]).length };
      if (/FROM ai_conversations WHERE id/.test(sql)) return convs[p[0]] === p[1] ? { id: p[0] } : null;
      if (/INSERT INTO ai_conversations/.test(sql)) { convs[2] = p[0]; return { id: 2 }; } return null; },
    async run(sql, p) { if (/INSERT INTO ai_usage/.test(sql)) usage.push(p[0]); if (/INSERT INTO ai_messages/.test(sql)) msgs.push(p[2]); return {}; } };
  const axios = { post: async (u, b, o) => { sentTo.push({ u, b, o }); return { data: { content: [{ type: "text", text: "Sure, let's write your ad." }], usage: { input_tokens: 10, output_tokens: 8 } } }; } };
  ai({ app, db, requireAuth: (q, r, n) => n(), requireAdmin: (q, r, n) => n(), axios });
  const call = (key, req) => new Promise(async (resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    req.body = req.body || {}; req.query = {}; req.params = req.params || {}; let i = 0; const next = async () => { const h = routes[key][i++]; if (h) await h(req, res, next); }; await next(); });
  await new Promise((r) => setTimeout(r, 20));
  delete process.env.AI_API_KEY;
  let r = await call("POST /api/ai/chat", { userEmail: "me@x.com", body: { message: "hello" } }); assert.strictEqual(r.code, 503);                 // no key yet
  process.env.AI_API_KEY = "secret-key"; process.env.AI_DAILY_LIMIT = "2";
  r = await call("POST /api/ai/chat", { userEmail: "me@x.com", body: { message: "x".repeat(2001) } }); assert.strictEqual(r.code, 400);
  r = await call("POST /api/ai/chat", { userEmail: "me@x.com", body: { conversationId: 1, message: "hi" } }); assert.strictEqual(r.code, 404);        // someone else's chat
  await new Promise((r2) => setTimeout(r2, 1600));                                                                                         // the 1.5 second pause between questions
  r = await call("POST /api/ai/chat", { userEmail: "me@x.com", body: { message: "I sell shoes" } });
  assert.ok(r.body.success && r.body.reply && r.body.conversationId === 2);
  assert.strictEqual(sentTo[0].o.headers["x-api-key"], "secret-key"); assert.ok(!JSON.stringify(r.body).includes("secret-key"));           // key goes to the provider, never back to the browser
  await new Promise((r2) => setTimeout(r2, 1600));
  r = await call("POST /api/ai/chat", { userEmail: "me@x.com", body: { conversationId: 2, message: "again" } }); assert.ok(r.body.success);
  await new Promise((r2) => setTimeout(r2, 1600));
  r = await call("POST /api/ai/chat", { userEmail: "me@x.com", body: { conversationId: 2, message: "third" } }); assert.strictEqual(r.code, 429);   // daily limit
  console.log("ok  Vico AI chat: refuses without a key, limits the day, blocks other people's chats, never returns the key");
  delete process.env.AI_API_KEY; delete process.env.AI_DAILY_LIMIT;

  // ---- Marketplace rules ----
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.ok(market.cleanListing({ title: "Nike shoes", description: "Size 42", price: 35000, category: "Fashion", image: png }).value);
  for (const b of [{ title: "x", price: 5, category: "Fashion" }, { title: "Shoes", price: 0, category: "Fashion" }, { title: "Shoes", price: 5, category: "Nope" },
    { title: "Counterfeit watch", price: 5, category: "Fashion" }, { title: "Shoes", price: 5, category: "Fashion", image: "data:text/html;base64,AAAA" }]) assert.ok(market.cleanListing(b).error);
  console.log("ok  Marketplace: bad names, prices, categories, prohibited items and non-image uploads are refused");

  // ---- Ad placements: choose where ads appear, launch in stages ----
  const AP = ads.PLACEMENTS; assert.strictEqual(Object.keys(AP).length, 14);      // 10 Vico placements + TikTok, Facebook, Instagram, other websites (requests)
  assert.deepStrictEqual(Object.keys(AP).filter((k) => AP[k].version === 1), ["short_videos"]);
  assert.deepStrictEqual(Object.keys(AP).filter((k) => AP[k].version === 2).sort(), ["marketplace", "search"]);
  assert.deepStrictEqual(Object.keys(AP).filter((k) => AP[k].version === 3), ["discovery"]);
  assert.deepStrictEqual(Object.keys(AP).filter((k) => AP[k].version === 4).sort(), ["business_profiles", "creator_videos"]);
  assert.deepStrictEqual(Object.keys(AP).filter((k) => AP[k].version === 5).sort(), ["events", "promotions"]);
  const V1 = ["short_videos"], V2 = ["short_videos", "marketplace", "search"];
  assert.deepStrictEqual(ads.recommendPlacements({ adType: "product" }, V1).placements, ["short_videos"]);                         // only what is open is offered
  assert.deepStrictEqual(ads.recommendPlacements({ adType: "product" }, ["short_videos", "marketplace", "home_feed"]).placements, ["marketplace", "home_feed", "short_videos"]);   // the shoe-seller example
  assert.deepStrictEqual(ads.recommendPlacements({ adType: "event" }, ["short_videos", "events", "promotions"]).placements, ["events", "promotions", "short_videos"]);
  assert.strictEqual(ads.recommendPlacements({ adType: "product", objective: "Promote my live stream" }, ["short_videos", "live"]).placements[0], "live");
  assert.deepStrictEqual(ads.resolvePlacements("recommended", [], { adType: "product" }, V2).placements, ["marketplace", "short_videos", "search"].filter((p) => ads.recommendPlacements({ adType: "product" }, V2).placements.includes(p)).length ? ads.recommendPlacements({ adType: "product" }, V2).placements : []);
  assert.deepStrictEqual(ads.resolvePlacements("short_videos", [], {}, V1).placements, ["short_videos"]);
  assert.ok(/Version 3/.test(ads.resolvePlacements("discovery", [], {}, V1).error));                                              // closed placements say when they open
  assert.ok(/Version 2/.test(ads.resolvePlacements("search", [], {}, V1).error));
  assert.ok(ads.resolvePlacements("multiple", ["short_videos"], {}, V2).error);                                                   // "multiple" needs 2 or more
  assert.ok(/not open/.test(ads.resolvePlacements("multiple", ["short_videos", "events"], {}, V2).error));
  assert.deepStrictEqual(ads.resolvePlacements("multiple", ["short_videos", "search"], {}, V2).placements, ["short_videos", "search"]);
  assert.ok(ads.resolvePlacements("anywhere", [], {}, V2).error);
  assert.deepStrictEqual(ads.resolvePlacements("custom", ["tiktok"], {}, ["marketplace", "tiktok"]).placements, ["marketplace", "tiktok"]);   // Marketplace is always added
  assert.deepStrictEqual(ads.resolvePlacements("custom", [], {}, ["marketplace"]).placements, ["marketplace"]);
  assert.ok(ads.resolvePlacements("custom", ["live"], {}, ["marketplace"]).error);
  console.log("ok  Ad placements: 10 placements in launch stages V1-V5; closed ones are refused with their opening version; recommendations match the shoe-seller example");

  // ---- Ad Center rules ----
  const S = { minBudget: 1000, maxBudget: 1000000, activePlacements: ["short_videos"] }, ok = { name: "Shoe sale", adType: "product", headline: "Fresh sneakers", body: "Quality sneakers from Lagos", link: "https://shop.example.com/shoes", budget: 5000, start: "2030-01-01", end: "2030-01-07", audienceMode: "auto", state: "Lagos", placementMode: "recommended" };
  let c = ads.cleanCampaign(ok, S, "2029-12-31"); assert.ok(c.value); assert.strictEqual(c.value.budget, 5000);
  for (const b of [{ ...ok, budget: 500 }, { ...ok, link: "http://shop.example.com" }, { ...ok, link: "https://localhost/x" }, { ...ok, state: "Mars" }, { ...ok, ageMin: 15 }, { ...ok, start: "2029-01-01" }, { ...ok, end: "2030-06-01" }, { ...ok, adType: "video" }, { ...ok, placementMode: "discovery" }, { ...ok, adType: "event", category: "Wedding" }]) assert.ok(ads.cleanCampaign(b, S, "2029-12-31").error);
  assert.deepStrictEqual(ads.costPreview({ budget: 7000, start: "2030-01-01", end: "2030-01-07", cpmNgn: 0, feePercent: 0 }), { days: 7, budget: 7000, dailyBudget: 1000, fee: 0, total: 7000, estimatedImpressions: null });   // no price set: no invented impressions
  assert.strictEqual(ads.costPreview({ budget: 7000, start: "2030-01-01", end: "2030-01-07", cpmNgn: 500, feePercent: 5 }).estimatedImpressions, 14000);
  assert.strictEqual(ads.costPreview({ budget: 7000, start: "2030-01-01", end: "2030-01-07", cpmNgn: 500, feePercent: 5 }).total, 7350);
  assert.ok(ads.autoReview({ ...c.value, headline: "Double your money fast!" }).some((f) => f.level === "block"));
  assert.ok(ads.autoReview({ ...c.value, body: "Guaranteed profit every week" }).some((f) => f.level === "block"));
  assert.strictEqual(ads.autoReview(c.value).filter((f) => f.level === "block").length, 0);
  console.log("ok  Ad Center: budget, dates, link, state and age rules; cost preview shows no impressions until a price is set; prohibited claims are blocked");
  console.log("\nALL MARKET COMMUNITY CHECKS PASSED"); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
