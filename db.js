// =====================================================
// VicoPay Live — PostgreSQL database layer
// =====================================================
// ALL data lives in PostgreSQL (Render: set DATABASE_URL). Nothing important is kept on the server's disk,
// so redeploys, restarts and crashes can never lose accounts or coins.
//
// Usage:   await db.get(sql, [params])   await db.all(...)   await db.run(...)   await db.tx(async t => { ... })
// SQL may use "?" placeholders (converted to $1, $2 ...) so queries stay easy to read.
// =====================================================
const { Pool, types } = require("pg");

// node-pg returns BIGINT / NUMERIC as strings by default. Our numbers (coins, timestamps in ms) are safe as JS numbers.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("\nDATABASE_URL is not set. On Render, add your PostgreSQL 'Internal Database URL' as DATABASE_URL.\n" +
    "Locally, install PostgreSQL and use e.g.  DATABASE_URL=postgres://postgres:password@localhost:5432/vicopay\n");
  process.exit(1);
}
// Render's *external* address needs SSL; its *internal* address (no dots in the host) does not.
const wantSsl = process.env.PGSSL ? process.env.PGSSL === "true" : /\.render\.com|sslmode=require/i.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: wantSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", (e) => console.error("PostgreSQL pool error:", e.message));

// "?" -> $1..$n, INSERT OR IGNORE -> ON CONFLICT DO NOTHING, AS camelCase -> AS "camelCase" (Postgres lower-cases bare names)
function toPg(sql) {
  let out = "", n = 0, q = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) { out += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    out += c === "?" ? "$" + (++n) : c;
  }
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(out)) {
    out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    out = /\sRETURNING\s/i.test(out) ? out.replace(/\sRETURNING\s/i, " ON CONFLICT DO NOTHING RETURNING ") : out.replace(/\s*;?\s*$/, " ON CONFLICT DO NOTHING");
  }
  return out.replace(/\bAS\s+([A-Za-z_]*[A-Z][A-Za-z_]*)\b/g, 'AS "$1"');
}

function api(exec) {
  const self = {
    async query(sql, params) { return exec(toPg(sql), params || []); },
    async all(sql, params) { return (await self.query(sql, params)).rows; },
    async get(sql, params) { return (await self.query(sql, params)).rows[0]; },
    async run(sql, params) { const r = await self.query(sql, params); return { changes: r.rowCount, rows: r.rows }; },
    // Same shape the old SQLite code used:  db.prepare("SELECT ...").get(a, b)
    prepare(sql) {
      return { all: (...p) => self.all(sql, p), get: (...p) => self.get(sql, p), run: (...p) => self.run(sql, p) };
    }
  };
  return self;
}

const db = api((sql, params) => pool.query(sql, params));
db.isPg = true;
db.pool = pool;

