/* Vico Message — browser app for vico-messages.html
   Verify account email -> chat (instant, with ticks) -> voice / video calls (LiveKit).
   Talks to /api/vm/* and /api/dm/* (vico-messages.js, vico-message-calls.js). Needs auth.js and gm-nav.js first. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var esc = window.gmEsc, say = function (m) { if (window.gmToast) window.gmToast(m); };
  // Not enough wallet balance: a bar with a button that opens the recharge page (wallet.html)
  function needRecharge(msg, url) {
    var old = document.getElementById("vmRecharge"); if (old) old.remove();
    var bar = document.createElement("div"); bar.id = "vmRecharge"; bar.setAttribute("role", "alert");
    bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:max(14px,env(safe-area-inset-bottom));z-index:99999;max-width:520px;margin:0 auto;background:#031c5d;color:#fff;border-radius:14px;padding:12px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.35);font:600 14px/1.35 system-ui,sans-serif";
    var t = document.createElement("div"); t.style.flex = "1"; t.textContent = msg || "You have insufficient balance. Recharge your wallet to continue.";
    var go = document.createElement("a"); go.href = /^[a-z0-9_.-]+\.html$/i.test(url || "") ? url : "wallet.html"; go.textContent = "Recharge wallet";
    go.style.cssText = "background:#ffc83d;color:#031c5d;text-decoration:none;font-weight:800;padding:9px 12px;border-radius:10px;white-space:nowrap";
    var x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.textContent = "×";
    x.style.cssText = "background:none;border:0;color:#a9c6ec;font-size:22px;cursor:pointer;padding:0 2px";
    x.onclick = function () { bar.remove(); };
    bar.appendChild(t); bar.appendChild(go); bar.appendChild(x); document.body.appendChild(bar);
    setTimeout(function () { if (bar.parentNode) bar.remove(); }, 20000);
  }
  var api = function (p, body) { return window.gmApi(p, body === undefined ? undefined : { body: body }); };
  var S = { status: null, tab: "chat", threads: [], cur: null, info: null, lastId: 0, ids: {}, sending: 0, lastDay: "", typingUntil: 0, typingSent: 0,
    stream: { on: false, stop: false, fails: 0 }, calls: [], searchT: null };
  var EMOJI = "😀 😂 😍 🥰 😎 🤝 🙏 👍 👏 🔥 🎉 ❤️ 😊 😉 🤔 😢 😭 😡 🙌 💯 ✅ 🎁 💰 📞 📦 🛒 ⭐ 👑 🌍 🚀 ✨".split(" ");
  var SEEN_KEY = "vmCallsSeen";

  /* ---------- helpers ---------- */
  function ico(id, cls) { return '<svg class="i ' + (cls || "") + '"><use href="#i-' + id + '"/></svg>'; }
  function avatar(p, biz) {
    var l = esc((p.businessName || p.displayName || "?").trim().charAt(0).toUpperCase() || "?");
    return '<div class="av' + (biz ? " biz" : "") + '">' + (p.avatar ? '<img src="' + esc(p.avatar) + '" alt="">' : l) + (p.online ? "<i></i>" : "") + "</div>";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function clock(t) { var d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function dayName(t) {
    var d = new Date(t), n = new Date(), y = new Date(Date.now() - 864e5);
    if (sameDay(d, n)) return "Today"; if (sameDay(d, y)) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
  }
  function short(t) {
    var d = new Date(t), n = new Date();
    if (sameDay(d, n)) return clock(t); if (sameDay(d, new Date(Date.now() - 864e5))) return "Yesterday";
    return Date.now() - t < 6 * 864e5 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  function dur(s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ":" + pad(m) : m) + ":" + pad(s % 60); }
  function linkify(escaped) {
    return escaped.replace(/\bhttps?:\/\/[^\s<]+/g, function (u) {
      var tail = (u.match(/[.,!?;:)\]]+$/) || [""])[0]; if (tail) u = u.slice(0, -tail.length);
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer nofollow">' + u + "</a>" + tail;
    });
  }
  function tick(state) {
    if (state === "pending") return ico("clock", "tick");
    return state === "sent" ? ico("check", "tick") : ico("check2", "tick" + (state === "read" ? " read" : ""));
  }
  function callText(meta, mine) {
    var k = meta && meta.kind === "video" ? "video" : "voice", st = meta && meta.status, d = meta && meta.duration;
    if (st === "missed") return { t: mine ? "No answer" : "Missed " + k + " call", red: !mine };
    if (st === "cancelled") return { t: mine ? "Cancelled " + k + " call" : "Missed " + k + " call", red: !mine };
    if (st === "declined") return { t: mine ? "Declined " + k + " call" : "You declined a " + k + " call", red: false };
    return { t: (mine ? "Outgoing " : "Incoming ") + k + " call", extra: d ? dur(d) : "", red: false };
  }
  function setTitle() { var n = S.threads.reduce(function (a, t) { return a + (t.unread || 0); }, 0); document.title = (n ? "(" + n + ") " : "") + "Vico Message - Vico Pay Live"; }

  /* ---------- gate: sign in, email, code, profile ---------- */
  function gate(html, step) {
    $("vm").hidden = true; document.body.classList.remove("vm-inchat");
    var g = $("gate"); g.hidden = false;
    var bar = step ? '<div class="steps" aria-hidden="true">' + [1, 2, 3, 4].map(function (i) { return "<i" + (i <= step ? ' class="on"' : "") + "></i>"; }).join("") + "</div>" : "";
    g.innerHTML = '<div class="gate-card"><div class="logo">' + ico("chat") + "</div>" + bar + html + "</div>";
  }
  function gateLogin() {
    gate("<h2>Log in to use Vico Message</h2><p>Chat and call buyers, sellers and streamers. Log in first, then verify your phone number and the email address on your VicoPay account.</p>" +
      '<a class="btn-main" style="display:block;text-align:center;text-decoration:none" href="join-now.html?next=vico-messages.html">Log in</a>');
  }

  /* ---------- phone verification ----------
     1 number + country  ->  2 six-digit code  ->  then the other verifications (email, profile).
     VicoPay makes and checks the code itself. It travels by SMS (Infobip) or, if this browser is set up for it, as a push notification to this device. */
  function pushSupported() { return !!(window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window); }
  function keyBytes(b64) {
    var r = atob((b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")), o = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o;
  }
  function sameBytes(buf, u8) { if (!buf) return false; var a = new Uint8Array(buf); if (a.length !== u8.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== u8[i]) return false; return true; }
  // Registers this browser for push codes. Must be called from a tap (the browser asks permission). Resolves { ok, message }.
  function enablePush() {
    var pk = S.status && S.status.push && S.status.push.publicKey;
    if (!pushSupported() || !pk) return Promise.resolve({ ok: false, message: "This browser cannot receive push codes." });
    var key = keyBytes(pk);
    return navigator.serviceWorker.register("vico-sw.js", { scope: "/" }).then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
      return Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") return { ok: false, message: "Notifications are blocked for this site. Allow them, or use SMS." };
        return reg.pushManager.getSubscription().then(function (sub) {
          if (sub && !sameBytes(sub.options && sub.options.applicationServerKey, key)) return sub.unsubscribe().then(function () { return null; });
          return sub;
        }).then(function (sub) { return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); })
          .then(function (sub) { return api("/api/vm/push/subscribe", { subscription: sub.toJSON() }); })
          .then(function (d) { return d.success ? { ok: true } : { ok: false, message: d.message || "Could not set up push codes." }; });
      });
    }).catch(function () { return { ok: false, message: "This browser could not set up push codes. Please use SMS." }; });
  }
  function splitPhone(e164) {   // "+2348012345678" -> { country: "NG", national: "8012345678" }
    var d = String(e164 || "").replace(/\D/g, ""), list = ((S.status && S.status.countries) || []).slice().sort(function (a, b) { return b.dial.length - a.dial.length; });
    for (var i = 0; i < list.length; i++) if (d.indexOf(list[i].dial) === 0) return { country: list[i].code, national: d.slice(list[i].dial.length) };
    return null;
  }
  function gatePhone(prefill) {
    var st = S.status || {}, cs = st.countries || [], pre = prefill || (st.suggestedPhone ? splitPhone(st.suggestedPhone.phone || st.suggestedPhone) : null) || {};
    var canPush = !!(st.push && st.push.web && pushSupported());
    gate("<h2>Verify your phone number</h2>" + (st.advertiserPending ? '<div class="hint" role="note">' + esc(st.advertiserMessage || "Verify your phone number in Vico Message to be able to start using Vico Message for calling, chatting and messaging for the advertisement of products in Vico Pay.") + "</div>" : "") + "<p>Enter your phone number with its country code. VicoPay will send a six-digit code to that exact number.</p>" +
      '<label class="f" for="pcountry">Country</label><div class="phone-row"><select id="pcountry" class="fi" aria-label="Country code">' +
      cs.map(function (c) { return '<option value="' + esc(c.code) + '"' + (c.code === (pre.country || "NG") ? " selected" : "") + ">" + esc(c.name) + " (+" + esc(c.dial) + ")</option>"; }).join("") +
      '</select><input id="pnum" class="fi" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="20" aria-label="Phone number" placeholder="801 234 5678" value="' + esc(pre.national || "") + '"></div>' +
      '<div class="err" id="gerr" role="alert"></div>' +
      '<button class="btn-main" id="sendSms" type="button">Send code by SMS</button>' +
      (canPush ? '<p style="text-align:center;margin:10px 0 0"><button class="link" id="sendPush" type="button">Send the code to this device instead</button></p>' : "") +
      '<div class="hint">Standard SMS rates from your network may apply. We never show your number to other people unless you allow it.</div>', 1);
    function go(channel) {
      var err = $("gerr"), n = $("pnum").value.trim(), b = $(channel === "push" ? "sendPush" : "sendSms"), label = b.textContent;
      if (!n) { err.textContent = "Enter your phone number."; return; }
      err.textContent = ""; b.disabled = true; b.textContent = "Sending…";
      var done = function (d) {
        b.disabled = false; b.textContent = label;
        if (!d.success) { err.textContent = d.message || "Could not send the code."; return; }
        if (d.alreadyVerified) return afterPhone();
        S.pend = { phone: d.phone, country: $("pcountry").value, masked: d.phoneMasked || d.phone, channel: d.channel || channel, dev: d.devCode || "" };
        gatePhoneCode(d.cooldownSeconds || 60);
      };
      var fail = function () { b.disabled = false; b.textContent = label; err.textContent = "Connection problem. Please try again."; };
      var send = function () { return api("/api/vm/phone/send", { phone: n, country: $("pcountry").value, channel: channel }); };
      if (channel === "push") enablePush().then(function (r) { if (!r.ok) { b.disabled = false; b.textContent = label; err.textContent = r.message; return; } return send().then(done); }).catch(fail);
      else send().then(done).catch(fail);
    }
    $("sendSms").onclick = function () { go("sms"); };
    if ($("sendPush")) $("sendPush").onclick = function () { go("push"); };
    $("pnum").onkeydown = function (e) { if (e.key === "Enter") go("sms"); };
  }
  function gatePhoneCode(wait) {
    var P = S.pend || {}, viaPush = P.channel === "push";
    gate("<h2>Enter your code</h2><p>" + (viaPush ? "We sent a six-digit code to this device as a notification." : "We sent a six-digit SMS code to <b>" + esc(P.masked) + "</b>.") + "</p>" +
      '<input id="codeIn" class="fi code-in" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" aria-label="6-digit code" placeholder="······">' +
      (P.dev ? '<div class="hint">Test mode code: <b>' + esc(P.dev) + "</b></div>" : "") +
      '<div class="err" id="gerr" role="alert"></div><button class="btn-main" id="verifyPhone" type="button" disabled>Verify</button>' +
      '<p style="text-align:center;margin:12px 0 0"><button class="link" id="resendPhone" type="button" disabled></button></p>' +
      (viaPush ? '<p style="text-align:center;margin:4px 0 0"><button class="link" id="viaSms" type="button">Send it by SMS instead</button></p>' : "") +
      '<p style="text-align:center;margin:4px 0 0"><button class="link" id="backPhone" type="button">Change number</button></p>', 2);
    var inp = $("codeIn"), t = Math.max(0, Number(wait) || 0), iv, ctl = null;
    inp.focus();
    function setCode(c) { inp.value = String(c || "").replace(/\D/g, "").slice(0, 6); $("verifyPhone").disabled = inp.value.length !== 6; if (inp.value.length === 6) confirmCode(); }
    inp.addEventListener("input", function () { setCode(inp.value); });
    // a push code arriving while this page is open fills the box by itself (vico-sw.js), and Chrome on Android can fill an SMS code with one tap (Web OTP)
    var onMsg = function (e) { if (e.data && e.data.type === "vm_code" && $("codeIn")) setCode(e.data.code); };
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", onMsg);
    if (!viaPush && "OTPCredential" in window && window.AbortController) {
      ctl = new AbortController();
      navigator.credentials.get({ otp: { transport: ["sms"] }, signal: ctl.signal }).then(function (o) { if (o && o.code && $("codeIn")) setCode(o.code); }).catch(function () {});
    }
    function cleanup() { clearInterval(iv); if (ctl) try { ctl.abort(); } catch (e) {} if (navigator.serviceWorker) navigator.serviceWorker.removeEventListener("message", onMsg); }
    function tickDown() {
      var r = $("resendPhone"); if (!r) return clearInterval(iv);
      r.disabled = t > 0; r.textContent = t > 0 ? "Resend code in " + t + "s" : "Resend code";
      if (t-- <= 0) clearInterval(iv);
    }
    tickDown(); iv = setInterval(tickDown, 1000);
    var busy = false;
    function confirmCode() {
      var b = $("verifyPhone"), err = $("gerr"); if (busy || inp.value.length !== 6) return;
      busy = true; err.textContent = ""; b.disabled = true; b.textContent = "Checking…";
      api("/api/vm/phone/verify", { code: inp.value }).then(function (d) {
        busy = false;
        if (!d.success) { b.disabled = false; b.textContent = "Verify"; err.textContent = d.message || "The code could not be verified."; return; }
        cleanup(); afterPhone();
      }).catch(function () { busy = false; b.disabled = false; b.textContent = "Verify"; err.textContent = "Connection problem. Please try again."; });
    }
    $("verifyPhone").onclick = confirmCode;
    inp.onkeydown = function (e) { if (e.key === "Enter") confirmCode(); };
    function resend(channel) {
      var err = $("gerr"); err.textContent = "";
      api("/api/vm/phone/send", { phone: P.phone, country: P.country, channel: channel }).then(function (d) {
        if (!d.success) { err.textContent = d.message || "Could not send a new code."; t = Number(d.waitSeconds) || 0; }
        else { S.pend.channel = d.channel || channel; if (channel !== P.channel) { cleanup(); return gatePhoneCode(d.cooldownSeconds || 60); } err.textContent = "A new code was sent."; t = Number(d.cooldownSeconds) || 60; }
        clearInterval(iv); tickDown(); iv = setInterval(tickDown, 1000);
      }).catch(function () { err.textContent = "Connection problem. Please try again."; });
    }
    $("resendPhone").onclick = function () { this.disabled = true; resend(P.channel || "sms"); };
    if ($("viaSms")) $("viaSms").onclick = function () { resend("sms"); };
    $("backPhone").onclick = function () { cleanup(); gatePhone({ country: P.country }); };
  }
  // Phone verified. Now the other Vico Message verifications: email, then the profile.
  function afterPhone() {
    loadStatus().then(function (st) { if (st.emailVerified) gateProfile(false); else gateEmail(); })
      .catch(function (e) { gate("<h2>Vico Message is not available</h2><p>" + esc(e.message || "Please try again.") + '</p><button class="btn-main" type="button" onclick="location.reload()">Try again</button>'); });
  }
  function finishEmailStep() {
    loadStatus().then(function () {
      // First-time activation always lets the person confirm their Vico Message profile.
      gateProfile(false);
    }).catch(function (e) {
      gate("<h2>Vico Message is not available</h2><p>" + esc(e.message || "Please try again.") + '</p><button class="btn-main" type="button" onclick="location.reload()">Try again</button>');
    });
  }
  function gateEmail() {
    var email = (S.status && S.status.email) || localStorage.getItem("vicoPayEmail") || "your VicoPay email";
    gate("<h2>Verify your email</h2><p>VicoPay will send a six-digit verification code to <b>" + esc(email) + "</b>.</p>" +
      '<div class="hint">This confirms that you control this email address.</div>' +
      '<div class="err" id="gerr" role="alert"></div><button class="btn-main" id="sendEmailCode" type="button">Send email code</button>' +
      (S.status && S.status.phoneVerified ? '<p style="text-align:center;margin:10px 0 0"><button class="link" id="laterEmail" type="button">Do this later</button></p>' : ""), 3);
    if ($("laterEmail")) $("laterEmail").onclick = function () { gateProfile(false); };
    $("sendEmailCode").onclick = function () {
      var b = this, err = $("gerr"); b.disabled = true; b.textContent = "Sending…"; err.textContent = "";
      api("/api/email-verify/send", {}).then(function (d) {
        b.disabled = false; b.textContent = "Send email code";
        if (!d.success) { err.textContent = d.message || "Could not send the email code."; return; }
        if (d.verified) return finishEmailStep();
        gateEmailCode(d.cooldownSeconds || 60);
      }).catch(function () { b.disabled = false; b.textContent = "Send email code"; err.textContent = "Connection problem. Please try again."; });
    };
  }
  function gateEmailCode(wait) {
    var email = (S.status && S.status.email) || localStorage.getItem("vicoPayEmail") || "your VicoPay email";
    gate("<h2>Enter your email code</h2><p>We sent a six-digit code to <b>" + esc(email) + "</b>.</p>" +
      '<input id="codeIn" class="fi code-in" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" aria-label="6-digit email code" placeholder="······">' +
      '<div class="err" id="gerr" role="alert"></div><button class="btn-main" id="verifyEmail" type="button" disabled>Verify email</button>' +
      '<p style="text-align:center;margin:12px 0 0"><button class="link" id="resendEmail" type="button" disabled></button></p>' +
      '<p style="text-align:center;margin:4px 0 0"><button class="link" id="backEmail" type="button">Back</button></p>', 3);
    var inp = $("codeIn"), t = Math.max(0, Number(wait) || 0), iv;
    inp.focus();
    inp.addEventListener("input", function () { inp.value = inp.value.replace(/\D/g, "").slice(0, 6); $("verifyEmail").disabled = inp.value.length !== 6; });
    function tickDown() {
      var r = $("resendEmail"); if (!r) return clearInterval(iv);
      r.disabled = t > 0; r.textContent = t > 0 ? "Resend email code in " + t + "s" : "Resend email code";
      if (t-- <= 0) clearInterval(iv);
    }
    tickDown(); iv = setInterval(tickDown, 1000);
    function confirmCode() {
      var b = $("verifyEmail"), err = $("gerr"); if (inp.value.length !== 6) return;
      err.textContent = ""; b.disabled = true; b.textContent = "Checking…";
      api("/api/email-verify/confirm", { code: inp.value }).then(function (d) {
        if (!d.success) { b.disabled = false; b.textContent = "Verify email"; err.textContent = d.message || "The code could not be verified."; return; }
        clearInterval(iv); finishEmailStep();
      }).catch(function () { b.disabled = false; b.textContent = "Verify email"; err.textContent = "Connection problem. Please try again."; });
    }
    $("verifyEmail").onclick = confirmCode;
    inp.onkeydown = function (e) { if (e.key === "Enter") confirmCode(); };
    $("resendEmail").onclick = function () {
      var b = this; b.disabled = true;
      api("/api/email-verify/send", {}).then(function (d) {
        if (!d.success) { $("gerr").textContent = d.message || "Could not resend the email code."; t = Number(d.waitSeconds) || 0; }
        else { $("gerr").textContent = "A new code was sent to your email."; t = Number(d.cooldownSeconds) || 60; }
        clearInterval(iv); tickDown(); iv = setInterval(tickDown, 1000);
      }).catch(function () { b.disabled = false; $("gerr").textContent = "Connection problem. Please try again."; });
    };
    $("backEmail").onclick = function () { clearInterval(iv); gateEmail(); };
  }
  function gateProfile(settings) {
    var st = S.status, me = st.me;
    var identityLine = settings
      ? (st.phoneVerified ? "Your account email is verified. Your previously verified phone number is " + esc(st.phoneMasked) + "." : "Your email address is verified. Your Vico Message account is active.")
      : "Your name is what people see in chats and calls.";
    var phoneRow = settings ? (st.phoneVerified
      ? '<div class="hint">✔ Phone number verified: <b>' + esc(st.phoneMasked) + "</b></div>"
      : '<div class="hint">Your phone number is not verified yet.<button class="link" id="verifyPhoneNow" type="button">Verify my phone number</button></div>') : "";
    var discoverToggle = st.phoneVerified
      ? '<label class="toggle" style="margin-top:10px"><span>People can find me by my verified number<small>Only your name and photo are shown, never the number.</small></span><input type="checkbox" id="pdisc"' + (st.discoverable ? " checked" : "") + "></label>"
      : "";
    gate("<h2>" + (settings ? "Your Vico Message profile" : "Set up your profile") + "</h2><p>" + identityLine + "</p>" +
      '<label class="f" for="pname">Name</label><input id="pname" class="fi" maxlength="40" autocomplete="name" value="' + esc(me.displayName === "User" ? "" : me.displayName) + '">' +
      '<label class="f" for="pabout">About</label><input id="pabout" class="fi" maxlength="139" value="' + esc(me.about || "Hey there! I use Vico Message.") + '">' +
      phoneRow + discoverToggle +
      '<label class="toggle"><span>Show when I am online<small>If off, you will not see other people\'s status either.</small></span><input type="checkbox" id="ponl"' + (st.showOnline ? " checked" : "") + "></label>" +
      '<div class="err" id="gerr" role="alert"></div><button class="btn-main" id="saveProf" type="button">' + (settings ? "Save" : "Start messaging") + "</button>" +
      (settings ? '<p style="text-align:center;margin:10px 0 0"><button class="link" id="closeSet" type="button">Close</button></p>' : ""), settings ? 0 : 4);
    if ($("closeSet")) $("closeSet").onclick = enter;
    if ($("verifyPhoneNow")) $("verifyPhoneNow").onclick = gatePhone;
    $("saveProf").onclick = function () {
      var b = this; b.disabled = true;
      var body = { displayName: $("pname").value, about: $("pabout").value, showOnline: $("ponl").checked };
      if ($("pdisc")) body.discoverable = $("pdisc").checked;
      api("/api/vm/profile", body).then(function (d) {
        b.disabled = false; if (!d.success) { $("gerr").textContent = d.message || "Could not save."; return; }
        loadStatus().then(enter);
      }).catch(function () { b.disabled = false; $("gerr").textContent = "Connection problem. Please try again."; });
    };
  }

  /* ---------- tabs ---------- */
  function setTab(tab) {
    S.tab = tab;
    ["message", "chat", "call"].forEach(function (t) { $("tab-" + t).setAttribute("aria-selected", t === tab); $("panel-" + t).hidden = t !== tab; });
    if (tab === "message") { loadPeople(); loadBiz(); loadOnline(); loadAdvertisers(); }
    if (tab === "chat") loadThreads();
    if (tab === "call") { loadCalls(); try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) {} $("callBadge").hidden = true; }
  }
  function backToList() {
    cancelRec();
    S.cur = null; $("vm").classList.remove("in-chat"); document.body.classList.remove("vm-inchat");
    $("conv").hidden = true; $("hello").hidden = false; $("chMenu").hidden = true; $("emoji").hidden = true; loadThreads();
  }

  /* ---------- chats list ---------- */
  function loadThreads() {
    return api("/api/dm/threads").then(function (d) {
      if (d.needsVerification) return needVerify();
      if (!d.success) { $("threads").innerHTML = '<div class="empty">' + esc(d.message || "Could not load your chats.") + "</div>"; return; }
      S.threads = d.threads; drawThreads(); setTitle();
      var n = d.threads.reduce(function (a, t) { return a + (t.unread || 0); }, 0), b = $("chatBadge"); b.hidden = !n; b.textContent = n > 99 ? "99+" : n;
    }).catch(function () {});
  }
  function drawThreads() {
    var q = $("filterChats").value.trim().toLowerCase();
    if (q.length >= 2) { $("threads").innerHTML = ""; return findChat(q); }
    $("chatFind").innerHTML = "";
    var list = S.threads.filter(function (t) { return !q || (t.displayName + " " + t.handle).toLowerCase().indexOf(q) >= 0; });
    $("threads").innerHTML = list.map(threadRow).join("") || '<div class="empty">' + (q ? "No chats match." : "No chats yet.<br>Type a person name above to start a chat.") + "</div>";
  }
  function threadRow(t) {
      var pv;
      if (t.kind === "call") { var c = callText(t.meta, t.mine); pv = '<small class="' + (c.red ? "red" : "") + '">' + ico(t.meta && t.meta.kind === "video" ? "video" : "phone", "mini") + esc(c.t) + "</small>"; }
      else pv = "<small>" + (t.mine ? tick(t.state) : "") + esc(t.preview) + "</small>";
      return '<div class="row' + (S.cur === t.handle ? " on" : "") + '" data-h="' + esc(t.handle) + '" role="button" tabindex="0">' + avatar(t) + '<div class="t"><b>' + esc(t.displayName) + "</b>" + pv + '</div><div class="r"><span>' + short(t.lastAt) + "</span>" + (t.unread ? "<em>" + t.unread + "</em>" : "") + "</div></div>";
      }
  // Chat tab: type a person's name, their name appears with a Chat button; tapping opens the same page the Message button opens.
  function findChat(q) {
    api("/api/vm/contacts/search?q=" + encodeURIComponent(q)).then(function (d) {
      if ($("filterChats").value.trim().toLowerCase() !== q) return;
      var mine = S.threads.filter(function (t) { return (t.displayName + " " + t.handle).toLowerCase().indexOf(q) >= 0; });
      $("chatFind").innerHTML = d.success ? (d.people.map(function (p) { return personRow(p, "chat"); }).join("") || (mine.length ? "" : '<div class="empty" style="padding:18px 22px">No one found. Check the spelling.</div>')) : '<div class="empty">' + esc(d.message || "Search failed.") + "</div>";
      if (mine.length) $("threads").innerHTML = '<h2 class="vm-h">Your chats</h2>' + mine.map(threadRow).join("");
    });
  }
  function needVerify() { loadStatus().then(function (st) { if (!st.phoneVerified && (st.phoneRequired || st.advertiserPending || !st.emailVerified)) gatePhone(); else if (st.emailVerified) gateProfile(false); else gateEmail(); }); }

  /* ---------- Message tab: people and businesses ---------- */
  function personRow(p, kind) {
    var sub = p.about ? esc(p.about) : "@" + esc(p.handle);
    return '<div class="row" data-open="' + esc(p.handle) + '">' + avatar(p) + '<div class="t"><b>' + esc(p.displayName) + "</b><small>" + sub + '</small></div><div class="acts">' +
      (kind === "call" ? '<button class="round" data-call="' + esc(p.handle) + '" data-kind="voice" type="button" aria-label="Voice call ' + esc(p.displayName) + '">' + ico("phone") + '</button><button class="round vid" data-call="' + esc(p.handle) + '" data-kind="video" type="button" aria-label="Video call ' + esc(p.displayName) + '">' + ico("video") + "</button>"
        : '<button class="pill" data-open="' + esc(p.handle) + '" type="button">' + (kind === "chat" ? "Chat" : "Message") + "</button>") + "</div></div>";
  }
  function loadPeople() {
    var q = $("findPeople").value.trim(), out = $("peopleOut");
    if (q.length < 2) { out.innerHTML = '<div class="empty" style="padding:18px 22px">Search by name or @username to start a conversation.</div>'; return; }
    api("/api/vm/contacts/search?q=" + encodeURIComponent(q)).then(function (d) {
      if (q !== $("findPeople").value.trim()) return;
      out.innerHTML = d.success ? (d.people.map(function (p) { return personRow(p, "msg"); }).join("") || '<div class="empty" style="padding:18px 22px">No one found. Check the spelling, or ask them to join Vico Message.</div>') : '<div class="empty">' + esc(d.message || "Search failed.") + "</div>";
    });
  }
  function loadBiz() {
    var q = $("findPeople").value.trim();
    api("/api/vm/businesses?q=" + encodeURIComponent(q.length >= 2 ? q : "")).then(function (d) {
      var list = d.success ? d.businesses : [];
      $("bizHead").hidden = !list.length;
      $("bizOut").innerHTML = list.map(function (b) {
        var tel = b.phone && !b.canCall ? '<a class="round" href="tel:' + esc(b.phone.replace(/[^\d+]/g, "")) + '" aria-label="Phone ' + esc(b.businessName) + '">' + ico("phone") + "</a>" : "";
        return '<div class="row" data-open="' + esc(b.handle) + '">' + avatar(b, true) + '<div class="t"><b>' + esc(b.businessName) + (b.numberVerified ? ' <span class="tag">' + ico("check", "mini") + "Verified number</span>" : "") + "</b><small>" + esc([b.city, b.description].filter(Boolean).join(" · ")) + '</small></div><div class="acts"><button class="pill" data-open="' + esc(b.handle) + '" type="button">Message</button>' +
          (b.canCall ? '<button class="round" data-call="' + esc(b.handle) + '" data-kind="voice" type="button" aria-label="Call ' + esc(b.businessName) + '">' + ico("phone") + "</button>" : "") + tel + "</div></div>";
      }).join("");
    });
  }

  function loadOnline() {
    var q = $("findPeople").value.trim();
    api("/api/vm/online?q=" + encodeURIComponent(q.length >= 2 ? q : "")).then(function (d) {
      var list = d.success ? d.people : [];
      $("onlineHead").textContent = "People online" + (d.success ? " (" + d.total + ")" : ""); $("onlineHead").hidden = !d.success;
      $("onlineOut").innerHTML = list.map(function (p) { return personRow(p, "msg"); }).join("") || (d.success ? '<div class="empty" style="padding:14px 22px">No one else is online right now.</div>' : "");
    });
  }
  function loadAdvertisers() {
    var q = $("findPeople").value.trim();
    api("/api/vm/advertisers?q=" + encodeURIComponent(q.length >= 2 ? q : "")).then(function (d) {
      var list = d.success ? d.advertisers : [];
      $("advHead").hidden = !list.length;
      $("advOut").innerHTML = list.map(function (b) {
        var tel = b.phone ? '<a class="round" href="tel:' + esc(b.phone.replace(/[^\d+]/g, "")) + '" aria-label="Phone ' + esc(b.businessName) + '">' + ico("phone") + "</a>" : "";
        return '<div class="row" data-open="' + esc(b.handle) + '">' + avatar(b, true) + '<div class="t"><b>' + esc(b.businessName) + (b.active ? "" : ' <span class="tag" style="background:#fff3d6;color:#7a5a12">Not active yet</span>') + "</b><small>" + esc(b.phone || "") + '</small></div><div class="acts"><button class="pill" data-open="' + esc(b.handle) + '" type="button">Message</button><button class="round" data-call="' + esc(b.handle) + '" data-kind="voice" type="button" aria-label="Call ' + esc(b.businessName) + '">' + ico("phone") + "</button>" + tel + "</div></div>";
      }).join("");
    });
  }

  /* ---------- Call tab ---------- */
  function loadCalls() {
    return api("/api/vm/calls/history").then(function (d) {
      if (!d.success) { $("calls").innerHTML = '<div class="empty">' + esc(d.message || "Could not load calls.") + "</div>"; return; }
      S.calls = d.calls; var seen = 0; try { seen = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) {}
      var missed = d.calls.filter(function (c) { return c.direction === "in" && (c.status === "missed" || c.status === "cancelled") && c.at > seen; }).length;
      var b = $("callBadge"); b.hidden = !missed || S.tab === "call"; b.textContent = missed;
      $("calls").innerHTML = d.calls.map(function (c) {
        var inc = c.direction === "in", miss = inc && (c.status === "missed" || c.status === "cancelled"), label = miss ? "Missed" : c.status === "declined" ? "Declined" : inc ? "Incoming" : (c.status === "missed" || c.status === "cancelled") ? "No answer" : "Outgoing";
        return '<div class="row" data-open="' + esc(c.handle) + '">' + avatar(c) + '<div class="t"><b class="' + (miss ? "red" : "") + '">' + esc(c.displayName) + '</b><small class="' + (miss ? "red" : "") + '">' + ico(inc ? "in" : "out", "mini") + label + " " + (c.kind === "video" ? "video" : "voice") + " · " + short(c.at) + (c.duration ? " · " + dur(c.duration) : "") + '</small></div><div class="acts"><button class="round" data-call="' + esc(c.handle) + '" data-kind="voice" type="button" aria-label="Voice call ' + esc(c.displayName) + '">' + ico("phone") + '</button><button class="round vid" data-call="' + esc(c.handle) + '" data-kind="video" type="button" aria-label="Video call ' + esc(c.displayName) + '">' + ico("video") + "</button></div></div>";
      }).join("") || '<div class="empty">No calls yet.<br>Search someone above, or open a chat and tap the phone or camera.</div>';
    }).catch(function () {});
  }
  function findCall() {
    var q = $("findCall").value.trim(), out = $("callFind"); if (q.length < 2) { out.innerHTML = ""; return; }
    api("/api/vm/contacts/search?q=" + encodeURIComponent(q)).then(function (d) {
      if (q !== $("findCall").value.trim()) return;
      out.innerHTML = d.success ? d.people.map(function (p) { return personRow(p, "call"); }).join("") || '<div class="empty" style="padding:14px 22px">No one found.</div>' : "";
    });
  }

  /* ---------- conversation ---------- */
  function presence(p, info) {
    if (p && p.visible) { if (p.online) return { t: "online", live: true }; if (p.lastSeen) { var d = new Date(p.lastSeen); return { t: "last seen " + (sameDay(d, new Date()) ? "today" : dayName(p.lastSeen).toLowerCase()) + " at " + clock(p.lastSeen) }; } }
    return { t: info && info.about ? info.about : "@" + (info ? info.handle : "") };
  }
  function setSub(txt, live) { var s = $("chSub"); s.textContent = txt; s.className = live ? "live" : ""; }
  function openChat(handle, prefill) {
    if (REC && REC.handle !== h0(arguments[0])) cancelRec();
    if (!handle) return;
    S.cur = handle; S.lastId = 0; S.ids = {}; S.lastDay = ""; S.info = null;
    $("msgs").innerHTML = ""; $("vm").classList.add("in-chat"); document.body.classList.add("vm-inchat");
    $("hello").hidden = true; $("conv").hidden = false; $("chMenu").hidden = true; $("emoji").hidden = true;
    $("chName").textContent = "…"; setSub("");
    api("/api/dm/with/" + encodeURIComponent(handle)).then(function (d) {
      if (S.cur !== handle) return;
      if (d.needsVerification) return needVerify();
      if (!d.success) { say(d.message || "Could not open the chat."); backToList(); return; }
      S.info = d.with; $("chName").textContent = d.with.displayName; $("chAv").outerHTML = avatar(d.with).replace('class="av"', 'class="av" id="chAv"');
      var p = presence(d.presence, d.with); setSub(p.t, p.live);
      $("chVoice").disabled = $("chVideo").disabled = !d.with.activated; $("chVoice").title = $("chVideo").title = d.with.activated ? "" : d.with.displayName + " has not activated Vico Message yet";
      applyBlocked(d.blockedByMe);
      if (!d.with.activated) addNotice(d.with.displayName + " has not activated Vico Message yet. Your messages will be waiting for them, but you cannot call them yet.");
      if (!d.messages.length) addNotice("No messages yet. Say hello 👋");
      draw(d.messages); applyStates(d.states);
      if (prefill) { $("in").value = prefill; autoGrow(); }
      $("in").focus({ preventScroll: true }); loadThreads();
    });
  }
  function applyBlocked(b) { S.blocked = !!b; $("composer").hidden = !!b; $("blockedBar").hidden = !b; }
  function addNotice(t) { var n = document.createElement("div"); n.className = "notice"; n.textContent = t; $("msgs").appendChild(n); }
  function scrollEnd(force) { var el = $("msgs"); if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight; }
  function draw(list, forceScroll) {
    var box = $("msgs"), prev = null;
    list.forEach(function (m) {
      if (S.ids[m.id]) return; S.ids[m.id] = true; S.lastId = Math.max(S.lastId, m.id);
      var n0 = box.querySelector(".notice"); if (n0 && !n0.dataset.keep && !n0.textContent.indexOf("No messages yet")) n0.remove();
      var dk = new Date(m.at).toDateString();
      if (dk !== S.lastDay) { S.lastDay = dk; var dv = document.createElement("div"); dv.className = "day"; dv.textContent = dayName(m.at); box.appendChild(dv); }
      box.appendChild(msgNode(m));
    });
    removeTyping(); scrollEnd(forceScroll !== false);
  }
  var OPT = '<button class="mopt" type="button" aria-label="Message options">⌄</button>';
  function msgNode(m) {
    var el = document.createElement("div");
    if (m.kind === "call") {
      var c = callText(m.meta, m.mine); el.className = "callmsg"; el.dataset.id = m.id;
      el.innerHTML = '<span class="' + (c.red ? "red" : "") + '" style="display:flex">' + ico(m.meta && m.meta.kind === "video" ? "video" : "phone", "mini") + "</span><span" + (c.red ? ' class="red"' : "") + ">" + esc(c.t) + "</span>" + (c.extra ? "<small>" + c.extra + "</small>" : "") + "<small>" + clock(m.at) + "</small>";
      return el;
    }
    if (m.kind === "deleted") { el.className = "m gone " + (m.mine ? "me" : "them"); el.dataset.id = m.id; el.dataset.at = m.at; el.innerHTML = "🚫 " + (m.mine ? "You deleted this message" : "This message was deleted") + '<div class="meta"><span>' + clock(m.at) + "</span></div>"; return el; }
    if (m.kind === "image" || m.kind === "voice") return mediaNode(m);
    el.className = "m " + (m.mine ? "me" : "them"); el.dataset.id = m.id; if (m.mine) el.dataset.state = m.state || "sent";
    el.dataset.at = m.at;
    el.innerHTML = linkify(esc(m.body)) + '<div class="meta"><span>' + clock(m.at) + "</span>" + (m.mine ? '<span class="st">' + tick(m.state || "sent") + "</span>" : "") + OPT + "</div>";
    return el;
  }
  var RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };
  function setState(el, state) {
    if (!el || (RANK[el.dataset.state] || 0) >= RANK[state]) return;
    el.dataset.state = state; var s = el.querySelector(".st"); if (s) s.innerHTML = tick(state);
  }
  function applyStates(list) { (list || []).forEach(function (s) { setState($("msgs").querySelector('.m.me[data-id="' + s.id + '"]'), s.state); }); }
  function applyUpTo(state, upTo) { [].forEach.call($("msgs").querySelectorAll(".m.me"), function (el) { if (Number(el.dataset.id) <= upTo) setState(el, state); }); }
  function showTyping() {
    setSub("typing…", true); S.typingUntil = Date.now() + 4000;
    if (!$("typingEl")) { var t = document.createElement("div"); t.id = "typingEl"; t.className = "typing"; t.innerHTML = "<i></i><i></i><i></i>"; $("msgs").appendChild(t); scrollEnd(); }
    setTimeout(function () { if (Date.now() >= S.typingUntil) { removeTyping(); refreshPresence(); } }, 4100);
  }
  function removeTyping() { var t = $("typingEl"); if (t) t.remove(); }
  function refreshPresence() {
    if (!S.cur) return; var h = S.cur;
    api("/api/dm/with/" + encodeURIComponent(h) + "?after=" + S.lastId).then(function (d) { if (d.success && S.cur === h) { var p = presence(d.presence, d.with); if (Date.now() >= S.typingUntil) setSub(p.t, p.live); if (d.messages.length) draw(d.messages); applyStates(d.states); } });
  }

  /* ---------- sending ---------- */
  function autoGrow() { var t = $("in"); t.style.height = "auto"; t.style.height = Math.min(130, t.scrollHeight) + "px"; $("sendBtn").disabled = !t.value.trim(); }
  function send() {
    var inp = $("in"), body = inp.value.trim(), h = S.cur; if (!body || !h) return;
    inp.value = ""; autoGrow(); $("emoji").hidden = true;
    var tmp = { id: "t" + Date.now(), body: body, at: Date.now(), mine: true, kind: "text", state: "pending" };
    var el = msgNode(tmp); el.dataset.id = tmp.id; el.dataset.state = "pending"; var dk = new Date().toDateString();
    if (dk !== S.lastDay) { S.lastDay = dk; var dv = document.createElement("div"); dv.className = "day"; dv.textContent = "Today"; $("msgs").appendChild(dv); }
    var n0 = $("msgs").querySelector(".notice"); if (n0 && n0.textContent.indexOf("No messages yet") === 0) n0.remove();
    $("msgs").appendChild(el); removeTyping(); scrollEnd(true); S.sending++;
    api("/api/dm/with/" + encodeURIComponent(h), { body: body }).then(function (d) {
      S.sending--;
      if (d.success) {
        if (S.ids[d.message.id]) { el.remove(); } else { S.ids[d.message.id] = true; S.lastId = Math.max(S.lastId, d.message.id); el.dataset.id = d.message.id; el.dataset.state = "pending"; setState(el, d.message.state); }
        if (d.balance != null) setWallet(d.balance);
        loadThreads();
      } else { fail(el, body, d.insufficient ? "Not sent: insufficient balance" : d.message); if (d.insufficient) needRecharge(d.message, d.walletUrl); }
    }).catch(function () { S.sending--; fail(el, body, "No connection."); });
  }
  function fail(el, body, msg) {
    el.classList.add("failed"); el.querySelector(".meta").innerHTML = "<span>" + esc(msg || "Not sent") + '</span><button type="button">Retry</button>';
    el.querySelector("button").onclick = function () { el.remove(); $("in").value = body; autoGrow(); send(); };
  }

  /* ---------- realtime ---------- */
  function conn(on) { $("conn").classList.toggle("on", !on && !S.stream.stop); }
  function startStream() {
    if (S.stream.on || S.stream.stop) return;
    var ctl = new AbortController(); S.stream.ctl = ctl; S.stream.on = true;
    fetch("/api/vm/stream", { signal: ctl.signal, headers: { Accept: "text/event-stream" } }).then(function (res) {
      if (!res.ok || !res.body) throw new Error("stream " + res.status);
      S.stream.fails = 0; conn(true); loadThreads();
      var rd = res.body.getReader(), dec = new TextDecoder(), buf = "";
      function pump() {
        return rd.read().then(function (r) {
          if (r.done) throw new Error("closed");
          buf += dec.decode(r.value, { stream: true }); var i;
          while ((i = buf.indexOf("\n\n")) >= 0) { var f = buf.slice(0, i); buf = buf.slice(i + 2); var ev = /^event: (.+)$/m.exec(f), da = /^data: (.+)$/m.exec(f); if (ev && da) { try { onEvent(ev[1], JSON.parse(da[1])); } catch (e) {} } }
          return pump();
        });
      }
      return pump();
    }).catch(function () {}).then(function () {
      S.stream.on = false; conn(false);
      if (!S.stream.stop) setTimeout(startStream, Math.min(15000, 1500 * (++S.stream.fails)));
    });
  }
  function onEvent(ev, d) {
    if (ev === "message") {
      var m = d.message;
      if (S.cur === d["with"]) { if (!m.mine) S.typingUntil = 0; draw([m]); if (!m.mine) refreshPresence(); } else if (!m.mine && m.kind !== "call") say(d.name + ": " + m.body.slice(0, 60));
      loadThreads(); if (m.kind === "call") loadCalls();
    } else if (ev === "receipt") { if (S.cur === d.by) applyUpTo(d.state, d.upTo); loadThreads(); }
    else if (ev === "message_deleted") {
      if (S.cur === d["with"]) { var gone = $("msgs").querySelector('.m[data-id="' + d.id + '"]'); if (gone && !gone.classList.contains("gone")) gone.replaceWith(msgNode({ id: d.id, at: Number(gone.dataset.at) || Date.now(), mine: !!d.mine, kind: "deleted" })); }
      loadThreads();
    }
    else if (ev === "message_hidden") {   // I deleted this message "for me" in another tab or on another phone
      if (S.cur === d["with"]) { var hid = $("msgs").querySelector('.m[data-id="' + d.id + '"],.callmsg[data-id="' + d.id + '"]'); if (hid) dropNode(hid); }
      loadThreads();
    }
    else if (ev === "chat_deleted") {     // I deleted the whole chat in another tab or on another phone
      if (S.cur === d["with"]) { cancelRec(); closeSheet(); closeMsgMenu(); backToList(); } else loadThreads();
    }
    else if (ev === "typing") { if (S.cur === d.from) showTyping(); }
    else if (ev === "call_incoming") onIncoming(d);
    else if (ev === "call_update") onCallUpdate(d);
    else if (ev === "call_balance") { if (call && d.callId === call.id) needRecharge("Your wallet balance is almost finished. Recharge to keep talking.", d.walletUrl); }
  }
  // when the stream is down (or as a safety net) the page still refreshes by itself
  setInterval(function () {
    if (document.hidden || $("vm").hidden) return;
    if (!S.stream.on) { loadThreads(); if (S.cur && !S.sending) refreshPresence(); api("/api/vm/calls/incoming").then(function (d) { if (d.success && d.calls.length && !call) onIncoming({ callId: d.calls[0].callId, kind: d.calls[0].kind, from: d.calls[0].from }); }); }
  }, 6000);
  setInterval(function () { if (S.stream.on && !document.hidden && !$("vm").hidden) { loadThreads(); if (S.cur) refreshPresence(); } }, 30000);

  /* ---------- calls ---------- */
  var call = null, ac = null, ringT = null;
  function tone(f, d) { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === "suspended") ac.resume(); var o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.16, ac.currentTime + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d); o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + d + 0.05); } catch (e) {} }
  function startRing(incoming) {
    stopRing();
    function beat() { if (incoming) { tone(880, 0.32); setTimeout(function () { tone(660, 0.32); }, 380); if (navigator.vibrate) try { navigator.vibrate([300, 150, 300]); } catch (e) {} } else tone(440, 0.9); }
    beat(); ringT = setInterval(beat, incoming ? 2300 : 3200);
  }
  function stopRing() { clearInterval(ringT); ringT = null; if (navigator.vibrate) try { navigator.vibrate(0); } catch (e) {} }
  function mediaError(e, kind) {
    var n = e && e.name; if (n === "NotAllowedError" || n === "PermissionDeniedError") return "Allow the microphone" + (kind === "video" ? " and camera" : "") + " in your browser to make calls.";
    if (n === "NotFoundError") return "No " + (kind === "video" ? "camera or " : "") + "microphone was found."; if (!window.isSecureContext) return "Calls need a secure (https) connection."; return "Could not start your microphone" + (kind === "video" ? " or camera" : "") + ".";
  }
  function getTracks(kind) { return window.LivekitClient.createLocalTracks({ audio: true, video: kind === "video" ? { facingMode: "user" } : false }); }
  function stopTracks(c) { (c && c.tracks || []).forEach(function (t) { try { t.stop(); } catch (e) {} }); }

  function showCall() {
    var L = $("callLayer"); L.classList.add("on"); L.classList.toggle("video-on", call.kind === "video");
    $("callName").textContent = call.peer.displayName; $("callAv").innerHTML = call.peer.avatar ? '<img src="' + esc(call.peer.avatar) + '" alt="">' : esc((call.peer.displayName || "?").charAt(0).toUpperCase());
    $("callStage").classList.toggle("ringing", call.state === "ringing" || call.state === "incoming");
    $("remoteVideo").style.display = "none"; $("localVideo").style.display = "none";
    if (call.kind === "video" && call.tracks) { var v = call.tracks.filter(function (t) { return t.kind === "video"; })[0]; if (v) { v.attach($("localVideo")); $("localVideo").style.display = "block"; } }
    callStatus(); renderCtl();
  }
  function callStatus() {
    var st = { incoming: "Incoming " + call.kind + " call", ringing: call.calleeOnline === false ? "Calling…" : "Ringing…", connecting: "Connecting…", active: call.connected ? dur((Date.now() - call.t0) / 1000) : "Connecting…" }[call.state] || "";
    $("callState").textContent = st; $("callStage").classList.toggle("ringing", call.state === "ringing" || call.state === "incoming"); document.title = call.state === "incoming" ? "📞 Incoming call - Vico Message" : document.title;
  }
  function renderCtl() {
    var c = $("callCtl"); c.classList.toggle("incoming", call.state === "incoming"); function b(cls, id, label, icon, off) { return '<div><button class="cbtn ' + cls + (off ? " off" : "") + '" id="' + id + '" type="button" aria-label="' + label + '">' + ico(icon) + "</button><small>" + label + "</small></div>"; }
    if (call.state === "incoming") c.innerHTML = b("end", "cDecline", "Decline", "phone") + b("accept", "cAccept", "Accept", call.kind === "video" ? "video" : "phone");
    else c.innerHTML = b("", "cMute", call.muted ? "Unmute" : "Mute", call.muted ? "micoff" : "mic", call.muted) + (call.kind === "video" ? b("", "cCam", call.camOff ? "Camera on" : "Camera off", call.camOff ? "camoff" : "video", call.camOff) : "") + b("end", "cEnd", call.state === "ringing" ? "Cancel" : "End", "phone");
  }
  function cleanup(msg) {
    var c = call; call = null; stopRing(); if (!c) return; clearInterval(c.timer);
    try { if (c.room) c.room.disconnect(); } catch (e) {} stopTracks(c);
    $("audioSink").innerHTML = ""; $("remoteVideo").srcObject = null; $("localVideo").srcObject = null; $("callLayer").classList.remove("on");
    setTitle(); if (msg) say(msg); loadThreads(); loadCalls(); loadWallet(); if (S.cur) refreshPresence();
  }
  function connectRoom(c) {
    var LK = window.LivekitClient;
    return api("/api/vm/calls/" + c.id + "/token", {}).then(function (t) {
      if (!t.success) throw new Error(t.message || "Could not connect the call.");
      var room = new LK.Room({ adaptiveStream: true, dynacast: true }); c.room = room;
      room.on(LK.RoomEvent.TrackSubscribed, function (track) {
        if (track.kind === "video") { track.attach($("remoteVideo")); $("remoteVideo").style.display = "block"; }
        else { $("audioSink").appendChild(track.attach()); }
        markConnected(c);
      });
      room.on(LK.RoomEvent.ParticipantDisconnected, function () { if (call === c && c.state === "active") hangup("Call ended"); });
      room.on(LK.RoomEvent.Disconnected, function () { if (call === c && c.state === "active" && !c.leaving) hangup("Call ended"); });
      return room.connect(t.url, t.token).then(function () {
        if (room.startAudio) room.startAudio().catch(function () {});
        return Promise.all((c.tracks || []).map(function (tr) { return room.localParticipant.publishTrack(tr); }));
      });
    });
  }
  function markConnected(c) {
    if (call !== c || c.connected) return; c.connected = true; c.t0 = Date.now(); stopRing();
    clearInterval(c.timer); c.timer = setInterval(callStatus, 1000); callStatus();
  }
  function startCall(handle, kind) {
    if (call) return say("You are already on a call.");
    if (!window.LivekitClient) return say("Calling could not load. Check your connection and refresh the page.");
    if (S.status && S.status.callsReady === false) return say("Calling is not switched on yet.");
    getTracks(kind).then(function (tracks) {
      return api("/api/vm/calls/start", { handle: handle, kind: kind }).then(function (d) {
        if (!d.success) { stopTracks({ tracks: tracks }); if (d.insufficient) needRecharge(d.message, d.walletUrl); else say(d.message || "Could not place the call."); if (d.needsVerification) needVerify(); return; }
        call = { id: d.callId, kind: kind, dir: "out", peer: d["with"], state: "ringing", tracks: tracks, calleeOnline: d.calleeOnline };
        showCall(); startRing(false); var c = call;
        connectRoom(c).catch(function (e) { if (call === c) hangup(e.message || "Could not connect the call."); });
      });
    }, function (e) { say(mediaError(e, kind)); });
  }
  function onIncoming(d) {
    if (call || !d || !d.callId) return;
    call = { id: d.callId, kind: d.kind === "video" ? "video" : "voice", dir: "in", peer: d.from, state: "incoming" };
    showCall(); startRing(true);
  }
  function acceptCall() {
    var c = call; if (!c || c.state !== "incoming" || c.accepting) return; c.accepting = true; stopRing();   // accepting: ignore the server's "active" event that can arrive before our own reply
    getTracks(c.kind).then(function (tracks) {
      c.tracks = tracks;
      return api("/api/vm/calls/" + c.id + "/accept", {}).then(function (d) {
        if (!d.success) { cleanup(d.message || "The call has ended."); return; }
        c.state = "active"; showCall();
        return connectRoom(c).catch(function (e) { if (call === c) hangup(e.message || "Could not connect the call."); });
      });
    }, function (e) { api("/api/vm/calls/" + c.id + "/decline", {}); cleanup(mediaError(e, c.kind)); });
  }
  function hangup(msg) {
    var c = call; if (!c) return; c.leaving = true;
    var path = c.state === "incoming" ? "decline" : c.state === "ringing" && c.dir === "out" ? "cancel" : "end";
    api("/api/vm/calls/" + c.id + "/" + path, {}); cleanup(typeof msg === "string" ? msg : "");
  }
  function onCallUpdate(d) {
    if (call && d.callId === call.id) {
      if (d.status === "active") { if (call.dir === "out" && call.state === "ringing") { call.state = "active"; stopRing(); showCall(); } else if (call.state === "incoming" && !call.accepting) cleanup(""); }   // answered on another device
      else if (d.reason === "balance") { var cb = call; cb.leaving = true; var mine = cb.dir === "out"; cleanup(mine ? "" : "Call ended."); if (mine) needRecharge("Your call ended because you have insufficient balance. Recharge to keep calling.", d.walletUrl); }
      else { var c = call; c.leaving = true; cleanup({ declined: "Call declined.", missed: c.dir === "out" ? "No answer." : "Missed call.", cancelled: c.dir === "out" ? "" : "Missed call.", ended: "Call ended." }[d.status] || ""); }
    }
    loadCalls();
  }
  $("callCtl").onclick = function (e) {
    var b = e.target.closest("button"); if (!b || !call) return;
    if (b.id === "cAccept") acceptCall(); else if (b.id === "cDecline" || b.id === "cEnd") hangup("");
    else if (b.id === "cMute") { call.muted = !call.muted; (call.tracks || []).forEach(function (t) { if (t.kind === "audio") { call.muted ? t.mute() : t.unmute(); } }); renderCtl(); }
    else if (b.id === "cCam") { call.camOff = !call.camOff; (call.tracks || []).forEach(function (t) { if (t.kind === "video") { call.camOff ? t.mute() : t.unmute(); } }); renderCtl(); }
  };

  /* ---------- wiring ---------- */

  /* ---------- wallet button (top right) ---------- */
  function setWallet(b) {
    b = Number(b); if (!isFinite(b)) return; S.walletBal = b;
    var el = $("walletBal"), btn = $("walletBtn"); if (!el || !btn) return;
    el.textContent = b.toLocaleString("en-NG"); btn.classList.toggle("low", b < 20);
    btn.setAttribute("aria-label", "VicoPay Wallet, balance " + b.toLocaleString("en-NG") + " naira");
  }
  function loadWallet() { return api("/api/wallet/balance").then(function (d) { if (d && d.success) { S.rates = d.rates || S.rates; setWallet(d.balance); } }).catch(function () {}); }

  /* ---------- photos and voice notes ---------- */
  var BLOBS = {}, PLAYING = null;
  function loadBlob(id) {
    if (!id) return Promise.reject(new Error("no file"));
    if (!BLOBS[id]) BLOBS[id] = fetch("/api/vm/media/" + encodeURIComponent(id)).then(function (r) { if (!r.ok) throw new Error("gone"); return r.blob(); }).then(function (b) { return URL.createObjectURL(b); });
    BLOBS[id].catch(function () { delete BLOBS[id]; });   // a failed load can be tried again
    return BLOBS[id];
  }
  function mm(secs) { secs = Math.max(0, Math.round(secs)); return Math.floor(secs / 60) + ":" + pad(secs % 60); }
  function mediaNode(m) {
    var el = document.createElement("div"), meta = m.meta || {};
    el.className = "m media " + (m.mine ? "me" : "them"); el.dataset.id = m.id; if (m.mine) el.dataset.state = m.state || "sent";
    el.dataset.at = m.at;
    var foot = '<div class="meta"><span>' + clock(m.at) + "</span>" + (m.mine ? '<span class="st">' + tick(m.state || "sent") + "</span>" : "") + OPT + "</div>";
    if (m.kind === "image") {
      el.innerHTML = '<div class="pic wait">Loading photo…</div>' + foot;
      loadBlob(meta.mediaId).then(function (url) {
        var w = el.querySelector(".pic"); if (!w) return;
        var img = document.createElement("img"); img.className = "pic"; img.alt = "Photo"; img.src = url;
        if (meta.w && meta.h) img.style.aspectRatio = meta.w + " / " + meta.h;
        img.onclick = function () { openSheet(url); };
        w.replaceWith(img);
      }, function () { var w = el.querySelector(".pic"); if (w) w.textContent = "Photo unavailable"; });
      return el;
    }
    el.innerHTML = '<div class="vn"><button type="button" aria-label="Play voice note"><svg class="i"><use href="#i-play"/></svg></button><div class="bar"><i></i></div><span class="dur">' + mm(meta.duration) + "</span></div>" + foot;
    var btn = el.querySelector("button"), bar = el.querySelector(".bar i"), dur = el.querySelector(".dur"), au = null;
    function icon(name) { btn.innerHTML = '<svg class="i"><use href="#i-' + name + '"/></svg>'; btn.setAttribute("aria-label", name === "pause" ? "Pause voice note" : "Play voice note"); }
    function reset() { icon("play"); bar.style.width = "0"; dur.textContent = mm(meta.duration); }
    btn.onclick = function () {
      if (au && !au.paused) { au.pause(); icon("play"); return; }
      if (PLAYING && PLAYING !== au && PLAYING.pause) PLAYING.pause();
      function go() { PLAYING = au; au.play().then(function () { icon("pause"); }, function () { say("This voice note could not be played."); reset(); }); }
      if (au) return go();
      btn.disabled = true;
      loadBlob(meta.mediaId).then(function (url) {
        au = new Audio(url); btn.disabled = false;
        au.ontimeupdate = function () { var t = meta.duration || au.duration || 1; bar.style.width = Math.min(100, au.currentTime / t * 100) + "%"; dur.textContent = mm(au.currentTime); };
        au.onended = function () { reset(); au.currentTime = 0; };
        au.onpause = function () { if (!au.ended) icon("play"); };
        go();
      }, function () { btn.disabled = false; say("This voice note could not be loaded."); });
    };
    return el;
  }
  function openSheet(url, onSend, note) {
    var sh = $("sheet"); $("sheetImg").src = url; $("sheetNote").textContent = note || "";
    $("sheetOk").hidden = !onSend; $("sheetOk").disabled = false; $("sheetOk").textContent = "Send photo"; $("sheetNo").textContent = onSend ? "Cancel" : "Close";
    S.sheetSend = onSend || null; sh.classList.add("on"); $("sheetNo").focus();
  }
  function closeSheet() { $("sheet").classList.remove("on"); $("sheetImg").src = ""; S.sheetSend = null; S.pendingPhoto = null; }

  // Photos are shrunk in the browser first (longest side 1600 px, JPEG). That keeps data use and the wait small, and it also removes the
  // location and camera details hidden inside phone photos. Animated GIFs are sent as they are when small enough.
  function shrink(file) {
    return new Promise(function (ok, no) {
      if (file.type === "image/gif" && file.size <= 3.5 * 1024 * 1024) { var g = new Image(), gu = URL.createObjectURL(file); g.onload = function () { ok({ blob: file, w: g.naturalWidth, h: g.naturalHeight }); URL.revokeObjectURL(gu); }; g.onerror = function () { no(new Error("bad")); }; g.src = gu; return; }
      var img = new Image(), u = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
        var c = document.createElement("canvas"); c.width = w; c.height = h; var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(u);
        c.toBlob(function (b) { b ? ok({ blob: b, w: w, h: h }) : no(new Error("bad")); }, "image/jpeg", 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(u); no(new Error("bad")); };
      img.src = u;
    });
  }
  function postMedia(handle, kind, blob, extra) {
    return fetch("/api/vm/media/" + encodeURIComponent(handle) + "?kind=" + kind + (extra || ""), { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; }); });
  }
  function afterMediaSent(d) {
    if (d.success) { draw([d.message], true); if (d.balance != null) setWallet(d.balance); loadThreads(); return true; }
    if (d.insufficient) needRecharge(d.message, d.walletUrl); else say(d.message || "Could not send.");
    return false;
  }
  function pickPhoto(file) {
    var h = S.cur; if (!file || !h) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return say("Choose a JPG, PNG, WebP or GIF photo.");
    shrink(file).then(function (p) {
      if (p.blob.size > 4 * 1024 * 1024) return say("That photo is too large.");
      var r = S.rates || { message: 1, firstMessage: 3 }, url = URL.createObjectURL(p.blob);
      S.pendingPhoto = p;
      openSheet(url, function () {
        var ok = $("sheetOk"); ok.disabled = true; ok.textContent = "Sending…";
        postMedia(h, "image", p.blob, "&w=" + p.w + "&h=" + p.h).then(function (d) { afterMediaSent(d); closeSheet(); URL.revokeObjectURL(url); })
          .catch(function () { say("No connection."); ok.disabled = false; ok.textContent = "Send photo"; });
      }, "");
    }, function () { say("That photo could not be opened."); });
  }

  // voice notes: tap the microphone, speak, tap send
  var REC = null, REC_MAX = 120;
  function recMime() { var t = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]; for (var i = 0; i < t.length; i++) { try { if (MediaRecorder.isTypeSupported(t[i])) return t[i]; } catch (e) {} } return ""; }
  function recUi(on) { $("composer").classList.toggle("recording", !!on); if (on) { $("sendBtn").disabled = false; $("recTime").textContent = "0:00"; } else autoGrow(); }
  function startRec() {
    if (REC || !S.cur) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return say("Voice notes are not supported on this browser.");
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = recMime(), rec; try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); return say("Voice notes are not supported on this browser."); }
      var r = { rec: rec, stream: stream, chunks: [], t0: Date.now(), handle: S.cur, send: false };
      rec.ondataavailable = function (e) { if (e.data && e.data.size) r.chunks.push(e.data); };
      rec.onstop = function () {
        clearInterval(r.timer); stream.getTracks().forEach(function (t) { t.stop(); });
        if (REC === r) REC = null; recUi(false);
        var secs = Math.round((Date.now() - r.t0) / 1000);
        if (!r.send) return;
        if (secs < 1) return say("Voice note too short. Tap the microphone and speak, then tap send.");
        var blob = new Blob(r.chunks, { type: (rec.mimeType || mime || "audio/webm").split(";")[0] });
        if (blob.size > 2 * 1024 * 1024) return say("That voice note is too long.");
        postMedia(r.handle, "voice", blob, "&duration=" + Math.min(180, secs)).then(function (d) { if (S.cur === r.handle) afterMediaSent(d); else if (d.success) { if (d.balance != null) setWallet(d.balance); loadThreads(); } else if (d.insufficient) needRecharge(d.message, d.walletUrl); else say(d.message || "Could not send."); })
          .catch(function () { say("No connection. Your voice note was not sent."); });
      };
      r.timer = setInterval(function () { var sec = Math.round((Date.now() - r.t0) / 1000); $("recTime").textContent = mm(sec); if (sec >= REC_MAX) stopRec(true); }, 250);
      REC = r; rec.start(); recUi(true);
    }, function () { say("Allow microphone access to record a voice note."); });
  }
  function stopRec(send) { var r = REC; if (!r) return; r.send = !!send; try { if (r.rec.state !== "inactive") r.rec.stop(); } catch (e) { REC = null; recUi(false); } }
  function cancelRec() { if (REC) stopRec(false); }

  function h0(x) { return String(x || "").replace(/^@/, ""); }

  /* ---------- delete for me / delete for everyone ---------- */
  function dropNode(el) { var prev = el.previousElementSibling, next = el.nextElementSibling; el.remove(); if (prev && prev.classList.contains("day") && (!next || next.classList.contains("day"))) prev.remove(); }
  function closeMsgMenu() { var o = document.getElementById("msgAct"); if (o) o.remove(); }
  function openMsgMenu(el) {
    closeMsgMenu(); if (!el || el.classList.contains("gone") || el.classList.contains("failed")) return;
    var id = Number(el.dataset.id); if (!(id > 0)) return say("Wait until this message is sent.");
    var o = document.createElement("div"); o.id = "msgAct"; o.className = "vm-act"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Message options");
    var box = document.createElement("div"); box.className = "box";
    function add(label, cls, fn) { var b = document.createElement("button"); b.type = "button"; b.textContent = label; if (cls) b.className = cls; b.onclick = fn; box.appendChild(b); return b; }
    add("Delete for me", "", function () { run("me"); });
    if (el.classList.contains("me")) add("Delete for everyone", "danger", function () { run("everyone"); });
    add("Cancel", "cancel", closeMsgMenu);
    o.appendChild(box); o.onclick = function (e) { if (e.target === o) closeMsgMenu(); };
    document.body.appendChild(o); box.querySelector("button").focus();
    function run(scope) {
      closeMsgMenu();
      api("/api/dm/message/" + id + "/delete", { body: { scope: scope } }).then(function (d) {
        if (!d.success) return say(d.message || "Could not delete that message.");
        if (scope === "everyone") el.replaceWith(msgNode({ id: id, at: Number(el.dataset.at) || Date.now(), mine: true, kind: "deleted" }));
        else dropNode(el);
        loadThreads();
      }).catch(function () { say("No connection."); });
    }
  }
  function wire() {
    document.querySelector(".vm-tabs").onclick = function (e) { var b = e.target.closest(".vm-tab"); if (b) setTab(b.dataset.tab); };
    $("vm").addEventListener("click", function (e) {
      var go = e.target.closest("[data-go]"); if (go) return setTab(go.dataset.go);
      var cb = e.target.closest("[data-call]"); if (cb) { e.stopPropagation(); return startCall(cb.dataset.call, cb.dataset.kind); }
      if (e.target.closest("a")) return;
      var o = e.target.closest("[data-open],[data-h]"); if (o) { setTab("chat"); openChat(o.dataset.open || o.dataset.h); }
    });
    $("threads").onkeydown = function (e) { if ((e.key === "Enter" || e.key === " ") && e.target.dataset.h) { e.preventDefault(); openChat(e.target.dataset.h); } };
    $("filterChats").oninput = drawThreads;
    $("findPeople").oninput = function () { clearTimeout(S.searchT); S.searchT = setTimeout(function () { loadPeople(); loadBiz(); loadOnline(); loadAdvertisers(); }, 300); };
    $("findCall").oninput = function () { clearTimeout(S.searchT); S.searchT = setTimeout(findCall, 300); };
    $("back").onclick = backToList;
    $("chVoice").onclick = function () { if (S.cur) startCall(S.cur, "voice"); };
    $("chVideo").onclick = function () { if (S.cur) startCall(S.cur, "video"); };
    $("openSettings").onclick = function () { loadStatus().then(function () { gateProfile(true); }); };
    $("composer").onsubmit = function (e) { e.preventDefault(); if (REC) stopRec(true); else send(); };
    $("msgs").addEventListener("click", function (e) { var b = e.target.closest(".mopt"); if (b) openMsgMenu(b.closest(".m")); });
    $("msgs").addEventListener("contextmenu", function (e) { var m = e.target.closest(".m"); if (m && !e.target.closest("a")) { e.preventDefault(); openMsgMenu(m); } });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMsgMenu(); });
    $("attachBtn").onclick = function () { $("photoIn").click(); };
    $("photoIn").onchange = function () { var f = this.files && this.files[0]; this.value = ""; pickPhoto(f); };
    $("micBtn").onclick = startRec; $("recCancel").onclick = cancelRec;
    $("sheetNo").onclick = closeSheet; $("sheetOk").onclick = function () { if (S.sheetSend) S.sheetSend(); };
    $("sheet").addEventListener("click", function (e) { if (e.target === $("sheet") && !$("sheetOk").disabled) closeSheet(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && $("sheet").classList.contains("on") && !$("sheetOk").disabled) closeSheet(); });
    $("in").oninput = function () {
      autoGrow(); if (S.cur && Date.now() - S.typingSent > 2500 && $("in").value) { S.typingSent = Date.now(); api("/api/vm/typing", { handle: S.cur }); }
    };
    $("in").onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
    var em = $("emoji"); em.innerHTML = EMOJI.map(function (x) { return '<button type="button" aria-label="' + x + '">' + x + "</button>"; }).join("");
    $("emojiBtn").onclick = function () { em.hidden = !em.hidden; };
    em.onclick = function (e) { var b = e.target.closest("button"); if (!b) return; var t = $("in"), s = t.selectionStart || t.value.length; t.value = t.value.slice(0, s) + b.textContent + t.value.slice(t.selectionEnd || s); t.focus(); autoGrow(); };
    $("chMore").onclick = function (e) {
      e.stopPropagation(); var m = $("chMenu"); if (!m.hidden) { m.hidden = true; return; }
      m.innerHTML = '<button type="button" id="mBlock" class="' + (S.blocked ? "" : "danger") + '">' + (S.blocked ? "Unblock contact" : "Block contact") + '</button><button type="button" id="mDelete" class="danger">Delete chat</button><button type="button" id="mClose">Close chat</button>'; m.hidden = false;
      $("mBlock").onclick = function () { toggleBlock(); }; $("mClose").onclick = backToList; $("mDelete").onclick = deleteChat;
    };
    $("unblockBtn").onclick = toggleBlock;
    document.addEventListener("click", function (e) { if (!e.target.closest("#chMenu") && !e.target.closest("#chMore")) $("chMenu").hidden = true; if (!e.target.closest("#emoji") && !e.target.closest("#emojiBtn")) $("emoji").hidden = true; });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { $("chMenu").hidden = true; $("emoji").hidden = true; } });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && S.cur) refreshPresence(); });
  }
  // Delete the whole chat for me only. The other person keeps their copy.
  function deleteChat() {
    var h = S.cur; if (!h) return; $("chMenu").hidden = true;
    if (!confirm("Delete this chat with " + (S.info ? S.info.displayName : "this contact") + "?\n\nAll its messages, photos and voice notes are removed for you only. The other person keeps their copy.")) return;
    api("/api/dm/with/" + encodeURIComponent(h) + "/delete", { body: {} }).then(function (d) {
      if (!d.success) return say(d.message || "Could not delete this chat.");
      cancelRec(); backToList(); say("Chat deleted."); loadThreads();
    }).catch(function () { say("No connection."); });
  }
  function toggleBlock() {
    var h = S.cur; if (!h) return; $("chMenu").hidden = true;
    if (!S.blocked && !confirm("Block " + (S.info ? S.info.displayName : "this contact") + "? They will not be able to message or call you.")) return;
    api(S.blocked ? "/api/vm/unblock" : "/api/vm/block", { handle: h }).then(function (d) { if (d.success) { applyBlocked(!S.blocked); say(S.blocked ? "Contact blocked." : "Contact unblocked."); loadThreads(); } else say(d.message || "Could not update."); });
  }

  /* ---------- start ---------- */
  function loadStatus() {
    return api("/api/vm/status").then(function (d) { if (!d.success) throw new Error(d.message || "Could not load Vico Message."); S.status = d; return d; });
  }
  var wired = false;
  function enter() {
    $("gate").hidden = true; $("vm").hidden = false; document.body.classList.remove("vm-inchat");
    if (!wired) { wired = true; wire(); }
    S.stream.stop = false; setTab(S.tab); startStream();
    loadWallet(); offerPush();
    var qs = new URLSearchParams(location.search), to = (qs.get("to") || "").replace(/^@/, ""), callTo = (qs.get("call") || "").replace(/^@/, "");
    if (to) { openChat(to, qs.get("t") ? "Hi, I am interested in “" + qs.get("t") + "”. Is it still available?" : ""); history.replaceState(null, "", "vico-messages.html"); }
    else if (callTo) { history.replaceState(null, "", "vico-messages.html"); startCall(callTo, qs.get("kind") === "video" ? "video" : "voice"); }
    api("/api/vm/calls/incoming").then(function (d) { if (d.success && d.calls.length) onIncoming({ callId: d.calls[0].callId, kind: d.calls[0].kind, from: d.calls[0].from }); });
  }
  // So a customer's message reaches this person's phone even when the page is closed, ask once to allow notifications.
  function offerPush() {
    try {
      var pk = S.status && S.status.push && S.status.push.web; if (!pk || !pushSupported() || Notification.permission === "denied") return;
      if (Notification.permission === "granted") { enablePush(); return; }
      if (sessionStorage.getItem("vmPushAsked") || (S.status.push.devices && S.status.push.devices.web)) return;
      var bar = $("conn"); var b = document.createElement("div"); b.id = "pushOffer"; b.style.cssText = "background:#eef6ff;color:#0b2a66;text-align:center;font:700 13px/1.4 system-ui,sans-serif;padding:8px 10px";
      b.innerHTML = 'Turn on notifications so customers can reach you even when you are offline. <button type="button" class="link" id="pushYes">Turn on</button> <button type="button" class="link" id="pushNo" style="color:#5d7096">Later</button>';
      bar.parentNode.insertBefore(b, bar.nextSibling);
      $("pushYes").onclick = function () { enablePush().then(function (r) { b.remove(); say(r.ok ? "Notifications are on." : r.message); }); };
      $("pushNo").onclick = function () { try { sessionStorage.setItem("vmPushAsked", "1"); } catch (e) {} b.remove(); };
    } catch (e) {}
  }
  function init() {
    if (!window.gmSignedIn || !gmSignedIn()) return gateLogin();
    loadStatus().then(function (st) { if (st.advertiserPending) return gatePhone(); if (st.activated && !(st.phoneRequired && !st.phoneVerified)) { if (S.status.me.displayName === "User") return gateProfile(false); enter(); } else gatePhone(); })
      .catch(function (e) { gate("<h2>Vico Message is not available</h2><p>" + esc(e.message || "Please try again.") + '</p><button class="btn-main" type="button" onclick="location.reload()">Try again</button>'); });
  }
  window.addEventListener("beforeunload", function () { S.stream.stop = true; if (S.stream.ctl) try { S.stream.ctl.abort(); } catch (e) {} });
  init();
})();
