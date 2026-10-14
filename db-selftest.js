// Proves the coin safety rules on YOUR real PostgreSQL database.   Run:  npm run db:selftest
// It builds a throw-away schema (vico_selftest_xxx), runs the checks below, then deletes the schema.
// Your real tables and data are never touched.
require("dotenv").config();
const db = require("./db");
const ledger = require("./ledger")(db);
const store = require("./store")(db);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); } };
const schema = "vico_selftest_" + Date.now();
let isolated = false;

(async () => {
  console.log("Database self-test (schema " + schema + ")\n");
  try {
    db.pool.on("connect", (c) => { c.query("SET search_path TO " + schema).catch(() => {}); });
    await db.pool.query("CREATE SCHEMA " + schema);
    isolated = true;
  } catch (e) { console.log("  (note: could not create an isolated schema - " + e.message.split("\n")[0] + ")\n"); }

  await db.migrate(); await db.migrate();
  ok("tables can be created, and creating them twice is harmless", true);

  // --- accounts ---
  const mk = (n) => store.users.create(n + "@selftest.com", { salt: "s", hash: "h", username: n, displayName: n }, "127.0.0.1");
  const a = await mk("alice"), dup = await mk("alice");
  ok("a second account with the same email is refused", !!a && dup === null);
  const uname = await store.users.create("other@selftest.com", { salt: "s", hash: "h", username: "alice", displayName: "x" }, "");
  ok("a second account with the same username is refused", uname === null);

  // --- one payment can only be credited once, even when Paystack and the verify page fire together ---
  const results = await Promise.all(Array.from({ length: 20 }, () => ledger.creditPurchase({ email: "alice@selftest.com", coins: 1000, reference: "REF-1", amountNgn: 10000 })));
  ok("the same payment sent 20 times at once is credited exactly once", results.filter((r) => r.credited).length === 1 && (await ledger.getBalance("alice@selftest.com")) === 1000, results.map((r) => r.credited));

  // --- no double spending ---
  await mk("host");
  const gifts = await Promise.all(Array.from({ length: 40 }, (_, i) => ledger.sendGift({ sender: "alice@selftest.com", host: "host@selftest.com", gift: "Rose", price: 100, giftId: "G-" + i, senderName: "alice", hostName: "host" })));
  const sent = gifts.filter((g) => g.ok).length;
  ok("40 gifts of 100 coins sent at once from a 1,000-coin balance: exactly 10 succeed", sent === 10, { sent });
  ok("balance ends at exactly 0 (never negative)", (await ledger.getBalance("alice@selftest.com")) === 0);
  const hs = await store.getHostStats("host@selftest.com");
  ok("the host received exactly 1,000 stars, no more", hs.giftCoins === 1000 && hs.gifts === 10, hs);

  // --- the database itself refuses a negative balance ---
  let refused = false;
  try { await db.run("UPDATE balances SET coins = -5 WHERE user_id = ?", ["alice@selftest.com"]); } catch (e) { refused = true; }
  ok("the database refuses a negative balance, even if the code had a bug", refused);

  // --- all-or-nothing ---
  await ledger.creditPurchase({ email: "alice@selftest.com", coins: 500, reference: "REF-2", amountNgn: 5000 });
  try { await db.tx(async (t) => { await t.run("UPDATE balances SET coins = coins + 999 WHERE user_id = ?", ["alice@selftest.com"]); throw new Error("simulated crash"); }); } catch (e) { /* expected */ }
  ok("a crash in the middle of a transaction changes nothing", (await ledger.getBalance("alice@selftest.com")) === 500);

  // --- fan club: charged once ---
  const joins = await Promise.all(Array.from({ length: 10 }, () => ledger.joinFanClub({ user: "alice@selftest.com", host: "host@selftest.com", cost: 100, userName: "alice", hostName: "host" })));
  ok("joining a fan club 10 times at once charges exactly once", joins.filter((j) => j.ok).length === 1 && (await ledger.getBalance("alice@selftest.com")) === 400);

  // --- chargeback ---
  await mk("buyer");
  await ledger.creditPurchase({ email: "buyer@selftest.com", coins: 500, reference: "REF-3", amountNgn: 5000 });
  await ledger.sendGift({ sender: "buyer@selftest.com", host: "host@selftest.com", gift: "Rose", price: 300, giftId: "G-X", senderName: "buyer", hostName: "host" });
  const before = (await store.getHostStats("host@selftest.com")).giftCoins;
  const rev = await ledger.reversePayment("REF-3", "disputed");
  const after = (await store.getHostStats("host@selftest.com")).giftCoins;
  ok("a chargeback takes the coins back and removes the stars from the host", rev.reversed && (await ledger.getBalance("buyer@selftest.com")) === 0 && before - after === 300, { rev, before, after });
  ok("the same chargeback cannot be applied twice", (await ledger.reversePayment("REF-3", "disputed")).reversed === false);

  // --- the books balance ---
  const st = await ledger.statement("alice@selftest.com", 50);
  ok("the coin statement shows every movement", st.length >= 3 && st.some((e) => Number(e.delta) < 0) && st.some((e) => Number(e.delta) > 0));
  const audit = await ledger.verify();
  ok("every balance equals the sum of its ledger lines", audit.ok, audit.mismatches);

  if (isolated) { try { await db.pool.query("DROP SCHEMA " + schema + " CASCADE"); console.log("\n(test schema removed)"); } catch (e) { console.log("\n(could not remove the test schema: " + e.message + ")"); } }
  console.log("\n" + pass + " passed, " + fail + " failed");
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error("SELF-TEST CRASHED:", e.message); try { if (isolated) await db.pool.query("DROP SCHEMA " + schema + " CASCADE"); } catch (_) { /* ignore */ } process.exit(1); });
