// VicoPay Super Admin Command Centre — live data + explainable fraud signals.
// All actions are administrative review actions; this module never automatically freezes money/accounts.
const crypto = require('crypto');
const { RoomServiceClient } = require('livekit-server-sdk');

module.exports = function registerCommandCenter({ app, db, requireAdmin, liveRooms, livekit }) {
  const lkReady = !!(livekit && livekit.url && livekit.key && livekit.secret);
  const livekitHost = lkReady ? String(livekit.url).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:') : '';
  const roomService = lkReady ? new RoomServiceClient(livekitHost, livekit.key, livekit.secret) : null;

  async function migrate() {
    await db.run(`CREATE TABLE IF NOT EXISTS admin_security_events (
      id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
      subject TEXT, ip_address TEXT, device TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, reviewed_at BIGINT, review_note TEXT
    )`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_admin_security_events_created ON admin_security_events(created_at DESC)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_admin_security_events_status ON admin_security_events(status, severity)`);
    await db.run(`CREATE TABLE IF NOT EXISTS admin_login_attempts (
      id BIGSERIAL PRIMARY KEY, login_hint TEXT, ip_address TEXT, device TEXT, success SMALLINT NOT NULL,
      created_at BIGINT NOT NULL
    )`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip_time ON admin_login_attempts(ip_address, created_at DESC)`);
    await db.run(`CREATE TABLE IF NOT EXISTS admin_payment_attempts (
      id BIGSERIAL PRIMARY KEY, reference TEXT, email TEXT, ip_address TEXT, amount DOUBLE PRECISION,
      currency TEXT, status TEXT NOT NULL, created_at BIGINT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_admin_payment_attempts_ip_time ON admin_payment_attempts(ip_address, created_at DESC)`);
    await db.run(`CREATE TABLE IF NOT EXISTS admin_fraud_alerts (
      id TEXT PRIMARY KEY, rule_key TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, subject TEXT, evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'open', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      reviewed_by TEXT, review_note TEXT
    )`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_admin_fraud_alerts_status ON admin_fraud_alerts(status, created_at DESC)`);
  }

  const ipOf = (req) => String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 100);
  const deviceOf = (req) => String(req.headers['user-agent'] || '').slice(0, 300);
  async function recordLogin({ login, ip, device, success }) {
    try {
      const now = Date.now(), safeLogin = String(login || '').slice(0, 120), safeIp = String(ip || '').slice(0, 100), safeDevice = String(device || '').slice(0, 300);
      await db.run('INSERT INTO admin_login_attempts(login_hint, ip_address, device, success, created_at) VALUES(?,?,?,?,?)',
        [safeLogin, safeIp, safeDevice, success ? 1 : 0, now]);
      await db.run('INSERT INTO admin_security_events(event_type, severity, subject, ip_address, device, details, created_at) VALUES(?,?,?,?,?,?::jsonb,?)',
        [success ? 'login_success' : 'login_failed', success ? 'low' : 'medium', safeLogin, safeIp, safeDevice, JSON.stringify({ success: !!success }), now]);
    } catch (e) { console.warn('Command centre login event could not be stored:', e.message); }
  }

  async function recordPaymentAttempt({ reference, email, ip, amount, currency, status, details }) {
    try {
      await db.run(`INSERT INTO admin_payment_attempts(reference,email,ip_address,amount,currency,status,created_at,details)
        VALUES(?,?,?,?,?,?,?,?::jsonb)`, [reference || null, String(email || '').slice(0,120), String(ip || '').slice(0,100),
        Number(amount || 0), String(currency || '').slice(0,8), String(status || 'unknown').slice(0,40), Date.now(), JSON.stringify(details || {})]);
    } catch (e) { console.warn('Command centre payment event could not be stored:', e.message); }
  }

  async function getLiveRooms() {
    const output = [];
    let source = 'in-memory', livekitQuerySucceeded = false;
    if (roomService) {
      try {
        const rooms = await roomService.listRooms();
        source = 'livekit'; livekitQuerySucceeded = true;
        for (const r of (rooms || [])) {
          let participants = [];
          try { participants = await roomService.listParticipants(r.name); } catch (_) { /* room may close while polling */ }
          const local = liveRooms.get(String(r.name));
          const viewerCount = Math.max(0, (participants || []).length - (participants?.length ? 1 : 0));
          output.push({ roomId: r.name, hostId: local?.hostId || '', title: local?.title || 'Live stream', viewers: viewerCount, participants: (participants || []).length, startedAt: local?.createdAt || null, source: 'livekit' });
        }
      } catch (e) {
        source = 'in-memory-fallback';
        console.warn('LiveKit command-centre query failed:', e.message);
      }
    }
    if (!livekitQuerySucceeded) {
      if (roomService && source !== 'in-memory-fallback') source = 'in-memory-fallback';
      for (const [roomId, room] of liveRooms.entries()) output.push({ roomId, hostId: room.hostId || '', title: room.title || room.name || 'Live stream', viewers: Number(room.viewers || 0), participants: null, startedAt: room.createdAt || null, source: 'server-memory' });
    }
    return { rooms: output, source };
  }

  async function raiseAlert(ruleKey, severity, title, description, subject, evidence) {
    const id = crypto.createHash('sha256').update(ruleKey + '|' + String(subject || '') + '|' + JSON.stringify(evidence || {})).digest('hex').slice(0, 32);
    const now = Date.now();
    await db.run(`INSERT INTO admin_fraud_alerts(id, rule_key, severity, title, description, subject, evidence, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?::jsonb,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=EXCLUDED.updated_at,
      evidence=EXCLUDED.evidence WHERE admin_fraud_alerts.status='open'`,
      [id, ruleKey, severity, title, description, subject || null, JSON.stringify(evidence || {}), now, now]);
  }

  async function scanFraud() {
    const now = Date.now(), since = now - 15 * 60 * 1000;
    const failed = await db.all(`SELECT ip_address, COUNT(*)::int AS attempts, COUNT(DISTINCT login_hint)::int AS accounts
      FROM admin_login_attempts WHERE success=0 AND created_at>=? AND COALESCE(ip_address,'')<>''
      GROUP BY ip_address HAVING COUNT(*)>=5`, [since]);
    for (const row of failed) await raiseAlert('login_bruteforce', 'high', 'Repeated failed sign-in attempts',
      `${row.attempts} failed sign-in attempts against ${row.accounts} account identifiers from one IP in 15 minutes. Review before taking action.`, row.ip_address, row);

    const giftBursts = await db.all(`SELECT sender_id, COUNT(*)::int AS gifts, COALESCE(SUM(coin),0)::bigint AS coins
      FROM gift_transactions WHERE created_at::timestamptz >= to_timestamp(? / 1000.0)
      GROUP BY sender_id HAVING COUNT(*)>=20`, [String(now - 60 * 1000)]).catch(() => []);
    for (const row of giftBursts) await raiseAlert('gift_burst', 'medium', 'Unusually rapid gifting',
      `${row.gifts} gifts totalling ${row.coins} coins were recorded for this sender in one minute. Check for scripted or abusive activity.`, row.sender_id, row);

    const failedPayments = await db.all(`SELECT ip_address, COUNT(*)::int AS attempts, COUNT(DISTINCT email)::int AS accounts
      FROM admin_payment_attempts WHERE status IN ('initialize_failed','verify_failed') AND created_at>=?
      AND COALESCE(ip_address,'')<>'' GROUP BY ip_address HAVING COUNT(*)>=4`, [since]).catch(() => []);
    for (const row of failedPayments) await raiseAlert('payment_failure_burst', 'high', 'Repeated failed payment attempts',
      `${row.attempts} failed payment attempts across ${row.accounts} customer email(s) came from this IP in 15 minutes. Check Paystack references and customer activity.`, row.ip_address, row);

    const dupes = await db.all(`SELECT reference, COUNT(*)::int AS occurrences, COUNT(DISTINCT email)::int AS accounts
      FROM transactions WHERE kind='purchase' AND reference IS NOT NULL AND reference<>'' GROUP BY reference HAVING COUNT(*)>1`).catch(() => []);
    for (const row of dupes) await raiseAlert('duplicate_payment_reference', 'critical', 'Duplicate payment reference detected',
      `Payment reference ${row.reference} appears more than once in the payment records. Verify against Paystack before any manual correction.`, row.reference, row);

    const suspiciousWithdrawals = await db.all(`SELECT creator_id, COUNT(*)::int AS requests, MAX(amount)::float AS largest_amount
      FROM withdrawal_requests WHERE created_at::timestamptz >= now() - interval '24 hours'
      AND LOWER(COALESCE(status,'')) IN ('pending','processing','requested') GROUP BY creator_id HAVING COUNT(*)>=3`).catch(() => []);
    for (const row of suspiciousWithdrawals) await raiseAlert('withdrawal_velocity', 'medium', 'Multiple withdrawal requests',
      `${row.requests} pending withdrawal requests were found for this creator in 24 hours. Review payout history and identity checks.`, row.creator_id, row);

    return { scannedAt: now, rulesRun: 4, findings: failed.length + giftBursts.length + dupes.length + suspiciousWithdrawals.length };
  }

  app.get('/api/admin/command-center/overview', requireAdmin, async (req, res) => {
    const now = Date.now(), day = now - 24 * 60 * 60 * 1000;
    const [live, users, payments, gifts, alerts, loginStats, sessions] = await Promise.all([
      getLiveRooms(),
      db.get('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at IS NOT NULL AND created_at::timestamptz >= now() - interval \'24 hours\')::int AS new_today FROM users'),
      db.get('SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_ngn),0)::float AS ngn FROM payments WHERE created_at>=?', [day]).catch(() => ({ count: 0, ngn: 0 })),
      db.get('SELECT COUNT(*)::int AS count, COALESCE(SUM(coin),0)::bigint AS coins FROM gift_transactions WHERE created_at::timestamptz >= to_timestamp(? / 1000.0)', [day]).catch(() => ({ count: 0, coins: 0 })),
      db.get("SELECT COUNT(*)::int AS open, COUNT(*) FILTER (WHERE severity IN ('high','critical'))::int AS urgent FROM admin_fraud_alerts WHERE status='open'"),
      db.get('SELECT COUNT(*) FILTER (WHERE success=0)::int AS failed FROM admin_login_attempts WHERE created_at>=?', [day]),
      db.get('SELECT COUNT(*)::int AS active FROM live_sessions WHERE ended_at IS NULL AND COALESCE(last_beat,started_at)>=?', [now - 2 * 60 * 1000]).catch(() => ({ active: 0 }))
    ]);
    const failedPaymentStats = await db.get("SELECT COUNT(*)::int AS failed FROM admin_payment_attempts WHERE status IN ('initialize_failed','verify_failed') AND created_at>=?", [day]).catch(() => ({ failed: 0 }));
    const recent = await db.all(`SELECT id, rule_key AS "ruleKey", severity, title, description, subject, evidence,
      status, created_at AS "createdAt", reviewed_by AS "reviewedBy", review_note AS "reviewNote"
      FROM admin_fraud_alerts ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT 30`);
    const liveCount = live.rooms.length;
    const totalViewers = live.rooms.reduce((n, r) => n + Number(r.viewers || 0), 0);
    res.json({ success: true, generatedAt: now, dataStatus: { live: live.source, livekitConfigured: lkReady }, metrics: {
      registeredUsers: users?.total || 0, newUsers24h: users?.new_today || 0, activeStreamers: liveCount,
      liveViewers: totalViewers, paymentCount24h: payments?.count || 0, paymentNgn24h: payments?.ngn || 0,
      gifts24h: gifts?.count || 0, giftCoins24h: gifts?.coins || 0, openAlerts: alerts?.open || 0,
      urgentAlerts: alerts?.urgent || 0, failedLogins24h: loginStats?.failed || 0, failedPaymentAttempts24h: failedPaymentStats?.failed || 0, storedActiveSessions: sessions?.active || 0
    }, liveRooms: live.rooms, alerts: recent });
  });

  app.post('/api/admin/command-center/scan', requireAdmin, async (req, res) => {
    const result = await scanFraud();
    res.json({ success: true, ...result });
  });

  app.post('/api/admin/command-center/alerts/:id/review', requireAdmin, async (req, res) => {
    const status = String(req.body?.status || 'reviewed');
    if (!['reviewed', 'resolved', 'dismissed'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid alert status.' });
    const note = String(req.body?.note || '').slice(0, 1000);
    const result = await db.run(`UPDATE admin_fraud_alerts SET status=?, reviewed_by=?, review_note=?, updated_at=? WHERE id=?`,
      [status, String(req.headers['x-admin-user'] || 'super-admin').slice(0, 120), note, Date.now(), req.params.id]);
    if (!result.changes) return res.status(404).json({ success: false, message: 'Alert not found.' });
    res.json({ success: true, status });
  });

  app.get('/api/admin/command-center/events', requireAdmin, async (req, res) => {
    const rows = await db.all(`SELECT id, event_type AS "eventType", severity, subject, ip_address AS ip,
      device, details, created_at AS "createdAt", status FROM admin_security_events ORDER BY created_at DESC LIMIT 100`);
    res.json({ success: true, events: rows });
  });

  return { migrate, recordLogin, recordPaymentAttempt, scanFraud };
};
