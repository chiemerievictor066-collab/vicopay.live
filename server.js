require("dotenv").config();
const cors = require("cors");
const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { AccessToken } = require("livekit-server-sdk");
const crypto = require("crypto");
const db = require("./db");
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
let commandCenter = null;
let adminControl = null;
let callSystem = null;
let platformMaintenance = { enabled: false, message: "VicoPay is temporarily undergoing maintenance." };

// =====================================================
// LIVEKIT CLOUD CREDENTIALS
// =====================================================
// Get these from your LiveKit Cloud dashboard → Settings → Keys.
// Put the real values in your .env file — NEVER hard-code them here.
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.warn(
    "⚠️  LiveKit is not fully configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET " +
    "to your .env file, or Go-Live.html will not be able to start a real live stream."
  );
}

if (!process.env.PAYSTACK_SECRET_KEY) {
  console.warn(
    "⚠️  PAYSTACK_SECRET_KEY is not set. Coin purchases (buy-coin.html) will not work until it is added to your .env file."
  );
}

const app = express();
// Express 4 does not catch errors thrown inside async handlers. This wrapper sends them to the error handler at the
// bottom of this file instead of crashing or hanging the request.
for (const m of ["get", "post", "put", "patch", "delete", "use"]) {
  const orig = app[m].bind(app);
  app[m] = (...args) => orig(...args.map((h) =>
    typeof h === "function" && h.constructor.name === "AsyncFunction" && h.length < 4
      ? (req, res, next) => h(req, res, next).catch(next) : h));
}
// Behind Render / Railway / Nginx the real visitor IP is in X-Forwarded-For. Needed for rate limits and fraud checks.
app.set("trust proxy", 1);
app.use(cors(process.env.APP_URL && /^https:/.test(process.env.APP_URL) ? { origin: process.env.APP_URL.replace(/\/$/, "") } : undefined));

// Middleware
app.use(express.json({ limit: "7mb", verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));
// Emergency maintenance gate: public API traffic is paused, while health/admin APIs remain reachable.
app.use((req, res, next) => {
  if (!platformMaintenance.enabled || !req.path.startsWith("/api/") || req.path === "/api/health" || req.path.startsWith("/api/admin/")) return next();
  res.setHeader("Retry-After", "300");
  return res.status(503).json({ success: false, maintenance: true, message: platformMaintenance.message });
});

// Serve your Victopay website files straight from this folder (there is no folder called public any more).
// SECURITY: only an allow-list is ever sent to browsers: the .html pages, vico.css and the browser scripts below.
// server.js, db.js, features.js, .env, package.json and every other server file are NEVER exposed.
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
const SITE_DIR = __dirname;
const BROWSER_SCRIPTS = new Set(["auth.js", "vico-ui.js", "vico-next.js", "vico-currency.js", "live-effects.js", "vico-gifts.js", "go-live-studio.js", "forex-lab.js", "vip-ui.js", "vip-entrance.js", "share-menu.js", "gm-nav.js", "vico-shell.js", "vico-buy.js", "vico-social.js", "vico-live-panel.js", "vico-pin.js", "vico-animal-filters.js", "campaigns-ui.js", "campaign-calendar.js", "vico-messages-app.js"]);
// gift videos are ordinary files next to the HTML pages: gift-rose.mp4, gift-lion.mp4 ... (there is NO gifts folder)
const GIFT_VIDEO = /^gift-[a-z0-9-]+\.(mp4|jpg)$/;   // gift videos + their small thumbnails
const VIP_FX_IMG = /^(vipfx-[a-z0-9-]+\.webp|vico-art-[a-z0-9-]+\.jpg|vico-animals\.webp|vico-ai-guide\.gif|vico-promo-(?:hero|vip|celebrate|benefits)\.jpg|vico-bc-(?:hero|shield|support)\.jpg)$/;   // VIP emoji / avatar / sticker / frame pictures used by the live Effects
const ANIMAL_PAGES = new RegExp("^(go-?live[a-z0-9_-]*\\.html|vip-go-?live[a-z0-9_-]*\\.html" + (process.env.ANIMAL_FILTER_PAGES ? "|" + process.env.ANIMAL_FILTER_PAGES.split(",").map((p) => p.trim().replace(/[^a-zA-Z0-9_.-]/g, "").replace(/\./g, "\\.")).filter(Boolean).join("|") : "") + ")$", "i");
const APPRECIATION_ART = new Set(["vico-monthly-appreciation.png", "vico-yearly-appreciation.png"]);
const BRAND_ASSETS = new Set(["favicon.ico", "favicon-32x32.png", "apple-touch-icon.png", "vico-app-icon.png", "vico-app-icon-192.png", "vico-app-icon-512.png", "site.webmanifest"]);
const SITE_FILES = new Set(fs.readdirSync(SITE_DIR).filter((f) => /\.html$/i.test(f) || f === "vico.css" || f === "gm.css" || BROWSER_SCRIPTS.has(f) || GIFT_VIDEO.test(f) || VIP_FX_IMG.test(f) || APPRECIATION_ART.has(f) || BRAND_ASSETS.has(f)));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let name;
  try { name = decodeURIComponent(req.path).replace(/^\/+/, ""); } catch (e) { return next(); }
  if (!name || !SITE_FILES.has(name)) return next();
  // every HTML page gets the left/right "previous / next page" arrows (vico-next.js) added automatically
  if (/\.html$/i.test(name)) {
    return fs.readFile(path.join(SITE_DIR, name), "utf8", (err, html) => {
      if (err) return next();
      // VicoPay brand identity: expose the supplied app logo as the browser favicon,
      // mobile home-screen icon and social/search preview image on every HTML page.
      const brandHead = '<link rel="icon" href="/favicon.ico" sizes="any">' +
        '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">' +
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
        '<link rel="manifest" href="/site.webmanifest">' +
        '<meta name="theme-color" content="#0636d9">' +
        '<meta name="application-name" content="VicoPay Live">' +
        '<meta property="og:site_name" content="VicoPay Live">' +
        '<meta property="og:type" content="website">' +
        '<meta property="og:title" content="VicoPay Live — Live • Watch • Earn">' +
        '<meta property="og:description" content="Go live, watch creators, connect and earn with VicoPay Live.">' +
        '<meta property="og:image" content="https://vicopay.live/vico-app-icon.png">' +
        '<meta property="og:image:width" content="1254">' +
        '<meta property="og:image:height" content="1254">' +
        '<meta name="twitter:card" content="summary">' +
        '<meta name="twitter:title" content="VicoPay Live — Live • Watch • Earn">' +
        '<meta name="twitter:description" content="Go live, watch creators, connect and earn with VicoPay Live.">' +
        '<meta name="twitter:image" content="https://vicopay.live/vico-app-icon.png">';
      if (!/rel=["']icon["']/i.test(html) || html.indexOf("/vico-app-icon.png") === -1) {
        const headMatch = /<head[^>]*>/i.exec(html);
        if (headMatch) html = html.slice(0, headMatch.index + headMatch[0].length) + brandHead + html.slice(headMatch.index + headMatch[0].length);
      }
      if (html.indexOf("vico-next.js") === -1) {
        const tag = (html.indexOf("auth.js") === -1 ? '<script src="auth.js"></script>' : "") + '<script src="vico-next.js"></script>';
        const i = html.lastIndexOf("</body>");
        html = i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
      }
      // Animal face filters: the Go Live page(s) get vico-animal-filters.js added at the very top, so it is ready before the page asks for the camera.
      // (Go-Live.html is also the page VIP hosts use. Any other page can be added with ANIMAL_FILTER_PAGES=page1.html,page2.html in .env.)
      if (ANIMAL_PAGES.test(name) && html.indexOf("vico-animal-filters.js") === -1) {
        const tag = '<script src="vico-animal-filters.js"></script>', h = /<head[^>]*>/i.exec(html);
        html = h ? html.slice(0, h.index + h[0].length) + tag + html.slice(h.index + h[0].length) : tag + html;
      }
      res.type("html").send(html);
    });
  }
  // gift videos: cached, and sendFile supports Range requests so phones can stream them
  if (GIFT_VIDEO.test(name) || VIP_FX_IMG.test(name) || APPRECIATION_ART.has(name)) res.setHeader("Cache-Control", "public, max-age=604800");
  res.sendFile(path.join(SITE_DIR, name), (err) => { if (err && !res.headersSent) next(); });
});
// =====================================================
// PERMANENT STORAGE: PostgreSQL (set DATABASE_URL). See db.js (tables), ledger.js (coins) and store.js (everything else).
// Nothing important is kept in this process's memory, so restarts and redeploys can never lose accounts or coins.
// =====================================================
const ledger = require("./ledger")(db);
const store = require("./store")(db);
const { users, publicHandle, displayNameOf, avatarUrl, bannedUsers } = store;
const getHostStats = store.getHostStats;
const getWallet = store.getWallet;
const getStarBreakdown = store.starBreakdown;
const PAYOUT_HOLD_DAYS = store.PAYOUT_HOLD_DAYS;
const recordSessionStart = (h, r) => store.sessionStart(h, r).catch((e) => console.error("SESSION START ERROR:", e.message));
const recordSessionEnd = (h, r) => store.sessionEnd(h, r).catch((e) => console.error("SESSION END ERROR:", e.message));
// Monthly requirements (the same wording is shown to hosts; the maths is in live-hours.js and is shared with payouts.js):
//   Normal host: 3,000 stars,  live EVERY day for at least 1 hour, and at least 30 live hours in the month. $9.00  per 3,000 stars.
//   VIP host:   12,000 stars,  live EVERY day for at least 1 hour, and at least 30 live hours in the month. $10.80 per 3,000 stars.
// The "every day, at least 1 hour" check is the existing per-day check in the store (it takes the hours-per-day as a number);
// the monthly TOTAL is counted here from live_sessions, in the Nigeria month, with overlapping rooms merged.
const liveHoursLib = require("./live-hours");
// hours on each day of the Nigeria month, from live_sessions. Same maths as the monthly payout (live-hours.js):
// a stream that runs past midnight is split over both days. (todayHours/days show the REAL hours streamed;
// only the first hour of each day is added to the monthly hours, extra hours that day are free.)
async function liveMonthPerDay(hostId) {
  const win = liveHoursLib.currentMonthWindow(Number(process.env.PAYOUT_TZ_OFFSET_MIN || 60));
  const sessions = await db.all(
    "SELECT started_at, ended_at, last_beat FROM live_sessions WHERE host_id = ? AND started_at < ? AND COALESCE(ended_at, last_beat, started_at) > ?",
    [String(hostId || "").trim().toLowerCase(), win.endMs, win.startMs]);
  return { win, perDay: liveHoursLib.liveHoursPerDay(sessions, win) };
}
async function liveHoursThisMonth(hostId) {
  return liveHoursLib.totalHours((await liveMonthPerDay(hostId)).perDay, liveHoursLib.DAILY_CAP_HOURS);
}
// The live requirement is a MINIMUM: at least dailyHours on every day and at least monthlyHours in the month.
// A host can keep streaming as long as they like after the first hour of the day, but only 1 hour per day is added to the monthly hours.
async function getMonthlyLiveStatus(hostId, hostRules) {
  const r = hostRules || { dailyHours: CREATOR_RULES.dailyLiveHours, monthlyHours: CREATOR_RULES.monthlyLiveHours };
  const base = await store.monthlyLiveStatus(hostId, r.dailyHours);            // month label and the shape the pages already use
  const { win, perDay } = await liveMonthPerDay(hostId);
  const days = perDay.map((h, i) => ({ day: i + 1, hours: Number(h.toFixed(2)), complete: h >= r.dailyHours - 1e-9 }));
  const completedDays = days.filter((d) => d.complete).length;
  const today = days[Math.min(win.days - 1, Math.max(0, Math.floor((Date.now() - win.startMs) / liveHoursLib.DAY)))];
  const monthlyHours = liveHoursLib.totalHours(perDay, r.dailyHours);
  const everyDayComplete = completedDays >= win.days, totalHoursComplete = monthlyHours >= r.monthlyHours;
  return Object.assign({}, base, {
    daysInMonth: win.days, completedDays, remainingDays: win.days - completedDays, days,
    dailyRequiredHours: r.dailyHours, todayHours: today.hours, todayComplete: today.complete,
    everyDayComplete, monthlyHours, monthlyHoursRequired: r.monthlyHours, totalHoursComplete,
    monthlyRequirementComplete: everyDayComplete && totalHoursComplete
  });
}

