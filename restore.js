// Loads a backup made by `npm run backup` into an EMPTY database.   Run:  npm run restore -- backups/vicopay-xxxx.ndjson.gz
// Refuses to run if the database already has accounts (add --force to merge anyway; existing rows are kept).
require("dotenv").config();
const fs = require("fs"), zlib = require("zlib"), readline = require("readline");
const db = require("./db");
const ledger = require("./ledger")(db);

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const force = process.argv.includes("--force");
if (!file || !fs.existsSync(file)) { console.error("Usage: npm run restore -- <backup-file.ndjson.gz>"); process.exit(1); }

(async () => {
  await db.migrate();
  const have = Number((await db.get("SELECT COUNT(*) AS c FROM users")).c);
  if (have > 0 && !force) { console.error("This database already has " + have + " accounts. Restore into an empty database (or add --force to merge)."); process.exit(1); }
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const n = {}; let sawEnd = false;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { t, r } = JSON.parse(line);
    if (t === "_end") { sawEnd = true; continue; }
    const cols = Object.keys(r);
    const vals = cols.map((k) => (r[k] && typeof r[k] === "object" && r[k].type === "Buffer" ? Buffer.from(r[k].data) : r[k]));
    await db.run("INSERT INTO " + t + " (" + cols.join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ") ON CONFLICT DO NOTHING", vals);
    n[t] = (n[t] || 0) + 1;
  }
  if (!sawEnd) console.warn("WARNING: the backup file ends early - it may be incomplete.");
  // Postgres counters must continue after the highest restored id
  for (const [tbl, col] of [["transactions", "id"], ["ledger_entries", "id"], ["live_sessions", "id"], ["chat_messages", "id"], ["notifications", "id"], ["reports", "id"]]) {
    try { await db.get("SELECT setval(pg_get_serial_sequence('" + tbl + "','" + col + "'), COALESCE((SELECT MAX(" + col + ") FROM " + tbl + "), 0) + 1, false)"); } catch (e) { /* not Postgres / no rows */ }
  }
  try { await db.get("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 0) + 1, false)"); } catch (e) { /* ignore */ }
  console.log("Restored: " + Object.entries(n).map(([k, v]) => k + " " + v).join(", "));
  const a = await ledger.verify();
  console.log(a.ok ? "Books balance: " + a.accounts + " coin accounts, " + a.totalCoins + " coins." : "MISMATCH after restore:\n" + JSON.stringify(a.mismatches, null, 2));
  await db.close(); process.exit(a.ok ? 0 : 2);
})().catch((e) => { console.error("RESTORE FAILED:", e.message); process.exit(1); });
