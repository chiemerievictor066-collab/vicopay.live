// =====================================================
// Vico Pay Live — VICO MARKETPLACE (buy and sell)
// =====================================================
// New tables only: market_listings, market_reports. Prices are in Naira (₦).
// A buyer contacts the seller through Vico Messages; money does not move through the marketplace yet (buyer and seller agree directly).
// One photo per listing (compressed by the page to under ~300 KB) is kept in the database and served from /api/market/listings/:id/image.
// Safety: 3 different people reporting a listing hides it until an admin looks (admin-community.html); admins can remove or restore any listing.
// =====================================================
const CATEGORIES = ["Electronics", "Fashion", "Home & Living", "Beauty", "Sports", "Health", "Books", "Food & Beverage", "Vehicles", "Services", "Other"];
const DAY = 86400000, KEEP_DAYS = 60;   // a product stays in the Marketplace for 2 months per payment ($2 renews it, see vico-ads.js)
const PHONE_RE = /^\+?[0-9 ]{7,16}$/;
// Nigerian numbers: 0803... -> 234803..., + and spaces removed (wa.me wants digits only)
function waNumber(n) { let d = String(n || "").replace(/[^0-9]/g, ""); if (/^0\d{10}$/.test(d)) d = "234" + d.slice(1); return d; }
function discountPct(price, old) { price = Number(price); old = Number(old); return old > price && price > 0 ? Math.round((1 - price / old) * 100) : 0; }
// badge on a product card, from what is really recorded (no invented ratings or sales)
function badgeOf(x, now) {
  if (x.discount >= 50) return "Hot Deal"; if (x.sales >= 5) return "Best Seller"; if (x.rcount >= 3 && x.ravg >= 4.5) return "Top Rated";
  return (now || Date.now()) - x.createdAt < 14 * DAY ? "New Arrival" : "";
}
// "other types of the same product": same category, the ones sharing the most title words first
function rankSimilar(base, list, max) {
  const words = (t) => new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const bw = words(base.title);
  return list.filter((x) => x.id !== base.id && x.category === base.category)
    .map((x) => { let n = 0; words(x.title).forEach((w) => { if (bw.has(w)) n++; }); return { x, n }; })
    .sort((a, b) => b.n - a.n || b.x.id - a.x.id).slice(0, max || 12).map((r) => r.x);
}
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const BLOCKED = /\b(counterfeit|fake (?:id|passport|certificate)|stolen|firearm|gun|ammunition|cocaine|heroin|weed|marijuana|escort|adult content|investment doubling|guaranteed (?:profit|returns?))\b/i;

function cleanListing(b) {
  b = b || {};
  const title = String(b.title || "").trim(), description = String(b.description || "").trim(), category = String(b.category || "Other");
  const price = Math.round(Number(b.price));
  if (title.length < 3 || title.length > 80) return { error: "Give your item a name (3 to 80 letters)." };
  if (description.length > 1000) return { error: "The description is too long (1,000 letters at most)." };
  if (!Number.isFinite(price) || price < 1 || price > 1000000000) return { error: "Enter the price in Naira." };
  if (!CATEGORIES.includes(category)) return { error: "Choose a category." };
  if (BLOCKED.test(title + " " + description)) return { error: "This item is not allowed on Vico Marketplace (see the advertising and community rules)." };
  const image = b.image ? String(b.image) : "";
  if (image && (image.length > 420000 || !IMG_RE.test(image))) return { error: "The photo must be a JPG, PNG or WebP picture under about 300 KB." };
  const oldPrice = b.oldPrice ? Math.round(Number(b.oldPrice)) : 0;
  if (oldPrice && !(oldPrice > price && oldPrice <= 1000000000)) return { error: "The old price must be higher than the new price." };
  const saleMode = b.saleMode === "direct" ? "direct" : "vico", contactMode = b.contactMode === "phone" ? "phone" : "whatsapp", contactNumber = String(b.contactNumber || "").trim();
  if (saleMode === "direct" && !PHONE_RE.test(contactNumber)) return { error: "Enter the phone or WhatsApp number buyers should use." };
  return { value: { title, description, category, price, oldPrice, saleMode, contactMode, contactNumber: saleMode === "direct" ? contactNumber : "", callEnabled: b.callEnabled !== false, location: String(b.location || "").trim().slice(0, 60), image } };
}