// =====================================================
// CREATOR PAYOUT RULES & ELIGIBILITY
// =====================================================

const CREATOR_RULES = {
  minimumStars: 3000,       // normal host: stars needed; it is also the size of one payout block ($9 / $10.80)
  dailyLiveHours: 1,        // live every day for at least 1 hour
  monthlyLiveHours: 30      // and at least 30 hours in the month
};
const VIP_RULES = { minimumStars: 12000, dailyLiveHours: 1, monthlyLiveHours: 30 };   // VIP: 12,000 stars, every day 1 hour, 30 hours a month

// $9 per every complete 3,000 Golden Stars for a normal host (3,000 -> $9, 6,000 -> $18, 9,000 -> $27 ...),
// $10.80 for a VIP host. Both tables are shown on host-wallet.html.
// VIP hosts are paid $10.80 per 3,000 stars ($3.60 per 1,000: 12,000 -> $43.20 ... 30,000 -> $108.00). Same whole-block rule, counted in cents.
// blockCents defaults to the normal $9.00, so any caller that does not know about VIP behaves exactly as before.
function calculateCreatorPayout(stars, blockCents) {
  if (stars < CREATOR_RULES.minimumStars) return 0;
  return Math.floor(stars / CREATOR_RULES.minimumStars) * (blockCents || 900) / 100;
}
// everything that depends on normal-or-VIP for one host: pay per 3,000-star block, stars needed, and the live-hour rules
async function hostRulesFor(creatorId) {
  const b = await payoutBlockFor(creatorId), v = b.vip ? VIP_RULES : CREATOR_RULES;
  return { vip: b.vip, blockCents: b.blockCents, minStars: v.minimumStars, dailyHours: v.dailyLiveHours, monthlyHours: v.monthlyLiveHours };
}
// the payout block for one host: { vip, blockCents, blockStars }. Falls back to the normal rate if the VIP module is not ready.
async function payoutBlockFor(creatorId) {
  try { if (typeof vip !== "undefined" && vip.payoutBlock) return await vip.payoutBlock(creatorId); } catch (_) { /* normal rate */ }
  return { vip: false, blockCents: 900, blockStars: CREATOR_RULES.minimumStars };
}

async function getCreatorEligibility(creatorId) {
  const wallet = await getWallet(creatorId);
  const breakdown = await getStarBreakdown(creatorId);
  const stars = breakdown.withdrawable;
  const hostRules = await hostRulesFor(creatorId);
  const live = await getMonthlyLiveStatus(creatorId, hostRules);

  const starsComplete = stars >= hostRules.minStars;
  const liveRequirementComplete = live.monthlyRequirementComplete;
  const eligible = starsComplete && liveRequirementComplete;
  // only whole 3,000-star blocks are paid: a VIP with 13,000 or 14,500 stars is paid for 12,000; with 15,000 for 15,000 ...
  const payout = eligible ? calculateCreatorPayout(stars, hostRules.blockCents) : 0;

  return {
    vipPayout: hostRules.vip,
    blockUsd: hostRules.blockCents / 100,
    requirements: { stars: hostRules.minStars, dailyHours: hostRules.dailyHours, monthlyHours: hostRules.monthlyHours },
    stars,
    earnedStars: breakdown.earned,      // all stars the host has, counting live
    onHoldStars: breakdown.onHold,
    holdDays: breakdown.holdDays,
    nextReleaseAt: breakdown.nextReleaseAt,
    breakdown,
    minimumStars: hostRules.minStars,
    starsComplete,
    liveRequirementComplete,
    eligible,
    payout,
    currency: "USD",
    live
  };
}

const WEBSITE_NAME = "VicoPay";

// =====================================================
// REAL ACCOUNTS & AUTHENTICATION
// =====================================================
// Passwords are stored ONLY as salted scrypt hashes. Sessions are
// signed tokens (HMAC-SHA256) that the browser sends as
//   Authorization: Bearer <token>
// Every money-related route below uses these, so nobody can view
// someone else's wallet, spend their coins or withdraw their earnings
// just by typing their email.

const resolveHandle = (h) => users.resolveHandle(h);

let AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET || AUTH_SECRET.length < 24) {
  AUTH_SECRET = crypto.randomBytes(48).toString("hex");
  console.warn(
    "⚠️  AUTH_SECRET is missing or too short (min 24 chars). A temporary one was generated, " +
    "so everyone will be signed out every time the server restarts. Set AUTH_SECRET in your .env file."
  );
}

const ADMIN_KEY = process.env.ADMIN_KEY || "";
if (!ADMIN_KEY) {
  console.warn("⚠️  ADMIN_KEY is not set, so the /api/admin/* routes are disabled.");
}

const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const scryptAsync = (pw, salt) => new Promise((ok, bad) => crypto.scrypt(String(pw), salt, 64, (e, k) => (e ? bad(e) : ok(k))));
async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}
async function verifyPassword(password, user) {
  const candidate = await scryptAsync(password, Buffer.from(user.salt, "hex"));
  const stored = Buffer.from(user.hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
function signToken(email) {
  const payload = Buffer.from(JSON.stringify({
    sub: email,
    exp: Date.now() + TOKEN_LIFETIME_MS
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.sub || !data.exp || data.exp < Date.now()) return null;
    return data.sub;
  } catch (e) {
    return null;
  }
}

// Returns the signed-in email, or null (does not block the request)
function getAuthEmail(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const email = verifyToken(token);
  return email && !bannedUsers.has(email) ? email : null;
}

// Wallet PIN + email OTP (Resend) in front of withdrawals and paid gifts. See wallet-security.js.
// (Registered here, before the money routes below, so its guard runs first.)
const walletSecurity = require("./wallet-security")({ app, db, requireAuth, getAuthEmail });
walletSecurity.guard();

// Blocks the request unless the user is signed in
async function requireAuth(req, res, next) {
  let email = getAuthEmail(req);
  // the token is valid, but the account must still exist (it may have been deleted)
  if (email && !(await users.exists(email))) email = null;
  if (!email) {
    return res.status(401).json({
      success: false,
      status: false,
      message: "Please sign in to continue."
    });
  }
  req.userEmail = email;
  next();
}

// Signed-in users can only act on THEIR OWN account: any email /
// creatorId / senderId / hostId they send is replaced by their real one.
function asSelf(...fields) {
  return async (req, res, next) => {
    await requireAuth(req, res, () => {
      for (const f of fields) {
        if (f.startsWith("query.")) {
          const k = f.slice(6);
          const given = req.query[k];
          if (given && String(given).toLowerCase() !== req.userEmail) {
            return res.status(403).json({ success: false, message: "You can only access your own account." });
          }
          req.query[k] = req.userEmail;
        } else if (f.startsWith("body.")) {
          req.body = req.body || {};
          req.body[f.slice(5)] = req.userEmail;
        } else if (f.startsWith("param.")) {
          const k = f.slice(6);
          // "me" means the signed-in account, so a page never has to guess the right email
          if (String(req.params[k]).toLowerCase() === "me") req.params[k] = req.userEmail;
          if (String(req.params[k]).toLowerCase() !== req.userEmail) {
            return res.status(403).json({ success: false, message: "You can only access your own account." });
          }
        }
      }
      next();
    });
  };
}

// Admin routes need the secret ADMIN_KEY in an "x-admin-key" header
function requireAdmin(req, res, next) {
  const given = String(req.headers["x-admin-key"] || "");
  if (
    !ADMIN_KEY ||
    given.length !== ADMIN_KEY.length ||
    !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_KEY))
  ) {
    return res.status(403).json({ success: false, message: "Admin access denied." });
  }
  next();
}

// Hides most of an email/ID in public leaderboards
function maskId(id) {
  const s = String(id || "");
  const [name, domain] = s.split("@");
  if (!domain) return s.slice(0, 2) + "***";
  return name.slice(0, 2) + "***@" + domain;
}

function maskRanking(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (!(body && Array.isArray(body.ranking))) return original(body);
    (async () => {
      if (req.isHostRanking) {
        // Only REAL registered accounts may appear (no placeholder/unknown "User" rows),
        // hosts who are live right now are added and shown first, then everyone by Golden Stars.
        const liveHostIds = [...liveRooms.values()].map(r => String(r.hostId || "").toLowerCase()).filter(Boolean);
        const candidates = [...new Set([...body.ranking.map(r => String(r.hostId || "").toLowerCase()), ...liveHostIds])].filter(Boolean);
        const real = new Set();
        if (candidates.length) {
          const rows = await db.all("SELECT LOWER(email) AS email FROM users WHERE LOWER(email) IN (" + candidates.map(() => "?").join(",") + ")", candidates);
          rows.forEach(r => real.add(r.email));
        }
        body.ranking = body.ranking.filter(r => real.has(String(r.hostId || "").toLowerCase()));
        const have = new Set(body.ranking.map(r => String(r.hostId).toLowerCase()));
        liveHostIds.forEach(h => {
          if (real.has(h) && !have.has(h)) { have.add(h); body.ranking.push({ hostId: h, goldenStars: 0, gifts: 0, loves: 0, viewers: 0 }); }
        });
        const liveSet = new Set(liveHostIds);
        body.ranking.sort((a, b) =>
          (liveSet.has(String(b.hostId).toLowerCase()) ? 1 : 0) - (liveSet.has(String(a.hostId).toLowerCase()) ? 1 : 0) ||
          Number(b.goldenStars || 0) - Number(a.goldenStars || 0));
      }
      const emails = body.ranking.map(r => String(r.hostId !== undefined ? r.hostId : (r.senderId || "")).toLowerCase());
      await users.warm(emails);
      const uniq = [...new Set(emails)], counts = new Map();
      if (uniq.length) {
        const rows = await db.all('SELECT host_id AS "hostId", COUNT(*) AS c FROM follows WHERE host_id IN (' + uniq.map(() => "?").join(",") + ") GROUP BY host_id", uniq);
        rows.forEach(r => counts.set(r.hostId, Number(r.c)));
      }
      const liveByHost = new Map();
      for (const room of liveRooms.values()) liveByHost.set(String(room.hostId).toLowerCase(), room);
      body.ranking = body.ranking.map((r, i) => {
        const raw = emails[i], live = liveByHost.get(raw) || null;
        return {
          ...r,
          hostId: r.hostId !== undefined ? maskId(r.hostId) : undefined,
          senderId: r.senderId !== undefined ? maskId(r.senderId) : undefined,
          handle: publicHandle(raw),
          displayName: displayNameOf(raw),
          avatar: avatarUrl(raw),
          isLive: !!live,
          roomId: live ? live.roomId : null,
          liveTitle: live ? live.title : null,
          viewers: live ? (live.viewers || 0) : 0,
          followers: counts.get(raw) || 0
        };
      });
      original(body);
    })().catch(e => { console.error("RANKING ERROR:", e); res.status(500).json({ success: false, message: "Could not load the ranking." }); });
    return res;
  };
  next();
}

// Simple brute-force protection for sign-in / sign-up
const authAttempts = new Map();
function authRateLimit(req, res, next) {
  const key = (req.ip || "") + "|" + String((req.body && (req.body.login || req.body.email)) || "").toLowerCase();
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = (authAttempts.get(key) || []).filter(t => now - t < windowMs);
  if (entry.length >= 10) {
    return res.status(429).json({
      success: false,
      message: "Too many attempts. Please wait 15 minutes and try again."
    });
  }
  entry.push(now);
  authAttempts.set(key, entry);
  next();
}

