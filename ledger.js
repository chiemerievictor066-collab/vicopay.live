// =====================================================
// VicoPay Live — the LEDGER (all coin movements)
// =====================================================
// Rules that make coins safe:
//  1. Every money event is ONE database transaction: the balance change, the `transactions` row and the
//     `ledger_entries` rows are saved together, or not at all. A crash can never leave half a payment.
//  2. A balance is only ever reduced by  UPDATE ... SET coins = coins - X WHERE coins >= X.  PostgreSQL locks the
//     row for that statement, so two gifts sent at the same moment can never spend the same coins twice.
//     (balances.coins also has CHECK (coins >= 0) as a last line of defence.)
//  3. A Paystack reference can only be inserted once (primary key), so a payment can never be credited twice,
//     no matter how many times the webhook / verify page fires.
//  4. Nothing is ever edited or deleted: reversals are new rows. balances.coins must always equal the sum of
//     that user's coin ledger entries, and verify() checks exactly that.
//
// The "statement" a user sees:
//     Victor  +1000  Initial balance
//     Victor   +200  Received from John
//     Victor    -50  Sent to Sarah
// =====================================================
module.exports = function makeLedger(db) {
  class Abort extends Error { constructor(reason, extra) { super(reason); this.reason = reason; this.extra = extra || {}; } }
  const lc = (v) => String(v || "").toLowerCase();

  async function getBalance(email) {
    const r = await db.get("SELECT coins FROM balances WHERE user_id = ?", [lc(email)]);
    return r ? Number(r.coins) : 0;
  }

  async function txn(t, kind, sender, receiver, amount, reference, memo, ts) {
    const r = await t.get(
      "INSERT INTO transactions (kind, sender_id, receiver_id, amount, reference, memo, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id",
      [kind, sender || null, receiver || null, amount, reference || null, memo || null, ts]);
    return r.id;
  }
  const entry = (t, txnId, user, currency, delta, balanceAfter, memo, ts) =>
    t.run("INSERT INTO ledger_entries (txn_id, user_id, currency, delta, balance_after, memo, created_at) VALUES (?,?,?,?,?,?,?)",
      [txnId, lc(user), currency, delta, balanceAfter === undefined ? null : balanceAfter, memo || null, ts]);

  const HOST_ROW = "RETURNING gifts, gift_coins AS \"giftCoins\", loves, viewers, withdrawn_stars AS \"withdrawnStars\"";

  // ---------- 1. Paystack purchase ----------
  async function creditPurchase({ email, coins, reference, amountNgn }) {
    email = lc(email);
    return db.tx(async (t) => {
      const ts = Date.now();
      const ins = await t.get(
        "INSERT INTO payments (reference, email, coins, amount_ngn, status, created_at) VALUES (?,?,?,?, 'ok', ?) ON CONFLICT (reference) DO NOTHING RETURNING reference",
        [reference, email, coins, Number(amountNgn) || 0, ts]);
      if (!ins) {
        const b = await t.get("SELECT coins FROM balances WHERE user_id = ?", [email]);
        return { credited: false, balance: b ? Number(b.coins) : 0 };
      }
      const b = await t.get(
        "INSERT INTO balances (user_id, coins, updated_at) VALUES (?,?,?) ON CONFLICT (user_id) DO UPDATE SET coins = balances.coins + EXCLUDED.coins, updated_at = EXCLUDED.updated_at RETURNING coins",
        [email, coins, ts]);
      const id = await txn(t, "purchase", null, email, coins, reference, "Paystack purchase", ts);
      await entry(t, id, email, "coin", coins, Number(b.coins), "Bought " + coins + " coins (₦" + (Number(amountNgn) || 0).toLocaleString("en-NG") + ")", ts);
      return { credited: true, balance: Number(b.coins) };
    });
  }

  // ---------- 2. Gift: viewer pays coins, host earns Golden Stars ----------
  async function sendGift({ sender, host, gift, price, giftId, senderName, hostName }) {
    sender = lc(sender); host = lc(host);
    return db.tx(async (t) => {
      const ts = Date.now();
      const bal = await t.get("UPDATE balances SET coins = coins - ?, updated_at = ? WHERE user_id = ? AND coins >= ? RETURNING coins", [price, ts, sender, price]);
      if (!bal) {
        const b = await t.get("SELECT coins FROM balances WHERE user_id = ?", [sender]);
        return { ok: false, reason: "insufficient", balance: b ? Number(b.coins) : 0 };
      }
      await t.run("INSERT INTO gift_transactions (id, gift, coin, sender_id, host_id, golden_stars, created_at) VALUES (?,?,?,?,?,?,?)",
        [giftId, gift, price, sender, host, price, new Date(ts).toISOString()]);
      const hs = await t.get(
        "INSERT INTO host_stats (host_id, gifts, gift_coins) VALUES (?, 1, ?) ON CONFLICT (host_id) DO UPDATE SET gifts = host_stats.gifts + 1, gift_coins = host_stats.gift_coins + EXCLUDED.gift_coins " + HOST_ROW,
        [host, price]);
      await t.run("UPDATE fan_members SET points = points + ? WHERE host_id = ? AND user_id = ?", [price, host, sender]);
      const id = await txn(t, "gift", sender, host, price, giftId, gift, ts);
      await entry(t, id, sender, "coin", -price, Number(bal.coins), "Sent " + gift + " to " + (hostName || host), ts);
      await entry(t, id, host, "star", price, null, "Received " + gift + " from " + (senderName || sender), ts);
      return { ok: true, balance: Number(bal.coins), hostStats: hs };
    });
  }

  // ---------- 3. Fan club membership ----------
  async function joinFanClub({ user, host, cost, userName, hostName }) {
    user = lc(user); host = lc(host);
    try {
      return await db.tx(async (t) => {
        const ts = Date.now();
        const bal = await t.get("UPDATE balances SET coins = coins - ?, updated_at = ? WHERE user_id = ? AND coins >= ? RETURNING coins", [cost, ts, user, cost]);
        if (!bal) throw new Abort("insufficient");
        const m = await t.get("INSERT INTO fan_members (host_id, user_id, points) VALUES (?,?,0) ON CONFLICT DO NOTHING RETURNING user_id", [host, user]);
        if (!m) throw new Abort("already");
        const giftId = "FAN-" + ts + "-" + Math.floor(Math.random() * 1e5);
        await t.run("INSERT INTO gift_transactions (id, gift, coin, sender_id, host_id, golden_stars, created_at) VALUES (?,?,?,?,?,?,?)",
          [giftId, "Fan Club", cost, user, host, cost, new Date(ts).toISOString()]);
        const hs = await t.get(
          "INSERT INTO host_stats (host_id, gift_coins) VALUES (?, ?) ON CONFLICT (host_id) DO UPDATE SET gift_coins = host_stats.gift_coins + EXCLUDED.gift_coins " + HOST_ROW,
          [host, cost]);
        const id = await txn(t, "fan_club", user, host, cost, giftId, "Fan club", ts);
        await entry(t, id, user, "coin", -cost, Number(bal.coins), "Joined " + (hostName || host) + "'s fan club", ts);
        await entry(t, id, host, "star", cost, null, (userName || user) + " joined your fan club", ts);
        return { ok: true, balance: Number(bal.coins), hostStats: hs };
      });
    } catch (e) {
      if (e instanceof Abort) return { ok: false, reason: e.reason, balance: await getBalance(user) };
      throw e;
    }
  }

  // ---------- 4. Chargeback / refund ----------
  // Takes the coins back from the buyer; coins already spent as gifts are taken back from the hosts who got them
  // (newest first); the buyer is frozen until you review them in /admin.html.
  async function reversePayment(reference, why) {
    return db.tx(async (t) => {
      const ts = Date.now();
      const p = await t.get("UPDATE payments SET status = 'reversed' WHERE reference = ? AND status = 'ok' RETURNING reference, email, coins", [reference]);
      if (!p) return { reversed: false };
      const email = lc(p.email);
      const row = await t.get("SELECT coins FROM balances WHERE user_id = ? FOR UPDATE", [email]);
      const take = Math.min(row ? Number(row.coins) : 0, Number(p.coins));
      const id = await txn(t, "reversal", email, null, Number(p.coins), reference, "Payment " + why, ts);
      if (take > 0) {
        const nb = await t.get("UPDATE balances SET coins = coins - ?, updated_at = ? WHERE user_id = ? RETURNING coins", [take, ts, email]);
        await entry(t, id, email, "coin", -take, Number(nb.coins), "Payment reversed (" + reference + ")", ts);
      }
      let remaining = Number(p.coins) - take;
      const hostUpdates = [];
      if (remaining > 0) {
        const nets = await t.all(
          "SELECT host_id AS \"hostId\", SUM(coin) AS net, MAX(created_at) AS last FROM gift_transactions WHERE sender_id = ? GROUP BY host_id HAVING SUM(coin) > 0 ORDER BY MAX(created_at) DESC", [email]);
        for (const n of nets) {
          if (remaining <= 0) break;
          const cut = Math.min(Number(n.net), remaining);
          remaining -= cut;
          await t.run("INSERT INTO gift_transactions (id, gift, coin, sender_id, host_id, golden_stars, created_at) VALUES (?,?,?,?,?,?,?)",
            ["REV-" + ts + "-" + Math.floor(Math.random() * 1e5), "Payment reversed", -cut, email, n.hostId, -cut, new Date(ts).toISOString()]);
          const hs = await t.get(
            "UPDATE host_stats SET gift_coins = CASE WHEN gift_coins >= ? THEN gift_coins - ? ELSE 0 END WHERE host_id = ? " + HOST_ROW, [cut, cut, n.hostId]);
          if (hs) hostUpdates.push({ hostId: n.hostId, stats: hs });
          await entry(t, id, n.hostId, "star", -cut, null, "Stars taken back: payment reversed", ts);
        }
      }
      await t.run(
        "INSERT INTO user_flags (email, banned, reason, banned_at) VALUES (?,1,?,?) ON CONFLICT (email) DO UPDATE SET banned = 1, reason = EXCLUDED.reason, banned_at = EXCLUDED.banned_at",
        [email, "Payment " + why + " (" + reference + ")", new Date(ts).toISOString()]);
      await t.run("INSERT INTO reports (reporter, room_id, host_id, reason, created_at) VALUES ('system', NULL, ?, ?, ?)",
        [email, "Payment " + why + ": " + p.coins + " coins reversed (" + reference + "). Account frozen. " + remaining + " coins could not be recovered.", ts]);
      return { reversed: true, email, coins: Number(p.coins), remaining, hostUpdates };
    });
  }

  // ---------- reading ----------
  async function statement(email, limit) {
    return db.all(
      "SELECT id, currency, delta, balance_after AS \"balanceAfter\", memo, created_at AS \"createdAt\" FROM ledger_entries WHERE user_id = ? ORDER BY id DESC LIMIT ?",
      [lc(email), Math.min(200, Number(limit) || 50)]);
  }

  // Safety audit: every balance must equal the sum of that user's coin ledger entries.
  async function verify() {
    const bad = await db.all(
      `SELECT b.user_id AS "userId", b.coins AS balance, COALESCE(s.total, 0) AS ledger
         FROM balances b LEFT JOIN (SELECT user_id, SUM(delta) AS total FROM ledger_entries WHERE currency = 'coin' GROUP BY user_id) s
           ON s.user_id = b.user_id
        WHERE b.coins <> COALESCE(s.total, 0) ORDER BY b.user_id LIMIT 50`);
    const t = await db.get("SELECT COUNT(*) AS accounts, COALESCE(SUM(coins), 0) AS coins FROM balances");
    return { ok: bad.length === 0, accounts: Number(t.accounts), totalCoins: Number(t.coins), mismatches: bad };
  }

  // The audit scans the whole ledger, so show a remembered result (refreshed in the background) instead of re-running it
  // on every admin page view. verifyCached(0) forces a fresh run.
  let audit = null, auditAt = 0, running = null;
  async function verifyCached(maxAgeMs) {
    const age = maxAgeMs === undefined ? 900000 : maxAgeMs;
    if (audit && Date.now() - auditAt < age) return audit;
    if (!running) running = verify().then((a) => { audit = a; auditAt = Date.now(); return a; }).finally(() => { running = null; });
    return running;
  }
  const lastAudit = () => audit ? { ...audit, checkedAt: auditAt } : { ok: null, pending: true };

  return { getBalance, creditPurchase, sendGift, joinFanClub, reversePayment, statement, verify, verifyCached, lastAudit, Abort };
};