// Run several statements as ONE all-or-nothing transaction.
db.tx = async function (fn) {
  const client = await pool.connect();
  const t = api((sql, params) => client.query(sql, params));
  // per-key lock that lasts until this transaction ends (used so two withdrawals can't run side by side)
  t.lock = (key) => client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(key)]);
  try {
    await client.query("BEGIN");
    const result = await fn(t);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------
// SCHEMA  (safe to run on every start: everything is IF NOT EXISTS)
// -----------------------------------------------------
const SCHEMA = [
  // ----- accounts -----
  `CREATE SEQUENCE IF NOT EXISTS users_id_seq`,
  `CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    id BIGINT NOT NULL DEFAULT nextval('users_id_seq'),
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    username TEXT,
    handle TEXT,
    display_name TEXT,
    created_at TEXT,
    signup_ip TEXT,
    last_ip TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users(id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle)`,
  `CREATE TABLE IF NOT EXISTS user_flags (email TEXT PRIMARY KEY, banned SMALLINT NOT NULL DEFAULT 0, reason TEXT, banned_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS profiles (email TEXT PRIMARY KEY, bio TEXT, updated_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS avatars (email TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at BIGINT NOT NULL, used SMALLINT NOT NULL DEFAULT 0)`,

  // ----- MONEY: balances + transactions + per-user ledger -----
  // balances.coins can never go below zero (the database itself refuses).
  `CREATE TABLE IF NOT EXISTS balances (
    user_id TEXT PRIMARY KEY,
    coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
    updated_at BIGINT NOT NULL DEFAULT 0
  )`,
  // One row per money event:  purchase | gift | fan_club | reversal | migration
  `CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    sender_id TEXT,
    receiver_id TEXT,
    amount BIGINT NOT NULL,
    reference TEXT,
    memo TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference)`,
  // The "bank statement":  Victor +1000 Initial balance / Victor +200 Received from John / Victor -50 Sent to Sarah
  // currency 'coin' = spendable coins (balance_after is the balance), 'star' = Golden Stars a host earned.
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    txn_id BIGINT NOT NULL,
    user_id TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'coin',
    delta BIGINT NOT NULL,
    balance_after BIGINT,
    memo TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(txn_id)`,
  // Paystack payments. The primary key on reference is what makes it impossible to credit one payment twice.
  `CREATE TABLE IF NOT EXISTS payments (
    reference TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    coins BIGINT NOT NULL,
    amount_ngn DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'ok',
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(email)`,

  // ----- gifts, hosts, payouts -----
  `CREATE TABLE IF NOT EXISTS gift_transactions (
    id TEXT PRIMARY KEY,
    gift TEXT NOT NULL,
    coin BIGINT NOT NULL,
    sender_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    golden_stars BIGINT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gift_host ON gift_transactions(host_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_gift_sender ON gift_transactions(sender_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_gift_created ON gift_transactions(created_at)`,
  `CREATE TABLE IF NOT EXISTS host_stats (
    host_id TEXT PRIMARY KEY,
    gifts BIGINT NOT NULL DEFAULT 0,
    gift_coins BIGINT NOT NULL DEFAULT 0,
    loves BIGINT NOT NULL DEFAULT 0,
    viewers BIGINT NOT NULL DEFAULT 0,
    withdrawn_stars BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS live_sessions (
    id BIGSERIAL PRIMARY KEY,
    host_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    ended_at BIGINT,
    last_beat BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_sessions_host ON live_sessions(host_id)`,
  `CREATE INDEX IF NOT EXISTS idx_live_sessions_room ON live_sessions(room_id)`,
  `CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    method TEXT, account_name TEXT, bank_name TEXT, account_number TEXT,
    amount DOUBLE PRECISION, currency TEXT,
    stars BIGINT, stars_spent BIGINT,
    month TEXT, status TEXT, security_status TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawal_creator ON withdrawal_requests(creator_id)`,
  `CREATE TABLE IF NOT EXISTS withdrawal_security (
    creator_id TEXT PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    banned SMALLINT NOT NULL DEFAULT 0,
    disqualified SMALLINT NOT NULL DEFAULT 0,
    last_attempt_at TEXT
  )`,

  // ----- social -----
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, host_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_follows_host ON follows(host_id)`,
  `CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id)`,
  `CREATE TABLE IF NOT EXISTS fan_members (
    host_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    points BIGINT NOT NULL DEFAULT 0,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    is_host SMALLINT NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS pk_battles (
    id TEXT PRIMARY KEY, host_a TEXT NOT NULL, host_b TEXT NOT NULL, room_a TEXT, room_b TEXT,
    score_a BIGINT NOT NULL DEFAULT 0, score_b BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', winner TEXT,
    started_at BIGINT NOT NULL, ends_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pk_status ON pk_battles(status, ends_at)`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL, text TEXT NOT NULL, link TEXT,
    read SMALLINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)`,
  `CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    reporter TEXT, room_id TEXT, host_id TEXT, reason TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at BIGINT NOT NULL
  )`,

  // ----- forex academy (paid membership) -----
  `CREATE TABLE IF NOT EXISTS forex_members (
    email TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL DEFAULT 0,
    lifetime SMALLINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS forex_payments (
    reference TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount_minor BIGINT NOT NULL,
    days INTEGER NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS forex_state (
    email TEXT PRIMARY KEY,
    progress TEXT, paper TEXT, journal TEXT,
    updated_at BIGINT NOT NULL
  )`,

  // ----- help center / support tickets -----
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reference TEXT, page TEXT, user_agent TEXT,
    last_from TEXT NOT NULL DEFAULT 'user',
    user_unread SMALLINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_email ON support_tickets(email, updated_at)`,
  `CREATE TABLE IF NOT EXISTS support_messages (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id)`
];

db.migrate = async function () {
  // Advisory lock: if two copies of the app start at the same moment, only one builds the tables.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    for (const sql of SCHEMA) await client.query(sql);
    // A crash/restart leaves live sessions open forever. Close them at the last moment we know the host was alive.
    await client.query("UPDATE live_sessions SET ended_at = COALESCE(last_beat, started_at) WHERE ended_at IS NULL");
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(727274)"); } catch (_) { /* ignore */ }
    client.release();
  }
};

db.close = () => pool.end();
module.exports = db;