function publicUser(email, u) {
  u = u || users.peek(email) || {};
  return { email, username: u.username || "", displayName: u.displayName || email.split("@")[0] };
}
app.post("/api/auth/register", authRateLimit, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    const username = String((req.body && req.body.username) || "").trim().toLowerCase();
    const displayName = String((req.body && req.body.displayName) || "").trim().slice(0, 40);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }
    if (username && !/^[a-z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ success: false, message: "Username must be 3-20 letters, numbers or underscores." });
    }
    if (await users.get(email)) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }
    if (username && await users.usernameTaken(username)) {
      return res.status(409).json({ success: false, message: "That username is already taken." });
    }
    const { salt, hash } = await hashPassword(password);
    const created = await users.create(email, {
      salt, hash, username,
      displayName: displayName || username || email.split("@")[0],
      createdAt: new Date().toISOString()
    }, req.ip);
    // lost a race with someone registering the same email/username at the same instant
    if (!created) return res.status(409).json({ success: false, message: "That email or username is already taken." });
    // Invite Friends: remember who invited this person (never blocks sign-up; see referrals.js)
    if (typeof referrals !== "undefined" && req.body && req.body.referralCode) {
      await referrals.recordSignup({ invitedEmail: email, code: req.body.referralCode, ip: req.ip });
    }
    return res.json({ success: true, token: signToken(email), user: publicUser(email, created) });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to create account." });
  }
});
app.post("/api/auth/login", authRateLimit, async (req, res) => {
  try {
    if (adminControl) {
      const blocked = await adminControl.isLoginBlocked(req);
      if (blocked) {
        if (commandCenter) await commandCenter.recordLogin({ login: String((req.body && req.body.login) || "").slice(0, 120), ip: req.ip, device: req.headers["user-agent"], success: false });
        return res.status(403).json({ success: false, message: "Sign-in from this network or device has been blocked. Contact VicoPay support." });
      }
    }
    const login = String((req.body && req.body.login) || "").trim().toLowerCase();
    const password = String((req.body && req.body.password) || "");
    if (!login || !password) {
      return res.status(400).json({ success: false, message: "Please enter your email/username and password." });
    }
    const user = await users.byLogin(login);
    // Same message for "no such user" and "wrong password" on purpose
    if (!user || !(await verifyPassword(password, user))) {
      if (commandCenter) await commandCenter.recordLogin({ login, ip: req.ip, device: req.headers["user-agent"], success: false });
      return res.status(401).json({ success: false, message: "Incorrect email/username or password." });
    }
    users.touchIp(user.email, req.ip).catch(() => { });
    if (commandCenter) await commandCenter.recordLogin({ login: user.email, ip: req.ip, device: req.headers["user-agent"], success: true });
    if (bannedUsers.has(user.email)) {
      return res.status(403).json({ success: false, message: "This account has been suspended. Contact support." });
    }
    return res.json({ success: true, token: signToken(user.email), user: publicUser(user.email, user) });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to sign in." });
  }
});
app.get("/api/auth/me", requireAuth, async (req, res) => {
  await users.warm([req.userEmail]);
  res.json({ success: true, user: publicUser(req.userEmail) });
});
app.post("/api/auth/change-password", authRateLimit, requireAuth, async (req, res) => {
  try {
    const currentPassword = String((req.body && req.body.currentPassword) || "");
    const newPassword = String((req.body && req.body.newPassword) || "");
    const user = await users.get(req.userEmail);
    if (!user || !(await verifyPassword(currentPassword, user))) {
      return res.status(401).json({ success: false, message: "Your current password is incorrect." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ success: false, message: "New password must be different from your current password." });
    }
    const { salt, hash } = await hashPassword(newPassword);
    await users.setPassword(req.userEmail, salt, hash);
    return res.json({ success: true, message: "Password changed successfully." });
  } catch (error) {
    console.error("CHANGE PASSWORD ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to change password." });
  }
});
app.post("/api/auth/delete-account", authRateLimit, requireAuth, async (req, res) => {
  try {
    const password = String((req.body && req.body.password) || "");
    const user = await users.get(req.userEmail);
    if (!user || !(await verifyPassword(password, user))) {
      return res.status(401).json({ success: false, message: "Your password is incorrect." });
    }
    // Sign-in access is removed immediately. Coin balances, the ledger, gift history and withdrawal records stay in
    // the database under this email: financial records should not simply vanish, and many countries require keeping them.
    await users.remove(req.userEmail);
    return res.json({ success: true, message: "Your account has been deleted. You have been signed out." });
  } catch (error) {
    console.error("DELETE ACCOUNT ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to delete account." });
  }
});


// Coin packages
const coinPackages = {
  100: 10,
  500: 50,
  1000: 100,
  2500: 250,
  7500: 750,
  10000: 1000,
  20000: 2000,
  50000: 5000,
  100000: 10000,
  120000: 12000,
  150000: 15000,
  200000: 20000,
  300000: 30000,
  500000: 50000
};

// Paystack adds its fee ON TOP of the package price (your account passes the fee to customers), so a customer who buys
// the ₦500,000 package is really charged about ₦502,000. payments.js works out which package a payment was for.
const { packageForPayment, usdPackages, packageForUsdPayment } = require("./payments");

// A customer paid but the amount matches no package. Never ignore it silently: log it and put it in Admin, Reports.
async function logUnmatchedPayment(reference, payment, where) {
  const paid = Number(payment && payment.amount) / 100;
  const sym = String(payment && payment.currency || "NGN").toUpperCase() === "USD" ? "$" : "₦";
  const who = (payment && payment.customer && payment.customer.email) || "unknown";
  const msg = "UNMATCHED PAYMENT " + reference + ": " + who + " paid " + sym + paid + " but that is not a coin package (" + where + "). Check it in Paystack, then open /api/paystack/verify?reference=" + reference + " to retry.";
  console.error(msg);
  try {
    const seen = await db.get("SELECT 1 AS x FROM reports WHERE reporter = 'system' AND reason LIKE ?", ["%" + reference + "%"]);
    if (!seen) await db.run("INSERT INTO reports (reporter, room_id, host_id, reason, created_at) VALUES ('system', NULL, NULL, ?, ?)", [msg.slice(0, 300), Date.now()]);
  } catch (e) { /* logging must never break a payment */ }
}

// ---------- Dollar (USD) coin prices ----------
// A package is still named by its naira price. Its dollar price = naira price / NGN_PER_USD, to the cent.
// Coin dollar prices use COIN_NGN_PER_USD (default 1428.57, so 10 coins = ₦100 = $0.07). Set it in Render to change it. Packages under COIN_MIN_USD dollars (default 1) are only sold in naira.
// To switch dollar payments off, set ENABLE_USD_PAYMENTS=false in Render.
const usdEnabled = () => String(process.env.ENABLE_USD_PAYMENTS || "true").toLowerCase() !== "false";
const coinUsdTable = () => usdEnabled() ? usdPackages(coinPackages, Number(process.env.COIN_NGN_PER_USD || 1428.57), Number(process.env.COIN_MIN_USD || 1)) : {};

// The address the person is on right now: Paystack sends them back here after paying (never to another website).
function siteUrlOf(req) {
  const host = String(req.get("host") || "").trim();
  if (/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return `${req.protocol}://${host}`;
  return String(process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

// The buy-coins page reads its prices here (naira and dollars)
app.get("/api/coin-prices", async (req, res) => {
  const usd = coinUsdTable();
  res.json({
    success: true, currencies: usdEnabled() ? ["NGN", "USD"] : ["NGN"],
    packages: Object.keys(coinPackages).map(Number).sort((a, b) => a - b).map((ngn) => ({ coins: coinPackages[ngn], ngn, usd: usd[ngn] === undefined ? null : usd[ngn] }))
  });
});

// Home page
app.get("/", async (req, res) => {
  res.sendFile(path.join(SITE_DIR, "motivational-page.html"));
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await db.get("SELECT 1 AS ok");
    res.json({ success: true, message: "Victopay server is running", database: "ok", time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ success: false, message: "Database unavailable", database: "down" });
  }
});

// Initialize Paystack payment
app.post("/api/paystack/initialize", asSelf("body.email"), async (req, res) => {
  try {
    const { email, amount, packageAmount } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    const selectedAmount = Number(packageAmount || amount);
    const currency = String(req.body.currency || "NGN").toUpperCase();
    if (currency !== "NGN" && currency !== "USD") {
      return res.status(400).json({ success: false, message: "Choose naira (NGN) or dollars (USD)." });
    }

    if (!selectedAmount || selectedAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid payment amount is required"
      });
    }

    if (!Object.prototype.hasOwnProperty.call(coinPackages, selectedAmount)) {
      return res.status(400).json({ success: false, message: "Please choose one of the coin packages." });
    }
    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!paystackSecretKey) {
      return res.status(500).json({
        success: false,
        message: "PAYSTACK_SECRET_KEY is not configured on the server"
      });
    }

    // What the customer is charged: the naira price, or the dollar price of the same package.
    let chargeAmount = selectedAmount;
    if (currency === "USD") {
      const usdPrice = coinUsdTable()[selectedAmount];
      if (!usdPrice) return res.status(400).json({ success: false, message: "This package is not available in dollars. Please pay in naira or choose a bigger package." });
      chargeAmount = usdPrice;
    }
    // Paystack expects the amount in the currency subunit (kobo for naira, cents for dollars).
    const amountInKobo = Math.round(chargeAmount * 100);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: email,
        amount: amountInKobo,
        currency: currency,

        metadata: {
          website: "Victopay",
          packagePrice: selectedAmount,
          coinPackage: coinPackages[selectedAmount] || 0,
          currency: currency
        },

        callback_url: `${siteUrlOf(req)}/payment-success.html`
      },
      {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.data.status) {
      if (commandCenter) await commandCenter.recordPaymentAttempt({ email, ip: req.ip, amount: chargeAmount, currency, status: "initialize_failed", details: { message: response.data.message || "Paystack rejected initialization" } });
      return res.status(400).json({
        success: false,
        message: response.data.message || "Unable to initialize payment"
      });
    }
    if (commandCenter) await commandCenter.recordPaymentAttempt({ reference: response.data.data.reference, email, ip: req.ip, amount: chargeAmount, currency, status: "initialized" });

    return res.json({
      success: true,
      message: "Payment initialized successfully",
      authorization_url: response.data.data.authorization_url,
      access_code: response.data.data.access_code,
      reference: response.data.data.reference,
      amount: chargeAmount,
      currency: currency,
      coin: coinPackages[selectedAmount] || 0
    });

  } catch (error) {
    console.error(
      "Paystack initialization error:",
      error.response?.data || error.message
    );
    if (commandCenter) await commandCenter.recordPaymentAttempt({ email: req.body?.email, ip: req.ip, amount: req.body?.amount || req.body?.packageAmount, currency: req.body?.currency || "NGN", status: "initialize_failed", details: { message: error.response?.data?.message || error.message } });

    return res.status(500).json({
      success: false,
      message: "Payment initialization failed",
      error: error.response?.data?.message || error.message
    });
  }
});

