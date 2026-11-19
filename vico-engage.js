// =====================================================
// Vico Pay Live — VICO ENGAGE (Follow / Like / Save / ⋯ for short videos and product pictures, plus Product Live)
// =====================================================
// * Save: a signed-in person saves a video or a product to their own list (GET /api/saved). Download: the full video / picture file.
// * "Visit website": the advertiser's own https link (from the ad, else the advertiser's website). Only https links are ever returned.
// * Product Live: a seller goes live with one of THEIR registered Marketplace products pinned for viewers. It uses the SAME LiveKit
//   account and the SAME /api/live/create as the normal Go Live (no second LiveKit key). An approved ID check is needed
//   (turn that off with ID_REQUIRED_FOR_PRODUCT_LIVE=false in .env).
// New tables only: product_likes, saved_items.
// =====================================================
const idApproval = require("./id-approval");
const KINDS = ["video", "product"];
function safeLink(url) {   // https only, a real public website
  let u; try { u = new URL(String(url || "").trim()); } catch (_) { return ""; }
  if (u.protocol !== "https:" || !u.hostname.includes(".")) return "";
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) return "";
  return u.toString().slice(0, 300);
}
const cleanKind = (k) => (KINDS.includes(k) ? k : "");
const fileName = (title, ext) => (String(title || "vico").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "vico") + "." + ext;

