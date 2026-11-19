// =====================================================
// Vico Pay Live — VICO VIDEOS (short videos: For You / Following / Trending / Shop, upload, likes, comments)
// =====================================================
// * Videos are stored in PostgreSQL (BYTEA) so a redeploy never loses them, and streamed with Range support so phones can seek.
// * Upload = 2 steps: POST /api/videos (title, thumbnail, ...) then PUT /api/videos/:id/file (the raw video, 30 MB at most).
// * Ad videos (uploaded in the Ad Center) are 'pending_ad' until an admin approves the ad; they show as "Sponsored".
// * An ad video appears in For You / Trending only if its ad chose "Short Videos", and in Shop while the ad is live and its
//   2-month Marketplace period is paid.
// New tables only: videos, video_likes, video_comments.
// =====================================================
const MAX_BYTES = 30 * 1024 * 1024, MAX_SECONDS = 90, DAY = 86400000;
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const TABS = ["foryou", "following", "trending", "shop", "saved"];
const CATEGORIES = ["Shopping", "Business", "Lifestyle", "Entertainment", "Tech", "Earn", "Deals", "Community", "Other"];

// ---- pure rules (tested) ----
function hashtagsOf(text) { const out = []; String(text || "").replace(/#([A-Za-z0-9_]{2,30})/g, (m, t) => { if (!out.includes(t) && out.length < 8) out.push(t); return m; }); return out; }
// the file must really be a video: MP4/MOV ("ftyp" at byte 4) or WebM (EBML header)
function sniffVideo(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf.slice(4, 8).toString("latin1") === "ftyp") return /^qt/.test(buf.slice(8, 10).toString("latin1")) ? "video/quicktime" : "video/mp4";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return "";
}
function cleanMeta(b) {
  b = b || {}; const title = String(b.title || "").trim(), tags = String(b.hashtags || "").trim().slice(0, 200), dur = Math.round(Number(b.durationSec)), thumb = b.thumb ? String(b.thumb) : "";
  const category = CATEGORIES.includes(b.category) ? b.category : "Other";
  if (title.length < 3 || title.length > 80) return { error: "Give your video a title (3 to 80 letters)." };
  if (!(dur >= 1 && dur <= MAX_SECONDS)) return { error: "Videos must be between 1 and " + MAX_SECONDS + " seconds." };
  if (thumb && (thumb.length > 150000 || !THUMB_RE.test(thumb))) return { error: "The cover picture is not valid." };
  if (/\b(counterfeit|firearm|cocaine|heroin|escort|adult content|double your money|guaranteed (?:profit|returns?))\b/i.test(title + " " + tags)) return { error: "This video is not allowed on Vico Videos." };
  return { value: { title, hashtags: tags, durationSec: dur, thumb, category } };
}
// Range header -> bytes (one chunk of at most 1 MB so the database never loads a whole file for a seek)
function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || "")); if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end; if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Number(m[2]); }
  end = Math.min(end, size - 1, start + 1024 * 1024 - 1); if (!(start >= 0 && start <= end)) return { bad: true };
  return { start, end };
}