// Verify Paystack payment
app.get("/api/paystack/verify", async (req, res) => {
  try {
    const reference = req.query.reference;

    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Payment reference is missing."
      });
    }

    const paystackSecretKey =
      process.env.PAYSTACK_SECRET_KEY;

    if (!paystackSecretKey) {
      return res.status(500).json({
        success: false,
        message:
          "PAYSTACK_SECRET_KEY is not configured on the server."
      });
    }

    // Ask Paystack to verify the transaction
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization:
            `Bearer ${paystackSecretKey}`
        }
      }
    );

    const payment = response.data.data;

    // Payment must actually be successful
    if (
      !response.data.status ||
      payment.status !== "success"
    ) {
      if (commandCenter) await commandCenter.recordPaymentAttempt({ reference, email: payment?.customer?.email, ip: req.ip, amount: payment?.amount, currency: payment?.currency, status: "verify_failed", details: { paymentStatus: payment?.status || "unknown" } });
      return res.status(400).json({
        success: false,
        message:
          "Payment was not successful."
      });
    }

    if (vicoWallet && vicoWallet.isWalletPayment(payment)) {   // wallet recharge: credited by the wallet module, never as coins
      const w = await vicoWallet.finalize(reference);
      return res.status(w.ok ? 200 : 400).json({ success: w.ok, wallet: true, coins: 0, message: w.ok ? "Wallet recharged." : w.message });
    }
    if (typeof commerce !== "undefined" && commerce.isCommercePayment(payment)) {
      const r = await commerce.finalize(reference);
      return res.status(r.ok ? 200 : 400).json({ success: r.ok, message: r.ok ? "Payment received." : r.message, commerce: true, coins: 0 });
    }
    // A Forex Academy membership payment is handled by the forex module, never as coins.
    if (forex.isForexPayment(payment)) {
      const f = await forex.activateFromPayment(payment);
      if (!f.ok) return res.status(400).json({ success: false, message: f.message });
      return res.json({ success: true, forex: true, message: "Your Forex Academy membership is active. Open forex.html to start learning.", reference: reference, coins: 0, balance: 0 });
    }

    // Paystack reports what the customer really paid: the package price PLUS Paystack's fee. Find the package.
    const payCurrency = String(payment.currency || "NGN").toUpperCase();
    if (payCurrency !== "NGN" && payCurrency !== "USD") {
      return res.status(400).json({ success: false, message: "Only naira (NGN) and dollar (USD) payments are accepted." });
    }
    const match = payCurrency === "USD" ? packageForUsdPayment(coinPackages, coinUsdTable(), payment) : packageForPayment(coinPackages, payment);
    if (!match) {
      await logUnmatchedPayment(reference, payment, "verify page");
      return res.status(400).json({ success: false, message: "We received your payment, but its amount does not match a coin package. Please contact support and quote this reference: " + reference });
    }
    const amountInNaira = match.price, coin = match.coins;
    // Use the customer's actual Paystack email
    const userId = String(payment.customer?.email || "").toLowerCase();
    if (!userId) {
      return res.status(400).json({ success: false, message: "Customer email was not returned by Paystack." });
    }
    // ONE database transaction: payment record + balance + ledger lines. A Paystack reference can only ever be
    // credited once, no matter how many times this page or the webhook fires.
    const credited = await ledger.creditPurchase({ email: userId, coins: coin, reference, amountNgn: amountInNaira });
    if (!credited.credited) {
      return res.json({
        success: true, alreadyProcessed: true, message: "This payment has already been processed.",
        reference: reference, coins: 0, balance: credited.balance
      });
    }
    const newBalance = credited.balance;
    console.log(
      `Payment verified: ${reference} | ` +
      `Email: ${userId} | ` +
      (payCurrency === "USD" ? `$${match.usd} (package ₦${amountInNaira}) | ` : `₦${amountInNaira} | `) +
      `${coin} coins | ` +
      `Balance: ${newBalance}`
    );

    return res.json({
      success: true,
      message:
        "Payment verified successfully.",

      reference:
        reference,

      email:
        userId,

      amount:
        amountInNaira,
      currency: payCurrency,
      chargedAmount: match.paid,
      feePaid: match.fee,

      coins:
        coin,

      balance:
        newBalance
    });

  } catch (error) {

    console.error(
      "Paystack verification error:",
      error.response?.data ||
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to verify payment."
    });
  }
});


// =====================================================
// OLD GIFT URL
// =====================================================

app.post(
  "/api/live/send-gift",
  async (req, res) => {

    req.url = "/api/gifts/send";

    app._router.handle(
      req,
      res,
      () => { }
    );

  }
);


// =====================================================
// CREATOR EARNINGS
// =====================================================

app.get(
  "/api/creator/earnings", asSelf("query.email"),
  async (req, res) => {

    try {

      const creatorId =
        req.query.email ||
        req.query.creatorId;


      if (!creatorId) {

        return res.status(400).json({

          success: false,

          message:
            "Creator ID or email is required."

        });

      }


      const eligibility =
        await getCreatorEligibility(
          creatorId
        );


      res.json({

        success: true,

        status: true,

        creatorId:
          creatorId,

        stars:
          eligibility.stars,

        earnedStars: eligibility.earnedStars,
        onHoldStars: eligibility.onHoldStars,
        holdDays: eligibility.holdDays,
        nextReleaseAt: eligibility.nextReleaseAt,

        minimumStars:
          eligibility.minimumStars,

        payout:
          eligibility.payout,

        currency:
          eligibility.currency,

        eligible:
          eligibility.eligible,

        starsComplete:
          eligibility.starsComplete,

        liveRequirementComplete:
          eligibility.liveRequirementComplete,

        monthlyLive:
          eligibility.live

      });


    } catch (error) {

      console.error(
        "CREATOR EARNINGS ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        message:
          "Unable to load creator earnings."

      });

    }

  }
);


// =====================================================
// CREATOR MONTHLY STATUS
// =====================================================

app.get(
  "/api/creator/monthly-status", asSelf("query.email"),
  async (req, res) => {

    try {

      const creatorId =
        req.query.email ||
        req.query.creatorId;


      if (!creatorId) {

        return res.status(400).json({

          success: false,

          message:
            "Creator ID or email is required."

        });

      }


      const result =
        await getCreatorEligibility(
          creatorId
        );


      res.json({

        success: true,

        status: true,

        creatorId:
          creatorId,

        month:
          result.live.month,

        stars:
          result.stars,

        earnedStars: result.earnedStars,
        onHoldStars: result.onHoldStars,
        holdDays: result.holdDays,
        nextReleaseAt: result.nextReleaseAt,

        minimumStars:
          result.minimumStars,

        starsComplete:
          result.starsComplete,

        dailyRequiredHours:
          result.live.dailyRequiredHours,

        todayHours:
          result.live.todayHours,

        todayComplete:
          result.live.todayComplete,

        daysInMonth:
          result.live.daysInMonth,

        completedDays:
          result.live.completedDays,

        remainingDays:
          result.live.remainingDays,

        monthlyLiveRequirementComplete:
          result.live.monthlyRequirementComplete,
        everyDayComplete: result.live.everyDayComplete,
        monthlyHours: result.live.monthlyHours,
        monthlyHoursRequired: result.live.monthlyHoursRequired,
        totalHoursComplete: result.live.totalHoursComplete,
        vipPayout: result.vipPayout,
        blockUsd: result.blockUsd,
        requirements: result.requirements,

        eligible:
          result.eligible,

        payout:
          result.payout,

        currency:
          result.currency

      });


    } catch (error) {

      console.error(
        "MONTHLY STATUS ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        message:
          "Unable to load monthly creator status."

      });

    }

  }
);


// =====================================================
// HOST WALLET → CREATOR WITHDRAWAL SECURITY
// =====================================================

app.get(
  "/api/creator/withdrawal", asSelf("query.email"),
  async (req, res) => {

    try {

      const creatorId =
        req.query.email ||
        req.query.creatorId;


      if (!creatorId) {

        return res.status(400).json({

          success: false,

          message:
            "Creator ID or email is required."

        });

      }


      // =================================================
      // HOST WALLET
      // =================================================

      const wallet =
        await getWallet(creatorId);


      const stars =
        (await getStarBreakdown(creatorId)).withdrawable;


      // =================================================
      // WITHDRAWAL SECURITY
      // =================================================

      const security =
        await getWithdrawalSecurity(
          creatorId
        );


      // =================================================
      // MONTHLY LIVE REQUIREMENT
      // =================================================

      const hostRules = await hostRulesFor(creatorId);
      const live = await getMonthlyLiveStatus(creatorId, hostRules);


      // =================================================
      // CHECK ALL CONDITIONS
      // =================================================

      const hostWalletReady =
        wallet !== null &&
        wallet !== undefined;


      const notBanned =
        security.banned !== true;


      const fourHoursComplete =
        live.monthlyRequirementComplete;


      const fourThousandStarsComplete =
        stars >= hostRules.minStars;


      const withdrawalUnlocked =
        hostWalletReady &&
        notBanned &&
        fourHoursComplete &&
        fourThousandStarsComplete;


      // =================================================
      // CALCULATE PAYOUT
      // =================================================

      const payout =
        withdrawalUnlocked
          ? calculateCreatorPayout(stars, hostRules.blockCents)
          : 0;


      // =================================================
      // DETERMINE LOCK REASONS
      // =================================================

      const lockedReasons = [];


      if (!hostWalletReady) {

        lockedReasons.push(
          "Host Wallet is not available."
        );

      }


      if (!notBanned) {

        lockedReasons.push(
          "Creator account is banned from withdrawal."
        );

      }


      if (!fourHoursComplete) {

        lockedReasons.push(
          "You must stream every day for at least " + hostRules.dailyHours + " hour and complete at least " + hostRules.monthlyHours + " live hours in the month (you have " + live.monthlyHours + ")."
        );

      }


      if (!fourThousandStarsComplete) {

        lockedReasons.push(
          "At least " + hostRules.minStars.toLocaleString("en-US") + " Golden Stars are required" + (hostRules.vip ? " for a VIP host." : ".")
        );

      }


      // =================================================
      // LOCKED
      // =================================================

      if (!withdrawalUnlocked) {

        return res.json({

          success: true,

          eligible: false,

          withdrawalOpen: false,

          withdrawalLocked: true,

          creatorId:
            creatorId,

          banned:
            security.banned,

          failedWithdrawalAttempts:
            security.failedAttempts,

          maximumFailedAttempts:
            MAX_WITHDRAWAL_ATTEMPTS,

          hostWalletReady:
            hostWalletReady,

          stars:
            stars,

          minimumStars: hostRules.minStars,
          monthlyHoursRequired: hostRules.monthlyHours,
          vipPayout: hostRules.vip,

          starsComplete:
            fourThousandStarsComplete,

          dailyFourHoursRequired: hostRules.dailyHours,
          dailyHoursRequired: hostRules.dailyHours,

          monthlyLiveRequirementComplete:
            fourHoursComplete,

          payout:
            0,

          currency:
            "USD",

          lockedReasons:
            lockedReasons,

          monthlyLive:
            live

        });

      }


      // =================================================
      // UNLOCKED
      // =================================================

      return res.json({

        success: true,

        eligible: true,

        withdrawalOpen: true,

        withdrawalLocked: false,

        creatorId:
          creatorId,

        banned: false,

        failedWithdrawalAttempts:
          security.failedAttempts,

        maximumFailedAttempts:
          MAX_WITHDRAWAL_ATTEMPTS,

        hostWalletReady:
          true,

        stars:
          stars,

        minimumStars: hostRules.minStars,
        monthlyHoursRequired: hostRules.monthlyHours,
        vipPayout: hostRules.vip,

        starsComplete:
          true,

        dailyFourHoursRequired: hostRules.dailyHours,
        dailyHoursRequired: hostRules.dailyHours,

        monthlyLiveRequirementComplete:
          true,

        payout:
          payout,

        currency:
          "USD",

        lockedReasons: [],

        message:
          "Host Wallet requirements completed. Creator withdrawal is unlocked.",

        monthlyLive:
          live

      });


    } catch (error) {

      console.error(
        "HOST WALLET WITHDRAWAL CHECK ERROR:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to check Host Wallet withdrawal status."

      });

    }

  }
);


// =====================================================
// CREATOR WITHDRAWAL SECURITY
// =====================================================

