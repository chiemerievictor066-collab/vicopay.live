// =====================================================
// Vico Pay Live — INVITE FRIENDS & EARN COINS (referral system)
// =====================================================
// Added WITHOUT touching existing tables or routes:
//   * new tables only (CREATE TABLE IF NOT EXISTS): referral_settings, referral_codes, referrals, referral_rewards, referral_events
//   * coins are paid into the EXISTING balances row through ledger.creditBonus, so they show in the normal coin history and the ledger
//     check (balances = sum of ledger entries) stays true. There is no second wallet.
//   * every rule is decided here on the server; the pages only show what the server returns.
// Plugged in from server.js with:   const referrals = require("./referrals")({ app, db, requireAuth, requireAdmin, ledger });
//
// Milestones are CUMULATIVE totals (default 5 friends = 10 coins, 10 friends = 20, 20 friends = 30). Reaching 5 pays 10, reaching 10 pays
// 10 more (total 20), reaching 20 pays 10 more (total 30). An admin can change the counts and totals in admin-referrals.html.
// =====================================================
const crypto = require("crypto");

// ---- pure rule: which milestones are newly reached and how many coins each one pays now ----
// milestones: [{count, total}] (total = cumulative coins at that milestone); paid: milestone counts already paid.
function planRewards(qualifiedCount, milestones, paid) {
  const list = (milestones || []).slice().sort((a, b) => a.count - b.count);
  const done = new Set((paid || []).map(Number));
  const out = [];
  let prevTotal = 0;
  for (const m of list) {
    const coins = Number(m.total) - prevTotal;
    prevTotal = Number(m.total);
    if (qualifiedCount >= m.count && !done.has(Number(m.count)) && coins > 0) out.push({ count: Number(m.count), coins });
  }
  return out;
}

// ---- pure rule: validate the milestone list an admin sends ----
function cleanMilestones(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) return { error: "Add between 1 and 10 milestones." };
  const out = [];
  let lastCount = 0, lastTotal = 0;
  for (const m of input) {
    const count = Number(m && m.count), total = Number(m && m.total);
    if (!Number.isInteger(count) || count < 1 || count > 100000) return { error: "Each milestone needs a whole number of friends (1 or more)." };
    if (!Number.isInteger(total) || total < 1 || total > 1000000) return { error: "Each reward must be a whole number of coins (1 to 1,000,000)." };
    if (count <= lastCount) return { error: "Friend counts must go up (for example 5, 10, 20)." };
    if (total <= lastTotal) return { error: "Total coins must go up with each milestone (for example 10, 20, 30)." };
    out.push({ count, total }); lastCount = count; lastTotal = total;
  }
  return { milestones: out };
}

const maskName = (name) => {
  const s = String(name || "").trim();
  if (!s) return "New user";
  if (s.length <= 3) return s[0] + "**";
  return s.slice(0, 2) + "*".repeat(Math.min(5, s.length - 3)) + s.slice(-1);
};

