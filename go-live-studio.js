/* =====================================================================
   VicoPay Live — Go Live studio (host side)
   Loaded by Go-Live.html AFTER its main script. It adds everything the
   host needs while live:
     - heartbeat (keeps the live alive, server ends it if the host vanishes)
     - live preview picture for the Live Room cards
     - real PK: challenge, accept/decline, scoreboard, opponent video
     - Fan Club, Gifts (Golden Stars) and Followers tabs
     - real camera / microphone switches while broadcasting
   It relies on these globals from Go-Live.html: vicoLiveRoomId,
   vicoLiveKitRoom, stream, muted, showToast, escapeHTML.
   ===================================================================== */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var enc = encodeURIComponent;
  var COLORS = ["#0787ed", "#7c3aed", "#db2777", "#ea580c", "#059669", "#0891b2", "#b45309", "#4f46e5"];
  var GIFT_ICON = { Rose: "🌹", Fire: "🔥", Strawberry: "🍓", Star: "⭐", Trophy: "🏆", Car: "🏎️", Silver: "🥈", Diamond: "💎", Gold: "🥇", Eagle: "🦅", Lion: "🦁", Dragon: "🐉", Elephant: "🐘", Whale: "🐋" };

  function esc(t) { var d = document.createElement("div"); d.textContent = t == null ? "" : String(t); return d.innerHTML; }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function api(path, body) {
    var o = { method: body !== undefined ? "POST" : "GET", headers: { "Content-Type": "application/json" } };
    if (body !== undefined) o.body = JSON.stringify(body);
    return fetch(location.origin + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._ok = r.ok && d.success !== false; return d; });
    });
  }
  function color(s) { var h = 0; s = String(s || "?"); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function avatar(name, url, size) {
    size = size || 38;
    return '<span class="va2" style="width:' + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.42) + "px;background:" + color(name) + '">' +
      esc(String(name || "?").trim().charAt(0).toUpperCase() || "?") + (url ? '<img src="' + esc(url) + '" alt="" onerror="this.remove()">' : "") + "</span>";
  }

  var me = null, battle = null, activeTab = "chat", pkDur = 180, lastEv = 0, seenInv = {}, oppId = null, oppLK = null;

  /* ---------------- who am I ---------------- */
  function loadMe() {
    return api("/api/me").then(function (d) {
      if (!d._ok) return;
      me = d;
      var n = $("#hcName"); if (n) n.textContent = d.displayName;
      var a = $("#hcAvatar");
      if (a) { a.innerHTML = esc(String(d.displayName).charAt(0).toUpperCase()) + (d.avatar ? '<img src="' + esc(d.avatar) + '" alt="" onerror="this.remove()">' : ""); a.style.background = color(d.displayName); a.style.fontSize = "17px"; }
      api("/api/followers/me").then(function (f) { if (f._ok && $("#hcSub")) $("#hcSub").textContent = num(f.owner.followers) + " followers"; });
    });
  }

  /* ---------------- tabs ---------------- */
  var LOADERS = { chat: function () { }, pk: loadPK, fans: loadFans, gifts: loadGifts, people: loadPeople };
  window.setTab = function (name) {
    activeTab = name;
    document.querySelectorAll("#gtabs .tab").forEach(function (b) { b.classList.toggle("active", b.dataset.t === name); if (b.dataset.t === name) b.classList.remove("alert"); });
    document.querySelectorAll(".pane").forEach(function (p) { p.classList.toggle("on", p.id === "pane-" + name); });
    (LOADERS[name] || function () { })();
    var r = $("#rightPanel");
    if (r && window.innerWidth <= 1050) r.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("#gtabs").addEventListener("click", function (e) { var b = e.target.closest(".tab"); if (b) window.setTab(b.dataset.t); });
  // old buttons in the page still call these
  window.openPK = function () { window.setTab("pk"); };
  window.sendLove = function () { showToast("❤️ Viewers send hearts from the watch page. You will see them counted here."); };

  /* ---------------- PK ---------------- */
  function pkIdle() { return !battle; }
  function loadPK() {
    var box = $("#pane-pk");
    if (!vicoLiveRoomId) {
      box.innerHTML = '<div class="pad"><div class="pcard"><b>⚔️ PK Battles</b><p class="hint">Two hosts go live side by side. Every gift sent in either room becomes points for that host. Highest score when the timer ends wins.</p><p class="hint">Start your live first, then challenge another host here.</p><button class="gift-main" onclick="startLive()">🔴 Start Live</button></div></div>';
      return;
    }
    if (battle) { box.innerHTML = '<div class="pad">' + battleCard(battle) + '<p class="hint">Gifts viewers send to you during the battle add to your score. The opponent’s video shows on your stage.</p></div>'; return; }
    box.innerHTML = '<div class="pad hint">Looking for live hosts…</div>';
    Promise.all([api("/api/pk/find-opponent"), api("/api/pk/invites")]).then(function (r) {
      if (battle || activeTab !== "pk") return;
      var opp = r[0].opponents || [], inv = r[1].invites || [];
      var html = '<div class="pad">';
      inv.forEach(function (i) {
        html += '<div class="pcard" style="border-color:#7c3aed"><b>⚔️ ' + esc(i.from) + ' challenges you</b><div class="hint">' + (i.duration / 60) + " minute battle · " + i.secondsLeft + 's left to answer</div><div style="margin-top:8px;display:flex;gap:8px"><button class="sm" onclick="pkAnswer(\'' + i.id + '\',true)">Accept</button><button class="sm gray" onclick="pkAnswer(\'' + i.id + '\',false)">Decline</button></div></div>';
      });
      html += '<div class="hint" style="margin-bottom:6px">Battle length</div><div class="chips">' + [180, 300, 600].map(function (x) { return '<button class="' + (pkDur === x ? "on" : "") + '" onclick="pkSetDur(' + x + ')">' + x / 60 + " min</button>"; }).join("") + "</div>";
      html += opp.length ? opp.map(function (o) {
        return '<div class="prow">' + avatar(o.displayName, o.avatar) + '<div class="g"><div class="n">' + esc(o.displayName) + '</div><div class="s">' + esc(o.title) + " · 👁 " + num(o.viewers) + " · " + num(o.followers) + ' followers</div></div><button class="sm violet" onclick="pkInvite(\'' + esc(o.handle) + '\')">⚔️ Challenge</button></div>';
      }).join("") : '<div class="pcard hint">No other hosts are live right now. When someone goes live they will appear here. You can also be challenged by others.</div>';
      html += '<p class="hint" style="margin-top:12px"><a style="color:#13d1ff" href="pk-battles.html" target="_blank">See all battles and the PK leaderboard</a></p></div>';
      box.innerHTML = html;
    });
  }
  window.pkSetDur = function (x) { pkDur = x; loadPK(); };
  window.pkInvite = function (h) {
    api("/api/pk/invite", { hostId: h, duration: pkDur }).then(function (d) { showToast(d._ok ? "⚔️ Challenge sent. They have 60 seconds to accept." : "❌ " + (d.message || "Could not send challenge.")); });
  };
  window.pkAnswer = function (id, yes) {
    api("/api/pk/respond", { inviteId: id, accept: yes }).then(function (d) {
      showToast(d._ok ? (yes ? "⚔️ PK battle started!" : "Declined.") : "❌ " + (d.message || "Could not answer."));
      if (d._ok && yes && d.battle) { battle = d.battle; paintBattle(); } loadPK();
    });
  };
  function battleCard(b) {
    var t = b.a.score + b.b.score, p = t ? Math.round(b.a.score / t * 100) : 50;
    return '<div class="pcard"><div class="pkscore"><div><b>' + esc(b.a.displayName) + '</b><div class="big">' + num(b.a.score) + '</div></div><div>VS<div class="hint" id="pkClockPane">' + clock(b) + '</div></div><div><b>' + esc(b.b.displayName) + '</b><div class="big">' + num(b.b.score) + '</div></div></div><div class="pkbar"><i style="width:' + p + '%"></i></div></div>';
  }
  function clock(b) { var s = Math.max(0, Math.ceil((b.endsAt - Date.now()) / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function paintBattle() {
    var sp = $("#stagePK");
    if (!battle) { sp.classList.remove("on"); syncOpp(null); return; }
    sp.classList.add("on");
    $("#spA").textContent = battle.a.displayName + " · " + num(battle.a.score);
    $("#spB").textContent = num(battle.b.score) + " · " + battle.b.displayName;
    var t = battle.a.score + battle.b.score; $("#spBar").style.width = (t ? Math.round(battle.a.score / t * 100) : 50) + "%";
    syncOpp(battle);
    if (activeTab === "pk") { var box = $("#pane-pk"); box.innerHTML = '<div class="pad">' + battleCard(battle) + '<p class="hint">Gifts viewers send to you during the battle add to your score. The opponent’s video shows on your stage.</p></div>'; }
  }
  setInterval(function () {
    if (!battle) return; var c = clock(battle); $("#spTimer").textContent = "⚔️ PK Battle · " + c; var e = $("#pkClockPane"); if (e) e.textContent = c;
  }, 500);

  // opponent's live video (host watches the other host like a viewer)
  function syncOpp(b) {
    var opp = b ? (me && b.a.handle === me.handle ? b.b : b.a) : null, rid = opp && opp.roomId ? opp.roomId : null;
    if (rid === oppId) return;
    oppId = rid;
    if (oppLK) { try { oppLK.disconnect(); } catch (e) { } oppLK = null; $("#oppVideo").srcObject = null; }
    $("#oppBox").style.display = rid ? "block" : "none";
    if (!rid || !window.LivekitClient) return;
    $("#oppName").textContent = opp.displayName;
    api("/api/livekit/token", { roomName: rid, identity: "pk", role: "viewer" }).then(function (d) {
      if (!d._ok || oppId !== rid) return;
      var L = window.LivekitClient, room = new L.Room({ adaptiveStream: true });
      oppLK = room;
      function attach(t) {
        if (t.kind === L.Track.Kind.Video) t.attach($("#oppVideo"));
        else if (t.kind === L.Track.Kind.Audio) { var a = t.attach(); a.style.display = "none"; document.body.appendChild(a); }
      }
      room.on(L.RoomEvent.TrackSubscribed, attach);
      room.on(L.RoomEvent.TrackUnsubscribed, function (t) { t.detach(); });
      return room.connect(d.url, d.token).then(function () {
        if (oppId !== rid) { room.disconnect(); return; }
        room.remoteParticipants.forEach(function (p) { p.trackPublications.forEach(function (pub) { if (pub.isSubscribed && pub.track) attach(pub.track); }); });
      });
    }).catch(function (e) { console.error("PK opponent video:", e); });
  }

  /* ---------------- Fan club ---------------- */
  function loadFans() {
    var box = $("#pane-fans"); box.innerHTML = '<div class="pad hint">Loading fan club…</div>';
    api("/api/fanclub/me").then(function (d) {
      if (!d._ok) { box.innerHTML = '<div class="pad hint">' + esc(d.message || "Could not load your fan club.") + "</div>"; return; }
      var link = location.origin + "/fan-club.html?host=" + enc(d.host.handle);
      var html = '<div class="pad"><div class="pcard" style="background:linear-gradient(135deg,#2a1a7a,#5b2fc7);border-color:#7c3aed"><b>💜 Your Fan Club</b><div class="hint" style="color:#e5d9ff">' + num(d.memberCount) + " members · fans pay " + num(d.cost) + " coins to join, and earn points with every gift. Levels at " + d.levels.map(num).join(" / ") + ' points.</div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="sm" id="copyFan">🔗 Copy fan club link</button><a class="sm gray" href="fan-club.html?host=' + enc(d.host.handle) + '" target="_blank">Open page</a></div></div>';
      html += d.members.length ? d.members.slice(0, 40).map(function (m, i) {
        return '<div class="prow"><b style="width:22px;color:#9fc3e8">' + (i + 1) + "</b>" + avatar(m.displayName, m.avatar, 34) + '<div class="g"><div class="n">' + esc(m.displayName) + '</div><div class="s">' + num(m.points) + ' points</div></div><span class="lvl">Lv ' + m.level + "</span></div>";
      }).join("") : '<div class="pcard hint">No fans have joined yet. Share your fan club link in your live chat, and viewers can also join from the 💜 button on your live.</div>';
      box.innerHTML = html + "</div>";
      var c = $("#copyFan"); if (c) c.onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { showToast("🔗 Fan club link copied"); }, function () { prompt("Copy this link:", link); }); };
    });
  }

  /* ---------------- Gifts / Golden Stars ---------------- */
  function loadGifts() {
    var box = $("#pane-gifts"); box.innerHTML = '<div class="pad hint">Loading…</div>';
    Promise.all([api("/api/creator/star-status"), api("/api/host/recent-gifts")]).then(function (r) {
      var s = r[0], g = r[1].gifts || [];
      var html = '<div class="pad"><div class="stat3"><div><b>' + num(s.total) + '</b><span>Golden Stars</span></div><div><b>' + num(s.withdrawable) + '</b><span>Withdrawable</span></div><div><b>' + num(s.onHold) + '</b><span>On hold ' + (s.holdDays || 7) + "d</span></div></div>";
      html += '<p class="hint">New stars are held for ' + (s.holdDays || 7) + ' days (to protect against refunds and chargebacks), then become withdrawable. <a style="color:#13d1ff" href="host-wallet.html">Open Host Wallet</a></p>';
      html += g.length ? g.map(function (x) {
        return '<div class="prow">' + avatar(x.from, x.avatar, 34) + '<div class="g"><div class="n">' + esc(x.from) + '</div><div class="s">' + (GIFT_ICON[x.gift] || "🎁") + " " + esc(x.gift) + " · " + new Date(x.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + '</div></div><b style="color:#ffc83d">+' + num(x.coin) + " ⭐</b></div>";
      }).join("") : '<div class="pcard hint">No gifts yet. When viewers send gifts they appear here instantly.</div>';
      box.innerHTML = html + "</div>";
    });
  }

  /* ---------------- Followers / Following ---------------- */
  // Followers = people who follow ME.   Following = people I follow.  Two separate lists, two separate tabs.
  var peopleMode = "followers", peopleData = null;
  function peopleRow(f, mode) {
    var btn;
    if (mode === "following") btn = '<button class="sm gray" onclick="followBack(this,\'' + esc(f.handle) + '\',true)">Following</button>';
    else btn = '<button class="sm ' + (f.isFollowing ? "gray" : "") + '" onclick="followBack(this,\'' + esc(f.handle) + "'," + !!f.isFollowing + ')">' + (f.isFollowing ? "Following" : "Follow back") + "</button>";
    return '<div class="prow">' + avatar(f.displayName, f.avatar, 34) + '<div class="g"><div class="n">' + esc(f.displayName) + '</div><div class="s">@' + esc(f.handle) + " · " + num(f.followers) + " followers</div></div>" + btn + "</div>";
  }
  function paintPeople() {
    var box = $("#pane-people"), d = peopleData; if (!box || !d) return;
    var nFollowers = d.fr.owner.followers, nFollowing = d.fr.owner.following;
    var list = peopleMode === "followers" ? d.fr.followers : d.fg.following;
    var html = '<div class="pad"><div class="stat3"><div><b>' + num(nFollowers) + "</b><span>Followers</span></div><div><b>" + num(nFollowing) + "</b><span>Following</span></div><div><b>" + num(list.length) + "</b><span>Shown</span></div></div>";
    html += '<div style="display:flex;gap:8px;margin-bottom:6px"><button class="sm ' + (peopleMode === "followers" ? "" : "gray") + '" onclick="peopleTab(\'followers\')">Followers (' + num(nFollowers) + ')</button><button class="sm ' + (peopleMode === "following" ? "" : "gray") + '" onclick="peopleTab(\'following\')">Following (' + num(nFollowing) + ")</button></div>";
    html += '<div class="hint" style="margin-bottom:8px">' + (peopleMode === "followers" ? "People who follow you." : "People you follow.") + "</div>";
    html += list.length ? list.map(function (f) { return peopleRow(f, peopleMode); }).join("") :
      '<div class="pcard hint">' + (peopleMode === "followers" ? "No followers yet. Go live, post your link, and ask viewers to tap Follow." : "You are not following anyone yet.") + "</div>";
    box.innerHTML = html + "</div>";
    var sub = $("#hcSub"); if (sub) sub.textContent = num(nFollowers) + " followers";
  }
  function loadPeople() {
    var box = $("#pane-people"); if (!peopleData) box.innerHTML = '<div class="pad hint">Loading…</div>';
    Promise.all([api("/api/followers/me"), api("/api/following/me")]).then(function (r) {
      var fr = r[0], fg = r[1];
      if (!fr._ok || !fg._ok) { box.innerHTML = '<div class="pad hint">' + esc((!fr._ok ? fr.message : fg.message) || "Could not load followers.") + "</div>"; return; }
      peopleData = { fr: fr, fg: fg }; paintPeople();
    });
  }
  window.peopleTab = function (m) { peopleMode = m; paintPeople(); };
  window.followBack = function (btn, handle, on) {
    btn.disabled = true;
    api(on ? "/api/unfollow" : "/api/follow", { hostId: handle }).then(function (d) { if (d._ok) loadPeople(); else { btn.disabled = false; showToast(d.message || "Failed"); } });
  };

  /* ---------------- gift pop-ups on stage ---------------- */
  // Gifts and hearts appear on the HOST's screen with the sender's photo and name:
  //  - a small list on the left ("Bob sent Fire x3", "Ada sent love x12")
  //  - the gift icon floating up in the middle; expensive gifts (1,000+ coins) get a big banner
  //  - hearts floating up on the right
  function giftStack() {
    var s = $("#giftStack");
    if (!s) { s = document.createElement("div"); s.id = "giftStack"; s.className = "gstack"; $(".live-stage").appendChild(s); }
    return s;
  }
  function stackRow(key, ev, html, ms, cls) {
    var st = giftStack(), row = st.querySelector('[data-k="' + key.replace(/"/g, "") + '"]');
    if (!row) {
      row = document.createElement("div"); row.className = "grow2" + (cls ? " " + cls : ""); row.setAttribute("data-k", key.replace(/"/g, ""));
      row.innerHTML = html; st.appendChild(row);
      while (st.children.length > 4) st.firstChild.remove();
    } else { row.innerHTML = html; row.classList.remove("bump"); void row.offsetWidth; row.classList.add("bump"); }
    clearTimeout(row._t); row._t = setTimeout(function () { row.remove(); }, ms || 4500);
  }
  function giftPop(ev) {
    var icon = GIFT_ICON[ev.gift] || "🎁", big = Number(ev.price) >= 1000;
    stackRow("g|" + ev.from + "|" + ev.gift, ev,
      avatar(ev.from, ev.avatar, 34) + '<div class="gt"><b>' + esc(ev.from) + '</b><span>sent ' + esc(ev.gift) + '</span></div><em>' + icon + '</em>' + (ev.combo > 1 ? '<i class="cx">x' + ev.combo + '</i>' : ""), 4500);
    if (window.VicoGifts) { VicoGifts.play(ev.gift, { container: $(".live-stage"), from: ev.from, combo: ev.combo }); return; }
    var f = document.createElement("div"); f.className = "gpop" + (big ? " big" : "");
    f.innerHTML = icon + (big ? "<small>" + esc(ev.from) + " sent " + esc(ev.gift) + "!</small>" : "");
    $(".live-stage").appendChild(f); setTimeout(function () { f.remove(); }, big ? 4200 : 3300);
    if (typeof showToast === "function" && !big) { /* the list on the left is enough for small gifts */ }
  }
  function followPop(ev) {
    stackRow("f|" + ev.from, ev, avatar(ev.from, ev.avatar, 34) + '<div class="gt"><b>' + esc(ev.from) + '</b><span>started following you</span></div><em>➕</em>', 7000, "follow");
    var sub = $("#hcSub"); if (sub && ev.followers != null) sub.textContent = num(ev.followers) + " followers";
    if (typeof showToast === "function") showToast("➕ " + ev.from + " started following you");
    var t = document.querySelector('#gtabs .tab[data-t="people"]'); if (t && activeTab !== "people") t.classList.add("alert");
    if (activeTab === "people") loadPeople();
  }
  function lovePop(ev) {
    (ev.items || []).forEach(function (it, idx) {
      stackRow("l|" + it.from, ev, avatar(it.from, it.avatar, 34) + '<div class="gt"><b>' + esc(it.from) + '</b><span>sent love</span></div><em>❤️</em>' + (it.n > 1 ? '<i class="cx">x' + it.n + '</i>' : ""), 3500);
      for (var k = 0; k < Math.min(it.n, 5); k++) {
        (function (k) { setTimeout(function () {
          var h = document.createElement("div"); h.className = "hpop"; h.textContent = ["❤️", "💙", "💖", "💗"][Math.floor(Math.random() * 4)];
          h.style.right = (16 + Math.random() * 60) + "px";
          if (k === 0 && idx === 0) h.innerHTML += '<small>' + esc(it.from) + '</small>';
          $(".live-stage").appendChild(h); setTimeout(function () { h.remove(); }, 2600);
        }, k * 160); })(k);
      }
    });
  }

  /* ---------------- the live loop ---------------- */
  function tick() {
    if (!vicoLiveRoomId) { if (battle) { battle = null; paintBattle(); } return; }
    api("/api/live/events/" + enc(vicoLiveRoomId) + "?since=" + lastEv + "&k=host").then(function (d) {
      if (d.ended) return;
      (d.events || []).forEach(function (e) {
        lastEv = Math.max(lastEv, e.id);
        if ((d.now || Date.now()) - e.ts > 12000) return;   // old news from before this page opened: do not replay it
        if (e.type === "gift") { giftPop(e); if (activeTab === "gifts") loadGifts(); }
        if (e.type === "love") lovePop(e);
        if (e.type === "follow") followPop(e);
        if (e.type === "pk_end") showToast(e.winner === "draw" ? "⚔️ PK ended in a draw." : "🏆 PK winner: " + e.winner);
      });
      var was = !!battle; battle = d.battle || null;
      if (was !== !!battle || battle) paintBattle();
      if (was && !battle && activeTab === "pk") loadPK();
    });
    if (!battle) api("/api/pk/invites").then(function (d) {
      (d.invites || []).forEach(function (i) {
        if (seenInv[i.id]) return; seenInv[i.id] = 1;
        showToast("⚔️ " + i.from + " challenged you to PK. Open the PK tab.");
        var t = document.querySelector('#gtabs .tab[data-t="pk"]'); if (t && activeTab !== "pk") t.classList.add("alert");
        if (activeTab === "pk") loadPK();
      });
    });
  }
  function heartbeat() {
    if (!vicoLiveRoomId) return;
    api("/api/live/" + enc(vicoLiveRoomId) + "/heartbeat", {}).then(function (d) {
      if (d && d._ok === false && /not running/i.test(d.message || "")) { showToast("Your live was ended by the server. Start again when ready."); }
    });
  }
  function thumb() {
    var v = $("#camera");
    if (!vicoLiveRoomId || !v || !v.videoWidth) return;
    var c = document.createElement("canvas"); c.width = 360; c.height = Math.round(360 * v.videoHeight / v.videoWidth);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    api("/api/live/" + enc(vicoLiveRoomId) + "/thumbnail", { image: c.toDataURL("image/jpeg", 0.6) });
  }
  setInterval(tick, 1500);
  setInterval(heartbeat, 20000);
  setInterval(thumb, 15000);
  setInterval(function () { if (activeTab === "pk" && !battle && vicoLiveRoomId) loadPK(); }, 8000);
  setInterval(function () { if (activeTab === "fans") loadFans(); else if (activeTab === "people") loadPeople(); }, 30000);
  // start sending signs of life the moment the live is created
  var watcher = setInterval(function () { if (vicoLiveRoomId) { heartbeat(); setTimeout(thumb, 4000); document.getElementById("pane-pk") && activeTab === "pk" && loadPK(); clearInterval(watcher); lastEv = 0; } }, 1500);

  /* ---------------- camera / microphone while live ---------------- */
  window.toggleLiveMicrophone = function () {
    var btn = $("#micControlBtn");
    if (vicoLiveKitRoom) {
      var lp = vicoLiveKitRoom.localParticipant, on = lp.isMicrophoneEnabled;
      lp.setMicrophoneEnabled(!on).then(function () { muted = on; if (btn) btn.textContent = "🎙️ Microphone: " + (on ? "Off" : "On"); showToast(on ? "🎙️ Microphone turned off." : "🎙️ Microphone turned on."); });
      return;
    }
    if (!stream) { showToast("🎙️ Start the camera first."); return; }
    var tr = stream.getAudioTracks(); if (!tr.length) { showToast("❌ Microphone was not found."); return; }
    muted = !muted; tr.forEach(function (t) { t.enabled = !muted; });
    if (btn) btn.textContent = "🎙️ Microphone: " + (muted ? "Off" : "On");
  };
  window.toggleMute = window.toggleLiveMicrophone;
  window.toggleCamera = function () {
    if (vicoLiveKitRoom) {
      var lp = vicoLiveKitRoom.localParticipant, on = lp.isCameraEnabled;
      lp.setCameraEnabled(!on).then(function () { showToast(on ? "📷 Camera turned off." : "📷 Camera turned on."); });
      return;
    }
    if (!stream) return window.startLiveCamera();
    var t = stream.getVideoTracks()[0]; if (!t) { showToast("❌ Camera was not found."); return; }
    t.enabled = !t.enabled; showToast(t.enabled ? "📷 Camera turned on." : "📷 Camera turned off.");
  };

  /* ---------------- housekeeping ---------------- */
  // categories saved by older versions of the page are not valid any more
  (function () {
    var sel = $("#setupCategory"), saved = localStorage.getItem("vicoPayLiveCategory");
    if (sel) {
      var ok = Array.prototype.some.call(sel.options, function (o) { return o.value === saved; });
      if (ok) sel.value = saved; else { localStorage.removeItem("vicoPayLiveCategory"); var rc = $("#roomCategory"); if (rc) rc.textContent = sel.value; }
    }
  })();
  window.addEventListener("beforeunload", function (e) { if (typeof vicoLiveKitRoom !== "undefined" && vicoLiveKitRoom) { e.preventDefault(); e.returnValue = ""; } });
  loadMe();
})();