module.exports = function makeEngage({ app, db, requireAuth, requireAdmin, getAuthEmail, store, liveRooms }) {
  const { publicHandle, displayNameOf, avatarUrl, users } = store;
  const now = () => Date.now();
  const bad = (res, code, msg, extra) => res.status(code).json({ success: false, message: msg, ...(extra || {}) });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS product_likes (listing_id BIGINT NOT NULL, user_email TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (listing_id, user_email))`,
    `CREATE TABLE IF NOT EXISTS saved_items (user_email TEXT NOT NULL, kind TEXT NOT NULL, item_id BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_email, kind, item_id))`,
    `CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_items(user_email, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS video_reports (video_id BIGINT NOT NULL, reporter TEXT NOT NULL, reason TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (video_id, reporter))`,
    `CREATE TABLE IF NOT EXISTS product_views (listing_id BIGINT NOT NULL, viewer_email TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (listing_id, viewer_email))`,
    `CREATE TABLE IF NOT EXISTS product_reviews (id BIGSERIAL PRIMARY KEY, listing_id BIGINT NOT NULL, reviewer_email TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at BIGINT NOT NULL, UNIQUE (listing_id, reviewer_email))`,
    `CREATE INDEX IF NOT EXISTS idx_product_reviews_listing ON product_reviews(listing_id, status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS trusted_business_status (owner_email TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'not_eligible', notified_at BIGINT, reviewed_at BIGINT, reviewed_by TEXT, admin_note TEXT)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727291)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727291)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("ENGAGE MIGRATE ERROR:", e); });

  // who owns it, and the advertiser's own website link (ad link first, then the advertiser's website)
  async function itemOf(kind, id) {
    if (kind === "video") {
      const v = await db.get("SELECT id, owner, title, ad_campaign_id AS ad, listing_id AS lid FROM videos WHERE id = ? AND status = 'active'", [id]); if (!v) return null;
      let link = ""; if (v.ad) { const c = await db.get("SELECT link FROM ad_campaigns WHERE id = ?", [v.ad]).catch(() => null); link = safeLink(c && c.link); }
      if (!link && v.ad) { const a = await db.get("SELECT website FROM ad_advertisers WHERE user_email = ?", [v.owner]).catch(() => null); link = safeLink(a && a.website); }
      return { owner: v.owner, title: v.title, website: link };
    }
    const l = await db.get("SELECT id, seller, title FROM market_listings WHERE id = ? AND status IN ('active','sold')", [id]); if (!l) return null;
    let link = "";
    const c = await db.get("SELECT c.link FROM ad_flow f JOIN ad_campaigns c ON c.id = f.campaign_id WHERE f.listing_id = ? ORDER BY c.id DESC LIMIT 1", [id]).catch(() => null); link = safeLink(c && c.link);
    if (!link) { const a = await db.get("SELECT website FROM ad_advertisers WHERE user_email = ?", [l.seller]).catch(() => null); link = safeLink(a && a.website); }
    return { owner: l.seller, title: l.title, website: link };
  }

  app.get("/api/social/state", async (req, res) => {
    try { await ready; const me = getAuthEmail ? getAuthEmail(req) : null, kind = cleanKind(req.query.kind), id = Math.floor(Number(req.query.id));
      if (!kind || !Number.isFinite(id) || id < 1) return bad(res, 400, "Unknown item.");
      const it = await itemOf(kind, id); if (!it) return bad(res, 404, "Not found.");
      await users.warm([it.owner]);
      const f = await db.get("SELECT COUNT(*) AS n FROM follows WHERE host_id = ?", [it.owner]);
      const out = { success: true, website: it.website, mine: !!me && me === it.owner, followers: Number(f.n), following: false, saved: false, liked: false, likes: 0,
        owner: { handle: publicHandle(it.owner), displayName: displayNameOf(it.owner), avatar: avatarUrl(it.owner) } };
      if (kind === "product") { out.likes = Number((await db.get("SELECT COUNT(*) AS n FROM product_likes WHERE listing_id = ?", [id])).n); }
      if (me) {
        out.following = !!(await db.get("SELECT 1 AS x FROM follows WHERE follower_id = ? AND host_id = ?", [me, it.owner]));
        out.saved = !!(await db.get("SELECT 1 AS x FROM saved_items WHERE user_email = ? AND kind = ? AND item_id = ?", [me, kind, id]));
        if (kind === "product") out.liked = !!(await db.get("SELECT 1 AS x FROM product_likes WHERE listing_id = ? AND user_email = ?", [id, me]));
      }
      res.json(out);
    } catch (e) { console.error(e); bad(res, 500, "Could not load."); } });

  app.post("/api/social/like", requireAuth, async (req, res) => {   // products only (videos already have /api/videos/:id/like)
    try { await ready; const id = Math.floor(Number((req.body || {}).id)); const it = Number.isFinite(id) && await itemOf("product", id); if (!it) return bad(res, 404, "Product not found.");
      const del = await db.run("DELETE FROM product_likes WHERE listing_id = ? AND user_email = ?", [id, req.userEmail]);
      if (!del.changes) await db.run("INSERT INTO product_likes (listing_id, user_email, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING", [id, req.userEmail, now()]);
      await checkTrustMilestone(it.owner);
      res.json({ success: true, liked: !del.changes, likes: Number((await db.get("SELECT COUNT(*) AS n FROM product_likes WHERE listing_id = ?", [id])).n) });
    } catch (e) { bad(res, 500, "Could not like this."); } });

  app.post("/api/social/save", requireAuth, async (req, res) => {
    try { await ready; const kind = cleanKind((req.body || {}).kind), id = Math.floor(Number((req.body || {}).id)); const it = kind && Number.isFinite(id) && await itemOf(kind, id); if (!it) return bad(res, 404, "Not found.");
      const del = await db.run("DELETE FROM saved_items WHERE user_email = ? AND kind = ? AND item_id = ?", [req.userEmail, kind, id]);
      if (!del.changes) {
        const n = await db.get("SELECT COUNT(*) AS n FROM saved_items WHERE user_email = ?", [req.userEmail]); if (Number(n.n) >= 500) return bad(res, 400, "Your saved list is full (500). Remove some first.");
        await db.run("INSERT INTO saved_items (user_email, kind, item_id, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", [req.userEmail, kind, id, now()]);
      }
      res.json({ success: true, saved: !del.changes });
    } catch (e) { bad(res, 500, "Could not save."); } });

  app.get("/api/saved", requireAuth, async (req, res) => {
    try { await ready; const kind = cleanKind(req.query.kind);
      const rows = await db.all(`SELECT kind, item_id AS id, created_at AS "at" FROM saved_items WHERE user_email = ? ${kind ? "AND kind = ?" : ""} ORDER BY created_at DESC LIMIT 100`, kind ? [req.userEmail, kind] : [req.userEmail]);
      const out = [];
      for (const r of rows) {
        if (r.kind === "video") { const v = await db.get("SELECT id, title, (thumb IS NOT NULL AND thumb <> '') AS t FROM videos WHERE id = ? AND status = 'active'", [r.id]); if (v) out.push({ kind: "video", id: Number(v.id), title: v.title, thumbUrl: v.t ? "/api/videos/" + v.id + "/thumb" : "", url: "vico-videos.html?v=" + v.id, savedAt: Number(r.at) }); }
        else { const l = await db.get("SELECT id, title, price_ngn AS price, (image IS NOT NULL AND image <> '') AS t FROM market_listings WHERE id = ? AND status IN ('active','sold')", [r.id]); if (l) out.push({ kind: "product", id: Number(l.id), title: l.title, price: Number(l.price), thumbUrl: l.t ? "/api/market/listings/" + l.id + "/image" : "", url: "vico-product.html?id=" + l.id, savedAt: Number(r.at) }); }
      }
      res.json({ success: true, items: out });
    } catch (e) { bad(res, 500, "Could not load your saved list."); } });

  // full video file for "Download" (the player stream only sends it in 1 MB pieces)
  const dl = new Map();
  app.get("/api/videos/:id/download", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), t = now(), k = req.userEmail; if ((dl.get(k) || 0) > t - 4000) return bad(res, 429, "One moment, then try again."); dl.set(k, t); if (dl.size > 5000) dl.clear();
      const v = Number.isFinite(id) && await db.get("SELECT title, mime, data FROM videos WHERE id = ? AND status = 'active' AND data IS NOT NULL", [id]); if (!v) return bad(res, 404, "Video not found.");
      const ext = /quicktime/.test(v.mime || "") ? "mov" : /webm/.test(v.mime || "") ? "webm" : "mp4";
      res.set({ "Content-Type": v.mime || "video/mp4", "Content-Disposition": 'attachment; filename="' + fileName(v.title, ext) + '"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).send(v.data);
    } catch (e) { if (!res.headersSent) bad(res, 500, "Could not download."); } });

  // ---------- REPORT A VIDEO (3 different people hide it until an admin looks, same rule as Marketplace items) ----------
  app.post("/api/videos/:id/report", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id));
      const v = Number.isFinite(id) && await db.get("SELECT id, owner FROM videos WHERE id = ? AND status = 'active'", [id]); if (!v) return bad(res, 404, "Video not found.");
      if (v.owner === req.userEmail) return bad(res, 400, "You cannot report your own video.");
      await db.run("INSERT INTO video_reports (video_id, reporter, reason, created_at) VALUES (?,?,?,?) ON CONFLICT (video_id, reporter) DO UPDATE SET reason = EXCLUDED.reason", [id, req.userEmail, String((req.body || {}).reason || "").slice(0, 300), now()]);
      const c = await db.get("SELECT COUNT(*) AS n FROM video_reports WHERE video_id = ?", [id]);
      if (Number(c.n) >= 3) await db.run("UPDATE videos SET status = 'hidden' WHERE id = ? AND status = 'active'", [id]);
      res.json({ success: true, message: "Thank you. Our team will look at it." });
    } catch (e) { bad(res, 500, "Could not send your report."); } });
  app.get("/api/admin/video-reports", requireAdmin, async (req, res) => {
    try { await ready; const rows = await db.all(`SELECT v.id, v.title, v.owner, v.status, COUNT(r.reporter) AS n, MAX(r.reason) AS reason FROM videos v JOIN video_reports r ON r.video_id = v.id WHERE v.status IN ('active','hidden') GROUP BY v.id ORDER BY (v.status = 'hidden') DESC, n DESC LIMIT 60`);
      res.json({ success: true, videos: rows.map((r) => ({ id: Number(r.id), title: r.title, owner: r.owner, status: r.status, reports: Number(r.n), reason: r.reason || "" })) });
    } catch (e) { bad(res, 500, "Could not load reports."); } });
  app.post("/api/admin/videos/:id/restore", requireAdmin, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); await db.run("UPDATE videos SET status = 'active' WHERE id = ? AND status = 'hidden'", [id]); await db.run("DELETE FROM video_reports WHERE video_id = ?", [id]); res.json({ success: true }); } catch (e) { bad(res, 500, "Could not restore."); } });

  // ---------- VICO PAY HIGH BUSINESS CENTER (company products and national products) ----------
  // Company = the seller paid for Company / Big Business ads, or is a registered company advertiser.  National = paid for National Ads.
  // "verified" = their ID check was approved. Nothing is shown from an unpaid order.
  const PAID = "o.status <> 'pending_payment'";
  const KIND_SQL = {
    company: `(ml.seller IN (SELECT o.user_email FROM ad_job_orders o WHERE o.tier IN ('company','big-business') AND ${PAID}) OR ml.seller IN (SELECT a.user_email FROM ad_advertisers a WHERE a.adv_type = 'Registered company' AND a.status = 'active'))`,
    national: `ml.seller IN (SELECT o.user_email FROM ad_job_orders o WHERE o.tier = 'national' AND ${PAID})`
  };
  app.get("/api/business/products", async (req, res) => {
    try { await ready; const kind = req.query.kind === "national" ? "national" : "company", q = String(req.query.q || "").trim().toLowerCase().slice(0, 60);
      const where = ["ml.status = 'active'", "(ml.keep_until IS NULL OR ml.keep_until > ?)", KIND_SQL[kind]], p = [now()];
      if (q) { where.push("(LOWER(ml.title) LIKE ? OR LOWER(ml.category) LIKE ?)"); p.push("%" + q + "%", "%" + q + "%"); }
      let rows = [];
      try {
        rows = await db.all(`SELECT ml.id, ml.seller, ml.title, ml.description, ml.price_ngn AS price, ml.old_price_ngn AS "oldPrice", ml.category, ml.sale_mode AS "saleMode", (ml.image IS NOT NULL AND ml.image <> '') AS t,
          EXISTS (SELECT 1 FROM ad_job_identity i JOIN ad_job_orders o ON o.id = i.order_id WHERE o.user_email = ml.seller AND i.status = 'approved') OR EXISTS (SELECT 1 FROM ad_identity d WHERE d.user_email = ml.seller AND d.status = 'approved') AS verified,
          (SELECT COUNT(*) FROM follows f WHERE f.host_id = ml.seller) AS followers,
          (SELECT COUNT(*) FROM product_likes pl JOIN market_listings x ON x.id = pl.listing_id WHERE x.seller = ml.seller) AS likes,
          (SELECT COUNT(*) FROM product_views pv JOIN market_listings x ON x.id = pv.listing_id WHERE x.seller = ml.seller) AS views,
          (SELECT COUNT(*) FROM product_reviews pr JOIN market_listings x ON x.id = pr.listing_id WHERE x.seller = ml.seller AND pr.status = 'approved') AS reviews,
          (SELECT COALESCE(AVG(pr.rating),0) FROM product_reviews pr JOIN market_listings x ON x.id = pr.listing_id WHERE x.seller = ml.seller AND pr.status = 'approved') AS rating,
          (SELECT status FROM trusted_business_status tb WHERE tb.owner_email = ml.seller) AS trust_status
          FROM market_listings ml WHERE ${where.join(" AND ")} ORDER BY ml.id DESC LIMIT 60`, p);
      } catch (e) { rows = []; }   // the ad tables do not exist yet on a brand-new database: nothing to show
      await users.warm(rows.map((r) => r.seller));
      for (const owner of [...new Set(rows.map((r) => r.seller))]) { try { await checkTrustMilestone(owner); } catch (_) {} }
      res.json({ success: true, kind, products: rows.map((r) => ({ id: Number(r.id), title: r.title, blurb: String(r.description || "").slice(0, 60), price: Number(r.price), oldPrice: r.oldPrice ? Number(r.oldPrice) : 0, category: r.category, saleMode: r.saleMode || "vico", verified: !!r.verified, trusted: r.trust_status === 'verified', followers: Number(r.followers || 0), likes: Number(r.likes || 0), views: Number(r.views || 0), reviews: Number(r.reviews || 0), rating: Number(r.rating || 0), imageUrl: r.t ? "/api/market/listings/" + r.id + "/image" : "",
        seller: { handle: publicHandle(r.seller), displayName: displayNameOf(r.seller), avatar: avatarUrl(r.seller) } })) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load the Business Center."); } });

  // ---------- BUSINESS PROFILE ENGAGEMENT + TRUST MILESTONES ----------
  async function trustProgress(owner) {
    const row = await db.get(`SELECT (SELECT COUNT(*) FROM follows WHERE host_id = ?) AS followers,
      (SELECT COUNT(*) FROM product_likes pl JOIN market_listings ml ON ml.id = pl.listing_id WHERE ml.seller = ?) AS likes,
      (SELECT COUNT(*) FROM product_views pv JOIN market_listings ml ON ml.id = pv.listing_id WHERE ml.seller = ?) AS views,
      (SELECT COUNT(*) FROM product_reviews pr JOIN market_listings ml ON ml.id = pr.listing_id WHERE ml.seller = ? AND pr.status = 'approved') AS reviews,
      (SELECT COALESCE(AVG(pr.rating),0) FROM product_reviews pr JOIN market_listings ml ON ml.id = pr.listing_id WHERE ml.seller = ? AND pr.status = 'approved') AS rating`, [owner, owner, owner, owner, owner]);
    const followers=Number(row.followers||0), likes=Number(row.likes||0), views=Number(row.views||0), reviews=Number(row.reviews||0), rating=Number(row.rating||0);
    const eligible=followers>=1000 && likes>=1000000 && reviews>=20 && rating>=4;
    return {followers,likes,views,reviews,rating,eligible};
  }
  async function checkTrustMilestone(owner) {
    const progress=await trustProgress(owner);
    if (!progress.eligible) return progress;
    const before=await db.get("SELECT status,notified_at FROM trusted_business_status WHERE owner_email=?",[owner]);
    await db.run(`INSERT INTO trusted_business_status (owner_email,status,notified_at) VALUES (?,'eligible',?) ON CONFLICT (owner_email) DO UPDATE SET status=CASE WHEN trusted_business_status.status='verified' THEN 'verified' ELSE 'eligible' END, notified_at=COALESCE(trusted_business_status.notified_at,EXCLUDED.notified_at)`, [owner,now()]);
    if (!before || !before.notified_at) {
      await db.run("INSERT INTO notifications (user_id,text,link,created_at) VALUES (?,?,?,?)", [owner,"Congratulations! Your business has reached Vico Trusted Business milestones. Your account is now queued for Vico verification review.","vico-trusted-business.html",now()]).catch(()=>{});
    }
    return progress;
  }
  app.post("/api/business/products/:id/view", requireAuth, async (req,res)=>{
    try { await ready; const id=Math.floor(Number(req.params.id)), it=Number.isFinite(id)&&await itemOf('product',id); if(!it)return bad(res,404,"Product not found.");
      await db.run("INSERT INTO product_views (listing_id,viewer_email,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING",[id,req.userEmail,now()]);
      const progress=await checkTrustMilestone(it.owner); res.json({success:true,views:progress.views,progress});
    } catch(e){bad(res,500,"Could not record this view.");}
  });
  app.get("/api/business/products/:id/reviews", async(req,res)=>{
    try { await ready; const id=Math.floor(Number(req.params.id)); const rows=await db.all("SELECT rating,comment,created_at AS \"createdAt\" FROM product_reviews WHERE listing_id=? AND status='approved' ORDER BY created_at DESC LIMIT 30",[id]); res.json({success:true,reviews:rows}); }
    catch(e){bad(res,500,"Could not load reviews.");}
  });
  app.post("/api/business/products/:id/reviews", requireAuth, async(req,res)=>{
    try { await ready; const id=Math.floor(Number(req.params.id)), it=Number.isFinite(id)&&await itemOf('product',id); if(!it)return bad(res,404,"Product not found.");
      if(it.owner===req.userEmail)return bad(res,400,"You cannot review your own business.");
      const purchase=await db.get("SELECT 1 AS x FROM market_orders WHERE listing_id=? AND buyer=? AND status='completed' LIMIT 1",[id,req.userEmail]).catch(()=>null);
      if(!purchase)return bad(res,403,"Only a customer who has completed an order for this product can leave a verified customer review.");
      const rating=Math.floor(Number((req.body||{}).rating)), comment=String((req.body||{}).comment||'').trim().slice(0,1000);
      if(rating<1||rating>5||comment.length<8)return bad(res,400,"Choose a 1–5 star rating and write at least 8 characters.");
      await db.run("INSERT INTO product_reviews (listing_id,reviewer_email,rating,comment,status,created_at) VALUES (?,?,?,?,'pending',?) ON CONFLICT (listing_id,reviewer_email) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment,status='pending',created_at=EXCLUDED.created_at",[id,req.userEmail,rating,comment,now()]);
      res.json({success:true,message:"Your review was submitted for moderation. It will appear after approval."});
    }catch(e){bad(res,500,"Could not submit review.");}
  });
  app.get("/api/business/trust-progress", requireAuth, async(req,res)=>{
    try { await ready; const p=await checkTrustMilestone(req.userEmail), st=await db.get("SELECT status,notified_at,reviewed_at,admin_note FROM trusted_business_status WHERE owner_email=?",[req.userEmail]); res.json({success:true,progress:p,status:st?st.status:'not_eligible',message:p.eligible?"Milestones reached. Your application is ready for Vico review.":"Keep building genuine followers, likes and positive customer reviews."}); }
    catch(e){bad(res,500,"Could not load trust progress.");}
  });
  app.get("/api/admin/business/reviews", requireAdmin, async(req,res)=>{
    try { await ready; const rows=await db.all(`SELECT pr.id,pr.listing_id AS "listingId",pr.rating,pr.comment,pr.status,pr.created_at AS "createdAt",pr.reviewer_email AS "reviewerEmail",ml.title FROM product_reviews pr JOIN market_listings ml ON ml.id=pr.listing_id WHERE pr.status='pending' ORDER BY pr.created_at ASC LIMIT 200`); res.json({success:true,items:rows}); }
    catch(e){bad(res,500,"Could not load pending reviews.");}
  });
  app.post("/api/admin/business/reviews/:id", requireAdmin, async(req,res)=>{
    try { await ready; const id=Math.floor(Number(req.params.id)), status=(req.body||{}).status; if(!['approved','rejected'].includes(status))return bad(res,400,"Choose approved or rejected."); await db.run("UPDATE product_reviews SET status=? WHERE id=?",[status,id]); res.json({success:true}); }
    catch(e){bad(res,500,"Could not moderate review.");}
  });
  app.get("/api/admin/business/trust", requireAdmin, async(req,res)=>{
    try { await ready; const rows=await db.all(`SELECT owner_email AS "ownerEmail",status,notified_at AS "notifiedAt",reviewed_at AS "reviewedAt",admin_note AS "adminNote" FROM trusted_business_status ORDER BY notified_at DESC NULLS LAST LIMIT 200`); res.json({success:true,items:rows}); }
    catch(e){bad(res,500,"Could not load trust applications.");}
  });
  app.post("/api/admin/business/trust/:email/review", requireAdmin, async(req,res)=>{
    try { await ready; const status=(req.body||{}).status, note=String((req.body||{}).note||'').slice(0,1000); if(!['verified','rejected','under_review'].includes(status))return bad(res,400,"Invalid status."); const email=String(req.params.email||'').toLowerCase(); await db.run(`INSERT INTO trusted_business_status(owner_email,status,reviewed_at,reviewed_by,admin_note) VALUES (?,?,?,?,?) ON CONFLICT(owner_email) DO UPDATE SET status=EXCLUDED.status,reviewed_at=EXCLUDED.reviewed_at,reviewed_by=EXCLUDED.reviewed_by,admin_note=EXCLUDED.admin_note`,[email,status,now(),req.adminEmail||'admin',note]); if(status==='verified')await db.run("INSERT INTO notifications(user_id,text,link,created_at) VALUES (?,?,?,?)",[email,"Your business has been verified as a Vico Trusted Business. Congratulations!","vico-trusted-business.html",now()]); res.json({success:true}); }
    catch(e){bad(res,500,"Could not save trust decision.");}
  });

  // ---------- PRODUCT LIVE ----------
  async function idApproved(email) {
    try { if (await db.get("SELECT 1 AS x FROM ad_identity WHERE user_email = ? AND status = 'approved'", [email])) return true; } catch (_) { /* table not there yet */ }
    try { if (await db.get("SELECT 1 AS x FROM ad_job_identity i JOIN ad_job_orders o ON o.id = i.order_id WHERE o.user_email = ? AND i.status = 'approved'", [email])) return true; } catch (_) { /* table not there yet */ }
    return false;
  }
  const productCard = (l) => ({ id: Number(l.id), title: l.title, price: Number(l.price), saleMode: l.saleMode || "vico", imageUrl: l.t ? "/api/market/listings/" + l.id + "/image" : "" });
  async function myProducts(email) {
    return (await db.all(`SELECT id, title, price_ngn AS price, sale_mode AS "saleMode", (image IS NOT NULL AND image <> '') AS t FROM market_listings WHERE seller = ? AND status = 'active' AND (keep_until IS NULL OR keep_until > ?) ORDER BY id DESC LIMIT 60`, [email, now()])).map(productCard);
  }
  // used by /api/live/create: returns { value: productCard } or { error, code }
  async function liveProduct(email, productId) {
    await ready; const id = Math.floor(Number(productId));
    if (!Number.isFinite(id) || id < 1) return { error: "Choose one of your registered products.", code: 400 };
    if (idApproval.requiredForLive() && !(await idApproved(email))) return { error: "Your ID check must be approved before you can sell a product in a live. Finish it in the Ad Center.", code: 403, needId: true };
    const l = await db.get(`SELECT id, title, price_ngn AS price, sale_mode AS "saleMode", (image IS NOT NULL AND image <> '') AS t FROM market_listings WHERE id = ? AND seller = ? AND status = 'active' AND (keep_until IS NULL OR keep_until > ?)`, [id, email, now()]);
    if (!l) return { error: "That product is not one of your active Marketplace products.", code: 404 };
    return { value: productCard(l) };
  }
  app.get("/api/live/product/mine", requireAuth, async (req, res) => {
    try { await ready; const approved = await idApproved(req.userEmail);
      res.json({ success: true, idApproved: approved, idRequired: idApproval.requiredForLive(), canGoLive: approved || !idApproval.requiredForLive(), products: await myProducts(req.userEmail) });
    } catch (e) { bad(res, 500, "Could not load your products."); } });

  return { ready, liveProduct, idApproved };
};
module.exports.safeLink = safeLink; module.exports.cleanKind = cleanKind; module.exports.fileName = fileName;
