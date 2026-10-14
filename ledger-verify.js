// Checks that every user's coin balance equals the sum of their ledger lines. Run:  npm run db:verify
// Exits with an error code if anything does not add up, so you can also run it on a schedule.
require("dotenv").config();
const db = require("./db");
const ledger = require("./ledger")(db);
(async () => {
  await db.migrate();
  const a = await ledger.verify();
  console.log(a.ok ? `OK: ${a.accounts} coin accounts, ${a.totalCoins} coins in total, every balance matches its ledger.`
                   : "MISMATCH:\n" + JSON.stringify(a.mismatches, null, 2));
  await db.close();
  process.exit(a.ok ? 0 : 2);
})().catch((e) => { console.error(e.message); process.exit(1); });