const MAX_WITHDRAWAL_ATTEMPTS = 5;
const getWithdrawalSecurity = (creatorId) => store.getWithdrawalSecurity(creatorId);
const saveWithdrawalSecurity = (creatorId, security) => store.saveWithdrawalSecurity(creatorId, security);
async function recordFailedWithdrawalAttempt(creatorId) {
  const security = await getWithdrawalSecurity(creatorId);
  security.failedAttempts += 1;
  security.lastAttemptAt = new Date().toISOString();
  if (security.failedAttempts >= MAX_WITHDRAWAL_ATTEMPTS) {
    security.banned = true;
    security.disqualified = true;
    console.log(`SECURITY ALERT: ${creatorId} has been banned and disqualified after ${security.failedAttempts} failed withdrawal attempts.`);
  }
  await saveWithdrawalSecurity(creatorId, security);
  return security;
}

// =====================================================
// WITHDRAWAL SECURITY STATUS
// =====================================================

app.get(
  "/api/creator/withdrawal/security", asSelf("query.email"),
  async (req, res) => {

    try {

      const creatorId =
        req.query.email ||
        req.query.creatorId;


      if (!creatorId) {

        return res.status(400).json({

          success: false,

          message:
            "Creator ID or email is required."

        });

      }


      const security =
        await getWithdrawalSecurity(
          creatorId
        );


      return res.json({

        success: true,

        creatorId:
          creatorId,

        failedAttempts:
          security.failedAttempts,

        remainingAttempts:
          Math.max(
            0,
            MAX_WITHDRAWAL_ATTEMPTS -
            security.failedAttempts
          ),

        banned:
          security.banned,

        disqualified:
          security.disqualified,

        maxAttempts:
          MAX_WITHDRAWAL_ATTEMPTS,

        withdrawalBlocked:
          security.banned ||
          security.disqualified

      });


    } catch (error) {

      console.error(
        "WITHDRAWAL SECURITY STATUS ERROR:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to check withdrawal security."

      });

    }

  }
);


// =====================================================
// SECURE CREATOR WITHDRAWAL REQUEST
// =====================================================

app.post(
  "/api/creator/withdrawal/request", asSelf("body.email"),
  async (req, res) => {

    try {

      const creatorId =
        String(
          req.body.email ||
          req.body.creatorId ||
          ""
        ).trim();


      const method =
        String(
          req.body.method ||
          ""
        ).trim();


      const accountName =
        String(
          req.body.accountName ||
          ""
        ).trim();


      const bankName =
        String(
          req.body.bankName ||
          ""
        ).trim();


      const accountNumber =
        String(
          req.body.accountNumber ||
          ""
        ).trim();


      const amount =
        Number(
          req.body.amount
        );


      // =================================================
      // BASIC SECURITY CHECK
      // =================================================

      if (!creatorId) {

        return res.status(400).json({

          status: false,

          success: false,

          message:
            "Creator account is required."

        });

      }


      // =================================================
      // GET SECURITY RECORD
      // =================================================

      const security =
        await getWithdrawalSecurity(
          creatorId
        );


      // =================================================
      // PERMANENT SECURITY BLOCK
      // =================================================

      if (
        security.banned ||
        security.disqualified
      ) {

        return res.status(403).json({

          status: false,

          success: false,

          withdrawalOpen: false,

          blocked: true,

          message:
            "This creator account is permanently blocked from withdrawal because the withdrawal security limit was reached."

        });

      }


      // =================================================
      // VALIDATE WITHDRAWAL METHOD
      // =================================================

      if (
        method !== "bank" &&
        method !== "paystack"
      ) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(400).json({

          status: false,

          success: false,

          withdrawalOpen: false,

          message:
            "Please select a valid withdrawal method.",

          failedAttempts:
            security.failedAttempts,

          blocked:
            security.banned ||
            security.disqualified

        });

      }


      // =================================================
      // VALIDATE ACCOUNT HOLDER NAME
      // =================================================

      if (!accountName) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(400).json({

          status: false,

          success: false,

          withdrawalOpen: false,

          message:
            "Account holder name is required.",

          failedAttempts:
            security.failedAttempts,

          blocked:
            security.banned ||
            security.disqualified

        });

      }


      // =================================================
      // VALIDATE BANK
      // =================================================

      if (!bankName) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(400).json({

          status: false,

          success: false,

          withdrawalOpen: false,

          message:
            "Bank name is required.",

          failedAttempts:
            security.failedAttempts,

          blocked:
            security.banned ||
            security.disqualified

        });

      }


      // =================================================
      // VALIDATE ACCOUNT NUMBER
      // =================================================

      if (
        !/^[0-9]+$/.test(
          accountNumber
        )
      ) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(400).json({

          status: false,

          success: false,

          withdrawalOpen: false,

          message:
            "Account number must contain numbers only.",

          failedAttempts:
            security.failedAttempts,

          blocked:
            security.banned ||
            security.disqualified

        });

      }


      // =================================================
      // VALIDATE AMOUNT
      // =================================================

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(400).json({

          status: false,

          success: false,

          withdrawalOpen: false,

          message:
            "Enter a valid withdrawal amount.",

          failedAttempts:
            security.failedAttempts,

          blocked:
            security.banned ||
            security.disqualified

        });

      }


      // =================================================
      // GET HOST WALLET
      // =================================================

      const wallet =
        await getWallet(
          creatorId
        );


      if (!wallet) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(403).json({

          success: false,

          withdrawalOpen: false,

          message:
            "Host wallet could not be found.",

          security:
            await getWithdrawalSecurity(
              creatorId
            )

        });

      }


      // =================================================
      // GET CREATOR ELIGIBILITY
      // =================================================

      const eligibility =
        await getCreatorEligibility(
          creatorId
        );


      // =================================================
      // 3,000 GOLDEN STAR CHECK
      // =================================================

      if (
        !eligibility.starsComplete
      ) {

        return res.status(403).json({

          success: false,

          withdrawalOpen: false,

          message:
            "Withdrawal is locked. You must reach at least " + Number(eligibility.minimumStars).toLocaleString("en-US") + " Golden Stars.",

          stars:
            eligibility.stars,

          minimumStars:
            eligibility.minimumStars,

          security:
            await getWithdrawalSecurity(
              creatorId
            )

        });

      }


      // =================================================
      // DAILY LIVE HOURS / MONTHLY CHECK
      // =================================================

      if (
        !eligibility.liveRequirementComplete
      ) {

        return res.status(403).json({

          success: false,

          withdrawalOpen: false,

          message:
            "Withdrawal is locked. Stream every day for at least " + eligibility.requirements.dailyHours + " hour and complete at least " + eligibility.requirements.monthlyHours + " live hours this month.",

          monthlyLive:
            eligibility.live,

          security:
            await getWithdrawalSecurity(
              creatorId
            )

        });

      }


      // =================================================
      // CALCULATE AVAILABLE CREATOR PAYOUT
      // =================================================

      const availablePayout =
        Number(
          eligibility.payout || 0
        );


      if (
        availablePayout <= 0
      ) {

        return res.status(403).json({

          success: false,

          withdrawalOpen: false,

          message:
            "There is currently no eligible withdrawal balance.",

          payout:
            0,

          security:
            await getWithdrawalSecurity(
              creatorId
            )

        });

      }


      // =================================================
      // AMOUNT MUST BE IN WHOLE $9 STEPS (each = 3,000 Golden Stars)
      // =================================================

      // VIP hosts: whole $10.80 steps. Everyone else: whole $9 steps. Counted in cents so decimals never cause a wrong answer.
      const blockCents = Math.round(Number(eligibility.blockUsd || 9) * 100);
      const amountCents = Math.round(amount * 100);
      const usd = (c) => (c / 100).toFixed(2).replace(/\.00$/, "");
      if (amountCents % blockCents !== 0) {

        return res.status(400).json({

          success: false,

          withdrawalOpen: true,

          message:
            "Withdrawal amounts must be in $" + usd(blockCents) + " steps (each $" + usd(blockCents) + " uses 3,000 Golden Stars). Try $" +
            usd(Math.floor(amountCents / blockCents) * blockCents || blockCents) + ".",

          availablePayout:
            availablePayout

        });

      }


      // =================================================
      // AMOUNT CANNOT EXCEED AVAILABLE PAYOUT
      // =================================================

      if (
        amount >
        availablePayout
      ) {

        await recordFailedWithdrawalAttempt(
          creatorId
        );


        return res.status(400).json({

          success: false,

          withdrawalOpen: false,

          message:
            `Requested amount is greater than your available payout of $${availablePayout.toFixed(2)}.`,

          availablePayout:
            availablePayout,

          requestedAmount:
            amount,

          security:
            await getWithdrawalSecurity(
              creatorId
            )

        });

      }


      // =================================================
      // ALL SECURITY CHECKS PASSED
      // =================================================

      const request = {

        id:
          "WD-" +
          Date.now() +
          "-" +
          Math.floor(
            Math.random() *
            10000
          ),

        creatorId:
          creatorId,

        method:
          method,

        accountName:
          accountName,

        bankName:
          bankName,

        accountNumber:
          accountNumber,

        amount:
          amount,

        currency:
          "USD",

        stars:
          eligibility.stars,

        month:
          eligibility.live.month,

        status:
          "pending_review",

        securityStatus:
          "passed",

        createdAt:
          new Date().toISOString()

      };


      // Spend the Golden Stars this payout is paid from (one block = 3,000 stars: $9 normal, $10.80 VIP),
      // so the same stars can never be withdrawn twice.
      const starsSpent = Math.round(amountCents / blockCents) * CREATOR_RULES.minimumStars;
      const spent = await store.recordWithdrawal(request, starsSpent);
      if (!spent.ok) {
        return res.status(409).json({ success: false, message: "Your available stars just changed. Please refresh and try again." });
      }
      request.starsSpent = starsSpent;

      // =================================================
      // RESET FAILED ATTEMPTS AFTER SUCCESSFUL REQUEST
      // =================================================

      security.failedAttempts = 0;

      security.lastAttemptAt =
        new Date().toISOString();

      await saveWithdrawalSecurity(creatorId, security);


      return res.json({

        success: true,

        status: true,

        withdrawalOpen: true,

        securityPassed: true,

        message:
          "Withdrawal request accepted and sent for review.",

        withdrawal:
          request,

        availablePayout:
          availablePayout,

        security: {

          failedAttempts:
            security.failedAttempts,

          remainingAttempts:
            MAX_WITHDRAWAL_ATTEMPTS,

          banned:
            false,

          disqualified:
            false

        }

      });


    } catch (error) {

      console.error(
        "SECURE WITHDRAWAL ERROR:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to process secure withdrawal request."

      });

    }

  }
);


// =====================================================
// ADMIN SECURITY STATUS
// =====================================================

app.get(
  "/api/admin/withdrawal-security", requireAdmin,
  async (req, res) => {

    const securityList = [];


    for (const security of await store.listWithdrawalSecurity()) {
      const creatorId = security.creatorId;

      securityList.push({

        creatorId:
          creatorId,

        failedAttempts:
          security.failedAttempts,

        remainingAttempts:
          Math.max(
            0,
            MAX_WITHDRAWAL_ATTEMPTS -
            security.failedAttempts
          ),

        banned:
          security.banned,

        disqualified:
          security.disqualified,

        lastAttemptAt:
          security.lastAttemptAt

      });

    }


    return res.json({

      success: true,

      maxAttempts:
        MAX_WITHDRAWAL_ATTEMPTS,

      security:
        securityList

    });

  }
);


// =====================================================
// WITHDRAWAL REQUEST LIST
// =====================================================

app.get(
  "/api/admin/creator-withdrawals", requireAdmin,
  async (req, res) => {

    res.json({

      success: true,

      withdrawals: await store.listWithdrawals(300)

    });

  }
);


// =====================================================
// HOST RANKING
// =====================================================

app.get("/api/ranking/hosts", (req, res, next) => { req.isHostRanking = true; next(); }, maskRanking, async (req, res) => {
  const ranking = await store.hostRanking(null, 100);
  res.json({ success: true, ranking });
});


// =====================================================
// GIFTER RANKING
// =====================================================

