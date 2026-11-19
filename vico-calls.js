// VicoPay shared in-stream calling permissions and paid VIP-call access.
// Call media continues to use the project's existing LiveKit room.
const crypto = require('crypto');
module.exports = function makeVicoCalls({ app, db, requireAuth, store, vip, liveRooms, axios }) {
  const now = () => Date.now();
  const STAR_GATE = 9000;
  const feeForStars = (earned) => earned >= 9000 ? 1 : earned >= 6000 ? 2 : earned >= 3000 ? 3 : 4;
  const ready = (async () => {
    const sql = [
      `CREATE TABLE IF NOT EXISTS vico_call_requests (id TEXT PRIMARY KEY, caller TEXT NOT NULL, host TEXT NOT NULL, room_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live', listing_id BIGINT, status TEXT NOT NULL, payment_reference TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_vico_calls_host_status ON vico_call_requests(host,status,created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_vico_calls_caller ON vico_call_requests(caller,created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS vico_call_payments (reference TEXT PRIMARY KEY, call_id TEXT NOT NULL, caller TEXT NOT NULL, host TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at BIGINT NOT NULL, verified_at BIGINT)` ,
      `CREATE INDEX IF NOT EXISTS idx_vico_call_payments_user ON vico_call_payments(caller,status)`
    ];
    for (const q of sql) await db.run(q);
  })();
  const bad = (res, status, message, extra={}) => res.status(status).json({ success:false, message, ...extra });
  const getAccount = async (handle) => { const row=await db.get('SELECT email, handle, username FROM users WHERE LOWER(handle)=LOWER(?) OR LOWER(username)=LOWER(?) LIMIT 1', [String(handle||''),String(handle||'')]); if(row) await store.users.warm([row.email]); return row; };
  const isVip = async (email) => { try { const t = await vip.tierOf(email); return !!(t && Number(t.rank)>0); } catch (_) { return false; } };
  const stars = async (email) => { try { return Number(await vip.lifetimeStars(email)) || 0; } catch (_) { return 0; } };
  async function access(caller, host) {
    const [callerVip, hostVip, earned] = await Promise.all([isVip(caller), isVip(host), stars(caller)]);
    const gate = !callerVip && hostVip;
    const feeUsd = feeForStars(earned);
    const paid = await db.get("SELECT id FROM vico_call_requests WHERE caller=? AND host=? AND status='paid_access' ORDER BY created_at DESC LIMIT 1", [caller,host]);
    return { callerVip, hostVip, stars:earned, threshold:STAR_GATE, requiresPayment:gate && !paid, paidAccess:!!paid, free:!gate || !!paid, feeUsd, feeTier: earned >= 9000 ? '9,000+ stars' : earned >= 6000 ? '6,000–8,999 stars' : earned >= 3000 ? '3,000–5,999 stars' : '0–2,999 stars' };
  }
  app.get('/api/calls/access/:handle', requireAuth, async (req,res) => {
    await ready;
    const target = await getAccount(req.params.handle);
    if (!target) return bad(res,404,'This account could not be found.');
    const a = await access(req.userEmail,target.email);
    const room = [...liveRooms.values()].find(r => String(r.hostId).toLowerCase()===String(target.email).toLowerCase());
    res.json({success:true,...a,targetHandle:store.publicHandle(target.email),isLive:!!room,roomId:room?room.roomId:null});
  });
  app.post('/api/calls/payment/initialize', requireAuth, async (req,res) => {
    await ready;
    const target = await getAccount(req.body && req.body.targetHandle);
    if (!target) return bad(res,404,'This account could not be found.');
    const room = [...liveRooms.values()].find(r => String(r.hostId).toLowerCase()===String(target.email).toLowerCase());
    if (!room) return bad(res,409,'This streamer is not live right now.');
    const a = await access(req.userEmail,target.email);
    if (!a.requiresPayment) return bad(res,400,'Payment is not required for this call.');
    const feeUsd = a.feeUsd;
    if (!process.env.PAYSTACK_SECRET_KEY) return bad(res,503,'Call payments are not configured yet.');
    const callId = crypto.randomUUID();
    await db.run("INSERT INTO vico_call_requests(id,caller,host,room_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,'payment_pending',?,?)",[callId,req.userEmail,target.email,room.roomId,String(req.body.source||'live').slice(0,30),now(),now()]);
    try {
      const origin = String(process.env.APP_URL || req.headers.origin || '').replace(/\/$/,'');
      const callback = new URL(origin+'/vip-call-payment.html'); callback.searchParams.set('room',room.roomId); callback.searchParams.set('target',store.publicHandle(target.email)); callback.searchParams.set('amount',String(feeUsd));
      const response = await axios.post('https://api.paystack.co/transaction/initialize', {
        email:req.userEmail, amount:feeUsd*100, currency:'USD', callback_url:callback.toString(),
        metadata:{vico_call_id:callId,call_type:'vip_video_call',target:store.publicHandle(target.email)}
      }, {headers:{Authorization:'Bearer '+process.env.PAYSTACK_SECRET_KEY,'Content-Type':'application/json'}});
      const p=response.data && response.data.data;
      if (!response.data.status || !p || !p.reference) throw new Error((response.data&&response.data.message)||'Payment provider did not return a checkout link.');
      await db.run("UPDATE vico_call_requests SET payment_reference=?,updated_at=? WHERE id=?",[p.reference,now(),callId]);
      await db.run("INSERT INTO vico_call_payments(reference,call_id,caller,host,amount_minor,currency,status,created_at) VALUES(?,?,?,?,?,'USD','pending',?)",[p.reference,callId,req.userEmail,target.email,feeUsd*100,now()]);
      res.json({success:true,authorizationUrl:p.authorization_url,reference:p.reference,amount:feeUsd,currency:'USD'});
    } catch(e) { console.error('VIP CALL PAYMENT INIT:',e.message); await db.run("UPDATE vico_call_requests SET status='payment_failed',updated_at=? WHERE id=?",[now(),callId]); bad(res,502,'Could not start your $'+feeUsd+' VIP call payment. Please try again.'); }
  });
  app.post('/api/calls/payment/verify', requireAuth, async (req,res) => {
    await ready;
    const ref=String(req.body&&req.body.reference||'').trim(); if(!ref) return bad(res,400,'Payment reference is required.');
    const row=await db.get('SELECT * FROM vico_call_payments WHERE reference=? AND caller=?',[ref,req.userEmail]);
    if(!row) return bad(res,404,'This payment reference was not found for your account.');
    if(row.status==='verified') return res.json({success:true,verified:true,amount:Number(row.amount_minor)/100,currency:row.currency,targetHandle:store.publicHandle(row.host)});
    if(!process.env.PAYSTACK_SECRET_KEY) return bad(res,503,'Payment verification is unavailable.');
    try {
      const v=await axios.get('https://api.paystack.co/transaction/verify/'+encodeURIComponent(ref),{headers:{Authorization:'Bearer '+process.env.PAYSTACK_SECRET_KEY}});
      const d=v.data&&v.data.data;
      if(!v.data.status||!d||d.status!=='success'||String(d.currency).toUpperCase()!=='USD'||Number(d.amount)!==Number(row.amount_minor)||String(d.metadata&&d.metadata.vico_call_id)!==String(row.call_id)) return bad(res,402,'Payment has not been verified. No call access has been granted.');
      await db.tx(async tx=>{
        await tx.run("UPDATE vico_call_payments SET status='verified',verified_at=? WHERE reference=? AND status='pending'",[now(),ref]);
        await tx.run("UPDATE vico_call_requests SET status='paid_access',updated_at=? WHERE id=? AND caller=?",[now(),row.call_id,req.userEmail]);
      });
      res.json({success:true,verified:true,amount:Number(row.amount_minor)/100,currency:row.currency,targetHandle:store.publicHandle(row.host)});
    } catch(e) { console.error('VIP CALL PAYMENT VERIFY:',e.message); bad(res,502,'Could not verify payment right now. Please try again.'); }
  });
  app.post('/api/calls/request', requireAuth, async (req,res) => {
    await ready;
    const roomId=String(req.body&&req.body.roomId||''); const room=liveRooms.get(roomId);
    if(!room) return bad(res,404,'This livestream has ended.');
    const host=String(room.hostId||'').toLowerCase(); if(host===req.userEmail) return bad(res,400,'You cannot call yourself.');
    const a=await access(req.userEmail,host);
    if(a.requiresPayment) return bad(res,402,'A verified $'+a.feeUsd+' payment is required to request a call with this VIP at your current star level.',{requiresPayment:true,stars:a.stars,threshold:STAR_GATE,feeUsd:a.feeUsd,feeTier:a.feeTier});
    const existing=await db.get("SELECT id FROM vico_call_requests WHERE caller=? AND host=? AND room_id=? AND status IN ('requested','accepted') ORDER BY created_at DESC LIMIT 1",[req.userEmail,host,roomId]);
    if(existing) return res.json({success:true,callId:existing.id,alreadyRequested:true});
    const paid=await db.get("SELECT id,payment_reference FROM vico_call_requests WHERE caller=? AND host=? AND status='paid_access' ORDER BY created_at DESC LIMIT 1",[req.userEmail,host]);
    const id=paid?paid.id:crypto.randomUUID();
    if(paid) await db.run("UPDATE vico_call_requests SET status='requested',room_id=?,source=?,updated_at=? WHERE id=?",[roomId,String(req.body.source||'live').slice(0,30),now(),id]);
    else await db.run("INSERT INTO vico_call_requests(id,caller,host,room_id,source,status,created_at,updated_at) VALUES(?,?,?,?,?,'requested',?,?)",[id,req.userEmail,host,roomId,String(req.body.source||'live').slice(0,30),now(),now()]);
    res.json({success:true,callId:id,callerIdentity:store.publicHandle(req.userEmail),displayName:store.displayNameOf(req.userEmail)});
  });
  app.post('/api/calls/decision', requireAuth, async (req,res) => {
    await ready;
    const id=String(req.body&&req.body.callId||''), decision=req.body&&req.body.decision==='accept'?'accepted':'declined';
    const row=await db.get('SELECT * FROM vico_call_requests WHERE id=? AND host=?',[id,req.userEmail]);
    if(!row) return bad(res,404,'Call request not found.');
    if(!liveRooms.has(row.room_id)) return bad(res,409,'The livestream has ended.');
    if(row.status!=='requested') return bad(res,409,'This call request is no longer waiting.');
    await db.run('UPDATE vico_call_requests SET status=?,updated_at=? WHERE id=?',[decision,now(),id]);
    res.json({success:true,status:decision,callerIdentity:store.publicHandle(row.caller)});
  });
  app.post('/api/calls/cancel', requireAuth, async (req,res) => {
    await ready; const id=String(req.body&&req.body.callId||'');
    await db.run("UPDATE vico_call_requests SET status='cancelled',updated_at=? WHERE id=? AND caller=? AND status='requested'",[now(),id,req.userEmail]);
    res.json({success:true});
  });
  app.post('/api/calls/end', requireAuth, async (req,res) => {
    await ready; const id=String(req.body&&req.body.callId||'');
    const row=await db.get('SELECT id FROM vico_call_requests WHERE id=? AND (caller=? OR host=?)',[id,req.userEmail,req.userEmail]);
    if(!row) return bad(res,404,'Call not found.');
    await db.run("UPDATE vico_call_requests SET status='ended',updated_at=? WHERE id=?",[now(),id]); res.json({success:true});
  });
  app.get('/api/calls/incoming', requireAuth, async (req,res) => {
    await ready; const rows=await db.all("SELECT c.id AS \"callId\",c.room_id AS \"roomId\",c.source,c.created_at AS \"createdAt\",u.handle,u.display_name AS \"displayName\" FROM vico_call_requests c LEFT JOIN users u ON LOWER(u.email)=c.caller WHERE c.host=? AND c.status='requested' ORDER BY c.created_at DESC LIMIT 5",[req.userEmail]);
    res.json({success:true,calls:rows});
  });
  app.get('/api/calls/request/:id', requireAuth, async (req,res) => {
    await ready; const row=await db.get("SELECT id,caller,host,room_id AS \"roomId\",status FROM vico_call_requests WHERE id=? AND host=?",[String(req.params.id),req.userEmail]);
    if(!row) return bad(res,404,'Call request not found.'); row.callerIdentity=store.publicHandle(row.caller); row.displayName=store.displayNameOf(row.caller); res.json({success:true,call:row});
  });
  app.get('/api/calls/live/:handle', requireAuth, async (req,res) => {
    const target=await getAccount(req.params.handle); if(!target) return bad(res,404,'Seller not found.');
    const room=[...liveRooms.values()].find(r=>String(r.hostId).toLowerCase()===String(target.email).toLowerCase());
    res.json({success:true,isLive:!!room,roomId:room?room.roomId:null});
  });
  app.get('/api/calls/history', requireAuth, async (req,res) => {
    await ready; const rows=await db.all("SELECT id AS \"callId\",room_id AS \"roomId\",source,status,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM vico_call_requests WHERE caller=? OR host=? ORDER BY created_at DESC LIMIT 50",[req.userEmail,req.userEmail]);
    res.json({success:true,calls:rows});
  });
  async function authorizeCaller(email,roomId) {
    await ready;
    const row=await db.get("SELECT id FROM vico_call_requests WHERE caller=? AND room_id=? AND status IN ('accepted','connected') ORDER BY created_at DESC LIMIT 1",[email,String(roomId)]);
    if(!row) return false;
    await db.run("UPDATE vico_call_requests SET status='connected',updated_at=? WHERE id=?",[now(),row.id]); return true;
  }
  return {ready,authorizeCaller};
};
