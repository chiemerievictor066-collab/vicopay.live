// =====================================================
// VicoPay Live — VIP system (Stage 0 foundation + Stage 1 "VIP identity")
// =====================================================
// Added WITHOUT touching existing tables or routes:
//   * every table is CREATE TABLE IF NOT EXISTS (new tables only; no column of an existing table is changed)
//   * VIP is activated once during upgrade; an administrator can still switch it off in /admin-vip.html
//   * every permission is decided here on the server; the pages only display what the server allows
//   * Stage 1 never touches balances, ledger_entries, gift_transactions, host_stats or payouts (it only READS gift_transactions to count earned stars).
//     Stage 2 VIP gifts will be paid through the existing ledger.sendGift, so they behave like normal gifts and pay the host Golden Stars.
// Plugged in from server.js with:   const vip = require("./vip")({ app, db, requireAuth, requireAdmin });
// =====================================================
module.exports = function makeVip({ app, db, requireAuth, requireAdmin, store, giftPrices }) {
  const COINS_PER_STAR = Number(store && store.COINS_PER_STAR) || 2;
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();

  // Tier ladder. rank 0 = ordinary user (no VIP).
  const TIERS = ["none", "silver", "gold", "diamond", "royal", "legend"];
  const rankOf = (t) => Math.max(0, TIERS.indexOf(String(t || "none")));
  const TIER_LABEL = { none: "Member", silver: "Silver", gold: "Gold", diamond: "Diamond", royal: "Royal", legend: "Legend" };

  // equip slot -> where the item lives
  const SLOTS = {
    badge:      { type: "badge" },
    frame:      { type: "frame" },
    background: { type: "decor", kind: "background" },
    name_color: { type: "decor", kind: "name_color" },
    crown:      { type: "decor", kind: "crown" },
    title:      { type: "decor", kind: "title" },
    card:       { type: "decor", kind: "card" }
  };
  const TABLE = { badge: "vip_badges", frame: "vip_frames", decor: "vip_decorations" };
  const EQUIP_COL = { badge: "badge_id", frame: "frame_id", background: "background_id", name_color: "name_color_id", crown: "crown_id", title: "title_id", card: "card_id" };

  // ---------------------------------------------------
  // SCHEMA (new tables only, safe to run on every start)
  // ---------------------------------------------------
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS vip_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS vip_badges (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'silver', icon TEXT, color TEXT, image_url TEXT,
      min_followers BIGINT NOT NULL DEFAULT 0, min_live_hours DOUBLE PRECISION NOT NULL DEFAULT 0, min_stars BIGINT NOT NULL DEFAULT 0,
      auto_unlock SMALLINT NOT NULL DEFAULT 0, admin_only SMALLINT NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0, active SMALLINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vip_frames (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tier_required TEXT NOT NULL DEFAULT 'silver', style TEXT NOT NULL DEFAULT 'silver-shine',
      color1 TEXT, color2 TEXT, image_url TEXT, animated SMALLINT NOT NULL DEFAULT 1, admin_only SMALLINT NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0, active SMALLINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
    // backgrounds, username colours, crowns, titles and identity cards share one table (kind tells them apart)
    `CREATE TABLE IF NOT EXISTS vip_decorations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, tier_required TEXT NOT NULL DEFAULT 'silver', value TEXT NOT NULL,
      admin_only SMALLINT NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, active SMALLINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_vip_decor_kind ON vip_decorations(kind)`,
    // who is VIP by decision of an admin (status 'approved' | 'revoked'; 'revoked' also blocks automatic tiers)
    `CREATE TABLE IF NOT EXISTS vip_eligibility (
      user_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'none', status TEXT NOT NULL DEFAULT 'approved',
      verified_streamer SMALLINT NOT NULL DEFAULT 0, reason TEXT, granted_by TEXT, granted_at BIGINT NOT NULL, expires_at BIGINT)`,
    // items given to one person on purpose (admin gift, achievement reward) even if their tier is lower
    `CREATE TABLE IF NOT EXISTS vip_unlocks (
      user_id TEXT NOT NULL, item_type TEXT NOT NULL, item_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'admin', unlocked_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, item_type, item_id))`,
    `CREATE TABLE IF NOT EXISTS vip_equipped (
      user_id TEXT PRIMARY KEY, badge_id TEXT, frame_id TEXT, background_id TEXT, name_color_id TEXT, crown_id TEXT, title_id TEXT, card_id TEXT,
      updated_at BIGINT NOT NULL DEFAULT 0)`,
    // exclusive gifts: price is in COINS (what the sender pays); naira is only the price list the owner thinks in
    `CREATE TABLE IF NOT EXISTS vip_gifts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, video_slug TEXT NOT NULL, price_ngn BIGINT NOT NULL DEFAULT 0,
      price_coins BIGINT NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, active SMALLINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
    // entrance animations: which videos play, in order, when a VIP of at least min_tier joins a live, and the notice text
    `CREATE TABLE IF NOT EXISTS vip_effects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, min_tier TEXT NOT NULL DEFAULT 'silver', videos TEXT NOT NULL,
      notice TEXT NOT NULL DEFAULT '{name} joined the exclusive room', sort INTEGER NOT NULL DEFAULT 0, active SMALLINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
    // every privilege change is recorded and never edited
    `CREATE TABLE IF NOT EXISTS vip_audit (
      id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_vip_audit_time ON vip_audit(id)`
  ];

  // Starter catalogue. Inserted once by id; admin edits are never overwritten, and "delete" only switches an item off.
  const SEED_BADGES = [
    // id, name, tier, icon, colour, min followers, min live hours, auto unlock
    ["badge-silver", "Silver VIP", "silver", "🥈", "#c0c7d4", 100, 1, 1],
    ["badge-gold", "Gold VIP", "gold", "🥇", "#ffc83d", 1000, 5, 1],
    ["badge-diamond", "Diamond VIP", "diamond", "💎", "#4fd8ff", 5000, 20, 1],
    ["badge-royal", "Royal VIP", "royal", "👑", "#b57bff", 10000, 50, 0],
    ["badge-legend", "Legend VIP", "legend", "🔱", "#ff5a7d", 50000, 100, 0]
  ];
  const SEED_FRAMES = [
    ["frame-silver-shine", "Silver Shine", "silver", "silver-shine", "#e4e9f2", "#9aa6b8"],
    ["frame-gold-pulse", "Gold Pulse", "gold", "gold-pulse", "#ffe27a", "#e0a100"],
    ["frame-diamond-spin", "Diamond Spin", "diamond", "diamond-spin", "#8be9ff", "#3a7bff"],
    ["frame-royal-flame", "Royal Flame", "royal", "royal-flame", "#d9a7ff", "#7b2ff7"],
    ["frame-legend-aurora", "Legend Aurora", "legend", "legend-aurora", "#ff5a7d", "#ffc83d"],
    ["frame-rose-glow", "Rose Glow", "gold", "rose-glow", "#ff9ccc", "#ff4fa3"]
  ];
  const SEED_DECOR = [
    // id, kind, name, tier, value
    ["nc-silver", "name_color", "Silver name", "silver", "#cfd6e4"],
    ["nc-gold", "name_color", "Gold name", "gold", "gradient:#ffe27a,#e0a100"],
    ["nc-diamond", "name_color", "Diamond name", "diamond", "gradient:#8be9ff,#3a7bff"],
    ["nc-royal", "name_color", "Royal name", "royal", "gradient:#e0b8ff,#7b2ff7"],
    ["nc-legend", "name_color", "Legend name", "legend", "gradient:#ff5a7d,#ffc83d"],
    ["bg-midnight", "background", "Midnight Gold", "silver", "gradient:#0b1330,#2b1d05"],
    ["bg-ocean", "background", "Diamond Ocean", "diamond", "gradient:#032a5e,#0aa2d8"],
    ["bg-royal", "background", "Royal Velvet", "royal", "gradient:#2a0a52,#7b2ff7"],
    ["bg-legend", "background", "Legend Sunset", "legend", "gradient:#7a0f3a,#ff9a3c"],
    ["crown-gold", "crown", "Gold crown", "gold", "👑"],
    ["crown-diamond", "crown", "Diamond crown", "diamond", "💎"],
    ["crown-royal", "crown", "Royal crown", "royal", "🏆"],
    ["title-rising", "title", "Rising Star", "silver", "Rising Star"],
    ["title-elite", "title", "Elite Creator", "gold", "Elite Creator"],
    ["title-star", "title", "Diamond Star", "diamond", "Diamond Star"],
    ["title-royalty", "title", "Royalty", "royal", "Royalty"],
    ["title-legend", "title", "Living Legend", "legend", "Living Legend"],
    ["card-silver", "card", "Silver identity card", "silver", "silver"],
    ["card-gold", "card", "Gold identity card", "gold", "gold"],
    ["card-diamond", "card", "Diamond identity card", "diamond", "diamond"],
    ["card-royal", "card", "Royal identity card", "royal", "royal"],
    ["card-legend", "card", "Legend identity card", "legend", "legend"]
  ];

  // id, name, video slug (files gift-<slug>.mp4 / .jpg), price in naira. 1 coin = NGN 10 (the buy-coins rate: NGN 100 = 10 coins).
  // Golden Galaxy has no price yet, so it stays OFF until an admin prices it.
  const SEED_GIFTS = [
    ["vg-diamond-butterfly", "Diamond Butterfly", "vip-diamond-butterfly", 500],
    ["vg-golden-rose", "Golden Rose", "vip-golden-rose", 2500],
    ["vg-diamond-heart", "Diamond Heart", "vip-diamond-heart", 5000],
    ["vg-diamond-crown", "Diamond Crown", "vip-diamond-crown", 7500],
    ["vg-royal-throne", "Royal Throne", "vip-royal-throne", 10000],
    ["vg-luxury-car", "Luxury Car", "vip-luxury-car", 15000],
    ["vg-golden-lion", "Golden Lion", "vip-golden-lion", 25000],
    ["vg-royal-dragon", "Royal Dragon", "vip-royal-dragon", 50000],
    ["vg-golden-palace", "Golden Palace", "vip-golden-palace", 75000],
    ["vg-royal-airplane", "Royal Airplane", "vip-royal-airplane", 100000],
    ["vg-luxury-yacht", "Luxury Yacht", "vip-luxury-yacht", 150000],
    ["vg-golden-galaxy", "Golden Galaxy", "vip-golden-galaxy", 0]
  ];

  // videos are files gift-<name>.mp4 in the site folder; they play in the listed order (car first, then crown)
  const SEED_EFFECTS = [["fx-vip-entrance", "VIP entrance (car, then crown)", "silver", "vip-entrance-car,vip-entrance-crown"]];

  async function migrate() {
    const client = await db.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(727275)");   // different lock number from db.js, so start-ups never block each other
      for (const sql of SCHEMA) await client.query(sql);
      // Earned tiers also need 6000 lifetime Golden Stars. Added to the (new) VIP table only, once; later admin edits are never overwritten.
      const hasStars = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'vip_badges' AND column_name = 'min_stars'");
      if (!hasStars.rowCount) {
        await client.query("ALTER TABLE vip_badges ADD COLUMN min_stars BIGINT NOT NULL DEFAULT 0");
        await client.query("UPDATE vip_badges SET min_stars = 6000 WHERE id IN ('badge-silver','badge-gold','badge-diamond')");
      }
      const ts = now();
      let i = 0;
      for (const b of SEED_BADGES) {
        await client.query(
          "INSERT INTO vip_badges (id, name, tier, icon, color, min_followers, min_live_hours, min_stars, auto_unlock, admin_only, sort, active, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12) ON CONFLICT (id) DO NOTHING",
          [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7] ? 6000 : 0, b[7], 0, ++i, ts]);
      }
      i = 0;
      for (const f of SEED_FRAMES) {
        await client.query(
          "INSERT INTO vip_frames (id, name, tier_required, style, color1, color2, animated, admin_only, sort, active, created_at) VALUES ($1,$2,$3,$4,$5,$6,1,0,$7,1,$8) ON CONFLICT (id) DO NOTHING",
          [f[0], f[1], f[2], f[3], f[4], f[5], ++i, ts]);
      }
      i = 0;
      for (const d of SEED_DECOR) {
        await client.query(
          "INSERT INTO vip_decorations (id, kind, name, tier_required, value, admin_only, sort, active, created_at) VALUES ($1,$2,$3,$4,$5,0,$6,1,$7) ON CONFLICT (id) DO NOTHING",
          [d[0], d[1], d[2], d[3], d[4], ++i, ts]);
      }
      i = 0;
      for (const g of SEED_GIFTS) {
        await client.query(
          "INSERT INTO vip_gifts (id, name, video_slug, price_ngn, price_coins, sort, active, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
          [g[0], g[1], g[2], g[3], Math.round(g[3] / 10), ++i, g[3] > 0 ? 1 : 0, ts]);
      }
      i = 0;
      for (const e of SEED_EFFECTS) {
        await client.query(
          "INSERT INTO vip_effects (id, name, min_tier, videos, notice, sort, active, created_at) VALUES ($1,$2,$3,$4,'{name} joined the exclusive room',$5,1,$6) ON CONFLICT (id) DO NOTHING",
          [e[0], e[1], e[2], e[3], ++i, ts]);
      }
      // Activate the already-built VIP feature once during this upgrade. A version marker
      // ensures an administrator can still switch VIP OFF later without the next restart
      // silently turning it back ON.
      await client.query("INSERT INTO vip_settings (key, value, updated_at) VALUES ('enabled','0',$1) ON CONFLICT (key) DO NOTHING", [ts]);
      const activation = await client.query("SELECT value FROM vip_settings WHERE key='activation_version'");
      if (!activation.rowCount) {
        await client.query("UPDATE vip_settings SET value='1', updated_at=$1 WHERE key='enabled'", [ts]);
        await client.query("INSERT INTO vip_settings (key, value, updated_at) VALUES ('activation_version','1',$1) ON CONFLICT (key) DO NOTHING", [ts]);
      }
      await client.query("INSERT INTO vip_settings (key, value, updated_at) VALUES ('max_open_reports','3',$1) ON CONFLICT (key) DO NOTHING", [ts]);
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(727275)"); } catch (_) { /* ignore */ }
      client.release();
    }
    await syncGifts();
  }

  // ---------------------------------------------------
  // VIP GIFTS — sold through the EXISTING gift route (/api/gifts/send), so they use the same safe coin spend, pay the host's
  // Golden Stars, count for rankings and PK battles, and play in the same live-room player. The only thing VIP adds is the price
  // list: while the VIP system is ON, each active gift is added to the server's giftPrices table; while OFF they are removed.
  // ---------------------------------------------------
  const vipGiftNames = new Set();
  async function syncGifts() {
    if (!giftPrices) return;
    const rows = await db.all("SELECT name, price_coins AS coins, active FROM vip_gifts");
    const on = await isEnabled();
    for (const r of rows) {
      vipGiftNames.add(r.name);
      if (on && Number(r.active) && Number(r.coins) > 0) giftPrices[r.name] = Number(r.coins);
      else delete giftPrices[r.name];
    }
  }

  // ---------------------------------------------------
  // small helpers
  // ---------------------------------------------------
  async function setting(key, fallback) {
    const r = await db.get("SELECT value FROM vip_settings WHERE key = ?", [key]);
    return r ? r.value : fallback;
  }
  let enabledCache = { v: false, at: 0 };
  async function isEnabled() {
    if (now() - enabledCache.at < 5000) return enabledCache.v;
    const v = (await setting("enabled", "0")) === "1";
    enabledCache = { v, at: now() };
    return v;
  }
  async function audit(actor, action, target, detail) {
    await db.run("INSERT INTO vip_audit (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)",
      [actor, action, target || null, detail ? String(detail).slice(0, 500) : null, now()]);
  }
  async function resolveUser(key) {
    const k = lc(key);
    if (!k) return null;
    const r = await db.get("SELECT email FROM users WHERE email = ? OR handle = ? OR username = ?", [k, k, k]);
    return r ? lc(r.email) : null;
  }

  // --- values an admin types are later drawn on every viewer's screen, so they are validated strictly ---
  const HEX = /^#[0-9a-fA-F]{3,8}$/;
  const SAFE_URL = /^(https:\/\/|\/)[A-Za-z0-9_\-./%~?=&]{1,300}$/;
  const SAFE_KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;
  function cleanColor(v) { v = String(v || "").trim(); return HEX.test(v) ? v : null; }
  function cleanId(v) { v = lc(v).replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); return SAFE_KEY.test(v) ? v : null; }
  function cleanDecorValue(kind, v) {
    v = String(v || "").trim();
    if (kind === "name_color") {
      if (HEX.test(v)) return v;
      const m = /^gradient:(#[0-9a-fA-F]{3,8}),(#[0-9a-fA-F]{3,8})$/.exec(v);
      return m ? v : null;
    }
    if (kind === "background") {
      if (/^gradient:(#[0-9a-fA-F]{3,8}),(#[0-9a-fA-F]{3,8})$/.test(v)) return v;
      return SAFE_URL.test(v) ? "url:" + v : (v.startsWith("url:") && SAFE_URL.test(v.slice(4)) ? v : null);
    }
    if (kind === "crown") return v && v.length <= 8 && !/[<>"'&]/.test(v) ? v : null;
    if (kind === "title") return v && v.length <= 30 && !/[<>"'&\\]/.test(v) ? v : null;
    if (kind === "card") return TIERS.indexOf(v) > 0 ? v : null;
    return null;
  }
  const cleanTier = (t) => (TIERS.indexOf(lc(t)) >= 0 ? lc(t) : null);

  // ---------------------------------------------------
  // ELIGIBILITY — decided on the server only
  // ---------------------------------------------------
  // effective tier = admin decision, or (automatic, from real records) followers + live hours + good standing.
  // An admin "revoked" decision blocks the automatic route too. Banned accounts are never VIP.
  const tierCache = new Map();   // email -> { at, val }
  const TIER_TTL = 30000;
  const dropCache = (email) => { if (email) tierCache.delete(lc(email)); else tierCache.clear(); };

  async function facts(email) {
    const [f, h, r, b] = await Promise.all([
      db.get("SELECT COUNT(*) AS c FROM follows WHERE host_id = ?", [email]),
      db.get("SELECT COALESCE(SUM(GREATEST(COALESCE(ended_at, last_beat, started_at) - started_at, 0)), 0) AS ms FROM live_sessions WHERE host_id = ?", [email]),
      db.get("SELECT COUNT(*) AS c FROM reports WHERE host_id = ? AND status = 'open'", [email]),
      db.get("SELECT banned FROM user_flags WHERE email = ?", [email])
    ]);
    return { followers: Number(f.c), liveHours: Number(h.ms) / 3600000, openReports: Number(r.c), banned: !!(b && Number(b.banned)) };
  }

  // Lifetime Golden Stars a streamer has really earned: every gift ever received minus coins that only went round in a circle
  // between two accounts (same rule store.starBreakdown uses for payouts). Withdrawing stars does NOT lower it, so cashing out never loses VIP.
  // VIP gifts (Stage 2) are sent through ledger.sendGift, so they are in gift_transactions and count here like any other gift.
  const starsCache = new Map();
  async function lifetimeStars(email) {
    email = lc(email);
    const hit = starsCache.get(email);
    if (hit && now() - hit.at < 60000) return hit.v;
    const pos = await db.get("SELECT COALESCE(SUM(coin), 0) AS v FROM gift_transactions WHERE host_id = ? AND coin > 0", [email]);
    const circ = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN r.amt < s.amt THEN r.amt ELSE s.amt END), 0) AS v
         FROM (SELECT sender_id AS other, SUM(coin) AS amt FROM gift_transactions WHERE host_id = ? GROUP BY sender_id HAVING SUM(coin) > 0) r
         JOIN (SELECT host_id AS other, SUM(coin) AS amt FROM gift_transactions WHERE sender_id = ? GROUP BY host_id HAVING SUM(coin) > 0) s
           ON s.other = r.other`, [email, email]);
    const v = Math.max(0, Math.floor((Number(pos.v) - Number(circ.v)) / COINS_PER_STAR));
    starsCache.set(email, { at: now(), v });
    if (starsCache.size > 5000) starsCache.clear();
    return v;
  }

  async function tierOf(email) {
    email = lc(email);
    const hit = tierCache.get(email);
    if (hit && now() - hit.at < TIER_TTL) return hit.val;

    const [row, badges, maxReports] = await Promise.all([
      db.get("SELECT tier, status, verified_streamer AS verified, expires_at AS \"expiresAt\" FROM vip_eligibility WHERE user_id = ?", [email]),
      db.all("SELECT tier, min_followers AS \"minFollowers\", min_live_hours AS \"minLiveHours\", min_stars AS \"minStars\" FROM vip_badges WHERE active = 1 AND auto_unlock = 1"),
      setting("max_open_reports", "3")
    ]);
    const fx = await facts(email);
    let rank = 0, source = "none";
    const adminActive = row && row.status === "approved" && (!row.expiresAt || Number(row.expiresAt) > now());
    const blocked = row && row.status === "revoked";
    if (!fx.banned && !blocked) {
      if (adminActive) { rank = rankOf(row.tier); source = "admin"; }
      if (fx.openReports < Number(maxReports)) {
        for (const b of badges) {
          const r = rankOf(b.tier);
          if (r > rank && fx.followers >= Number(b.minFollowers) && fx.liveHours >= Number(b.minLiveHours)) {
            // the stars check is the heaviest query, so it only runs for someone who already meets the other two requirements
            if (Number(b.minStars) > 0 && (await lifetimeStars(email)) < Number(b.minStars)) continue;
            rank = r; source = "earned";
          }
        }
      }
    }
    const val = { rank, tier: TIERS[rank], source, verified: !!(row && row.verified && !fx.banned && !blocked), facts: fx };
    tierCache.set(email, { at: now(), val });
    if (tierCache.size > 5000) tierCache.clear();
    return val;
  }

  function itemRank(item) { return rankOf(item.tierRequired || item.tier); }

  // can this person use this item?  (a deliberate unlock always works; otherwise their tier must be high enough)
  function canUse(item, tier, unlockedSet, type) {
    if (!item || !Number(item.active)) return false;
    if (!tier || tier.rank === 0) return false;           // decorations are for people who currently have VIP
    if (unlockedSet.has(type + ":" + item.id)) return true;
    if (Number(item.adminOnly)) return false;
    return tier.rank > 0 && tier.rank >= itemRank(item);
  }

  const COLS = {
    badge: 'id, name, tier, icon, color, image_url AS "imageUrl", min_followers AS "minFollowers", min_live_hours AS "minLiveHours", min_stars AS "minStars", auto_unlock AS "autoUnlock", admin_only AS "adminOnly", sort, active',
    frame: 'id, name, tier_required AS "tierRequired", style, color1, color2, image_url AS "imageUrl", animated, admin_only AS "adminOnly", sort, active',
    decor: 'id, kind, name, tier_required AS "tierRequired", value, admin_only AS "adminOnly", sort, active'
  };
  const loadItems = (type, onlyActive) =>
    db.all("SELECT " + COLS[type] + " FROM " + TABLE[type] + (onlyActive ? " WHERE active = 1" : "") + " ORDER BY sort, id");

  async function unlockSet(email) {
    const rows = await db.all("SELECT item_type AS t, item_id AS i FROM vip_unlocks WHERE user_id = ?", [email]);
    return new Set(rows.map((r) => r.t + ":" + r.i));
  }

  // The equipped items that this person may STILL use (a revoked VIP shows nothing, even if the old row is still stored).
  async function validEquipped(email, tier) {
    const eq = await db.get("SELECT badge_id, frame_id, background_id, name_color_id, crown_id, title_id, card_id FROM vip_equipped WHERE user_id = ?", [email]);
    if (!eq || tier.rank === 0) return {};
    const unl = await unlockSet(email);
    const out = {};
    const [badges, frames, decor] = await Promise.all([loadItems("badge", true), loadItems("frame", true), loadItems("decor", true)]);
    const pick = (list, id, type) => { const it = list.find((x) => x.id === id); return it && canUse(it, tier, unl, type) ? it : null; };
    if (eq.badge_id) out.badge = pick(badges, eq.badge_id, "badge");
    if (eq.frame_id) out.frame = pick(frames, eq.frame_id, "frame");
    for (const slot of ["background", "name_color", "crown", "title", "card"]) {
      const id = eq[EQUIP_COL[slot]];
      if (id) { const it = pick(decor.filter((d) => d.kind === SLOTS[slot].kind), id, "decor"); if (it) out[slot] = it; }
    }
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }

  // public shape: only what is needed to DRAW someone, never an email
  function publicShape(tier, eq) {
    const o = { tier: tier.tier, label: TIER_LABEL[tier.tier], verified: !!tier.verified };
    if (eq.badge) o.badge = { name: eq.badge.name, icon: eq.badge.icon, color: eq.badge.color, imageUrl: eq.badge.imageUrl || null };
    if (eq.frame) o.frame = { style: eq.frame.style, color1: eq.frame.color1, color2: eq.frame.color2, imageUrl: eq.frame.imageUrl || null, animated: !!Number(eq.frame.animated) };
    if (eq.name_color) o.nameColor = eq.name_color.value;
    if (eq.background) o.background = eq.background.value;
    if (eq.crown) o.crown = eq.crown.value;
    if (eq.title) o.title = eq.title.value;
    if (eq.card) o.card = eq.card.value;
    return o;
  }

  // ---------------------------------------------------
  // USER ROUTES
  // ---------------------------------------------------
  const equipHits = new Map();   // simple per-user limiter: 30 changes per minute
  function equipLimited(email) {
    const t = now(), a = (equipHits.get(email) || []).filter((x) => t - x < 60000);
    a.push(t); equipHits.set(email, a);
    if (equipHits.size > 5000) equipHits.clear();
    return a.length > 30;
  }

  app.get("/api/vip/status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, enabled: await isEnabled() });
  });

  // My VIP page: my tier, everything I can/can't equip yet (with the requirement), what is equipped, progress to the next tier
  app.get("/api/vip/me", requireAuth, async (req, res) => {
    const me = req.userEmail;
    if (!(await isEnabled())) return res.json({ success: true, enabled: false });
    const tier = await tierOf(me);
    if (!tier || tier.rank === 0) return res.json({ success: true, enabled: true, eligible: false, tier: "none", promotionUrl: "promotion-duration.html" });
    const [badges, frames, decor, unl] = await Promise.all([loadItems("badge", true), loadItems("frame", true), loadItems("decor", true), unlockSet(me)]);
    const need = (it) => (Number(it.adminOnly) ? "Given by VicoPay" : TIER_LABEL[it.tierRequired || it.tier] + " VIP");
    const mark = (list, type) => list.map((it) => ({ ...it, unlocked: canUse(it, tier, unl, type), requirement: need(it) }));
    const eq = await validEquipped(me, tier);
    const rows = await db.all("SELECT tier, min_followers AS \"minFollowers\", min_live_hours AS \"minLiveHours\", min_stars AS \"minStars\", auto_unlock AS \"autoUnlock\" FROM vip_badges WHERE active = 1 ORDER BY min_followers");
    const myStars = await lifetimeStars(me);
    const next = rows.find((r) => rankOf(r.tier) > tier.rank);
    res.json({
      success: true, enabled: true,
      tier: tier.tier, label: TIER_LABEL[tier.tier], source: tier.source, verified: tier.verified,
      progress: { followers: tier.facts.followers, stars: myStars, liveHours: Math.round(tier.facts.liveHours * 10) / 10,
        next: next ? { tier: next.tier, label: TIER_LABEL[next.tier], minFollowers: Number(next.minFollowers), minLiveHours: Number(next.minLiveHours), minStars: Number(next.minStars), byAdminOnly: !Number(next.autoUnlock) } : null },
      items: { badges: mark(badges, "badge"), frames: mark(frames, "frame"), decorations: mark(decor, "decor") },
      equipped: publicShape(tier, eq),
      equippedIds: Object.fromEntries(Object.entries(eq).map(([k, v]) => [k, v.id]))
    });
  });

  // Equip or remove one decoration. The server re-checks eligibility every time; the page cannot cheat.
  app.post("/api/vip/equip", requireAuth, async (req, res) => {
    const me = req.userEmail;
    if (!(await isEnabled())) return res.status(503).json({ success: false, message: "VIP is not open yet." });
    if (equipLimited(me)) return res.status(429).json({ success: false, message: "Too many changes. Wait a minute." });
    const slot = String((req.body || {}).slot || "");
    const id = (req.body || {}).id === null || (req.body || {}).id === "" ? null : String((req.body || {}).id || "");
    const def = SLOTS[slot];
    if (!def) return res.status(400).json({ success: false, message: "Unknown slot." });
    if (id !== null) {
      const tier = await tierOf(me);
      const it = await db.get("SELECT " + COLS[def.type] + " FROM " + TABLE[def.type] + " WHERE id = ?" + (def.kind ? " AND kind = ?" : ""), def.kind ? [id, def.kind] : [id]);
      if (!it) return res.status(404).json({ success: false, message: "That item does not exist." });
      const unl = await unlockSet(me);
      if (!canUse(it, tier, unl, def.type)) return res.status(403).json({ success: false, message: "You have not unlocked this yet: " + (Number(it.adminOnly) ? "it is given by VicoPay." : "it needs " + TIER_LABEL[it.tierRequired || it.tier] + " VIP.") });
    }
    const col = EQUIP_COL[slot];
    await db.run("INSERT INTO vip_equipped (user_id, " + col + ", updated_at) VALUES (?,?,?) ON CONFLICT (user_id) DO UPDATE SET " + col + " = EXCLUDED." + col + ", updated_at = EXCLUDED.updated_at", [me, id, now()]);
    res.json({ success: true });
  });

  // How other people see someone (live rooms, chat, profiles). Keys are the handles/ids the page already knows.
  // Only people who really have VIP are returned. Never returns emails.
  const pubCache = new Map();    // email -> { at, val }
  app.get("/api/vip/public", async (req, res) => {
    res.set("Cache-Control", "public, max-age=15");
    if (!(await isEnabled())) return res.json({ success: true, enabled: false, users: {} });
    const keys = [...new Set(String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 50);
    const users = {};
    await Promise.all(keys.map(async (k) => {
      try {
        const email = await resolveUser(k);
        if (!email) return;
        let hit = pubCache.get(email);
        if (!hit || now() - hit.at > TIER_TTL) {
          const tier = await tierOf(email);
          const val = tier.rank > 0 ? publicShape(tier, await validEquipped(email, tier)) : null;
          hit = { at: now(), val }; pubCache.set(email, hit);
          if (pubCache.size > 5000) pubCache.clear();
        }
        if (hit.val) users[k] = hit.val;
      } catch (_) { /* one bad key never breaks the rest */ }
    }));
    res.json({ success: true, enabled: true, users });
  });

  // ---------------------------------------------------
  // ADMIN ROUTES  (x-admin-key, like the rest of /admin)
  // ---------------------------------------------------
  const A = "/api/admin/vip";
  const bad = (res, msg, code) => res.status(code || 400).json({ success: false, message: msg });
  const actor = () => "admin";
  const flushPublic = () => { pubCache.clear(); dropCache(); };

  app.get(A + "/settings", requireAdmin, async (req, res) => {
    const c = await Promise.all([
      db.get("SELECT COUNT(*) AS c FROM vip_eligibility WHERE status = 'approved'"),
      db.get("SELECT COUNT(*) AS c FROM vip_equipped")
    ]);
    res.json({ success: true, enabled: (await setting("enabled", "0")) === "1", maxOpenReports: Number(await setting("max_open_reports", "3")), tiers: TIERS.slice(1), approvedVips: Number(c[0].c), usersWithDecorations: Number(c[1].c) });
  });

  app.post(A + "/settings", requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) {
      await db.run("INSERT INTO vip_settings (key, value, updated_at) VALUES ('enabled', ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [b.enabled ? "1" : "0", now()]);
      enabledCache = { v: !!b.enabled, at: now() };
      await audit(actor(), "vip_enabled", null, b.enabled ? "on" : "off");
    }
    if (b.maxOpenReports !== undefined) {
      const n = Math.max(0, Math.min(100, Math.floor(Number(b.maxOpenReports))));
      if (!Number.isFinite(n)) return bad(res, "Reports limit must be a number.");
      await db.run("INSERT INTO vip_settings (key, value, updated_at) VALUES ('max_open_reports', ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [String(n), now()]);
      await audit(actor(), "max_open_reports", null, String(n));
    }
    flushPublic();
    await syncGifts();
    res.json({ success: true });
  });

  app.get(A + "/items/:type", requireAdmin, async (req, res) => {
    const type = req.params.type;
    if (!TABLE[type]) return bad(res, "Unknown type.");
    res.json({ success: true, items: await loadItems(type, false) });
  });

  // create or edit (the id is the key; "delete" = switch off, nothing is ever removed)
  app.post(A + "/items/:type", requireAdmin, async (req, res) => {
    const type = req.params.type, b = req.body || {};
    if (!TABLE[type]) return bad(res, "Unknown type.");
    const id = cleanId(b.id || b.name);
    const name = String(b.name || "").trim().slice(0, 40);
    if (!id || !name || /[<>"]/.test(name)) return bad(res, "A valid id and name are needed.");
    const ts = now();
    const sort = Math.max(0, Math.min(9999, Math.floor(Number(b.sort) || 0)));
    const adminOnly = b.adminOnly ? 1 : 0;
    const active = b.active === false || b.active === 0 ? 0 : 1;
    const url = b.imageUrl ? (SAFE_URL.test(String(b.imageUrl)) ? String(b.imageUrl) : null) : null;
    if (b.imageUrl && !url) return bad(res, "Image address must start with https:// or / and use plain characters.");

    if (type === "badge") {
      const tier = cleanTier(b.tier); if (!tier || tier === "none") return bad(res, "Choose a tier.");
      const color = b.color ? cleanColor(b.color) : null; if (b.color && !color) return bad(res, "Colour must look like #ffc83d.");
      const icon = String(b.icon || "").slice(0, 8); if (/[<>"'&]/.test(icon)) return bad(res, "Bad icon.");
      await db.run(
        `INSERT INTO vip_badges (id, name, tier, icon, color, image_url, min_followers, min_live_hours, min_stars, auto_unlock, admin_only, sort, active, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tier=EXCLUDED.tier, icon=EXCLUDED.icon, color=EXCLUDED.color, image_url=EXCLUDED.image_url,
           min_followers=EXCLUDED.min_followers, min_live_hours=EXCLUDED.min_live_hours, min_stars=EXCLUDED.min_stars, auto_unlock=EXCLUDED.auto_unlock, admin_only=EXCLUDED.admin_only, sort=EXCLUDED.sort, active=EXCLUDED.active`,
        [id, name, tier, icon, color, url, Math.max(0, Math.floor(Number(b.minFollowers) || 0)), Math.max(0, Number(b.minLiveHours) || 0), Math.max(0, Math.floor(Number(b.minStars) || 0)), b.autoUnlock ? 1 : 0, adminOnly, sort, active, ts]);
    } else if (type === "frame") {
      const tier = cleanTier(b.tierRequired); if (!tier || tier === "none") return bad(res, "Choose a tier.");
      const style = lc(b.style || "silver-shine"); if (!SAFE_KEY.test(style)) return bad(res, "Bad style key.");
      const c1 = b.color1 ? cleanColor(b.color1) : null, c2 = b.color2 ? cleanColor(b.color2) : null;
      if ((b.color1 && !c1) || (b.color2 && !c2)) return bad(res, "Colours must look like #ffc83d.");
      await db.run(
        `INSERT INTO vip_frames (id, name, tier_required, style, color1, color2, image_url, animated, admin_only, sort, active, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tier_required=EXCLUDED.tier_required, style=EXCLUDED.style, color1=EXCLUDED.color1, color2=EXCLUDED.color2,
           image_url=EXCLUDED.image_url, animated=EXCLUDED.animated, admin_only=EXCLUDED.admin_only, sort=EXCLUDED.sort, active=EXCLUDED.active`,
        [id, name, tier, style, c1, c2, url, b.animated === false ? 0 : 1, adminOnly, sort, active, ts]);
    } else {
      const kind = String(b.kind || ""); if (!Object.values(SLOTS).some((s) => s.kind === kind)) return bad(res, "Unknown decoration kind.");
      const tier = cleanTier(b.tierRequired); if (!tier || tier === "none") return bad(res, "Choose a tier.");
      const value = cleanDecorValue(kind, b.value); if (!value) return bad(res, "That value is not allowed for " + kind + ".");
      await db.run(
        `INSERT INTO vip_decorations (id, kind, name, tier_required, value, admin_only, sort, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tier_required=EXCLUDED.tier_required, value=EXCLUDED.value, admin_only=EXCLUDED.admin_only, sort=EXCLUDED.sort, active=EXCLUDED.active`,
        [id, kind, name, tier, value, adminOnly, sort, active, ts]);
    }
    await audit(actor(), "item_save", type + ":" + id, name);
    flushPublic();
    res.json({ success: true, id });
  });

  app.post(A + "/items/:type/:id/active", requireAdmin, async (req, res) => {
    const { type, id } = req.params;
    if (!TABLE[type]) return bad(res, "Unknown type.");
    const r = await db.run("UPDATE " + TABLE[type] + " SET active = ? WHERE id = ?", [(req.body || {}).active ? 1 : 0, id]);
    if (!r.changes) return bad(res, "Item not found.", 404);
    await audit(actor(), (req.body || {}).active ? "item_on" : "item_off", type + ":" + id, null);
    flushPublic();
    res.json({ success: true });
  });

  // Who is VIP (admin decisions + people who earned it and have something equipped)
  app.get(A + "/users", requireAdmin, async (req, res) => {
    const q = lc(req.query.q);
    const rows = await db.all(
      `SELECT e.user_id AS email, e.tier, e.status, e.verified_streamer AS verified, e.reason, e.granted_at AS "grantedAt", e.expires_at AS "expiresAt", u.handle, u.display_name AS "displayName"
         FROM vip_eligibility e LEFT JOIN users u ON LOWER(u.email) = e.user_id ORDER BY e.granted_at DESC LIMIT 300`);
    const out = [];
    for (const r of rows) {
      if (q && !(r.email.includes(q) || lc(r.handle).includes(q) || lc(r.displayName).includes(q))) continue;
      const t = await tierOf(r.email);
      out.push({ ...r, effectiveTier: t.tier, source: t.source, followers: t.facts.followers, stars: await lifetimeStars(r.email), liveHours: Math.round(t.facts.liveHours * 10) / 10, openReports: t.facts.openReports });
    }
    res.json({ success: true, users: out });
  });

  // Look up one person before granting (shows what they would get automatically)
  app.get(A + "/lookup", requireAdmin, async (req, res) => {
    const email = await resolveUser(req.query.user);
    if (!email) return bad(res, "No account found.", 404);
    const t = await tierOf(email);
    const row = await db.get("SELECT tier, status, verified_streamer AS verified, reason, expires_at AS \"expiresAt\" FROM vip_eligibility WHERE user_id = ?", [email]);
    res.json({ success: true, email, effectiveTier: t.tier, source: t.source, decision: row || null, facts: { ...t.facts, stars: await lifetimeStars(email) } });
  });

  app.post(A + "/grant", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const email = await resolveUser(b.user);
    if (!email) return bad(res, "No account found for that user.", 404);
    const tier = cleanTier(b.tier);
    if (!tier || tier === "none") return bad(res, "Choose a tier.");
    const days = b.expiresDays ? Math.max(1, Math.min(3650, Math.floor(Number(b.expiresDays)))) : null;
    const reason = String(b.reason || "").slice(0, 200);
    await db.run(
      `INSERT INTO vip_eligibility (user_id, tier, status, verified_streamer, reason, granted_by, granted_at, expires_at) VALUES (?,?,'approved',?,?,?,?,?)
       ON CONFLICT (user_id) DO UPDATE SET tier=EXCLUDED.tier, status='approved', verified_streamer=EXCLUDED.verified_streamer, reason=EXCLUDED.reason, granted_by=EXCLUDED.granted_by, granted_at=EXCLUDED.granted_at, expires_at=EXCLUDED.expires_at`,
      [email, tier, b.verifiedStreamer ? 1 : 0, reason, actor(), now(), days ? now() + days * 86400000 : null]);
    await audit(actor(), "grant", email, tier + (days ? " for " + days + "d" : "") + (reason ? " - " + reason : ""));
    dropCache(email); pubCache.delete(email);
    res.json({ success: true });
  });

  // revoke = the person is not VIP any more AND cannot earn it automatically until an admin grants again
  app.post(A + "/revoke", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const email = await resolveUser(b.user);
    if (!email) return bad(res, "No account found for that user.", 404);
    const reason = String(b.reason || "").slice(0, 200);
    await db.run(
      `INSERT INTO vip_eligibility (user_id, tier, status, verified_streamer, reason, granted_by, granted_at, expires_at) VALUES (?,'none','revoked',0,?,?,?,NULL)
       ON CONFLICT (user_id) DO UPDATE SET tier='none', status='revoked', verified_streamer=0, reason=EXCLUDED.reason, granted_by=EXCLUDED.granted_by, granted_at=EXCLUDED.granted_at, expires_at=NULL`,
      [email, reason, actor(), now()]);
    await audit(actor(), "revoke", email, reason);
    dropCache(email); pubCache.delete(email);
    res.json({ success: true });
  });

  // lift a revoke so the person is treated like everyone again (automatic tiers work again)
  app.post(A + "/reset", requireAdmin, async (req, res) => {
    const email = await resolveUser((req.body || {}).user);
    if (!email) return bad(res, "No account found for that user.", 404);
    await db.run("DELETE FROM vip_eligibility WHERE user_id = ?", [email]);
    await audit(actor(), "reset", email, null);
    dropCache(email); pubCache.delete(email);
    res.json({ success: true });
  });

  app.post(A + "/unlock", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const email = await resolveUser(b.user);
    if (!email) return bad(res, "No account found for that user.", 404);
    const type = String(b.type || "");
    if (!TABLE[type]) return bad(res, "Unknown type.");
    if (!(await db.get("SELECT 1 AS x FROM " + TABLE[type] + " WHERE id = ?", [String(b.id || "")]))) return bad(res, "Item not found.", 404);
    if (b.lock) {
      await db.run("DELETE FROM vip_unlocks WHERE user_id = ? AND item_type = ? AND item_id = ?", [email, type, b.id]);
      await audit(actor(), "lock", email, type + ":" + b.id);
    } else {
      await db.run("INSERT INTO vip_unlocks (user_id, item_type, item_id, source, unlocked_at) VALUES (?,?,?, 'admin', ?) ON CONFLICT DO NOTHING", [email, type, b.id, now()]);
      await audit(actor(), "unlock", email, type + ":" + b.id);
    }
    dropCache(email); pubCache.delete(email);
    res.json({ success: true });
  });

  app.get(A + "/audit", requireAdmin, async (req, res) => {
    res.json({ success: true, rows: await db.all("SELECT id, actor, action, target, detail, created_at AS \"createdAt\" FROM vip_audit ORDER BY id DESC LIMIT 200") });
  });

  // ---------------------------------------------------
  // VIP ENTRANCE — called by features.js when a signed-in viewer opens a live. Pushes ONE "vip_join" event into that room's
  // event list; every viewer's page picks it up on its normal poll and plays it (vip-entrance.js). The browser never decides
  // who is VIP: the event only exists if the server says so.
  // ---------------------------------------------------
  const joinSeen = new Map();   // roomId|email -> last entrance time (same person re-opening within 2 minutes does not replay)
  const roomRate = new Map();   // roomId -> recent entrance times (at most 20 a minute per live, so a flood cannot spam the room)
  let fxCache = { at: 0, rows: [] };
  async function activeEffects() {
    if (now() - fxCache.at < 15000) return fxCache.rows;
    const rows = await db.all("SELECT id, min_tier AS \"minTier\", videos, notice FROM vip_effects WHERE active = 1 ORDER BY sort, id");
    fxCache = { at: now(), rows };
    return rows;
  }
  async function onViewerJoin(room, email, pushEvent) {
    if (!room || !room.roomId || !(await isEnabled())) return;
    email = lc(email);
    if (email === lc(room.hostId)) return;
    const key = room.roomId + "|" + email, t = now();
    if (t - (joinSeen.get(key) || 0) < 120000) return;
    const tier = await tierOf(email);
    if (tier.rank === 0) return;
    let best = null;
    for (const fx of await activeEffects()) {
      const r = rankOf(fx.minTier);
      if (r > 0 && r <= tier.rank && (!best || r >= best.r)) best = { r, fx };
    }
    if (!best) return;
    const recent = (roomRate.get(room.roomId) || []).filter((x) => t - x < 60000);
    if (recent.length >= 20) return;
    recent.push(t); roomRate.set(room.roomId, recent);
    joinSeen.set(key, t);
    if (joinSeen.size > 5000) joinSeen.clear();
    if (roomRate.size > 2000) roomRate.clear();
    const name = String((store && store.displayNameOf ? store.displayNameOf(email) : "") || "A VIP").slice(0, 40);
    const eq = await validEquipped(email, tier);
    pushEvent(room.roomId, {
      type: "vip_join", effect: best.fx.id, name, tier: tier.tier, label: TIER_LABEL[tier.tier],
      videos: String(best.fx.videos).split(",").map((x) => "gift-" + x.trim() + ".mp4"),
      text: String(best.fx.notice || "{name} joined the exclusive room").replace("{name}", name).slice(0, 120),
      vip: publicShape(tier, eq)
    });
  }

  app.get(A + "/effects", requireAdmin, async (req, res) => {
    res.json({ success: true, effects: await db.all("SELECT id, name, min_tier AS \"minTier\", videos, notice, sort, active FROM vip_effects ORDER BY sort, id") });
  });
  app.post(A + "/effects", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const id = cleanId(b.id || b.name), name = String(b.name || "").trim().slice(0, 40);
    if (!id || !name || /[<>"]/.test(name)) return bad(res, "A valid id and name are needed.");
    const tier = cleanTier(b.minTier); if (!tier || tier === "none") return bad(res, "Choose the lowest tier that gets this entrance.");
    const vids = String(b.videos || "").split(",").map((x) => lc(x)).filter(Boolean);
    if (!vids.length || vids.length > 4 || vids.some((x) => !/^vip-[a-z0-9-]{1,40}$/.test(x))) return bad(res, "Videos: 1 to 4 names like vip-entrance-car, separated by commas, in the order they should play.");
    const notice = String(b.notice || "{name} joined the exclusive room").trim();
    if (notice.indexOf("{name}") < 0 || notice.length > 100 || !/^[\p{L}\p{N} {}.,!'’:-]+$/u.test(notice)) return bad(res, "The notice must contain {name} and use only letters, numbers and simple punctuation.");
    await db.run(
      `INSERT INTO vip_effects (id, name, min_tier, videos, notice, sort, active, created_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, min_tier=EXCLUDED.min_tier, videos=EXCLUDED.videos, notice=EXCLUDED.notice, sort=EXCLUDED.sort, active=EXCLUDED.active`,
      [id, name, tier, vids.join(","), notice, Math.max(0, Math.min(9999, Math.floor(Number(b.sort) || 0))), b.active === false ? 0 : 1, now()]);
    await audit(actor(), "effect_save", id, name + " (" + tier + ")" + (b.active === false ? " off" : " on"));
    fxCache = { at: 0, rows: [] };
    res.json({ success: true, id });
  });

  const GIFT_COLS = 'id, name, video_slug AS "videoSlug", price_ngn AS "priceNgn", price_coins AS "priceCoins", sort, active';
  const shapeGift = (g) => ({ id: g.id, name: g.name, priceCoins: Number(g.priceCoins), priceNgn: Number(g.priceNgn), video: "/gift-" + g.videoSlug + ".mp4", image: "/gift-" + g.videoSlug + ".jpg", sort: g.sort });

  // The VIP gift shelf for the gift panel: send one with the normal call  POST /api/gifts/send { gift: <name>, hostId, requestId }
  app.get("/api/vip/gifts", async (req, res) => {
    res.set("Cache-Control", "public, max-age=15");
    if (!(await isEnabled())) return res.json({ success: true, enabled: false, gifts: [] });
    const rows = await db.all("SELECT " + GIFT_COLS + " FROM vip_gifts WHERE active = 1 AND price_coins > 0 ORDER BY price_coins, sort");
    res.json({ success: true, enabled: true, gifts: rows.map(shapeGift) });
  });

  // My VIP gift history: what I sent, and what I received (only my own rows)
  app.get("/api/vip/gifts/history", requireAuth, async (req, res) => {
    const me = req.userEmail;
    if (!vipGiftNames.size) await syncGifts();
    const names = [...vipGiftNames];
    if (!names.length) return res.json({ success: true, sent: [], received: [] });
    const ph = names.map(() => "?").join(",");
    const q = (col) => db.all(
      "SELECT t.id, t.gift, t.coin AS coins, t.created_at AS \"createdAt\", u.handle AS \"otherHandle\", u.display_name AS \"otherName\" FROM gift_transactions t LEFT JOIN users u ON LOWER(u.email) = LOWER(" + (col === "sender_id" ? "t.host_id" : "t.sender_id") + ") WHERE t." + col + " = ? AND t.gift IN (" + ph + ") ORDER BY t.created_at DESC LIMIT 50",
      [me, ...names]);
    res.json({ success: true, sent: await q("sender_id"), received: await q("host_id") });
  });

  app.get(A + "/gifts", requireAdmin, async (req, res) => {
    const rows = await db.all("SELECT " + GIFT_COLS + " FROM vip_gifts ORDER BY sort, id");
    const sums = await db.all("SELECT gift, COUNT(*) AS n, COALESCE(SUM(coin),0) AS coins FROM gift_transactions WHERE gift IN (SELECT name FROM vip_gifts) GROUP BY gift");
    const by = Object.fromEntries(sums.map((x) => [x.gift, { sold: Number(x.n), coins: Number(x.coins) }]));
    res.json({ success: true, gifts: rows.map((g) => ({ ...g, ...(by[g.name] || { sold: 0, coins: 0 }) })) });
  });

  // price / switch on-off / rename. Never deletes (past gift records keep their name). A name can't clash with a normal gift.
  app.post(A + "/gifts", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const id = cleanId(b.id || b.name);
    const name = String(b.name || "").trim().slice(0, 30);
    if (!id || !name || !/^[A-Za-z0-9 ]+$/.test(name)) return bad(res, "Use letters, numbers and spaces for the name.");
    const slug = lc(b.videoSlug || "");
    if (!/^vip-[a-z0-9-]{1,40}$/.test(slug)) return bad(res, "Video name must look like vip-golden-rose (file gift-vip-golden-rose.mp4).");
    const coins = Math.floor(Number(b.priceCoins)), ngn = Math.floor(Number(b.priceNgn) || 0);
    if (!Number.isFinite(coins) || coins < 0 || coins > 1000000) return bad(res, "Coin price must be a whole number from 0 to 1,000,000.");
    const active = b.active && coins > 0 ? 1 : 0;
    const exists = await db.get("SELECT name FROM vip_gifts WHERE id = ?", [id]);
    if (giftPrices && Object.prototype.hasOwnProperty.call(giftPrices, name) && !vipGiftNames.has(name)) return bad(res, "That name is already used by a normal gift.");
    if (exists && exists.name !== name && giftPrices) delete giftPrices[exists.name];
    await db.run(
      `INSERT INTO vip_gifts (id, name, video_slug, price_ngn, price_coins, sort, active, created_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, video_slug=EXCLUDED.video_slug, price_ngn=EXCLUDED.price_ngn, price_coins=EXCLUDED.price_coins, sort=EXCLUDED.sort, active=EXCLUDED.active`,
      [id, name, slug, Math.max(0, ngn), coins, Math.max(0, Math.min(9999, Math.floor(Number(b.sort) || 0))), active, now()]);
    await audit(actor(), "gift_save", id, name + " " + coins + " coins" + (active ? " on" : " off"));
    await syncGifts();
    res.json({ success: true, id, active: !!active });
  });

  return {
    onViewerJoin, syncGifts, migrate, isEnabled, tierOf, lifetimeStars, dropCache, TIERS, rankOf,
    // exposed for later stages (entrance effects, chat, rooms) and for tests
    _test: { clearStars: () => starsCache.clear(), cleanDecorValue, cleanColor, cleanId, canUse, itemRank }
  };
};
