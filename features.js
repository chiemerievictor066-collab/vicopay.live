// =====================================================
// VicoPay Live — feature module (PostgreSQL)
// follow system, fan club, PK battles, live discovery, notifications, reports, search,
// profiles + photos, admin dashboard API and self-service password reset.
// Data is stored in PostgreSQL (see db.js). The real-time bits (who is watching right now, gift pop-ups, chat pulse)
// live in this server's memory because they only matter for seconds.
// =====================================================
const mailer = require("./mailer"); // email through Resend (see mailer.js)
module.exports = function (ctx) {
  const {
    app, db, ledger, store, axios, crypto, liveRooms, giftPrices, getAuthEmail, requireAuth, requireAdmin,
    authRateLimit, hashPassword, recordSessionEnd, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
  } = ctx;
  const { users, publicHandle, displayNameOf, avatarUrl, bannedUsers, getHostStats } = store;
  const getStarBreakdown = store.starBreakdown;
  const resolveHandle = (h) => users.resolveHandle(h);

  const FAN_CLUB_COST = 100;                       // coins to join a fan club
  const FAN_LEVELS = [0, 500, 2000, 10000, 50000]; // points needed for level 1..5
  const PK_DURATIONS = [180, 300, 600];
  const lc = (v) => String(v || "").toLowerCase();
  const ok = (res, extra) => res.json({ success: true, ...extra });
  const fail = (res, code, message) => res.status(code).json({ success: false, message });
  const ph = (arr) => arr.map(() => "?").join(",");
  const oneJson = (limit) => require("express").json({ limit });

  // ---------- notifications ----------
  const notify = (email, text, link) =>
    db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [lc(email), String(text).slice(0, 200), link || null, Date.now()]).catch(() => {});

  const roomOfHost = (email) => { for (const r of liveRooms.values()) if (lc(r.hostId) === lc(email)) return r; return null; };

  // ---------- live viewers, thumbnails, events (in memory: they only matter for a few seconds) ----------
  const viewers = new Map();  // roomId -> Map(key -> lastSeen)
  const thumbs = new Map();   // roomId -> {buf, ts}
  const events = new Map();   // roomId -> [{id, ts, ...}]
  const uniq = new Map();     // roomId -> Set of everyone who has opened this live (total views)
  let eventSeq = 1;
  const pushEvent = (roomId, ev) => {
    if (!roomId) return;
    const list = events.get(roomId) || [];
    list.push({ id: eventSeq++, ts: Date.now(), ...ev });
    while (list.length > 150) { const i = list.findIndex((e) => e.type === "love"); list.splice(i >= 0 ? i : 0, 1); } // hearts go first, gifts are kept
    events.set(roomId, list);
  };
  function countViewers(roomId) {
    const m = viewers.get(roomId); if (!m) return 0;
    const now = Date.now(); let n = 0;
    for (const [k, t] of m) { if (now - t > 25000) m.delete(k); else n++; }
    return n;
  }

  // ---------- follower counts: one grouped query per request, remembered for 30 seconds ----------
  const countCache = new Map(); // host -> {c, t}
  async function prep(emails, viewer) {
    emails = [...new Set((emails || []).map(lc).filter(Boolean))];
    await users.warm(emails);
    const now = Date.now(), counts = new Map(), mine = new Set();
    const stale = emails.filter((e) => { const c = countCache.get(e); if (c && now - c.t < 30000) { counts.set(e, c.c); return false; } return true; });
    if (stale.length) {
      const rows = await db.all("SELECT host_id AS id, COUNT(*) AS c FROM follows WHERE host_id IN (" + ph(stale) + ") GROUP BY host_id", stale);
      const got = new Map(rows.map((r) => [r.id, Number(r.c)]));
      for (const e of stale) { const c = got.get(e) || 0; counts.set(e, c); countCache.set(e, { c, t: now }); }
      if (countCache.size > 50000) countCache.clear();
    }
    if (viewer && emails.length) {
      const rows = await db.all("SELECT host_id AS id FROM follows WHERE follower_id = ? AND host_id IN (" + ph(emails) + ")", [viewer, ...emails]);
      rows.forEach((r) => mine.add(r.id));
    }
    return { counts, mine };
  }
  function card(email, viewer, p) {
    email = lc(email);
    const room = roomOfHost(email);
    return {
      handle: publicHandle(email), displayName: displayNameOf(email), avatar: avatarUrl(email),
      isLive: !!room, roomId: room ? room.roomId : null, title: room ? room.title : null,
      viewers: room ? countViewers(room.roomId) : 0,
      followers: p.counts.get(email) || 0,
      isFollowing: viewer ? p.mine.has(email) : false
    };
  }
  function roomCard(room, viewer, p) {
    const host = lc(room.hostId);
    room.viewers = countViewers(room.roomId);
    const t = thumbs.get(room.roomId);
    return {
      roomId: room.roomId, title: room.title, category: room.category, liveType: room.liveType,
      viewers: room.viewers, gifts: room.gifts, pkActive: !!room.pkActive, createdAt: room.createdAt,
      handle: publicHandle(host), displayName: displayNameOf(host), avatar: avatarUrl(host),
      description: room.description || "", views: (uniq.get(room.roomId) || new Set()).size,
      followers: p.counts.get(host) || 0,
      isFollowing: viewer ? p.mine.has(host) : false,
      thumb: t ? "/api/live/thumb/" + room.roomId + "?t=" + t.ts : null
    };
  }
  const cardsFor = async (emails, viewer) => { const p = await prep(emails, viewer); return emails.map((e) => card(e, viewer, p)); };

  // ---------- discovery (real live list) ----------
  async function roomCards(rooms, me) {
    const p = await prep(rooms.map((r) => r.hostId), me);
    return rooms.map((r) => roomCard(r, me, p));
  }
  app.get("/api/live/discover", async (req, res) => {
    const me = getAuthEmail(req);
    const cat = lc(req.query.category), search = lc(req.query.q);
    let rooms = await roomCards(Array.from(liveRooms.values()), me);
    if (cat && cat !== "all") rooms = rooms.filter((r) => lc(r.category) === cat);
    if (search) rooms = rooms.filter((r) => lc(r.title).includes(search) || lc(r.displayName).includes(search) || lc(r.handle).includes(search));
    if (req.query.following === "1" && me) rooms = rooms.filter((r) => r.isFollowing);
    rooms.sort((a, b) => (b.viewers + b.gifts * 5) - (a.viewers + a.gifts * 5));
    ok(res, { category: req.query.category || "All", rooms: rooms.slice(0, 200) });
  });
  app.get("/api/live/categories", (req, res) => ok(res, { categories: ["Trending", "Popular", "Music", "Dance", "Gaming", "Chat", "Entertainment", "Education", "Comedy", "Sports", "Audio", "Multi-Guest", "PK", "New Hosts"] }));
  app.get("/api/live/trending", async (req, res) => {
    const me = getAuthEmail(req);
    const rooms = (await roomCards(Array.from(liveRooms.values()), me)).sort((a, b) => (b.viewers + b.gifts * 100) - (a.viewers + a.gifts * 100));
    ok(res, { trending: rooms.slice(0, 50) });
  });

  const levelOf = (pts) => { let l = 1; FAN_LEVELS.forEach((t, i) => { if (pts >= t) l = i + 1; }); return l; };
  // one room: used by the live page
  app.get("/api/live/info/:roomId", async (req, res) => {
    const room = liveRooms.get(req.params.roomId);
    if (!room) return fail(res, 404, "This live has ended.");
    const me = getAuthEmail(req), host = lc(room.hostId);
    const [p, fan, members] = await Promise.all([
      prep([host], me),
      me ? db.get("SELECT points FROM fan_members WHERE host_id = ? AND user_id = ?", [host, me]) : null,
      db.get("SELECT COUNT(*) AS c FROM fan_members WHERE host_id = ?", [host])
    ]);
    ok(res, {
      room: roomCard(room, me, p), isOwner: me === host, loggedIn: !!me,
      fanClub: { cost: FAN_CLUB_COST, members: Number(members.c), joined: !!fan, level: fan ? levelOf(Number(fan.points)) : 0 },
      battle: battleOfHost(host)
    });
  });
  // viewers ping this every few seconds: real viewer counts + gift / PK events in one call (no database work on the hot path)
  app.get("/api/live/events/:roomId", async (req, res) => {
    const room = liveRooms.get(req.params.roomId);
    if (!room) return ok(res, { ended: true, events: [], viewers: 0 });
    const key = getAuthEmail(req) || ("g" + String(req.query.k || "").replace(/[^a-z0-9]/gi, "").slice(0, 24));
    if (key.length > 1 && key !== lc(room.hostId)) {
      if (!viewers.has(room.roomId)) viewers.set(room.roomId, new Map());
      viewers.get(room.roomId).set(key, Date.now());
      if (!uniq.has(room.roomId)) uniq.set(room.roomId, new Set());
      uniq.get(room.roomId).add(key);
    }
    if (room.lovesAt === undefined || Date.now() - room.lovesAt > 5000) {
      room.lovesAt = Date.now();
      room.lovesN = (await getHostStats(room.hostId)).loves;
    }
    const since = Number(req.query.since) || 0;
    ok(res, {
      viewers: countViewers(room.roomId), views: (uniq.get(room.roomId) || new Set()).size, loves: room.lovesN,
      now: Date.now(),
      events: (events.get(room.roomId) || []).filter((e) => e.id > since),
      battle: battleOfHost(lc(room.hostId))
    });
  });
  // host's browser uploads a still frame of the camera -> real live preview on the cards
  app.post("/api/live/:roomId/thumbnail", requireAuth, oneJson("250kb"), (req, res) => {
    const room = liveRooms.get(req.params.roomId);
    if (!room || lc(room.hostId) !== req.userEmail) return fail(res, 403, "Not your live.");
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ""));
    if (!m || m[1].length > 140000) return fail(res, 400, "Bad image.");
    thumbs.set(room.roomId, { buf: Buffer.from(m[1], "base64"), ts: Date.now() });
    room.lastBeat = Date.now();
    ok(res, {});
  });
  app.get("/api/live/thumb/:roomId", (req, res) => {
    const t = thumbs.get(req.params.roomId);
    if (!t) return res.sendStatus(404);
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=10" }).send(t.buf);
  });

  // ---------- follow system ----------
  const targetOf = (req) => resolveHandle(req.body && req.body.hostId);
  app.post("/api/follow", requireAuth, async (req, res) => {
    const host = await targetOf(req);
    if (!host) return fail(res, 404, "Host not found.");
    if (host === req.userEmail) return fail(res, 400, "You cannot follow yourself.");
    const r = await db.run("INSERT OR IGNORE INTO follows (follower_id, host_id) VALUES (?, ?)", [req.userEmail, host]);
    countCache.delete(host);
    await users.warm([req.userEmail]);
    const fcount = (await prep([host])).counts.get(host) || 0;
    if (r.changes) {
      notify(host, displayNameOf(req.userEmail) + " started following you", "followers.html");
      // if the host is live right now, show "X started following you" on their live screen
      const liveRoom = roomOfHost(host);
      if (liveRoom) pushEvent(liveRoom.roomId, { type: "follow", from: displayNameOf(req.userEmail), avatar: avatarUrl(req.userEmail), followers: fcount });
    }
    ok(res, { following: true, followers: fcount });
  });
  app.post("/api/unfollow", requireAuth, async (req, res) => {
    const host = await targetOf(req);
    if (!host) return fail(res, 404, "Host not found.");
    await db.run("DELETE FROM follows WHERE follower_id = ? AND host_id = ?", [req.userEmail, host]);
    countCache.delete(host);
    ok(res, { following: false, followers: (await prep([host])).counts.get(host) || 0 });
  });
  // :id is a handle, or "me"
  function listFor(kind) {
    return async (req, res) => {
      const me = getAuthEmail(req);
      const raw = req.params.userId || req.params.hostId;
      const target = raw === "me" ? me : await resolveHandle(raw);
      if (!target) return fail(res, me ? 404 : 401, me ? "User not found." : "Please sign in.");
      const rows = await db.all(
        kind === "followers"
          ? "SELECT follower_id AS id FROM follows WHERE host_id = ? ORDER BY created_at DESC LIMIT 500"
          : "SELECT host_id AS id FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 500", [target]);
      const ids = rows.map((r) => r.id);
      const p = await prep([target, ...ids], me);
      const list = ids.map((e) => card(e, me, p)).sort((a, b) => Number(b.isLive) - Number(a.isLive));
      const fg = await db.get("SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?", [target]);
      ok(res, { owner: { ...card(target, me, p), following: Number(fg.c) }, count: list.length, [kind]: list });
    };
  }
  app.get("/api/followers/:hostId", listFor("followers"));
  app.get("/api/following/:userId", listFor("following"));

  // ---------- fan club (paid through the ledger: coins out, stars in, all-or-nothing) ----------
  app.post("/api/fanclub/join", requireAuth, async (req, res) => {
    const host = await targetOf(req);
    if (!host) return fail(res, 404, "Host not found.");
    if (host === req.userEmail) return fail(res, 400, "You cannot join your own fan club.");
    await users.warm([req.userEmail, host]);
    const r = await ledger.joinFanClub({ user: req.userEmail, host, cost: FAN_CLUB_COST, userName: displayNameOf(req.userEmail), hostName: displayNameOf(host) });
    if (!r.ok && r.reason === "already") return fail(res, 409, "You are already in this fan club.");
    if (!r.ok) return fail(res, 400, "You need " + FAN_CLUB_COST + " coins to join. Please buy more coins.");
    notify(host, displayNameOf(req.userEmail) + " joined your fan club", "fan-club.html?host=" + publicHandle(host));
    ok(res, { joined: true, coins: r.balance });
  });
  app.get("/api/fanclub/:hostId", async (req, res) => {
    const me = getAuthEmail(req);
    const host = req.params.hostId === "me" ? me : await resolveHandle(req.params.hostId);
    if (!host) return fail(res, 404, "Host not found.");
    const rows = await db.all('SELECT user_id AS id, points, joined_at AS "joinedAt" FROM fan_members WHERE host_id = ? ORDER BY points DESC LIMIT 200', [host]);
    const p = await prep([host, ...rows.map((r) => r.id)], me);
    const members = rows.map((m) => ({ handle: publicHandle(m.id), displayName: displayNameOf(m.id), avatar: avatarUrl(m.id), points: Number(m.points), level: levelOf(Number(m.points)), joinedAt: m.joinedAt, isMe: m.id === me }));
    ok(res, { host: card(host, me, p), cost: FAN_CLUB_COST, levels: FAN_LEVELS, memberCount: members.length, joined: members.some((m) => m.isMe), members });
  });

  // ---------- gifts catalog ----------
  app.get("/api/gifts/catalog", (req, res) => ok(res, { gifts: Object.entries(giftPrices).map(([name, price]) => ({ name, price })) }));

  // ---------- PK battles ----------
  // Saved in PostgreSQL; active ones are also kept in memory so the scoreboard that every viewer polls costs no database work.
  const invites = new Map();        // id -> {id, from, to, duration, expires}
  const activeBattles = new Map();  // battleId -> row (+ names snapshot)
  async function withNames(b) {
    await users.warm([b.host_a, b.host_b]);
    b.names = {};
    for (const h of [b.host_a, b.host_b]) b.names[h] = { handle: publicHandle(h), displayName: displayNameOf(h), avatar: avatarUrl(h) };
    return b;
  }
  function view(b) {
    const side = (h, score) => {
      const r = roomOfHost(h), n = (b.names && b.names[h]) || { handle: publicHandle(h), displayName: displayNameOf(h), avatar: avatarUrl(h) };
      return { ...n, roomId: r ? r.roomId : null, score: Number(score) };
    };
    return {
      battleId: b.id, status: b.status, a: side(b.host_a, b.score_a), b: side(b.host_b, b.score_b),
      endsAt: Number(b.ends_at), remainingSeconds: Math.max(0, Math.ceil((Number(b.ends_at) - Date.now()) / 1000)),
      winner: b.winner ? (b.winner === "draw" ? "draw" : publicHandle(b.winner)) : null
    };
  }
  function battleOfHost(h) {
    let best = null;
    for (const b of activeBattles.values()) if ((b.host_a === h || b.host_b === h) && (!best || b.started_at > best.started_at)) best = b;
    return best ? view(best) : null;
  }
  // Only one server copy can finish a battle (the UPDATE succeeds once), so winners are announced once.
  async function settle(b) {
    const winner = Number(b.score_a) > Number(b.score_b) ? b.host_a : Number(b.score_b) > Number(b.score_a) ? b.host_b : "draw";
    const done = await db.get("UPDATE pk_battles SET status = 'finished', winner = ?, score_a = ?, score_b = ? WHERE id = ? AND status = 'active' RETURNING id", [winner, b.score_a, b.score_b, b.id]);
    activeBattles.delete(b.id);
    for (const h of [b.host_a, b.host_b]) { const r = roomOfHost(h); if (r) r.pkActive = false; }
    if (!done) return null;
    const ev = { type: "pk_end", winner: winner === "draw" ? "draw" : publicHandle(winner), scoreA: Number(b.score_a), scoreB: Number(b.score_b) };
    const ra = roomOfHost(b.host_a), rb = roomOfHost(b.host_b);
    if (ra) pushEvent(ra.roomId, ev); if (rb) pushEvent(rb.roomId, ev);
    if (winner !== "draw") notify(winner, "You won your PK battle! " + b.score_a + " vs " + b.score_b, null);
    return winner;
  }
  async function settleDue() {
    for (const b of Array.from(activeBattles.values())) if (Number(b.ends_at) <= Date.now()) await settle(b);
  }
  app.get("/api/pk/find-opponent", requireAuth, async (req, res) => {
    const rooms = Array.from(liveRooms.values()).filter((r) => lc(r.hostId) !== req.userEmail && !r.pkActive).slice(0, 30);
    const p = await prep(rooms.map((r) => r.hostId));
    ok(res, { opponents: rooms.map((r) => ({ handle: publicHandle(r.hostId), displayName: displayNameOf(r.hostId), avatar: avatarUrl(r.hostId), title: r.title, viewers: countViewers(r.roomId), followers: p.counts.get(lc(r.hostId)) || 0 })) });
  });
  app.post("/api/pk/invite", requireAuth, async (req, res) => {
    const me = roomOfHost(req.userEmail), to = await resolveHandle(req.body && req.body.hostId);
    const dur = PK_DURATIONS.includes(Number((req.body || {}).duration)) ? Number(req.body.duration) : 300;
    if (!me) return fail(res, 400, "Start your live first, then challenge someone.");
    if (me.pkActive) return fail(res, 400, "You are already in a PK battle.");
    const other = to && roomOfHost(to);
    if (!other || to === req.userEmail) return fail(res, 404, "That host is not live right now.");
    if (other.pkActive) return fail(res, 400, "That host is already in a PK battle.");
    for (const i of invites.values()) if (i.from === req.userEmail && i.to === to && i.expires > Date.now()) return fail(res, 409, "Invite already sent.");
    const id = "INV-" + crypto.randomBytes(5).toString("hex");
    invites.set(id, { id, from: req.userEmail, to, duration: dur, expires: Date.now() + 60000 });
    await users.warm([req.userEmail]);
    notify(to, displayNameOf(req.userEmail) + " challenged you to a " + dur / 60 + " minute PK battle", "pk-battles.html");
    ok(res, { inviteId: id });
  });
  app.get("/api/pk/invites", requireAuth, async (req, res) => {
    const mine = [];
    for (const i of invites.values()) {
      if (i.expires < Date.now()) { invites.delete(i.id); continue; }
      if (i.to === req.userEmail) mine.push(i);
    }
    await users.warm(mine.map((i) => i.from));
    ok(res, { invites: mine.map((i) => ({ id: i.id, from: displayNameOf(i.from), handle: publicHandle(i.from), duration: i.duration, secondsLeft: Math.ceil((i.expires - Date.now()) / 1000) })) });
  });
  app.post("/api/pk/respond", requireAuth, async (req, res) => {
    const inv = invites.get(String((req.body || {}).inviteId));
    if (!inv || inv.to !== req.userEmail || inv.expires < Date.now()) return fail(res, 404, "This invite has expired.");
    invites.delete(inv.id);
    await users.warm([req.userEmail, inv.from]);
    if (!req.body.accept) { notify(inv.from, displayNameOf(req.userEmail) + " declined your PK challenge", null); return ok(res, { accepted: false }); }
    const ra = roomOfHost(inv.from), rb = roomOfHost(inv.to);
    if (!ra || !rb || ra.pkActive || rb.pkActive) return fail(res, 400, "One of the hosts is no longer available.");
    const id = "PK-" + Date.now() + "-" + Math.floor(Math.random() * 10000), now = Date.now();
    await db.run("INSERT INTO pk_battles (id, host_a, host_b, room_a, room_b, started_at, ends_at) VALUES (?,?,?,?,?,?,?)",
      [id, lc(inv.from), lc(inv.to), ra.roomId, rb.roomId, now, now + inv.duration * 1000]);
    const b = await withNames({ id, host_a: lc(inv.from), host_b: lc(inv.to), score_a: 0, score_b: 0, status: "active", winner: null, started_at: now, ends_at: now + inv.duration * 1000 });
    activeBattles.set(id, b);
    ra.pkActive = rb.pkActive = true;
    const ev = { type: "pk_start", battleId: id };
    pushEvent(ra.roomId, ev); pushEvent(rb.roomId, ev);
    notify(inv.from, displayNameOf(req.userEmail) + " accepted your PK challenge!", "Go-Live.html");
    ok(res, { accepted: true, battle: view(b) });
  });
  app.get("/api/pk/active", (req, res) => {
    const rows = Array.from(activeBattles.values()).sort((a, b) => b.started_at - a.started_at).slice(0, 50);
    ok(res, { battles: rows.map(view) });
  });
  app.get("/api/pk/leaderboard", async (req, res) => {
    const rows = await db.all(
      `SELECT h AS host, COUNT(*) AS played, SUM(CASE WHEN winner = h THEN 1 ELSE 0 END) AS wins FROM (
         SELECT host_a AS h, winner FROM pk_battles WHERE status = 'finished'
         UNION ALL SELECT host_b AS h, winner FROM pk_battles WHERE status = 'finished') x
       GROUP BY h ORDER BY wins DESC, played ASC LIMIT 50`);
    const p = await prep(rows.map((r) => r.host));
    ok(res, { ranking: rows.map((r) => ({ ...card(r.host, null, p), played: Number(r.played), wins: Number(r.wins) })) });
  });
  app.get("/api/pk/:battleId", async (req, res) => {
    const live = activeBattles.get(req.params.battleId);
    const b = live || await db.get("SELECT * FROM pk_battles WHERE id = ?", [req.params.battleId]);
    if (!b) return fail(res, 404, "PK battle not found.");
    if (!live) await users.warm([b.host_a, b.host_b]);
    const v = view(b);
    ok(res, { battle: v, remainingSeconds: v.remainingSeconds });
  });

  // ---------- called by server.js ----------
  // Every paid gift (the coins were already moved by the ledger): PK score, gift animation and counters for the room.
  async function onGift({ senderId, hostId, gift, price }) {
    const host = lc(hostId), sender = lc(senderId);
    const room = roomOfHost(host);
    if (room) { room.gifts = (room.gifts || 0) + 1; room.giftCoins = (room.giftCoins || 0) + price; }
    let b = null;
    for (const x of activeBattles.values()) if ((x.host_a === host || x.host_b === host) && Number(x.ends_at) > Date.now()) { b = x; break; }
    if (b) {
      const col = b.host_a === host ? "score_a" : "score_b";
      const r = await db.get("UPDATE pk_battles SET " + col + " = " + col + " + ? WHERE id = ? RETURNING score_a, score_b", [price, b.id]);
      if (r) { b.score_a = Number(r.score_a); b.score_b = Number(r.score_b); }
    }
    await users.warm([sender, host]);
    const ck = host + "|" + sender + "|" + gift, prev = combos.get(ck);
    const combo = prev && Date.now() - prev.t < 6000 ? prev.n + 1 : 1;
    combos.set(ck, { n: combo, t: Date.now() });
    const ev = { type: "gift", from: displayNameOf(sender), avatar: avatarUrl(sender), gift, price, combo };
    if (room) pushEvent(room.roomId, ev);
    if (b) { const other = roomOfHost(b.host_a === host ? b.host_b : b.host_a); if (other) pushEvent(other.roomId, { ...ev, toHost: displayNameOf(host) }); }
    return b ? view(b) : null;
  }
  const combos = new Map();    // host|sender|gift -> {n, t}   (for "x3" gift combos)
  const loveBuf = new Map();   // roomId -> Map(sender email -> taps this second)
  function onLove({ senderId, hostId }) {
    const room = roomOfHost(lc(hostId)); if (!room) return;
    const m = loveBuf.get(room.roomId) || new Map();
    m.set(lc(senderId), (m.get(lc(senderId)) || 0) + 1); loveBuf.set(room.roomId, m);
  }
  async function flushLove() {
    for (const [roomId, m] of Array.from(loveBuf)) {
      loveBuf.delete(roomId);
      const top = Array.from(m).sort((a, b) => b[1] - a[1]).slice(0, 4);
      await users.warm(top.map((x) => x[0]));
      pushEvent(roomId, { type: "love", total: Array.from(m.values()).reduce((a, b) => a + b, 0), items: top.map(([e, n]) => ({ from: displayNameOf(e), avatar: avatarUrl(e), n })) });
    }
    for (const [k, v] of combos) if (Date.now() - v.t > 12000) combos.delete(k);
  }
  async function onLiveStart(room) {
    room.lastBeat = Date.now();
    const host = lc(room.hostId);
    await users.warm([host]);
    // one statement notifies the host's most recent 5,000 followers, however many followers there are
    await db.run(
      "INSERT INTO notifications (user_id, text, link, created_at) SELECT follower_id, CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS BIGINT) FROM follows WHERE host_id = ? ORDER BY created_at DESC LIMIT 5000",
      [(displayNameOf(host) + " is live now: " + room.title).slice(0, 200), "live-feed.html?room=" + encodeURIComponent(room.roomId), Date.now(), host]).catch(() => {});
  }
  async function onLiveEnd(room) {
    const host = lc(room.hostId);
    for (const b of Array.from(activeBattles.values())) if (b.host_a === host || b.host_b === host) await settle(b);
    viewers.delete(room.roomId); thumbs.delete(room.roomId); events.delete(room.roomId); uniq.delete(room.roomId);
  }

  // ---------- notifications ----------
  app.get("/api/notifications", requireAuth, async (req, res) => {
    const rows = await db.all("SELECT id, text, link, read, created_at AS ts FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 40", [req.userEmail]);
    ok(res, { unread: rows.filter((r) => !r.read).length, notifications: rows.map((r) => ({ ...r, id: Number(r.id), ts: Number(r.ts) })) });
  });
  app.post("/api/notifications/read", requireAuth, async (req, res) => {
    await db.run("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0", [req.userEmail]);
    ok(res, {});
  });

  // ---------- search + reports ----------
  app.get("/api/search/hosts", async (req, res) => {
    const s = lc(req.query.q).trim(); if (s.length < 2) return ok(res, { results: [] });
    const me = getAuthEmail(req);
    const found = await users.search(s, 30);
    const p = await prep(found.map((u) => u.email), me);
    const out = found.map((u) => card(u.email, me, p));
    out.sort((a, b) => Number(b.isLive) - Number(a.isLive) || b.followers - a.followers);
    ok(res, { results: out });
  });
  app.post("/api/report", requireAuth, async (req, res) => {
    const room = liveRooms.get(String((req.body || {}).roomId));
    const reason = String((req.body || {}).reason || "").trim().slice(0, 300);
    if (!room || !reason) return fail(res, 400, "Choose a live and give a reason.");
    await db.run("INSERT INTO reports (reporter, room_id, host_id, reason, created_at) VALUES (?,?,?,?,?)", [req.userEmail, room.roomId, lc(room.hostId), reason, Date.now()]);
    ok(res, { message: "Thanks — our team will review this live." });
  });

  // ---------- self-service password reset ----------
  const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
  async function sendResetMail(email, link) {
    if (mailer.ready()) {
      // resend.emails.send({ from, to, subject, html }) — see mailer.js
      const r = await mailer.sendMail({
        to: email, subject: "Reset your VicoPay Live password",
        html: '<p>Click the button below to choose a new password. This link works for 30 minutes.</p><p><a href="' + link + '" style="background:#0787ed;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Reset password</a></p><p>If you did not ask for this, ignore this email.</p>'
      });
      if (r.error) throw new Error("Resend: " + r.error.message);
      return "email";
    }
    console.log("PASSWORD RESET LINK (no email provider configured) for " + email + ": " + link);
    return "console";
  }
  async function makeResetLink(email) {
    const token = crypto.randomBytes(32).toString("hex");
    await db.run("INSERT INTO password_resets (token_hash, email, expires_at) VALUES (?,?,?)", [sha(token), email, Date.now() + 30 * 60 * 1000]);
    return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "") + "/reset-password.html?token=" + token;
  }
  app.post("/api/auth/forgot", authRateLimit, async (req, res) => {
    const email = lc((req.body || {}).email).trim();
    let delivery = mailer.ready() ? "email" : "console";
    try { if (email && await users.exists(email) && !bannedUsers.has(email)) delivery = await sendResetMail(email, await makeResetLink(email)); }
    catch (e) { console.error("RESET MAIL ERROR:", e.message); }
    // same answer whether or not the account exists
    ok(res, { delivery, message: "If an account exists for that email, a reset link has been sent. It works for 30 minutes." });
  });
  // ---------- email (Resend): status, test, and RECEIVING ----------
  // Admin: is email set up?
  app.get("/api/admin/email/status", requireAdmin, async (req, res) => {
    ok(res, {
      canSend: mailer.ready(), from: mailer.mailFrom() || null,
      canReceive: !!(process.env.RESEND_WEBHOOK_SECRET && process.env.INBOX_FORWARD_TO && process.env.RESEND_API_KEY),
      forwardTo: process.env.INBOX_FORWARD_TO || null,
      webhookUrl: (process.env.APP_URL || "").replace(/\/$/, "") + "/api/resend/webhook"
    });
  });
  // Admin: send yourself a test email  { "to": "you@gmail.com" }
  app.post("/api/admin/email/test", requireAdmin, async (req, res) => {
    const to = String((req.body || {}).to || process.env.INBOX_FORWARD_TO || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail(res, 400, 'Send { "to": "your@email.com" }.');
    const r = await mailer.sendMail({
      to, subject: "VicoPay Live test email",
      html: "<p>Your VicoPay Live website can send email through Resend. ✅</p>"
    });
    if (r.error) return fail(res, 502, "Resend could not send: " + r.error.message);
    ok(res, { message: "Test email sent to " + to + ".", id: r.id });
  });
  // Resend calls this when someone emails your receiving address (event "email.received").
  // We check the signature, read the email, and forward it to INBOX_FORWARD_TO (a reply goes to the original sender).
  app.post("/api/resend/webhook", async (req, res) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return fail(res, 503, "RESEND_WEBHOOK_SECRET is not set.");
    if (!mailer.verifyWebhook(req.rawBody, req.headers, secret)) return fail(res, 400, "Invalid signature.");
    const event = req.body || {};
    if (event.type !== "email.received") return ok(res, { ignored: event.type || true });
    const forwardTo = String(process.env.INBOX_FORWARD_TO || "").trim();
    const meta = event.data || {};
    if (!forwardTo) { console.log("EMAIL RECEIVED from " + meta.from + " (set INBOX_FORWARD_TO to get it in your inbox)"); return ok(res, { stored: false }); }
    const own = (mailer.mailFrom().match(/[^<\s]+@[^>\s]+/) || [""])[0].toLowerCase();
    if (own && String(meta.from || "").toLowerCase() === own) return ok(res, { skipped: "own address" }); // never forward in a loop
    const got = await mailer.resend.emails.receiving.get(meta.email_id);
    if (got.error) { console.error("RESEND RECEIVE ERROR:", got.error.message); return fail(res, 502, "Could not read the email yet."); } // Resend will retry
    const m = got.data || {}, e = mailer.esc;
    const from = (m.headers && m.headers.from) || m.from || meta.from || "unknown sender";
    const head = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">' +
      "<b>From:</b> " + e(from) + "<br><b>To:</b> " + e((m.to || meta.to || []).join(", ")) + "<br><b>Subject:</b> " + e(m.subject || meta.subject || "") + "</div>";
    const body = m.html || ('<pre style="font-family:inherit;white-space:pre-wrap">' + e(m.text || "(no text)") + "</pre>");
    const replyTo = (String(from).match(/[^<\s]+@[^>\s]+/) || [""])[0] || meta.from;
    const sent = await mailer.sendMail({ to: forwardTo, subject: "[VicoPay inbox] " + (m.subject || meta.subject || "(no subject)"), html: head + body, replyTo });
    if (sent.error) { console.error("RESEND FORWARD ERROR:", sent.error.message); return fail(res, 502, "Could not forward the email yet."); }
    ok(res, { forwarded: true });
  });
  app.post("/api/auth/reset", authRateLimit, async (req, res) => {
    const token = String((req.body || {}).token || ""), password = String((req.body || {}).password || "");
    if (password.length < 8) return fail(res, 400, "Password must be at least 8 characters.");
    // claim the link first: it can only be used once, even if two requests arrive together
    const row = await db.get("UPDATE password_resets SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at >= ? RETURNING email", [sha(token), Date.now()]);
    if (!row || !(await users.exists(row.email))) return fail(res, 400, "This reset link is invalid or has expired. Please request a new one.");
    const { salt, hash } = await hashPassword(password);
    await users.setPassword(row.email, salt, hash);
    await db.run("UPDATE password_resets SET used = 1 WHERE email = ?", [row.email]);
    ok(res, { message: "Password updated. You can sign in now." });
  });

  // ---------- admin dashboard API (send x-admin-key) ----------
  function killRoom(room) {
    recordSessionEnd(room.hostId, room.roomId); onLiveEnd(room).catch(() => {}); liveRooms.delete(room.roomId);
    try {
      const { RoomServiceClient } = require("livekit-server-sdk");
      if (LIVEKIT_URL && LIVEKIT_API_KEY) new RoomServiceClient(LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), LIVEKIT_API_KEY, LIVEKIT_API_SECRET).deleteRoom(room.roomId).catch(() => {});
    } catch (e) { /* ignore */ }
  }
  const count = async (sql, params) => Number((await db.get(sql, params || [])).c);
  app.get("/api/admin/overview", requireAdmin, async (req, res) => {
    const g = await store.giftTotals();
    ok(res, {
      users: await users.count(), banned: bannedUsers.size, liveNow: liveRooms.size,
      viewersNow: Array.from(liveRooms.keys()).reduce((n, id) => n + countViewers(id), 0),
      activePK: activeBattles.size,
      follows: await count("SELECT COUNT(*) AS c FROM follows"), fanMembers: await count("SELECT COUNT(*) AS c FROM fan_members"),
      giftCoinsTotal: g.coins, giftsTotal: g.count, withdrawalRequests: await store.withdrawalCount(),
      openReports: await count("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'"),
      ledger: ledger.lastAudit()
    });
  });
  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    const list = await users.list(lc(req.query.q).trim(), 200);
    const emails = list.map((u) => u.email);
    const p = await prep(emails);
    const bal = new Map();
    if (emails.length) (await db.all("SELECT user_id AS id, coins FROM balances WHERE user_id IN (" + ph(emails) + ")", emails)).forEach((r) => bal.set(r.id, Number(r.coins)));
    ok(res, { users: list.map((u) => ({ email: u.email, username: u.username, displayName: u.displayName, createdAt: u.createdAt, banned: bannedUsers.has(u.email), coins: bal.get(u.email) || 0, followers: p.counts.get(u.email) || 0, live: !!roomOfHost(u.email) })) });
  });
  app.post("/api/admin/users/ban", requireAdmin, async (req, res) => {
    const email = lc((req.body || {}).email), ban = !!(req.body || {}).banned;
    if (!(await users.exists(email))) return fail(res, 404, "User not found.");
    await store.setBan(email, ban, (req.body || {}).reason);
    if (ban) { const r = roomOfHost(email); if (r) killRoom(r); }
    ok(res, { email, banned: ban });
  });
  app.post("/api/admin/users/reset-link", requireAdmin, async (req, res) => {
    const email = lc((req.body || {}).email);
    if (!(await users.exists(email))) return fail(res, 404, "User not found.");
    ok(res, { link: await makeResetLink(email) });
  });
  app.get("/api/admin/lives", requireAdmin, async (req, res) => {
    const rooms = Array.from(liveRooms.values());
    const cards = await roomCards(rooms, null);
    ok(res, { lives: cards.map((c, i) => ({ ...c, email: rooms[i].hostId })) });
  });
  app.post("/api/admin/lives/end", requireAdmin, (req, res) => {
    const room = liveRooms.get(String((req.body || {}).roomId));
    if (!room) return fail(res, 404, "Live not found.");
    killRoom(room); ok(res, {});
  });
  app.get("/api/admin/reports", requireAdmin, async (req, res) => {
    const rows = await db.all('SELECT id, reporter, room_id AS "roomId", host_id AS "hostId", reason, status, created_at AS ts FROM reports ORDER BY id DESC LIMIT 200');
    ok(res, { reports: rows.map((r) => ({ ...r, id: Number(r.id), ts: Number(r.ts) })) });
  });
  app.post("/api/admin/reports/resolve", requireAdmin, async (req, res) => {
    await db.run("UPDATE reports SET status = 'resolved' WHERE id = ?", [Number((req.body || {}).id)]); ok(res, {});
  });

  // ---------- profile pictures + bio ----------
  function imageType(b) {
    if (b.length > 12 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
    if (b.length > 12 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return "image/png";
    if (b.length > 12 && b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return "image/webp";
    return null;
  }
  const bioOf = async (e) => { const r = await db.get("SELECT bio FROM profiles WHERE email = ?", [e]); return r && r.bio ? r.bio : ""; };
  app.post("/api/profile/avatar", requireAuth, oneJson("400kb"), async (req, res) => {
    const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ""));
    if (!m) return fail(res, 400, "Please choose a JPG, PNG or WebP picture.");
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > 250 * 1024) return fail(res, 400, "That picture is too large.");
    const mime = imageType(buf);
    if (!mime) return fail(res, 400, "That file is not a valid picture.");
    const ts = Date.now();
    await db.run("INSERT INTO avatars (email, mime, data, updated_at) VALUES (?,?,?,?) ON CONFLICT (email) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at", [req.userEmail, mime, buf, ts]);
    await users.get(req.userEmail); users.setAvatarVersion(req.userEmail, ts);
    ok(res, { avatar: avatarUrl(req.userEmail) });
  });
  app.post("/api/profile/avatar/remove", requireAuth, async (req, res) => {
    await db.run("DELETE FROM avatars WHERE email = ?", [req.userEmail]); users.setAvatarVersion(req.userEmail, null); ok(res, {});
  });
  app.get("/api/avatar/:handle", async (req, res) => {
    const e = await resolveHandle(req.params.handle);
    const row = e && await db.get("SELECT mime, data FROM avatars WHERE email = ?", [e]);
    if (!row) return res.sendStatus(404);
    res.set({ "Content-Type": row.mime, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).send(Buffer.from(row.data));
  });
  app.get("/api/me", requireAuth, async (req, res) => {
    await users.warm([req.userEmail]);
    ok(res, { handle: publicHandle(req.userEmail), displayName: displayNameOf(req.userEmail), avatar: avatarUrl(req.userEmail), bio: await bioOf(req.userEmail), email: req.userEmail });
  });
  app.post("/api/profile/update", requireAuth, async (req, res) => {
    const b = req.body || {};
    if (typeof b.displayName === "string") {
      const name = b.displayName.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 30);
      if (name.length < 2) return fail(res, 400, "Name must be at least 2 characters.");
      await users.setDisplayName(req.userEmail, name);
    }
    if (typeof b.bio === "string") {
      await db.run("INSERT INTO profiles (email, bio, updated_at) VALUES (?,?,?) ON CONFLICT (email) DO UPDATE SET bio = EXCLUDED.bio, updated_at = EXCLUDED.updated_at",
        [req.userEmail, b.bio.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 160), Date.now()]);
    }
    await users.warm([req.userEmail]);
    ok(res, { displayName: displayNameOf(req.userEmail), bio: await bioOf(req.userEmail) });
  });
  app.get("/api/profile/:handle", async (req, res) => {
    const me = getAuthEmail(req);
    const e = req.params.handle === "me" ? me : await resolveHandle(req.params.handle);
    if (!e) return fail(res, me || req.params.handle !== "me" ? 404 : 401, "Profile not found.");
    const stats = await getHostStats(e), u = await users.get(e);
    const pk = await db.get("SELECT COUNT(*) AS played, COALESCE(SUM(CASE WHEN winner = ? THEN 1 ELSE 0 END), 0) AS wins FROM pk_battles WHERE status = 'finished' AND (host_a = ? OR host_b = ?)", [e, e, e]);
    const p = await prep([e], me);
    const following = await count("SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?", [e]);
    const fans = await count("SELECT COUNT(*) AS c FROM fan_members WHERE host_id = ?", [e]);
    ok(res, {
      profile: {
        ...card(e, me, p), following, bio: await bioOf(e), likes: stats.loves, giftsReceived: stats.gifts,
        fanMembers: fans, pk: { played: Number(pk.played), wins: Number(pk.wins) }, joinedAt: (u && u.createdAt) || null, isMe: e === me
      }
    });
  });

  // ---------- host heartbeat: a closed tab can never leave a ghost live (or free live-hours) behind ----------
  app.post("/api/live/:roomId/heartbeat", requireAuth, async (req, res) => {
    const room = liveRooms.get(req.params.roomId);
    if (!room || lc(room.hostId) !== req.userEmail) return fail(res, 404, "Your live is not running.");
    room.lastBeat = Date.now();
    store.sessionBeat(room.roomId).catch(() => {});
    ok(res, { viewers: countViewers(room.roomId), views: (uniq.get(room.roomId) || new Set()).size });
  });

  // ---------- host earnings view ----------
  app.get("/api/creator/star-status", requireAuth, async (req, res) => ok(res, { ...(await getStarBreakdown(req.userEmail)) }));
  app.get("/api/host/recent-gifts", requireAuth, async (req, res) => {
    const rows = await store.recentGiftsTo(req.userEmail, 40);
    await users.warm(rows.map((r) => r.senderId));
    ok(res, { gifts: rows.map((t) => ({ from: displayNameOf(t.senderId), handle: publicHandle(t.senderId), avatar: avatarUrl(t.senderId), gift: t.gift, coin: Number(t.coin), ts: new Date(t.createdAt).getTime() })) });
  });
  // coin statement of the signed-in user (also at /api/wallet/:id/statement)
  app.get("/api/me/statement", requireAuth, async (req, res) => {
    const entries = (await ledger.statement(req.userEmail, req.query.limit)).filter((r) => r.currency === "coin");
    ok(res, { balance: await ledger.getBalance(req.userEmail), entries: entries.map((e) => ({ ...e, id: Number(e.id), delta: Number(e.delta), balanceAfter: e.balanceAfter === null ? null : Number(e.balanceAfter), createdAt: Number(e.createdAt) })) });
  });

  // ---------- admin: withdrawal risk report ----------
  app.get("/api/admin/risk/:email", requireAdmin, async (req, res) => {
    const host = lc(req.params.email), b = await getStarBreakdown(host);
    const by = await db.all("SELECT sender_id AS e, SUM(coin) AS coins FROM gift_transactions WHERE host_id = ? GROUP BY sender_id HAVING SUM(coin) > 0 ORDER BY SUM(coin) DESC LIMIT 15", [host]);
    const userRow = async (e) => (await db.get("SELECT signup_ip, last_ip, created_at FROM users WHERE email = ?", [e])) || {};
    const h = await userRow(host);
    const senders = [];
    for (const r of by) {
      const u = await userRow(r.e);
      const bought = await db.get("SELECT COALESCE(SUM(coins), 0) AS c FROM payments WHERE email = ? AND status = 'ok'", [r.e]);
      const rev = await db.get("SELECT COUNT(*) AS c FROM payments WHERE email = ? AND status = 'reversed'", [r.e]);
      senders.push({
        email: r.e, coins: Number(r.coins), coinsBought: Number(bought.c), reversedPayments: Number(rev.c),
        accountAgeDays: u.created_at ? Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000) : null,
        sameNetwork: !!h.last_ip && (u.last_ip === h.last_ip || (!!h.signup_ip && u.signup_ip === h.signup_ip))
      });
    }
    const flags = [];
    if (b.circular > 0) flags.push(b.circular + " stars are round-trip gifts (excluded automatically).");
    if (senders.length && b.total > 0 && senders.slice(0, 2).reduce((n, x) => n + x.coins, 0) / b.total > 0.6) flags.push("More than 60% of the stars come from one or two accounts.");
    if (senders.some((x) => x.sameNetwork)) flags.push("Some gifters use the same network as this host. Could be family or shared Wi-Fi; check before paying.");
    if (senders.some((x) => x.accountAgeDays !== null && x.accountAgeDays < 2)) flags.push("Some gifters have accounts less than 2 days old.");
    if (senders.some((x) => x.reversedPayments > 0)) flags.push("A gifter has had a payment reversed.");
    if (senders.some((x) => x.coinsBought === 0)) flags.push("Some gifters have no recorded coin purchases (older balances or free coins).");
    ok(res, { host, breakdown: b, senders, flags, verdict: flags.length >= 3 ? "HIGH RISK: review before paying" : flags.length ? "Check the flags" : "Looks normal" });
  });

  // ---------- background jobs (called once the database is ready) ----------
  async function start() {
    // A restart drops every live room, so battles that were running are finished on the spot (winner by current score).
    for (const b of await db.all("SELECT * FROM pk_battles WHERE status = 'active'")) { await withNames(b); activeBattles.set(b.id, b); await settle(b); }
    setInterval(() => flushLove().catch((e) => console.error("LOVE FLUSH ERROR:", e.message)), 1000).unref();
    setInterval(() => settleDue().catch((e) => console.error("PK TIMER ERROR:", e.message)), 2000).unref();
    setInterval(() => {
      for (const room of Array.from(liveRooms.values())) {
        if (Date.now() - (room.lastBeat || 0) > 90000) {
          console.log("Ending abandoned live " + room.roomId + " (host stopped responding)");
          recordSessionEnd(room.hostId, room.roomId); onLiveEnd(room).catch(() => {}); liveRooms.delete(room.roomId);
        }
      }
    }, 15000).unref();
  }

  return { onGift, onLove, onLiveStart, onLiveEnd, start };
};
