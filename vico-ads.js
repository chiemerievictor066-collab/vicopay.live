// =====================================================
// Vico Pay Live — VICO AD CENTER (phases 1-2 + review: accounts, ad studio, audience, budget, approval)
// =====================================================
// Built now:  advertiser account (uses the normal Vico login), ad studio (product / business / image ads), audience choices,
//             budget + cost preview, campaign statuses, submit for review, admin approve / reject, audit history.
// NOT built yet (later phases, so nothing here pretends to do them): paying with an ad wallet, ad delivery to users,
//             impression/click tracking, analytics, video upload, appeals. Until delivery exists the page shows no impressions, clicks or spend.
// Payment and approval are separate: approving an ad never publishes it by itself.
// New tables only: ad_advertisers, ad_campaigns, ad_reviews, ad_audit, ad_settings.
// =====================================================
const STATES = ["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT Abuja","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];
const ADVERTISER_TYPES = ["Individual advertiser", "Small business", "Registered company", "Product seller", "Service provider", "Content creator", "Agency"];
const CATEGORIES = ["Restaurant & Food", "Fashion", "Supermarket & Groceries", "Technology", "Real Estate", "Hotels & Travel", "Education", "Transportation", "Beauty", "Professional Services", "Electronics", "Health", "Other"];
const AD_TYPES = { product: "Product ad", business: "Business ad", image: "Image / banner ad", event: "Event promotion" };
const EVENT_KINDS = ["Concert", "Business event", "Product launch", "Online class", "Live shopping event", "Special promotion"];
const OBJECTIVES = ["Get more website visits", "Get more WhatsApp chats", "Promote a product", "Promote my business", "Promote my live stream", "Promote an event"];
const LANGUAGES = ["Any", "English", "Hausa", "Yoruba", "Igbo", "Pidgin", "French"];
const AUDIENCES = { auto: "Automatic audience", custom: "Custom audience", broad: "Broad audience" };
// The 10 places an ad can appear. `version` is the launch stage: only the placements an admin has switched ON can be chosen, the rest show
// "opens in version N". Launch plan: V1 Short Videos | V2 Marketplace, Search Results | V3 Discovery | V4 Business Profiles, Creator Videos | V5 Promotions, Events.
// Home Feed and Live Streaming have no stage yet (version null) and stay closed until an admin opens them.
const PLACEMENTS = {
  short_videos: { label: "Short Videos", icon: "🎬", version: 1 },
  marketplace: { label: "Marketplace", icon: "🛍️", version: 2 },
  search: { label: "Search Results", icon: "🔎", version: 2 },
  discovery: { label: "Discovery", icon: "✨", version: 3 },
  business_profiles: { label: "Business Profiles", icon: "💼", version: 4 },
  creator_videos: { label: "Creator Videos", icon: "🎥", version: 4 },
  promotions: { label: "Promotions", icon: "🏷️", version: 5 },
  events: { label: "Events", icon: "🎟️", version: 5 },
  home_feed: { label: "Home Feed", icon: "🏠", version: null },
  live: { label: "Live Streaming", icon: "🔴", version: null },
  // outside Vico: these are REQUESTS. The Vico team sets them up after approval, nothing is posted automatically.
  tiktok: { label: "TikTok", icon: "🎵", version: null, external: true },
  facebook: { label: "Facebook", icon: "📘", version: null, external: true },
  instagram: { label: "Instagram", icon: "📷", version: null, external: true },
  websites: { label: "Other websites", icon: "🌐", version: null, external: true }
};
const LEGACY_PLACEMENT = { feed: "home_feed", market: "marketplace" };
const PLACEMENT_MODES = { custom: "Choose my placements", recommended: "All recommended placements", short_videos: "Short videos only", search: "Search results only", discovery: "Discovery only", multiple: "Multiple placements" };
const DEFAULT_ACTIVE = ["marketplace", "short_videos", "tiktok", "facebook", "instagram", "websites"];   // Marketplace is always included; Vico delivers it itself. The outside platforms are requests.
const EDITABLE = ["draft", "rejected"];
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const PROHIBITED = /\b(counterfeit|fake (?:id|passport|certificate|degree)|stolen|firearms?|guns?|ammunition|cocaine|heroin|marijuana|escort|adult content|investment doubling|double your money|guaranteed (?:profit|profits|returns?|income|sales)|get rich quick|ponzi)\b/i;
const DAY = 86400000;
const MARKET = require("./vico-market");
// The ad is paid ONCE. After that, keeping the product in the Marketplace (and wherever else the ad appears) costs KEEP_USD every KEEP_DAYS days.
// The first KEEP_DAYS days are covered by the ad payment. Pure rules (tested):
const KEEP_USD = 2, KEEP_DAYS = MARKET.KEEP_DAYS;
const ngnPerUsd = () => Number(process.env.NGN_PER_USD) || 1500;
function keepFeeNgn(rate, usd) { return Math.round((Number(usd) || KEEP_USD) * (Number(rate) || 1500)); }
function extendKeep(current, t, days) { return Math.max(Number(current) || 0, t) + (days || KEEP_DAYS) * DAY; }   // renewing early never wastes paid days
function cleanProduct(b, campaign) {   // step 5: what the Marketplace product page will show
  b = b || {}; const saleMode = b.saleMode === "direct" ? "direct" : "vico";
  const r = MARKET.cleanListing({ title: campaign.headline || campaign.name, description: campaign.body, category: b.productCategory, price: b.price, oldPrice: b.oldPrice, saleMode, contactMode: b.contactMode, contactNumber: b.contactNumber, location: b.location, image: campaign.image || "" });
  if (r.error) return r.error === "Enter the price in Naira." ? { error: "Enter the price of your product." } : r;
  return r.value.saleMode === "vico" && !["address", "contact", "both"].includes(b.delivery) ? { error: "Choose how buyers receive the product." } : { value: { ...r.value, delivery: ["address", "contact", "both"].includes(b.delivery) ? b.delivery : null } };
}

// ---- pure rules (tested) ----
function linkProblem(url) {
  if (!url) return "";
  let u; try { u = new URL(url); } catch (_) { return "The link is not a valid web address."; }
  if (u.protocol !== "https:") return "The link must start with https://";
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname) || !u.hostname.includes(".")) return "The link must be a real website address.";
  return "";
}
function dayCount(start, end) { const a = Date.parse(start + "T00:00:00Z"), b = Date.parse(end + "T00:00:00Z"); return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) + 1 : 0; }
// the full cost shown BEFORE anything is paid; impressions are only estimated when an admin has set a real price per 1,000 views
function costPreview({ budget, start, end, cpmNgn, feePercent }) {
  const days = dayCount(start, end), b = Math.round(Number(budget));
  if (!(b > 0) || days < 1) return null;
  const fee = Math.round(b * (Number(feePercent) || 0) / 100);
  return { days, budget: b, dailyBudget: Math.floor(b / days), fee, total: b + fee,
    estimatedImpressions: Number(cpmNgn) > 0 ? Math.floor(b / Number(cpmNgn) * 1000) : null };
}
// Vico recommends where an ad fits best from its type and goal (a shoe shop gets Marketplace, Home Feed and Short Videos), then keeps only the placements that are open.
const FIT = { product: ["marketplace", "home_feed", "short_videos", "search", "discovery"], business: ["business_profiles", "discovery", "search", "short_videos", "creator_videos"],
  image: ["home_feed", "discovery", "marketplace", "short_videos"], event: ["events", "promotions", "discovery", "short_videos", "home_feed"] };
