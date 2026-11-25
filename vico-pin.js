/* =====================================================
   Vico Wallet — PIN pad, email code (OTP) screen, final security check
   Loaded by auth.js the first time a money action needs it (withdrawal, paid gift), and by the Wallet page for Create / Change / Forgot PIN.
   Screens follow your design: "Create a 4 digit PIN" (round keypad) and "OTP Verification" (6 boxes, timer, Resend Code) — in blue.
   VicoPin.authorize({ action:"withdraw"|"gift", amount, details:[[label, value]] }) -> Promise<{token}> (rejects {cancel:true} if closed)
   VicoPin.create() / VicoPin.change() / VicoPin.reset() -> Promise (Wallet page)
   ===================================================== */
(function () {
  "use strict";
  if (window.VicoPin) return;
  var css = document.createElement("style");
  css.textContent = [
    ".vp{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(6,20,50,.78);font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}",
    ".vp *{box-sizing:border-box}.vp button{font-family:inherit;cursor:pointer}",
    ".vp-card{position:relative;width:min(430px,100%);height:min(860px,100%);overflow:auto;display:flex;flex-direction:column;align-items:center}",
    "@media(min-width:520px){.vp-card{border-radius:30px;box-shadow:0 30px 80px rgba(0,10,40,.6)}}",
    ".vp-dark{background:linear-gradient(180deg,#1c3a6e 0%,#16315f 100%);color:#fff}.vp-light{background:#fff;color:#0b2a5b}.vp-sky{background:linear-gradient(180deg,#eaf5ff,#d3e9ff);color:#0b2a5b}",
    ".vp-x{position:absolute;left:14px;top:14px;width:42px;height:42px;border-radius:50%;border:0;background:rgba(255,255,255,.14);color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center}.vp-light .vp-x,.vp-sky .vp-x{background:#eef5ff;color:#0b2a5b}",
    ".vp h2{margin:84px 24px 0;font-size:30px;font-weight:600;text-align:center;line-height:1.2}.vp .sub{margin:8px 28px 0;text-align:center;color:#b9d5f7;font-size:15px;font-weight:500;min-height:20px}",
    ".vp-dots{display:flex;gap:16px;margin:34px 0 8px}.vp-dots i{width:46px;height:46px;border-radius:50%;border:2px solid #fff;display:block;transition:.15s}.vp-dots i.on{background:#7cc4ff;border-color:#7cc4ff;transform:scale(.92)}",
    ".vp-dots.shake{animation:vpsh .4s}@keyframes vpsh{20%,60%{transform:translateX(-10px)}40%,80%{transform:translateX(10px)}}",
    ".vp-err{min-height:22px;color:#ffb4b4;font-weight:700;font-size:14.5px;text-align:center;margin:6px 24px}.vp-light .vp-err,.vp-sky .vp-err{color:#d92d20}",
    ".vp-pad{display:grid;grid-template-columns:repeat(3,76px);gap:18px 30px;margin:14px 0}.vp-pad button{width:76px;height:76px;border-radius:50%;border:1.5px solid rgba(255,255,255,.45);background:transparent;color:#fff;font-size:30px;font-weight:500}.vp-pad button:active{background:rgba(124,196,255,.3)}.vp-pad .gap{visibility:hidden}",
    ".vp-link{background:none;border:0;color:#9fd3ff;font-weight:700;font-size:15px;margin:6px 0 20px;padding:8px}.vp-light .vp-link,.vp-sky .vp-link{color:#1d6fe8}",
    ".vp-bar{display:flex;align-items:center;gap:12px;width:100%;padding:18px 18px 0}.vp-bar b{font-size:18px;font-weight:700}.vp-bar .vp-x{position:static}",
    ".vp-body{width:100%;padding:18px 22px;display:flex;flex-direction:column}.vp-body h1{margin:14px 0 6px;font-size:28px;font-weight:700}.vp-body p{margin:0;color:#4a628a;font-size:14.5px;line-height:1.5}.vp-body p b{color:#0b2a5b}",
    ".vp-otp{position:relative;display:flex;gap:10px;margin:28px 0 20px}.vp-otp div{flex:1;height:54px;border:1.5px solid #c9dcf5;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:700;background:#fff}.vp-otp div.on{border-color:#1d6fe8;box-shadow:0 0 0 3px rgba(29,111,232,.15)}.vp-otp input{position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:16px;border:0;background:none}",
    ".vp-tm{text-align:center;font-weight:800;font-size:17px;margin:6px 0 4px}.vp-rs{text-align:center;color:#4a628a;font-size:15px}.vp-rs button{border:0;background:none;color:#1d6fe8;font-weight:800;font-size:15px;padding:4px}.vp-rs button:disabled{color:#9ab4d8}",
    ".vp-go{width:100%;height:52px;border:0;border-radius:12px;background:linear-gradient(135deg,#1d6fe8,#0f4bb5);color:#fff;font-size:17px;font-weight:700;margin-top:22px}.vp-go:disabled{opacity:.55}.vp-go.ghost{background:#e5f0ff;color:#0f4bb5}",
    ".vp-sum{margin:18px 0 6px;background:#fff;border-radius:18px;padding:6px 16px;box-shadow:0 8px 24px rgba(15,75,181,.12)}.vp-sum div{display:flex;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid #e3eefc;font-size:15px}.vp-sum div:last-child{border:0}.vp-sum span{color:#4a628a}.vp-sum b{text-align:right;word-break:break-word}",
    ".vp-big{text-align:center;font-size:40px;font-weight:800;color:#0f4bb5;margin:18px 0 0}",
    ".vp-chk{margin:26px 0;display:flex;flex-direction:column;gap:14px}.vp-chk div{display:flex;align-items:center;gap:12px;font-weight:700;font-size:15.5px;opacity:.35;transition:.3s}.vp-chk div.on{opacity:1}.vp-chk i{width:28px;height:28px;border-radius:50%;border:2px solid #7cb6ff;display:flex;align-items:center;justify-content:center;font-style:normal;color:#fff;font-size:15px}.vp-chk div.on i{background:#1d6fe8;border-color:#1d6fe8}",
    ".vp-ico{font-size:62px;text-align:center;margin:70px 0 0}"
  ].join("");
  document.head.appendChild(css);

  var root = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function open() { if (!root) { root = document.createElement("div"); root.className = "vp"; root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); document.body.appendChild(root); } root.style.display = "flex"; document.body.style.overflow = "hidden"; }
  function close() { if (root) { root.style.display = "none"; root.innerHTML = ""; } document.body.style.overflow = ""; }
  function card(kind, html) { open(); root.innerHTML = '<div class="vp-card vp-' + kind + '">' + html + "</div>"; return root.firstChild; }
  function api(path, body) { return fetch("/api/wallet-security" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }
  var CANCEL = { cancel: true };
  function money(n) { return "₦" + Number(n || 0).toLocaleString(); }

  // ---- screens (each returns a Promise; `submit` decides what happens with what the person typed) ----
  function pinScreen(o, submit) {
    return new Promise(function (resolve, reject) {
      var c = card("dark", '<button class="vp-x" aria-label="Close">' + (o.back ? "‹" : "✕") + '</button><h2>' + esc(o.title) + '</h2><div class="sub">' + esc(o.sub || "") + '</div><div class="vp-dots"><i></i><i></i><i></i><i></i></div><div class="vp-err" role="alert"></div><div class="vp-pad"></div>' + (o.forgot ? '<button class="vp-link" id="vpF">Forgot PIN?</button>' : ""));
      var pin = "", busy = false, dots = c.querySelector(".vp-dots"), err = c.querySelector(".vp-err"), pad = c.querySelector(".vp-pad");
      function paint() { [].forEach.call(dots.children, function (d, i) { d.className = i < pin.length ? "on" : ""; }); }
      function done(fn, v) { document.removeEventListener("keydown", key); fn(v); }
      function press(k) {
        if (busy) return; err.textContent = "";
        if (k === "x") { pin = pin.slice(0, -1); paint(); return; }
        if (pin.length >= 4) return; pin += k; paint();
        if (pin.length === 4) { busy = true; var p = pin;
          Promise.resolve(submit(p)).then(function (r) {
            if (r && r.done) return done(resolve, r.value);
            if (r && r.lock) { c.innerHTML = '<button class="vp-x" aria-label="Close">✕</button><div class="vp-ico">🔒</div><h2 style="margin-top:14px">Wallet locked</h2><div class="sub">' + esc(r.lock.message) + '</div><button class="vp-go ghost" style="width:220px;margin-top:30px">Close</button>'; c.querySelector(".vp-x").onclick = c.querySelector(".vp-go").onclick = function () { done(reject, CANCEL); }; return; }
            busy = false; pin = ""; paint(); err.textContent = (r && r.error) || "Something went wrong. Try again."; dots.classList.remove("shake"); void dots.offsetWidth; dots.classList.add("shake"); if (navigator.vibrate) navigator.vibrate(120);
          }).catch(function () { busy = false; pin = ""; paint(); err.textContent = "Could not reach Vico. Check your connection."; });
        }
      }
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "x"].forEach(function (k) { var b = document.createElement("button"); b.type = "button"; if (k === "") b.className = "gap"; else { b.textContent = k === "x" ? "✕" : k; b.setAttribute("aria-label", k === "x" ? "Delete" : k); b.onclick = function () { press(k); }; } pad.appendChild(b); });
      function key(e) { if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === "Backspace") press("x"); else if (e.key === "Escape") done(reject, CANCEL); }
      document.addEventListener("keydown", key);
      c.querySelector(".vp-x").onclick = function () { done(reject, CANCEL); };
      var f = c.querySelector("#vpF"); if (f) f.onclick = function () { done(resolve, { forgot: true }); };
    });
  }
  // `info` = { maskedEmail, cooldownSeconds }, `resend()` -> Promise<{cooldownSeconds}|{error}>
  function otpScreen(info, submit, resend) {
    return new Promise(function (resolve, reject) {
      var c = card("light", '<div class="vp-bar"><button class="vp-x" aria-label="Back">←</button><b>OTP Verification</b></div><div class="vp-body"><h1>Check Your Email</h1><p>A 6-digit code has been sent to your email address, <b>' + esc(info.maskedEmail || "your email") + '</b>. Type it below.</p><div class="vp-otp"><div></div><div></div><div></div><div></div><div></div><div></div><input inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="6-digit code"></div><div class="vp-err" role="alert"></div><div class="vp-tm"></div><div class="vp-rs">Didn’t receive code? <button type="button" disabled>Resend Code</button></div><button class="vp-go" disabled>Verify</button></div>');
      var inp = c.querySelector("input"), boxes = c.querySelectorAll(".vp-otp div"), err = c.querySelector(".vp-err"), tm = c.querySelector(".vp-tm"), rs = c.querySelector(".vp-rs button"), go = c.querySelector(".vp-go"), left = info.cooldownSeconds || 60, timer = null, busy = false;
      function paint() { var v = inp.value; [].forEach.call(boxes, function (b, i) { b.textContent = v[i] || ""; b.className = i === v.length || (v.length === 6 && i === 5) ? "on" : ""; }); go.disabled = busy || v.length !== 6; }
      function tick() { var m = Math.floor(left / 60), s = left % 60; tm.textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; rs.disabled = left > 0; }
      function start(n) { left = n; tick(); clearInterval(timer); timer = setInterval(function () { if (left > 0) left--; tick(); if (left <= 0) clearInterval(timer); }, 1000); }
      function finish(fn, v) { clearInterval(timer); fn(v); }
      inp.oninput = function () { inp.value = inp.value.replace(/\D/g, "").slice(0, 6); err.textContent = ""; paint(); };
      c.querySelector(".vp-otp").onclick = function () { inp.focus(); };
      rs.onclick = function () { rs.disabled = true; Promise.resolve(resend()).then(function (r) { if (r && r.error) { err.textContent = r.error; if (r.wait) start(r.wait); else rs.disabled = false; } else { err.textContent = ""; start((r && r.cooldownSeconds) || 60); } }); };
      go.onclick = function () { if (go.disabled) return; busy = true; paint(); Promise.resolve(submit(inp.value)).then(function (r) { busy = false; if (r && r.done) return finish(resolve, r.value); err.textContent = (r && r.error) || "That code is not right."; inp.value = ""; paint(); inp.focus(); }).catch(function () { busy = false; err.textContent = "Could not reach Vico. Check your connection."; paint(); }); };
      inp.onkeydown = function (e) { if (e.key === "Enter") go.click(); };
      c.querySelector(".vp-x").onclick = function () { finish(reject, CANCEL); };
      start(left); paint(); setTimeout(function () { inp.focus(); }, 80);
    });
  }
  function detailsScreen(o) {
    return new Promise(function (resolve, reject) {
      var rows = (o.details || []).map(function (r) { return "<div><span>" + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b></div>"; }).join("");
      var c = card("sky", '<div class="vp-bar"><button class="vp-x" aria-label="Close">✕</button><b>' + esc(o.title) + '</b></div><div class="vp-body"><div class="vp-big">' + esc(o.amountText || "") + '</div><div class="vp-sum">' + rows + '</div><p style="text-align:center;margin-top:10px">Next you will enter your private Wallet PIN.</p><button class="vp-go">Continue</button></div>');
      c.querySelector(".vp-x").onclick = function () { reject(CANCEL); }; c.querySelector(".vp-go").onclick = function () { resolve(); };
    });
  }
  function checkScreen() {
    return new Promise(function (resolve) {
      var items = ["Checking your balance and limits", "Checking your account status", "Securing your transaction"];
      var c = card("sky", '<div class="vp-ico">🛡️</div><h2 style="margin-top:14px;color:#0b2a5b">Final security check</h2><div class="vp-body"><div class="vp-chk">' + items.map(function (t) { return "<div><i>✓</i>" + t + "</div>"; }).join("") + "</div></div>");
      var els = c.querySelectorAll(".vp-chk div"), i = 0;
      (function step() { if (i < els.length) { els[i].className = "on"; i++; setTimeout(step, 420); } else setTimeout(function () { close(); resolve(); }, 450); })();
    });
  }
  function messageScreen(icon, title, text, btn) {
    return new Promise(function (resolve) {
      var c = card("sky", '<div class="vp-ico">' + icon + '</div><h2 style="margin-top:14px;color:#0b2a5b">' + esc(title) + '</h2><div class="sub" style="color:#4a628a">' + esc(text) + '</div><div class="vp-body"><button class="vp-go">' + esc(btn || "OK") + "</button></div>");
      c.querySelector(".vp-go").onclick = function () { close(); resolve(); };
    });
  }

  // ---- flows ----
  function sendOtp(purpose) { return api("/otp/send", { purpose: purpose }).then(function (r) { return r.success ? { maskedEmail: r.maskedEmail, cooldownSeconds: r.cooldownSeconds } : { error: r.message, wait: r.waitSeconds }; }); }
  // email code -> new PIN -> confirm PIN -> save. kind: "set_pin" | "reset_pin" | "change_pin" (change also asks the current PIN first)
  function pinSetupFlow(kind) {
    var oldPin = "", title = kind === "change_pin" ? "Change Wallet PIN" : kind === "reset_pin" ? "Reset Wallet PIN" : "Create a 4 digit PIN";
    function oldStep() { return kind !== "change_pin" ? Promise.resolve() : pinScreen({ title: "Enter your current PIN", sub: "Then we will email you a code." }, function (p) { oldPin = p; return { done: true }; }); }
    function otpStep() { return sendOtp(kind).then(function (info) { if (info.error && !info.wait) return messageScreen("⚠️", "Could not send the code", info.error, "Close").then(function () { return Promise.reject(CANCEL); }); info.cooldownSeconds = info.cooldownSeconds || info.wait; return otpScreen(info, function (code) { return { done: true, value: code }; }, function () { return sendOtp(kind); }); }); }
    function newStep(otp) {
      return pinScreen({ title: title, sub: "Choose 4 numbers only you know." }, function (p) { return { done: true, value: p }; }).then(function (p1) {
        return pinScreen({ title: "Confirm your PIN", sub: "Type the same 4 digits again.", back: true }, function (p2) { return p2 === p1 ? { done: true, value: p2 } : { error: "The two PINs do not match." }; }).then(function (p2) {
          var path = kind === "set_pin" ? "/pin/set" : kind === "reset_pin" ? "/pin/reset" : "/pin/change", body = kind === "set_pin" ? { otp: otp, pin: p1, confirm: p2 } : kind === "reset_pin" ? { otp: otp, newPin: p1, confirm: p2 } : { currentPin: oldPin, otp: otp, newPin: p1, confirm: p2 };
          return api(path, body).then(function (r) {
            if (r.success) return messageScreen("✅", kind === "set_pin" ? "Wallet PIN created" : "Wallet PIN changed", "Your wallet is now protected by your PIN.", "Done");
            return messageScreen("⚠️", "Not saved", r.message || "Please try again.", "Try again").then(function () { return /code/i.test(r.message || "") ? otpStep().then(newStep) : /PIN/i.test(r.message || "") && kind === "change_pin" ? oldStep().then(function () { return newStep(otp); }) : newStep(otp); });
          });
        });
      });
    }
    return oldStep().then(otpStep).then(newStep);
  }
  function authorize(o) {
    o = o || {}; var action = o.action === "gift" ? "gift" : o.action === "wallet" ? "wallet" : "withdraw";
    return api("/status").then(function (st) {
      if (!st.success) return Promise.reject({ message: st.message || "Could not check wallet security." });
      if (!st.enabled) return { token: "" };
      if (st.locked) return messageScreen("🔒", "Wallet locked", "Too many wrong PIN tries. Try again in " + Math.max(1, Math.ceil((st.lockedUntil - Date.now()) / 60000)) + " minutes.", "Close").then(function () { return Promise.reject(CANCEL); });
      var first = st.hasPin ? Promise.resolve() : messageScreen("🛡️", "Create your Wallet PIN", "To protect your money, first create a 4 digit PIN. We will email you a code to confirm it is you.", "Continue").then(function () { return pinSetupFlow("set_pin"); });
      return first.then(function () { return action === "withdraw" && o.details ? detailsScreen({ title: "Confirm withdrawal", amountText: money(o.amount), details: o.details }) : null; }).then(function () { return pinStep(); });
      function submitAuth(pin, otp) { return api("/authorize", { action: action, amount: o.amount || 0, pin: pin, otp: otp || undefined }); }
      function pinStep() {
        return pinScreen({ title: "Enter your Wallet PIN", sub: action === "withdraw" ? "To withdraw " + money(o.amount) : action === "wallet" ? "To open your VicoPay Wallet" : "To send your gift", forgot: true }, function (p) {
          return submitAuth(p).then(function (r) {
            if (r.success) return { done: true, value: { token: r.token } };
            if (r.otpRequired) return { done: true, value: { pin: p, info: r } };
            if (r.locked) return { lock: r };
            return { error: r.message };
          });
        }).then(function (v) {
          if (v.forgot) return pinSetupFlow("reset_pin").then(pinStep);
          if (v.token) return checkScreen().then(function () { return { token: v.token }; });
          return otpScreen(v.info, function (code) { return submitAuth(v.pin, code).then(function (r) { return r.success ? { done: true, value: r.token } : { error: r.message }; }); }, function () { return submitAuth(v.pin).then(function (r) { return r.otpRequired ? { cooldownSeconds: r.cooldownSeconds } : { error: r.message || "Could not send a new code." }; }); })
            .then(function (token) { return checkScreen().then(function () { return { token: token }; }); });
        });
      }
    }).catch(function (e) { if (e && e.cancel) { close(); } throw e; });
  }
  function wrap(fn) { return function () { return fn.apply(null, arguments).then(function (v) { close(); return v; }, function (e) { close(); throw e; }); }; }
  window.VicoPin = {
    authorize: authorize,
    create: wrap(function () { return pinSetupFlow("set_pin"); }), change: wrap(function () { return pinSetupFlow("change_pin"); }), reset: wrap(function () { return pinSetupFlow("reset_pin"); }),
    status: function () { return api("/status"); }
  };
})();
