// Vico Ad Center — levels, priced jobs, business information and identity matching.
// Run:  node tests/ad-jobs.test.js      (the full-flow part needs Node 22.5+ because it uses the built-in SQLite engine; it is skipped on older Node)
const assert = require("assert"), fs = require("fs"), path = require("path"), Module = require("module");
const SITE = path.join(__dirname, "..");
const J = require("../vico-ad-jobs");
const ads = require("../vico-ads");
process.env.ID_DOC_KEY = "a".repeat(64); process.env.NGN_PER_USD = "1500";

// ---- 1. the price list: the pages must show exactly what the server will charge ----
const tiers = J.CATALOG.tiers;
assert.deepStrictEqual(Object.keys(tiers), ["personal", "small-business", "big-business", "company", "national"]);
for (const k of Object.keys(tiers)) {
  const t = tiers[k], html = fs.readFileSync(path.join(SITE, t.page), "utf8");
  const chips = [...html.matchAll(/data-price="(\d+)"[^>]*>(.*?)<span class="pr">/g)].map((m) => ({ usd: Number(m[1]), name: m[2] }));
  assert.strictEqual(chips.length, t.jobs.length, k + ": number of jobs on the page and in the price list");
  t.jobs.forEach((j, i) => { assert.strictEqual(chips[i].name, j.name, k + " job name " + j.name); assert.strictEqual(chips[i].usd, j.usd, k + " price of " + j.name);
    assert.ok(j.usd >= t.min && (t.max === null || j.usd <= t.max), k + ": " + j.name + " is outside the level's price range"); });
  assert.strictEqual(new Set(t.jobs.map((j) => j.name.toLowerCase())).size, t.jobs.length, k + ": job names must be unique");
  assert.ok(html.includes('id="payLink"') && html.includes("ad-payment.html?level="), k + ": page links to payment");
}
assert.strictEqual(tiers.personal.min, 4); assert.strictEqual(tiers.personal.max, 10);
const q = J.quoteFor("Personal Ads", "barber", 1500);
assert.strictEqual(q.usd, 4); assert.strictEqual(q.ngn, 6000); assert.strictEqual(q.kobo, 600000); assert.strictEqual(q.currency, "NGN");
assert.strictEqual(J.quoteFor("Personal Ads", "Nonexistent job", 1500), null); assert.strictEqual(J.quoteFor("Mega Ads", "Barber", 1500), null);
assert.strictEqual(J.quoteFor("personal", "BARBER", 1500).job, "Barber");   // the key or the label, any capitals
console.log("ok  Price list: " + Object.keys(tiers).map((k) => tiers[k].jobs.length).join("+") + " jobs, pages equal the server's prices, every price inside its level's range");

// ---- 2. matching rules ----
assert.strictEqual(J.normPhone("0801 234 5678"), "2348012345678"); assert.strictEqual(J.normPhone("+234 801 234 5678"), "2348012345678"); assert.strictEqual(J.normPhone("2348012345678"), "2348012345678");
assert.notStrictEqual(J.normPhone("08012345679"), J.normPhone("08012345678")); assert.strictEqual(J.normPhone(""), "");
const prof = { ownerName: "Amina  Yusuf Bello", phone: "08012345678", country: "Nigeria", city: "Bauchi, Bauchi State" };
assert.deepStrictEqual(J.compareIdentity(prof, { legalName: "amina yusuf bello", phone: "+2348012345678", country: "NIGERIA", city: "bauchi, bauchi state" }), { ok: true, mismatches: [] });
assert.deepStrictEqual(J.compareIdentity(prof, { legalName: "Amina Yusuf", phone: "08012345678", country: "Nigeria", city: "Bauchi" }).mismatches, ["name", "city / state"]);
assert.deepStrictEqual(J.compareIdentity(prof, { legalName: "Amina Yusuf Bello", phone: "08099999999", country: "Ghana", city: "Bauchi, Bauchi State" }).mismatches, ["phone number", "country"]);
console.log("ok  Identity matching: capitals/spaces/phone formats ignored; a different name, phone, country or city is caught");