function recommendPlacements({ adType, objective }, active) {
  const order = /live stream/i.test(objective || "") ? ["live", "home_feed", "short_videos", "discovery"] : (FIT[adType] || FIT.product);
  const open = new Set(active || []);
  const rec = order.filter((p) => open.has(p)).slice(0, 3);
  const ideal = order.slice(0, 3);
  return { placements: rec.length ? rec : (active || []).slice(0, 1), ideal, closed: ideal.filter((p) => !open.has(p)) };
}
// turns what the advertiser picked into the real list of placements, or an error
function resolvePlacements(mode, chosen, ctx, active) {
  const open = new Set(active || []), name = (p) => PLACEMENTS[p].label;
  const closedMsg = (p) => name(p) + " is not open yet" + (PLACEMENTS[p].version ? " (it opens in Version " + PLACEMENTS[p].version + ")" : "") + ".";
  if (!PLACEMENT_MODES[mode]) return { error: "Choose where you want your advertisement to appear." };
  const withMarket = (l) => (open.has("marketplace") && !l.includes("marketplace") ? ["marketplace"].concat(l) : l);   // every ad appears in the Vico Marketplace
  if (mode === "recommended") { const r = recommendPlacements(ctx, active); return r.placements.length ? { placements: withMarket(r.placements) } : { error: "No placements are open for ads yet." }; }
  if (mode === "short_videos" || mode === "search" || mode === "discovery") return open.has(mode) ? { placements: withMarket([mode]) } : { error: closedMsg(mode) };
  if (mode === "custom") {
    const l = [...new Set([].concat(chosen || []).map((p) => LEGACY_PLACEMENT[p] || p))].filter((p) => PLACEMENTS[p]);
    const shut = l.find((p) => !open.has(p)); if (shut) return { error: closedMsg(shut) };
    const all = withMarket(l); return all.length ? { placements: all } : { error: "Choose at least one placement." };
  }
  const list = [...new Set([].concat(chosen || []).map((p) => LEGACY_PLACEMENT[p] || p))].filter((p) => PLACEMENTS[p]);
  if (list.length < 2) return { error: "Pick at least two placements, or choose a single-placement option." };
  const shut = list.find((p) => !open.has(p)); if (shut) return { error: closedMsg(shut) };
  return { placements: list };
}
function cleanCampaign(b, S, today, opts) {
  b = b || {}; const str = (k, n) => String(b[k] == null ? "" : b[k]).trim().slice(0, n);
  const c = { name: str("name", 80), adType: str("adType", 20), objective: str("objective", 60), headline: str("headline", 60), body: str("body", 400), cta: str("cta", 30),
    link: str("link", 300), priceText: str("priceText", 40), category: str("category", 40), country: str("country", 40) || "Nigeria", state: str("state", 40), city: str("city", 60),
    language: str("language", 20) || "Any", audienceMode: str("audienceMode", 10) || "auto", ageMin: Math.floor(Number(b.ageMin)) || 18, ageMax: Math.floor(Number(b.ageMax)) || 65,
    placementMode: str("placementMode", 12) || "recommended", budget: Math.round(Number(b.budget)), start: str("start", 10), end: str("end", 10), image: b.image ? String(b.image) : "" };
  if (c.name.length < 3) return { error: "Give your campaign a name." };
  if (!AD_TYPES[c.adType]) return { error: "Choose the type of ad." };
  if (!AUDIENCES[c.audienceMode]) return { error: "Choose an audience type." };
  if (c.adType === "event" && c.category && !EVENT_KINDS.includes(c.category)) return { error: "Choose what kind of event you are promoting." };
  if (c.state && !STATES.includes(c.state)) return { error: "Choose a state from the list." };
  const pr = resolvePlacements(c.placementMode, b.placements, { adType: c.adType, objective: c.objective }, S.activePlacements || DEFAULT_ACTIVE);
  if (pr.error) return { error: pr.error };
  c.placements = pr.placements.join(",");
  if (c.ageMin < 18 || c.ageMax > 99 || c.ageMin > c.ageMax) return { error: "Age range must be 18 or older." };
  if (c.image && (c.image.length > 420000 || !IMG_RE.test(c.image))) return { error: "The picture must be a JPG, PNG or WebP under about 300 KB." };
  if (!(c.budget >= S.minBudget && c.budget <= S.maxBudget)) return { error: "Budget must be between ₦" + S.minBudget.toLocaleString() + " and ₦" + S.maxBudget.toLocaleString() + "." };
  if (!(dayCount(c.start, c.end) >= 1) || (c.start < today && !(opts && opts.locked))) return { error: "Choose a start date from today and an end date after it." };
  if (dayCount(c.start, c.end) > 90) return { error: "A campaign can run for 90 days at most." };
  const lp = linkProblem(c.link); if (lp) return { error: lp };
  return { value: c };
}
// step 2 of the Ad Center flow: how people can reach the advertiser (collected once, checked by the Vico team against the ID later)
function cleanContact(b) {
  b = b || {}; const s = (k, n) => String(b[k] == null ? "" : b[k]).trim().slice(0, n);
  const c = { phone: s("phone", 20), state: s("cState", 40), city: s("cCity", 60), age: Math.floor(Number(b.age)), marketAddress: s("marketAddress", 200), country: s("cCountry", 40) || "Nigeria", extra: s("extra", 300) };
  if (!/^\+?[0-9 ]{7,16}$/.test(c.phone)) return { error: "Enter your phone number so buyers and Vico can reach you." };
  if (!STATES.includes(c.state) && c.country === "Nigeria") return { error: "Choose your state." };
  if (c.city.length < 2) return { error: "Enter your city or area." };
  if (!(c.age >= 18 && c.age <= 99)) return { error: "You must be 18 or older to advertise." };
  if (c.marketAddress.length < 8) return { error: "Enter your market or shop address." };
  return { value: c };
}
const ID_TYPES = { national_id: "National ID card", voters_card: "Voter's card", bank_statement: "Bank statement", drivers_license: "Driver's license", passport: "International passport" };
// ID photos are encrypted before they touch the database (AES-256-GCM, key from .env ID_DOC_KEY) and are only ever shown to an admin.
function idKey() { const k = String(process.env.ID_DOC_KEY || "").trim(); if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex"); try { const b = Buffer.from(k, "base64"); return b.length === 32 ? b : null; } catch (_) { return null; } }
function encryptDoc(key, text) { const iv = require("crypto").randomBytes(12), c = require("crypto").createCipheriv("aes-256-gcm", key, iv), enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]); return { enc: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") }; }
function decryptDoc(key, p) { const d = require("crypto").createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64")); d.setAuthTag(Buffer.from(p.tag, "base64")); return Buffer.concat([d.update(Buffer.from(p.enc, "base64")), d.final()]).toString("utf8"); }
// which step the advertiser is on, from what is really recorded
function flowStage(c, f, idStatus) {
  if (c.status === "cancelled") return "cancelled";
  if (!f || !Number(f.paid)) return "payment";
  if (idStatus !== "approved") return "identity";
  if (["under_review"].includes(c.status)) return "review";
  if (["approved", "active", "completed", "paused"].includes(c.status)) return "live";
  if (!Number(f.placementsDone)) return "placements";
  return "submit";
}
// automatic review at submit time: "block" stops it with a reason, "flag" goes to the human reviewer with a note
function autoReview(c) {
  const flags = [], text = [c.headline, c.body, c.name, c.priceText].join(" ");
  if (!c.headline || c.headline.length < 5) flags.push({ level: "block", note: "Add a headline (at least 5 letters)." });
  if (!c.body || c.body.length < 10) flags.push({ level: "block", note: "Add a short description of what you are advertising." });
  if (PROHIBITED.test(text)) flags.push({ level: "block", note: "This ad mentions something that is not allowed (illegal, counterfeit, or guaranteed money / profit claims)." });
  if (!c.link) flags.push({ level: "flag", note: "No link added." });
  if (/[A-Z]{12,}/.test(text)) flags.push({ level: "flag", note: "Lots of capital letters." });
  if (/\b100% (?:safe|guaranteed|working)\b/i.test(text)) flags.push({ level: "flag", note: "Absolute claim that needs checking." });
  return flags;
}

module.exports = function makeAds({ app, db, requireAuth, requireAdmin, emailVerified, commerce }) {
  const now = () => Date.now();
  const bad = (res, code, msg) => res.status(code).json({ success: false, message: msg });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS ad_advertisers (user_email TEXT PRIMARY KEY, adv_type TEXT NOT NULL, advertiser_name TEXT NOT NULL, business_name TEXT, category TEXT, country TEXT, state TEXT, website TEXT, status TEXT NOT NULL DEFAULT 'active', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ad_campaigns (id BIGSERIAL PRIMARY KEY, owner_email TEXT NOT NULL, name TEXT NOT NULL, ad_type TEXT NOT NULL, objective TEXT, headline TEXT, body TEXT, cta TEXT, link TEXT, price_text TEXT, category TEXT,
       country TEXT, state TEXT, city TEXT, language TEXT, audience_mode TEXT, age_min INTEGER, age_max INTEGER, placements TEXT, budget_ngn BIGINT NOT NULL, start_date TEXT, end_date TEXT, image TEXT,
       status TEXT NOT NULL DEFAULT 'draft', reject_reason TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, submitted_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_ad_campaigns_owner ON ad_campaigns(owner_email, id DESC)`, `CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status ON ad_campaigns(status, id DESC)`,
    `ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS placement_mode TEXT`, 
    `CREATE TABLE IF NOT EXISTS ad_flow (campaign_id BIGINT PRIMARY KEY, phone TEXT, state TEXT, city TEXT, age INTEGER, market_address TEXT, country TEXT, extra TEXT, listing_id BIGINT, sell_in_market SMALLINT,
       delivery_pref TEXT, paid SMALLINT NOT NULL DEFAULT 0, payment_ref TEXT, paid_at BIGINT, amount_paid BIGINT, placements_done SMALLINT NOT NULL DEFAULT 0, refund_due SMALLINT NOT NULL DEFAULT 0)`,
    `ALTER TABLE ad_flow ADD COLUMN IF NOT EXISTS video_id BIGINT`,
    `CREATE TABLE IF NOT EXISTS ad_identity (user_email TEXT PRIMARY KEY, doc_type TEXT, full_name TEXT, status TEXT NOT NULL DEFAULT 'pending', reason TEXT, enc TEXT, iv TEXT, tag TEXT, created_at BIGINT NOT NULL, reviewed_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS ad_reviews (id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL, reviewer TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ad_audit (id BIGSERIAL PRIMARY KEY, campaign_id BIGINT, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ad_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727281)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727281)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("ADS MIGRATE ERROR:", e); });

  const DEFAULTS = { budgets: "1000,5000,10000,20000,50000,100000", minBudget: "1000", maxBudget: "1000000", cpmNgn: "0", feePercent: "0", activePlacements: DEFAULT_ACTIVE.join(","), keepUsd: String(KEEP_USD) };
  async function settings() {
    const rows = await db.all("SELECT key, value FROM ad_settings"); const s = { ...DEFAULTS }; for (const r of rows) s[r.key] = r.value;
    return { budgets: s.budgets.split(",").map(Number).filter((n) => n > 0), minBudget: Number(s.minBudget) || 1000, maxBudget: Number(s.maxBudget) || 1000000, cpmNgn: Number(s.cpmNgn) || 0, feePercent: Number(s.feePercent) || 0,
      activePlacements: s.activePlacements.split(",").filter((p) => PLACEMENTS[p]), keepUsd: Number(s.keepUsd) > 0 ? Number(s.keepUsd) : KEEP_USD, keepDays: KEEP_DAYS, ngnPerUsd: ngnPerUsd() };
  }
  const today = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);   // Nigeria date (UTC+1)
  const audit = (id, actor, action, detail) => db.run("INSERT INTO ad_audit (campaign_id, actor, action, detail, created_at) VALUES (?,?,?,?,?)", [id, actor, action, String(detail || "").slice(0, 300), now()]).catch(() => {});
  const notify = (email, text) => db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [email, String(text).slice(0, 200), "vico-ad-center.html", now()]).catch(() => {});
  const COLS = `id, owner_email AS owner, name, ad_type AS "adType", objective, headline, body, cta, link, price_text AS "priceText", category, country, state, city, language, audience_mode AS "audienceMode", age_min AS "ageMin", age_max AS "ageMax", placements, placement_mode AS "placementMode", budget_ngn AS budget, start_date AS start, end_date AS "end", status, reject_reason AS "rejectReason", created_at AS "createdAt", updated_at AS "updatedAt", submitted_at AS "submittedAt", (image IS NOT NULL AND image <> '') AS "hasImage"`;
  const shape = (r) => ({ ...r, id: Number(r.id), budget: Number(r.budget), createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt), submittedAt: r.submittedAt ? Number(r.submittedAt) : null,
    placements: r.placements ? r.placements.split(",").map((p) => LEGACY_PLACEMENT[p] || p) : [], placementMode: r.placementMode || "recommended", imageUrl: r.hasImage ? "/api/ads/campaigns/" + r.id + "/image" : "", editable: EDITABLE.includes(r.status) });
  const mine = async (id, email) => { id = Math.floor(Number(id)); return Number.isFinite(id) ? db.get(`SELECT ${COLS} FROM ad_campaigns WHERE id = ? AND owner_email = ?`, [id, email]) : null; };

  app.get("/api/ads/settings", requireAuth, async (req, res) => {
    try { await ready; const S = await settings();
      res.json({ success: true, settings: S, placements: Object.keys(PLACEMENTS).map((id) => ({ id, ...PLACEMENTS[id], active: S.activePlacements.includes(id) })), placementModes: PLACEMENT_MODES, eventKinds: EVENT_KINDS,
      lists: { states: STATES, advertiserTypes: ADVERTISER_TYPES, categories: CATEGORIES, adTypes: AD_TYPES, objectives: OBJECTIVES, languages: LANGUAGES, audiences: AUDIENCES, } });
    } catch (e) { bad(res, 500, "Could not load settings."); }
  });

  app.post("/api/ads/placements/recommend", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), b = req.body || {};
      const r = recommendPlacements({ adType: String(b.adType || "product"), objective: String(b.objective || "") }, S.activePlacements);
      res.json({ success: true, placements: r.placements, ideal: r.ideal, notYetOpen: r.closed.map((p) => ({ id: p, label: PLACEMENTS[p].label, version: PLACEMENTS[p].version })) });
    } catch (e) { bad(res, 500, "Could not work out a recommendation."); }
  });

  // ---- advertiser account (the normal Vico login; no second account) ----
  app.get("/api/ads/advertisers/me", requireAuth, async (req, res) => {
    try { await ready;
      const a = await db.get(`SELECT adv_type AS type, advertiser_name AS "advertiserName", business_name AS "businessName", category, country, state, website, status, created_at AS "createdAt" FROM ad_advertisers WHERE user_email = ?`, [req.userEmail]);
      res.json({ success: true, advertiser: a || null, emailVerified: await emailVerified(req.userEmail) });
    } catch (e) { bad(res, 500, "Could not load your advertiser account."); }
  });
  const saveAdvertiser = async (req, res) => {
    try { await ready; const b = req.body || {}, s = (k, n) => String(b[k] == null ? "" : b[k]).trim().slice(0, n);
      const type = s("type", 40), name = s("advertiserName", 80), country = s("country", 40) || "Nigeria", state = s("state", 40), website = s("website", 200);
      if (!ADVERTISER_TYPES.includes(type)) return bad(res, 400, "Choose what type of advertiser you are.");
      if (name.length < 2) return bad(res, 400, "Enter your advertiser name.");
      if (state && !STATES.includes(state)) return bad(res, 400, "Choose a state from the list.");
      if (website && linkProblem(website)) return bad(res, 400, "The website must be a real address starting with https://");
      const t = now();
      await db.run(`INSERT INTO ad_advertisers (user_email, adv_type, advertiser_name, business_name, category, country, state, website, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)
        ON CONFLICT (user_email) DO UPDATE SET adv_type = EXCLUDED.adv_type, advertiser_name = EXCLUDED.advertiser_name, business_name = EXCLUDED.business_name, category = EXCLUDED.category, country = EXCLUDED.country, state = EXCLUDED.state, website = EXCLUDED.website, updated_at = EXCLUDED.updated_at`,
        [req.userEmail, type, name, s("businessName", 80), s("category", 40), country, state, website, t, t]);
      res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your advertiser account."); }
  };
  app.post("/api/ads/advertisers", requireAuth, saveAdvertiser);
  app.patch("/api/ads/advertisers/me", requireAuth, saveAdvertiser);

  // ---- dashboard: only what is really recorded ----
  app.get("/api/ads/overview", requireAuth, async (req, res) => {
    try { await ready;
      const rows = await db.all("SELECT status, COUNT(*) AS n FROM ad_campaigns WHERE owner_email = ? GROUP BY status", [req.userEmail]);
      const by = {}; rows.forEach((r) => { by[r.status] = Number(r.n); });
      res.json({ success: true, counts: by, total: Object.values(by).reduce((a, b) => a + b, 0),
        delivery: { launched: false, note: "Impressions, clicks and spend appear here once ad delivery and payments launch. No numbers are shown until they are really recorded." } });
    } catch (e) { bad(res, 500, "Could not load your overview."); }
  });

  app.post("/api/ads/estimate", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), b = req.body || {};
      const p = costPreview({ budget: b.budget, start: String(b.start || ""), end: String(b.end || ""), cpmNgn: S.cpmNgn, feePercent: S.feePercent });
      if (!p) return bad(res, 400, "Choose a budget and the start and end dates.");
      const pool = await db.get("SELECT COUNT(*) AS n FROM users");
      res.json({ success: true, preview: p, audiencePool: Number(pool.n),
        notes: ["Estimated reach is an estimate, not a promise of views, clicks, customers or sales.",
          p.estimatedImpressions === null ? "An impression estimate is not shown yet because the price per 1,000 views has not been set." : "Impressions are estimated from the price per 1,000 valid views.",
          "Location, age and language targeting cannot be counted yet because accounts do not record them, so the audience size above is every Vico account."] });
    } catch (e) { bad(res, 500, "Could not work out the cost."); }
  });

  // ---- campaigns: details -> payment -> ID check -> placements -> review -> live ----
  const flowOf = (id) => db.get(`SELECT phone, state AS "cState", city AS "cCity", age, market_address AS "marketAddress", country AS "cCountry", extra, listing_id AS "listingId", sell_in_market AS "sellInMarket", delivery_pref AS "deliveryPref", video_id AS "videoId", paid, payment_ref AS "paymentRef", paid_at AS "paidAt", amount_paid AS "amountPaid", placements_done AS "placementsDone", refund_due AS "refundDue" FROM ad_flow WHERE campaign_id = ?`, [id]);
  const idOf = async (email) => (await db.get(`SELECT status, reason, doc_type AS "docType" FROM ad_identity WHERE user_email = ?`, [email])) || { status: "none" };
  async function view(c, S) {
    const f = (await flowOf(c.id)) || {}, idn = await idOf(c.owner || c.owner_email);
    const pv = costPreview({ budget: c.budget, start: c.start, end: c.end, cpmNgn: S.cpmNgn, feePercent: S.feePercent });
    let product = null;
    if (f.listingId) { const l = await db.get(`SELECT id, title, price_ngn AS price, old_price_ngn AS "oldPrice", category, sale_mode AS "saleMode", contact_mode AS "contactMode", contact_number AS "contactNumber", status, keep_until AS "keepUntil" FROM market_listings WHERE id = ?`, [f.listingId]);
      if (l) { const pics = await db.get("SELECT COUNT(*) AS n FROM market_images WHERE listing_id = ?", [l.id]); let vid = null; if (f.videoId) vid = await db.get("SELECT status FROM videos WHERE id = ?", [f.videoId]).catch(() => null);
        const keep = l.keepUntil ? Number(l.keepUntil) : null; product = { id: Number(l.id), title: l.title, price: Number(l.price), oldPrice: l.oldPrice ? Number(l.oldPrice) : 0, category: l.category, saleMode: l.saleMode, contactMode: l.contactMode || "whatsapp", contactNumber: l.contactNumber || "", status: l.status,
          extraPictures: Number(pics.n), hasVideo: !!(vid && vid.status !== "removed"), keepUntil: keep, expired: !!(keep && keep <= now()), daysLeft: keep ? Math.max(0, Math.ceil((keep - now()) / DAY)) : null }; } }
    return { ...shape(c), product, flow: { ...f, paid: !!Number(f.paid), age: f.age ? Number(f.age) : null, placementsDone: !!Number(f.placementsDone), sellInMarket: f.sellInMarket === null || f.sellInMarket === undefined ? null : !!Number(f.sellInMarket), refundDue: !!Number(f.refundDue), paidAt: f.paidAt ? Number(f.paidAt) : null },
      stage: flowStage(c, { paid: f.paid, placementsDone: f.placementsDone }, idn.status), identity: { status: idn.status, reason: idn.reason || "" }, totalToPay: pv ? pv.total : null };
  }
  app.get("/api/ads/campaigns", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), rows = await db.all(`SELECT ${COLS} FROM ad_campaigns WHERE owner_email = ? ORDER BY id DESC LIMIT 100`, [req.userEmail]);
      const out = []; for (const r of rows) out.push(await view(r, S)); res.json({ success: true, campaigns: out });
    } catch (e) { console.error(e); bad(res, 500, "Could not load your campaigns."); }
  });
  app.get("/api/ads/campaigns/:id", requireAuth, async (req, res) => {
    try { await ready; const c = await mine(req.params.id, req.userEmail); if (!c) return bad(res, 404, "Campaign not found.");
      const hist = await db.all("SELECT action, detail, created_at AS at FROM ad_audit WHERE campaign_id = ? ORDER BY id DESC LIMIT 30", [c.id]);
      res.json({ success: true, campaign: await view(c, await settings()), history: hist.map((h) => ({ action: h.action, detail: h.detail, at: Number(h.at) })) });
    } catch (e) { bad(res, 500, "Could not load that campaign."); }
  });
  app.get("/api/ads/campaigns/:id/image", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const r = Number.isFinite(id) && await db.get("SELECT image FROM ad_campaigns WHERE id = ? AND owner_email = ?", [id, req.userEmail]);   // only the owner can see a draft's picture
      const m = r && r.image && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image); if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); }
  });

  const params = (c) => [c.name, c.adType, c.objective, c.headline, c.body, c.cta, c.link, c.priceText, c.category, c.country, c.state, c.city, c.language, c.audienceMode, c.ageMin, c.ageMax, c.placements, c.placementMode, c.budget, c.start, c.end];
  const ownListing = async (email, id) => { id = Math.floor(Number(id)); return Number.isFinite(id) && id > 0 ? db.get("SELECT id, status FROM market_listings WHERE id = ? AND seller = ? AND status IN ('active','sold','pending')", [id, email]) : null; };
  app.post("/api/ads/campaigns", requireAuth, async (req, res) => {
    try { await ready; const S = await settings();
      const adv = await db.get("SELECT status FROM ad_advertisers WHERE user_email = ?", [req.userEmail]);
      if (!adv) return bad(res, 400, "Create your advertiser account first.");
      if (adv.status !== "active") return bad(res, 403, "Your advertiser account is suspended. Please contact support.");
      const r = cleanCampaign(req.body, S, today()); if (r.error) return bad(res, 400, r.error);
      const k = cleanContact(req.body); if (k.error) return bad(res, 400, k.error);
      const lid = req.body.listingId ? await ownListing(req.userEmail, req.body.listingId) : null; if (req.body.listingId && !lid) return bad(res, 400, "That item is not one of your Marketplace items.");
      const c = r.value, t = now();
      const n = await db.get("SELECT COUNT(*) AS n FROM ad_campaigns WHERE owner_email = ? AND status = 'draft'", [req.userEmail]);
      if (Number(n.n) >= 20) return bad(res, 400, "You have 20 drafts. Delete or finish some first.");
      const id = await db.tx(async (tx) => {
        const row = await tx.get(`INSERT INTO ad_campaigns (owner_email, name, ad_type, objective, headline, body, cta, link, price_text, category, country, state, city, language, audience_mode, age_min, age_max, placements, placement_mode, budget_ngn, start_date, end_date, image, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?) RETURNING id`, [req.userEmail].concat(params(c), [c.image || null, t, t]));
        await tx.run("INSERT INTO ad_flow (campaign_id, phone, state, city, age, market_address, country, extra, listing_id) VALUES (?,?,?,?,?,?,?,?,?)", [row.id, k.value.phone, k.value.state, k.value.city, k.value.age, k.value.marketAddress, k.value.country, k.value.extra, lid ? lid.id : null]);
        return Number(row.id);
      });
      await audit(id, req.userEmail, "created", c.name);
      res.json({ success: true, id });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your campaign."); }
  });
  app.patch("/api/ads/campaigns/:id", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), cur = await mine(req.params.id, req.userEmail);
      if (!cur) return bad(res, 404, "Campaign not found.");
      if (!EDITABLE.includes(cur.status)) return bad(res, 400, "This campaign can no longer be edited. Duplicate it to make changes.");
      const f = (await flowOf(cur.id)) || {}, paid = !!Number(f.paid), body = { ...req.body };
      if (paid) { body.budget = cur.budget; body.start = cur.start; body.end = cur.end; }          // money and dates are locked once paid
      const r = cleanCampaign(body, S, today(), { locked: paid }); if (r.error) return bad(res, 400, r.error);
      const k = cleanContact(body); if (k.error) return bad(res, 400, k.error);
      const c = r.value; const keepImage = req.body && req.body.keepImage === true && !c.image;
      await db.run(`UPDATE ad_campaigns SET name=?, ad_type=?, objective=?, headline=?, body=?, cta=?, link=?, price_text=?, category=?, country=?, state=?, city=?, language=?, audience_mode=?, age_min=?, age_max=?, placements=?, placement_mode=?, budget_ngn=?, start_date=?, end_date=?${keepImage ? "" : ", image=?"}, status=?, reject_reason=NULL, updated_at=? WHERE id=? AND owner_email=?`,
        params(c).concat(keepImage ? [] : [c.image || null]).concat([paid ? "paid" : "draft", now(), cur.id, req.userEmail]));
      await db.run("UPDATE ad_flow SET phone=?, state=?, city=?, age=?, market_address=?, country=?, extra=? WHERE campaign_id=?", [k.value.phone, k.value.state, k.value.city, k.value.age, k.value.marketAddress, k.value.country, k.value.extra, cur.id]);
      await audit(cur.id, req.userEmail, "edited", c.name);
      res.json({ success: true });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your changes."); }
  });

  // step 3: PAY. The ad total (budget + any fee) goes to Paystack; the server only believes Paystack, never the browser.
  commerce.registerPurpose("ad", async (t, pay) => {
    await t.run("UPDATE ad_flow SET paid = 1, payment_ref = ?, paid_at = ?, amount_paid = ? WHERE campaign_id = ?", [pay.reference, now(), pay.amount, pay.refId]);
    await t.run("UPDATE ad_campaigns SET status = 'paid', updated_at = ? WHERE id = ? AND status = 'draft'", [now(), pay.refId]);
    return async () => { await audit(pay.refId, pay.payer, "paid", "₦" + Number(pay.amount).toLocaleString()); await notify(pay.payer, "Payment received. Next, verify your identity."); };
  });
  app.post("/api/ads/campaigns/:id/pay", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), cur = await mine(req.params.id, req.userEmail);
      if (!cur) return bad(res, 404, "Campaign not found.");
      if (cur.status !== "draft") return bad(res, 400, "This campaign is already paid or submitted.");
      if (cur.start < today()) return bad(res, 400, "The start date has passed. Edit the dates first.");
      const pv = costPreview({ budget: cur.budget, start: cur.start, end: cur.end, cpmNgn: S.cpmNgn, feePercent: S.feePercent }); if (!pv) return bad(res, 400, "Check the budget and dates.");
      let p; try { p = await commerce.initPayment({ purpose: "ad", refId: Number(cur.id), email: req.userEmail, amountNgn: pv.total, req, back: "vico-ad-center.html" }); }
      catch (e) { console.error("AD PAYMENT INIT ERROR:", e.response ? JSON.stringify(e.response.data) : e.message); return bad(res, 502, e.code === "no_key" ? "Payments are not switched on yet." : "Could not start the payment. Please try again."); }
      if (!p.url) return bad(res, 502, "Could not start the payment. Please try again.");
      res.json({ success: true, url: p.url, total: pv.total });
    } catch (e) { console.error(e); bad(res, 500, "Could not start the payment."); }
  });

  // step 4: IDENTITY. Only the Vico team can see it. It is encrypted, and deleted as soon as the team decides.
  app.get("/api/ads/identity/me", requireAuth, async (req, res) => { try { await ready; res.json({ success: true, identity: await idOf(req.userEmail), types: ID_TYPES, secure: !!idKey() }); } catch (e) { bad(res, 500, "Could not load."); } });
  app.post("/api/ads/identity", requireAuth, async (req, res) => {
    try { await ready; const key = idKey();
      if (!key) return bad(res, 503, "Identity checks are not switched on yet. Please try again soon.");
      const b = req.body || {}, type = String(b.docType || ""), name = String(b.fullName || "").trim(), img = String(b.image || "");
      if (!ID_TYPES[type]) return bad(res, 400, "Choose which document you are uploading.");
      if (name.length < 3 || name.length > 80) return bad(res, 400, "Type your full name exactly as it is written on the document.");
      if (img.length > 430000 || !IMG_RE.test(img)) return bad(res, 400, "Upload a clear photo (JPG, PNG or WebP) of the document.");
      const adv = await db.get("SELECT 1 AS x FROM ad_advertisers WHERE user_email = ?", [req.userEmail]); if (!adv) return bad(res, 400, "Create your advertiser account first.");
      const cur = await idOf(req.userEmail); if (cur.status === "approved") return res.json({ success: true, status: "approved" });
      const e = encryptDoc(key, img);
      await db.run(`INSERT INTO ad_identity (user_email, doc_type, full_name, status, reason, enc, iv, tag, created_at, reviewed_at) VALUES (?,?,?, 'pending', NULL, ?,?,?, ?, NULL)
        ON CONFLICT (user_email) DO UPDATE SET doc_type = EXCLUDED.doc_type, full_name = EXCLUDED.full_name, status = 'pending', reason = NULL, enc = EXCLUDED.enc, iv = EXCLUDED.iv, tag = EXCLUDED.tag, created_at = EXCLUDED.created_at, reviewed_at = NULL`,
        [req.userEmail, type, name, e.enc, e.iv, e.tag, now()]);
      await audit(null, req.userEmail, "identity_submitted", type);
      require("./id-approval").notifyIdSubmitted({ who: name + " (" + req.userEmail + ")", docLabel: ID_TYPES[type], source: "Ad Center" });
      res.json({ success: true, status: "pending" });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your document."); }
  });

  // step 5: PLACEMENTS + how it is sold + the product page (price, contact, pictures, video). The product is created as 'pending' and goes live when the ad is approved.
  app.post("/api/ads/campaigns/:id/placements", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), cur = await mine(req.params.id, req.userEmail);
      if (!cur) return bad(res, 404, "Campaign not found.");
      const f = (await flowOf(cur.id)) || {}, idn = await idOf(req.userEmail);
      if (!Number(f.paid)) return bad(res, 400, "Pay for this ad first.");
      if (idn.status !== "approved") return bad(res, 400, "Your identity must be verified first.");
      if (!["paid", "rejected"].includes(cur.status)) return bad(res, 400, "Placements can no longer be changed.");
      const b = req.body || {}, pr = resolvePlacements("custom", b.placements, { adType: cur.adType, objective: cur.objective }, S.activePlacements); if (pr.error) return bad(res, 400, pr.error);
      if (b.saleMode !== "vico" && b.saleMode !== "direct") return bad(res, 400, "Choose how you want to sell: through Vico Marketplace, or directly with the buyer.");
      const img = await db.get("SELECT image FROM ad_campaigns WHERE id = ?", [cur.id]);
      const pc = cleanProduct(b, { ...cur, image: (img && img.image) || "" }); if (pc.error) return bad(res, 400, pc.error);
      const v = pc.value, t = now(); let lid = f.listingId ? Number(f.listingId) : null;
      if (b.listingId) { const l = await ownListing(req.userEmail, b.listingId); if (!l) return bad(res, 400, "That item is not one of your Marketplace items."); lid = Number(l.id); }
      const existing = lid ? await db.get("SELECT status FROM market_listings WHERE id = ? AND seller = ?", [lid, req.userEmail]) : null;
      if (!existing) {
        const row = await db.get(`INSERT INTO market_listings (seller, title, description, price_ngn, old_price_ngn, category, location, image, sale_mode, contact_mode, contact_number, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?) RETURNING id`,
          [req.userEmail, v.title, v.description, v.price, v.oldPrice || null, v.category, v.location, v.image || null, v.saleMode, v.contactMode, v.contactNumber, t, t]); lid = Number(row.id);
      } else if (existing.status === "pending") {   // made by this flow: update everything
        await db.run("UPDATE market_listings SET title=?, description=?, price_ngn=?, old_price_ngn=?, category=?, location=?, image=?, sale_mode=?, contact_mode=?, contact_number=?, updated_at=? WHERE id=?",
          [v.title, v.description, v.price, v.oldPrice || null, v.category, v.location, v.image || null, v.saleMode, v.contactMode, v.contactNumber, t, lid]);
      } else {   // an item the seller already had on sale: only how it is priced and sold
        await db.run("UPDATE market_listings SET price_ngn=?, old_price_ngn=?, sale_mode=?, contact_mode=?, contact_number=?, updated_at=? WHERE id=?", [v.price, v.oldPrice || null, v.saleMode, v.contactMode, v.contactNumber, t, lid]);
      }
      await db.run("UPDATE ad_campaigns SET placements = ?, placement_mode = 'custom', updated_at = ? WHERE id = ?", [pr.placements.join(","), t, cur.id]);
      await db.run("UPDATE ad_flow SET sell_in_market = ?, delivery_pref = ?, listing_id = ?, placements_done = 1 WHERE campaign_id = ?", [v.saleMode === "vico" ? 1 : 0, v.delivery, lid, cur.id]);
      await audit(cur.id, req.userEmail, "placements", pr.placements.join(",") + " / " + v.saleMode); res.json({ success: true, placements: pr.placements, listingId: lid });
    } catch (e) { console.error(e); bad(res, 500, "Could not save your choices."); }
  });

  // step 6: SUBMIT for the Vico team's review (paid + identity approved + placements chosen are all required, checked here)
  app.post("/api/ads/campaigns/:id/submit", requireAuth, async (req, res) => {
    try { await ready; const cur = await mine(req.params.id, req.userEmail);
      if (!cur) return bad(res, 404, "Campaign not found.");
      const f = (await flowOf(cur.id)) || {}, idn = await idOf(req.userEmail);
      if (!["paid", "rejected"].includes(cur.status) || !Number(f.paid)) return bad(res, 400, cur.status === "draft" ? "Pay for this ad first." : "This campaign was already submitted.");
      if (idn.status !== "approved") return bad(res, 400, "Your identity must be verified first.");
      if (!Number(f.placementsDone)) return bad(res, 400, "Choose where your ad will appear first.");
      const adv = await db.get("SELECT status FROM ad_advertisers WHERE user_email = ?", [req.userEmail]);
      if (!adv || adv.status !== "active") return bad(res, 403, "Your advertiser account cannot submit ads right now.");
      if (!(await emailVerified(req.userEmail))) return bad(res, 403, "Please verify your email before submitting an ad.");
      const hasImg = await db.get("SELECT (image IS NOT NULL AND image <> '') AS ok FROM ad_campaigns WHERE id = ?", [cur.id]), pics = f.listingId ? await db.get("SELECT COUNT(*) AS n FROM market_images WHERE listing_id = ?", [f.listingId]) : { n: 0 };
      const vid = f.videoId ? await db.get("SELECT status FROM videos WHERE id = ?", [f.videoId]).catch(() => null) : null;
      if (!(hasImg && hasImg.ok) && !Number(pics.n) && !(vid && vid.status === "pending_ad")) return bad(res, 400, "Add a picture or a short video of your product first.");
      const flags = autoReview(cur), blocks = flags.filter((x) => x.level === "block");
      if (blocks.length) return bad(res, 400, blocks.map((x) => x.note).join(" "));
      await db.run("UPDATE ad_campaigns SET status = 'under_review', submitted_at = ?, updated_at = ?, reject_reason = NULL WHERE id = ?", [now(), now(), cur.id]);
      for (const x of flags) await db.run("INSERT INTO ad_reviews (campaign_id, reviewer, decision, reason, created_at) VALUES (?,?,?,?,?)", [cur.id, "auto", "flag", x.note, now()]);
      await audit(cur.id, req.userEmail, "submitted", "sent for review"); res.json({ success: true, status: "under_review" });
    } catch (e) { console.error(e); bad(res, 500, "Could not submit your campaign."); }
  });
  app.post("/api/ads/campaigns/:id/cancel", requireAuth, async (req, res) => {
    try { await ready; const cur = await mine(req.params.id, req.userEmail);
      if (!cur) return bad(res, 404, "Campaign not found.");
      const f = (await flowOf(cur.id)) || {};
      if (Number(f.paid)) return bad(res, 400, "This ad is already paid. Please contact support to cancel it and ask for a refund.");
      if (!["draft", "rejected"].includes(cur.status)) return bad(res, 400, "This campaign cannot be cancelled now.");
      await db.run("UPDATE ad_campaigns SET status = 'cancelled', updated_at = ? WHERE id = ?", [now(), cur.id]); await audit(cur.id, req.userEmail, "cancelled", "");
      res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not cancel this campaign."); }
  });
  app.post("/api/ads/campaigns/:id/duplicate", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const row = Number.isFinite(id) && await db.get(`INSERT INTO ad_campaigns (owner_email, name, ad_type, objective, headline, body, cta, link, price_text, category, country, state, city, language, audience_mode, age_min, age_max, placements, placement_mode, budget_ngn, start_date, end_date, image, status, created_at, updated_at)
        SELECT owner_email, LEFT(name || ' (copy)', 80), ad_type, objective, headline, body, cta, link, price_text, category, country, state, city, language, audience_mode, age_min, age_max, placements, placement_mode, budget_ngn, ?, ?, image, 'draft', ?, ? FROM ad_campaigns WHERE id = ? AND owner_email = ? RETURNING id`,
        [today(), today(), now(), now(), id, req.userEmail]);
      if (!row) return bad(res, 404, "Campaign not found.");
      await db.run("INSERT INTO ad_flow (campaign_id, phone, state, city, age, market_address, country, extra, listing_id) SELECT ?, phone, state, city, age, market_address, country, extra, listing_id FROM ad_flow WHERE campaign_id = ?", [row.id, id]);
      await audit(row.id, req.userEmail, "duplicated", "from #" + id); res.json({ success: true, id: Number(row.id) });
    } catch (e) { console.error(e); bad(res, 500, "Could not duplicate this campaign."); }
  });

  // ---- live in the Marketplace: approved + active ads are shown as "Sponsored". (Views and clicks are not counted yet.) ----
  const LIVE = "c.status = 'active' AND c.placements LIKE '%marketplace%' AND c.start_date <= ? AND c.end_date >= ? AND (f.listing_id IS NULL OR EXISTS (SELECT 1 FROM market_listings l WHERE l.id = f.listing_id AND l.status = 'active' AND (l.keep_until IS NULL OR l.keep_until > ?)))";
  app.get("/api/market/sponsored", async (req, res) => {
    try { await ready; const d = today();
      const rows = await db.all(`SELECT c.id, c.headline, c.body, c.cta, c.link, c.price_text AS "priceText", (c.image IS NOT NULL AND c.image <> '') AS "hasImage", f.listing_id AS "listingId", f.sell_in_market AS sell
        FROM ad_campaigns c LEFT JOIN ad_flow f ON f.campaign_id = c.id WHERE ${LIVE} ORDER BY RANDOM() LIMIT 12`, [d, d, now()]);
      res.json({ success: true, ads: rows.map((r) => ({ id: Number(r.id), headline: r.headline, body: r.body, cta: r.cta, link: r.link, priceText: r.priceText, listingId: r.listingId ? Number(r.listingId) : null, imageUrl: r.hasImage ? "/api/market/sponsored/" + r.id + "/image" : "" })) });
    } catch (e) { res.json({ success: true, ads: [] }); }
  });
  app.get("/api/market/sponsored/:id/image", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), d = today();
      const r = Number.isFinite(id) && await db.get(`SELECT c.image FROM ad_campaigns c LEFT JOIN ad_flow f ON f.campaign_id = c.id WHERE c.id = ? AND ${LIVE}`, [id, d, d, now()]);
      const m = r && r.image && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image); if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); }
  });

  // ---- KEEP FEE: the ad is paid once; every 2 months $2 keeps the product in the Marketplace and wherever its ad appears ----
  commerce.registerPurpose("keep", async (t, pay) => {
    const l = await t.get("SELECT seller, title, keep_until AS keep FROM market_listings WHERE id = ?", [pay.refId]); if (!l) return null;
    await t.run("UPDATE market_listings SET keep_until = ?, keep_notified = NULL, updated_at = ? WHERE id = ?", [extendKeep(l.keep, now(), KEEP_DAYS), now(), pay.refId]);
    return async () => { await notify(l.seller, "Thank you. “" + l.title + "” stays in the Marketplace for 2 more months.", "vico-marketplace.html?mine=1"); };
  });
  app.get("/api/keep/info", async (req, res) => { try { await ready; const S = await settings(); res.json({ success: true, usd: S.keepUsd, days: KEEP_DAYS, ngn: keepFeeNgn(ngnPerUsd(), S.keepUsd), ngnPerUsd: ngnPerUsd() }); } catch (e) { bad(res, 500, "Could not load."); } });
  app.post("/api/market/listings/:id/renew", requireAuth, async (req, res) => {
    try { await ready; const S = await settings(), id = Math.floor(Number(req.params.id));
      const l = Number.isFinite(id) && await db.get("SELECT id, status, keep_until AS keep FROM market_listings WHERE id = ? AND seller = ?", [id, req.userEmail]);
      if (!l || l.status !== "active") return bad(res, 404, "This item cannot be renewed.");
      if (l.keep && Number(l.keep) > now() + 30 * DAY) return bad(res, 400, "This item is already paid for more than a month ahead.");
      let p; try { p = await commerce.initPayment({ purpose: "keep", refId: id, email: req.userEmail, amountNgn: keepFeeNgn(ngnPerUsd(), S.keepUsd), req, back: "vico-marketplace.html?mine=1" }); }
      catch (e) { console.error("KEEP PAYMENT INIT ERROR:", e.response ? JSON.stringify(e.response.data) : e.message); return bad(res, 502, e.code === "no_key" ? "Payments are not switched on yet." : "Could not start the payment. Please try again."); }
      if (!p.url) return bad(res, 502, "Could not start the payment. Please try again.");
      res.json({ success: true, url: p.url, usd: S.keepUsd, ngn: keepFeeNgn(ngnPerUsd(), S.keepUsd) });
    } catch (e) { console.error(e); bad(res, 500, "Could not start the payment."); }
  });
  // reminders: once when 3 days are left, once when the product leaves the Marketplace
  async function keepSweep() { try { await ready; const t = now();
    const soon = await db.all("SELECT id, seller, title FROM market_listings WHERE status = 'active' AND keep_until IS NOT NULL AND keep_until > ? AND keep_until <= ? AND keep_notified IS NULL", [t, t + 3 * DAY]);
    for (const l of soon) { await db.run("UPDATE market_listings SET keep_notified = 1 WHERE id = ?", [l.id]); notify(l.seller, "“" + l.title + "” leaves the Marketplace in 3 days. Pay $" + KEEP_USD + " to keep it 2 more months.", "vico-marketplace.html?mine=1"); }
    const gone = await db.all("SELECT id, seller, title FROM market_listings WHERE status = 'active' AND keep_until IS NOT NULL AND keep_until <= ? AND (keep_notified IS NULL OR keep_notified = 1)", [t]);
    for (const l of gone) { await db.run("UPDATE market_listings SET keep_notified = 2 WHERE id = ?", [l.id]); notify(l.seller, "“" + l.title + "” is no longer shown in the Marketplace. Pay $" + KEEP_USD + " to bring it back for 2 months.", "vico-marketplace.html?mine=1"); }
  } catch (e) { console.error("KEEP SWEEP ERROR:", e.message); } }
  const keepTimer = setInterval(keepSweep, 6 * 3600 * 1000); if (keepTimer.unref) keepTimer.unref();

  // ---- admin (x-admin-key for now; staff roles and two-step login come with the security phase) ----
  app.get("/api/admin/ads/campaigns", requireAdmin, async (req, res) => {
    try { await ready; const S = await settings(), st = String(req.query.status || "under_review"), where = st === "all" ? "" : "WHERE status = ?";
      const rows = await db.all(`SELECT ${COLS} FROM ad_campaigns ${where} ORDER BY id DESC LIMIT 100`, st === "all" ? [] : [st]);
      const out = [];
      for (const r of rows) { const flags = await db.all("SELECT reason FROM ad_reviews WHERE campaign_id = ? AND reviewer = 'auto' ORDER BY id DESC LIMIT 6", [r.id]); out.push({ ...(await view(r, S)), owner: r.owner, flags: flags.map((f) => f.reason), imageUrl: r.hasImage ? "/api/admin/ads/campaigns/" + r.id + "/image" : "" }); }
      res.json({ success: true, campaigns: out });
    } catch (e) { console.error(e); bad(res, 500, "Could not load campaigns."); }
  });
  app.get("/api/admin/ads/campaigns/:id/image", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); const r = Number.isFinite(id) && await db.get("SELECT image FROM ad_campaigns WHERE id = ?", [id]);
      const m = r && r.image && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image); if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); }
  });
  app.post("/api/admin/ads/campaigns/:id/approve", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const c = Number.isFinite(id) && await db.get("SELECT owner_email AS owner, status FROM ad_campaigns WHERE id = ?", [id]);
      if (!c || c.status !== "under_review") return bad(res, 400, "Only a campaign under review can be approved.");
      const f = (await flowOf(id)) || {}, idn = await idOf(c.owner);
      if (!Number(f.paid)) return bad(res, 400, "This ad is not paid."); if (idn.status !== "approved") return bad(res, 400, "The advertiser's identity is not approved yet.");
      await db.run("UPDATE ad_campaigns SET status = 'active', updated_at = ? WHERE id = ?", [now(), id]);
      if (f.listingId) {   // the ad payment covers the first 2 months in the Marketplace; after that the seller renews for $2
        const l = await db.get("SELECT status, keep_until AS keep FROM market_listings WHERE id = ?", [f.listingId]);
        if (l) await db.run("UPDATE market_listings SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, keep_until = ?, keep_notified = NULL, updated_at = ? WHERE id = ?", [extendKeep(l.keep, now(), KEEP_DAYS), now(), f.listingId]);
        await db.run("UPDATE videos SET status = 'active' WHERE ad_campaign_id = ? AND status = 'pending_ad'", [id]).catch(() => {});
      }
      await db.run("INSERT INTO ad_reviews (campaign_id, reviewer, decision, reason, created_at) VALUES (?,?,?,?,?)", [id, "admin", "approved", String((req.body && req.body.note) || "").slice(0, 300), now()]);
      await audit(id, "admin", "approved", ""); notify(c.owner, "Your ad is approved and live in the Vico Marketplace on its start date."); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not approve."); }
  });
  // paid but cannot go live (for example the ID was refused for good): cancel it and mark it so you refund it from the Paystack dashboard
  app.post("/api/admin/ads/campaigns/:id/refund", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const c = Number.isFinite(id) && await db.get("SELECT owner_email AS owner, status FROM ad_campaigns WHERE id = ?", [id]); const f = c && await flowOf(id);
      if (!c || !f || !Number(f.paid) || c.status === "cancelled") return bad(res, 400, "Only a paid campaign can be marked for refund.");
      await db.run("UPDATE ad_campaigns SET status = 'cancelled', updated_at = ? WHERE id = ?", [now(), id]); await db.run("UPDATE ad_flow SET refund_due = 1 WHERE campaign_id = ?", [id]);
      await audit(id, "admin", "refund_due", f.paymentRef); notify(c.owner, "Your ad was cancelled and your payment will be refunded.");
      res.json({ success: true, paymentRef: f.paymentRef, amount: Number(f.amountPaid), note: "Now refund this payment from your Paystack dashboard." });
    } catch (e) { bad(res, 500, "Could not mark the refund."); }
  });

  // identity review: the admin compares the document with what the advertiser typed
  app.get("/api/admin/ads/identity", requireAdmin, async (req, res) => {
    try { await ready; const st = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending";
      const rows = await db.all(`SELECT i.user_email AS email, i.doc_type AS "docType", i.full_name AS "fullName", i.status, i.created_at AS "createdAt", (i.enc IS NOT NULL) AS "hasImage", a.advertiser_name AS "advertiserName", a.business_name AS "businessName", a.adv_type AS "advType"
        FROM ad_identity i LEFT JOIN ad_advertisers a ON a.user_email = i.user_email WHERE i.status = ? ORDER BY i.created_at LIMIT 100`, [st]);
      const out = [];
      for (const r of rows) { const f = await db.get(`SELECT f.phone, f.state, f.city, f.age, f.market_address AS "marketAddress", f.country FROM ad_flow f JOIN ad_campaigns c ON c.id = f.campaign_id WHERE c.owner_email = ? ORDER BY c.id DESC LIMIT 1`, [r.email]);
        out.push({ ...r, createdAt: Number(r.createdAt), docLabel: ID_TYPES[r.docType] || r.docType, entered: f || null }); }
      res.json({ success: true, identities: out });
    } catch (e) { console.error(e); bad(res, 500, "Could not load identity checks."); }
  });
  app.get("/api/admin/ads/identity/:email/image", requireAdmin, async (req, res) => {
    try { await ready; const key = idKey(); if (!key) return res.sendStatus(503);
      const email = String(req.params.email || "").toLowerCase(), r = await db.get("SELECT enc, iv, tag FROM ad_identity WHERE user_email = ?", [email]);
      if (!r || !r.enc) return res.sendStatus(404);
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(decryptDoc(key, r)); if (!m) return res.sendStatus(404);
      await audit(null, "admin", "identity_viewed", email);                                   // every look at an ID is logged
      res.set({ "Content-Type": m[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); }
  });
  app.post("/api/admin/ads/identity/:email/decision", requireAdmin, async (req, res) => {
    try { await ready; const email = String(req.params.email || "").toLowerCase(), d = String((req.body && req.body.decision) || ""), reason = String((req.body && req.body.reason) || "").trim().slice(0, 300);
      if (!["approve", "reject"].includes(d)) return bad(res, 400, "Choose approve or reject."); if (d === "reject" && reason.length < 5) return bad(res, 400, "Write the reason (the advertiser will read it).");
      const cur = await db.get("SELECT status FROM ad_identity WHERE user_email = ?", [email]); if (!cur || cur.status !== "pending") return bad(res, 400, "There is no pending document for this person.");
      // the photo is deleted as soon as a decision is made (we keep only the result)
      await db.run("UPDATE ad_identity SET status = ?, reason = ?, enc = NULL, iv = NULL, tag = NULL, reviewed_at = ? WHERE user_email = ?", [d === "approve" ? "approved" : "rejected", d === "reject" ? reason : null, now(), email]);
      await audit(null, "admin", "identity_" + d, email); notify(email, d === "approve" ? "Your identity is verified. Next, choose where your ad appears." : "Your identity could not be verified: " + reason); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not save the decision."); }
  });
  app.post("/api/admin/ads/campaigns/:id/reject", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), reason = String((req.body && req.body.reason) || "").trim().slice(0, 300);
      if (reason.length < 5) return bad(res, 400, "Write the reason (the advertiser will read it).");
      const c = Number.isFinite(id) && await db.get("SELECT owner_email AS owner, status FROM ad_campaigns WHERE id = ?", [id]);
      if (!c || !["under_review", "approved"].includes(c.status)) return bad(res, 400, "This campaign cannot be rejected now.");
      await db.run("UPDATE ad_campaigns SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?", [reason, now(), id]);
      await db.run("INSERT INTO ad_reviews (campaign_id, reviewer, decision, reason, created_at) VALUES (?,?,?,?,?)", [id, "admin", "rejected", reason, now()]);
      await audit(id, "admin", "rejected", reason); notify(c.owner, "Your ad needs changes: " + reason); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not reject."); }
  });
  app.post("/api/admin/ads/advertisers/suspend", requireAdmin, async (req, res) => {
    try { await ready; const email = String((req.body && req.body.email) || "").trim().toLowerCase(), on = !!(req.body && req.body.suspend);
      await db.run("UPDATE ad_advertisers SET status = ?, updated_at = ? WHERE user_email = ?", [on ? "suspended" : "active", now(), email]); await audit(null, "admin", on ? "suspended" : "unsuspended", email); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not update the advertiser."); }
  });
  app.get("/api/admin/ads/settings", requireAdmin, async (req, res) => { try { await ready; res.json({ success: true, settings: await settings(), placements: Object.keys(PLACEMENTS).map((id) => ({ id, ...PLACEMENTS[id] })) }); } catch (e) { bad(res, 500, "Could not load settings."); } });
  app.post("/api/admin/ads/settings", requireAdmin, async (req, res) => {
    try { await ready; const b = req.body || {}, put = (k, v) => db.run("INSERT INTO ad_settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, String(v)]);
      if (b.budgets !== undefined) { const l = [].concat(b.budgets).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 100000000); if (!l.length) return bad(res, 400, "Add at least one budget."); await put("budgets", l.join(",")); }
      if (b.activePlacements !== undefined) { const l = [].concat(b.activePlacements).filter((p) => PLACEMENTS[p]); if (!l.length) return bad(res, 400, "Keep at least one placement open."); await put("activePlacements", [...new Set(l)].join(",")); }
      for (const k of ["minBudget", "maxBudget", "cpmNgn", "feePercent"]) if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) return bad(res, 400, "Enter a valid number for " + k + "."); await put(k, n); }
      res.json({ success: true, settings: await settings() });
    } catch (e) { bad(res, 500, "Could not save settings."); }
  });
  return { ready };
};
module.exports.cleanContact = cleanContact; module.exports.flowStage = flowStage; module.exports.encryptDoc = encryptDoc; module.exports.decryptDoc = decryptDoc; module.exports.ID_TYPES = ID_TYPES;
module.exports.keepFeeNgn = keepFeeNgn; module.exports.extendKeep = extendKeep; module.exports.cleanProduct = cleanProduct; module.exports.KEEP_USD = KEEP_USD;
module.exports.PLACEMENTS = PLACEMENTS; module.exports.recommendPlacements = recommendPlacements; module.exports.resolvePlacements = resolvePlacements; module.exports.cleanCampaign = cleanCampaign; module.exports.autoReview = autoReview; module.exports.costPreview = costPreview; module.exports.linkProblem = linkProblem;
