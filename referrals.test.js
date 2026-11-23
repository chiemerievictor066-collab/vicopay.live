// Referral reward rules — `node tests/referrals.test.js` (pure rules, no database)
const assert = require("assert");
const { planRewards, cleanMilestones } = require("../referrals");
const M = [{ count: 5, total: 10 }, { count: 10, total: 20 }, { count: 20, total: 30 }];
const sum = (p) => p.reduce((a, x) => a + x.coins, 0);
assert.deepStrictEqual(planRewards(4, M, []), []);
assert.deepStrictEqual(planRewards(5, M, []), [{ count: 5, coins: 10 }]);                      // 5 friends = 10 coins
assert.deepStrictEqual(planRewards(10, M, [5]), [{ count: 10, coins: 10 }]);                   // 10 friends = 20 in total (10 more)
assert.deepStrictEqual(planRewards(20, M, [5, 10]), [{ count: 20, coins: 10 }]);               // 20 friends = 30 in total (10 more)
assert.strictEqual(sum(planRewards(25, M, [])), 30);                                           // never more than 30 in total
assert.deepStrictEqual(planRewards(25, M, [5, 10, 20]), []);                                   // a paid milestone is never paid again
assert.strictEqual(sum(planRewards(10, M, [])), 20);                                           // jumping straight to 10 still pays 10 + 10
console.log("ok  milestones are cumulative: 5 -> 10, 10 -> 20, 20 -> 30 coins; never paid twice");
let c = cleanMilestones([{ count: 3, total: 5 }, { count: 8, total: 12 }]); assert.deepStrictEqual(c.milestones, [{ count: 3, total: 5 }, { count: 8, total: 12 }]);
for (const badList of [[], [{ count: 5, total: 10 }, { count: 5, total: 20 }], [{ count: 5, total: 10 }, { count: 9, total: 10 }], [{ count: 0, total: 10 }], [{ count: 5, total: 1.5 }], "x"]) assert.ok(cleanMilestones(badList).error);
console.log("ok  admin milestone changes are validated (counts and totals must go up, whole numbers)");

// ---- self-referral / duplicate / flag rules through recordSignup, with a fake database ----
(async () => {
  const rows = [], codes = { VPLAAAAAA: "ada@x.com" };
  const users = { "ada@x.com": { signup_ip: "1.1.1.1", last_ip: "1.1.1.1" } };
  const db = {
    pool: { connect: async () => ({ query: async () => ({}), release() {} }) },
    async all() { return []; },
    async get(sql, p) {
      if (/FROM referral_codes WHERE code/.test(sql)) return codes[p[0]] ? { user_email: codes[p[0]] } : null;
      if (/FROM users WHERE email/.test(sql)) return users[p[0]] || null;
      if (/COUNT\(\*\) AS c FROM referrals WHERE inviter_email = \? AND signup_ip/.test(sql)) return { c: rows.filter((r) => r.inviter === p[0] && r.ip === p[1]).length };
      if (/INSERT INTO referrals/.test(sql)) { if (rows.some((r) => r.invited === p[1])) return null; rows.push({ inviter: p[0], invited: p[1], status: p[3], flagged: p[6], ip: p[5] }); return { id: rows.length }; }
      return null;
    }
  };
  const R = require("../referrals")({ app: { get() {}, post() {} }, db, requireAuth() {}, requireAdmin() {}, ledger: {} });
  let r = await R.recordSignup({ invitedEmail: "ada@x.com", code: "VPLAAAAAA", ip: "9.9.9.9" }); assert.strictEqual(r.status, "rejected");   // self-referral
  r = await R.recordSignup({ invitedEmail: "bob@x.com", code: "VPLAAAAAA", ip: "1.1.1.1" }); assert.strictEqual(r.flagged, true);            // same network as inviter
  r = await R.recordSignup({ invitedEmail: "cy@x.com", code: "VPLAAAAAA", ip: "5.5.5.5" }); assert.strictEqual(r.flagged, false);
  r = await R.recordSignup({ invitedEmail: "cy@x.com", code: "VPLAAAAAA", ip: "5.5.5.5" }); assert.strictEqual(r.ok, false);                  // same account cannot be counted twice
  r = await R.recordSignup({ invitedEmail: "dee@x.com", code: "VPLAAAAAA", ip: "5.5.5.5" }); assert.strictEqual(r.flagged, false);
  r = await R.recordSignup({ invitedEmail: "eve@x.com", code: "VPLAAAAAA", ip: "5.5.5.5" }); assert.strictEqual(r.flagged, true);            // 3rd signup from one address is held
  r = await R.recordSignup({ invitedEmail: "x@x.com", code: "nonsense", ip: "5.5.5.5" }); assert.strictEqual(r.ok, false);
  console.log("ok  self-referral rejected, same-network and bulk signups held for review, duplicate account counted once");
  console.log("\nALL REFERRAL CHECKS PASSED"); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
