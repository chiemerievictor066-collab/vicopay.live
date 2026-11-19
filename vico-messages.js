// Vico Messages — private, authenticated one-to-one messaging.
// Messages are stored in PostgreSQL; users can only read conversations they participate in.
module.exports = function makeMessages({ app, db, requireAuth, store }) {
  const { users, publicHandle, displayNameOf, avatarUrl } = store;
  const lc = (v) => String(v || '').trim().toLowerCase();
  const bad = (res, code, message) => res.status(code).json({ success: false, message });
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS dm_conversations (id BIGSERIAL PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, UNIQUE(user_a,user_b), CHECK(user_a <> user_b))`,
    `CREATE INDEX IF NOT EXISTS idx_dm_conversations_a ON dm_conversations(user_a,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dm_conversations_b ON dm_conversations(user_b,updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS dm_messages (id BIGSERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, read_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation ON dm_messages(conversation_id,id)`
  ];
  const ready = (async () => { const c = await db.pool.connect(); try { await c.query('SELECT pg_advisory_lock(727291)'); for (const q of SCHEMA) await c.query(q); } finally { try { await c.query('SELECT pg_advisory_unlock(727291)'); } catch (_) {} c.release(); } })().catch(e => { console.error('VICO MESSAGES MIGRATE ERROR:', e); });
  async function target(handle) {
    const email = await users.resolveHandle(String(handle || '').replace(/^@/, ''));
    return email ? lc(email) : null;
  }
  async function conversation(me, other, create) {
    const a = [lc(me), lc(other)].sort();
    if (create) await db.run(`INSERT INTO dm_conversations(user_a,user_b,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_a,user_b) DO NOTHING`, [a[0],a[1],Date.now(),Date.now()]);
    return db.get('SELECT id FROM dm_conversations WHERE user_a=? AND user_b=?', a);
  }
  app.get('/api/dm/threads', requireAuth, async (req,res) => {
    try { await ready; const me=lc(req.userEmail);
      const rows=await db.all(`SELECT c.id, CASE WHEN c.user_a=? THEN c.user_b ELSE c.user_a END AS other_id, c.updated_at AS "lastAt",
        m.body AS preview, m.sender_id, (SELECT COUNT(*) FROM dm_messages u WHERE u.conversation_id=c.id AND u.recipient_id=? AND u.read_at IS NULL) AS unread
        FROM dm_conversations c LEFT JOIN LATERAL (SELECT body,sender_id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) m ON TRUE
        WHERE c.user_a=? OR c.user_b=? ORDER BY c.updated_at DESC LIMIT 100`,[me,me,me,me]);
      await users.warm(rows.map(x=>x.other_id));
      res.json({success:true,threads:rows.map(x=>({handle:publicHandle(x.other_id),displayName:displayNameOf(x.other_id),avatar:avatarUrl(x.other_id),preview:String(x.preview||'').slice(0,120),lastAt:Number(x.lastAt),unread:Number(x.unread)||0}))});
    } catch(e){ console.error('DM THREADS:',e); bad(res,500,'Could not load your messages.'); }
  });
  app.get('/api/dm/with/:handle', requireAuth, async (req,res) => {
    try { await ready; const me=lc(req.userEmail), other=await target(req.params.handle); if(!other) return bad(res,404,'That user was not found.'); if(other===me) return bad(res,400,'You cannot message yourself.');
      const c=await conversation(me,other,false); if(!c) return res.json({success:true,with:{handle:publicHandle(other),displayName:displayNameOf(other),avatar:avatarUrl(other)},messages:[]});
      const after=Math.max(0,Math.floor(Number(req.query.after)||0));
      const rows=await db.all('SELECT id,sender_id AS "senderId",body,created_at AS at FROM dm_messages WHERE conversation_id=? AND id>? ORDER BY id ASC LIMIT 200',[c.id,after]);
      await db.run('UPDATE dm_messages SET read_at=? WHERE conversation_id=? AND recipient_id=? AND read_at IS NULL',[Date.now(),c.id,me]);
      res.json({success:true,with:{handle:publicHandle(other),displayName:displayNameOf(other),avatar:avatarUrl(other)},messages:rows.map(m=>({id:Number(m.id),body:m.body,at:Number(m.at),mine:lc(m.senderId)===me}))});
    } catch(e){ console.error('DM OPEN:',e); bad(res,500,'Could not open this chat.'); }
  });
  app.post('/api/dm/with/:handle', requireAuth, async (req,res) => {
    try { await ready; const me=lc(req.userEmail), other=await target(req.params.handle); if(!other) return bad(res,404,'That user was not found.'); if(other===me) return bad(res,400,'You cannot message yourself.');
      const body=String(req.body&&req.body.body||'').trim(); if(!body) return bad(res,400,'Write a message first.'); if(body.length>1000) return bad(res,400,'Messages can contain up to 1,000 characters.');
      await users.warm([me,other]); const c=await conversation(me,other,true), at=Date.now();
      const row=await db.get('INSERT INTO dm_messages(conversation_id,sender_id,recipient_id,body,created_at) VALUES(?,?,?,?,?) RETURNING id',[c.id,me,other,body,at]);
      await db.run('UPDATE dm_conversations SET updated_at=? WHERE id=?',[at,c.id]);
      res.json({success:true,message:{id:Number(row.id),body,at,mine:true}});
    } catch(e){ console.error('DM SEND:',e); bad(res,500,'Could not send your message.'); }
  });
  return { migrate: ready };
};
