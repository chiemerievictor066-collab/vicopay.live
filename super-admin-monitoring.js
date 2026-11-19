// VicoPay Super Admin Monitoring — read-only operational visibility plus security investigation notes.
// All endpoints are protected by the existing ADMIN_KEY middleware. New table only; no existing schema is changed.
module.exports = function registerSuperAdminMonitoring({ app, db, requireAdmin }) {
  const now = () => Date.now();
  const safe = async (sql, params = []) => { try { return await db.all(sql, params); } catch (e) { console.error('[super-admin-monitoring]', e.message); return []; } };
  const one = async (sql, params = []) => { const rows = await safe(sql, params); return rows[0] || {}; };
  const ensure = db.run(`CREATE TABLE IF NOT EXISTS admin_security_events (
    id BIGSERIAL PRIMARY KEY, event_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
    email TEXT, ip TEXT, device TEXT, detail TEXT, status TEXT NOT NULL DEFAULT 'open',
    investigated_by TEXT, investigation_note TEXT, created_at BIGINT NOT NULL, resolved_at BIGINT
  )`).catch(e => console.error('monitoring schema:', e.message));
  db.run('CREATE INDEX IF NOT EXISTS idx_admin_security_events_time ON admin_security_events(created_at DESC)').catch(()=>{});
  app.post('/api/monitoring/security-event', async (req,res) => {
    // Internal, unauthenticated telemetry is deliberately NOT exposed. Login route writes directly using db.
    res.status(404).json({success:false});
  });
  app.get('/api/admin/super-monitoring/overview', requireAdmin, async (req,res) => {
    await ensure;
    const [users,live,viewers,purchases,gifts,withdrawals,market,alerts,failedPayments] = await Promise.all([
      one('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > ?)::int AS new_24h FROM users', [new Date(now()-86400000).toISOString()]),
      one('SELECT COUNT(*)::int AS total FROM live_sessions WHERE ended_at IS NULL AND COALESCE(last_beat,started_at) > ?', [now()-180000]),
      one('SELECT COALESCE(SUM(viewers),0)::int AS total FROM host_stats'),
      one("SELECT COUNT(*)::int AS total, COALESCE(SUM(amount_ngn),0)::numeric AS ngn FROM payments WHERE status='ok' AND created_at > ?", [now()-86400000]),
      one('SELECT COUNT(*)::int AS total, COALESCE(SUM(coin),0)::numeric AS coins FROM gift_transactions WHERE created_at > ?', [new Date(now()-86400000).toISOString()]),
      one("SELECT COUNT(*)::int AS total FROM withdrawal_requests WHERE lower(COALESCE(status,'')) IN ('pending','processing','requested')"),
      one("SELECT COUNT(*)::int AS total, COALESCE(SUM(amount_ngn),0)::numeric AS gmv FROM market_orders WHERE created_at > ?", [now()-86400000]),
      one("SELECT COUNT(*)::int AS total FROM admin_security_events WHERE status='open' AND severity IN ('high','critical')"),
      one("SELECT COUNT(*)::int AS total FROM payments WHERE status NOT IN ('ok','success','paid') AND created_at > ?", [now()-86400000])
    ]);
    res.json({success:true,generatedAt:now(),users,live,viewers,purchases,gifts,withdrawals,market,alerts,failedPayments});
  });
  app.get('/api/admin/super-monitoring/registrations', requireAdmin, async(req,res)=>{
    await ensure; const rows=await safe(`SELECT u.email,u.username,u.display_name AS "displayName",u.created_at AS "createdAt",u.signup_ip AS "signupIp",u.last_ip AS "lastIp",COALESCE(b.banned,0)::int AS banned FROM users u LEFT JOIN user_flags b ON b.email=u.email ORDER BY u.id DESC LIMIT 250`); res.json({success:true,rows});
  });
  app.get('/api/admin/super-monitoring/streamers', requireAdmin, async(req,res)=>{
    const rows=await safe(`SELECT s.id,s.host_id AS email,s.room_id AS "roomId",s.started_at AS "startedAt",s.last_beat AS "lastBeat",u.display_name AS "displayName",u.username FROM live_sessions s LEFT JOIN users u ON u.email=s.host_id WHERE s.ended_at IS NULL AND COALESCE(s.last_beat,s.started_at)>? ORDER BY s.started_at DESC LIMIT 200`,[now()-180000]);
    res.json({success:true,rows:rows.map(x=>({...x,durationSeconds:Math.max(0,Math.floor((now()-Number(x.startedAt||now()))/1000))}))});
  });
  app.get('/api/admin/super-monitoring/activity', requireAdmin, async(req,res)=>{
    const [gifts,payments,withdrawals,creatorEarnings]=await Promise.all([
      safe('SELECT id,gift,coin,sender_id AS sender,host_id AS recipient,created_at AS "createdAt" FROM gift_transactions ORDER BY created_at DESC LIMIT 150'),
      safe('SELECT reference,email,coins,amount_ngn AS amount,status,created_at AS "createdAt" FROM payments ORDER BY created_at DESC LIMIT 150'),
      safe('SELECT id,creator_id AS creator,amount,currency,status,security_status AS "securityStatus",created_at AS "createdAt" FROM withdrawal_requests ORDER BY created_at DESC LIMIT 100'),
      safe('SELECT host_id AS creator,COUNT(*)::int AS gifts,COALESCE(SUM(golden_stars),0)::numeric AS earned_stars,COALESCE(SUM(coin),0)::numeric AS gift_coins FROM gift_transactions GROUP BY host_id ORDER BY earned_stars DESC LIMIT 100')
    ]); res.json({success:true,gifts,payments,withdrawals,creatorEarnings});
  });
  app.get('/api/admin/super-monitoring/marketplace', requireAdmin, async(req,res)=>{
    const rows=await safe('SELECT id,title,seller,buyer,amount_ngn AS amount,status,created_at AS "createdAt" FROM market_orders ORDER BY created_at DESC LIMIT 200');
    const sellers=await safe('SELECT seller,COUNT(*)::int AS listings FROM market_listings GROUP BY seller ORDER BY listings DESC LIMIT 100'); res.json({success:true,orders:rows,sellers});
  });
  app.get('/api/admin/super-monitoring/security', requireAdmin, async(req,res)=>{
    await ensure; const events=await safe('SELECT id,event_type AS type,severity,email,ip,device,detail,status,investigated_by AS "investigatedBy",investigation_note AS "investigationNote",created_at AS "createdAt" FROM admin_security_events ORDER BY created_at DESC LIMIT 300');
    const users=await safe(`SELECT email,signup_ip AS "signupIp",last_ip AS "lastIp" FROM users WHERE COALESCE(last_ip,'')<>'' ORDER BY id DESC LIMIT 200`); res.json({success:true,events,recentIpActivity:users});
  });
  app.post('/api/admin/super-monitoring/security/:id/investigate', requireAdmin, async(req,res)=>{
    await ensure; const status=['open','investigating','resolved'].includes(String(req.body.status))?String(req.body.status):'investigating';
    const note=String(req.body.note||'').slice(0,2000); const admin=String(req.body.admin||'super-admin').slice(0,120);
    const r=await db.run('UPDATE admin_security_events SET status=?,investigated_by=?,investigation_note=?,resolved_at=? WHERE id=?',[status,admin,note,status==='resolved'?now():null,Number(req.params.id)]);
    res.json({success:true,updated:r.changes});
  });
};