app.get("/api/ranking/gifters", maskRanking, async (req, res) => {
  const ranking = await store.gifterRanking(null, 100);
  res.json({ success: true, ranking });
});


// =====================================================
// LIVE ROOM STATS
// =====================================================

app.get(
  "/api/live/room/:hostId",
  async (req, res) => {

    const hostId =
      req.params.hostId;


    const wallet =
      await getWallet(hostId);


    const stats =
      await getHostStats(hostId);


    res.json({

      success: true,

      hostId:
        hostId,

      goldenStars:
        Number(wallet?.stars || 0),

      loves:
        Number(wallet?.loves || 0),

      gifts:
        stats.gifts,

      giftCoins:
        stats.giftCoins,

      viewers:
        stats.viewers

    });

  }
);


// =====================================================
// LIVE ROOM VIEWER COUNT
// =====================================================

app.post("/api/live/room/:hostId/viewer", async (req, res) => {
  const hostId = req.params.hostId;
  res.json({ success: true, hostId, viewers: await store.addViewer(hostId) });
});


// =====================================================
// ALL GIFT TRANSACTIONS
// =====================================================

app.get(
  "/api/gifts/transactions", requireAdmin,
  async (req, res) => {

    res.json({

      success: true,

      transactions: await store.allGifts(500)

    });

  }
);


// =====================================================
// CREATOR DAILY RECORDS
// =====================================================

app.get(
  "/api/creator/live-records", asSelf("query.email"),
  async (req, res) => {

    try {

      const creatorId =
        req.query.email ||
        req.query.creatorId;


      if (!creatorId) {

        return res.status(400).json({

          success: false,

          message:
            "Creator ID or email is required."

        });

      }


      const result = await getMonthlyLiveStatus(creatorId, await hostRulesFor(creatorId));


      res.json({

        success: true,

        creatorId:
          creatorId,

        month:
          result.month,

        daysInMonth:
          result.daysInMonth,

        completedDays:
          result.completedDays,

        remainingDays:
          result.remainingDays,

        dailyRequiredHours:
          result.dailyRequiredHours,

        todayHours:
          result.todayHours,

        todayComplete:
          result.todayComplete,

        monthlyRequirementComplete:
          result.monthlyRequirementComplete,
        everyDayComplete: result.everyDayComplete,
        monthlyHours: result.monthlyHours,
        monthlyHoursRequired: result.monthlyHoursRequired,
        totalHoursComplete: result.totalHoursComplete,

        days:
          result.days

      });


    } catch (error) {

      console.error(
        "LIVE RECORDS ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        message:
          "Unable to load live records."

      });

    }

  }
);


// =====================================================
// VICTOPAY LIVE PLATFORM
// =====================================================

// =====================================================
// LIVE CATEGORIES
// =====================================================

const LIVE_CATEGORIES = [

  "Trending",
  "Popular",
  "Music",
  "Dance",
  "Gaming",
  "Chat",
  "Entertainment",
  "Education",
  "Comedy",
  "Sports",
  "Audio",
  "Multi-Guest",
  "PK",
  "Shopping",
  "New Hosts"

];


// =====================================================
// LIVEKIT REAL-TIME VIDEO
// =====================================================

app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomName, name, role } = req.body || {};
    let identity = (req.body || {}).identity;

    if (!roomName || !identity) {
      return res.status(400).json({ success: false, message: "roomName and identity are required." });
    }

    // Publishing (going live) requires a real signed-in account and can only
    // be done as yourself. Viewers may be guests, but a guest can never take
    // the identity of a real account.
    const authEmail = getAuthEmail(req);
    if (role === "host") {
      if (!authEmail) {
        return res.status(401).json({ success: false, message: "Please sign in to go live." });
      }
      // A host token may only be issued to the creator of this live room.
      const ownedRoom = liveRooms.get(String(roomName));
      if (!ownedRoom || String(ownedRoom.hostId).toLowerCase() !== authEmail) {
        return res.status(403).json({ success: false, message: "You can only broadcast in your own live room." });
      }
      identity = publicHandle(authEmail);
    } else if (role === "caller") {
      // Only signed-in users may publish a camera/microphone into another
      // person's live room, and only while that room is active.
      if (!authEmail) {
        return res.status(401).json({ success: false, message: "Sign in before requesting a video call." });
      }
      if (!liveRooms.has(String(roomName))) {
        return res.status(404).json({ success: false, message: "This livestream is no longer available." });
      }
      if (!callSystem || !(await callSystem.authorizeCaller(authEmail, String(roomName)))) {
        return res.status(403).json({ success: false, message: "The streamer must accept your call request before your camera and microphone can connect." });
      }
      identity = publicHandle(authEmail);
    } else {
      identity = authEmail ? publicHandle(authEmail) : ("guest-" + String(identity).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30));
    }

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        success: false,
        message: "Live video service is not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to the server environment."
      });
    }

    const canPublish = role === "host" || role === "caller";
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(identity),
      name: authEmail ? displayNameOf(authEmail) : "Guest",
      ttl: "2h"
    });

    token.addGrant({
      roomJoin: true,
      room: String(roomName),
      canPublish,
      canSubscribe: true,
      canPublishData: true
    });

    const jwt = await token.toJwt();

    return res.json({
      success: true,
      url: LIVEKIT_URL,
      token: jwt,
      identity: String(identity),
      role: role === "host" ? "host" : role === "caller" ? "caller" : "viewer"
    });
  } catch (error) {
    console.error("LIVEKIT TOKEN ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to create live video token." });
  }
});

// =====================================================
// LIVE CHAT HISTORY
// =====================================================
// Chat itself travels instantly over LiveKit's data channel (see
// Go-Live.html / watch-live.html) — nothing about real-time delivery
// depends on this. This table exists ONLY so someone who joins a
// room already in progress can see recent messages, since LiveKit
// keeps no history of a data message once it has been delivered.

const saveChatMessage = (roomId, senderName, isHost, text) => store.saveChat(roomId, senderName || "Guest", isHost, text);
const getChatHistory = (roomId, limit) => store.chatHistory(roomId, limit);

// GET recent chat history for a room — called once when a page joins,
// so late arrivals aren't staring at an empty chat box.
app.get("/api/live/chat/:roomId", async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const messages = await getChatHistory(roomId, req.query.limit);
    return res.json({ success: true, roomId, messages });
  } catch (error) {
    console.error("CHAT HISTORY ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to load chat history." });
  }
});

// POST one chat message to save into history. Real-time delivery to
// everyone in the room already happens over the LiveKit data channel
// the instant it's sent — this call just backs it up for later.
const chatSeen = new Map();
function chatLimit(req, res, next) {
  const last = chatSeen.get(req.userEmail) || 0;
  if (Date.now() - last < 800) return res.status(429).json({ success: false, message: "Slow down a little." });
  chatSeen.set(req.userEmail, Date.now());
  if (chatSeen.size > 5000) chatSeen.clear();
  next();
}
app.post("/api/live/chat/:roomId", requireAuth, chatLimit, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { name, isHost, text } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({ success: false, message: "Message text is required." });
    }

    // Only the real, signed-in owner of this room can have their
    // message saved with the HOST badge — this stops anyone else
    // from forging a fake "host" message into the saved history.
    let confirmedHost = false;
    if (isHost) {
      const authEmail = getAuthEmail(req);
      const room = liveRooms.get(String(roomId));
      confirmedHost = !!authEmail && !!room && String(room.hostId).toLowerCase() === authEmail;
    }

    const ts = await saveChatMessage(roomId, displayNameOf(req.userEmail), confirmedHost, String(text).trim());
    return res.json({ success: true, ts });
  } catch (error) {
    console.error("CHAT SAVE ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to save chat message." });
  }
});

// =====================================================
// LIVE ROOMS STORAGE
// =====================================================

const liveRooms =
  new Map();


// =====================================================
// CREATE LIVE ROOM
// =====================================================

app.post(
  "/api/live/create", asSelf("body.hostId"),
  async (req, res) => {

    try {

      const {
        hostId,
        title,
        category,
        liveType,
        name
      } = req.body;


      if (!hostId) {

        return res.status(400).json({

          success: false,

          message:
            "Host ID is required."

        });

      }

      if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        return res.status(503).json({
          success: false,
          message: "Live video service is not configured. Add LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to the server environment."
        });
      }


      // Product Live: the same LiveKit connection, with one of the host's registered Marketplace products pinned for viewers
      let liveProduct = null;
      if (req.body.productId) {
        const lp = await engage.liveProduct(String(hostId).toLowerCase(), req.body.productId);
        if (lp.error) return res.status(lp.code || 400).json({ success: false, message: lp.error, needId: !!lp.needId });
        liveProduct = lp.value;
      }

      // one live per host: starting again closes any older (ghost) room of theirs
      for (const [oldId, old] of Array.from(liveRooms.entries())) {
        if (String(old.hostId).toLowerCase() === String(hostId).toLowerCase()) {
          recordSessionEnd(old.hostId, oldId); await feat.onLiveEnd(old); liveRooms.delete(oldId);
        }
      }

      const roomId =
        "ROOM-" +
        Date.now() +
        "-" +
        Math.floor(
          Math.random() *
          10000
        );


      const room = {

        roomId:

          roomId,

        hostId:

          hostId,

        title:

          title ||
          "Victopay Live",

        category:

          LIVE_CATEGORIES.includes(
            category
          )
            ? category
            : "Trending",

        liveType:

          liveType ||
          "video",

        description: String(req.body.description || "").slice(0, 140),

        product: liveProduct,
        story: require("./vico-promo").cleanStory(req.body.story),
        promoted: await promo.isPromoted(hostId),

        viewers:
          0,

        gifts:
          0,

        giftCoins:
          0,

        pkActive:
          false,

        createdAt:
          new Date().toISOString()

      };


      liveRooms.set(
        roomId,
        room
      );
      await feat.onLiveStart(room);

      // Record the real session start time for live-hour tracking
      // (host-wallet.html / creator-withdrawal.html read from this).
      recordSessionStart(hostId, roomId);

      // Generate the host's LiveKit token for this same room, so
      // Go-Live.html only needs ONE call to start broadcasting.
      const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: publicHandle(hostId),
        name: displayNameOf(hostId),
        ttl: "6h"
      });

      token.addGrant({
        roomJoin: true,
        room: roomId,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
      });

      const jwt = await token.toJwt();


      return res.json({

        success: true,

        room,

        livekit: {
          url: LIVEKIT_URL,
          token: jwt,
          room: roomId
        }

      });


    } catch (error) {

      console.error(
        "CREATE LIVE ERROR:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Unable to create live room."

      });

    }

  }
);


// =====================================================
// END LIVE ROOM
// =====================================================

app.post("/api/live/end/:roomId", asSelf("body.hostId"), async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = liveRooms.get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: "Live room not found." });
    }

    const hostId = req.body?.hostId;
    if (hostId && String(room.hostId) !== String(hostId)) {
      return res.status(403).json({ success: false, message: "Only the host can end this live room." });
    }

    recordSessionEnd(room.hostId, roomId);
    await feat.onLiveEnd(room);

    liveRooms.delete(roomId);
    return res.json({ success: true, roomId });
  } catch (error) {
    console.error("END LIVE ERROR:", error);
    return res.status(500).json({ success: false, message: "Unable to end live room." });
  }
});

// =====================================================
// LIVE CATEGORIES API
// =====================================================

app.get(
  "/api/live/categories",
  async (req, res) => {

    res.json({

      success: true,

      categories:
        LIVE_CATEGORIES

    });

  }
);


// =====================================================
// DAILY / WEEKLY / MONTHLY RANKING
// =====================================================

function getRankingPeriod(
  period
) {

  const now =
    new Date();


  let start;


  if (
    period ===
    "daily"
  ) {

    start =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );

  } else if (
    period ===
    "weekly"
  ) {

    start =
      new Date(
        now.getTime() -
        7 * 24 * 60 * 60 * 1000
      );

  } else {

    start =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        1
      );

  }


  return start;

}


