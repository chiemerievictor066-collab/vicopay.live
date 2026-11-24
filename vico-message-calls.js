// =====================================================
// Vico Message — voice and video calls between two people (WhatsApp style)
// =====================================================
// The server only does the "phone" part: ringing, answering, declining, missed calls, busy, the call log and a LiveKit token.
// The audio/video itself flows through the SAME LiveKit account as Go Live (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).
// Every call is its own private LiveKit room (vmcall_<id>); a token is only ever issued to the two people on that call.
//
//   ringing --accept--> active --end--> ended
//      |--decline--> declined      |--cancel (caller hangs up first)--> cancelled      |--45 s unanswered--> missed
//
// New table: vm_calls. Called from vico-messages.js (which owns the shared schema, the realtime hub and the chat log).
const crypto = require("crypto");

const RING_MS = 45 * 1000;          // how long a phone rings
const STALE_RING_MS = 70 * 1000;    // a "ringing" row older than this was never answered (server restarted)
const MAX_CALL_MS = 6 * 60 * 60 * 1000;

module.exports = function makeMessageCalls({ app, db, requireAuth, requireActivated, store, hub, isBlocked, logCall, callAccess, env, wallet }) {
  env = env || process.env;
  const lc = (v) => String(v || "").trim().toLowerCase();
  const now = () => Date.now();
  const bad = (res, code, message, extra) => res.status(code).json({ success: false, message, ...(extra || {}) });
  const who = (email) => ({ handle: store.publicHandle(email), displayName: store.displayNameOf(email), avatar: store.avatarUrl(email) });
  const lkReady = () => !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  const kindOf = (k) => (k === "video" ? "video" : "voice");

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS vm_calls (id TEXT PRIMARY KEY, caller TEXT NOT NULL, callee TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, room TEXT NOT NULL, created_at BIGINT NOT NULL, answered_at BIGINT, ended_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_vm_calls_caller ON vm_calls(caller, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_vm_calls_callee ON vm_calls(callee, created_at DESC)`
  ];

  const timers = new Map();   // callId -> ring timeout
  const clearTimer = (id) => { const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); } };

  // Move a call that is still ringing/active to its final state exactly once, write it into the chat, tell both phones.
  async function finish(call, status, only, extra) {
    const t = now();
    const r = await db.run(
      "UPDATE vm_calls SET status = ?, ended_at = ? WHERE id = ? AND status IN (" + (only || "'ringing','active'") + ")", [status, t, call.id]);
    if (!r.changes) return false;
    clearTimer(call.id);
    const duration = call.answered_at ? Math.max(0, Math.round((t - Number(call.answered_at)) / 1000)) : 0;
    // The caller sees "Cancelled"/"Declined"/"No answer"; the person called sees a plain "Missed call" if they never answered.
    await store.users.warm([call.caller, call.callee]);
    try { await logCall({ call, status, duration }); } catch (e) { console.error("VM CALL LOG:", e.message); }
    const payload = { callId: call.id, status, duration, kind: call.kind, ...(extra || {}) };
    hub.push(call.caller, "call_update", { ...payload, with: who(call.callee) });
    hub.push(call.callee, "call_update", { ...payload, with: who(call.caller) });
    return true;
  }

  async function sweep() {
    const t = now();
    const stale = await db.all("SELECT * FROM vm_calls WHERE (status = 'ringing' AND created_at < ?) OR (status = 'active' AND answered_at < ?) LIMIT 50", [t - STALE_RING_MS, t - MAX_CALL_MS]);
    for (const c of stale) await finish(c, c.status === "ringing" ? "missed" : "ended");
  }

  let started = null;
  const ready = (async () => {
    const c = await db.pool.connect();
    try { await c.query("SELECT pg_advisory_lock(727293)"); for (const q of SCHEMA) await c.query(q); }
    finally { try { await c.query("SELECT pg_advisory_unlock(727293)"); } catch (_) { /* ignore */ } c.release(); }
    await sweep();
    started = setInterval(() => sweep().catch(() => {}), 60 * 1000); if (started.unref) started.unref();
  })().catch((e) => { console.error("VICO MESSAGE CALLS MIGRATE ERROR:", e); });

  const resolve = async (handle) => { const e = await store.users.resolveHandle(String(handle || "").replace(/^@/, "")); return e ? lc(e) : null; };
  const own = async (id, me) => {
    const c = await db.get("SELECT * FROM vm_calls WHERE id = ? AND (caller = ? OR callee = ?)", [String(id || ""), me, me]);
    if (c && c.status === "ringing" && now() - Number(c.created_at) > STALE_RING_MS) { await finish(c, "missed"); return db.get("SELECT * FROM vm_calls WHERE id = ?", [c.id]); }
    return c;
  };
  const inCall = (email) => db.get("SELECT id FROM vm_calls WHERE (caller = ? OR callee = ?) AND ((status = 'ringing' AND created_at > ?) OR (status = 'active' AND answered_at > ?)) LIMIT 1", [email, email, now() - STALE_RING_MS, now() - MAX_CALL_MS]);

  // ---- paid calls: the CALLER pays RATES.callMinute naira for every minute that starts (so a 61 second call is 2 minutes) ----
  // Minute m is charged once, with the reference "callmin:<id>:<m>", so a restart, a double timer or a retry can never charge it twice.
  const billed = new Map();   // callId -> last minute already charged (a restart just re-checks, which is harmless)
  const low = new Set();      // calls already warned about a low balance
  const WALLET_URL = "wallet.html";
  async function billCall(call) {
    if (!wallet) return true;
    const due = Math.floor((now() - Number(call.answered_at)) / 60000) + 1;
    for (let m = (billed.get(call.id) || 0) + 1; m <= due; m++) {
      const ch = await wallet.charge({ email: call.caller, amount: wallet.RATES.callMinute, kind: "call", ref: "callmin:" + call.id + ":" + m, memo: (call.kind === "video" ? "Video call" : "Voice call") + " · minute " + m }, null);
      if (!ch.ok) {
        billed.delete(call.id); low.delete(call.id);
        await finish(call, "ended", "'active'", { reason: "balance", walletUrl: WALLET_URL });   // out of money: the call ends, the caller is sent to wallet.html
        return false;
      }
      billed.set(call.id, m);
      const minutesLeft = Math.floor(ch.balance / wallet.RATES.callMinute);
      if (minutesLeft <= 1 && !low.has(call.id)) { low.add(call.id); hub.push(call.caller, "call_balance", { callId: call.id, minutesLeft, balance: ch.balance, walletUrl: WALLET_URL }); }
    }
    return true;
  }
  async function billActive() {
    if (!wallet) return;
    const rows = await db.all("SELECT * FROM vm_calls WHERE status = 'active' AND answered_at IS NOT NULL LIMIT 200", []);
    const live = new Set(rows.map((r) => r.id));
    for (const k of billed.keys()) if (!live.has(k)) { billed.delete(k); low.delete(k); }
    for (const c of rows) { try { await billCall(c); } catch (e) { console.error("VM CALL BILL:", e.message); } }
  }
  if (wallet) { const bt = setInterval(() => billActive().catch(() => {}), 10 * 1000); if (bt.unref) bt.unref(); }

  // ---- start a call ----
  app.post("/api/vm/calls/start", requireAuth, requireActivated, async (req, res) => {
    try {
      await ready;
      const me = lc(req.userEmail), other = await resolve(req.body && req.body.handle), kind = kindOf(req.body && req.body.kind);
      if (!other) return bad(res, 404, "That user was not found.");
      if (other === me) return bad(res, 400, "You cannot call yourself.");
      if (!lkReady()) return bad(res, 503, "Calling is not switched on yet. The site owner needs to add the LiveKit settings.");
      if (await isBlocked(me, other)) return bad(res, 403, "This call cannot be placed.");
      if (wallet) {
        const have = await wallet.balanceOf(me), need = wallet.RATES.callMinute;
        if (have < need) return res.status(402).json({ success: false, insufficient: true, needed: need, balance: have, walletUrl: WALLET_URL,
          message: "Your VicoPay Wallet balance is too low to make a call (₦" + need + " per minute). Recharge your wallet to continue." });
      }
      const peer = await db.get("SELECT phone_verified_at FROM vm_profiles WHERE email = ? AND phone IS NOT NULL", [other]);
      await store.users.warm([me, other]);
      if (!peer) return bad(res, 409, store.displayNameOf(other) + " has not activated Vico Message yet, so they cannot receive calls. You can still send a message.", { notActivated: true });
      if (await inCall(me)) return bad(res, 409, "You are already on a call.");
      if (callAccess && env.VM_VIP_CALL_GATE !== "off") {
        let a = null; try { a = await callAccess(me, other); } catch (e) { console.error("VM VIP GATE:", e.message); }
        if (a && a.requiresPayment) return bad(res, 402, "Private calls with this VIP are paid. Join their live stream to request a call.", { vipGate: true });
      }
      const busy = await inCall(other);
      const id = crypto.randomUUID(), room = "vmcall_" + id, t = now();
      await db.run("INSERT INTO vm_calls(id, caller, callee, kind, status, room, created_at) VALUES(?,?,?,?,?,?,?)", [id, me, other, kind, busy ? "busy" : "ringing", room, t]);
      const call = { id, caller: me, callee: other, kind, room, created_at: t, answered_at: null };
      if (busy) {
        await db.run("UPDATE vm_calls SET ended_at = ? WHERE id = ?", [t, id]);
        try { await logCall({ call, status: "missed", duration: 0 }); } catch (_) { /* ignore */ }
        return res.status(409).json({ success: false, busy: true, message: store.displayNameOf(other) + " is on another call." });
      }
      const online = hub.push(other, "call_incoming", { callId: id, kind, from: who(me), expiresInMs: RING_MS });
      const tm = setTimeout(async () => { try { const c = await db.get("SELECT * FROM vm_calls WHERE id = ?", [id]); if (c && c.status === "ringing") await finish(c, "missed"); } catch (_) { /* ignore */ } }, RING_MS);
      if (tm.unref) tm.unref(); timers.set(id, tm);
      res.json({ success: true, callId: id, kind, with: who(other), calleeOnline: online, ringMs: RING_MS });
    } catch (e) { console.error("VM CALL START:", e); bad(res, 500, "Could not start the call."); }
  });

  // ---- answer / refuse / hang up ----
  app.post("/api/vm/calls/:id/accept", requireAuth, requireActivated, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail), c = await own(req.params.id, me);
      if (!c || c.callee !== me) return bad(res, 404, "Call not found.");
      const r = await db.run("UPDATE vm_calls SET status = 'active', answered_at = ? WHERE id = ? AND callee = ? AND status = 'ringing'", [now(), c.id, me]);
      if (!r.changes) return bad(res, 409, "This call is no longer ringing.");
      clearTimer(c.id);
      if (wallet) { const full = await db.get("SELECT * FROM vm_calls WHERE id = ?", [c.id]); if (!(await billCall(full))) return bad(res, 409, "This call could not connect."); }   // minute 1; no money left means the call ends
      await store.users.warm([c.caller, c.callee]);
      hub.push(c.caller, "call_update", { callId: c.id, status: "active", kind: c.kind, with: who(c.callee) });
      hub.push(c.callee, "call_update", { callId: c.id, status: "active", kind: c.kind, with: who(c.caller) });   // answered on another tab? the others stop ringing
      res.json({ success: true, callId: c.id, kind: c.kind, with: who(c.caller) });
    } catch (e) { console.error("VM CALL ACCEPT:", e); bad(res, 500, "Could not answer the call."); }
  });
  app.post("/api/vm/calls/:id/decline", requireAuth, async (req, res) => {
    try { await ready; const me = lc(req.userEmail), c = await own(req.params.id, me);
      if (!c || c.callee !== me) return bad(res, 404, "Call not found.");
      await finish(c, "declined", "'ringing'"); res.json({ success: true });
    } catch (e) { console.error("VM CALL DECLINE:", e); bad(res, 500, "Could not decline the call."); }
  });
  app.post("/api/vm/calls/:id/cancel", requireAuth, async (req, res) => {
    try { await ready; const me = lc(req.userEmail), c = await own(req.params.id, me);
      if (!c || c.caller !== me) return bad(res, 404, "Call not found.");
      await finish(c, "cancelled", "'ringing'"); res.json({ success: true });
    } catch (e) { console.error("VM CALL CANCEL:", e); bad(res, 500, "Could not cancel the call."); }
  });
  app.post("/api/vm/calls/:id/end", requireAuth, async (req, res) => {
    try { await ready; const me = lc(req.userEmail), c = await own(req.params.id, me);
      if (!c) return bad(res, 404, "Call not found.");
      // hanging up before the other person answered is a cancel, afterwards it is a normal end
      if (c.status === "ringing") { await finish(c, c.caller === me ? "cancelled" : "declined", "'ringing'"); }
      else await finish(c, "ended", "'active'");
      res.json({ success: true });
    } catch (e) { console.error("VM CALL END:", e); bad(res, 500, "Could not end the call."); }
  });

  // ---- state (used when the realtime stream is not connected) ----
  app.get("/api/vm/calls/incoming", requireAuth, async (req, res) => {
    try { await ready; const me = lc(req.userEmail);
      const rows = await db.all("SELECT id, caller, kind, created_at FROM vm_calls WHERE callee = ? AND status = 'ringing' AND created_at > ? ORDER BY created_at DESC LIMIT 3", [me, now() - RING_MS]);
      await store.users.warm(rows.map((r) => r.caller));
      res.json({ success: true, calls: rows.map((r) => ({ callId: r.id, kind: r.kind, from: who(r.caller), at: Number(r.created_at) })) });
    } catch (e) { console.error("VM CALL INCOMING:", e); bad(res, 500, "Could not check for calls."); }
  });
  app.get("/api/vm/calls/history", requireAuth, async (req, res) => {
    try { await ready; const me = lc(req.userEmail);
      const rows = await db.all("SELECT id, caller, callee, kind, status, created_at, answered_at, ended_at FROM vm_calls WHERE (caller = ? OR callee = ?) AND status NOT IN ('ringing') ORDER BY created_at DESC LIMIT 60", [me, me]);
      const others = rows.map((r) => (r.caller === me ? r.callee : r.caller)); await store.users.warm(others);
      res.json({ success: true, calls: rows.map((r) => { const out = r.caller === me, o = out ? r.callee : r.caller;
        return { callId: r.id, ...who(o), kind: r.kind, direction: out ? "out" : "in", status: r.status, at: Number(r.created_at),
          duration: r.answered_at && r.ended_at ? Math.max(0, Math.round((Number(r.ended_at) - Number(r.answered_at)) / 1000)) : 0 }; }) });
    } catch (e) { console.error("VM CALL HISTORY:", e); bad(res, 500, "Could not load your calls."); }
  });
  app.get("/api/vm/calls/:id", requireAuth, async (req, res) => {
    try { await ready; const me = lc(req.userEmail), c = await own(req.params.id, me);
      if (!c) return bad(res, 404, "Call not found.");
      await store.users.warm([c.caller, c.callee]);
      res.json({ success: true, callId: c.id, status: c.status, kind: c.kind, direction: c.caller === me ? "out" : "in", with: who(c.caller === me ? c.callee : c.caller) });
    } catch (e) { console.error("VM CALL STATE:", e); bad(res, 500, "Could not read the call."); }
  });

  // ---- LiveKit token: only the two people on the call, only while it can carry audio/video ----
  app.post("/api/vm/calls/:id/token", requireAuth, async (req, res) => {
    try {
      await ready; const me = lc(req.userEmail), c = await own(req.params.id, me);
      if (!c) return bad(res, 404, "Call not found.");
      const allowed = c.status === "active" || (c.status === "ringing" && c.caller === me);   // the caller connects first and waits for the answer
      if (!allowed) return bad(res, 409, "This call is not connected.");
      if (!lkReady()) return bad(res, 503, "Calling is not switched on yet.");
      const { AccessToken } = require("livekit-server-sdk");
      await store.users.warm([me]);
      const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: store.publicHandle(me), name: store.displayNameOf(me), ttl: "2h" });
      token.addGrant({ roomJoin: true, room: c.room, canPublish: true, canSubscribe: true, canPublishData: false });
      res.json({ success: true, url: env.LIVEKIT_URL, token: await token.toJwt(), kind: c.kind });
    } catch (e) { console.error("VM CALL TOKEN:", e); bad(res, 500, "Could not connect the call."); }
  });

  return { ready, finish, sweep, billActive, RING_MS };
};
