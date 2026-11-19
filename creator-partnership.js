// VicoPay Creator Video Partnership: marketplace publishing, verified company funding and bank payouts.
// Paystack collects company funds into VicoPay's Paystack balance; this is not a regulated/trust escrow account.
"use strict";
module.exports = function creatorPartnership({ app, db, requireAuth, axios }) {
  const now = () => Date.now();
  const email = v => String(v || "").trim().toLowerCase();
  const bad = (res, code, message) => res.status(code).json({ success:false, message });
  const secret = () => process.env.PAYSTACK_SECRET_KEY;
  const api = async (method, url, data) => {
    if (!secret()) { const e = new Error("Paystack is not configured yet. Add PAYSTACK_SECRET_KEY to the server environment."); e.status=503; throw e; }
    const r = await axios({ method, url:"https://api.paystack.co"+url, data, timeout:25000, headers:{ Authorization:"Bearer "+secret(), "Content-Type":"application/json" } });
    if (!r.data || r.data.status !== true) { const e = new Error(String(r.data && r.data.message || "Paystack request failed.")); e.status=502; e.paystackStatus=r.status; throw e; }
    return r.data.data;
  };
  const schema = [
    `CREATE TABLE IF NOT EXISTS creator_partnership_requests (
      id BIGSERIAL PRIMARY KEY, creator_email TEXT NOT NULL, business_email TEXT NOT NULL, business_name TEXT NOT NULL,
      brief TEXT NOT NULL, deliverable TEXT NOT NULL DEFAULT 'Promotional video', agreed_amount NUMERIC(14,2),
      currency TEXT NOT NULL DEFAULT 'NGN' CHECK(currency IN ('NGN','USD')), status TEXT NOT NULL DEFAULT 'requested',
      video_id BIGINT, video_title TEXT, delivery_mode TEXT, video_url TEXT, review_note TEXT,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, offered_at BIGINT, submitted_at BIGINT, approved_at BIGINT,
      funding_status TEXT NOT NULL DEFAULT 'unfunded', payment_reference TEXT, payment_verified_at BIGINT,
      transfer_reference TEXT, transfer_code TEXT, transfer_status TEXT NOT NULL DEFAULT 'not_started', transfer_note TEXT
    )`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS funding_status TEXT NOT NULL DEFAULT 'unfunded'`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS payment_reference TEXT`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS payment_verified_at BIGINT`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS payment_disputed BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS transfer_reference TEXT`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS transfer_code TEXT`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS transfer_status TEXT NOT NULL DEFAULT 'not_started'`,
    `ALTER TABLE creator_partnership_requests ADD COLUMN IF NOT EXISTS transfer_note TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_partner_payment_ref ON creator_partnership_requests(payment_reference) WHERE payment_reference IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_partner_transfer_ref ON creator_partnership_requests(transfer_reference) WHERE transfer_reference IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_creator_partner_creator ON creator_partnership_requests(creator_email,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_creator_partner_business ON creator_partnership_requests(business_email,created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS creator_partnership_marketplace_videos (
      video_id BIGINT PRIMARY KEY, request_id BIGINT NOT NULL UNIQUE REFERENCES creator_partnership_requests(id),
      creator_email TEXT NOT NULL, title TEXT NOT NULL, published_at BIGINT NOT NULL, visibility TEXT NOT NULL DEFAULT 'public'
    )`,
    `CREATE TABLE IF NOT EXISTS creator_partnership_wallet_entries (
      id BIGSERIAL PRIMARY KEY, request_id BIGINT NOT NULL UNIQUE REFERENCES creator_partnership_requests(id), creator_email TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('NGN','USD')), memo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', transfer_reference TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
    )`,
    `ALTER TABLE creator_partnership_wallet_entries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE creator_partnership_wallet_entries ADD COLUMN IF NOT EXISTS transfer_reference TEXT`,
    `ALTER TABLE creator_partnership_wallet_entries ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_creator_partner_wallet_owner ON creator_partnership_wallet_entries(creator_email,created_at DESC)`
  ];
  const ready = (async()=>{ await db.tx(async t=>{ await t.lock("creator-partnership-schema-v2"); for(const s of schema) await t.run(s); }); })();
  const shape = r => ({ id:Number(r.id), creatorEmail:r.creator_email, businessEmail:r.business_email, businessName:r.business_name,
    brief:r.brief, deliverable:r.deliverable, amount:r.agreed_amount==null?null:Number(r.agreed_amount), currency:r.currency,
    status:r.status, videoId:r.video_id==null?null:Number(r.video_id), videoTitle:r.video_title, deliveryMode:r.delivery_mode,
    videoUrl:r.video_url, reviewNote:r.review_note, fundingStatus:r.funding_status||"unfunded", paymentReference:r.payment_reference,
    transferStatus:r.transfer_status||"not_started", transferNote:r.transfer_note, createdAt:Number(r.created_at), updatedAt:Number(r.updated_at) });
  const getReq = id => db.get("SELECT * FROM creator_partnership_requests WHERE id=?",[id]);

  async function releaseIfReady(id) {
    // A bank transfer is attempted only after BOTH verified company funding and business video approval.
    const claimed = await db.tx(async t => {
      await t.lock("creator-partnership-release:"+id);
      const r=await t.get("SELECT * FROM creator_partnership_requests WHERE id=? FOR UPDATE",[id]);
      if(!r || r.status!=="approved" || r.funding_status!=="funded") return {skip:true, reason:"Awaiting video approval or verified funding."};
      if(r.payment_disputed){await t.run("UPDATE creator_partnership_requests SET transfer_status='needs_review',transfer_note=?,updated_at=? WHERE id=?",["Company payment is disputed or refunded. Payout is blocked pending investigation.",now(),id]);return {skip:true,reason:"Payment dispute/refund requires review."};}
      if(r.transfer_status==="success" || ["sending","processing","needs_review"].includes(r.transfer_status)) return {skip:true,reason:"Transfer already started."};
      if(r.currency!=="NGN") {
        await t.run("UPDATE creator_partnership_requests SET transfer_status='manual_settlement',transfer_note=?,updated_at=? WHERE id=?",["USD company funding is verified. Nigerian NUBAN bank transfers are NGN-only; USD settlement needs the platform's configured USD payout route.",now(),id]);
        await t.run("INSERT INTO creator_partnership_wallet_entries (request_id,creator_email,amount,currency,memo,status,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?) ON CONFLICT(request_id) DO NOTHING",[id,r.creator_email,r.agreed_amount,r.currency,"Approved and funded creator partnership earnings",now(),now()]);
        return {skip:true,reason:"USD earnings are available in the Vico partnership wallet; a USD payout route is not configured."};
      }
      const rec=await t.get("SELECT recipient_code,bank_name,account_number FROM payout_recipients WHERE creator_id=?",[r.creator_email]);
      if(!rec) {
        await t.run("UPDATE creator_partnership_requests SET transfer_status='awaiting_bank',transfer_note=?,updated_at=? WHERE id=?",["Add and verify a bank account in Payout Setup to receive this approved payment.",now(),id]);
        await t.run("INSERT INTO creator_partnership_wallet_entries (request_id,creator_email,amount,currency,memo,status,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?) ON CONFLICT(request_id) DO NOTHING",[id,r.creator_email,r.agreed_amount,r.currency,"Approved and funded creator partnership earnings",now(),now()]);
        return {skip:true,reason:"Creator must add a verified bank account."};
      }
      const cooldownHours=Number(process.env.PAYOUT_RECIPIENT_COOLDOWN_HOURS||72), age=now()-Number((await t.get("SELECT updated_at FROM payout_recipients WHERE creator_id=?",[r.creator_email])).updated_at||0);
      if(age<cooldownHours*3600000){const wait=Math.ceil((cooldownHours*3600000-age)/3600000);await t.run("UPDATE creator_partnership_requests SET transfer_status='awaiting_bank',transfer_note=?,updated_at=? WHERE id=?",["Bank details are in the payout security waiting period. Try again in about "+wait+" hour(s).",now(),id]);await t.run("INSERT INTO creator_partnership_wallet_entries (request_id,creator_email,amount,currency,memo,status,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?) ON CONFLICT(request_id) DO NOTHING",[id,r.creator_email,r.agreed_amount,r.currency,"Approved and funded creator partnership earnings",now(),now()]);return {skip:true,reason:"Bank payout security waiting period: "+wait+" hour(s) remaining."};}
      const ref="vcp-partner-"+id+"-"+cryptoRandom();
      const amount=Math.round(Number(r.agreed_amount)*100);
      if(!(amount>0)) throw new Error("Invalid agreed amount.");
      await t.run("UPDATE creator_partnership_requests SET transfer_status='sending',transfer_reference=?,transfer_note=NULL,updated_at=? WHERE id=?",[ref,now(),id]);
      await t.run("INSERT INTO creator_partnership_wallet_entries (request_id,creator_email,amount,currency,memo,status,transfer_reference,created_at,updated_at) VALUES (?,?,?,?,?,'processing',?,?,?) ON CONFLICT(request_id) DO UPDATE SET status='processing',transfer_reference=EXCLUDED.transfer_reference,updated_at=EXCLUDED.updated_at",[id,r.creator_email,r.agreed_amount,r.currency,"Creator partnership payment",ref,now(),now()]);
      return {request:r, recipient:rec, reference:ref, amount};
    });
    if(claimed.skip) return claimed;
    try {
      const data=await api("POST","/transfer",{source:"balance",amount:claimed.amount,recipient:claimed.recipient.recipient_code,currency:"NGN",reference:claimed.reference,reason:"VicoPay creator video partnership #"+id});
      await applyTransfer(claimed.reference,data.status,{transferCode:data.transfer_code,amount:data.amount,reason:data.reason});
      return {started:true,status:data.status};
    } catch(e) {
      // Definitive Paystack 4xx rejection means no transfer was created; keep the amount available for a safe retry.
      // Network/5xx outcomes are ambiguous, so verify the SAME reference before ever creating another transfer.
      const definitive=Number(e.paystackStatus)>=400&&Number(e.paystackStatus)<500;
      await db.run("UPDATE creator_partnership_requests SET transfer_status=?,transfer_note=?,updated_at=? WHERE id=? AND transfer_reference=?",[definitive?"failed":"needs_review",String(e.message||"Transfer could not be confirmed.").slice(0,240),now(),id,claimed.reference]);
      await db.run("UPDATE creator_partnership_wallet_entries SET status=?,updated_at=? WHERE request_id=?",[definitive?"available":"processing",now(),id]);
      console.error("CREATOR PARTNERSHIP TRANSFER",e.message);
      return {started:false,needsReview:!definitive,failed:definitive};
    }
  }
  function cryptoRandom(){ return require("crypto").randomBytes(6).toString("hex"); }
  async function applyTransfer(reference,status,extra={}) {
    const s=String(status||"").toLowerCase(), r=await db.get("SELECT * FROM creator_partnership_requests WHERE transfer_reference=?",[reference]);
    if(!r) return {ignored:true};
    if(extra.amount!=null && Math.round(Number(extra.amount))!==Math.round(Number(r.agreed_amount)*100)) {
      await db.run("UPDATE creator_partnership_requests SET transfer_status='needs_review',transfer_note=?,updated_at=? WHERE id=?",["Paystack transfer amount did not match the agreed amount. Manual review required.",now(),r.id]); return {mismatch:true};
    }
    if(s==="success") {
      await db.tx(async t=>{
        await t.run("UPDATE creator_partnership_requests SET transfer_status='success',transfer_code=COALESCE(?,transfer_code),transfer_note=NULL,updated_at=? WHERE id=?",[extra.transferCode||null,now(),r.id]);
        await t.run("UPDATE creator_partnership_wallet_entries SET status='paid',updated_at=? WHERE request_id=?",[now(),r.id]);
      });
    } else if(s==="failed"||s==="reversed") {
      await db.run("UPDATE creator_partnership_requests SET transfer_status=?,transfer_code=COALESCE(?,transfer_code),transfer_note=?,updated_at=? WHERE id=?",[s,extra.transferCode||null,String(extra.reason||("Paystack transfer "+s)).slice(0,240),now(),r.id]);
      await db.run("UPDATE creator_partnership_wallet_entries SET status='available',updated_at=? WHERE request_id=?",[now(),r.id]);
    } else {
      await db.run("UPDATE creator_partnership_requests SET transfer_status='processing',transfer_code=COALESCE(?,transfer_code),updated_at=? WHERE id=?",[extra.transferCode||null,now(),r.id]);
    }
    return {updated:true,status:s};
  }

  app.get("/api/creator-partnership/mine",requireAuth,async(req,res)=>{try{await ready;const me=email(req.userEmail);
    const rows=await db.all("SELECT * FROM creator_partnership_requests WHERE creator_email=? OR business_email=? ORDER BY created_at DESC LIMIT 100",[me,me]);
    const wallet=await db.all("SELECT currency,status,COALESCE(SUM(amount),0) total FROM creator_partnership_wallet_entries WHERE creator_email=? GROUP BY currency,status",[me]);
    const pending=await db.all("SELECT currency,COALESCE(SUM(agreed_amount),0) total FROM creator_partnership_requests WHERE creator_email=? AND agreed_amount IS NOT NULL AND (status<>'approved' OR funding_status<>'funded' OR transfer_status IN ('sending','processing','needs_review')) GROUP BY currency",[me]);
    res.json({success:true,requests:rows.map(shape),wallet:wallet.map(x=>({currency:x.currency,status:x.status,amount:Number(x.total)})),pending:pending.map(x=>({currency:x.currency,amount:Number(x.total)}))});
  }catch(e){console.error(e);bad(res,500,"Could not load partnership requests.");}});

  app.get("/api/creator-partnership/wallet",requireAuth,async(req,res)=>{try{await ready;const me=email(req.userEmail);const entries=await db.all("SELECT w.*,r.business_name,r.video_title FROM creator_partnership_wallet_entries w JOIN creator_partnership_requests r ON r.id=w.request_id WHERE w.creator_email=? ORDER BY w.created_at DESC LIMIT 100",[me]);const pending=await db.all("SELECT id,business_name,agreed_amount,currency,status,funding_status,transfer_status,updated_at FROM creator_partnership_requests WHERE creator_email=? AND agreed_amount IS NOT NULL AND (status<>'approved' OR funding_status<>'funded' OR transfer_status IN ('sending','processing','needs_review')) ORDER BY updated_at DESC LIMIT 100",[me]);res.json({success:true,entries:entries.map(x=>({id:Number(x.id),requestId:Number(x.request_id),businessName:x.business_name,videoTitle:x.video_title,amount:Number(x.amount),currency:x.currency,status:x.status,transferReference:x.transfer_reference,createdAt:Number(x.created_at)})),pending:pending.map(x=>({requestId:Number(x.id),businessName:x.business_name,amount:Number(x.agreed_amount),currency:x.currency,partnershipStatus:x.status,fundingStatus:x.funding_status,transferStatus:x.transfer_status,updatedAt:Number(x.updated_at)}))});}catch(e){bad(res,500,"Could not load creator partnership wallet.");}});

  app.post("/api/creator-partnership/requests",requireAuth,async(req,res)=>{try{await ready;const creator=email(req.userEmail),businessEmail=email(req.body&&req.body.businessEmail),businessName=String(req.body&&req.body.businessName||"").trim().slice(0,120),brief=String(req.body&&req.body.brief||"").trim().slice(0,2000),deliverable=String(req.body&&req.body.deliverable||"Promotional video").trim().slice(0,120);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)||businessEmail===creator)return bad(res,400,"Enter a valid registered business email different from your own.");
    if(businessName.length<2||brief.length<10)return bad(res,400,"Enter the business name and describe the video you are proposing.");
    if(!await db.get("SELECT email FROM users WHERE email=?",[businessEmail]))return bad(res,404,"That business email does not have a VicoPay account yet.");
    const ts=now(),r=await db.get("INSERT INTO creator_partnership_requests (creator_email,business_email,business_name,brief,deliverable,status,created_at,updated_at) VALUES (?,?,?,?,?,'requested',?,?) RETURNING *",[creator,businessEmail,businessName,brief,deliverable,ts,ts]);res.json({success:true,request:shape(r)});
  }catch(e){console.error(e);bad(res,500,"Could not send the partnership request.");}});

  app.post("/api/creator-partnership/:id/respond",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),me=email(req.userEmail),decision=req.body&&req.body.decision;if(!Number.isInteger(id)||id<1||!['accept','reject'].includes(decision))return bad(res,400,"Invalid response.");
    const r=await db.get("SELECT * FROM creator_partnership_requests WHERE id=?",[id]);if(!r)return bad(res,404,"Request not found.");if(r.business_email!==me)return bad(res,403,"Only the requested business can respond.");if(r.status!=="requested")return bad(res,409,"This request has already been answered.");
    const updated=await db.get("UPDATE creator_partnership_requests SET status=?,updated_at=? WHERE id=? RETURNING *",[decision==="accept"?"accepted":"rejected",now(),id]);res.json({success:true,request:shape(updated)});
  }catch(e){bad(res,500,"Could not update the request.");}});

  app.post("/api/creator-partnership/:id/offer",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),me=email(req.userEmail),amount=Number(req.body&&req.body.amount),currency=req.body&&req.body.currency==="USD"?"USD":"NGN";
    if(!Number.isInteger(id)||id<1||!Number.isFinite(amount)||amount<=0||amount>100000000000)return bad(res,400,"Enter the amount both parties agreed on.");
    const r=await db.get("SELECT * FROM creator_partnership_requests WHERE id=?",[id]);if(!r)return bad(res,404,"Request not found.");if(r.business_email!==me)return bad(res,403,"Only the business can record the agreed offer.");if(!['accepted','offered'].includes(r.status))return bad(res,409,"Accept the creator request first.");if(r.funding_status==='funded')return bad(res,409,"This agreement is already funded and cannot be repriced.");
    const updated=await db.get("UPDATE creator_partnership_requests SET agreed_amount=?,currency=?,status='offered',funding_status='unfunded',payment_reference=NULL,updated_at=?,offered_at=? WHERE id=? RETURNING *",[amount,currency,now(),now(),id]);res.json({success:true,request:shape(updated),message:"Offer saved. The business must now fund this exact amount through Paystack."});
  }catch(e){bad(res,500,"Could not save the agreed offer.");}});

  app.post("/api/creator-partnership/:id/fund",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),me=email(req.userEmail),r=await getReq(id);if(!r)return bad(res,404,"Partnership not found.");if(r.business_email!==me)return bad(res,403,"Only the business can fund this agreement.");if(!r.agreed_amount||!['offered','submitted','video_rejected','approved'].includes(r.status))return bad(res,409,"There is no agreed offer to fund.");if(r.funding_status==='funded')return res.json({success:true,alreadyFunded:true,message:"This partnership is already funded."});
    if(r.payment_reference){const v=await api("GET","/transaction/verify/"+encodeURIComponent(r.payment_reference));if(v.status==='success'&&await verifyCharge(v,r)){await markFunded(r.id,r.payment_reference);await releaseIfReady(r.id);return res.json({success:true,alreadyFunded:true,message:"Funding verified."});}return bad(res,409,"A Paystack payment is already in progress for this agreement. Check its status before trying again.");}
    const minor=Math.round(Number(r.agreed_amount)*100);if(!(minor>=100))return bad(res,400,"The agreed amount is below Paystack's minimum charge.");
    const ref="vcp-fund-"+id+"-"+cryptoRandom();await db.run("UPDATE creator_partnership_requests SET payment_reference=?,funding_status='unfunded',updated_at=? WHERE id=?",[ref,now(),id]);
    const callback=process.env.APP_URL?(process.env.APP_URL.replace(/\/$/,"")+"/creator-partnership.html?payment=callback"):undefined;
    let d;try{d=await api("POST","/transaction/initialize",{email:me,amount:String(minor),currency:r.currency,reference:ref,...(callback?{callback_url:callback}:{}),metadata:{type:"creator_partnership_funding",request_id:id,business_email:me,creator_email:r.creator_email,agreed_amount:Number(r.agreed_amount),currency:r.currency}});}catch(initError){await db.run("UPDATE creator_partnership_requests SET payment_reference=NULL,funding_status='unfunded',updated_at=? WHERE id=? AND payment_reference=?",[now(),id,ref]);throw initError;}
    res.json({success:true,authorizationUrl:d.authorization_url,reference:ref,message:"Complete Paystack checkout to fund this partnership."});
  }catch(e){console.error("PARTNERSHIP FUND INIT",e);bad(res,e.status||500,e.message||"Could not start company payment.");}});

  async function verifyCharge(p,r){return !!(p&&p.status==='success'&&String(p.currency).toUpperCase()===r.currency&&Number(p.amount)===Math.round(Number(r.agreed_amount)*100)&&email(p.customer&&p.customer.email)===r.business_email&&p.metadata&&Number(p.metadata.request_id)===Number(r.id)&&p.metadata.type==='creator_partnership_funding');}
  async function markFunded(id,reference){await db.tx(async t=>{await t.lock("creator-partnership-funding:"+id);const r=await t.get("SELECT * FROM creator_partnership_requests WHERE id=? FOR UPDATE",[id]);if(!r||r.funding_status==='funded')return;await t.run("UPDATE creator_partnership_requests SET funding_status='funded',payment_verified_at=?,updated_at=? WHERE id=? AND payment_reference=?",[now(),now(),id,reference]);});}
  async function verifyReference(reference){const r=await db.get("SELECT * FROM creator_partnership_requests WHERE payment_reference=?",[reference]);if(!r)return {ok:false,unknown:true};const p=await api("GET","/transaction/verify/"+encodeURIComponent(reference));if(!await verifyCharge(p,r))return {ok:false,message:"Paystack payment details did not match the partnership agreement."};await markFunded(r.id,reference);const release=await releaseIfReady(r.id);return {ok:true,requestId:Number(r.id),release};}
  app.get("/api/creator-partnership/payment/verify",requireAuth,async(req,res)=>{try{await ready;const ref=String(req.query.reference||"").slice(0,100),r=await db.get("SELECT business_email FROM creator_partnership_requests WHERE payment_reference=?",[ref]);if(!r)return bad(res,404,"Payment reference not found.");if(r.business_email!==email(req.userEmail))return bad(res,403,"Only the paying business can verify this payment.");const v=await verifyReference(ref);if(!v.ok)return bad(res,409,v.message||"Payment is not yet confirmed.");res.json({success:true,message:"Company funding verified. The payment will be released after video approval."});}catch(e){bad(res,e.status||500,e.message||"Could not verify payment.");}});

  app.post("/api/creator-partnership/:id/submit-video",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),me=email(req.userEmail),videoId=Number(req.body&&req.body.videoId),mode=req.body&&req.body.deliveryMode==='marketplace'?'marketplace':'company_only',title=String(req.body&&req.body.videoTitle||'').trim().slice(0,120);
    const r=await getReq(id);if(!r)return bad(res,404,"Partnership not found.");if(r.creator_email!==me)return bad(res,403,"Only the creator can submit this video.");if(!['offered','video_rejected'].includes(r.status))return bad(res,409,"A business offer is required before submitting a video.");
    const v=await db.get("SELECT id,owner,status,title FROM videos WHERE id=?",[videoId]);if(!v||v.owner!==me||!['active','partner_private'].includes(v.status))return bad(res,400,"Upload and finish your video in Vico Videos first.");
    const ts=now();const videoUrl="/api/creator-partnership/"+id+"/video";
    if(r.video_id&&Number(r.video_id)!==videoId){await db.run("UPDATE videos SET status='partner_private' WHERE id=? AND owner=?",[r.video_id,me]);}
    await db.run("DELETE FROM creator_partnership_marketplace_videos WHERE request_id=?",[id]);
    const updated=await db.get("UPDATE creator_partnership_requests SET video_id=?,video_title=?,delivery_mode=?,video_url=?,status='submitted',submitted_at=?,review_note=NULL,updated_at=? WHERE id=? RETURNING *",[videoId,title||v.title,mode,videoUrl,ts,ts,id]);
    await db.run("UPDATE videos SET status=? WHERE id=? AND owner=?",[mode==='marketplace'?'active':'partner_private',videoId,me]);
    if(mode==='marketplace')await db.run("INSERT INTO creator_partnership_marketplace_videos (video_id,request_id,creator_email,title,published_at,visibility) VALUES (?,?,?,?,?,'public') ON CONFLICT(video_id) DO UPDATE SET visibility='public',request_id=EXCLUDED.request_id,title=EXCLUDED.title,published_at=EXCLUDED.published_at",[videoId,id,me,title||v.title,ts]);
    res.json({success:true,request:shape(updated),message:mode==='marketplace'?'Video submitted to the company and published in the public VicoPay Marketplace video showcase.':'Video submitted privately to the company; it will not appear publicly in the Marketplace.'});
  }catch(e){console.error(e);bad(res,500,"Could not submit the video.");}});

  app.get("/api/creator-partnership/:id/video",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),me=email(req.userEmail),r=await getReq(id);if(!r||!r.video_id)return res.sendStatus(404);if(me!==r.creator_email&&me!==r.business_email)return res.sendStatus(403);const v=await db.get("SELECT mime,data,size FROM videos WHERE id=? AND owner=?",[r.video_id,r.creator_email]);if(!v||!v.data||!['partner_private','active'].includes((await db.get("SELECT status FROM videos WHERE id=?",[r.video_id])).status))return res.sendStatus(404);res.set({"Content-Type":v.mime||"video/mp4","Content-Length":String(v.size||v.data.length),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});res.send(v.data); }catch(e){console.error(e);res.sendStatus(500);}});
  app.get("/api/creator-partnership/marketplace-videos",async(req,res)=>{try{await ready;const rows=await db.all(`SELECT m.video_id AS id,m.title,COALESCE(NULLIF(u.handle,''),NULLIF(u.username,''), 'Vico Creator') AS creator,m.published_at,v.duration_s,v.thumb FROM creator_partnership_marketplace_videos m JOIN videos v ON v.id=m.video_id LEFT JOIN users u ON LOWER(u.email)=LOWER(m.creator_email) WHERE m.visibility='public' AND v.status='active' AND v.data IS NOT NULL ORDER BY m.published_at DESC LIMIT 60`);res.json({success:true,videos:rows.map(x=>({id:Number(x.id),title:x.title,creator:x.creator,createdAt:Number(x.published_at),duration:Number(x.duration_s),videoUrl:'/api/videos/'+x.id+'/stream',thumbUrl:x.thumb?'/api/videos/'+x.id+'/thumb':null}))});}catch(e){bad(res,500,"Could not load Marketplace creator videos.");}});
  app.post("/api/creator-partnership/marketplace-videos/:id/hide",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),r=await db.get("UPDATE creator_partnership_marketplace_videos SET visibility='hidden' WHERE video_id=? AND creator_email=? RETURNING video_id",[id,email(req.userEmail)]);if(!r)return bad(res,404,"Your Marketplace video was not found.");res.json({success:true});}catch(e){bad(res,500,"Could not hide the video.");}});

  app.post("/api/creator-partnership/:id/review",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),me=email(req.userEmail),decision=req.body&&req.body.decision,note=String(req.body&&req.body.note||'').trim().slice(0,1000),r=await getReq(id);if(!r)return bad(res,404,"Partnership not found.");if(r.business_email!==me)return bad(res,403,"Only the business can review this video.");if(r.status!=='submitted')return bad(res,409,"There is no submitted video waiting for review.");if(!['approve','reject'].includes(decision))return bad(res,400,"Choose approve or reject.");
    const updated=await db.get("UPDATE creator_partnership_requests SET status=?,approved_at=?,review_note=?,updated_at=? WHERE id=? RETURNING *",[decision==='approve'?'approved':'video_rejected',decision==='approve'?now():null,note||(decision==='approve'?'Video approved by the business.':'Please revise and resubmit your video.'),now(),id]);
    let release=null;if(decision==='approve'&&updated.funding_status==='funded')release=await releaseIfReady(id);
    res.json({success:true,request:shape(updated),release,message:decision==='approve'?'Video approved. Verified funds are being released to the creator.':'Video rejected. The creator can revise and resubmit.'});
  }catch(e){console.error(e);bad(res,500,"Could not review the video.");}});

  app.post("/api/creator-partnership/:id/retry-payout",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),r=await getReq(id);if(!r)return bad(res,404,"Partnership not found.");if(email(req.userEmail)!==email(r.creator_email))return bad(res,403,"Only the creator can request payout processing.");if(r.status!=="approved"||r.funding_status!=="funded")return bad(res,409,"The company funding and video approval must both be complete.");if(r.transfer_status==="needs_review"&&r.transfer_reference){const d=await api("GET","/transfer/verify/"+encodeURIComponent(r.transfer_reference));await applyTransfer(r.transfer_reference,d.status,{transferCode:d.transfer_code,amount:d.amount,reason:d.reason});const fresh=await getReq(id);return res.json({success:true,status:fresh.transfer_status,message:"Existing transfer checked with Paystack. No duplicate transfer was created."});}const result=await releaseIfReady(id);res.json({success:true,result,message:result.reason||"Payout processing has been requested."});}catch(e){bad(res,e.status||500,e.message||"Could not process payout.");}});
  app.get("/api/creator-partnership/:id/transfer-check",requireAuth,async(req,res)=>{try{await ready;const id=Number(req.params.id),r=await getReq(id);if(!r)return bad(res,404,"Partnership not found.");if(![email(r.creator_email),email(r.business_email)].includes(email(req.userEmail)))return bad(res,403,"Not allowed.");if(!r.transfer_reference)return res.json({success:true,status:r.transfer_status,note:r.transfer_note});const d=await api("GET","/transfer/verify/"+encodeURIComponent(r.transfer_reference));await applyTransfer(r.transfer_reference,d.status,{transferCode:d.transfer_code,amount:d.amount,reason:d.reason});const fresh=await getReq(id);res.json({success:true,status:fresh.transfer_status,note:fresh.transfer_note});}catch(e){bad(res,e.status||500,e.message||"Could not check transfer.");}});

  async function handleChargeSuccess(payment){await ready;const ref=String(payment&&payment.reference||"");const r=await db.get("SELECT * FROM creator_partnership_requests WHERE payment_reference=?",[ref]);if(!r)return {handled:false};const verified=await api("GET","/transaction/verify/"+encodeURIComponent(ref));if(!await verifyCharge(verified,r))throw new Error("Partnership payment verification mismatch: "+ref);await markFunded(r.id,ref);await releaseIfReady(r.id);return {handled:true};}
  async function handleTransferEvent(event){await ready;const name=String(event&&event.event||'');if(!/^transfer\.(success|failed|reversed)$/.test(name))return {handled:false};const d=event.data||{};return applyTransfer(d.reference,name.slice(9),{transferCode:d.transfer_code,amount:d.amount,reason:d.reason||d.gateway_response});}
  async function handleChargeReversal(reference,reason){await ready;const ref=String(reference||"");if(!ref)return {handled:false};const r=await db.get("SELECT id,transfer_status FROM creator_partnership_requests WHERE payment_reference=?",[ref]);if(!r)return {handled:false};await db.run("UPDATE creator_partnership_requests SET payment_disputed=TRUE,transfer_status=CASE WHEN transfer_status='success' THEN 'needs_review' ELSE transfer_status END,transfer_note=?,updated_at=? WHERE id=?",[String(reason||"Company payment was disputed or refunded.").slice(0,240),now(),r.id]);return {handled:true};}
  async function migrate(){await ready;}
  return {migrate,handleChargeSuccess,handleTransferEvent,handleChargeReversal,verifyReference,releaseIfReady};
};
