// VicoPay Live — monthly appreciation announcements and annual consistency reward.
"use strict";

module.exports = function setupAppreciation({ app, db, ledger, requireAuth, hostRulesFor }) {
  const liveHours = require("./live-hours");
  const TZ = Number(process.env.PAYOUT_TZ_OFFSET_MIN || 60);
  const COIN_REWARD = 20;

  async function migrate() {
    await db.run(`CREATE TABLE IF NOT EXISTS appreciation_monthly_sent (
      user_id TEXT NOT NULL, month_key TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(user_id, month_key)
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS appreciation_yearly_awards (
      user_id TEXT NOT NULL, award_year INTEGER NOT NULL, coins INTEGER NOT NULL DEFAULT 20,
      created_at BIGINT NOT NULL, PRIMARY KEY(user_id, award_year)
    )`);
    await db.run("CREATE INDEX IF NOT EXISTS idx_appreciation_year ON appreciation_yearly_awards(award_year)");
  }

  function localParts(now = new Date()) {
    const d = new Date(now.getTime() + TZ * 60000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  function monthKey(year, month) { return `${year}-${String(month).padStart(2, "0")}`; }

  async function streamerIds() {
    const rows = await db.all(
      `SELECT host_id AS id FROM host_stats
       UNION SELECT host_id AS id FROM live_sessions
       UNION SELECT email AS id FROM users WHERE email IN (SELECT host_id FROM host_stats)`
    );
    return [...new Set(rows.map(r => String(r.id || "").toLowerCase()).filter(Boolean))];
  }

  async function sendMonthlyAppreciation(year, month) {
    const key = monthKey(year, month), now = Date.now();
    const ids = await streamerIds();
    let sent = 0;
    for (const userId of ids) {
      const delivered = await db.tx(async (t) => {
        const result = await t.get(
          `INSERT INTO appreciation_monthly_sent(user_id, month_key, created_at)
           VALUES(?,?,?) ON CONFLICT(user_id, month_key) DO NOTHING RETURNING user_id`,
          [userId, key, now]
        );
        if (!result) return false;
        await t.run(
          "INSERT INTO notifications(user_id,text,link,read,created_at) VALUES(?,?,?,?,?)",
          [userId, "Monthly Appreciation: Thank you for being part of Vico Pay Live. We appreciate your support and participation!", `appreciation.html?type=monthly&month=${key}`, 0, now]
        );
        return true;
      });
      if (delivered) sent++;
    }
    return { month: key, sent };
  }

  async function monthEligibility(userId, year, month) {
    const key = monthKey(year, month);
    const win = liveHours.monthWindow(key, TZ);
    const sessions = await db.all(
      `SELECT started_at, ended_at, last_beat FROM live_sessions
       WHERE host_id = ? AND started_at < ?
       AND COALESCE(ended_at,last_beat,started_at) > ?`,
      [userId, win.endMs, win.startMs]
    );
    const perDay = liveHours.liveHoursPerDay(sessions, win);
    const rules = await hostRulesFor(userId);
    const live = liveHours.checkLive(perDay, { dailyHours: rules.dailyHours, monthlyHours: rules.monthlyHours });
    const starsRow = await db.get(
      `SELECT COALESCE(SUM(golden_stars),0) AS stars FROM gift_transactions
       WHERE host_id = ? AND created_at >= ? AND created_at < ?`,
      [userId, new Date(win.startMs).toISOString(), new Date(win.endMs).toISOString()]
    );
    const stars = Number(starsRow && starsRow.stars || 0);
    return {
      month: key, stars, requiredStars: Number(rules.minStars || 3000),
      dailyComplete: live.everyDay, hoursComplete: live.enoughHours,
      starsComplete: stars >= Number(rules.minStars || 3000),
      eligible: live.everyDay && live.enoughHours && stars >= Number(rules.minStars || 3000)
    };
  }

  async function awardYear(userId, awardYear) {
    const checks = [];
    for (let month = 1; month <= 12; month++) {
      checks.push(await monthEligibility(userId, awardYear, month));
      if (!checks[checks.length - 1].eligible) return { eligible: false, checks };
    }
    const reference = `vico-yearly-appreciation-${awardYear}-${userId}`;
    const result = await ledger.creditBonus({
      email: userId, coins: COIN_REWARD, kind: "yearly_appreciation",
      reference, memo: `Vico Pay Live ${awardYear} Yearly Appreciation — 20 coins`,
      guard: async (t, ts) => {
        const inserted = await t.get(
          `INSERT INTO appreciation_yearly_awards(user_id,award_year,coins,created_at)
           VALUES(?,?,?,?) ON CONFLICT(user_id,award_year) DO NOTHING RETURNING user_id`,
          [userId, awardYear, COIN_REWARD, ts]
        );
        if (!inserted) return false;
        await t.run(
          "INSERT INTO notifications(user_id,text,link,read,created_at) VALUES(?,?,?,?,?)",
          [userId, `Congratulations! You completed all 12 monthly requirements for ${awardYear}. 20 coins have been awarded to you for your consistency on Vico Pay Live.`, `appreciation.html?type=yearly&year=${awardYear}`, 0, ts]
        );
        return true;
      }
    });
    return { eligible: !!result.credited, alreadyAwarded: !result.credited, checks };
  }

  async function runYearlyAwards(awardYear) {
    const ids = await streamerIds();
    const results = [];
    for (const id of ids) {
      try {
        const result = await awardYear(id, awardYear);
        if (result.eligible) results.push({ userId: id, awarded: true });
      } catch (e) {
        console.error("Yearly appreciation check failed for", id, e.message);
      }
    }
    return { year: awardYear, awarded: results.length };
  }

  app.get("/api/appreciation/me", requireAuth, async (req, res) => {
    const userId = String(req.userEmail || "").toLowerCase();
    const rows = await db.all(
      `SELECT user_id AS "userId", award_year AS "awardYear", coins, created_at AS "createdAt"
       FROM appreciation_yearly_awards WHERE user_id = ? ORDER BY award_year DESC`,
      [userId]
    );
    res.json({ success: true, yearlyAwards: rows });
  });

  async function runScheduled() {
    const p = localParts();
    // Normally this runs on day 1. Retrying during the month also catches up after a server outage;
    // the per-user/month primary key prevents duplicate appreciation notifications.
    const r = await sendMonthlyAppreciation(p.year, p.month);
    if (r.sent) console.log(`Monthly appreciation ${r.month}: sent to ${r.sent} streamers.`);
    // Process the completed calendar year during January. Per-user/year keys prevent duplicate credits.
    if (p.month === 1) {
      const annual = await runYearlyAwards(p.year - 1);
      if (annual.awarded) console.log(`Yearly appreciation ${annual.year}: awarded 20 coins to ${annual.awarded} streamers.`);
    }
  }

  function start() {
    let lastLocalDay = "";
    const tick = () => {
      const p = localParts(), key = `${p.year}-${p.month}-${p.day}`;
      if (key === lastLocalDay) return;
      lastLocalDay = key;
      runScheduled().catch(e => console.error("Appreciation scheduler error:", e.message));
    };
    tick();
    setInterval(tick, 60 * 60 * 1000).unref();
  }

  return { migrate, start, sendMonthlyAppreciation, runYearlyAwards, monthEligibility };
};