// ---- 3. which step the advertiser is on ----
const O = (status) => ({ status });
assert.strictEqual(J.stageOf(null, false, "none"), "none"); assert.strictEqual(J.stageOf(O("pending_payment"), false, "none"), "payment");
assert.strictEqual(J.stageOf(O("paid"), false, "none"), "profile"); assert.strictEqual(J.stageOf(O("profile_saved"), true, "none"), "identity");
assert.strictEqual(J.stageOf(O("id_pending"), true, "pending"), "review"); assert.strictEqual(J.stageOf(O("verified"), true, "approved"), "verified");
assert.strictEqual(J.stageOf(O("id_rejected"), true, "rejected"), "identity"); assert.strictEqual(J.stageOf(O("id_rejected"), false, "rejected"), "profile");
console.log("ok  Steps: payment > business information > identity > review > verified (a rejected ID goes back to identity)");

// ---- 4. files must really be what they say, and IDs are encrypted ----
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]), png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(20)]);
const pdf = Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(20)]), mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42"), Buffer.alloc(20)]), exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(40)]);
assert.strictEqual(J.sniffImage(jpg), "image/jpeg"); assert.strictEqual(J.sniffImage(png), "image/png"); assert.strictEqual(J.sniffImage(pdf, false), ""); assert.strictEqual(J.sniffImage(pdf, true), "application/pdf"); assert.strictEqual(J.sniffImage(exe, true), "");
assert.strictEqual(J.sniffVideo(mp4), "video/mp4"); assert.strictEqual(J.sniffVideo(jpg), "");
const key = Buffer.alloc(32, 7), e = J.encryptBuf(key, jpg); assert.ok(!e.enc.equals(jpg)); assert.ok(J.decryptBuf(key, e).equals(jpg));
assert.throws(() => J.decryptBuf(Buffer.alloc(32, 8), e));
console.log("ok  Uploads: only real JPG/PNG/WebP (PDF for the ID front) and MP4/MOV/WebM are accepted; ID photos are encrypted and a wrong key fails");

// ---- 5. form rules ----
const good = { ownerName: "Amina Yusuf Bello", businessName: "Amina Styles", description: "Hair styling and braiding at home and in salon.", phone: "08012345678", email: "", whatsapp: "", address: "12 Market Road, Bauchi", country: "Nigeria", city: "Bauchi, Bauchi State", placements: ["Marketplace"], socialLink: "https://instagram.com/aminastyles", social: "", products: "Braids, wigs", logo: "" };
assert.ok(J.cleanProfile(good, ads.linkProblem).value);
assert.ok(J.cleanProfile({ ...good, socialLink: "http://x.com/a" }, ads.linkProblem).error); assert.ok(J.cleanProfile({ ...good, socialLink: "" }, ads.linkProblem).error);
assert.ok(J.cleanProfile({ ...good, placements: ["Nowhere"] }, ads.linkProblem).error); assert.ok(J.cleanProfile({ ...good, phone: "abc" }, ads.linkProblem).error);
assert.ok(J.cleanProfile({ ...good, logo: "data:image/svg+xml;base64,AAAA" }, ads.linkProblem).error);
const idOk = { legalName: "Amina Yusuf Bello", dateOfBirth: "1995-04-02", idType: "National identity card", idNumber: "123", residentialAddress: "12 Market Road, Bauchi", phone: "08012345678", country: "Nigeria", city: "Bauchi" };
assert.ok(J.cleanIdentity(idOk).value); assert.ok(J.cleanIdentity({ ...idOk, dateOfBirth: new Date().getFullYear() - 10 + "-01-01" }).error); assert.ok(J.cleanIdentity({ ...idOk, idType: "Library card" }).error);
console.log("ok  Forms: social link must be https, placements must be real, ID must be an adult with an accepted document");

