// Product livestream recordings: save an actual browser-recorded video file against its Marketplace listing.
const express = require("express");
const MAX_BYTES = 250 * 1024 * 1024;
function sniff(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf.slice(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return "";
}
module.exports = function productLiveRecordings({ app, db, requireAuth, liveRooms }) {
  const ready = (async () => {
    await db.run(`CREATE TABLE IF NOT EXISTS product_live_recordings (
      id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, listing_id BIGINT NOT NULL,
      seller_email TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL,
      size BIGINT NOT NULL, duration_s INTEGER NOT NULL DEFAULT 0, data BYTEA NOT NULL,
      created_at BIGINT NOT NULL)`);
    await db.run("CREATE INDEX IF NOT EXISTS idx_product_live_recordings_listing ON product_live_recordings(listing_id, created_at DESC)");
  })().catch(e => { console.error("PRODUCT LIVE RECORDINGS MIGRATE ERROR:", e); throw e; });

  app.post("/api/product-live-recordings/:roomId", requireAuth,
    express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
      try {
        await ready;
        const roomId = String(req.params.roomId || "").slice(0, 120);
        const room = liveRooms && liveRooms.get(roomId);
        if (!room || String(room.hostId).toLowerCase() !== String(req.userEmail).toLowerCase())
          return res.status(403).json({ success: false, message: "Only the seller who owns this active product live can save its recording." });
        const listingId = Number(room.product && room.product.id);
        if (!Number.isSafeInteger(listingId) || listingId < 1)
          return res.status(400).json({ success: false, message: "This live is not linked to a Marketplace product." });
        const buf = req.body, mime = sniff(buf);
        if (!Buffer.isBuffer(buf) || !mime) return res.status(400).json({ success: false, message: "No valid MP4 or WebM recording file was received." });
        const duration = Math.max(0, Math.min(86400, Math.floor(Number(req.headers["x-recording-duration"]) || 0)));
        const result = await db.get(`INSERT INTO product_live_recordings
          (room_id,listing_id,seller_email,title,mime,size,duration_s,data,created_at)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET
          data=EXCLUDED.data,mime=EXCLUDED.mime,size=EXCLUDED.size,duration_s=EXCLUDED.duration_s
          RETURNING id`,
          [roomId, listingId, req.userEmail, String(room.product.title || room.title || "Product livestream").slice(0,160),
           mime, buf.length, duration, buf, Date.now()]);
        return res.status(201).json({ success: true, recordingId: Number(result.id), listingId,
          message: "Your real livestream video has been saved and linked to this Marketplace product." });
      } catch (e) {
        console.error("PRODUCT LIVE RECORDING SAVE ERROR:", e);
        return res.status(e.type === "entity.too.large" ? 413 : 500).json({
          success: false, message: e.type === "entity.too.large" ? "Recording is larger than 250 MB. Shorten the live or reduce recording quality." : "Could not save the livestream recording."
        });
      }
    });

  app.get("/api/market/listings/:listingId/live-recordings", async (req, res) => {
    try {
      await ready;
      const id = Math.floor(Number(req.params.listingId));
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success:false, recordings:[] });
      const rows = await db.all(`SELECT id,title,mime,size,duration_s AS "durationSec",created_at AS "createdAt"
        FROM product_live_recordings WHERE listing_id=? ORDER BY created_at DESC LIMIT 20`, [id]);
      res.json({ success:true, recordings:rows.map(r => ({...r,id:Number(r.id),size:Number(r.size),durationSec:Number(r.durationSec),createdAt:Number(r.createdAt),url:"/api/product-live-recordings/"+r.id+"/stream"})) });
    } catch (e) { res.status(500).json({ success:false, recordings:[] }); }
  });

  app.get("/api/product-live-recordings/:id/stream", async (req, res) => {
    try {
      await ready;
      const id = Math.floor(Number(req.params.id));
      const row = Number.isSafeInteger(id) && id > 0 ? await db.get("SELECT mime,size,data FROM product_live_recordings WHERE id=?", [id]) : null;
      if (!row) return res.sendStatus(404);
      const size = Number(row.size), range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
      let start = 0, end = size - 1;
      if (range) {
        if (!range[1] && !range[2]) return res.status(416).end();
        if (!range[1]) { start = Math.max(0, size - Number(range[2])); }
        else { start = Number(range[1]); end = range[2] ? Number(range[2]) : end; }
        end = Math.min(end, size - 1);
        if (start < 0 || start > end) return res.status(416).set("Content-Range", "bytes */"+size).end();
      }
      const part = await db.get("SELECT substring(data FROM ? FOR ?) AS part FROM product_live_recordings WHERE id=?", [start+1, end-start+1, id]);
      const headers = {
        "Content-Type":row.mime, "Accept-Ranges":"bytes", "Content-Length":end-start+1,
        "X-Content-Type-Options":"nosniff", "Cache-Control":"public, max-age=3600"
      };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      res.status(range ? 206 : 200).set(headers).end(part.part);
    } catch (e) { if (!res.headersSent) res.sendStatus(500); }
  });
  return { ready };
};
