// VicoPay Campaigns & Competitions — PostgreSQL-backed event system.
const crypto = require('crypto');
module.exports = function campaigns({ app, db, requireAuth, requireAdmin, getAuthEmail, liveRooms }) {
  const id = () => 'evt_' + crypto.randomUUID();
  const now = () => Date.now();
  const clean = (v, n = 500) => String(v == null ? '' : v).trim().slice(0, n);
  const categories = ['video', 'singing', 'comedy', 'dance', 'hosting', 'bracket', 'occasion'];
  async function migrate() {
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      banner_image TEXT, promo_video TEXT, starts_at BIGINT, ends_at BIGINT, registration_deadline BIGINT,
      live_url TEXT, venue TEXT, format TEXT NOT NULL DEFAULT 'open', status TEXT NOT NULL DEFAULT 'draft',
      bracket_size INTEGER NOT NULL DEFAULT 16, prize_text TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_entries (
      id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,
      user_email TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'registered', entry_video TEXT, bio TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, UNIQUE(event_id,user_email))`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_votes (
      id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,
      voter_email TEXT NOT NULL, entry_id BIGINT NOT NULL REFERENCES campaign_entries(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL, UNIQUE(event_id,voter_email))`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_announcements (
      id BIGSERIAL PRIMARY KEY, event_id TEXT REFERENCES campaign_events(id) ON DELETE CASCADE,
      title TEXT NOT NULL, message TEXT NOT NULL, send_to TEXT NOT NULL DEFAULT 'all_streamers', created_at BIGINT NOT NULL)`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_sponsors (
      id BIGSERIAL PRIMARY KEY, event_id TEXT REFERENCES campaign_events(id) ON DELETE SET NULL,
      business_name TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL,
      amount NUMERIC NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at BIGINT NOT NULL)`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_campaign_events_status ON campaign_events(status, starts_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_campaign_entries_event ON campaign_entries(event_id)');
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_applications (
      id TEXT PRIMARY KEY, applicant_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL, event_id TEXT REFERENCES campaign_events(id) ON DELETE SET NULL,
      experience TEXT NOT NULL DEFAULT '', portfolio_url TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new', admin_note TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_campaign_applications_status ON campaign_applications(status,created_at DESC)');
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_event_metrics (event_id TEXT PRIMARY KEY REFERENCES campaign_events(id) ON DELETE CASCADE, views BIGINT NOT NULL DEFAULT 0, likes BIGINT NOT NULL DEFAULT 0)`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_event_likes (event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE, user_email TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(event_id,user_email))`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_matches (
      id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL, match_number INTEGER NOT NULL,
      entry_a BIGINT REFERENCES campaign_entries(id) ON DELETE SET NULL,
      entry_b BIGINT REFERENCES campaign_entries(id) ON DELETE SET NULL,
      winner_entry_id BIGINT REFERENCES campaign_entries(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending', result_note TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      UNIQUE(event_id,round_number,match_number))`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_judges (
      event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,
      judge_email TEXT NOT NULL, assigned_by TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(event_id,judge_email))`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_judge_scores (
      id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,
      match_id BIGINT NOT NULL REFERENCES campaign_matches(id) ON DELETE CASCADE,
      entry_id BIGINT NOT NULL REFERENCES campaign_entries(id) ON DELETE CASCADE,
      judge_email TEXT NOT NULL, score NUMERIC NOT NULL CHECK(score>=0 AND score<=100),
      comments TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      UNIQUE(match_id,entry_id,judge_email))`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_disputes (
      id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,
      match_id BIGINT REFERENCES campaign_matches(id) ON DELETE SET NULL,
      entry_id BIGINT REFERENCES campaign_entries(id) ON DELETE SET NULL,
      submitted_by TEXT NOT NULL, reason TEXT NOT NULL, evidence_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', admin_note TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, reviewed_at BIGINT)`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_campaign_matches_event ON campaign_matches(event_id,round_number,match_number)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_campaign_disputes_event ON campaign_disputes(event_id,status)');
    await db.run('ALTER TABLE campaign_entries ADD COLUMN IF NOT EXISTS live_room_id TEXT');
    await db.run('ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS winner_entry_id BIGINT REFERENCES campaign_entries(id) ON DELETE SET NULL');
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_viewer_comments (id BIGSERIAL PRIMARY KEY,event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,entry_id BIGINT REFERENCES campaign_entries(id) ON DELETE SET NULL,viewer_email TEXT NOT NULL,comment TEXT NOT NULL,created_at BIGINT NOT NULL)`);
    await db.run(`CREATE TABLE IF NOT EXISTS campaign_viewer_judgements (id BIGSERIAL PRIMARY KEY,event_id TEXT NOT NULL REFERENCES campaign_events(id) ON DELETE CASCADE,entry_id BIGINT NOT NULL REFERENCES campaign_entries(id) ON DELETE CASCADE,viewer_email TEXT NOT NULL,score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),comment TEXT NOT NULL DEFAULT '',created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,UNIQUE(event_id,entry_id,viewer_email))`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_campaign_comments_event ON campaign_viewer_comments(event_id,created_at DESC)');
    await db.run('ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS winner_finalized_at BIGINT');
    await db.run("ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS winner_method TEXT NOT NULL DEFAULT ''");
    await db.run('ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS published_notice_sent_at BIGINT');
    await db.run('ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS live_notice_sent_at BIGINT');
  }
  app.get('/api/campaigns', async (req,res) => {
    const rows = await db.all(`SELECT e.*,
      (SELECT COUNT(*) FROM campaign_entries p WHERE p.event_id=e.id) AS participants,
      (SELECT COUNT(*) FROM campaign_votes v WHERE v.event_id=e.id) AS votes,
      COALESCE((SELECT views FROM campaign_event_metrics m WHERE m.event_id=e.id),0) AS views,
      COALESCE((SELECT likes FROM campaign_event_metrics m WHERE m.event_id=e.id),0) AS likes
      FROM campaign_events e WHERE e.status IN ('published','live','completed') ORDER BY e.starts_at ASC NULLS LAST LIMIT 100`);
    res.json({ success:true, events:rows });
  });
  app.get('/api/campaigns/:id', async (req,res) => {
    const e = await db.get(`SELECT e.*,(SELECT COUNT(*) FROM campaign_entries p WHERE p.event_id=e.id) AS participants,
      (SELECT COUNT(*) FROM campaign_votes v WHERE v.event_id=e.id) AS votes,
      COALESCE((SELECT views FROM campaign_event_metrics m WHERE m.event_id=e.id),0) AS views, COALESCE((SELECT likes FROM campaign_event_metrics m WHERE m.event_id=e.id),0) AS likes FROM campaign_events e WHERE e.id=? AND e.status<>'draft'`, [req.params.id]);
    if (!e) return res.status(404).json({success:false,message:'Event not found.'});
    const entries = await db.all(`SELECT p.id,p.stage,p.entry_video,p.bio,p.live_room_id,p.created_at,COALESCE(u.display_name,u.username,'VicoPay Creator') AS display_name,u.username AS creator_handle,
      (SELECT COUNT(*) FROM campaign_votes v WHERE v.entry_id=p.id) AS votes,
      (SELECT COUNT(*) FROM follows f WHERE f.host_id=p.user_email) AS followers,
      COALESCE((SELECT SUM(g.coin) FROM gift_transactions g WHERE lower(g.host_id)=lower(p.user_email) AND g.created_at::timestamptz>=to_timestamp(COALESCE((SELECT starts_at FROM campaign_events WHERE id=p.event_id),(SELECT created_at FROM campaign_events WHERE id=p.event_id))/1000.0) AND g.created_at::timestamptz<=to_timestamp(COALESCE((SELECT ends_at FROM campaign_events WHERE id=p.event_id),?)/1000.0)),0) AS gift_coins,
      (SELECT COUNT(DISTINCT g.sender_id) FROM gift_transactions g WHERE lower(g.host_id)=lower(p.user_email) AND g.created_at::timestamptz>=to_timestamp(COALESCE((SELECT starts_at FROM campaign_events WHERE id=p.event_id),(SELECT created_at FROM campaign_events WHERE id=p.event_id))/1000.0) AND g.created_at::timestamptz<=to_timestamp(COALESCE((SELECT ends_at FROM campaign_events WHERE id=p.event_id),?)/1000.0)) AS supporters
      FROM campaign_entries p LEFT JOIN users u ON lower(u.email)=lower(p.user_email)
      WHERE p.event_id=? ORDER BY votes DESC,p.created_at ASC`, [now(),now(),e.id]);
    res.json({success:true,event:e,entries});
  });
  app.post('/api/campaigns/:id/view', async (req,res) => {
    const e=await db.get("SELECT id FROM campaign_events WHERE id=? AND status<>'draft'",[req.params.id]);
    if(!e) return res.status(404).json({success:false});
    await db.run('INSERT INTO campaign_event_metrics(event_id,views) VALUES(?,1) ON CONFLICT(event_id) DO UPDATE SET views=campaign_event_metrics.views+1',[e.id]);
    res.json({success:true});
  });
  app.post('/api/campaigns/:id/like', requireAuth, async (req,res) => {
    const e=await db.get("SELECT id FROM campaign_events WHERE id=? AND status IN ('published','live')",[req.params.id]);
    if(!e) return res.status(404).json({success:false,message:'Event not found.'});
    try { await db.run('INSERT INTO campaign_event_likes(event_id,user_email,created_at) VALUES(?,?,?)',[e.id,req.userEmail,now()]);
      await db.run('INSERT INTO campaign_event_metrics(event_id,likes) VALUES(?,1) ON CONFLICT(event_id) DO UPDATE SET likes=campaign_event_metrics.likes+1',[e.id]); }
    catch(err) { if(err.code==='23505') return res.status(409).json({success:false,message:'You already liked this event.'}); throw err; }
    res.json({success:true,message:'Like counted.'});
  });
  app.post('/api/campaigns/:id/join', requireAuth, async (req,res) => {
    const e = await db.get("SELECT id,status,registration_deadline FROM campaign_events WHERE id=?",[req.params.id]);
    if (!e || !['published','live'].includes(e.status)) return res.status(404).json({success:false,message:'This event is not accepting entries.'});
    if (e.registration_deadline && Number(e.registration_deadline) < now()) return res.status(400).json({success:false,message:'Registration has closed.'});
    const suppliedEmail=clean(req.body.accountEmail,240).toLowerCase();
    if (!suppliedEmail || !/^\S+@\S+\.\S+$/.test(suppliedEmail) || suppliedEmail !== String(req.userEmail||'').toLowerCase())
      return res.status(403).json({success:false,message:'Use the same email address you supplied for this competition application, and sign in to VicoPay with that exact email.'});
    try { await db.run('INSERT INTO campaign_entries(event_id,user_email,bio,entry_video,created_at) VALUES(?,?,?,?,?)',[e.id,req.userEmail,clean(req.body.bio,800),clean(req.body.entryVideo,1000),now()]); }
    catch(err) { if (err.code==='23505') return res.status(409).json({success:false,message:'You have already joined this event.'}); throw err; }
    res.json({success:true,message:'Your entry has been registered.'});
  });
  app.post('/api/campaigns/:id/vote', requireAuth, async (req,res) => {
    const event = await db.get("SELECT id,status FROM campaign_events WHERE id=? AND status IN ('published','live')",[req.params.id]);
    if (!event) return res.status(404).json({success:false,message:'Voting is not open.'});
    const entry = await db.get('SELECT id FROM campaign_entries WHERE id=? AND event_id=?',[Number(req.body.entryId),event.id]);
    if (!entry) return res.status(404).json({success:false,message:'Entry not found.'});
    try { await db.run('INSERT INTO campaign_votes(event_id,voter_email,entry_id,created_at) VALUES(?,?,?,?)',[event.id,req.userEmail,entry.id,now()]); }
    catch(err) { if (err.code==='23505') return res.status(409).json({success:false,message:'You have already voted in this event.'}); throw err; }
    res.json({success:true,message:'Your vote has been counted.'});
  });
  // Attach an existing VicoPay LiveKit broadcast to the signed-in participant's event entry.
  app.post('/api/campaigns/:id/live/attach', requireAuth, async (req,res)=>{
    const roomId=clean(req.body.roomId,120);
    const liveEvent=await db.get("SELECT id,status FROM campaign_events WHERE id=? AND status IN ('published','live')",[req.params.id]);
    if(!liveEvent) return res.status(409).json({success:false,message:'This competition is not currently accepting live performances.'});
    const room=liveRooms && liveRooms.get(roomId);
    if(!room || String(room.hostId).toLowerCase()!==String(req.userEmail).toLowerCase()) return res.status(403).json({success:false,message:'That live room is not owned by your account or is no longer live.'});
    const entry=await db.get('SELECT id FROM campaign_entries WHERE event_id=? AND lower(user_email)=lower(?)',[req.params.id,req.userEmail]);
    if(!entry) return res.status(403).json({success:false,message:'Join this competition before starting its live performance.'});
    await db.run('UPDATE campaign_entries SET live_room_id=?,stage=\'live\' WHERE id=?',[roomId,entry.id]);
    await db.run("UPDATE campaign_events SET status='live',updated_at=? WHERE id=? AND status='published'",[now(),req.params.id]);
    await db.run('UPDATE campaign_events SET live_url=? WHERE id=?',[`campaign-watch.html?id=${encodeURIComponent(req.params.id)}&entry=${entry.id}`,req.params.id]);
    res.json({success:true,watchUrl:`campaign-watch.html?id=${encodeURIComponent(req.params.id)}&entry=${entry.id}`,message:'Your competition livestream is connected to this event.'});
  });
  app.post('/api/campaigns/:id/comments', requireAuth, async(req,res)=>{
    const comment=clean(req.body.comment,1200), entryId=req.body.entryId?Number(req.body.entryId):null;
    if(comment.length<1) return res.status(400).json({success:false,message:'Write a comment first.'});
    const event=await db.get("SELECT id FROM campaign_events WHERE id=? AND status IN ('published','live')",[req.params.id]);
    if(!event) return res.status(404).json({success:false,message:'Event is not open for comments.'});
    if(entryId && !(await db.get('SELECT id FROM campaign_entries WHERE id=? AND event_id=?',[entryId,event.id]))) return res.status(404).json({success:false,message:'Participant not found.'});
    const r=await db.get('INSERT INTO campaign_viewer_comments(event_id,entry_id,viewer_email,comment,created_at) VALUES(?,?,?,?,?) RETURNING id',[event.id,entryId,req.userEmail,comment,now()]);
    res.status(201).json({success:true,id:r.id,message:'Your comment has been recorded.'});
  });
  app.get('/api/campaigns/:id/comments', async(req,res)=>{
    const rows=await db.all(`SELECT c.id,c.entry_id,c.comment,c.created_at,COALESCE(u.display_name,u.username,'VicoPay Viewer') AS viewer_name FROM campaign_viewer_comments c LEFT JOIN users u ON lower(u.email)=lower(c.viewer_email) WHERE c.event_id=? ORDER BY c.created_at DESC LIMIT 150`,[req.params.id]);
    res.json({success:true,comments:rows});
  });
  app.post('/api/campaigns/:id/viewer-judgements', requireAuth, async(req,res)=>{
    const entryId=Number(req.body.entryId), score=Number(req.body.score), comment=clean(req.body.comment,1000);
    const event=await db.get("SELECT id FROM campaign_events WHERE id=? AND status IN ('published','live')",[req.params.id]);
    if(!event || !Number.isInteger(entryId) || !Number.isInteger(score) || score<1 || score>10) return res.status(400).json({success:false,message:'Choose a participant and a score from 1 to 10.'});
    if(!(await db.get('SELECT id FROM campaign_entries WHERE id=? AND event_id=?',[entryId,event.id]))) return res.status(404).json({success:false,message:'Participant not found.'});
    await db.run(`INSERT INTO campaign_viewer_judgements(event_id,entry_id,viewer_email,score,comment,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id,entry_id,viewer_email) DO UPDATE SET score=EXCLUDED.score,comment=EXCLUDED.comment,updated_at=EXCLUDED.updated_at`,[event.id,entryId,req.userEmail,score,comment,now(),now()]);
    res.json({success:true,message:'Your viewer assessment has been recorded for admin review. It does not automatically change the official score.'});
  });
  app.get('/api/admin/campaigns/:id/feedback', requireAdmin, async(req,res)=>{
    const comments=await db.all(`SELECT c.id,c.entry_id,c.comment,c.created_at,COALESCE(u.display_name,u.username,c.viewer_email) AS viewer_name,COALESCE(p.display_name,'Event-wide') AS participant FROM campaign_viewer_comments c LEFT JOIN users u ON lower(u.email)=lower(c.viewer_email) LEFT JOIN (SELECT id,COALESCE(u2.display_name,u2.username,'Creator') AS display_name FROM campaign_entries e LEFT JOIN users u2 ON lower(u2.email)=lower(e.user_email)) p ON p.id=c.entry_id WHERE c.event_id=? ORDER BY c.created_at DESC LIMIT 500`,[req.params.id]);
    const judgements=await db.all(`SELECT j.id,j.entry_id,j.score,j.comment,j.created_at,COALESCE(u.display_name,u.username,j.viewer_email) AS viewer_name,COALESCE(p.display_name,'Creator') AS participant FROM campaign_viewer_judgements j LEFT JOIN users u ON lower(u.email)=lower(j.viewer_email) LEFT JOIN (SELECT id,COALESCE(u2.display_name,u2.username,'Creator') AS display_name FROM campaign_entries e LEFT JOIN users u2 ON lower(u2.email)=lower(e.user_email)) p ON p.id=j.entry_id WHERE j.event_id=? ORDER BY j.created_at DESC LIMIT 500`,[req.params.id]);
    res.json({success:true,comments,judgements});
  });
  // Public competition application form; admins review and enrol applicants into an event.
  app.post('/api/campaign-applications', async (req,res)=>{
    const b=req.body||{}, name=clean(b.name,140), email=clean(b.email,240).toLowerCase(), phone=clean(b.phone,50);
    const category=categories.includes(clean(b.category,30))?clean(b.category,30):'video';
    const eventId=clean(b.eventId,80)||null;
    if(!name || !/^\S+@\S+\.\S+$/.test(email) || !phone || !clean(b.message,30)) return res.status(400).json({success:false,message:'Enter your name, valid email, phone number and at least 30 characters about your application.'});
    if(eventId && !(await db.get("SELECT id FROM campaign_events WHERE id=? AND status IN ('published','live')",[eventId]))) return res.status(404).json({success:false,message:'The selected competition is not open for applications.'});
    const applicationId='app_'+crypto.randomUUID(), t=now();
    await db.run(`INSERT INTO campaign_applications(id,applicant_name,email,phone,category,event_id,experience,portfolio_url,message,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'new',?,?)`,[applicationId,name,email,phone,category,eventId,clean(b.experience,1500),clean(b.portfolioUrl,500),clean(b.message,3000),t,t]);
    res.status(201).json({success:true,applicationId,message:'Your competition application has been sent to VicoPay. The admin team will review it.'});
  });
  app.get('/api/admin/campaign-applications', requireAdmin, async(req,res)=>{
    const status=clean(req.query.status,30);
    const rows=await db.all(`SELECT a.*,e.title AS event_title FROM campaign_applications a LEFT JOIN campaign_events e ON e.id=a.event_id ${['new','reviewing','approved','declined','enrolled'].includes(status)?'WHERE a.status=?':''} ORDER BY a.created_at DESC LIMIT 500`,['new','reviewing','approved','declined','enrolled'].includes(status)?[status]:[]);
    res.json({success:true,applications:rows});
  });
  app.patch('/api/admin/campaign-applications/:id', requireAdmin, async(req,res)=>{
    const status=['reviewing','approved','declined'].includes(req.body.status)?req.body.status:null;
    if(!status) return res.status(400).json({success:false,message:'Choose reviewing, approved or declined.'});
    const note=clean(req.body.adminNote,1500);
    const existing=await db.get('SELECT id FROM campaign_applications WHERE id=?',[req.params.id]);
    if(!existing) return res.status(404).json({success:false,message:'Application not found.'});
    await db.run('UPDATE campaign_applications SET status=?,admin_note=?,updated_at=? WHERE id=?',[status,note,now(),req.params.id]);
    res.json({success:true,message:'Application review saved.'});
  });
  app.post('/api/admin/campaign-applications/:id/enrol', requireAdmin, async(req,res)=>{
    const application=await db.get('SELECT * FROM campaign_applications WHERE id=?',[req.params.id]);
    if(!application) return res.status(404).json({success:false,message:'Application not found.'});
    const eventId=clean(req.body.eventId||application.event_id,80);
    const event=await db.get("SELECT id FROM campaign_events WHERE id=? AND status IN ('published','live')",[eventId]);
    if(!event) return res.status(400).json({success:false,message:'Select a published competition before adding this applicant.'});
    try { await db.run("INSERT INTO campaign_entries(event_id,user_email,stage,bio,created_at) VALUES(?,?,'registered',?,?) ON CONFLICT(event_id,user_email) DO NOTHING",[eventId,application.email,clean(application.experience+' '+application.message,1000),now()]); }
    catch(e){ return res.status(500).json({success:false,message:'Could not add this applicant to the competition.'}); }
    await db.run("UPDATE campaign_applications SET event_id=?,status='enrolled',updated_at=? WHERE id=?",[eventId,now(),application.id]);
    res.json({success:true,message:'Applicant added to the selected competition.'});
  });

  app.get('/api/campaign-announcements', async (req,res) => {
    const rows = await db.all('SELECT id,event_id,title,message,created_at FROM campaign_announcements ORDER BY created_at DESC LIMIT 30');
    res.json({success:true,announcements:rows});
  });
  app.post('/api/campaigns/sponsors', async (req,res) => {
    const b=req.body||{}; const business=clean(b.businessName,160), email=clean(b.email,240);
    if(!business || !email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({success:false,message:'Enter a business name and valid email.'});
    if(b.eventId && !(await db.get('SELECT id FROM campaign_events WHERE id=?',[clean(b.eventId,80)]))) return res.status(404).json({success:false,message:'Event not found.'});
    await db.run('INSERT INTO campaign_sponsors(event_id,business_name,contact_name,email,amount,message,created_at) VALUES(?,?,?,?,?,?,?)',[clean(b.eventId,80)||null,business,clean(b.contactName,160),email,Math.max(0,Number(b.amount)||0),clean(b.message,1500),now()]);
    res.json({success:true,message:'Sponsorship enquiry submitted. VicoPay will review it.'});
  });
  app.get('/api/admin/campaigns', requireAdmin, async (req,res) => {
    const events=await db.all(`SELECT e.*,(SELECT COUNT(*) FROM campaign_entries p WHERE p.event_id=e.id) AS participants,
      (SELECT COUNT(*) FROM campaign_votes v WHERE v.event_id=e.id) AS votes FROM campaign_events e ORDER BY e.created_at DESC`);
    const sponsors=await db.all('SELECT * FROM campaign_sponsors ORDER BY created_at DESC LIMIT 100');
    res.json({success:true,events,sponsors});
  });
  app.post('/api/admin/campaigns', requireAdmin, async (req,res) => {
    const b=req.body||{}, title=clean(b.title,160), category=clean(b.category,30);
    if(!title || !categories.includes(category) || !clean(b.description,3000)) return res.status(400).json({success:false,message:'Title, valid event type and description are required.'});
    const eventId=id(), t=now();
    await db.run(`INSERT INTO campaign_events(id,title,category,description,banner_image,promo_video,starts_at,ends_at,registration_deadline,live_url,venue,format,status,bracket_size,prize_text,rules,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[eventId,title,category,clean(b.description,3000),clean(b.bannerImage,1000),clean(b.promoVideo,1000),b.startsAt?new Date(b.startsAt).getTime():null,b.endsAt?new Date(b.endsAt).getTime():null,b.registrationDeadline?new Date(b.registrationDeadline).getTime():null,clean(b.liveUrl,1000),clean(b.venue,200),b.format==='bracket'?'bracket':'open','draft',Math.max(2,Math.min(128,Number(b.bracketSize)||16)),clean(b.prizeText,500),clean(b.rules,3000),getAuthEmail(req)||'admin',t,t]);
    res.status(201).json({success:true,eventId,message:'Event saved as draft. Publish it when the details are ready.'});
  });
  app.patch('/api/admin/campaigns/:id', requireAdmin, async (req,res) => {
    const b=req.body||{}, event=await db.get('SELECT * FROM campaign_events WHERE id=?',[req.params.id]);
    if(!event) return res.status(404).json({success:false,message:'Event not found.'});
    const allowed=['draft','published','live','completed','cancelled'];
    const status=allowed.includes(b.status)?b.status:event.status;
    const stamp=now();
    const shouldNotifyPublished=status==='published' && !event.published_notice_sent_at;
    const shouldNotifyLive=status==='live' && !event.live_notice_sent_at;
    await db.run('UPDATE campaign_events SET status=?,updated_at=?,published_notice_sent_at=CASE WHEN ? THEN ? ELSE published_notice_sent_at END,live_notice_sent_at=CASE WHEN ? THEN ? ELSE live_notice_sent_at END WHERE id=?',[status,stamp,shouldNotifyPublished,stamp,shouldNotifyLive,stamp,event.id]);
    let notified=0;
    if(shouldNotifyPublished||shouldNotifyLive){
      const text=shouldNotifyLive?`${event.title} is LIVE now on VicoPay. Open the event page to watch and participate.`:`${event.title} has been scheduled on VicoPay. Check the event calendar for its date, time and participation details.`;
      const result=await db.run(`INSERT INTO notifications(user_id,text,link,created_at) SELECT lower(email),?,?,? FROM users WHERE email IS NOT NULL AND trim(email)<>''`,[text,`campaign-event.html?id=${encodeURIComponent(event.id)}`,stamp]);
      notified=Number(result.changes||0);
    }
    res.json({success:true,message:(shouldNotifyPublished||shouldNotifyLive)?`Event status updated. In-app notification delivered to ${notified} VicoPay accounts.`:'Event status updated.',notified});
  });
  app.post('/api/admin/campaigns/:id/announce', requireAdmin, async (req,res) => {
    const b=req.body||{}, title=clean(b.title,160), message=clean(b.message,1500);
    if(!title||!message) return res.status(400).json({success:false,message:'Announcement title and message are required.'});
    const eventId=clean(req.params.id,80); if(eventId!=='all' && !(await db.get('SELECT id FROM campaign_events WHERE id=?',[eventId]))) return res.status(404).json({success:false,message:'Event not found.'});
    const stamp=now();
    await db.run('INSERT INTO campaign_announcements(event_id,title,message,send_to,created_at) VALUES(?,?,?,?,?)',[eventId==='all'?null:eventId,title,message,'all_vicopay_accounts',stamp]);
    const link=eventId==='all'?'campaigns.html':`campaign-event.html?id=${encodeURIComponent(eventId)}`;
    const body=`${title}: ${message}`.slice(0,200);
    const delivered=await db.run(`INSERT INTO notifications(user_id,text,link,created_at) SELECT lower(email),?,?,? FROM users WHERE email IS NOT NULL AND trim(email)<>''`,[body,link,stamp]);
    res.json({success:true,message:`Announcement published and delivered to ${Number(delivered.changes||0)} VicoPay customer and streamer accounts.`,notified:Number(delivered.changes||0)});
  });
  app.patch('/api/admin/campaign-sponsors/:id', requireAdmin, async (req,res) => {
    const status=['reviewing','approved','declined'].includes(req.body.status)?req.body.status:null;
    if(!status) return res.status(400).json({success:false,message:'Invalid sponsor status.'});
    await db.run('UPDATE campaign_sponsors SET status=? WHERE id=?',[status,Number(req.params.id)]);
    res.json({success:true,message:'Sponsor enquiry updated.'});
  });
  // ----- Knockout brackets, judge scoring, gift points and disputes -----
  async function advanceBracket(t, eventId) {
    const current = await t.all('SELECT * FROM campaign_matches WHERE event_id=? ORDER BY round_number,match_number', [eventId]);
    if (!current.length || current.some(m => m.status !== 'completed')) return;
    const round = Math.max(...current.map(m => Number(m.round_number)));
    const latest = current.filter(m => Number(m.round_number) === round);
    if (latest.some(m => m.status !== 'completed')) return;
    if (latest.length === 1) return; // final already decided
    if (await t.get('SELECT id FROM campaign_matches WHERE event_id=? AND round_number=? LIMIT 1', [eventId, round + 1])) return;
    const winners = latest.map(m => Number(m.winner_entry_id)).filter(Boolean);
    if (winners.length <= 1) return;
    for (let i = 0; i < winners.length; i += 2) {
      const a = winners[i], b = winners[i + 1] || null;
      const status = b ? 'pending' : 'completed';
      await t.run(`INSERT INTO campaign_matches(event_id,round_number,match_number,entry_a,entry_b,winner_entry_id,status,result_note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [eventId, round + 1, Math.floor(i / 2) + 1, a, b, b ? null : a, status, b ? '' : 'Automatic bye advancement', now(), now()]);
    }
    // If every match in the newly-created round is a bye, continue advancing automatically.
    await advanceBracket(t, eventId);
  }
  app.post('/api/admin/campaigns/:id/bracket/generate', requireAdmin, async (req,res) => {
    const eventId=clean(req.params.id,80);
    const event=await db.get('SELECT * FROM campaign_events WHERE id=?',[eventId]);
    if(!event) return res.status(404).json({success:false,message:'Event not found.'});
    if(event.format!=='bracket' && event.category!=='bracket') return res.status(400).json({success:false,message:'Set this event format to bracket before generating matches.'});
    try {
      const result=await db.tx(async t=>{
        await t.lock('campaign-bracket:'+eventId);
        const existing=await t.get('SELECT id FROM campaign_matches WHERE event_id=? LIMIT 1',[eventId]);
        if(existing) return {created:false};
        const entrants=await t.all("SELECT id FROM campaign_entries WHERE event_id=? AND stage<>'withdrawn' ORDER BY created_at ASC,id ASC",[eventId]);
        if(entrants.length<2) throw Object.assign(new Error('At least two registered participants are required.'),{status:400});
        const cap=Math.max(2,Math.min(128,Number(event.bracket_size)||16));
        if(entrants.length>cap) throw Object.assign(new Error(`This event allows ${cap} entrants. There are ${entrants.length} registered.`),{status:400});
        let size=2; while(size<entrants.length) size*=2;
        const slots=entrants.map(x=>Number(x.id)); while(slots.length<size) slots.push(null);
        for(let i=0;i<size;i+=2){
          const a=slots[i],b=slots[i+1],bye=!b;
          await t.run(`INSERT INTO campaign_matches(event_id,round_number,match_number,entry_a,entry_b,winner_entry_id,status,result_note,created_at,updated_at)
            VALUES(?,1,?,?,?,?,?,?,?,?)`,[eventId,i/2+1,a,b,bye?a:null,bye?'completed':'pending',bye?'Automatic bye advancement':'',now(),now()]);
        }
        await advanceBracket(t,eventId);
        return {created:true,entrants:entrants.length,bracketSize:size};
      });
      if(!result.created) return res.status(409).json({success:false,message:'A bracket already exists for this event. It cannot be regenerated after matches have been created.'});
      res.status(201).json({success:true,...result,message:`Knockout bracket generated for ${result.entrants} participants.`});
    } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Could not generate bracket.'});}
  });
  app.get('/api/campaigns/:id/bracket', async (req,res)=>{
    const event=await db.get("SELECT id,title,status FROM campaign_events WHERE id=? AND status<>'draft'",[req.params.id]);
    if(!event) return res.status(404).json({success:false,message:'Event not found.'});
    const matches=await db.all(`SELECT m.*,
      COALESCE(ua.display_name,ua.username,'Creator') AS entry_a_name,COALESCE(ub.display_name,ub.username,'Creator') AS entry_b_name,
      COALESCE(uw.display_name,uw.username,'Creator') AS winner_name
      FROM campaign_matches m LEFT JOIN campaign_entries a ON a.id=m.entry_a LEFT JOIN campaign_entries b ON b.id=m.entry_b LEFT JOIN campaign_entries w ON w.id=m.winner_entry_id
      LEFT JOIN users ua ON lower(ua.email)=lower(a.user_email) LEFT JOIN users ub ON lower(ub.email)=lower(b.user_email) LEFT JOIN users uw ON lower(uw.email)=lower(w.user_email)
      WHERE m.event_id=? ORDER BY m.round_number,m.match_number`,[event.id]);
    res.json({success:true,event,matches});
  });
  app.patch('/api/admin/campaign-matches/:matchId/result', requireAdmin, async(req,res)=>{
    const matchId=Number(req.params.matchId), winner=Number(req.body.winnerEntryId), note=clean(req.body.note,1000);
    try {
      const updated=await db.tx(async t=>{
        const m=await t.get('SELECT * FROM campaign_matches WHERE id=?',[matchId]);
        if(!m) throw Object.assign(new Error('Match not found.'),{status:404});
        if(m.status==='completed') throw Object.assign(new Error('This match has already been completed.'),{status:409});
        if(![Number(m.entry_a),Number(m.entry_b)].includes(winner)) throw Object.assign(new Error('Winner must be one of the two participants in this match.'),{status:400});
        const open=await t.get("SELECT id FROM campaign_disputes WHERE match_id=? AND status='open' LIMIT 1",[matchId]);
        if(open) throw Object.assign(new Error('Resolve the open dispute before recording this result.'),{status:409});
        await t.run("UPDATE campaign_matches SET winner_entry_id=?,status='completed',result_note=?,updated_at=? WHERE id=?",[winner,note,now(),matchId]);
        await advanceBracket(t,m.event_id);
        return m.event_id;
      });
      res.json({success:true,message:'Match result saved and the next round advanced where possible.',eventId:updated});
    }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Could not save result.'});}
  });
  app.post('/api/admin/campaigns/:id/judges', requireAdmin, async(req,res)=>{
    const email=clean(req.body.email,240).toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({success:false,message:'Enter a valid judge account email.'});
    const event=await db.get('SELECT id FROM campaign_events WHERE id=?',[req.params.id]);
    if(!event) return res.status(404).json({success:false,message:'Event not found.'});
    await db.run('INSERT INTO campaign_judges(event_id,judge_email,assigned_by,created_at) VALUES(?,?,?,?) ON CONFLICT(event_id,judge_email) DO NOTHING',[event.id,email,getAuthEmail(req)||'admin',now()]);
    res.json({success:true,message:'Judge assigned.'});
  });
  app.get('/api/campaigns/:id/judges', requireAuth, async(req,res)=>{
    const rows=await db.all('SELECT judge_email,created_at FROM campaign_judges WHERE event_id=? ORDER BY created_at',[req.params.id]);
    res.json({success:true,judges:rows.map(x=>({judge: x.judge_email.replace(/^(.{2}).*(@.*)$/,'$1•••$2'),created_at:x.created_at}))});
  });
  app.post('/api/campaign-matches/:matchId/score', requireAuth, async(req,res)=>{
    const match=await db.get("SELECT * FROM campaign_matches WHERE id=? AND status<>'completed'",[Number(req.params.matchId)]);
    if(!match) return res.status(404).json({success:false,message:'Open match not found.'});
    const judge=await db.get('SELECT judge_email FROM campaign_judges WHERE event_id=? AND lower(judge_email)=lower(?)',[match.event_id,req.userEmail]);
    if(!judge) return res.status(403).json({success:false,message:'Only judges assigned to this event can score it.'});
    const entryId=Number(req.body.entryId), score=Number(req.body.score), comments=clean(req.body.comments,1000);
    if(![Number(match.entry_a),Number(match.entry_b)].includes(entryId)||!Number.isFinite(score)||score<0||score>100) return res.status(400).json({success:false,message:'Choose a match participant and enter a score from 0 to 100.'});
    await db.run(`INSERT INTO campaign_judge_scores(event_id,match_id,entry_id,judge_email,score,comments,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(match_id,entry_id,judge_email) DO UPDATE SET score=EXCLUDED.score,comments=EXCLUDED.comments,updated_at=EXCLUDED.updated_at`,[match.event_id,match.id,entryId,req.userEmail,score,comments,now(),now()]);
    res.json({success:true,message:'Your judging score has been saved.'});
  });
  app.post('/api/campaigns/:id/disputes', requireAuth, async(req,res)=>{
    const event=await db.get("SELECT id FROM campaign_events WHERE id=? AND status IN ('published','live','completed')",[req.params.id]);
    const reason=clean(req.body.reason,2000), matchId=req.body.matchId?Number(req.body.matchId):null;
    if(!event||reason.length<15) return res.status(400).json({success:false,message:'Event not found or dispute reason is too short (minimum 15 characters).'});
    if(matchId && !(await db.get('SELECT id FROM campaign_matches WHERE id=? AND event_id=?',[matchId,event.id]))) return res.status(404).json({success:false,message:'Match not found.'});
    const entry=await db.get('SELECT id FROM campaign_entries WHERE event_id=? AND lower(user_email)=lower(?)',[event.id,req.userEmail]);
    const r=await db.get(`INSERT INTO campaign_disputes(event_id,match_id,entry_id,submitted_by,reason,evidence_url,created_at)
      VALUES(?,?,?,?,?,?,?) RETURNING id`,[event.id,matchId,entry?entry.id:null,req.userEmail,reason,clean(req.body.evidenceUrl,1000),now()]);
    res.status(201).json({success:true,disputeId:r.id,message:'Dispute submitted for VicoPay admin review.'});
  });
  app.get('/api/admin/campaign-disputes', requireAdmin, async(req,res)=>{
    const rows=await db.all(`SELECT d.*,e.title AS event_title,m.round_number,m.match_number,p.user_email AS participant_email
      FROM campaign_disputes d JOIN campaign_events e ON e.id=d.event_id LEFT JOIN campaign_matches m ON m.id=d.match_id LEFT JOIN campaign_entries p ON p.id=d.entry_id
      ORDER BY CASE WHEN d.status='open' THEN 0 ELSE 1 END,d.created_at DESC LIMIT 200`);
    res.json({success:true,disputes:rows});
  });
  app.patch('/api/admin/campaign-disputes/:id', requireAdmin, async(req,res)=>{
    const status=['resolved','rejected'].includes(req.body.status)?req.body.status:null, note=clean(req.body.adminNote,2000);
    if(!status||note.length<5) return res.status(400).json({success:false,message:'Choose resolved or rejected and provide an admin review note.'});
    const r=await db.run('UPDATE campaign_disputes SET status=?,admin_note=?,reviewed_at=? WHERE id=? AND status=\'open\'',[status,note,now(),Number(req.params.id)]);
    if(!r.changes) return res.status(404).json({success:false,message:'Open dispute not found.'});
    res.json({success:true,message:'Dispute review saved.'});
  });
  app.get('/api/campaigns/:id/leaderboard', async(req,res)=>{
    const event=await db.get("SELECT * FROM campaign_events WHERE id=? AND status<>'draft'",[req.params.id]);
    if(!event) return res.status(404).json({success:false,message:'Event not found.'});
    const start=Number(event.starts_at||event.created_at), end=Number(event.ends_at||now());
    const rows=await db.all(`SELECT p.id,p.user_email,COALESCE(u.display_name,u.username,'VicoPay Creator') AS display_name,
      (SELECT COUNT(*) FROM campaign_votes v WHERE v.entry_id=p.id) AS votes,
      COALESCE((SELECT SUM(g.coin) FROM gift_transactions g WHERE lower(g.host_id)=lower(p.user_email) AND g.created_at::timestamptz>=to_timestamp(?/1000.0) AND g.created_at::timestamptz<=to_timestamp(?/1000.0)),0) AS gift_coins,
      COALESCE((SELECT AVG(s.score) FROM campaign_judge_scores s WHERE s.event_id=p.event_id AND s.entry_id=p.id),0) AS judge_score
      FROM campaign_entries p LEFT JOIN users u ON lower(u.email)=lower(p.user_email) WHERE p.event_id=? AND p.stage<>'withdrawn'`,[start,end,event.id]);
    const leaderboard=rows.map(x=>({...x,user_email:undefined,gift_points:Math.floor(Number(x.gift_coins||0)/100),judge_score:Number(x.judge_score||0),total_score:Number(x.votes||0)+Math.floor(Number(x.gift_coins||0)/100)+Number(x.judge_score||0)})).sort((a,b)=>b.total_score-a.total_score||b.judge_score-a.judge_score||b.votes-a.votes||b.gift_coins-a.gift_coins);
    res.json({success:true,scoring:{votes:'1 point per verified vote',gifts:'1 point per 100 gift coins received during the event',judges:'Average judge score (0–100 per scored match)'},leaderboard});
  });
  app.post('/api/admin/campaigns/:id/finalize', requireAdmin, async(req,res)=>{
    const eventId=clean(req.params.id,80);
    try {
      const winner=await db.tx(async t=>{
        await t.lock('campaign-finalize:'+eventId);
        const event=await t.get('SELECT * FROM campaign_events WHERE id=?',[eventId]);
        if(!event) throw Object.assign(new Error('Event not found.'),{status:404});
        if(event.winner_finalized_at) throw Object.assign(new Error('A winner has already been finalized for this event.'),{status:409});
        const dispute=await t.get("SELECT id FROM campaign_disputes WHERE event_id=? AND status='open' LIMIT 1",[eventId]);
        if(dispute) throw Object.assign(new Error('Resolve all open disputes before finalizing the winner.'),{status:409});
        let entryId=null,method='weighted leaderboard';
        const matches=await t.all('SELECT * FROM campaign_matches WHERE event_id=? ORDER BY round_number DESC,match_number ASC',[eventId]);
        if(matches.length){
          const finalMatch=matches[0];
          if(finalMatch.status!=='completed'||!finalMatch.winner_entry_id) throw Object.assign(new Error('The knockout bracket is not complete. Finish the final match first.'),{status:409});
          entryId=Number(finalMatch.winner_entry_id);method='knockout bracket';
        } else {
          const start=Number(event.starts_at||event.created_at),end=Number(event.ends_at||now());
          const rows=await t.all(`SELECT p.id,
            (SELECT COUNT(*) FROM campaign_votes v WHERE v.entry_id=p.id) AS votes,
            COALESCE((SELECT SUM(g.coin) FROM gift_transactions g WHERE lower(g.host_id)=lower(p.user_email) AND g.created_at::timestamptz>=to_timestamp(?/1000.0) AND g.created_at::timestamptz<=to_timestamp(?/1000.0)),0) AS gift_coins,
            COALESCE((SELECT AVG(s.score) FROM campaign_judge_scores s WHERE s.event_id=p.event_id AND s.entry_id=p.id),0) AS judge_score
            FROM campaign_entries p WHERE p.event_id=? AND p.stage<>'withdrawn'`,[start,end,eventId]);
          if(!rows.length) throw Object.assign(new Error('There are no eligible participants.'),{status:400});
          rows.sort((a,b)=>(Number(b.votes)+Math.floor(Number(b.gift_coins)/100)+Number(b.judge_score))-(Number(a.votes)+Math.floor(Number(a.gift_coins)/100)+Number(a.judge_score))||Number(b.judge_score)-Number(a.judge_score)||Number(b.votes)-Number(a.votes)||Number(b.gift_coins)-Number(a.gift_coins));
          entryId=Number(rows[0].id);
        }
        await t.run("UPDATE campaign_events SET winner_entry_id=?,winner_finalized_at=?,winner_method=?,status='completed',updated_at=? WHERE id=?",[entryId,now(),method,now(),eventId]);
        const p=await t.get("SELECT p.id,p.user_email,COALESCE(u.display_name,u.username,'VicoPay Creator') AS display_name FROM campaign_entries p LEFT JOIN users u ON lower(u.email)=lower(p.user_email) WHERE p.id=?",[entryId]);
        return {entryId:p.id,displayName:p.display_name,method};
      });
      res.json({success:true,winner,message:`Winner finalized: ${winner.displayName} (${winner.method}).`});
    }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Could not finalize winner.'});}
  });
  app.get('/api/admin/campaigns/:id/competition', requireAdmin, async(req,res)=>{
    const matches=await db.all('SELECT * FROM campaign_matches WHERE event_id=? ORDER BY round_number,match_number',[req.params.id]);
    const judges=await db.all('SELECT judge_email,created_at FROM campaign_judges WHERE event_id=? ORDER BY created_at',[req.params.id]);
    const disputes=await db.all("SELECT * FROM campaign_disputes WHERE event_id=? ORDER BY created_at DESC",[req.params.id]);
    res.json({success:true,matches,judges,disputes});
  });
  return { migrate };
};
