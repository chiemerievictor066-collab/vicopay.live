// Public VIP leaderboards and achievements. Read-only: this module never grants or changes VIP status.
module.exports = function makeVipRankings({ app, db, store, vip }) {
  const lc = v => String(v || '').toLowerCase();
  async function rows() {
    if (!(await vip.isEnabled())) return [];
    const eligible=await db.all("SELECT user_id AS email,tier,verified_streamer AS verified FROM vip_eligibility WHERE status='approved' AND tier <> 'none' AND (expires_at IS NULL OR expires_at>?) ORDER BY granted_at DESC LIMIT 200",[Date.now()]);
    await store.users.warm(eligible.map(x=>x.email));
    const scored=[];
    for (const u of eligible) {
      try {
        const tier=await vip.tierOf(u.email); if(!tier||!tier.rank) continue;
        const [stars,followers]=await Promise.all([vip.lifetimeStars(u.email),db.get('SELECT COUNT(*) AS n FROM follows WHERE host_id=?',[lc(u.email)])]);
        scored.push({handle:store.publicHandle(u.email),displayName:store.displayNameOf(u.email),avatar:store.avatarUrl(u.email),tier:tier.tier,label:tier.label||tier.tier,rank:tier.rank,stars:Number(stars)||0,followers:Number(followers&&followers.n)||0,verified:!!u.verified});
      } catch (_) { /* one malformed profile must not break the board */ }
    }
    return scored;
  }
  app.get('/api/vip/rankings', async (req,res)=>{
    try { const list=await rows(); const by=(a,b)=>b.rank-a.rank||b.stars-a.stars||b.followers-a.followers;
      res.set('Cache-Control','public, max-age=30'); res.json({success:true,enabled:await vip.isEnabled(),rankings:list.sort(by).slice(0,100)});
    } catch(e){console.error('VIP RANKINGS:',e);res.status(500).json({success:false,message:'Could not load VIP rankings.'});}
  });
  app.get('/api/vip/achievements', async (req,res)=>{
    try { const list=await rows(); const top=list.slice().sort((a,b)=>b.stars-a.stars||b.followers-a.followers).slice(0,20);
      res.set('Cache-Control','public, max-age=30'); res.json({success:true,enabled:await vip.isEnabled(),achievements:top.map((u,i)=>({...u,achievement:i===0?'Top VIP Supporter':i<3?'Elite VIP Supporter':u.rank>=4?'Royal VIP':'VIP Member'}))});
    } catch(e){console.error('VIP ACHIEVEMENTS:',e);res.status(500).json({success:false,message:'Could not load VIP achievements.'});}
  });
};
