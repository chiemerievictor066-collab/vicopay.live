/* =====================================================
   Vico Pay Live — round "three dots" share button
   Add to a page with:   <script src="share-menu.js"></script>
   It puts a circle button (three dots) on the page. Tapping it opens WhatsApp, Facebook, Instagram, TikTok, Telegram,
   X, LinkedIn, Reddit, Invite Friends, Share (phone share sheet), Save and Download.
   Everything shares YOUR personal invite link (from /api/referrals/me), so friends who join through it count for your rewards.
   To move the button, change the --vsm-top / --vsm-right values below.
   ===================================================== */
(function () {
  if (window.__vicoShareMenu) return; window.__vicoShareMenu = true;
  var NAME = "Vico Pay Live";
  var info = { link: location.origin + "/signup.html", code: "" };

  var css = document.createElement("style");
  css.textContent =
    ":root{--vsm-top:14px;--vsm-right:14px}" +
    "#vsmBtn{position:fixed;top:var(--vsm-top);right:var(--vsm-right);z-index:9500;width:46px;height:46px;border-radius:50%;border:2px solid #f5c542;background:linear-gradient(135deg,#7c3aed,#3b0a77);color:#ffd76a;font:900 22px/1 Arial,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:0;letter-spacing:0}" +
    "#vsmBtn svg{width:22px;height:22px;fill:currentColor}" +
    "#vsmBack{position:fixed;inset:0;z-index:9600;background:rgba(5,2,16,.6);display:none;align-items:flex-end;justify-content:center}" +
    "#vsmBack.on{display:flex}" +
    "#vsmSheet{width:min(520px,100%);max-height:88vh;overflow:auto;background:linear-gradient(180deg,#1a0b3a,#0b0620);border:1px solid #5b2fb3;border-bottom:0;border-radius:22px 22px 0 0;padding:18px 16px 22px;color:#fff;font-family:Arial,sans-serif;animation:vsmUp .22s ease-out}" +
    "@keyframes vsmUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}" +
    "#vsmSheet h3{margin:0 0 4px;font-size:18px;color:#ffd76a}#vsmSheet p{margin:0 0 14px;font-size:12.5px;color:#c9b8f0}" +
    ".vsmGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}" +
    ".vsmItem{border:1px solid #4a2a8f;background:#150a33;color:#fff;border-radius:14px;padding:10px 4px 8px;cursor:pointer;font:inherit;font-size:11.5px;font-weight:700;display:flex;flex-direction:column;align-items:center;gap:6px}" +
    ".vsmItem:active{transform:scale(.96)}" +
    ".vsmIc{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:#fff}" +
    ".vsmGold{background:linear-gradient(135deg,#f5c542,#c98a00);color:#2a1700!important}" +
    "#vsmLink{margin-top:14px;display:flex;gap:8px}#vsmLink input{flex:1;min-width:0;padding:10px 12px;border-radius:12px;border:1px solid #4a2a8f;background:#0b0620;color:#fff;font:inherit;font-size:12px}" +
    "#vsmLink button{border:0;border-radius:12px;padding:0 16px;background:linear-gradient(135deg,#f5c542,#c98a00);color:#2a1700;font-weight:900;cursor:pointer}" +
    "#vsmClose{display:block;margin:14px auto 0;border:0;background:none;color:#c9b8f0;font:inherit;font-size:13px;cursor:pointer}" +
    "#vsmToast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9700;background:#16a34a;color:#fff;padding:10px 16px;border-radius:12px;font:700 13px Arial,sans-serif;opacity:0;pointer-events:none;transition:opacity .2s;max-width:90vw;text-align:center}" +
    "#vsmToast.on{opacity:1}";
  document.head.appendChild(css);

  var btn = document.createElement("button");
  btn.id = "vsmBtn"; btn.type = "button"; btn.setAttribute("aria-label", "Share and invite");
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>';

  var back = document.createElement("div"); back.id = "vsmBack";
  var toastEl = document.createElement("div"); toastEl.id = "vsmToast";

  function text() { return "Join me on " + NAME + "! Sign up with my invite link" + (info.code ? " (code " + info.code + ")" : "") + ": " + info.link; }
  function enc(s) { return encodeURIComponent(s); }
  function toast(m) { toastEl.textContent = m; toastEl.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.classList.remove("on"); }, 2600); }
  function open(url) { window.open(url, "_blank", "noopener"); }
  function copy(then) {
    var done = function () { if (then) then(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(info.link).then(done, function () { fallbackCopy(); done(); });
    else { fallbackCopy(); done(); }
  }
  function fallbackCopy() { var i = document.getElementById("vsmInput"); if (i) { i.select(); try { document.execCommand("copy"); } catch (e) { } } }

  function saveLink() {
    try {
      var list = JSON.parse(localStorage.getItem("vicoSavedLinks") || "[]");
      if (list.indexOf(info.link) === -1) list.unshift(info.link);
      localStorage.setItem("vicoSavedLinks", JSON.stringify(list.slice(0, 50)));
      toast("💾 Invite link saved on this device.");
    } catch (e) { toast("Could not save on this device."); }
  }
  function downloadCard() {
    var W = 1080, H = 1350, c = document.createElement("canvas"); c.width = W; c.height = H; var g = c.getContext("2d");
    var bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#2a0a5e"); bg.addColorStop(1, "#05020f"); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.textAlign = "center"; g.fillStyle = "#ffd76a"; g.font = "900 70px Arial"; g.fillText("Vico Pay Live", W / 2, 120);
    g.fillStyle = "#fff"; g.font = "700 40px Arial"; g.fillText("Invite Friends. Earn Rewards.", W / 2, 185);
    function finish() {
      g.fillStyle = "#c9b8f0"; g.font = "700 38px Arial"; g.fillText("Join me with my invite code", W / 2, 960);
      g.fillStyle = "#ffd76a"; g.font = "900 110px Arial"; g.fillText(info.code || "VICO PAY", W / 2, 1075);
      g.fillStyle = "#fff"; g.font = "700 34px Arial"; g.fillText(info.link.replace(/^https?:\/\//, ""), W / 2, 1150);
      c.toBlob(function (b) {
        var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "vico-pay-invite.png";
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast("⬇️ Invite card downloaded.");
      });
    }
    var im = new Image(); im.onload = function () { var h = 640, w = h * im.width / im.height; g.drawImage(im, (W - w) / 2, 250, w, h); finish(); }; im.onerror = finish; im.src = "vipfx-emoji4.webp";
  }

  var ITEMS = [
    ["WhatsApp", "💬", "#25d366", function () { open("https://wa.me/?text=" + enc(text())); }],
    ["Facebook", "f", "#1877f2", function () { open("https://www.facebook.com/sharer/sharer.php?u=" + enc(info.link) + "&quote=" + enc(text())); }],
    ["Instagram", "📷", "linear-gradient(135deg,#f58529,#dd2a7b,#8134af)", function () { copy(function () { toast("Link copied. Paste it in Instagram."); open("https://www.instagram.com/"); }); }],
    ["TikTok", "♪", "#111", function () { copy(function () { toast("Link copied. Paste it in TikTok."); open("https://www.tiktok.com/"); }); }],
    ["Telegram", "✈", "#229ed9", function () { open("https://t.me/share/url?url=" + enc(info.link) + "&text=" + enc(text())); }],
    ["X", "𝕏", "#000", function () { open("https://twitter.com/intent/tweet?text=" + enc(text())); }],
    ["LinkedIn", "in", "#0a66c2", function () { open("https://www.linkedin.com/sharing/share-offsite/?url=" + enc(info.link)); }],
    ["Reddit", "👽", "#ff4500", function () { open("https://www.reddit.com/submit?url=" + enc(info.link) + "&title=" + enc("Join me on " + NAME)); }],
    ["Invite Friends", "👥", "gold", function () { location.href = "invite-friends.html"; }],
    ["Share", "⤴", "#7c3aed", function () {
      if (navigator.share) navigator.share({ title: NAME, text: text(), url: info.link }).catch(function () { });
      else copy(function () { toast("Link copied. Your device has no share sheet."); });
    }],
    ["Save", "💾", "#0f766e", saveLink],
    ["Download", "⬇", "#b45309", downloadCard]
  ];

  function build() {
    var sheet = document.createElement("div"); sheet.id = "vsmSheet";
    sheet.innerHTML = "<h3>Share &amp; Invite</h3><p>Friends who join with your link count toward your Invite Friends rewards.</p><div class=\"vsmGrid\"></div>" +
      "<div id=\"vsmLink\"><input id=\"vsmInput\" readonly><button type=\"button\" id=\"vsmCopy\">Copy</button></div><button type=\"button\" id=\"vsmClose\">Close</button>";
    var grid = sheet.querySelector(".vsmGrid");
    ITEMS.forEach(function (it) {
      var b = document.createElement("button"); b.type = "button"; b.className = "vsmItem";
      var ic = document.createElement("span"); ic.className = "vsmIc" + (it[2] === "gold" ? " vsmGold" : ""); if (it[2] !== "gold") ic.style.background = it[2]; ic.textContent = it[1];
      var lb = document.createElement("span"); lb.textContent = it[0];
      b.appendChild(ic); b.appendChild(lb); b.addEventListener("click", it[3]); grid.appendChild(b);
    });
    back.appendChild(sheet);
    sheet.querySelector("#vsmCopy").addEventListener("click", function () { copy(function () { toast("🔗 Invite link copied."); }); });
    sheet.querySelector("#vsmClose").addEventListener("click", close);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
  }
  function show() { document.getElementById("vsmInput").value = info.link; back.classList.add("on"); loadInfo(); }
  function close() { back.classList.remove("on"); }

  function loadInfo() {
    if (info.loaded) return; info.loaded = true;
    var h = {}; try { var t = localStorage.getItem("vicoPayToken"); if (t) h.Authorization = "Bearer " + t; } catch (e) { }
    fetch("/api/referrals/me", { headers: h }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.success && d.link) { info.link = d.link; info.code = d.code; var i = document.getElementById("vsmInput"); if (i) i.value = d.link; }
    }).catch(function () { info.loaded = false; });
  }

  function start() { build(); document.body.appendChild(btn); document.body.appendChild(back); document.body.appendChild(toastEl); btn.addEventListener("click", show); loadInfo(); }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
