'use strict';
// VicoPay platform health, incident log and emergency API maintenance gate.
module.exports = function registerPlatformOperations({ app, db, requireAdmin, getMaintenance, setMaintenance, env, livekit }) {
  const now = () => Date.now();
  const clean = (v, n=500) => String(v == null ? '' : v).trim().slice(0,n);
  async function migrate() {
    await db.run(`CREATE TABLE IF NOT EXISTS platform_incidents (
      id BIGSERIAL PRIMARY KEY, severity TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, created_at BIGINT NOT NULL,
      resolved_by TEXT, resolved_at BIGINT)`);
    await db.run(`CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_by TEXT NOT NULL, updated_at BIGINT NOT NULL)`);
    const row = await db.get("SELECT value FROM platform_settings WHERE key='maintenance'");
    if (row?.value) setMaintenance(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
  }
  app.get('/api/admin/platform/health', requireAdmin, async (req,res) => {
    const checks = { database: 'unknown', paystack: env.PAYSTACK_SECRET_KEY ? 'configured' : 'missing_credentials', livekit: livekit.url && livekit.key && livekit.secret ? 'configured' : 'missing_credentials' };
    try { await db.get('SELECT 1 AS ok'); checks.database='healthy'; } catch (_) { checks.database='unavailable'; }
    const incidents = await db.get("SELECT COUNT(*)::int AS open FROM platform_incidents WHERE status='open'");
    res.json({ success:true, checks, process:{ uptimeSeconds:Math.floor(process.uptime()), node:process.version, memoryRssBytes:process.memoryUsage().rss }, maintenance:getMaintenance(), openIncidents:incidents?.open||0, checkedAt:new Date().toISOString() });
  });
  app.get('/api/admin/platform/incidents', requireAdmin, async (req,res) => {
    const rows=await db.all('SELECT id,severity,title,description,status,created_by AS "createdBy",created_at AS "createdAt",resolved_by AS "resolvedBy",resolved_at AS "resolvedAt" FROM platform_incidents ORDER BY created_at DESC LIMIT 200');
    res.json({success:true,incidents:rows});
  });
  app.post('/api/admin/platform/incidents', requireAdmin, async (req,res) => {
    const severity=clean(req.body?.severity,12), title=clean(req.body?.title,160), description=clean(req.body?.description,1000);
    if(!['low','medium','high','critical'].includes(severity)||!title||!description) return res.status(400).json({success:false,message:'Severity, title and description are required.'});
    const actor=clean(req.headers['x-admin-actor']||'admin-key',180);
    const r=await db.get(`INSERT INTO platform_incidents(severity,title,description,created_by,created_at) VALUES(?,?,?,?,?) RETURNING id`,[severity,title,description,actor,now()]);
    res.status(201).json({success:true,id:r.id});
  });
  app.post('/api/admin/platform/incidents/:id/resolve', requireAdmin, async (req,res) => {
    const actor=clean(req.headers['x-admin-actor']||'admin-key',180);
    const r=await db.run("UPDATE platform_incidents SET status='resolved',resolved_by=?,resolved_at=? WHERE id=? AND status='open'",[actor,now(),Number(req.params.id)]);
    if(!r.changes) return res.status(404).json({success:false,message:'Open incident not found.'});
    res.json({success:true});
  });
  app.post('/api/admin/platform/maintenance', requireAdmin, async (req,res) => {
    const enabled=!!req.body?.enabled, message=clean(req.body?.message,240)||'VicoPay is temporarily undergoing maintenance.';
    const value={enabled,message,changedAt:new Date().toISOString()};
    await db.run(`INSERT INTO platform_settings(key,value,updated_by,updated_at) VALUES('maintenance',?::jsonb,?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,[JSON.stringify(value),'admin-key',now()]);
    setMaintenance(value);
    res.json({success:true,maintenance:value,message:enabled?'Public API maintenance gate enabled.':'Public API maintenance gate disabled.'});
  });
  return {migrate};
};
