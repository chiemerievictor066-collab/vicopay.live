// =====================================================
// VicoPay Live — data store (PostgreSQL)
// =====================================================
// Everything the app needs to remember lives in PostgreSQL. This file is the only place that knows the SQL for
// accounts, host stats, gift history, rankings, live-session time, withdrawals and chat.
// Coins themselves are NOT here: they only move through ledger.js (one all-or-nothing transaction per event).
//
// Accounts are read from the database on demand and kept in a small, bounded cache (USER_CACHE_MAX, default 20,000),
// so memory stays flat whether you have 1,000 or 10,000,000 registered users.
// =====================================================
const crypto = require("crypto");

module.exports = function makeStore(db) {
  const lc = (v) => String(v || "").toLowerCase();
  const hashHandle = (email) => "u" + crypto.createHash("sha1").update(lc(email)).digest("hex").slice(0, 9);
  const isUnique = (e) => e && (e.code === "23505" || /unique|duplicate/i.test(String(e.message)));

  // ---------------------------------------------------
  // ACCOUNTS  (bounded cache in front of the users table)
  // ---------------------------------------------------
  const CACHE_MAX = Math.max(100, Number(process.env.USER_CACHE_MAX || 20000));
  const cache = new Map();
  const SEL = `SELECT u.email, u.id, u.salt, u.hash, u.username, u.display_name AS "displayName", u.created_at AS "createdAt",
                      u.handle, a.updated_at AS "avatarV"
                 FROM users u LEFT JOIN avatars a ON a.email = u.email`;
  function remember(row) {
    if (!row) return null;
    const u = { ...row, username: row.username || "", displayName: row.displayName || "", handle: row.handle || hashHandle(row.email) };
    cache.delete(u.email); cache.set(u.email, u);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return u;
  }
  const users = {
    peek: (email) => cache.get(lc(email)),
    async get(email) {
      const e = lc(email); if (!e) return null;
      if (cache.has(e)) return cache.get(e);
      return remember(await db.get(SEL + " WHERE u.email = ?", [e]));
    },
    async exists(email) { return !!(await users.get(email)); },
    // Load many accounts in one query so the synchronous name/photo helpers below work for a whole list.
    async warm(emails) {
      const need = [...new Set((emails || []).map(lc).filter((e) => e && !cache.has(e)))];
      for (let i = 0; i < need.length; i += 400) {
        const chunk = need.slice(i, i + 400);
        const rows = await db.all(SEL + " WHERE u.email IN (" + chunk.map(() => "?").join(",") + ")", chunk);
        rows.forEach(remember);
      }
    },
    async byLogin(login) {
      const l = lc(login).trim(); if (!l) return null;
      return remember(await db.get(SEL + " WHERE u.email = ? OR u.username = ?", [l, l]));
    },
    async usernameTaken(username) { return !!(await db.get("SELECT 1 AS x FROM users WHERE username = ? OR handle = ?", [username, username])); },
    // Returns the new account, or null if the email/username is already used.
    async create(email, u, ip) {
      email = lc(email);
      const handle = u.username || hashHandle(email);
      try {
        const r = await db.get(
          "INSERT INTO users (email, salt, hash, username, display_name, created_at, handle, signup_ip, last_ip) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING email",
          [email, u.salt, u.hash, u.username || null, u.displayName || null, u.createdAt || new Date().toISOString(), handle, ip || "", ip || ""]);
        if (!r) return null;
      } catch (e) { if (isUnique(e)) return null; throw e; }
      cache.delete(email);
      return users.get(email);
    },
    async setPassword(email, salt, hash) {
      await db.run("UPDATE users SET salt = ?, hash = ? WHERE email = ?", [salt, hash, lc(email)]);
      cache.delete(lc(email));
    },
    async setDisplayName(email, name) { await db.run("UPDATE users SET display_name = ? WHERE email = ?", [name, lc(email)]); cache.delete(lc(email)); },
    async touchIp(email, ip) { await db.run("UPDATE users SET last_ip = ? WHERE email = ?", [ip || "", lc(email)]); },
    async remove(email) { await db.run("DELETE FROM users WHERE email = ?", [lc(email)]); cache.delete(lc(email)); },
    forget: (email) => cache.delete(lc(email)),
    async resolveHandle(h) {
      const k = lc(h).trim(); if (!k) return null;
      const r = await db.get("SELECT email FROM users WHERE email = ? OR handle = ? OR username = ?", [k, k, k]);
      return r ? r.email : null;
    },
    async search(q, limit) {
      const s = "%" + lc(q).replace(/[\\%_]/g, " ").trim() + "%";
      const rows = await db.all(SEL + " WHERE u.username LIKE ? OR LOWER(u.display_name) LIKE ? ORDER BY u.id DESC LIMIT ?", [s, s, limit || 30]);
      return rows.map(remember);
    },
    async list(q, limit) {
      const s = "%" + lc(q).replace(/[\\%_]/g, " ").trim() + "%";
      const rows = q
        ? await db.all(SEL + " WHERE u.email LIKE ? OR u.username LIKE ? OR LOWER(u.display_name) LIKE ? ORDER BY u.id DESC LIMIT ?", [s, s, s, limit || 100])
        : await db.all(SEL + " ORDER BY u.id DESC LIMIT ?", [limit || 100]);
      return rows.map(remember);
    },
    async count() { return Number((await db.get("SELECT COUNT(*) AS c FROM users")).c); },
    setAvatarVersion(email, v) { const u = cache.get(lc(email)); if (u) u.avatarV = v; }
  };
  // Synchronous helpers: they read the cache, so call `await users.warm([...])` first when rendering a list.
  const publicHandle = (email) => { const u = cache.get(lc(email)); return (u && u.handle) || hashHandle(email); };
  const displayNameOf = (email) => { const u = cache.get(lc(email)); return (u && (u.displayName || u.username)) || "User"; };
  const avatarUrl = (email) => { const u = cache.get(lc(email)); return u && u.avatarV ? "/api/avatar/" + publicHandle(email) + "?v=" + u.avatarV : null; };

  // ---------------------------------------------------
  // BANS  (a small set, refreshed from the database so every server copy agrees)
  // ---------------------------------------------------
  const bannedUsers = new Set();
  async function refreshBans() {
    const rows = await db.all("SELECT email FROM user_flags WHERE banned = 1");
    bannedUsers.clear(); rows.forEach((r) => bannedUsers.add(lc(r.email)));
  }
  async function setBan(email, banned, reason) {
    email = lc(email);
    await db.run(
      "INSERT INTO user_flags (email, banned, reason, banned_at) VALUES (?,?,?,?) ON CONFLICT (email) DO UPDATE SET banned = EXCLUDED.banned, reason = EXCLUDED.reason, banned_at = EXCLUDED.banned_at",
      [email, banned ? 1 : 0, String(reason || "").slice(0, 200), new Date().toISOString()]);
    if (banned) bannedUsers.add(email); else bannedUsers.delete(email);
  }

  // ---------------------------------------------------
  // HOST STATS & STARS
  // 10 coins = 5 Golden Stars (2 coins = 1 star). Gifts are saved in coins; every star number shown or paid out comes from here.
  const COINS_PER_STAR = 2;
  const starsOf = (coins) => Math.max(0, Math.floor(Number(coins || 0) / COINS_PER_STAR));
  // ---------------------------------------------------
  const statsRow = (r) => ({ gifts: Number(r ? r.gifts : 0), giftCoins: Number(r ? r.giftCoins : 0), loves: Number(r ? r.loves : 0), viewers: Number(r ? r.viewers : 0), withdrawnStars: Number(r ? r.withdrawnStars : 0) });
  async function getHostStats(host) {
    return statsRow(await db.get('SELECT gifts, gift_coins AS "giftCoins", loves, viewers, withdrawn_stars AS "withdrawnStars" FROM host_stats WHERE host_id = ?', [lc(host)]));
  }
  async function getWallet(host) {
    const s = await getHostStats(host);
    return { stars: Math.max(0, starsOf(s.giftCoins) - s.withdrawnStars), loves: s.loves };
  }
  // Hearts are free and not money, so they are counted in memory and saved every few seconds in ONE statement per host.
  // (Thousands of taps on one popular live would otherwise all fight over a single database row.)
  const pendingLoves = new Map();
  async function addLove(host) { host = lc(host); pendingLoves.set(host, (pendingLoves.get(host) || 0) + 1); }
  async function flushLoves() {
    if (!pendingLoves.size) return;
    const batch = [...pendingLoves].sort((a, b) => (a[0] < b[0] ? -1 : 1)); pendingLoves.clear();
    for (const [h, n] of batch) {
      try { await db.run("INSERT INTO host_stats (host_id, loves) VALUES (?, ?) ON CONFLICT (host_id) DO UPDATE SET loves = host_stats.loves + EXCLUDED.loves", [h, n]); }
      catch (e) { pendingLoves.set(h, (pendingLoves.get(h) || 0) + n); }
    }
  }
  async function addViewer(host) {
    const r = await db.get("INSERT INTO host_stats (host_id, viewers) VALUES (?, 1) ON CONFLICT (host_id) DO UPDATE SET viewers = host_stats.viewers + 1 RETURNING viewers", [lc(host)]);
    return Number(r.viewers);
  }

  const PAYOUT_HOLD_DAYS = Math.max(0, Number(process.env.PAYOUT_HOLD_DAYS || 7));
  // Stars a host may actually withdraw: held PAYOUT_HOLD_DAYS (chargeback window), minus stars that only went round in a
  // circle between two accounts, minus stars already paid out.
  async function starBreakdown(host, ex) {
    ex = ex || db; host = lc(host);
    const cutoffMs = Date.now() - PAYOUT_HOLD_DAYS * 86400000, cutoff = new Date(cutoffMs).toISOString();
    const total = Number((await ex.get("SELECT COALESCE(SUM(coin), 0) AS v FROM gift_transactions WHERE host_id = ?", [host])).v);
    const matured = Number((await ex.get("SELECT COALESCE(SUM(coin), 0) AS v FROM gift_transactions WHERE host_id = ? AND (coin < 0 OR created_at <= ?)", [host, cutoff])).v);
    const nxt = await ex.get("SELECT MIN(created_at) AS v FROM gift_transactions WHERE host_id = ? AND coin > 0 AND created_at > ?", [host, cutoff]);
    const circ = await ex.get(
      `SELECT COALESCE(SUM(CASE WHEN r.amt < s.amt THEN r.amt ELSE s.amt END), 0) AS v
         FROM (SELECT sender_id AS other, SUM(coin) AS amt FROM gift_transactions WHERE host_id = ? GROUP BY sender_id HAVING SUM(coin) > 0) r
         JOIN (SELECT host_id AS other, SUM(coin) AS amt FROM gift_transactions WHERE sender_id = ? GROUP BY host_id HAVING SUM(coin) > 0) s
           ON s.other = r.other`, [host, host]);
    const stats = await ex.get("SELECT withdrawn_stars AS v FROM host_stats WHERE host_id = ?", [host]);
    const withdrawn = Number(stats ? stats.v : 0);
    const totalC = total, maturedC = matured, circularC = Number(circ.v);   // coins -> stars below
    const nextMs = nxt && nxt.v ? new Date(nxt.v).getTime() : null;
    const total_ = starsOf(totalC), matured_ = starsOf(maturedC), circular = starsOf(circularC);
    return {
      total: total_, matured: matured_, onHold: Math.max(0, total_ - matured_), circular, withdrawn,
      earned: Math.max(0, total_ - withdrawn),                       // every star the host has, counting live (even while on hold)
      withdrawable: Math.max(0, matured_ - circular - withdrawn),
      holdDays: PAYOUT_HOLD_DAYS, nextReleaseAt: nextMs === null ? null : nextMs + PAYOUT_HOLD_DAYS * 86400000
    };
  }

  // ---------------------------------------------------
  // RANKINGS (SQL, so they stay fast with millions of gifts)
  // ---------------------------------------------------
  async function hostRanking(sinceIso, limit) {
    limit = Math.min(500, Number(limit) || 100);
    if (!sinceIso) {
      return db.all(
        `SELECT host_id AS "hostId", CASE WHEN gift_coins / 2 - withdrawn_stars > 0 THEN gift_coins / 2 - withdrawn_stars ELSE 0 END AS "goldenStars",
                gifts, loves, viewers FROM host_stats WHERE gift_coins > 0 OR loves > 0 ORDER BY gift_coins / 2 - withdrawn_stars DESC LIMIT ?`, [limit]);
    }
    return db.all(
      `SELECT host_id AS "hostId", SUM(golden_stars) / 2 AS "goldenStars", SUM(CASE WHEN coin > 0 THEN 1 ELSE 0 END) AS gifts
         FROM gift_transactions WHERE created_at >= ? GROUP BY host_id HAVING SUM(golden_stars) > 0 ORDER BY SUM(golden_stars) DESC LIMIT ?`, [sinceIso, limit]);
  }
  async function gifterRanking(sinceIso, limit) {
    limit = Math.min(500, Number(limit) || 100);
    return db.all(
      `SELECT sender_id AS "senderId", SUM(coin) AS coin, SUM(CASE WHEN coin > 0 THEN 1 ELSE 0 END) AS gifts
         FROM gift_transactions ${sinceIso ? "WHERE created_at >= ?" : ""} GROUP BY sender_id HAVING SUM(coin) > 0 ORDER BY SUM(coin) DESC LIMIT ?`,
      sinceIso ? [sinceIso, limit] : [limit]);
  }
  async function recentGiftsTo(host, limit) {
    return db.all('SELECT id, gift, coin, sender_id AS "senderId", created_at AS "createdAt" FROM gift_transactions WHERE host_id = ? AND coin > 0 ORDER BY created_at DESC LIMIT ?', [lc(host), limit || 30]);
  }
  async function allGifts(limit) {
    return db.all('SELECT id, gift, coin, sender_id AS "senderId", host_id AS "hostId", golden_stars AS "goldenStars", created_at AS "createdAt" FROM gift_transactions ORDER BY created_at DESC LIMIT ?', [Math.min(1000, Number(limit) || 500)]);
  }
  async function giftTotals() {
    const r = await db.get("SELECT COALESCE(SUM(coin), 0) AS coins, COUNT(*) AS n FROM gift_transactions WHERE coin > 0");
    return { coins: Number(r.coins), count: Number(r.n) };
  }

  // ---------------------------------------------------
  // LIVE SESSIONS (real broadcast time, used for the monthly live-hours rule)
  // ---------------------------------------------------
  async function sessionStart(host, roomId) {
    const now = Date.now();
    await db.run("INSERT INTO live_sessions (host_id, room_id, started_at, last_beat) VALUES (?,?,?,?)", [lc(host), roomId, now, now]);
  }
  async function sessionEnd(host, roomId) {
    await db.run("UPDATE live_sessions SET ended_at = ? WHERE room_id = ? AND host_id = ? AND ended_at IS NULL", [Date.now(), roomId, lc(host)]);
  }
  async function sessionBeat(roomId) { await db.run("UPDATE live_sessions SET last_beat = ? WHERE room_id = ? AND ended_at IS NULL", [Date.now(), roomId]); }
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  async function monthlyLiveStatus(host, dailyRequiredHours) {
    const now = new Date(), year = now.getFullYear(), month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const from = new Date(year, month, 1).getTime(), to = new Date(year, month + 1, 1).getTime();
    const rows = await db.all('SELECT started_at AS "startedAt", ended_at AS "endedAt" FROM live_sessions WHERE host_id = ? AND started_at >= ? AND started_at < ?', [lc(host), from, to]);
    const hoursByDay = {}; for (let d = 1; d <= daysInMonth; d++) hoursByDay[d] = 0;
    for (const s of rows) {
      const start = new Date(s.startedAt), end = s.endedAt ? new Date(s.endedAt) : now;
      hoursByDay[start.getDate()] += Math.max(0, (end - start) / 3600000);
    }
    const days = Object.keys(hoursByDay).map((d) => ({ day: Number(d), hours: Number(hoursByDay[d].toFixed(2)), complete: hoursByDay[d] >= dailyRequiredHours }));
    const completedDays = days.filter((d) => d.complete).length;
    const todayHours = Number((hoursByDay[now.getDate()] || 0).toFixed(2));
    return {
      month: MONTH_NAMES[month] + " " + year, daysInMonth, completedDays, remainingDays: Math.max(0, daysInMonth - completedDays),
      dailyRequiredHours, todayHours, todayComplete: todayHours >= dailyRequiredHours, monthlyRequirementComplete: completedDays >= daysInMonth, days
    };
  }

  // ---------------------------------------------------
  // WITHDRAWALS
  // ---------------------------------------------------
  const secRow = (r) => ({ failedAttempts: r ? Number(r.failedAttempts) : 0, banned: !!(r && r.banned), disqualified: !!(r && r.disqualified), lastAttemptAt: r ? r.lastAttemptAt : null });
  const SEC_SEL = 'SELECT creator_id AS "creatorId", failed_attempts AS "failedAttempts", banned, disqualified, last_attempt_at AS "lastAttemptAt" FROM withdrawal_security';
  async function getWithdrawalSecurity(id) { return secRow(await db.get(SEC_SEL + " WHERE creator_id = ?", [lc(id)])); }
  async function saveWithdrawalSecurity(id, s) {
    await db.run(
      `INSERT INTO withdrawal_security (creator_id, failed_attempts, banned, disqualified, last_attempt_at) VALUES (?,?,?,?,?)
       ON CONFLICT (creator_id) DO UPDATE SET failed_attempts = EXCLUDED.failed_attempts, banned = EXCLUDED.banned, disqualified = EXCLUDED.disqualified, last_attempt_at = EXCLUDED.last_attempt_at`,
      [lc(id), s.failedAttempts, s.banned ? 1 : 0, s.disqualified ? 1 : 0, s.lastAttemptAt]);
  }
  async function listWithdrawalSecurity() { return (await db.all(SEC_SEL + " ORDER BY creator_id LIMIT 500")).map((r) => ({ creatorId: r.creatorId, ...secRow(r) })); }
  const WD_SEL = `SELECT id, creator_id AS "creatorId", method, account_name AS "accountName", bank_name AS "bankName", account_number AS "accountNumber",
                         amount, currency, stars, stars_spent AS "starsSpent", month, status, security_status AS "securityStatus", created_at AS "createdAt"
                    FROM withdrawal_requests`;
  const listWithdrawals = (limit) => db.all(WD_SEL + " ORDER BY created_at DESC LIMIT ?", [Math.min(1000, Number(limit) || 300)]);
  const withdrawalsOf = (creator, limit) => db.all(WD_SEL + " WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?", [lc(creator), limit || 50]);
  const withdrawalCount = async () => Number((await db.get("SELECT COUNT(*) AS c FROM withdrawal_requests")).c);
  // Saves the request and spends the stars in ONE transaction, after re-checking the stars under a per-creator lock,
  // so two withdrawals sent at the same instant can never spend the same stars twice.
  async function recordWithdrawal(request, starsSpent) {
    const host = lc(request.creatorId);
    return db.tx(async (t) => {
      await t.lock("withdraw:" + host);
      const b = await starBreakdown(host, t);
      if (b.withdrawable < starsSpent) return { ok: false, withdrawable: b.withdrawable };
      await t.run(
        `INSERT INTO host_stats (host_id, withdrawn_stars) VALUES (?, ?) ON CONFLICT (host_id) DO UPDATE SET withdrawn_stars = host_stats.withdrawn_stars + EXCLUDED.withdrawn_stars`,
        [host, starsSpent]);
      await t.run(
        `INSERT INTO withdrawal_requests (id, creator_id, method, account_name, bank_name, account_number, amount, currency, stars, stars_spent, month, status, security_status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [request.id, host, request.method, request.accountName, request.bankName, request.accountNumber, request.amount, request.currency,
         request.stars, starsSpent, request.month, request.status, request.securityStatus, request.createdAt]);
      return { ok: true };
    });
  }

  // ---------------------------------------------------
  // CHAT  (old messages are deleted after 7 days to keep the table small)
  // ---------------------------------------------------
  async function saveChat(roomId, name, isHost, text) {
    const ts = Date.now();
    await db.run("INSERT INTO chat_messages (room_id, sender_name, is_host, text, created_at) VALUES (?,?,?,?,?)", [String(roomId), String(name).slice(0, 40), isHost ? 1 : 0, String(text).slice(0, 300), ts]);
    return ts;
  }
  async function chatHistory(roomId, limit) {
    const rows = await db.all('SELECT sender_name AS name, is_host AS "isHost", text, created_at AS ts FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?', [String(roomId), Math.min(100, Number(limit) || 50)]);
    return rows.reverse().map((r) => ({ type: "chat", name: r.name, isHost: !!r.isHost, text: r.text, ts: Number(r.ts) }));
  }
  async function pruneOld() {
    await db.run("DELETE FROM chat_messages WHERE created_at < ?", [Date.now() - 7 * 86400000]);
    await db.run("DELETE FROM notifications WHERE created_at < ?", [Date.now() - 30 * 86400000]);
    await db.run("DELETE FROM password_resets WHERE expires_at < ?", [Date.now() - 86400000]);
  }

  async function followerCount(host) { return Number((await db.get("SELECT COUNT(*) AS c FROM follows WHERE host_id = ?", [lc(host)])).c); }

  return {
    users, publicHandle, displayNameOf, avatarUrl, hashHandle, bannedUsers, refreshBans, setBan,
    getHostStats, getWallet, starsOf, COINS_PER_STAR, addLove, flushLoves, addViewer, starBreakdown, PAYOUT_HOLD_DAYS,
    hostRanking, gifterRanking, recentGiftsTo, allGifts, giftTotals,
    sessionStart, sessionEnd, sessionBeat, monthlyLiveStatus,
    getWithdrawalSecurity, saveWithdrawalSecurity, listWithdrawalSecurity, listWithdrawals, withdrawalsOf, withdrawalCount, recordWithdrawal,
    saveChat, chatHistory, pruneOld, followerCount
  };
};
