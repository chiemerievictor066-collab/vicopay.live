// VicoPay Live - quick self-check.
// 1) start the server in one terminal:   npm start
// 2) run this in another terminal:       npm run smoke
// It checks that sign-up/sign-in, wallet protection and creator pages respond
// correctly. It does NOT spend money or contact Paystack/LiveKit.
const BASE = process.env.BASE_URL || "http://localhost:" + (process.env.PORT || 3000);
let failed = 0;

function check(name, ok, extra) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok || !extra ? "" : "  -> " + extra));
  if (!ok) failed++;
}

async function call(path, options = {}) {
  const res = await fetch(BASE + path, options);
  let body = {};
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body };
}

(async () => {
  console.log("Testing " + BASE + "\n");
  const email = "smoke" + Date.now() + "@example.com";
  const json = { "Content-Type": "application/json" };

  const health = await call("/api/health");
  check("server is running", health.status === 200 && health.body.success);

  const reg = await call("/api/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email, password: "TestPass123" }) });
  check("can create an account", reg.status === 200 && !!reg.body.token, JSON.stringify(reg.body));
  const auth = { ...json, Authorization: "Bearer " + reg.body.token };

  const bad = await call("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ login: email, password: "wrong-password" }) });
  check("wrong password is rejected", bad.status === 401);

  const noAuth = await call("/api/wallet/" + encodeURIComponent(email));
  check("wallet is private when signed out", noAuth.status === 401);

  const wallet = await call("/api/wallet/" + encodeURIComponent(email), { headers: auth });
  check("signed-in user can see own wallet", wallet.status === 200 && wallet.body.success, JSON.stringify(wallet.body));

  const other = await call("/api/wallet/someone-else@example.com", { headers: auth });
  check("cannot read another person's wallet", other.status === 403);

  const status = await call("/api/creator/monthly-status", { headers: auth });
  check("creator status loads", status.status === 200 && status.body.success, JSON.stringify(status.body));
  check("new host is not eligible for withdrawal", status.body.eligible === false);

  const admin = await call("/api/admin/creator-withdrawals");
  check("admin pages are locked without the admin key", admin.status === 403);

  const hostToken = await call("/api/livekit/token", { method: "POST", headers: auth, body: JSON.stringify({ roomName: "ROOM-not-mine", identity: email, role: "host" }) });
  check("cannot broadcast in a room you do not own", hostToken.status === 403 || hostToken.status === 503, JSON.stringify(hostToken.body));

  const gift = await call("/api/gifts/send", { method: "POST", headers: auth, body: JSON.stringify({ gift: "Rose", hostId: "host@example.com" }) });
  check("gift with no coins is refused", gift.status === 400, JSON.stringify(gift.body));

  const rooms = await call("/api/live/discover");
  check("live discovery works", rooms.status === 200 && Array.isArray(rooms.body.rooms));

  const chatRoomId = "SMOKE-" + Date.now();
  const emptyHistory = await call("/api/live/chat/" + encodeURIComponent(chatRoomId));
  check("chat history starts empty for a new room", emptyHistory.status === 200 && Array.isArray(emptyHistory.body.messages) && emptyHistory.body.messages.length === 0, JSON.stringify(emptyHistory.body));

  const sentChat = await call("/api/live/chat/" + encodeURIComponent(chatRoomId), { method: "POST", headers: auth, body: JSON.stringify({ name: "Smoke Tester", isHost: false, text: "hello from the smoke test" }) });
  check("can save a chat message", sentChat.status === 200 && sentChat.body.success, JSON.stringify(sentChat.body));

  await new Promise(r => setTimeout(r, 1000)); // chat has a 0.8s anti-spam limit per user
  const forgedHost = await call("/api/live/chat/" + encodeURIComponent(chatRoomId), { method: "POST", headers: auth, body: JSON.stringify({ name: "Smoke Tester", isHost: true, text: "pretending to be the host" }) });
  const history = await call("/api/live/chat/" + encodeURIComponent(chatRoomId));
  const forgedMsg = history.body.messages && history.body.messages.find(m => m.text === "pretending to be the host");
  check("chat history now has 2 messages", history.status === 200 && history.body.messages.length === 2, JSON.stringify(history.body));
  check("cannot forge the HOST badge without owning that room", forgedHost.status === 200 && forgedMsg && forgedMsg.isHost === false, JSON.stringify(forgedMsg));

  const wrongCurrent = await call("/api/auth/change-password", { method: "POST", headers: auth, body: JSON.stringify({ currentPassword: "wrong-one", newPassword: "NewTestPass123" }) });
  check("wrong current password is rejected", wrongCurrent.status === 401, JSON.stringify(wrongCurrent.body));

  const changed = await call("/api/auth/change-password", { method: "POST", headers: auth, body: JSON.stringify({ currentPassword: "TestPass123", newPassword: "NewTestPass123" }) });
  check("can change password with correct current password", changed.status === 200 && changed.body.success, JSON.stringify(changed.body));

  const loginOldPassword = await call("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ login: email, password: "TestPass123" }) });
  check("old password no longer works after change", loginOldPassword.status === 401);

  const loginNewPassword = await call("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ login: email, password: "NewTestPass123" }) });
  check("new password works after change", loginNewPassword.status === 200 && !!loginNewPassword.body.token);

  const wrongDelete = await call("/api/auth/delete-account", { method: "POST", headers: auth, body: JSON.stringify({ password: "wrong-one" }) });
  check("wrong password blocks account deletion", wrongDelete.status === 401, JSON.stringify(wrongDelete.body));

  const deleted = await call("/api/auth/delete-account", { method: "POST", headers: auth, body: JSON.stringify({ password: "NewTestPass123" }) });
  check("can delete own account with correct password", deleted.status === 200 && deleted.body.success, JSON.stringify(deleted.body));

  const loginAfterDelete = await call("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ login: email, password: "NewTestPass123" }) });
  check("deleted account can no longer sign in", loginAfterDelete.status === 401);


  // ---------- v2 features: live room, follow, profile photo, fan club, PK, password reset, 404 ----------
  console.log("\nLive features:");
  const mk = async (tag) => {
    const e = "smoke" + tag + Date.now() + "@example.com";
    const r = await call("/api/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email: e, password: "TestPass123", username: "sm" + tag + String(Date.now()).slice(-6) }) });
    return { email: e, token: r.body.token, handle: r.body.user && r.body.user.username, h: { ...json, Authorization: "Bearer " + r.body.token } };
  };
  const A = await mk("a"), B = await mk("b");
  check("two test accounts created", !!A.token && !!B.token);
  const post = (u, path, body) => call(path, { method: "POST", headers: u.h, body: JSON.stringify(body || {}) });

  const nf = await fetch(BASE + "/no-such-page-" + Date.now() + ".html");
  check("unknown page shows the friendly 404 page", nf.status === 404 && /404/.test(await nf.text()));
  const nfApi = await call("/api/does-not-exist");
  check("unknown API route returns JSON 404", nfApi.status === 404 && nfApi.body.success === false);

  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
  const av = await post(A, "/api/profile/avatar", { image: JPEG });
  check("profile photo upload works", av.status === 200 && !!av.body.avatar, JSON.stringify(av.body));
  const avBad = await post(A, "/api/profile/avatar", { image: "data:image/jpeg;base64,AAAAAAAAAAAAAAAAAAAAAAAA" });
  check("fake image file is rejected", avBad.status === 400);
  const avGet = av.body.avatar ? await fetch(BASE + av.body.avatar) : { status: 0 };
  check("profile photo is served publicly", avGet.status === 200);

  const mine = await call("/api/live/discover");
  check("live room list responds", mine.status === 200 && Array.isArray(mine.body.rooms));
  check("live list never exposes email addresses", !/@/.test(JSON.stringify(mine.body)));

  const live = await post(A, "/api/live/create", { title: "Smoke test live", category: "Chat", liveType: "video" });
  check("host can start a live", live.status === 200 && live.body.success, JSON.stringify(live.body));
  const roomId = live.body.room && live.body.room.roomId;
  const list2 = await call("/api/live/discover");
  check("new live appears in the live room", (list2.body.rooms || []).some(r => r.roomId === roomId));
  const ev = await call("/api/live/events/" + roomId + "?k=smoke");
  check("viewer pulse works (viewers, loves, events)", ev.status === 200 && typeof ev.body.viewers === "number");

  check("cannot follow yourself", (await post(A, "/api/follow", { hostId: A.handle })).status === 400);
  check("can follow a host", (await post(B, "/api/follow", { hostId: A.handle })).body.following === true);
  const fl = await call("/api/followers/" + A.handle, { headers: B.h });
  check("followers list shows the new follower", fl.status === 200 && fl.body.count === 1);
  check("can unfollow", (await post(B, "/api/unfollow", { hostId: A.handle })).body.following === false);

  check("gift without coins is refused", !(await post(B, "/api/gifts/send", { gift: "Rose", hostId: A.handle })).body.success);
  check("cannot gift yourself", !(await post(A, "/api/gifts/send", { gift: "Rose", hostId: A.handle })).body.success);
  check("fan club needs coins", !(await post(B, "/api/fanclub/join", { hostId: A.handle })).body.success);
  const pkOpp = await call("/api/pk/find-opponent", { headers: A.h });
  check("PK opponent search works", pkOpp.status === 200 && Array.isArray(pkOpp.body.opponents));
  check("PK needs the other host to be live", !(await post(A, "/api/pk/invite", { hostId: B.handle, duration: 180 })).body.success);

  // hearts reach the host's screen with the sender's name (the heart route must resolve @handles like the gift route does)
  const lv = await post(B, "/api/live/send-love", { hostId: A.handle });
  check("a viewer can send love to a live by @handle", lv.status === 200 && lv.body.success, JSON.stringify(lv.body));
  await new Promise(r => setTimeout(r, 1700));   // hearts are bundled once per second
  const evl = await call("/api/live/events/" + roomId + "?since=0&k=smoke2");
  const loveEv = (evl.body.events || []).find(e => e.type === "love");
  check("the host's screen gets a love event with the sender's name", !!loveEv && loveEv.items.length > 0 && !!loveEv.items[0].from, JSON.stringify(evl.body.events));
  check("events carry server time (so old gifts are never replayed)", typeof evl.body.now === "number");
  for (const [kind, per] of [["hosts", "daily"], ["hosts", "weekly"], ["hosts", "monthly"], ["gifters", "daily"], ["gifters", "weekly"], ["gifters", "monthly"]]) {
    const rk = await call("/api/ranking/" + kind + "/" + per);
    check("ranking " + kind + " " + per + " returns data (JSON)", rk.status === 200 && rk.body.success === true && Array.isArray(rk.body.ranking));
  }
  const badPack = await post(A, "/api/paystack/initialize", { email: A.email, packageAmount: 123 });
  check("a payment that is not a coin package cannot be started", badPack.status === 400 && badPack.body.success === false, JSON.stringify(badPack.body));
  const stmt = await call("/api/me/statement", { headers: A.h });
  check("coin history (statement) loads", stmt.status === 200 && Array.isArray(stmt.body.entries) && stmt.body.balance === 0, JSON.stringify(stmt.body).slice(0, 120));
  check("coin history is private", (await call("/api/me/statement")).status === 401);
  check("ledger audit is locked without the admin key", [401, 403].includes((await call("/api/admin/ledger/verify")).status));
  const rep = await post(B, "/api/report", { roomId, reason: "smoke test report" });
  check("viewers can report a live", rep.status === 200 && rep.body.success);
  check("admin pages are locked without the admin key", [401, 403].includes((await call("/api/admin/overview")).status));

  const fg = await call("/api/auth/forgot", { method: "POST", headers: json, body: JSON.stringify({ email: "nobody-" + Date.now() + "@example.com" }) });
  check("password reset gives the same answer for unknown emails", fg.status === 200 && fg.body.success);
  const rs = await call("/api/auth/reset", { method: "POST", headers: json, body: JSON.stringify({ token: "not-a-real-token", password: "NewTestPass123" }) });
  check("password reset rejects a bad link", rs.status === 400);

  const end = await post(A, "/api/live/end/" + roomId, {});
  check("host can end the live", end.status === 200, JSON.stringify(end.body));
  for (const u of [A, B]) await post(u, "/api/auth/delete-account", { password: "TestPass123" });

  console.log("\n" + (failed ? failed + " check(s) FAILED" : "All checks passed"));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("Could not reach the server. Is it running (npm start)?\n", e.message); process.exit(1); });