// =====================================================
// GIFTER PERIOD RANKING
// =====================================================

app.get("/api/ranking/gifters/:period", maskRanking, async (req, res) => {
  const period = req.params.period;
  if (!["daily", "weekly", "monthly"].includes(period)) {
    return res.status(400).json({ success: false, message: "Period must be daily, weekly or monthly." });
  }
  const ranking = await store.gifterRanking(getRankingPeriod(period).toISOString(), 100);
  res.json({ success: true, period, ranking });
});


// =====================================================
// HOST PERIOD RANKING
// =====================================================

app.get("/api/ranking/hosts/:period", (req, res, next) => { req.isHostRanking = true; next(); }, maskRanking, async (req, res) => {
  const period = req.params.period;
  if (!["daily", "weekly", "monthly"].includes(period)) {
    return res.status(400).json({ success: false, message: "Period must be daily, weekly or monthly." });
  }
  const ranking = await store.hostRanking(getRankingPeriod(period).toISOString(), 100);
  res.json({ success: true, period, ranking });
});


// =====================================================
// GIFT ANIMATION EVENT
// =====================================================

const giftAnimationEvents =
  [];

app.get(
  "/api/gifts/animations",
  async (req, res) => {

    res.json({

      success: true,

      animations:
        giftAnimationEvents.slice(
          -100
        )

    });

  }
);


// =====================================================
// PLATFORM SETTINGS
// =====================================================

const platformSettings = {

  videoLive:
    true,

  audioLive:
    true,

  gameLive:
    true,

  multiGuestLive:
    true,

  pkBattle:
    true,

  giftAnimation:
    true,

  fanClub:
    true,

  followers:
    true,

  rankings:
    true,

  trending:
    true

};


app.get(
  "/api/platform/features",
  async (req, res) => {

    res.json({

      success: true,

      website:
        WEBSITE_NAME,

      features:
        platformSettings

    });

  }
);


// =====================================================
// VICTOPAY LIVE - GIFT SHOP
// =====================================================

// Gift prices

const giftPrices = {
  "Strawberry": 10,
  "Fire": 50,
  "Rose": 100,
  "Trophy": 250,
  "Silver": 700,
  "Power Bike": 1000,
  "Car": 1200,
  "Gold": 2000,
  "Diamond": 5000,
  "Eagle": 10000,
  "Lion": 15000,
  "Dragon": 20000,
  "Elephant": 30000,
  "Whale": 50000
};


// =====================================================
// GET WALLET BALANCE
// =====================================================

app.get(
  "/api/wallet/:userId", asSelf("param.userId"),
  async (req, res) => {

    const userId = req.params.userId;

    if (!userId) {
      return res.status(400).json({
        status: false,
        message: "User ID is required."
      });
    }

    const balance = await ledger.getBalance(userId);

    return res.json({
      status: true,
      success: true,
      userId: userId,

      // Main wallet field
      coins: balance,

      // Kept for compatibility with older pages
      balance: balance
    });

  }
);

// =====================================================
// COIN STATEMENT  (e.g. +1000 Initial balance / +200 Received / -50 Sent to Sarah)
// =====================================================
app.get("/api/wallet/:userId/statement", asSelf("param.userId"), async (req, res) => {
  const rows = await ledger.statement(req.params.userId, req.query.limit);
  res.json({ success: true, balance: await ledger.getBalance(req.params.userId), entries: rows.filter(r => r.currency === "coin") });
});
app.get("/api/admin/ledger/verify", requireAdmin, async (req, res) => {
  res.json({ success: true, ...(await ledger.verify()) });
});
// Turn a host handle into the real account BEFORE the routes below run (Express runs routes in the order they are listed).
app.use(["/api/gifts/send", "/api/live/send-love", "/api/live/send-gift"], resolveHostMw);

// =====================================================
// FREE LOVE
// =====================================================

app.post(
  "/api/live/send-love", asSelf("body.senderId"),
  async (req, res) => {

    const {
      senderId,
      hostId
    } = req.body;


    if (
      !senderId ||
      !hostId
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Sender and host are required."

      });

    }


    // (no log line per tap: popular lives get thousands of hearts per minute)


    await store.addLove(hostId);
    feat.onLove({ senderId, hostId });


    return res.json({

      success: true,

      message:
        "Love sent successfully."

    });

  }
);


// =====================================================
// SEND PAID GIFT
// =====================================================

// Viewers send a public handle; turn it into the real host account, and never allow gifting yourself
async function resolveHostMw(req, res, next) {
  if (req.body && req.body.hostId) {
    req.body.hostId = await resolveHandle(req.body.hostId) || String(req.body.hostId).toLowerCase();
  }
  const me = getAuthEmail(req);
  if (me && req.body && req.body.hostId === me && !String(req.originalUrl).startsWith("/api/live/send-love")) {
    return res.status(400).json({ success: false, message: "You cannot send gifts to yourself." });
  }
  next();
}

app.post(
  "/api/gifts/send", asSelf("body.senderId"),
  async (req, res) => {

    const {
      gift,
      senderId,
      hostId
    } = req.body;


    // Check required information

    if (
      !gift ||
      !senderId ||
      !hostId
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Gift, sender and host are required."

      });

    }


    // Check whether gift exists

    if (!Object.prototype.hasOwnProperty.call(giftPrices, gift) || !(giftPrices[gift] > 0)) {

      return res.status(400).json({

        success: false,

        message:
          "Invalid gift selected."

      });

    }


    const price =
      giftPrices[gift];


    await users.warm([senderId, hostId]);
    // ONE database transaction: take the coins (only if the balance covers it), pay the host's stars, write the gift
    // record and both ledger lines. Two gifts sent at the same instant can never spend the same coins twice.
    // Optional requestId from the page: the same request can only ever be charged once (gift_transactions.id is unique, so a
    // repeat - double tap, retry after a bad connection - is rejected by the database and rolls back with no charge).
    const rid = String((req.body && req.body.requestId) || "");
    const giftId = /^[A-Za-z0-9_-]{16,64}$/.test(rid)
      ? "GIFT-R-" + crypto.createHash("sha1").update(senderId).digest("hex").slice(0, 10) + "-" + rid
      : "GIFT-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
    let sent;
    try {
      sent = await ledger.sendGift({
        sender: senderId, host: hostId, gift, price, giftId,
        senderName: displayNameOf(senderId), hostName: displayNameOf(hostId)
      });
    } catch (e) {
      if (e && e.code === "23505") return res.json({ success: true, duplicate: true, message: "That gift was already sent." });
      throw e;
    }
    if (!sent.ok) {
      return res.status(400).json({ success: false, message: "Insufficient coin. Please buy more coin." });
    }
    const newBalance = sent.balance;
    console.log(`🎁 GIFT: ${gift} | Sender: ${senderId} | Host: ${hostId} | Coins: ${price}`);
    const pkInfo = await feat.onGift({ senderId, hostId, gift, price });
    // Fan-club points are awarded only after the normal gift transaction succeeds.
    try { if (featureHooks.topSupporter) await featureHooks.topSupporter({ senderId, hostId, gift, price }); }
    catch (e) { console.error("FAN CLUB GIFT POINTS:", e.message); }


    // Return the new balance

    return res.json({

      success: true,

      gift:
        gift,

      price:
        price,

      senderId:
        senderId,

      hostId:
        hostId,

      coins:
        newBalance,

      balance:
        newBalance,
      battle:
        pkInfo || null
    });
  }
);

// ============================================================
// PAYMENT REVERSAL (chargeback / refund)
// ============================================================
// Takes the coins back from the buyer's wallet; if they were already spent as gifts, takes the stars back from
// the hosts who received them (newest gifts first) and freezes the buyer's account until you review it in /admin.html.
async function reversePayment(reference, why) {
  // one transaction: coins taken back, hosts' stars taken back, buyer frozen, report logged (see ledger.js)
  const r = await ledger.reversePayment(reference, why);
  if (!r.reversed) return false;
  bannedUsers.add(String(r.email).toLowerCase());
  return true;
}

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================
let creatorPartnership = null;
let vicoWallet = null;   // VicoPay Wallet (vico-wallet.js): wallet recharges must never be treated as coin purchases
let globalEnquiries = null;
app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature || !process.env.PAYSTACK_SECRET_KEY || !req.rawBody) {
      return res.sendStatus(400);
    }

    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(String(signature)), expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.sendStatus(401);
    }

    const event = req.body;
    if (event?.event === "paymentrequest.success" && globalEnquiries) {
      await globalEnquiries.handleInvoiceWebhook(event);
    }
    if (event?.event === "charge.success") {
      const payment = event.data;
      const reference = payment?.reference;
      if (creatorPartnership) {
        const partnershipResult = await creatorPartnership.handleChargeSuccess(payment);
        if (partnershipResult && partnershipResult.handled) return res.sendStatus(200);
      }
      if (vicoWallet && vicoWallet.isWalletPayment(payment)) {   // wallet recharge: re-checked with Paystack, credited once
        const w = await vicoWallet.finalize(reference);
        if (!w.ok && !w.pending) console.error("Wallet recharge not credited:", reference, w.message);
        return res.sendStatus(w.ok || !w.pending ? 200 : 500);
      }
      const userId = String(payment?.customer?.email || "").toLowerCase();
      if (typeof commerce !== "undefined" && commerce.isCommercePayment(payment)) {   // ad and marketplace payments: always re-checked with Paystack, finalised once
        const r = await commerce.finalize(reference);
        if (!r.ok) console.error("Commerce payment not finalised:", reference, r.message);
        return res.sendStatus(r.ok || /Unknown|not completed/.test(String(r.message)) ? 200 : 500);
      }
      if (promo.isPromoPayment(payment)) {   // Promotional Duration: always re-checked with Paystack, applied once
        const pr = await promo.confirm(reference);
        if (!pr.ok && !pr.pending) console.error("Promotion payment not applied:", reference, pr.message);
        return res.sendStatus(pr.ok || !pr.pending ? 200 : 500);
      }
      if (forex.isForexPayment(payment)) {
        const f = await forex.activateFromPayment(payment);
        if (f.ok && f.activated) console.log(`Paystack webhook activated Forex Academy for ${f.email}`);
        else if (!f.ok) console.error("Forex payment not activated:", reference, f.message);
        return res.sendStatus(200);
      }
      const payCurrency = String(payment?.currency || "NGN").toUpperCase();
      const isNgn = payCurrency === "NGN" || payCurrency === "USD"; // naira and dollar coin payments are both handled
      const match = payCurrency === "USD" ? packageForUsdPayment(coinPackages, coinUsdTable(), payment) : packageForPayment(coinPackages, payment);
      if (reference && userId && isNgn && !match) await logUnmatchedPayment(reference, payment, "webhook");
      if (reference && userId && isNgn && match) {
        // Safe to receive the same event many times: a reference is credited once (primary key + transaction).
        const r = await ledger.creditPurchase({ email: userId, coins: match.coins, reference, amountNgn: match.price });
        if (r.credited) console.log(`Paystack webhook credited ${match.coins} coins to ${userId} (paid ${payCurrency === "USD" ? "$" : "₦"}${match.paid} = package ₦${match.price}, fee ${payCurrency === "USD" ? "$" : "₦"}${match.fee})`);
      }
    }
    // Creator payout transfers: transfer.success / transfer.failed / transfer.reversed. If this throws, Paystack retries later.
    if (typeof event?.event === "string" && event.event.startsWith("transfer.")) {
      if (creatorPartnership) await creatorPartnership.handleTransferEvent(event);
      await payouts.handleTransferEvent(event);
      return res.sendStatus(200);
    }
    if (event?.event === "charge.dispute.create" || event?.event === "refund.processed") {
      const d = event.data || {};
      const ref = (d.transaction && d.transaction.reference) || d.transaction_reference || d.reference;
      if (ref && creatorPartnership) await creatorPartnership.handleChargeReversal(ref, event.event);
      if (ref) await reversePayment(ref, event.event);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Paystack webhook error:", error.message);
    return res.sendStatus(500);
  }
});

