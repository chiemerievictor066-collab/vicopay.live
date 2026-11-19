/* Vico Pay Live — Market Community bottom navigation (shared by every Market Community page).
   Add to a page:  <link rel="stylesheet" href="gm.css"> ... <body class="gm" data-gm="ads"> ... <script src="gm-nav.js"></script>
   data-gm = which button is lit (home, live, videos, messages, wallet, ai, ads, market, vip, profile).
   A button whose page is not built yet shows a short "opening soon" message. Set ready:true when its page exists. */
(function () {
  var ITEMS = [
    { k: "home", icon: "🏠", label: "Home", href: "global-market-community.html", ready: true },
    { k: "live", icon: "📡", label: "Live", href: "live-room.html", ready: true },
    { k: "videos", icon: "▶️", label: "Videos", href: "vico-videos.html", ready: false },
    { k: "messages", icon: "💬", label: "Messages", href: "vico-messages.html", ready: true },
    { k: "wallet", icon: "👛", label: "Vico Wallet", href: "vico-wallet.html", ready: true },
    { k: "ai", icon: '<img src="vico-ai-guide.gif" alt="" class="gmAiNavIcon">', label: "Vico AI", href: "vico-ai.html", ready: true },
    { k: "ads", icon: "📢", label: "Ad Center", href: "vico-ad-center.html", ready: true },
    { k: "market", icon: "🛒", label: "Marketplace", href: "vico-marketplace.html", ready: true },
    { k: "partnership", icon: "🎬", label: "Creator Partnership", href: "creator-partnership.html", ready: true },
    { k: "vip", icon: "👑", label: "VIP", href: "vip-profile.html", ready: true },
    { k: "profile", icon: "👤", label: "Profile", href: "vico-profile.html", ready: true }
  ];
  var here = document.body.getAttribute("data-gm") || "";
  var bar = document.createElement("div"); bar.className = "gm-bar";
  var nav = document.createElement("nav"); nav.setAttribute("aria-label", "Market Community");
  ITEMS.forEach(function (it) {
    var a = document.createElement("a"); a.href = it.ready ? it.href : "#"; a.dataset.k = it.k;
    if (it.k === here) a.className = "on"; if (!it.ready) a.className += " soon";
    a.innerHTML = "<span>" + it.icon + "</span>" + it.label;
    if (!it.ready) a.addEventListener("click", function (e) { e.preventDefault(); toast(it.label + " is opening soon."); });
    nav.appendChild(a);
  });
  bar.appendChild(nav);
  var t = document.createElement("div"); t.id = "gmToast";
  function toast(m) { t.textContent = m; t.className = "on"; clearTimeout(toast.t); toast.t = setTimeout(function () { t.className = ""; }, 2200); }
  window.gmToast = toast;
  window.gmOpen = function (k) { for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].k === k) { if (ITEMS[i].ready) location.href = ITEMS[i].href; else toast(ITEMS[i].label + " is opening soon."); return; } };
  /* ---- helpers every Market Community page can use ---- */
  window.gmApi = function (path, opts) {
    opts = opts || {}; var init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: { "Content-Type": "application/json" } };
    if (opts.body) init.body = JSON.stringify(opts.body);
    return fetch(path, init).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; }); });
  };
  window.gmEsc = function (x) { return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  window.gmSignedIn = function () { return !!(window.VicoAuth && VicoAuth.isSignedIn()); };
  window.gmNeedLogin = function () { toast("Please log in first."); setTimeout(function () { location.href = "join-now.html"; }, 900); };

  /* ---- Naira / Dollar: the SAME choice as the Home page (vico-currency.js). Write prices as  gmM(naira)  or  <span data-ngn="35000"></span> ---- */
  var RATE = 1500;
  function money(n) {
    n = Number(n) || 0; var usd = window.VicoCurrency && VicoCurrency.get() === "USD";
    if (!usd) return "₦" + Math.round(n).toLocaleString();
    var d = n / RATE; return "$" + d.toLocaleString(undefined, { minimumFractionDigits: d < 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  window.gmMoney = money;
  window.gmIsUsd = function () { return !!(window.VicoCurrency && VicoCurrency.get() === "USD"); };
  window.gmToNgn = function (v) { v = Number(v) || 0; return window.gmIsUsd() ? Math.round(v * RATE) : Math.round(v); };   // what the person typed (in the chosen currency) -> Naira, the money we charge
  window.gmRate = function () { return RATE; };
  window.gmM = function (n) { return '<span data-ngn="' + (Number(n) || 0) + '">' + money(n) + "</span>"; };
  function paintMoney(root) {
    var cur = window.VicoCurrency ? VicoCurrency.get() : "NGN";
    [].forEach.call((root || document).querySelectorAll("[data-ngn]"), function (el) { var k = cur + RATE + el.getAttribute("data-ngn"); if (el.__k !== k) { el.__k = k; el.textContent = money(el.getAttribute("data-ngn")); } });
  }
  window.gmPaintMoney = paintMoney;
  function curToggle() {
    var w = document.createElement("div"); w.className = "gm-cur"; w.innerHTML = '<button type="button" data-c="NGN">₦ Naira</button><button type="button" data-c="USD">$ Dollar</button>';
    w.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b && window.VicoCurrency) VicoCurrency.set(b.dataset.c); });
    function mark() { var c = window.VicoCurrency ? VicoCurrency.get() : "NGN"; [].forEach.call(w.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.dataset.c === c); }); }
    mark(); window.__gmCurMark = mark; return w;
  }
  function loadCurrency(cb) {
    function ready() { if (window.VicoCurrency) VicoCurrency.on(function () { paintMoney(); if (window.__gmCurMark) window.__gmCurMark(); if (window.gmOnCurrency) window.gmOnCurrency(); }); fetch("/api/currency/rate").then(function (r) { return r.json(); }).then(function (d) { if (d && d.ngnPerUsd) { RATE = d.ngnPerUsd; paintMoney(); } }).catch(function () {}); cb(); }
    if (window.VicoCurrency) return ready();
    var sc = document.createElement("script"); sc.src = "vico-currency.js"; sc.onload = ready; sc.onerror = cb; document.head.appendChild(sc);
  }

  /* ---- unread messages badge on the Messages button ---- */
  function badge() {
    if (!window.gmSignedIn()) return;
    window.gmApi("/api/dm/unread").then(function (d) {
      if (d && d.unread > 0) { var a = nav.querySelector('a[data-k="messages"]'); if (a && !a.querySelector("b")) { var b = document.createElement("b"); b.textContent = d.unread > 99 ? "99+" : d.unread; a.appendChild(b); } }
    }).catch(function () {});
  }

  /* ---- floating Vico AI (bottom-right). Pages opt in with  data-ai="ads|market|wallet" ---- */
  function floatAi(ctx) {
    var css = document.createElement("style");
    css.textContent = "#gmAiBtn{position:fixed;right:14px;bottom:92px;z-index:70;border:0;border-radius:30px;padding:10px 16px 10px 12px;background:linear-gradient(135deg,#3b8bff,#6d28d9);color:#fff;font:800 14px system-ui,Arial;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 10px 24px rgba(60,60,200,.4)}" +
      "#gmAiPanel{position:fixed;right:14px;bottom:150px;z-index:75;width:min(380px,calc(100vw - 28px));height:min(460px,60vh);background:#fff;border:1px solid #c5dcf7;border-radius:22px;box-shadow:0 18px 44px rgba(40,70,160,.3);display:none;flex-direction:column;overflow:hidden}" +
      "#gmAiPanel.on{display:flex}#gmAiPanel header{background:linear-gradient(135deg,#3b8bff,#6d28d9);color:#fff;padding:12px 14px;font-weight:900;display:flex;justify-content:space-between;align-items:center}" +
      "#gmAiPanel header button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}#gmAiLog{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f3f8ff}" +
      ".gmB{max-width:88%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}.gmB.u{align-self:flex-end;background:#4c1d95;color:#fff}.gmB.a{align-self:flex-start;background:#fff;border:1px solid #c5dcf7;color:#14224d}" +
      "#gmAiForm{display:flex;gap:6px;padding:8px;border-top:1px solid #c5dcf7}#gmAiForm input{flex:1;border:1px solid #c5dcf7;border-radius:14px;padding:10px 12px;font:inherit;min-width:0}#gmAiForm button{border:0;border-radius:14px;padding:0 14px;background:#4c1d95;color:#fff;font-weight:800;cursor:pointer}";
    var mascot = document.body.getAttribute("data-ai-img") || "vico-ai-guide.gif";   // pages with data-ai-img="file.gif" show the Vico AI robot instead of the plain button (Ad Center)
    if (mascot) css.textContent += "#gmAiBtn.mascot{padding:0;background:none;box-shadow:none;border-radius:22px;overflow:hidden;bottom:88px}#gmAiBtn.mascot img{display:block;width:clamp(104px,28vw,150px);height:auto;border-radius:22px;box-shadow:0 10px 26px rgba(30,60,200,.45);}#gmAiPanel.mascot{bottom:min(290px,40vh)}#gmAiPanel .gmAiTitle{display:flex;align-items:center;gap:8px}#gmAiPanel .gmAiTitle img{width:34px;height:30px;object-fit:contain;border-radius:8px}.gmAiNavIcon{width:28px;height:26px;object-fit:contain;vertical-align:middle}";
    document.head.appendChild(css);
    var btn = document.createElement("button"); btn.id = "gmAiBtn"; btn.className = "mascot"; btn.setAttribute("aria-label", "Vico AI: ask a question"); btn.innerHTML = '<img alt="Vico AI animated question guide" src="' + mascot.replace(/[^A-Za-z0-9_.-]/g, "") + '">';
        var p = document.createElement("div"); p.id = "gmAiPanel";
    if (mascot) p.className = "mascot";
    p.innerHTML = '<header><span class="gmAiTitle"><img src="' + mascot.replace(/[^A-Za-z0-9_.-]/g, "") + '" alt="">Vico AI</span><button type="button" aria-label="Close">×</button></header><div id="gmAiLog"></div><form id="gmAiForm"><input id="gmAiIn" maxlength="2000" placeholder="Ask Vico AI…" autocomplete="off"><button>Send</button></form>';
    document.body.appendChild(btn); document.body.appendChild(p);
    var log = p.querySelector("#gmAiLog"), conv = null, busy = false;
    function add(cls, text) { var d = document.createElement("div"); d.className = "gmB " + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
    add("a", "Hello! I'm Vico AI, your personal advertising and business assistant. What would you like to achieve today?");
    btn.onclick = function () { p.classList.toggle("on"); };
    p.querySelector("header button").onclick = function () { p.classList.remove("on"); };
    p.querySelector("#gmAiForm").onsubmit = function (e) {
      e.preventDefault(); var i = p.querySelector("#gmAiIn"), m = i.value.trim(); if (!m || busy) return;
      if (!window.gmSignedIn()) { window.gmNeedLogin(); return; }
      i.value = ""; add("u", m); busy = true; var w = add("a", "…");
      window.gmApi("/api/ai/chat", { body: { message: m, conversationId: conv, context: ctx === "ads" ? "ads" : "" } }).then(function (d) {
        busy = false; if (d.success) { conv = d.conversationId; w.textContent = d.reply; } else w.textContent = d.message || "Vico AI could not answer.";
        log.scrollTop = log.scrollHeight;
      }).catch(function () { busy = false; w.textContent = "Vico AI could not answer. Please try again."; });
    };
  }

  function start() {
    loadCurrency(function () {
      var tog = curToggle(), top = document.querySelector(".gm-top");
      var slot = document.querySelector("[data-cur-slot]");
      if (slot) slot.appendChild(tog); else if (top) { tog.style.marginLeft = "auto"; top.appendChild(tog); }
      paintMoney(); new MutationObserver(function () { paintMoney(); }).observe(document.body, { childList: true, subtree: true });
    });
    if (document.body.getAttribute("data-gm-bar") === "none") { document.body.appendChild(t); return; }   // pages with their own header and bottom bar (Marketplace, Videos, Product)
    document.body.appendChild(bar); document.body.appendChild(t);
    var on = nav.querySelector("a.on"); if (on && on.scrollIntoView) on.scrollIntoView({ inline: "center", block: "nearest" });
    var ttl = document.body.getAttribute("data-title");
    if (ttl) { var h = document.createElement("div"); h.className = "gm-wrap"; h.style.paddingBottom = "0";
      h.innerHTML = '<div class="gm-top"><a class="gm-me" href="global-market-community.html" style="padding:8px 14px">‹ Back</a><div class="gm-logo" style="margin-left:6px"><i>▶</i><div>' + window.gmEsc(ttl) + '<small>Vico Pay Live</small></div></div></div>';
      document.body.insertBefore(h, document.body.firstChild); }
    badge(); var f = document.body.getAttribute("data-ai"); if (f) floatAi(f);
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
