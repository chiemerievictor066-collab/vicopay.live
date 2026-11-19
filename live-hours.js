// =====================================================
// VicoPay Live — live-hours maths, shared by the monthly payout engine (payouts.js) and the host wallet (server.js)
// so both always count hours the SAME way:
//   * the month is the NIGERIA month (UTC+1 by default, PAYOUT_TZ_OFFSET_MIN)
//   * two rooms live at the same time never count double (overlaps are merged)
//   * a live that crashed only counts up to its last heartbeat, and one session counts at most 24 hours
// =====================================================
"use strict";
const DAY = 86400000;

function monthWindow(month, tzOffsetMin) {                    // month = "2026-11"
  const [y, m] = String(month).split("-").map(Number), off = (Number(tzOffsetMin) || 0) * 60000;
  const startMs = Date.UTC(y, m - 1, 1) - off, endMs = Date.UTC(y, m, 1) - off;
  return { startMs, endMs, days: Math.round((endMs - startMs) / DAY) };
}
function currentMonthKey(tzOffsetMin, nowMs) {
  const d = new Date((nowMs == null ? Date.now() : nowMs) + (Number(tzOffsetMin) || 0) * 60000);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
const currentMonthWindow = (tzOffsetMin, nowMs) => monthWindow(currentMonthKey(tzOffsetMin, nowMs), tzOffsetMin);

// hours broadcast on each day of the window (an array with one number per day)
function liveHoursPerDay(sessions, win) {
  const iv = [];
  for (const s of sessions) {
    const start = Number(s.started_at), endRaw = s.ended_at != null ? Number(s.ended_at) : (s.last_beat != null ? Number(s.last_beat) : start);
    const end = Math.min(endRaw, start + DAY);
    if (end > start) iv.push([Math.max(start, win.startMs), Math.min(end, win.endMs)]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const x of iv) { if (x[1] <= x[0]) continue; const last = merged[merged.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else merged.push([x[0], x[1]]); }
  const hours = new Array(win.days).fill(0);
  for (const [a, b] of merged) {
    let cur = a;
    while (cur < b) {
      const idx = Math.min(win.days - 1, Math.floor((cur - win.startMs) / DAY)), dayEnd = win.startMs + (idx + 1) * DAY, seg = Math.min(b, dayEnd);
      hours[idx] += (seg - cur) / 3600000; cur = seg;
    }
  }
  return hours;
}
// MONTHLY HOURS: every day counts at most dailyCap hours (default 1). Once a host has done the 1 hour of a day, the extra hours
// streamed on that SAME day are free (they are not added to the monthly hours). A new day starts a new 1 hour.
const DAILY_CAP_HOURS = 1;
const totalHours = (perDay, dailyCap) => {
  const cap = dailyCap == null ? DAILY_CAP_HOURS : Number(dailyCap);
  const sum = perDay.reduce((a, h) => a + Math.min(Math.max(0, h), cap), 0);
  return Math.floor(sum * 100 + 1e-6) / 100;                                                       // 2 decimals, rounded DOWN
};

// THE MONTHLY RULES (one place, used everywhere)
//   Normal host: 3,000 stars | live EVERY day for at least 1 hour | at least 30 live hours in the month | $9.00  per 3,000 stars
//   VIP host:   12,000 stars | live EVERY day for at least 1 hour | at least 30 live hours in the month | $10.80 per 3,000 stars
const RULES = {
  normal: { minStars: 3000,  dailyHours: 1, monthlyHours: 30, blockStars: 3000, blockCents: 900 },
  vip:    { minStars: 12000, dailyHours: 1, monthlyHours: 30, blockStars: 3000, blockCents: 1080 }
};
// does one host meet the live rules for a month? perDay = liveHoursPerDay(...), rules = RULES.normal | RULES.vip
function checkLive(perDay, rules) {
  const liveDays = perDay.filter((h) => h >= rules.dailyHours - 1e-9).length;
  const hours = totalHours(perDay, rules.dailyHours);
  return { liveDays, days: perDay.length, hours, everyDay: liveDays >= perDay.length, enoughHours: hours >= rules.monthlyHours };
}
// dollars for a number of stars: whole 3,000-star blocks only (13,000 and 14,500 stars are both paid as 12,000), counted in cents
const payoutUsd = (stars, rules) => Math.floor(Math.max(0, Number(stars) || 0) / rules.blockStars) * rules.blockCents / 100;

module.exports = { DAY, DAILY_CAP_HOURS, monthWindow, currentMonthKey, currentMonthWindow, liveHoursPerDay, totalHours, RULES, checkLive, payoutUsd };