module.exports = function makeVideos({ app, db, requireAuth, requireAdmin, store, getAuthEmail }) {
  const express = require("express");
  const { publicHandle, displayNameOf, avatarUrl, users } = store;
  const now = () => Date.now();
  const bad = (res, code, msg) => res.status(code).json({ success: false, message: msg });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS videos (id BIGSERIAL PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, hashtags TEXT, category TEXT, duration_s INTEGER NOT NULL, thumb TEXT, mime TEXT, size BIGINT, data BYTEA,
       status TEXT NOT NULL DEFAULT 'uploading', listing_id BIGINT, ad_campaign_id BIGINT, views BIGINT NOT NULL DEFAULT 0, shares BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status, id DESC)`, `CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos(owner)`, `CREATE INDEX IF NOT EXISTS idx_videos_listing ON videos(listing_id)`,
    `CREATE TABLE IF NOT EXISTS video_likes (video_id BIGINT NOT NULL, user_email TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (video_id, user_email))`,
    `CREATE TABLE IF NOT EXISTS video_comments (id BIGSERIAL PRIMARY KEY, video_id BIGINT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL)`, `CREATE INDEX IF NOT EXISTS idx_video_comments_v ON video_comments(video_id, id)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727283)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727283)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("VIDEOS MIGRATE ERROR:", e); });
  const today = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);

  // an ad video is shown only while its ad is live (and its Marketplace period is paid); `place` = the placement it needs
  const adLive = (place) => `(v.ad_campaign_id IS NULL OR EXISTS (SELECT 1 FROM ad_campaigns c LEFT JOIN market_listings l ON l.id = v.listing_id WHERE c.id = v.ad_campaign_id AND c.status = 'active' AND c.placements LIKE '%${place}%' AND c.start_date <= ? AND c.end_date >= ? AND (l.keep_until IS NULL OR l.keep_until > ?)))`;
  const COLS = `v.id, v.owner, v.title, v.hashtags, v.category, v.duration_s AS "durationS", v.views, v.shares, v.listing_id AS "listingId", v.ad_campaign_id AS "adId", v.created_at AS "createdAt",
    (SELECT COUNT(*) FROM video_likes k WHERE k.video_id = v.id) AS likes, (SELECT COUNT(*) FROM video_comments m WHERE m.video_id = v.id) AS comments, (v.thumb IS NOT NULL AND v.thumb <> '') AS "hasThumb"`;

  async function shapeAll(rows, me) {
    await users.warm(rows.map((r) => r.owner));
    const ids = rows.map((r) => Number(r.id)), liked = new Set(), follows = new Set(), lists = {};
    if (me && ids.length) {
      (await db.all(`SELECT video_id AS id FROM video_likes WHERE user_email = ? AND video_id IN (${ids.map(() => "?").join(",")})`, [me].concat(ids))).forEach((r) => liked.add(Number(r.id)));
      (await db.all("SELECT host_id AS h FROM follows WHERE follower_id = ?", [me])).forEach((r) => follows.add(r.h));
    }
    const lids = rows.filter((r) => r.listingId).map((r) => Number(r.listingId));
    if (lids.length) (await db.all(`SELECT id, title, price_ngn AS price, old_price_ngn AS "oldPrice", sale_mode AS "saleMode" FROM market_listings WHERE id IN (${lids.map(() => "?").join(",")}) AND status = 'active'`, lids)).forEach((l) => { lists[Number(l.id)] = { id: Number(l.id), title: l.title, price: Number(l.price), saleMode: l.saleMode }; });
    return rows.map((r) => ({ id: Number(r.id), title: r.title, hashtags: hashtagsOf(r.hashtags), category: r.category || "Other", duration: r.durationS, views: Number(r.views), likes: Number(r.likes), comments: Number(r.comments), shares: Number(r.shares),
      liked: liked.has(Number(r.id)), sponsored: !!r.adId, mine: !!me && r.owner === me, following: follows.has(r.owner), createdAt: Number(r.createdAt),
      creator: { handle: publicHandle(r.owner), displayName: displayNameOf(r.owner), avatar: avatarUrl(r.owner) }, videoUrl: "/api/videos/" + r.id + "/stream", thumbUrl: r.hasThumb ? "/api/videos/" + r.id + "/thumb" : "",
      product: r.listingId ? lists[Number(r.listingId)] || null : null }));
  }

  app.get("/api/videos/categories", (req, res) => res.json({ success: true, categories: CATEGORIES }));

  app.get("/api/videos", async (req, res) => {
    try { await ready; const me = getAuthEmail ? getAuthEmail(req) : null, tab = TABS.includes(req.query.tab) ? req.query.tab : "foryou", cat = String(req.query.category || ""), q = String(req.query.q || "").trim().toLowerCase().slice(0, 60);
      const d = today(), t = now(), where = ["v.status = 'active'"], p = [];
      const one = Math.floor(Number(req.query.id)); if (Number.isFinite(one) && one > 0) { where.push("v.id = ?"); p.push(one); }
      if (tab === "saved") { if (!me) return res.json({ success: true, videos: [], needLogin: true }); where.push("v.id IN (SELECT item_id FROM saved_items WHERE user_email = ? AND kind = 'video')"); p.push(me); }
      if (tab === "shop") where.push("v.listing_id IS NOT NULL");
      where.push(adLive(tab === "shop" || tab === "saved" ? "marketplace" : "short_videos")); p.push(d, d, t);
      if (tab === "following") { if (!me) return res.json({ success: true, videos: [], needLogin: true }); where.push("v.owner IN (SELECT host_id FROM follows WHERE follower_id = ?)"); p.push(me); }
      if (CATEGORIES.includes(cat)) { where.push("v.category = ?"); p.push(cat); }
      if (q) { where.push("(LOWER(v.title) LIKE ? OR LOWER(v.hashtags) LIKE ?)"); p.push("%" + q + "%", "%" + q + "%"); }
      const order = tab === "trending" ? `ORDER BY (v.views + 5 * (SELECT COUNT(*) FROM video_likes k WHERE k.video_id = v.id) + 3 * v.shares) DESC, v.id DESC` : "ORDER BY v.id DESC";
      const rows = await db.all(`SELECT ${COLS} FROM videos v WHERE ${where.join(" AND ")} ${order} LIMIT 40`, p);
      res.json({ success: true, videos: await shapeAll(rows, me) });
    } catch (e) { console.error(e); bad(res, 500, "Could not load videos."); }
  });
  app.get("/api/videos/mine", requireAuth, async (req, res) => {
    try { await ready; const rows = await db.all(`SELECT ${COLS}, v.status FROM videos v WHERE v.owner = ? AND v.status IN ('active','pending_ad') ORDER BY v.id DESC LIMIT 60`, [req.userEmail]);
      res.json({ success: true, videos: await shapeAll(rows, req.userEmail) }); } catch (e) { bad(res, 500, "Could not load your videos."); } });

  // ---- file + cover ----
  const visible = "(status = 'active')";
  app.get("/api/videos/:id/thumb", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); const r = Number.isFinite(id) && await db.get(`SELECT thumb FROM videos WHERE id = ? AND ${visible}`, [id]);
      const m = r && r.thumb && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r.thumb); if (!m) return res.sendStatus(404);
      res.set({ "Content-Type": m[1], "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(m[2], "base64"));
    } catch (e) { res.sendStatus(500); } });
  app.get("/api/videos/:id/stream", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); const v = Number.isFinite(id) && await db.get(`SELECT size, mime FROM videos WHERE id = ? AND ${visible} AND data IS NOT NULL`, [id]); if (!v) return res.sendStatus(404);
      const size = Number(v.size), r = parseRange(req.headers.range, size), h = { "Content-Type": v.mime || "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" };
      if (r && r.bad) return res.status(416).set("Content-Range", "bytes */" + size).end();
      const start = r ? r.start : 0, end = r ? r.end : Math.min(size - 1, 1024 * 1024 - 1);   // no Range header: first MB with 206 so players ask for the rest
      const row = await db.get("SELECT substring(data FROM ? FOR ?) AS part FROM videos WHERE id = ?", [start + 1, end - start + 1, id]);
      res.status(206).set({ ...h, "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": end - start + 1 }).end(row.part);
    } catch (e) { if (!res.headersSent) res.sendStatus(500); } });

  // ---- upload ----
  app.post("/api/videos", requireAuth, async (req, res) => {
    try { await ready; const c = cleanMeta(req.body); if (c.error) return bad(res, 400, c.error);
      const n = await db.get("SELECT COUNT(*) AS n FROM videos WHERE owner = ? AND created_at > ?", [req.userEmail, now() - DAY]); if (Number(n.n) >= 10) return bad(res, 429, "You can upload 10 videos a day.");
      const v = c.value; let listingId = null, adId = null;
      const cid = Math.floor(Number(req.body.campaignId));
      if (Number.isFinite(cid) && cid > 0) {   // an ad video: must be the owner's PAID campaign, tied to its product
        const f = await db.get("SELECT f.listing_id AS lid, f.paid, c.id FROM ad_campaigns c JOIN ad_flow f ON f.campaign_id = c.id WHERE c.id = ? AND c.owner_email = ?", [cid, req.userEmail]);
        if (!f || !Number(f.paid)) return bad(res, 400, "Pay for the ad before uploading its video."); if (!f.lid) return bad(res, 400, "Save your product choices first, then upload the video.");
        listingId = Number(f.lid); adId = cid;
      }
      const r = await db.get("INSERT INTO videos (owner, title, hashtags, category, duration_s, thumb, status, listing_id, ad_campaign_id, created_at) VALUES (?,?,?,?,?,?, 'uploading', ?, ?, ?) RETURNING id", [req.userEmail, v.title, v.hashtags, adId ? "Shopping" : v.category, v.durationSec, v.thumb || null, listingId, adId, now()]);
      res.json({ success: true, id: Number(r.id) });
    } catch (e) { console.error(e); bad(res, 500, "Could not start the upload."); } });
  app.put("/api/videos/:id/file", requireAuth, express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); const v = Number.isFinite(id) && await db.get("SELECT status, ad_campaign_id AS ad, listing_id AS lid FROM videos WHERE id = ? AND owner = ?", [id, req.userEmail]);
      if (!v || v.status !== "uploading") return bad(res, 404, "Upload not found.");
      const buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) return bad(res, 400, "No video received."); const mime = sniffVideo(buf); if (!mime) return bad(res, 400, "That file is not an MP4, MOV or WebM video.");
      if (v.ad) {   // a new ad video replaces the old one
        await db.run("UPDATE videos SET status = 'removed', data = NULL WHERE ad_campaign_id = ? AND id <> ?", [v.ad, id]);
        await db.run("UPDATE videos SET data = ?, mime = ?, size = ?, status = 'pending_ad' WHERE id = ?", [buf, mime, buf.length, id]);
        await db.run("UPDATE ad_flow SET video_id = ? WHERE campaign_id = ?", [id, v.ad]);
      } else await db.run("UPDATE videos SET data = ?, mime = ?, size = ?, status = 'active' WHERE id = ?", [buf, mime, buf.length, id]);
      res.json({ success: true, id });
    } catch (e) { console.error(e); bad(res, e.type === "entity.too.large" ? 413 : 500, e.type === "entity.too.large" ? "That video is too big (30 MB at most)." : "Could not save the video."); } });
  app.post("/api/videos/:id/delete", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); await db.run("UPDATE videos SET status = 'removed', data = NULL WHERE id = ? AND owner = ?", [id, req.userEmail]); res.json({ success: true }); } catch (e) { bad(res, 500, "Could not delete."); } });

  // ---- views, likes, comments, shares ----
  const seen = new Map();
  app.post("/api/videos/:id/view", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), k = (req.ip || "") + ":" + id, t = now(); if ((seen.get(k) || 0) > t - 30000) return res.json({ success: true });
      seen.set(k, t); if (seen.size > 5000) seen.clear(); await db.run(`UPDATE videos SET views = views + 1 WHERE id = ? AND ${visible}`, [id]); res.json({ success: true }); } catch (e) { res.json({ success: true }); } });
  app.post("/api/videos/:id/like", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); const v = Number.isFinite(id) && await db.get(`SELECT id FROM videos WHERE id = ? AND ${visible}`, [id]); if (!v) return bad(res, 404, "Video not found.");
      const del = await db.run("DELETE FROM video_likes WHERE video_id = ? AND user_email = ?", [id, req.userEmail]);
      if (!del.changes) await db.run("INSERT INTO video_likes (video_id, user_email, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING", [id, req.userEmail, now()]);
      const c = await db.get("SELECT COUNT(*) AS n FROM video_likes WHERE video_id = ?", [id]); res.json({ success: true, liked: !del.changes, likes: Number(c.n) });
    } catch (e) { bad(res, 500, "Could not like this video."); } });
  app.get("/api/videos/:id/comments", async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)); const rows = await db.all("SELECT id, author, body, created_at AS \"createdAt\" FROM video_comments WHERE video_id = ? ORDER BY id DESC LIMIT 50", [id]);
      await users.warm(rows.map((r) => r.author)); res.json({ success: true, comments: rows.map((r) => ({ id: Number(r.id), body: r.body, createdAt: Number(r.createdAt), author: { handle: publicHandle(r.author), displayName: displayNameOf(r.author), avatar: avatarUrl(r.author) } })) });
    } catch (e) { bad(res, 500, "Could not load comments."); } });
  app.post("/api/videos/:id/comments", requireAuth, async (req, res) => {
    try { await ready; const id = Math.floor(Number(req.params.id)), body = String((req.body && req.body.body) || "").trim().slice(0, 300); if (body.length < 1) return bad(res, 400, "Write a comment.");
      const v = Number.isFinite(id) && await db.get(`SELECT id FROM videos WHERE id = ? AND ${visible}`, [id]); if (!v) return bad(res, 404, "Video not found.");
      const n = await db.get("SELECT COUNT(*) AS n FROM video_comments WHERE author = ? AND created_at > ?", [req.userEmail, now() - 60000]); if (Number(n.n) >= 8) return bad(res, 429, "Slow down a little.");
      await db.run("INSERT INTO video_comments (video_id, author, body, created_at) VALUES (?,?,?,?)", [id, req.userEmail, body, now()]); res.json({ success: true });
    } catch (e) { bad(res, 500, "Could not post your comment."); } });
  app.post("/api/videos/:id/share", async (req, res) => { try { await ready; await db.run(`UPDATE videos SET shares = shares + 1 WHERE id = ? AND ${visible}`, [Math.floor(Number(req.params.id))]); res.json({ success: true }); } catch (e) { res.json({ success: true }); } });

  // ---- admin ----
  app.post("/api/admin/videos/:id/remove", requireAdmin, async (req, res) => {
    try { await ready; await db.run("UPDATE videos SET status = 'removed', data = NULL WHERE id = ?", [Math.floor(Number(req.params.id))]); res.json({ success: true }); } catch (e) { bad(res, 500, "Could not remove the video."); } });
  return { ready };
};
module.exports.cleanMeta = cleanMeta; module.exports.sniffVideo = sniffVideo; module.exports.parseRange = parseRange; module.exports.hashtagsOf = hashtagsOf; module.exports.MAX_BYTES = MAX_BYTES; module.exports.MAX_SECONDS = MAX_SECONDS;
