// Saves a compressed copy of everything important (accounts, coins, ledger, payments, gifts, payouts, follows...)
// to backups/vicopay-<date>.ndjson.gz.   Run:  npm run backup
// It reads from ONE consistent snapshot, so the copy always balances. The file contains password hashes and
// bank details: keep it private and never put it on GitHub. This is a SECOND safety net; the first is Render's
// own database backups (see README, section 5).
require("dotenv").config();
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const db = require("./db");

const TABLES = [ // [table, order-by]
  ["users", "email"], ["user_flags", "email"], ["profiles", "email"], ["balances", "user_id"], ["transactions", "id"],
  ["ledger_entries", "id"], ["payments", "reference"], ["gift_transactions", "id"], ["host_stats", "host_id"],
  ["withdrawal_requests", "id"], ["withdrawal_security", "creator_id"], ["follows", "follower_id, host_id"],
  ["fan_members", "host_id, user_id"], ["pk_battles", "id"], ["reports", "id"]
];
const PAGE = 5000;

(async () => {
  await db.migrate();
  const dir = process.env.BACKUP_DIR || path.join(__dirname, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const file = path.join(dir, "vicopay-" + stamp + ".ndjson.gz");
  const out = fs.createWriteStream(file), gz = zlib.createGzip(); gz.pipe(out);
  const write = (s) => new Promise((res) => { if (gz.write(s)) res(); else gz.once("drain", res); });

  const c = await db.pool.connect();
  const counts = {};
  try {
    try { await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); } catch (e) { await c.query("BEGIN"); }
    for (const [table, order] of TABLES) {
      counts[table] = 0;
      for (let offset = 0; ; offset += PAGE) {
        const r = await c.query("SELECT * FROM " + table + " ORDER BY " + order + " LIMIT " + PAGE + " OFFSET " + offset);
        if (!r.rows.length) break;
        await write(r.rows.map((row) => JSON.stringify({ t: table, r: row })).join("\n") + "\n");
        counts[table] += r.rows.length;
        if (r.rows.length < PAGE) break;
      }
    }
    await c.query("COMMIT");
  } catch (e) { try { await c.query("ROLLBACK"); } catch (_) { /* ignore */ } throw e; } finally { c.release(); }
  await write(JSON.stringify({ t: "_end", r: { counts, at: new Date().toISOString() } }) + "\n");
  await new Promise((res) => { gz.end(); out.on("close", res); });
  console.log("Backup saved: " + file + " (" + (fs.statSync(file).size / 1024).toFixed(1) + " KB)");
  console.log(Object.entries(counts).map(([k, v]) => k + ": " + v).join(", "));
  await db.close();
})().catch((e) => { console.error("BACKUP FAILED:", e.message); process.exit(1); });
