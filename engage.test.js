// Follow/Save/⋯ helpers, Product Live ID rule, ID approval email, Groq provider — `node tests/engage.test.js` (no network, no database)
const assert = require("assert");
const eng = require("../vico-engage"), idap = require("../id-approval"), ai = require("../vico-ai");
// only real public https links are ever offered as "Visit website"
assert.strictEqual(eng.safeLink("https://shop.example.com/x?a=1"), "https://shop.example.com/x?a=1");
for (const bad of ["http://shop.example.com", "javascript:alert(1)", "https://localhost/x", "https://192.168.1.5/x", "https://10.0.0.1", "https://172.20.1.1", "https://intranet", "", null, "not a url"]) assert.strictEqual(eng.safeLink(bad), "", String(bad));
assert.strictEqual(eng.cleanKind("video"), "video"); assert.strictEqual(eng.cleanKind("product"), "product"); assert.strictEqual(eng.cleanKind("user"), "");
assert.strictEqual(eng.fileName("Fresh Sneakers!! (new)", "mp4"), "Fresh-Sneakers-new.mp4"); assert.strictEqual(eng.fileName("", "jpg"), "vico.jpg");
// ID approval email: names + document type only, never an image or number
const m = idap.buildMail({ who: 'Ada <b>"x"</b> (ada@x.com)', docLabel: "National ID card", source: "Ad Center", url: "https://vicopay.live/admin-community.html" });
assert.ok(/ID check waiting/.test(m.subject)); assert.ok(!/<b>"x"<\/b>/.test(m.html)); assert.ok(/&lt;b&gt;/.test(m.html)); assert.ok(!/data:image|base64/i.test(m.text + m.html));
process.env.ID_APPROVER_EMAIL = "boss@vicopay.live"; assert.strictEqual(idap.approverEmail(), "boss@vicopay.live");
process.env.ID_APPROVER_EMAIL = "nonsense"; process.env.PAYOUT_APPROVER_EMAIL = "pay@vicopay.live"; assert.strictEqual(idap.approverEmail(), "pay@vicopay.live");
delete process.env.ID_APPROVER_EMAIL; delete process.env.PAYOUT_APPROVER_EMAIL; delete process.env.INBOX_FORWARD_TO; assert.strictEqual(idap.approverEmail(), "");
delete process.env.ID_REQUIRED_FOR_PRODUCT_LIVE; assert.strictEqual(idap.requiredForLive(), true);   // default: ID approval is required to sell in a live
process.env.ID_REQUIRED_FOR_PRODUCT_LIVE = "false"; assert.strictEqual(idap.requiredForLive(), false); process.env.ID_REQUIRED_FOR_PRODUCT_LIVE = "true"; assert.strictEqual(idap.requiredForLive(), true);
process.env.APP_URL = "https://vicopay.live/"; delete process.env.ID_REVIEW_URL; assert.strictEqual(idap.reviewUrl(), "https://vicopay.live/admin-community.html");
// Groq provider (OpenAI-style request, gpt-oss thinks briefly)
const rq = ai.providerRequest({ provider: "groq", model: "openai/gpt-oss-20b", key: "k", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 700 });
assert.strictEqual(rq.url, "https://api.groq.com/openai/v1/chat/completions"); assert.strictEqual(rq.body.reasoning_effort, "low"); assert.strictEqual(rq.headers.Authorization, "Bearer k");
assert.strictEqual(ai.readReply("groq", { choices: [{ message: { content: " Hi " } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }).text, "Hi");
console.log("engage tests passed");