// ============================================================
// FEATURES: follow, fan club, PK, notifications, admin, password reset, search
// ============================================================
// Warn loudly if the payout is generous compared with what a coin costs (self-gifting would then make money).
(function checkEconomics() {
  const ngnPerUsd = Number(process.env.NGN_PER_USD || 1500), coinPriceNgn = 10;
  const payoutNgn = 9 * ngnPerUsd, costNgn = CREATOR_RULES.minimumStars * coinPriceNgn;
  const ratio = payoutNgn / costNgn;
  console.log("Payout check: " + CREATOR_RULES.minimumStars.toLocaleString() + " stars cost buyers ₦" + costNgn.toLocaleString() + " and pay hosts $9 (about ₦" + payoutNgn.toLocaleString() + " at ₦" + ngnPerUsd + "/$) = " + Math.round(ratio * 100) + "% of what was spent.");
  if (ratio > 0.6) console.warn("⚠️  PAYOUT TOO HIGH: hosts would receive " + Math.round(ratio * 100) + "% of what buyers pay. Self-gifting could be profitable. Lower the payout or raise coin prices.");
})();

app.get("/config.js", async (req, res) => {
  res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(
    "window.VICO_CONFIG=" + JSON.stringify({ siteName: "VicoPay Live", supportEmail: process.env.SUPPORT_EMAIL || "", supportWhatsapp: String(process.env.SUPPORT_WHATSAPP || "").replace(/[^\d]/g, "") }) + ";");
});

const featureHooks = {};   // filled in below by the VIP module (VIP entrance animations)
const feat = require("./features")({
  app, db, ledger, store, axios, crypto, liveRooms, giftPrices, getAuthEmail, requireAuth, requireAdmin, authRateLimit, hashPassword,
  recordSessionEnd, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, hooks: featureHooks
});

// Forex Academy: paid membership, lessons, practice-trading saves
const forex = require("./forex")({ app, db, axios, getAuthEmail, requireAuth, requireAdmin });

// Help Center: support tickets + replies
require("./support")({ app, db, requireAuth, requireAdmin });
// Vico Pay Global Market Community: public enquiries, admin replies and Paystack invoice billing.
globalEnquiries = require("./global-enquiries")({ app, db, axios, requireAdmin });
// Admin Analytics: protected dashboard endpoint backed by live PostgreSQL records.
require("./analytics")({ app, db, requireAdmin });
const campaigns = require("./campaigns")({ app, db, requireAuth, requireAdmin, getAuthEmail, liveRooms });
// Free-first company and national organisation verification (KYB).
require("./company-verification")({ app, db, requireAuth, requireAdmin });

// VIP system (Stage 1: identity). New tables only, switched OFF until an admin turns it on in admin-vip.html. See vip.js.
const vip = require("./vip")({ app, db, requireAuth, requireAdmin, store, giftPrices });
// Shared video-call access: VIP eligibility, 9,000-star threshold and verified $3 VIP-call payments.
callSystem = require("./vico-calls")({ app, db, requireAuth, store, vip, liveRooms, axios });

// Invite Friends & Earn Coins. New tables only; coins are paid into the existing balances/ledger. See referrals.js.
// Email verification through Resend (6-digit code + Resend delivery webhook). New tables only. See email-verify.js.
const emailVerify = require("./email-verify")({ app, db, requireAuth, onBounce: (addr) => referrals.rejectForEmail(addr) });
const referrals = require("./referrals")({ app, db, requireAuth, requireAdmin, ledger, emailVerified: emailVerify.isVerified });
// Market Community: Vico AI, Vico Messages, Vico Marketplace and the Vico Ad Center. New tables only. See vico-ai.js, vico-messages.js, vico-market.js, vico-ads.js.
require("./vico-ai")({ app, db, requireAuth, requireAdmin, axios });
// Vico Message: phone-verified chat + voice/video calls (vico-messages.js, vico-message-calls.js, vico-phone.js). Private calls with a VIP follow the same paid-call rule as live calls.
// VicoPay Wallet: one central naira balance for paid messages and calls, recharged with Paystack. New tables only. See vico-wallet.js.
vicoWallet = require("./vico-wallet")({ app, db, requireAuth, axios, siteUrlOf, walletSecurity });
const vicoMessage = require("./vico-messages")({ app, db, requireAuth, store, axios, callAccess: callSystem && callSystem.access, wallet: vicoWallet });
require("./vico-market")({ app, db, requireAuth, requireAdmin, store });
const videos = require("./vico-videos")({ app, db, requireAuth, requireAdmin, store, getAuthEmail });
// Creator video partnership: public Marketplace publishing + Paystack verified company funding + bank transfer settlement.
creatorPartnership = require("./creator-partnership")({ app, db, requireAuth, axios });
// Follow / Like / Save / "⋯" on videos and product pictures, and Product Live (same LiveKit account as Go Live). New tables only. See vico-engage.js.
const engage = require("./vico-engage")({ app, db, requireAuth, requireAdmin, getAuthEmail, store, liveRooms });
// Product livestreams are saved as real video files and linked to their Marketplace listing.
const productLiveRecordings = require("./product-live-recordings")({ app, db, requireAuth, liveRooms });
const commerce = require("./vico-commerce")({ app, db, requireAuth, requireAdmin, store, axios });
require("./vico-ads")({ app, db, requireAuth, requireAdmin, emailVerified: emailVerify.isVerified, commerce });
// Ad levels and priced jobs: Personal / Small / Big / Company / National -> job -> pay -> business information -> identity matching. New tables only. See vico-ad-jobs.js and ad-catalog.json.
require("./vico-ad-jobs")({ app, db, requireAuth, requireAdmin, commerce, linkProblem: require("./vico-ads").linkProblem });
// Fan club membership (levels, missions, leaderboards, fan entrance, top supporter). See fans.js.
const fans = require("./fans")({ app, db, store, vip, requireAuth, getAuthEmail });
// Live promotion: blue "Processing Promotion" -> green "Promotion Successful", the Promotional Duration payment (Paystack), VIP grant. See vico-promo.js.
const promo = require("./vico-promo")({ app, db, requireAuth, store, vip, liveRooms });
// A fan club member entering THEIR host's live gets the fan entrance (bike, crown, name); everybody else still gets the normal VIP entrance.
featureHooks.viewerJoin = async (room, email, push) => {
  try { if (await fans.onViewerJoin(room, email, push)) return; } catch (e) { /* a broken fan entrance must never block the VIP one */ }
  return vip.onViewerJoin(room, email, push);
};
featureHooks.topSupporter = fans.onGift;
// VIP rankings and achievements (read-only boards of VIP people). See vip-rankings.js.
require("./vip-rankings")({ app, db, store, vip });

// Monthly creator payouts (Paystack Transfers): eligibility, bank recipients, email approval, webhooks. See payouts.js.
// Real-time Super Admin Command Centre: LiveKit room/participant counts, PostgreSQL metrics and fraud review.
commandCenter = require("./admin-command-center")({
  app, db, requireAdmin, liveRooms,
  livekit: { url: LIVEKIT_URL, key: LIVEKIT_API_KEY, secret: LIVEKIT_API_SECRET }
});
// Individual administrator accounts, TOTP MFA, role permissions, enforcement actions and immutable-by-API audit history.
adminControl = require("./admin-control-center")({ app, db, requireAdmin, store, bannedUsers, authSecret: AUTH_SECRET });
const platformOps = require("./admin-platform-operations")({ app, db, requireAdmin, getMaintenance: () => platformMaintenance, setMaintenance: (v) => { platformMaintenance = v; }, env: process.env, livekit: { url: LIVEKIT_URL, key: LIVEKIT_API_KEY, secret: LIVEKIT_API_SECRET } });

const payouts = require("./payouts")({
  app, db, store, axios, crypto, requireAuth, requireAdmin,
  rules: {
    minimumStars: CREATOR_RULES.minimumStars, dailyLiveHours: CREATOR_RULES.dailyLiveHours, monthlyLiveHours: CREATOR_RULES.monthlyLiveHours, usdPerBlock: 9,
    vipMinimumStars: VIP_RULES.minimumStars, vipMonthlyLiveHours: VIP_RULES.monthlyLiveHours, vipUsdPerBlock: 10.8
  },
  hostRules: hostRulesFor,     // normal or VIP, decided on the server for each host
  holdDays: PAYOUT_HOLD_DAYS
});

// Monthly appreciation messages (1st of every month) and yearly 20-coin consistency awards.
// The yearly award checks all 12 completed months against the existing server-side creator requirements.
const appreciation = require("./appreciation")({ app, db, ledger, requireAuth, hostRulesFor });

// ============================================================
// START SERVER
// ============================================================

app.use("/api", async (req, res) => res.status(404).json({ success: false, message: "Not found." }));
app.use(async (req, res) => res.status(404).sendFile(path.join(SITE_DIR, "404.html")));
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ success: false, message: err.status === 413 ? "That upload is too large." : "Something went wrong." });
});


const PORT = process.env.PORT || 3000;

// START THE WEB SERVER IMMEDIATELY.
// Render can detect the port while database migrations run.
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("============================================================");
  console.log("Victopay server is listening on port " + PORT);
  console.log("============================================================");
});

server.on("error", (error) => {
  console.error("SERVER ERROR:", error);
});

process.on("SIGTERM", () => {
  console.log("Shutting down...");
  server.close(() => {
    store.flushLoves()
      .catch(() => { })
      .then(() => db.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  });
});

async function start() {
  console.log("STARTUP: beginning VicoPay startup sequence...");

  console.log("STARTUP: running main database migration...");
  await db.migrate();
  console.log("STARTUP: main database migration completed.");

  console.log("STARTUP: migrating command center...");
  await commandCenter.migrate();
  console.log("STARTUP: command center migration completed.");

  console.log("STARTUP: migrating admin control...");
  await adminControl.migrate();
  console.log("STARTUP: admin control migration completed.");

  await platformOps.migrate();
  console.log("STARTUP: platform operations migration completed.");

  await globalEnquiries.migrate();
  console.log("STARTUP: global enquiries migration completed.");

  await payouts.migrate();
  console.log("STARTUP: payouts migration completed.");

  await videos.ready;
  console.log("STARTUP: video storage ready.");

  await productLiveRecordings.ready;
  console.log("STARTUP: product live recordings ready.");

  await creatorPartnership.migrate();
  await vip.migrate();
  await fans.migrate();
  await appreciation.migrate();
  await campaigns.migrate();

  console.log("STARTUP: all migrations completed.");

  await store.refreshBans();

  setInterval(() => store.refreshBans().catch(() => { }), 20000).unref();
  setInterval(() => store.pruneOld().catch(() => { }), 3600000).unref();

  ledger.verifyCached(0).then((audit) => {
    console.log(
      audit.ok
        ? `Ledger check OK: ${audit.accounts} coin accounts, ${audit.totalCoins} coins in total.`
        : "LEDGER MISMATCH: " + JSON.stringify(audit.mismatches.slice(0, 5))
    );
  }).catch((e) => console.error("Ledger check failed:", e.message));

  setInterval(() => ledger.verifyCached(3600000).catch(() => { }), 3600000).unref();
  setInterval(() => store.flushLoves().catch(() => { }), 3000).unref();

  feat.start();
  payouts.start();
  appreciation.start();

  const fraudScanTimer = setInterval(
    () => commandCenter.scanFraud().catch((e) => console.error("Fraud scan failed:", e.message)),
    60000
  );
  fraudScanTimer.unref();

  console.log("STARTUP: VicoPay startup completed successfully.");
}

start().catch((e) => {
  console.error("STARTUP FAILED:", e);
  process.exit(1);
});
