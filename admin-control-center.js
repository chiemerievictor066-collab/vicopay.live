'use strict';
// VicoPay Super Admin Enforcement & Control Centre.
// Staff access is role-scoped, TOTP protected, and every consequential action is audit logged.
const crypto = require('crypto');

module.exports = function registerAdminControl({ app, db, requireAdmin, store, bannedUsers, authSecret }) {
  const ROLES = {
    super_admin: ['*'],
    security_analyst: ['dashboard.read','alerts.read','alerts.review','accounts.read','accounts.suspend','devices.block','market.read','market.moderate'],
    finance_admin: ['dashboard.read','alerts.read','alerts.review','payouts.hold','payouts.release','payouts.read'],
    support_admin: ['dashboard.read','alerts.read','accounts.read','accounts.suspend','market.read']
  };
  const now = () => Date.now();
  const clean = (v, n=180) => String(v == null ? '' : v).trim().slice(0,n);
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
  const secret = String(authSecret || process.env.AUTH_SECRET || '');
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function base32(buf) {
    let bits=0, value=0, out='';
    for (const byte of buf) { value=(value<<8)|byte; bits+=8; while(bits>=5){out+=b32[(value >>> (bits-5))&31];bits-=5;} }
    if(bits) out+=b32[(value << (5-bits))&31];
    return out;
  }
  function unbase32(s) {
    let bits=0,value=0,out=[];
    for(const c of String(s).replace(/=+$/,'').toUpperCase()) { const x=b32.indexOf(c); if(x<0) throw new Error('Invalid MFA secret'); value=(value<<5)|x;bits+=5;if(bits>=8){out.push((value >>> (bits-8))&255);bits-=8;} }
    return Buffer.from(out);
  }
  function totp(secretB32, at=Date.now()) {
    const counter=Math.floor(at/30000), msg=Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
    const mac=crypto.createHmac('sha1',unbase32(secretB32)).update(msg).digest();
    const off=mac[mac.length-1]&15, code=((mac.readUInt32BE(off)&0x7fffffff)%1000000).toString().padStart(6,'0'); return code;
  }
  function validTotp(secretB32, token) {
    const t=String(token||'').replace(/\s/g,''); if(!/^\d{6}$/.test(t)) return false;
    return [-1,0,1].some(d=>crypto.timingSafeEqual(Buffer.from(t),Buffer.from(totp(secretB32,now()+d*30000))));
  }
  const passwordHash = async (pw, salt) => new Promise((resolve,reject)=>crypto.scrypt(String(pw),salt,64,(e,k)=>e?reject(e):resolve(k.toString('hex'))));
  function sign(payload) { const p=Buffer.from(JSON.stringify(payload)).toString('base64url'); return p+'.'+crypto.createHmac('sha256',secret).update(p).digest('base64url'); }
  function readToken(token) {
    if(!secret || !token || !token.includes('.')) return null;
    const [p,s]=token.split('.'), expected=crypto.createHmac('sha256',secret).update(p).digest('base64url');
    if(!s || s.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expected))) return null;
    try { const x=JSON.parse(Buffer.from(p,'base64url').toString()); return x.exp>now()?x:null; } catch(_){return null;}
  }
  function actor(req) {
    const raw=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    const token=readToken(raw); return token ? token : null;
  }
  function isRoot(req) {
    const given=String(req.headers['x-admin-key']||''), expected=String(process.env.ADMIN_KEY||'');
    return !!expected && given.length===expected.length && crypto.timingSafeEqual(Buffer.from(given),Buffer.from(expected));
  }
  function has(role, permission) { const p=ROLES[role]||[]; return p.includes('*')||p.includes(permission); }
  async function authorize(req,res,permission) {
    if(isRoot(req)) { req.adminActor={email:'root-key',role:'super_admin'}; return true; }
    const token=actor(req); if(!token) {res.status(401).json({success:false,message:'Admin sign-in required.'});return false;}
    const user=await db.get('SELECT email, role, active FROM admin_operators WHERE email=?',[token.sub]);
    if(!user || Number(user.active)!==1 || user.role!==token.role) {res.status(401).json({success:false,message:'Admin session is no longer valid.'});return false;}
    if(!has(user.role,permission)) {res.status(403).json({success:false,message:'Your administrator role cannot perform this action.'});return false;}
    req.adminActor={email:user.email,role:user.role}; return true;
  }
  async function audit(req, action, target, detail={}) {
    await db.run(`INSERT INTO admin_action_audit(actor_email,actor_role,action,target,details,ip_address,created_at)
      VALUES(?,?,?,?,?::jsonb,?,?)`,[req.adminActor?.email||'system',req.adminActor?.role||'system',action,clean(target,240),JSON.stringify(detail),clean(req.ip,100),now()]);
  }
  async function migrate() {
    await db.run(`CREATE TABLE IF NOT EXISTS admin_operators (
      email TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL,
      password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, active SMALLINT NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL, created_at BIGINT NOT NULL, last_login_at BIGINT)`);
    await db.run(`CREATE TABLE IF NOT EXISTS admin_operator_login_attempts (
      id BIGSERIAL PRIMARY KEY, email TEXT, ip_address TEXT, success SMALLINT NOT NULL, created_at BIGINT NOT NULL)`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_admin_operator_login_ip ON admin_operator_login_attempts(ip_address,created_at DESC)');
    await db.run(`CREATE TABLE IF NOT EXISTS admin_action_audit (
      id BIGSERIAL PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address TEXT, created_at BIGINT NOT NULL)`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_admin_action_audit_time ON admin_action_audit(created_at DESC)');
    await db.run(`CREATE TABLE IF NOT EXISTS admin_payout_holds (
      creator_id TEXT PRIMARY KEY, reason TEXT NOT NULL, held_by TEXT NOT NULL, held_at BIGINT NOT NULL,
      released_by TEXT, released_at BIGINT, active SMALLINT NOT NULL DEFAULT 1)`);
    await db.run(`CREATE TABLE IF NOT EXISTS admin_blocked_signin_fingerprints (
      id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, label TEXT, reason TEXT NOT NULL,
      active SMALLINT NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at BIGINT NOT NULL,
      UNIQUE(kind,fingerprint))`);
  }

  app.post('/api/admin/control/operators', requireAdmin, async (req,res)=>{
    const email=clean(req.body?.email,180).toLowerCase(), name=clean(req.body?.displayName,100), role=clean(req.body?.role,40), password=String(req.body?.password||'');
    if(!/^\S+@\S+\.\S+$/.test(email) || !name || !ROLES[role] || role==='super_admin' || password.length<12) return res.status(400).json({success:false,message:'Provide a valid email, name, permitted staff role, and password of at least 12 characters. Super Admin accounts cannot be created through this endpoint.'});
    const salt=crypto.randomBytes(16).toString('hex'), secretB32=base32(crypto.randomBytes(20));
    const ph=await passwordHash(password,salt);
    try {
      await db.run(`INSERT INTO admin_operators(email,display_name,role,salt,password_hash,totp_secret,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?)`,[email,name,role,salt,ph,secretB32,'root-key',now()]);
    } catch(e) { if(e.code==='23505') return res.status(409).json({success:false,message:'An administrator with that email already exists.'}); throw e; }
    await audit({adminActor:{email:'root-key',role:'super_admin'},ip:req.ip},'operator.created',email,{role});
    res.status(201).json({success:true,operator:{email,displayName:name,role},mfa:{secret:secretB32,otpauth:`otpauth://totp/VicoPay:${encodeURIComponent(email)}?secret=${secretB32}&issuer=VicoPay&algorithm=SHA1&digits=6&period=30`},message:'Save this MFA secret securely. It is shown only once; the operator must add it to an authenticator app.'});
  });
  app.get('/api/admin/control/operators', requireAdmin, async (req,res)=>{
    const rows=await db.all('SELECT email,display_name AS "displayName",role,active,created_at AS "createdAt",last_login_at AS "lastLoginAt" FROM admin_operators ORDER BY created_at DESC');
    res.json({success:true,operators:rows});
  });
  app.post('/api/admin/control/operators/:email/disable', requireAdmin, async (req,res)=>{
    const email=clean(req.params.email,180).toLowerCase();
    const r=await db.run('UPDATE admin_operators SET active=0 WHERE email=?',[email]);
    if(!r.changes) return res.status(404).json({success:false,message:'Administrator not found.'});
    await audit({adminActor:{email:'root-key',role:'super_admin'},ip:req.ip},'operator.disabled',email,{});
    res.json({success:true});
  });

  app.post('/api/admin/control/login', async (req,res)=>{
    const email=clean(req.body?.email,180).toLowerCase(), password=String(req.body?.password||''), otp=String(req.body?.otp||''), ip=clean(req.ip,100), at=now();
    const recent=await db.get('SELECT COUNT(*)::int AS n FROM admin_operator_login_attempts WHERE ip_address=? AND success=0 AND created_at>?',[ip,at-15*60*1000]);
    if(Number(recent?.n||0)>=5) return res.status(429).json({success:false,message:'Too many failed administrator sign-in attempts. Try again in 15 minutes.'});
    const u=await db.get('SELECT * FROM admin_operators WHERE email=? AND active=1',[email]);
    let ok=false;
    if(u && password.length && validTotp(u.totp_secret,otp)) { const candidate=await passwordHash(password,u.salt); ok=candidate===u.password_hash; }
    await db.run('INSERT INTO admin_operator_login_attempts(email,ip_address,success,created_at) VALUES(?,?,?,?)',[email,ip,ok?1:0,at]);
    if(!ok) return res.status(401).json({success:false,message:'Invalid administrator credentials or authenticator code.'});
    await db.run('UPDATE admin_operators SET last_login_at=? WHERE email=?',[at,email]);
    req.adminActor={email,role:u.role}; await audit(req,'admin.login',email,{mfa:true});
    const token=sign({sub:email,role:u.role,exp:at+8*60*60*1000});
    res.json({success:true,token,expiresAt:at+8*60*60*1000,operator:{email,displayName:u.display_name,role:u.role}});
  });

  // Unified Master Admin read model. Each optional subsystem is isolated so a missing
  // commerce module/table does not take down the complete operations dashboard.
  app.get('/api/admin/master/overview', async (req,res)=>{
    if(!await authorize(req,res,'dashboard.read')) return;
    const since=now()-24*60*60*1000;
    const safeGet=async(sql,args=[])=>{try{return await db.get(sql,args)||{};}catch(_){return {};}};
    const safeAll=async(sql,args=[])=>{try{return await db.all(sql,args)||[];}catch(_){return [];}};
    const [customers, banned, purchases, gifts, live, withdrawals, orders, sellers, alerts, holds, staff, latestOrders, latestWithdrawals, latestAlerts] = await Promise.all([
      safeGet('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at IS NOT NULL AND created_at::timestamptz >= to_timestamp(? / 1000.0))::int AS new24h FROM users',[since]),
      safeGet('SELECT COUNT(*)::int AS total FROM user_flags WHERE banned=1'),
      safeGet("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_ngn),0)::float AS ngn FROM payments WHERE created_at>=? AND status='ok'",[since]),
      safeGet('SELECT COUNT(*)::int AS count, COALESCE(SUM(coin),0)::bigint AS coins FROM gift_transactions WHERE created_at::timestamptz >= to_timestamp(? / 1000.0)',[since]),
      safeGet("SELECT COUNT(*)::int AS active FROM live_sessions WHERE ended_at IS NULL AND COALESCE(last_beat,started_at)>=?",[now()-2*60*1000]),
      safeGet("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('pending','processing','requested'))::int AS pending, COALESCE(SUM(amount) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('pending','processing','requested')),0)::float AS pendingAmount FROM withdrawal_requests"),
      safeGet("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','refunded'))::int AS open, COALESCE(SUM(amount_ngn) FILTER (WHERE status='completed'),0)::bigint AS completedNgn FROM market_orders"),
      safeGet('SELECT COUNT(DISTINCT seller)::int AS total FROM market_orders'),
      safeGet("SELECT COUNT(*)::int AS open, COUNT(*) FILTER (WHERE severity IN ('high','critical'))::int AS urgent FROM admin_fraud_alerts WHERE status='open'"),
      safeGet('SELECT COUNT(*)::int AS active FROM admin_payout_holds WHERE active=1'),
      safeGet('SELECT COUNT(*)::int AS active FROM admin_operators WHERE active=1'),
      safeAll('SELECT id,title,seller,buyer,amount_ngn AS "amountNgn",status,created_at AS "createdAt" FROM market_orders ORDER BY created_at DESC LIMIT 8'),
      safeAll('SELECT id,creator_id AS "creatorId",amount,currency,status,created_at AS "createdAt" FROM withdrawal_requests ORDER BY created_at DESC LIMIT 8'),
      safeAll("SELECT id,title,severity,status,subject,created_at AS \"createdAt\" FROM admin_fraud_alerts ORDER BY created_at DESC LIMIT 8")
    ]);
    res.json({success:true,generatedAt:now(),metrics:{customers:customers.total||0,newCustomers24h:customers.new24h||0,suspendedCustomers:banned.total||0,
      successfulCoinPurchases24h:purchases.count||0,purchaseNgn24h:purchases.ngn||0,gifts24h:gifts.count||0,giftCoins24h:gifts.coins||0,
      activeLiveSessions:live.active||0,withdrawalRequests:withdrawals.total||0,pendingWithdrawals:withdrawals.pending||0,pendingWithdrawalAmount:withdrawals.pendingAmount||0,
      marketplaceOrders:orders.total||0,openMarketplaceOrders:orders.open||0,completedMarketplaceNgn:orders.completedNgn||0,marketplaceSellers:sellers.total||0,
      openSecurityAlerts:alerts.open||0,urgentSecurityAlerts:alerts.urgent||0,activePayoutHolds:holds.active||0,activeAdminOperators:staff.active||0},
      latestOrders,latestWithdrawals:has(req.adminActor.role,'payouts.read')?latestWithdrawals:[],latestAlerts:has(req.adminActor.role,'alerts.read')?latestAlerts:[],modules:{marketplace:typeof orders.total!=='undefined',security:true,payouts:has(req.adminActor.role,'payouts.read')}});
  });

  // Customer lookup for the action workspace. Search is deliberately bounded and
  // returns only operational identifiers/status, never password or private profile data.
  app.get('/api/admin/actions/customers', async (req,res)=>{
    if(!await authorize(req,res,'accounts.read')) return;
    const q=clean(req.query?.q,120).toLowerCase();
    if(q.length<2) return res.status(400).json({success:false,message:'Enter at least two characters to search.'});
    const like='%'+q+'%';
    let rows=[];
    try {
      rows=await db.all(`SELECT u.email, u.created_at AS "createdAt", COALESCE(f.banned,0)::int AS banned
        FROM users u LEFT JOIN user_flags f ON LOWER(f.email)=LOWER(u.email)
        WHERE LOWER(u.email) LIKE ? ORDER BY u.created_at DESC LIMIT 30`,[like]);
    } catch(e) {
      // Some deployments store the ban flag separately without an email column.
      rows=await db.all(`SELECT u.email, u.created_at AS "createdAt", 0::int AS banned
        FROM users u WHERE LOWER(u.email) LIKE ? ORDER BY u.created_at DESC LIMIT 30`,[like]);
    }
    res.json({success:true,customers:rows});
  });

  app.get('/api/admin/actions/withdrawals', async (req,res)=>{
    if(!await authorize(req,res,'payouts.read')) return;
    const rows=await db.all(`SELECT id,creator_id AS "creatorId",amount,currency,status,created_at AS "createdAt"
      FROM withdrawal_requests WHERE LOWER(COALESCE(status,'')) IN ('pending','processing','requested','held')
      ORDER BY created_at ASC LIMIT 100`);
    res.json({success:true,withdrawals:rows});
  });

  app.get('/api/admin/control/overview', async (req,res)=>{
    if(!await authorize(req,res,'dashboard.read')) return;
    const [operators, suspended, holds, blocks, auditRows]=await Promise.all([
      db.get('SELECT COUNT(*)::int AS n FROM admin_operators WHERE active=1'),
      db.get('SELECT COUNT(*)::int AS n FROM user_flags WHERE banned=1'),
      db.get('SELECT COUNT(*)::int AS n FROM admin_payout_holds WHERE active=1'),
      db.get('SELECT COUNT(*)::int AS n FROM admin_blocked_signin_fingerprints WHERE active=1'),
      db.all('SELECT id,actor_email AS "actorEmail",actor_role AS "actorRole",action,target,details,ip_address AS ip,created_at AS "createdAt" FROM admin_action_audit ORDER BY created_at DESC LIMIT 50')
    ]);
    res.json({success:true,metrics:{activeOperators:operators?.n||0,suspendedAccounts:suspended?.n||0,activePayoutHolds:holds?.n||0,blockedFingerprints:blocks?.n||0},audit: auditRows});
  });
  app.post('/api/admin/control/users/:email/suspend', async (req,res)=>{
    if(!await authorize(req,res,'accounts.suspend')) return;
    const email=clean(req.params.email,180).toLowerCase(), reason=clean(req.body?.reason,300);
    if(!/^\S+@\S+\.\S+$/.test(email)||!reason) return res.status(400).json({success:false,message:'A valid customer email and reason are required.'});
    const user=await db.get('SELECT email FROM users WHERE email=?',[email]); if(!user) return res.status(404).json({success:false,message:'Customer not found.'});
    await store.setBan(email,true,reason);
    await audit(req,'customer.suspended',email,{reason});
    res.json({success:true,message:'Customer account suspended. Existing signed-in requests will be denied when the account check runs.'});
  });
  app.post('/api/admin/control/users/:email/restore', async (req,res)=>{
    if(!await authorize(req,res,'accounts.suspend')) return;
    const email=clean(req.params.email,180).toLowerCase();
    await store.setBan(email,false,''); await audit(req,'customer.restored',email,{}); res.json({success:true});
  });
  app.post('/api/admin/control/payout-holds/:creatorId', async (req,res)=>{
    if(!await authorize(req,res,'payouts.hold')) return;
    const creator=clean(req.params.creatorId,180).toLowerCase(), reason=clean(req.body?.reason,300);
    if(!creator||!reason) return res.status(400).json({success:false,message:'Creator ID and hold reason are required.'});
    await db.run(`INSERT INTO admin_payout_holds(creator_id,reason,held_by,held_at,active) VALUES(?,?,?,?,1)
      ON CONFLICT(creator_id) DO UPDATE SET reason=EXCLUDED.reason,held_by=EXCLUDED.held_by,held_at=EXCLUDED.held_at,released_by=NULL,released_at=NULL,active=1`,[creator,reason,req.adminActor.email,now()]);
    await audit(req,'payout.hold',creator,{reason}); res.json({success:true,message:'Creator payout hold is active. Queued transfers will be stopped before Paystack submission.'});
  });
  app.delete('/api/admin/control/payout-holds/:creatorId', async (req,res)=>{
    if(!await authorize(req,res,'payouts.release')) return;
    const creator=clean(req.params.creatorId,180).toLowerCase();
    const r=await db.run('UPDATE admin_payout_holds SET active=0,released_by=?,released_at=? WHERE creator_id=? AND active=1',[req.adminActor.email,now(),creator]);
    if(!r.changes) return res.status(404).json({success:false,message:'No active payout hold found.'});
    await audit(req,'payout.hold_released',creator,{}); res.json({success:true});
  });
  app.get('/api/admin/control/payout-holds', async (req,res)=>{
    if(!await authorize(req,res,'payouts.read')) return;
    const rows=await db.all('SELECT creator_id AS "creatorId",reason,held_by AS "heldBy",held_at AS "heldAt",active FROM admin_payout_holds ORDER BY held_at DESC LIMIT 200');
    res.json({success:true,holds:rows});
  });
  app.post('/api/admin/control/block-fingerprint', async (req,res)=>{
    if(!await authorize(req,res,'devices.block')) return;
    const kind=clean(req.body?.kind,12), value=clean(req.body?.value,500), reason=clean(req.body?.reason,300), label=clean(req.body?.label,120);
    if(!['ip','device'].includes(kind)||!value||!reason) return res.status(400).json({success:false,message:'Provide kind (ip/device), value, and reason.'});
    const fingerprint=hash(kind==='device'?value.toLowerCase():value);
    await db.run(`INSERT INTO admin_blocked_signin_fingerprints(kind,fingerprint,label,reason,created_by,created_at,active)
      VALUES(?,?,?,?,?,?,1) ON CONFLICT(kind,fingerprint) DO UPDATE SET label=EXCLUDED.label,reason=EXCLUDED.reason,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at,active=1`,[kind,fingerprint,label,reason,req.adminActor.email,now()]);
    await audit(req,'signin_fingerprint.blocked',kind,{label,reason}); res.json({success:true,message:'New sign-ins matching this fingerprint will be blocked.'});
  });
  app.get('/api/admin/control/audit', async (req,res)=>{
    if(!await authorize(req,res,'dashboard.read')) return;
    const rows=await db.all('SELECT id,actor_email AS "actorEmail",actor_role AS "actorRole",action,target,details,ip_address AS ip,created_at AS "createdAt" FROM admin_action_audit ORDER BY created_at DESC LIMIT 300');
    res.json({success:true,audit:rows});
  });


  // Marketplace operations: seller/listing/order visibility plus audited listing moderation.
  // Order state changes are intentionally excluded until delivery/dispute policy is confirmed.
  app.get('/api/admin/actions/market/listings', async (req,res)=>{
    if(!await authorize(req,res,'market.read')) return;
    const status=['active','hidden','sold','removed'].includes(String(req.query.status||''))?String(req.query.status):'active';
    const rows=await db.all(`SELECT l.id,l.seller,l.title,l.category,l.price_ngn AS "priceNgn",l.status,l.created_at AS "createdAt",
      (SELECT COUNT(*) FROM market_reports r WHERE r.listing_id=l.id)::int AS reports
      FROM market_listings l WHERE l.status=? ORDER BY reports DESC,l.created_at DESC LIMIT 100`,[status]);
    res.json({success:true,listings:rows});
  });
  app.get('/api/admin/actions/market/orders', async (req,res)=>{
    if(!await authorize(req,res,'market.read')) return;
    const rows=await db.all(`SELECT id,listing_id AS "listingId",seller,buyer,title,amount_ngn AS "amountNgn",method,status,
      dispute_reason AS "disputeReason",created_at AS "createdAt",paid_at AS "paidAt",shipped_at AS "shippedAt",completed_at AS "completedAt"
      FROM market_orders ORDER BY CASE WHEN dispute_reason IS NOT NULL AND dispute_reason<>'' THEN 0 ELSE 1 END,created_at DESC LIMIT 150`);
    res.json({success:true,orders:rows});
  });
  app.post('/api/admin/actions/market/listings/:id/moderate', async (req,res)=>{
    if(!await authorize(req,res,'market.moderate')) return;
    const id=Math.floor(Number(req.params.id)), action=clean(req.body?.action,20), reason=clean(req.body?.reason,300);
    if(!Number.isSafeInteger(id)||id<1||!['hide','remove','restore'].includes(action)||!reason)
      return res.status(400).json({success:false,message:'Valid listing, action, and moderation reason are required.'});
    const listing=await db.get('SELECT id,seller,status FROM market_listings WHERE id=?',[id]);
    if(!listing) return res.status(404).json({success:false,message:'Marketplace listing not found.'});
    const status=action==='restore'?'active':(action==='hide'?'hidden':'removed');
    await db.run('UPDATE market_listings SET status=?,updated_at=? WHERE id=?',[status,now(),id]);
    await audit(req,'market.listing.'+action,String(id),{seller:listing.seller,reason,previousStatus:listing.status,nextStatus:status});
    res.json({success:true,status,message:'Marketplace listing updated: '+status+'.'});
  });

  async function isLoginBlocked(req) {
    const ip=clean(req.ip,100), ua=clean(req.headers['user-agent'],500);
    const [ipBlock,deviceBlock]=await Promise.all([
      db.get("SELECT id,reason FROM admin_blocked_signin_fingerprints WHERE kind='ip' AND fingerprint=? AND active=1",[hash(ip)]),
      db.get("SELECT id,reason FROM admin_blocked_signin_fingerprints WHERE kind='device' AND fingerprint=? AND active=1",[hash(ua.toLowerCase())])
    ]);
    return ipBlock||deviceBlock||null;
  }
  return { migrate, isLoginBlocked };
};
