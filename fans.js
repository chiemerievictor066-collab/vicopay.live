// Fan Club live hooks. The membership/join/list API already lives in features.js;
// this module adds fan entrance effects and gift-earned points without duplicating those routes.
module.exports = function makeFans({ app, db, store, vip, requireAuth, getAuthEmail }) {
  const lc = v => String(v || '').trim().toLowerCase();
  const LEVELS = [0,500,2000,10000,50000];
  const levelOf = points => { let level=1; LEVELS.forEach((n,i)=>{if(Number(points)>=n) level=i+1;}); return level; };
  async function onViewerJoin(room,email,push) {
    const host=lc(room&&room.hostId), user=lc(email); if(!host||!user||host===user) return false;
    const member=await db.get('SELECT points FROM fan_members WHERE host_id=? AND user_id=?',[host,user]);
    if(!member) return false;
    const name=store.displayNameOf(user), level=levelOf(member.points);
    push(room.roomId,{type:'fan_enter',from:name,avatar:store.avatarUrl(user),level,notice:`${name} joined as a Level ${level} fan`});
    return true;
  }
  async function onGift({senderId,hostId,price}) {
    const sender=lc(senderId), host=lc(hostId), points=Math.max(0,Math.floor(Number(price)||0));
    if(!sender||!host||!points) return {updated:false};
    const row=await db.get('UPDATE fan_members SET points=points+? WHERE host_id=? AND user_id=? RETURNING points',[points,host,sender]);
    return row ? {updated:true,points:Number(row.points),level:levelOf(row.points)} : {updated:false};
  }
  return { onViewerJoin, onGift, levelOf, levels:LEVELS.slice() };
};