module.exports = function makeMarket({ app, db, requireAuth, requireAdmin, store }) {
  const { publicHandle, displayNameOf, avatarUrl, users } = store;
  const now = () => Date.now();
  const bad = (res, code, msg) => res.status(code).json({ success: false, message: msg });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS market_listings (id BIGSERIAL PRIMARY KEY, seller TEXT NOT NULL, title TEXT NOT NULL, description TEXT, price_ngn BIGINT NOT NULL, category TEXT NOT NULL, location TEXT, image TEXT, status TEXT NOT NULL DEFAULT 'active', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_market_status ON market_listings(status, category, id DESC)`, `CREATE INDEX IF NOT EXISTS idx_market_seller ON market_listings(seller)`,
    `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS old_price_ngn BIGINT`, `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS keep_until BIGINT`, `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS keep_notified BIGINT`,
    `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS sale_mode TEXT NOT NULL DEFAULT 'vico'`, `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS contact_mode TEXT`, `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS contact_number TEXT`, `ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS call_enabled SMALLINT NOT NULL DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS market_images (id BIGSERIAL PRIMARY KEY, listing_id BIGINT NOT NULL, data TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`, `CREATE INDEX IF NOT EXISTS idx_market_images_l ON market_images(listing_id, pos)`,
    `CREATE TABLE IF NOT EXISTS market_reviews (listing_id BIGINT NOT NULL, reviewer TEXT NOT NULL, stars SMALLINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (listing_id, reviewer))`,
    `CREATE TABLE IF NOT EXISTS market_reports (id BIGSERIAL PRIMARY KEY, listing_id BIGINT NOT NULL, reporter TEXT NOT NULL, reason TEXT, created_at BIGINT NOT NULL, UNIQUE (listing_id, reporter))`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727280)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727280)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("MARKET MIGRATE ERROR:", e); });

  const COLS = `id, seller, title, description, price_ngn AS "priceNgn", old_price_ngn AS "oldPrice", category, location, status, sale_mode AS "saleMode", contact_mode AS "contactMode", call_enabled AS "callEnabled", keep_until AS "keepUntil", created_at AS "createdAt", (image IS NOT NULL AND image <> '') AS "hasImage",
    (SELECT COUNT(*) FROM market_reviews rv WHERE rv.listing_id = market_listings.id) AS rcount, (SELECT COALESCE(AVG(stars),0) FROM market_reviews rv WHERE rv.listing_id = market_listings.id) AS ravg,
    (SELECT COUNT(*) FROM market_orders mo WHERE mo.listing_id = market_listings.id AND mo.status IN ('paid','shipped','completed')) AS sales`;
  const VISIBLE = "status = 'active' AND (keep_until IS NULL OR keep_until > ?)";
  const shape = (r, withSeller, owner) => {
    const price = Number(r.priceNgn), old = r.oldPrice ? Number(r.oldPrice) : 0, discount = discountPct(price, old), keep = r.keepUntil ? Number(r.keepUntil) : null;
    const x = { id: Number(r.id), title: r.title, description: r.description || "", price, oldPrice: discount ? old : 0, discount, category: r.category, location: r.location || "", status: r.status, saleMode: r.saleMode || "vico", contactMode: r.contactMode || "", callEnabled: r.callEnabled !== 0,
      createdAt: Number(r.createdAt), imageUrl: r.hasImage ? "/api/market/listings/" + r.id + "/image" : "", rating: { avg: Math.round(Number(r.ravg) * 10) / 10, count: Number(r.rcount) }, sales: Number(r.sales) };
    x.badge = badgeOf({ discount, sales: x.sales, rcount: x.rating.count, ravg: x.rating.avg, createdAt: x.createdAt }, now());
    if (owner) { x.keepUntil = keep; x.expired = !!(keep && keep <= now()); x.daysLeft = keep ? Math.max(0, Math.ceil((keep - now()) / DAY)) : null; }
    if (withSeller) x.seller = { handle: publicHandle(r.seller), displayName: displayNameOf(r.seller), avatar: avatarUrl(r.seller) };
    return x;
  };
  app.get("/api/market/categories", (req, res) => res.json({ success: true, categories: CATEGORIES }));

  app.get("/api/market/listings", async (req, res) => {
    try { await ready;
      const q = String(req.query.q || "").trim().slice(0, 60), cats = String(req.query.category || "").split(",").filter((c) => CATEGORIES.includes(c)), one = Math.floor(Number(req.query.id));
      const where = [VISIBLE], p = [now()];
      if (Number.isFinite(one) && one > 0) { where.push("id = ?"); p.push(one); }
      if (cats.length) { where.push("category IN (" + cats.map(() => "?").join(",") + ")"); p.push(...cats); }
      if (q) { where.push("(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)"); p.push("%" + q.toLowerCase() + "%", "%" + q.toLowerCase() + "%"); }
      const order = req.query.sort === "price_asc" ? "price_ngn ASC, id DESC" : req.query.sort === "price_desc" ? "price_ngn DESC, id DESC" : "id DESC";
      const rows = await db.all(`SELECT ${COLS} FROM market_listings WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 60`, p);
      await users.warm(rows.map((r) => r.seller));
      res.json({ success: true, listings: rows.map((r) => shape(r, true)) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load the marketplace."); }
  });

  // ONE product page: big pictures, the video if there is one, then (separate call) other types of the same product
  app.get("/api/market/listings/:id", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const r = Number.isFinite(id) && await db.get(`SELECT ${COLS} FROM market_listings WHERE id = ? AND (status = 'sold' OR (${VISIBLE}))`, [id, now()]);
      if (!r) return bad(res, 404, "This item is no longer available.");
      await users.warm([r.seller]);
      const imgs = await db.all("SELECT id FROM market_images WHERE listing_id = ? ORDER BY pos, id LIMIT 8", [id]);
      let video = null; try { const v = await db.get("SELECT id FROM videos WHERE listing_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [id]); if (v) video = { id: Number(v.id), url: "/api/videos/" + v.id + "/stream", thumb: "/api/videos/" + v.id + "/thumb" }; } catch (_) { /* videos not ready */ }
      const l = shape(r, true); const pics = (l.imageUrl ? [l.imageUrl] : []).concat(imgs.map((i) => "/api/market/images/" + i.id));
      res.json({ success: true, listing: l, pictures: pics, video });
    } catch (e) { console.error(e); bad(res, 500, "Could not load this item."); }
  });
  app.get("/api/market/listings/:id/related", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const base = Number.isFinite(id) && await db.get("SELECT id, title, category FROM market_listings WHERE id = ?", [id]); if (!base) return res.json({ success: true, listings: [] });
      const rows = await db.all(`SELECT ${COLS} FROM market_listings WHERE ${VISIBLE} AND category = ? AND id <> ? ORDER BY id DESC LIMIT 80`, [now(), base.category, id]);
      const top = rankSimilar({ id: Number(base.id), title: base.title, category: base.category }, rows.map((r) => ({ ...r, id: Number(r.id) })), 12);
      await users.warm(top.map((r) => r.seller));
      res.json({ success: true, listings: top.map((r) => shape(r, true)) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load similar items."); }
  });
  app.get("/api/market/images/:id", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const r = Number.isFinite(id) && await db.get("SELECT i.data FROM market_images i JOIN market_listings l ON l.id = i.listing_id WHERE i.id = ? AND l.status IN ('active','sold')", [id]);
      const m = r && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.data); if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); }
  });
  // the owner adds up to 4 more pictures (one per request, so each stays small)
  app.post("/api/market/listings/:id/images", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), img = String((req.body && req.body.image) || "");
      const l = Number.isFinite(id) && await db.get("SELECT id FROM market_listings WHERE id = ? AND seller = ? AND status <> 'removed'", [id, req.userEmail]); if (!l) return bad(res, 404, "Item not found.");
      if (img.length > 420000 || !IMG_RE.test(img)) return bad(res, 400, "The picture must be a JPG, PNG or WebP under about 300 KB.");
      const n = await db.get("SELECT COUNT(*) AS n FROM market_images WHERE listing_id = ?", [id]); if (Number(n.n) >= 4) return bad(res, 400, "You can add 4 extra pictures.");
      const r = await db.get("INSERT INTO market_images (listing_id, data, pos, created_at) VALUES (?,?,?,?) RETURNING id", [id, img, Number(n.n), now()]); res.json({ success: true, id: Number(r.id) });
    } catch (e) { bad(res, 500, "Could not save the picture."); } });
  app.post("/api/market/images/:id/delete", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      await db.run("DELETE FROM market_images WHERE id = ? AND listing_id IN (SELECT id FROM market_listings WHERE seller = ?)", [id, req.userEmail]); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not remove the picture."); } });
  // direct deals: the seller's phone / WhatsApp is shown only to a signed-in buyer (not to scrapers)
  app.post("/api/market/listings/:id/contact", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const l = Number.isFinite(id) && await db.get(`SELECT title, price_ngn AS price, sale_mode AS mode, contact_mode AS cm, contact_number AS num FROM market_listings WHERE id = ? AND ${VISIBLE}`, [id, now()]);
      if (!l || l.mode !== "direct" || !l.num) return bad(res, 404, "This seller deals through Vico checkout.");
      const msg = "Hello, I am interested in “" + l.title + "” on Vico Pay Marketplace.";
      res.json({ success: true, mode: l.cm, number: l.num, link: l.cm === "phone" ? "tel:+" + waNumber(l.num) : "https://wa.me/" + waNumber(l.num) + "?text=" + encodeURIComponent(msg) });
    } catch (e) { bad(res, 500, "Could not get the seller's contact."); } });
  // only someone who really bought and received it can rate it
  app.post("/api/market/listings/:id/review", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), stars = Math.floor(Number(req.body && req.body.stars));
      if (!(stars >= 1 && stars <= 5)) return bad(res, 400, "Choose 1 to 5 stars.");
      const o = Number.isFinite(id) && await db.get("SELECT 1 AS x FROM market_orders WHERE listing_id = ? AND buyer = ? AND status = 'completed'", [id, req.userEmail]); if (!o) return bad(res, 403, "You can rate an item after you have received it.");
      await db.run("INSERT INTO market_reviews (listing_id, reviewer, stars, created_at) VALUES (?,?,?,?) ON CONFLICT (listing_id, reviewer) DO UPDATE SET stars = EXCLUDED.stars", [id, req.userEmail, stars, now()]); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not save your rating."); } });

  app.get("/api/market/listings/:id/image", async (req, res) => {
    try { await ready;
      const id = Math.floor(Number(req.params.id));
      const r = Number.isFinite(id) && await db.get("SELECT image FROM market_listings WHERE id = ? AND status IN ('active','sold')", [id]);
      const m = r && r.image && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.image);
      if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); }
  });

  app.get("/api/market/mine", requireAuth, async (req, res) => {
    try { await ready;
      const q = String(req.query.q || "").trim().toLowerCase().slice(0, 60);
      const rows = await db.all(`SELECT ${COLS} FROM market_listings WHERE seller = ? AND status <> 'removed'${q ? " AND (LOWER(title) LIKE ? OR LOWER(category) LIKE ?)" : ""} ORDER BY id DESC LIMIT 100`, q ? [req.userEmail, "%" + q + "%", "%" + q + "%"] : [req.userEmail]);
      res.json({ success: true, listings: rows.map((r) => shape(r, false, true)) });
    } catch (e) { bad(res, 500, "Could not load your items."); }
  });

  app.post("/api/market/listings", requireAuth, async (req, res) => {
    try { await ready;
      const c = cleanListing(req.body); if (c.error) return bad(res, 400, c.error);
      const n = await db.get("SELECT COUNT(*) AS n FROM market_listings WHERE seller = ? AND status = 'active'", [req.userEmail]);
      if (Number(n.n) >= 20) return bad(res, 400, "You can have 20 active items. Mark some as sold or remove them first.");
      const v = c.value, t = now();
      const r = await db.get("INSERT INTO market_listings (seller, title, description, price_ngn, old_price_ngn, category, location, image, sale_mode, contact_mode, contact_number, call_enabled, status, keep_until, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?) RETURNING id",
        [req.userEmail, v.title, v.description, v.price, v.oldPrice || null, v.category, v.location, v.image || null, v.saleMode, v.contactMode, v.contactNumber, v.callEnabled ? 1 : 0, t + KEEP_DAYS * DAY, t, t]);
      res.json({ success: true, id: Number(r.id) });
    } catch (e) { console.error(e); bad(res, 500, "Could not post your item."); }
  });

  // the owner can mark an item sold, put it back on sale, or remove it
  app.post("/api/market/listings/:id/status", requireAuth, async (req, res) => {
    try { await ready;
      const id = Math.floor(Number(req.params.id)), st = String((req.body && req.body.status) || "");
      if (!["active", "sold", "removed"].includes(st)) return bad(res, 400, "Choose active, sold or removed.");
      const cur = Number.isFinite(id) && await db.get("SELECT status FROM market_listings WHERE id = ? AND seller = ?", [id, req.userEmail]);
      if (!cur) return bad(res, 404, "Item not found.");
      if (cur.status === "hidden") return bad(res, 403, "This item is under review by Vico.");
      if (cur.status === "removed") return bad(res, 404, "Item not found.");
      await db.run("UPDATE market_listings SET status = ?, updated_at = ? WHERE id = ? AND seller = ?", [st, now(), id, req.userEmail]);
      res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not update your item."); }
  });

  app.post("/api/market/listings/:id/report", requireAuth, async (req, res) => {
    try { await ready;
      const id = Math.floor(Number(req.params.id));
      const l = Number.isFinite(id) && await db.get("SELECT id, seller FROM market_listings WHERE id = ? AND status = 'active'", [id]);
      if (!l) return bad(res, 404, "Item not found.");
      if (l.seller === req.userEmail) return bad(res, 400, "You cannot report your own item.");
      await db.run("INSERT INTO market_reports (listing_id, reporter, reason, created_at) VALUES (?,?,?,?) ON CONFLICT (listing_id, reporter) DO NOTHING", [id, req.userEmail, String((req.body && req.body.reason) || "").slice(0, 200), now()]);
      const c = await db.get("SELECT COUNT(*) AS n FROM market_reports WHERE listing_id = ?", [id]);
      if (Number(c.n) >= 3) await db.run("UPDATE market_listings SET status = 'hidden', updated_at = ? WHERE id = ? AND status = 'active'", [now(), id]);
      res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not send your report."); }
  });

  // ---- admin ----
  app.get("/api/admin/market/listings", requireAdmin, async (req, res) => {
    try { await ready;
      const st = ["active", "hidden", "sold", "removed"].includes(req.query.status) ? req.query.status : "hidden";
      const rows = await db.all(`SELECT ${COLS}, (SELECT COUNT(*) FROM market_reports r WHERE r.listing_id = market_listings.id) AS reports FROM market_listings WHERE status = ? ORDER BY id DESC LIMIT 100`, [st]);
      res.json({ success: true, listings: rows.map((r) => ({ ...shape(r, false), seller: r.seller, reports: Number(r.reports) })) });
    } catch (e) { bad(res, 500, "Could not load listings."); }
  });
  app.post("/api/admin/market/listings/:id/action", requireAdmin, async (req, res) => {
    try { await ready;
      const id = Math.floor(Number(req.params.id)), a = String((req.body && req.body.action) || "");
      if (!["remove", "restore"].includes(a)) return bad(res, 400, "Choose remove or restore.");
      await db.run("UPDATE market_listings SET status = ?, updated_at = ? WHERE id = ?", [a === "remove" ? "removed" : "active", now(), id]);
      if (a === "restore") await db.run("DELETE FROM market_reports WHERE listing_id = ?", [id]);
      res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not update that item."); }
  });
  return { ready };
};
module.exports.cleanListing = cleanListing;
module.exports.CATEGORIES = CATEGORIES; module.exports.waNumber = waNumber; module.exports.rankSimilar = rankSimilar; module.exports.badgeOf = badgeOf; module.exports.discountPct = discountPct; module.exports.KEEP_DAYS = KEEP_DAYS;