module.exports = function makeReferrals({ app, db, requireAuth, requireAdmin, ledger, emailVerified }) {
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const bad = (res, msg, code) => res.status(code || 400).json({ success: false, message: msg });

  const DEFAULTS = {
    enabled: "1",
    milestones: JSON.stringify([{ count: 5, total: 10 }, { count: 10, total: 20 }, { count: 20, total: 30 }]),
    requireProfile: "1",     // invited user has a username and a bio or a photo
    requireActivity: "1",    // invited user bought coins, sent a gift, joined a fan club, or went live
    requireEmail: "1",       // invited user must verify their email (6-digit code sent with Resend, see email-verify.js)
    maxSameIp: "2"           // more signups than this from ONE network address for the same inviter are held for review
  };

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS referral_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS referral_codes (user_email TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      inviter_email TEXT NOT NULL,
      invited_email TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      signup_ip TEXT,
      flagged SMALLINT NOT NULL DEFAULT 0,
      flag_reason TEXT,
      created_at BIGINT NOT NULL,
      qualified_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_email, status)`,
    `CREATE TABLE IF NOT EXISTS referral_rewards (
      id BIGSERIAL PRIMARY KEY,
      inviter_email TEXT NOT NULL,
      milestone_count INTEGER NOT NULL,
      coins BIGINT NOT NULL,
      txn_id BIGINT,
      created_at BIGINT NOT NULL,
      UNIQUE (inviter_email, milestone_count)
    )`,
    `CREATE TABLE IF NOT EXISTS referral_events (id BIGSERIAL PRIMARY KEY, referral_id BIGINT, action TEXT NOT NULL, detail TEXT, created_at BIGINT NOT NULL)`
  ];

  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(727276)");
      for (const sql of SCHEMA) await client.query(sql);
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(727276)"); } catch (_) { /* ignore */ }
      client.release();
    }
  })().catch((e) => { console.error("REFERRALS MIGRATE ERROR:", e); });

  // ---------- settings ----------
  async function settings() {
    const rows = await db.all("SELECT key, value FROM referral_settings");
    const s = { ...DEFAULTS };
    for (const r of rows) s[r.key] = r.value;
    let milestones; try { milestones = JSON.parse(s.milestones); } catch (_) { milestones = JSON.parse(DEFAULTS.milestones); }
    return {
      enabled: s.enabled === "1", milestones,
      requireProfile: s.requireProfile === "1", requireActivity: s.requireActivity === "1", requireEmail: s.requireEmail === "1",
      maxSameIp: Math.max(1, Number(s.maxSameIp) || 2)
    };
  }
  async function saveSetting(key, value) {
    await db.run("INSERT INTO referral_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [key, String(value), now()]);
  }

  // ---------- codes ----------
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";      // no 0/O/1/I so a code is easy to read out
  const makeCode = () => "VPL" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");
  async function codeFor(email) {
    email = lc(email);
    const have = await db.get("SELECT code FROM referral_codes WHERE user_email = ?", [email]);
    if (have) return have.code;
    for (let i = 0; i < 8; i++) {
      const code = makeCode();
      const r = await db.get("INSERT INTO referral_codes (user_email, code, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING code", [email, code, now()]);
      if (r) return r.code;
      const again = await db.get("SELECT code FROM referral_codes WHERE user_email = ?", [email]);   // another request made it first
      if (again) return again.code;
    }
    throw new Error("could not make a referral code");
  }
  const validCodeShape = (c) => /^VPL[A-Z2-9]{6}$/.test(String(c || "").trim().toUpperCase());

  // ---------- 1. a new account signs up with a code ----------
  // Called from /api/auth/register. NEVER throws: a referral problem must not stop someone from creating an account.
  async function recordSignup({ invitedEmail, code, ip }) {
    try {
      await ready;
      invitedEmail = lc(invitedEmail); code = String(code || "").trim().toUpperCase();
      if (!invitedEmail || !validCodeShape(code)) return { ok: false, reason: "no_code" };
      const S = await settings(); if (!S.enabled) return { ok: false, reason: "disabled" };
      const owner = await db.get("SELECT user_email FROM referral_codes WHERE code = ?", [code]);
      if (!owner) return { ok: false, reason: "unknown_code" };
      const inviter = lc(owner.user_email);
      let status = "pending", reason = null, flagged = 0, flagReason = null;
      if (inviter === invitedEmail) { status = "rejected"; reason = "self_referral"; }
      else {
        const inv = await db.get("SELECT signup_ip, last_ip FROM users WHERE email = ?", [inviter]);
        if (ip && inv && (inv.signup_ip === ip || inv.last_ip === ip)) { flagged = 1; flagReason = "Same network address as the inviter"; }
        else if (ip) {
          const same = await db.get("SELECT COUNT(*) AS c FROM referrals WHERE inviter_email = ? AND signup_ip = ?", [inviter, ip]);
          if (Number(same.c) >= S.maxSameIp) { flagged = 1; flagReason = "Many signups from one network address"; }
        }
      }
      const row = await db.get(
        "INSERT INTO referrals (inviter_email, invited_email, code, status, reject_reason, signup_ip, flagged, flag_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (invited_email) DO NOTHING RETURNING id",
        [inviter, invitedEmail, code, status, reason, ip || null, flagged, flagReason, now()]);
      return { ok: !!row, status, flagged: !!flagged };
    } catch (e) { console.error("REFERRAL SIGNUP ERROR:", e); return { ok: false, reason: "error" }; }
  }

  // ---------- 2. is an invited account a real, qualified user yet? ----------
  async function qualification(invitedEmail, S) {
    const e = lc(invitedEmail);
    const fl = await db.get("SELECT banned FROM user_flags WHERE email = ?", [e]);
    if (fl && Number(fl.banned)) return { state: "reject", reason: "account_banned" };
    const u = await db.get("SELECT username FROM users WHERE email = ?", [e]);
    if (!u) return { state: "reject", reason: "account_missing" };
    if (S.requireProfile) {
      const hasName = !!(u.username && String(u.username).trim());
      const pic = await db.get("SELECT 1 AS x FROM avatars WHERE email = ?", [e]);
      const bio = await db.get("SELECT bio FROM profiles WHERE email = ?", [e]);
      if (!(hasName && (pic || (bio && String(bio.bio || "").trim())))) return { state: "wait", reason: "profile_incomplete" };
    }
    if (S.requireActivity) {
      const a = await db.get(
        `SELECT (SELECT COUNT(*) FROM payments WHERE email = ? AND status = 'ok')
              + (SELECT COUNT(*) FROM gift_transactions WHERE sender_id = ?)
              + (SELECT COUNT(*) FROM fan_members WHERE user_id = ?)
              + (SELECT COUNT(*) FROM live_sessions WHERE host_id = ?) AS n`, [e, e, e, e]);
      if (!(Number(a.n) > 0)) return { state: "wait", reason: "no_activity" };
    }
    if (S.requireEmail && emailVerified && !(await emailVerified(e))) return { state: "wait", reason: "email_not_verified" };
    return { state: "ok" };
  }

  // ---------- 3. count qualified referrals and pay new milestones (safe to run again and again) ----------
  async function evaluate(inviterEmail) {
    await ready;
    const inviter = lc(inviterEmail);
    const S = await settings(); if (!S.enabled) return { paid: [] };
    const pend = await db.all("SELECT id, invited_email AS \"invitedEmail\" FROM referrals WHERE inviter_email = ? AND status = 'pending' AND flagged = 0", [inviter]);
    for (const r of pend) {
      const q = await qualification(r.invitedEmail, S);
      if (q.state === "ok") await db.run("UPDATE referrals SET status = 'qualified', qualified_at = ? WHERE id = ? AND status = 'pending' AND flagged = 0", [now(), r.id]);
      else if (q.state === "reject") await db.run("UPDATE referrals SET status = 'rejected', reject_reason = ? WHERE id = ? AND status = 'pending'", [q.reason, r.id]);
    }
    const qc = await db.get("SELECT COUNT(*) AS c FROM referrals WHERE inviter_email = ? AND status = 'qualified' AND flagged = 0", [inviter]);
    const paidRows = await db.all("SELECT milestone_count AS c FROM referral_rewards WHERE inviter_email = ?", [inviter]);
    const plan = planRewards(Number(qc.c), S.milestones, paidRows.map((r) => r.c));
    const paid = [];
    for (const step of plan) {
      const res = await ledger.creditBonus({
        email: inviter, coins: step.coins, kind: "referral", reference: "REF-" + inviter + "-" + step.count,
        memo: "Referral reward: " + step.count + " friends joined",
        guard: async (t, ts) => !!(await t.get(
          "INSERT INTO referral_rewards (inviter_email, milestone_count, coins, created_at) VALUES (?,?,?,?) ON CONFLICT (inviter_email, milestone_count) DO NOTHING RETURNING id",
          [inviter, step.count, step.coins, ts]))
      });
      if (res.credited) {
        await db.run("UPDATE referral_rewards SET txn_id = ? WHERE inviter_email = ? AND milestone_count = ?", [res.txnId, inviter, step.count]);
        paid.push(step);
      }
    }
    return { paid };
  }

  // background: invited friends become active while the inviter is away, so check pending referrals every 5 minutes
  async function sweep() {
    try {
      await ready;
      const rows = await db.all("SELECT DISTINCT inviter_email AS e FROM referrals WHERE status = 'pending' AND flagged = 0 LIMIT 200");
      for (const r of rows) { try { await evaluate(r.e); } catch (e) { console.error("REFERRAL SWEEP ERROR:", e.message); } }
    } catch (e) { console.error("REFERRAL SWEEP ERROR:", e.message); }
  }
  const timer = setInterval(sweep, 5 * 60 * 1000); if (timer.unref) timer.unref();

  const baseUrl = (req) => (process.env.PUBLIC_URL || process.env.APP_URL || (req.protocol + "://" + req.get("host"))).replace(/\/+$/, "");

  // ---------- user routes ----------
  app.get("/invite/:code", (req, res) => {
    const c = String(req.params.code || "").toUpperCase();
    res.redirect(302, validCodeShape(c) ? "/signup.html?ref=" + encodeURIComponent(c) : "/signup.html");
  });

  app.get("/api/referrals/check", async (req, res) => {          // the sign-up page asks "is this a real code?" (nothing else is revealed)
    try { await ready; const c = String(req.query.code || "").trim().toUpperCase();
      if (!validCodeShape(c)) return res.json({ success: true, valid: false });
      const r = await db.get("SELECT 1 AS x FROM referral_codes WHERE code = ?", [c]);
      return res.json({ success: true, valid: !!r });
    } catch (e) { return res.json({ success: true, valid: false }); }
  });

  app.get("/api/referrals/me", requireAuth, async (req, res) => {
    try {
      await ready;
      const me = req.userEmail;
      const S = await settings();
      const code = await codeFor(me);
      try { await evaluate(me); } catch (e) { console.error("REFERRAL EVALUATE ERROR:", e.message); }
      const rows = await db.all(
        `SELECT r.id, r.status, r.flagged, r.created_at AS "createdAt", r.qualified_at AS "qualifiedAt", u.username, u.display_name AS "displayName"
         FROM referrals r LEFT JOIN users u ON u.email = r.invited_email WHERE r.inviter_email = ? ORDER BY r.id DESC LIMIT 200`, [me]);
      const rewards = await db.all("SELECT milestone_count AS \"count\", coins, created_at AS \"createdAt\" FROM referral_rewards WHERE inviter_email = ? ORDER BY milestone_count", [me]);
      const qualified = rows.filter((r) => r.status === "qualified" && !Number(r.flagged)).length;
      const earned = rewards.reduce((a, r) => a + Number(r.coins), 0);
      const paidCounts = new Set(rewards.map((r) => Number(r.count)));
      const rewardAt = {}; let prev = 0;
      for (const m of S.milestones) { rewardAt[m.count] = m.total - prev; prev = m.total; }
      // the friend who completed a paid milestone shows that milestone's coins ("Rewarded")
      const qSorted = rows.filter((r) => r.status === "qualified" && !Number(r.flagged)).sort((a, b) => Number(a.qualifiedAt) - Number(b.qualifiedAt) || a.id - b.id);
      const rewardedId = {}; qSorted.forEach((r, i) => { if (paidCounts.has(i + 1)) rewardedId[r.id] = rewardAt[i + 1] || 0; });
      const history = rows.map((r) => ({
        username: maskName(r.username || r.displayName), joined: Number(r.createdAt),
        status: r.status === "rejected" ? "rejected" : r.status === "qualified" && !Number(r.flagged) ? (rewardedId[r.id] !== undefined ? "rewarded" : "qualified") : "pending",
        reward: rewardedId[r.id] || 0
      }));
      const base = baseUrl(req);
      return res.json({
        success: true, enabled: S.enabled, code, link: base + "/invite/" + code,
        milestones: S.milestones.map((m) => ({ ...m, reached: qualified >= m.count, paid: paidCounts.has(m.count) })),
        stats: {
          totalInvites: rows.length, successful: qualified,
          pending: rows.filter((r) => r.status === "pending" || (r.status === "qualified" && Number(r.flagged))).length,
          rejected: rows.filter((r) => r.status === "rejected").length, coinsEarned: earned
        },
        history, rewards: rewards.map((r) => ({ count: Number(r.count), coins: Number(r.coins), at: Number(r.createdAt) })),
        balance: await ledger.getBalance(me),
        emailVerified: emailVerified ? await emailVerified(me) : true
      });
    } catch (e) { console.error("REFERRALS ME ERROR:", e); return bad(res, "Could not load your referrals.", 500); }
  });

  // ---------- admin routes ----------
  app.get("/api/admin/referrals/overview", requireAdmin, async (req, res) => {
    try {
      await ready;
      const S = await settings();
      const by = await db.all("SELECT status, flagged, COUNT(*) AS c FROM referrals GROUP BY status, flagged");
      const n = (st, fl) => by.filter((r) => r.status === st && (fl === undefined || Number(r.flagged) === fl)).reduce((a, r) => a + Number(r.c), 0);
      const awarded = await db.get("SELECT COALESCE(SUM(coins),0) AS c, COUNT(*) AS n FROM referral_rewards");
      const top = await db.all(
        `SELECT inviter_email AS email, COUNT(*) FILTER (WHERE status = 'qualified' AND flagged = 0) AS qualified, COUNT(*) AS total
         FROM referrals GROUP BY inviter_email ORDER BY 2 DESC, 3 DESC LIMIT 10`);
      return res.json({ success: true, settings: S, stats: {
        total: by.reduce((a, r) => a + Number(r.c), 0), pending: n("pending", 0), qualified: n("qualified", 0), rejected: n("rejected"),
        flagged: by.filter((r) => Number(r.flagged) === 1 && r.status !== "rejected").reduce((a, r) => a + Number(r.c), 0),
        coinsAwarded: Number(awarded.c), rewardsPaid: Number(awarded.n)
      }, top: top.map((r) => ({ email: r.email, qualified: Number(r.qualified), total: Number(r.total) })) });
    } catch (e) { console.error(e); return bad(res, "Could not load referral overview.", 500); }
  });

  app.post("/api/admin/referrals/settings", requireAdmin, async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      if (b.milestones !== undefined) {
        const c = cleanMilestones(b.milestones); if (c.error) return bad(res, c.error);
        await saveSetting("milestones", JSON.stringify(c.milestones));
      }
      for (const k of ["enabled", "requireProfile", "requireActivity", "requireEmail"]) if (b[k] !== undefined) await saveSetting(k, b[k] ? "1" : "0");
      if (b.maxSameIp !== undefined) {
        const n = Math.floor(Number(b.maxSameIp)); if (!Number.isFinite(n) || n < 1 || n > 50) return bad(res, "Signups per network address must be 1 to 50.");
        await saveSetting("maxSameIp", n);
      }
      return res.json({ success: true, settings: await settings() });
    } catch (e) { console.error(e); return bad(res, "Could not save settings.", 500); }
  });

  app.get("/api/admin/referrals/list", requireAdmin, async (req, res) => {
    try {
      await ready;
      const f = String(req.query.filter || "all");
      const where = f === "flagged" ? "WHERE r.flagged = 1 AND r.status <> 'rejected'" : ["pending", "qualified", "rejected"].includes(f) ? "WHERE r.status = '" + f + "'" : "";
      const rows = await db.all(
        `SELECT r.id, r.inviter_email AS inviter, r.invited_email AS invited, r.code, r.status, r.flagged, r.flag_reason AS "flagReason", r.reject_reason AS "rejectReason",
                r.signup_ip AS ip, r.created_at AS "createdAt", r.qualified_at AS "qualifiedAt"
         FROM referrals r ${where} ORDER BY r.id DESC LIMIT 300`);
      return res.json({ success: true, referrals: rows.map((r) => ({ ...r, flagged: !!Number(r.flagged), createdAt: Number(r.createdAt), qualifiedAt: r.qualifiedAt ? Number(r.qualifiedAt) : null })) });
    } catch (e) { console.error(e); return bad(res, "Could not load referrals.", 500); }
  });

  app.get("/api/admin/referrals/rewards", requireAdmin, async (req, res) => {
    try {
      await ready;
      const rows = await db.all("SELECT id, inviter_email AS inviter, milestone_count AS \"count\", coins, txn_id AS \"txnId\", created_at AS \"createdAt\" FROM referral_rewards ORDER BY id DESC LIMIT 300");
      return res.json({ success: true, rewards: rows.map((r) => ({ ...r, coins: Number(r.coins), createdAt: Number(r.createdAt) })) });
    } catch (e) { console.error(e); return bad(res, "Could not load rewards.", 500); }
  });

  // flag = hold it (not counted) · approve = clear the flag, it can qualify normally · reject = never counts
  app.post("/api/admin/referrals/:id/action", requireAdmin, async (req, res) => {
    try {
      await ready;
      const id = Math.floor(Number(req.params.id)); const action = String((req.body && req.body.action) || ""); const why = String((req.body && req.body.reason) || "").slice(0, 200);
      if (!Number.isFinite(id)) return bad(res, "Unknown referral.");
      const cur = await db.get("SELECT id, inviter_email AS inviter, status FROM referrals WHERE id = ?", [id]);
      if (!cur) return bad(res, "Unknown referral.", 404);
      if (action === "flag") await db.run("UPDATE referrals SET flagged = 1, flag_reason = ? WHERE id = ?", [why || "Flagged by admin", id]);
      else if (action === "approve") await db.run("UPDATE referrals SET flagged = 0, flag_reason = NULL, status = CASE WHEN status = 'rejected' THEN 'pending' ELSE status END, reject_reason = NULL WHERE id = ?", [id]);
      else if (action === "reject") await db.run("UPDATE referrals SET status = 'rejected', reject_reason = ? WHERE id = ?", [why || "Rejected by admin", id]);
      else return bad(res, "Choose flag, approve or reject.");
      await db.run("INSERT INTO referral_events (referral_id, action, detail, created_at) VALUES (?,?,?,?)", [id, action, why, now()]);
      if (action === "approve") { try { await evaluate(cur.inviter); } catch (_) { /* the 5-minute check will retry */ } }
      return res.json({ success: true });
    } catch (e) { console.error(e); return bad(res, "Could not update that referral.", 500); }
  });

  // Resend told us an address bounced or complained: a pending referral that used it is a fake/unreachable account
  async function rejectForEmail(addr) {
    await ready;
    await db.run("UPDATE referrals SET status = 'rejected', reject_reason = 'email_bounced' WHERE invited_email = ? AND status = 'pending'", [lc(addr)]);
  }

  return { recordSignup, evaluate, rejectForEmail, codeFor, planRewards, cleanMilestones, ready };
};
module.exports.planRewards = planRewards;
module.exports.cleanMilestones = cleanMilestones;