// ---- 6. the whole flow against a real SQL engine (SQLite stands in for PostgreSQL) ----
let sqlite = null; try { sqlite = require("node:sqlite"); } catch (_) { /* older Node */ }
if (!sqlite) { console.log("skip  Full flow test needs Node 22.5+ (built-in SQLite)."); process.exit(0); }
process.removeAllListeners("warning");
const orig = Module._load; Module._load = function (req, ...a) { return req === "express" ? { raw: () => (rq, rs, next) => next() } : orig.call(this, req, ...a); };
const s = new sqlite.DatabaseSync(":memory:"), conv = (x) => x.replace(/BIGSERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT").replace(/BYTEA/g, "BLOB");
const bind = (p) => (p || []).map((v) => (Buffer.isBuffer(v) ? new Uint8Array(v) : v)), fix = (r) => { if (!r) return r; const o = { ...r }; for (const k in o) if (o[k] instanceof Uint8Array) o[k] = Buffer.from(o[k]); return o; };
s.exec("CREATE TABLE ad_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id BIGINT, actor TEXT, action TEXT, detail TEXT, created_at BIGINT); CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, text TEXT, link TEXT, created_at BIGINT)");
const db = { get: async (q, p) => fix(s.prepare(conv(q)).get(...bind(p))), all: async (q, p) => s.prepare(conv(q)).all(...bind(p)).map(fix), run: async (q, p) => { s.prepare(conv(q)).run(...bind(p)); },
  tx: async (fn) => { s.exec("BEGIN"); try { const r = await fn(db); s.exec("COMMIT"); return r; } catch (e) { s.exec("ROLLBACK"); throw e; } },
  pool: { connect: async () => ({ query: async (q) => { if (!/advisory/.test(q)) s.exec(conv(q)); }, release() {} }) } };
const routes = []; const mk = (m) => (p, ...h) => routes.push({ m, re: new RegExp("^" + p.replace(/:[a-z]+/g, "([^/]+)") + "$"), names: (p.match(/:[a-z]+/g) || []).map((x) => x.slice(1)), h });
const app = { get: mk("GET"), post: mk("POST"), put: mk("PUT") };
const purposes = {}, inits = [];
const commerce = { registerPurpose: (n, f) => { purposes[n] = f; }, initPayment: async (o) => { inits.push(o); return { reference: "VAD-T" + inits.length, url: "https://paystack.test/pay" + inits.length }; } };
const requireAuth = (req, res, next) => (req._user ? (req.userEmail = req._user, next()) : res.status(401).json({ success: false })), requireAdmin = (req, res, next) => (req._admin ? next() : res.status(401).json({ success: false }));
const { ready } = J({ app, db, requireAuth, requireAdmin, commerce, linkProblem: ads.linkProblem });
async function call(method, url, o) {
  o = o || {}; const [pathname, qs] = url.split("?"); const r = routes.find((x) => x.m === method && x.re.test(pathname)); if (!r) throw new Error("no route " + method + " " + pathname);
  const m = pathname.match(r.re), req = { params: {}, query: Object.fromEntries(new URLSearchParams(qs || "")), body: o.body, _user: o.user, _admin: o.admin };
  r.names.forEach((n, i) => { req.params[n] = m[i + 1]; });
  return new Promise((resolve, reject) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, send(b) { resolve({ code: this.code, body: b }); }, set() { return this; }, sendStatus(c) { resolve({ code: c }); } };
    let i = 0; const next = (e) => { if (e) return reject(e); const f = r.h[i++]; if (!f) return; Promise.resolve(f(req, res, next)).catch(reject); }; next(); });
}
(async () => {
  await ready; const A = "amina@x.com", B = "other@x.com";
  // price
  let r = await call("GET", "/api/ads/quote?level=Personal%20Ads&category=Barber", { user: A }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.amount, 600000); assert.strictEqual(r.body.currency, "NGN");
  r = await call("GET", "/api/ads/quote?level=Personal%20Ads&category=Nope", { user: A }); assert.strictEqual(r.code, 404);
  r = await call("GET", "/api/ads/quote?level=Personal%20Ads&category=Barber", {}); assert.strictEqual(r.code, 401);
  // the browser can never set the price: extra fields are ignored, the server amount is used
  r = await call("POST", "/api/ads/paystack/initialize", { user: A, body: { level: "Personal Ads", category: "Barber", amount: 1, amountNgn: 1 } }); assert.strictEqual(r.code, 200); assert.strictEqual(inits[0].amountNgn, 6000); assert.strictEqual(inits[0].purpose, "adjob"); assert.strictEqual(inits[0].back, "ad-business-information.html");
  r = await call("POST", "/api/ads/paystack/initialize", { user: A, body: { level: "Personal Ads", category: "Barber" } }); assert.strictEqual(inits[1].refId, inits[0].refId, "same unpaid order is reused");
  assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM ad_job_orders")).n, 1);
  r = await call("GET", "/api/ads/orders/current", { user: A }); assert.strictEqual(r.body.order, null);
  r = await call("POST", "/api/ads/business-profile", { user: A, body: { ...good, logo: "" } }); assert.strictEqual(r.code, 403, "no business information before payment");
  // pay (what the commerce file does once Paystack confirms)
  const oid = inits[0].refId; let after; await db.tx(async (t) => { after = await purposes.adjob(t, { reference: "VAD-T1", refId: oid, payer: A, amount: 6000 }); }); await after();
  r = await call("GET", "/api/ads/orders/current", { user: A }); assert.strictEqual(r.body.stage, "profile"); assert.strictEqual(r.body.order.job, "Barber"); assert.strictEqual(r.body.order.level, "Personal Ads");
  // business information
  r = await call("POST", "/api/ads/business-profile", { user: A, body: { ...good, logo: "" } }); assert.strictEqual(r.code, 400); assert.match(r.body.message, /logo/i);
  const logo = "data:image/png;base64," + png.toString("base64");
  r = await call("POST", "/api/ads/business-profile", { user: A, body: { ...good, logo } }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.orderId, oid);
  r = await call("PUT", "/api/ads/orders/" + oid + "/media/product", { user: B, body: jpg }); assert.strictEqual(r.code, 404, "another user cannot touch this order");
  r = await call("PUT", "/api/ads/orders/" + oid + "/media/product", { user: A, body: exe }); assert.strictEqual(r.code, 400);
  r = await call("POST", "/api/ads/orders/" + oid + "/profile/complete", { user: A }); assert.strictEqual(r.code, 400); assert.match(r.body.message, /product picture/);
  r = await call("PUT", "/api/ads/orders/" + oid + "/media/product", { user: A, body: jpg }); assert.strictEqual(r.body.count, 1);
  r = await call("POST", "/api/ads/orders/" + oid + "/profile/complete", { user: A }); assert.strictEqual(r.code, 400); assert.match(r.body.message, /video/);
  r = await call("PUT", "/api/ads/orders/" + oid + "/media/video", { user: A, body: jpg }); assert.strictEqual(r.code, 400);
  r = await call("PUT", "/api/ads/orders/" + oid + "/media/video", { user: A, body: mp4 }); assert.strictEqual(r.code, 200);
  r = await call("POST", "/api/ads/orders/" + oid + "/profile/complete", { user: A }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.next_url, "ad-identity-verification.html");
  r = await call("GET", "/api/ads/orders/current", { user: A }); assert.strictEqual(r.body.stage, "identity"); assert.strictEqual(r.body.profile.businessName, "Amina Styles"); assert.strictEqual(r.body.media.products, 1); assert.strictEqual(r.body.media.video, true);
  // identity: photos first, then the details, which must match the business information
  r = await call("PUT", "/api/ads/orders/" + oid + "/identity/front", { user: A, body: pdf }); assert.strictEqual(r.code, 200, "a PDF is allowed for the front");
  r = await call("PUT", "/api/ads/orders/" + oid + "/identity/selfie", { user: A, body: pdf }); assert.strictEqual(r.code, 400, "a selfie must be a photo");
  r = await call("POST", "/api/ads/identity-verification", { user: A, body: idOk }); assert.strictEqual(r.code, 400); assert.match(r.body.message, /selfie/i);
  r = await call("PUT", "/api/ads/orders/" + oid + "/identity/front", { user: A, body: jpg }); r = await call("PUT", "/api/ads/orders/" + oid + "/identity/selfie", { user: A, body: png }); assert.strictEqual(r.code, 200);
  r = await call("POST", "/api/ads/identity-verification", { user: A, body: { ...idOk, legalName: "Amina Yusuf", city: "Kano" } }); assert.strictEqual(r.code, 422); assert.deepStrictEqual(r.body.mismatches, ["name", "city / state"]);
  assert.strictEqual(await db.get("SELECT 1 AS x FROM ad_job_identity"), undefined, "a mismatch saves nothing");
  r = await call("POST", "/api/ads/identity-verification", { user: A, body: { ...idOk, city: "Bauchi, Bauchi State", phone: "+234 801 234 5678" } }); assert.strictEqual(r.code, 200); assert.strictEqual(r.body.status, "pending");
  r = await call("GET", "/api/ads/orders/current", { user: A }); assert.strictEqual(r.body.stage, "review");
  r = await call("POST", "/api/ads/business-profile", { user: A, body: { ...good, logo } }); assert.strictEqual(r.code, 400, "information is locked while the ID is being checked");
  r = await call("POST", "/api/ads/identity-verification", { user: A, body: { ...idOk, city: "Bauchi, Bauchi State" } }); assert.strictEqual(r.code, 400);
  // the ID is stored encrypted, never as the original photo
  const stored = await db.get("SELECT enc FROM ad_job_id_files WHERE order_id = ? AND part = 'front'", [oid]); assert.ok(!stored.enc.equals(jpg));
  assert.strictEqual((await db.get("SELECT id_number FROM ad_job_identity")).id_number.includes("123"), false, "the ID number is encrypted too");
  // admin
  r = await call("GET", "/api/admin/ad-jobs?status=id_pending", {}); assert.strictEqual(r.code, 401);
  r = await call("GET", "/api/admin/ad-jobs?status=id_pending", { admin: true }); assert.strictEqual(r.body.orders.length, 1); const ord = r.body.orders[0];
  assert.strictEqual(ord.match.ok, true); assert.deepStrictEqual(ord.idFiles.sort(), ["front", "selfie"]); assert.strictEqual(ord.level, "Personal Ads"); assert.strictEqual(ord.media.length, 2);
  r = await call("GET", "/api/admin/ad-jobs/" + oid + "/id/front", { admin: true }); assert.ok(Buffer.isBuffer(r.body) && r.body.equals(jpg), "admin sees the original photo");
  r = await call("POST", "/api/admin/ad-jobs/" + oid + "/decision", { admin: true, body: { decision: "reject", reason: "no" } }); assert.strictEqual(r.code, 400);
  r = await call("POST", "/api/admin/ad-jobs/" + oid + "/decision", { admin: true, body: { decision: "reject", reason: "The photo is blurry, please retake it." } }); assert.strictEqual(r.code, 200);
  assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM ad_job_id_files")).n, 0, "photos are deleted once a decision is made");
  r = await call("GET", "/api/ads/orders/current", { user: A }); assert.strictEqual(r.body.stage, "identity"); assert.strictEqual(r.body.identity.status, "rejected"); assert.match(r.body.identity.reason, /blurry/);
  // try again, this time approved
  await call("PUT", "/api/ads/orders/" + oid + "/identity/front", { user: A, body: jpg }); await call("PUT", "/api/ads/orders/" + oid + "/identity/selfie", { user: A, body: jpg });
  r = await call("POST", "/api/ads/identity-verification", { user: A, body: { ...idOk, city: "Bauchi, Bauchi State" } }); assert.strictEqual(r.code, 200);
  r = await call("POST", "/api/admin/ad-jobs/" + oid + "/decision", { admin: true, body: { decision: "approve" } }); assert.strictEqual(r.code, 200);
  r = await call("GET", "/api/ads/orders/current", { user: A }); assert.strictEqual(r.body.stage, "verified");
  assert.ok((await db.all("SELECT * FROM notifications WHERE user_id = ?", [A])).length >= 3); assert.ok((await db.get("SELECT COUNT(*) AS n FROM ad_audit")).n >= 5);
  console.log("ok  Full flow (real SQL): level > job > server price > pay > business info + pictures + video > ID mismatch refused > ID matched > rejected > resubmitted > verified");
})().catch((e) => { console.error(e); process.exit(1); });
