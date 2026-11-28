/* =====================================================
   Vico Pay — shared look for Marketplace, Product page and Videos (icons, bottom bar, product card, stars)
   Needs gm-nav.js first (gmApi, gmEsc, gmM, gmToast). Pages add data-gm-bar="none" on <body> so gm-nav does not add its own bar.
   ===================================================== */
(function () {
  "use strict";
  if (window.VicoShell) return;
  var P = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9v11h16V9"/><path d="M4 9c0 2 3 2 4 0 1 2 3 2 4 0 1 2 3 2 4 0 1 2 4 2 4 0"/><path d="M10 20v-5h4v5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z"/>',
    chip: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><path d="M10.5 9.5l4 2.5-4 2.5z" fill="currentColor"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/><circle cx="9" cy="10.5" r=".9" fill="currentColor"/><circle cx="12" cy="10.5" r=".9" fill="currentColor"/><circle cx="15" cy="10.5" r=".9" fill="currentColor"/>',
    wallet: '<path d="M4 7h14a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><path d="M4 7l11-3v3"/><circle cx="16" cy="13.5" r="1.2" fill="currentColor"/>',
    crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z"/><path d="M5 21h14"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    cart: '<path d="M2 3h3l2.4 12.2a2 2 0 002 1.6h8.2a2 2 0 002-1.5L21 8H6"/><circle cx="10" cy="20.5" r="1.4"/><circle cx="18" cy="20.5" r="1.4"/>',
    bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>',
    heart: '<path d="M12 20s-8-5-8-11a4.5 4.5 0 018-2.7A4.5 4.5 0 0120 9c0 6-8 11-8 11z"/>',
    share: '<path d="M14 4l7 7-7 7v-4c-6 0-9 2-11 6 1-7 5-11 11-11z"/>',
    gift: '<rect x="3" y="9" width="18" height="12" rx="1"/><path d="M12 9v12M3 13h18"/><path d="M12 9c-3-5-7-3-5 0M12 9c3-5 7-3 5 0"/>',
    bag: '<path d="M5 8h14l1 13H4z"/><path d="M9 8V6a3 3 0 016 0v2"/>',
    cam: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'
  };
  function icon(n, s) { return '<svg viewBox="0 0 24 24" width="' + (s || 24) + '" height="' + (s || 24) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[n] || "") + "</svg>"; }

  var css = document.createElement("style");
  css.textContent = [
    ":root{--vs-in:#4c1d95;--vs-pu:#6d28d9;--vs-bl:#2b5cff;--vs-ink:#14224d;--vs-mute:#5d7096;--vs-line:#e2e8f8}",
    "body.vs-page{background:#f6f8ff;color:var(--vs-ink);padding-bottom:92px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}",
    ".vs-nav{position:fixed;left:0;right:0;bottom:0;z-index:60;background:#fff;border-top:1px solid var(--vs-line);box-shadow:0 -6px 22px rgba(60,60,160,.1);padding:6px 6px calc(6px + env(safe-area-inset-bottom))}",
    ".vs-nav nav{display:flex;max-width:1180px;margin:0 auto;overflow-x:auto;scrollbar-width:none}.vs-nav nav::-webkit-scrollbar{display:none}",
    ".vs-nav a{position:relative;flex:1 0 62px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 4px 9px;color:#3a2a8c;font-weight:700;font-size:12px;white-space:nowrap;text-decoration:none}",
    ".vs-nav a.on{color:var(--vs-pu)}.vs-nav a.on:after{content:'';position:absolute;left:18%;right:18%;bottom:0;height:3px;border-radius:3px;background:var(--vs-pu)}",
    ".vs-nav a.on svg{color:var(--vs-pu)}.vs-nav a b{position:absolute;top:2px;left:calc(50% + 6px);min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font:800 11px/18px Arial;text-align:center;padding:0 4px}",
    ".vs-nav.dark{background:rgba(10,8,30,.92);border-top-color:#2a2150}.vs-nav.dark a{color:#e8e4ff}.vs-nav.dark a.on{color:#fff}.vs-nav.dark a.on:after{display:none}",
    /* product card */
    ".vs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}",
    ".vs-card{background:#fff;border:1px solid var(--vs-line);border-radius:20px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;box-shadow:0 8px 22px rgba(60,60,160,.08)}",
    ".vs-img{position:relative;aspect-ratio:4/3;background:linear-gradient(135deg,#e3f1ff,#eee6ff);display:flex;align-items:center;justify-content:center;font-size:48px}.vs-img img{width:100%;height:100%;object-fit:cover}",
    ".vs-badge{position:absolute;left:0;top:0;display:flex;align-items:center;gap:5px;padding:6px 12px 6px 9px;border-radius:0 0 14px 0;font:800 13px system-ui,Arial;color:#fff;background:rgba(30,20,90,.92)}",
    ".vs-badge.hot{background:rgba(88,28,135,.94)}.vs-badge.best{background:rgba(120,72,10,.95)}.vs-badge.top{background:rgba(23,50,140,.95)}.vs-badge.new{background:rgba(24,70,170,.95)}",
    ".vs-off{position:absolute;right:8px;top:8px;background:#e11d2e;color:#fff;font:800 13px system-ui,Arial;padding:3px 9px;border-radius:12px}",
    ".vs-sp{position:absolute;right:8px;bottom:8px;background:#fef3c7;color:#92400e;font:900 11px system-ui,Arial;padding:2px 8px;border-radius:8px}",
    ".vs-bd{padding:10px 12px 12px;display:flex;flex-direction:column;gap:3px;flex:1}",
    ".vs-t{font-weight:800;font-size:16px;line-height:1.25;min-height:40px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--vs-ink)}",
    ".vs-rate{display:flex;align-items:center;gap:5px;font-size:14px;color:var(--vs-mute);font-weight:700}.vs-rate .stars{background:linear-gradient(90deg,#f5b301 var(--p,0%),#d5dbea var(--p,0%));-webkit-background-clip:text;background-clip:text;color:transparent;letter-spacing:1px;font-size:15px}.vs-rate b{color:var(--vs-ink)}",
    ".vs-price{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.vs-price b{font-size:22px;font-weight:900;color:#4318b8}.vs-price s{font-size:14px;color:#8a94b3;font-weight:700}",
    ".vs-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:4px}.vs-store{display:flex;align-items:center;gap:6px;font-weight:700;font-size:14px;color:var(--vs-ink);min-width:0}.vs-store span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vs-store svg{color:#4318b8;flex:0 0 auto}",
    ".vs-btn{display:inline-flex;align-items:center;gap:7px;border:0;border-radius:14px;padding:10px 16px;background:linear-gradient(135deg,#6d28d9,#4c1d95);color:#fff;font:800 14px system-ui,Arial;cursor:pointer;box-shadow:0 8px 16px rgba(76,29,149,.28);white-space:nowrap}.vs-btn.lg{padding:15px 28px;font-size:17px;border-radius:18px}",
    ".vs-empty{padding:36px;text-align:center;color:var(--vs-mute);font-weight:700;grid-column:1/-1}",
    "@media(max-width:560px){.vs-grid{grid-template-columns:repeat(2,1fr);gap:10px}.vs-t{font-size:14px;min-height:36px}.vs-price b{font-size:18px}.vs-btn{padding:9px 12px;font-size:13px}.vs-badge{font-size:11.5px;padding:5px 9px 5px 7px}.vs-store{font-size:12px}}"
  ].join("");
  document.head.appendChild(css);

  function stars(avg) { return '<span class="stars" style="--p:' + Math.max(0, Math.min(100, Math.round(avg / 5 * 100))) + '%">★★★★★</span>'; }
  function esc(x) { return window.gmEsc ? window.gmEsc(x) : String(x == null ? "" : x).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var BADGE = { "Hot Deal": ["hot", "🔥"], "Best Seller": ["best", "👑"], "Top Rated": ["top", "👍"], "New Arrival": ["new", "⭐"] };
  function money(n) { return window.gmM ? window.gmM(n) : "₦" + Number(n).toLocaleString(); }
  // one product card: badge, discount, picture, name, rating, price (old price struck), store, Buy Now. `o.sponsored` adds a Sponsored tag.
  function card(it, o) {
    o = o || {}; var b = BADGE[it.badge], r = it.rating || { avg: 0, count: 0 };
    return '<div class="vs-card" data-id="' + it.id + '"><div class="vs-img">' + (it.imageUrl ? '<img loading="lazy" alt="" src="' + it.imageUrl + '">' : "🛍️") +
      (b ? '<span class="vs-badge ' + b[0] + '">' + b[1] + " " + esc(it.badge) + "</span>" : "") + (it.discount ? '<span class="vs-off">-' + it.discount + "%</span>" : "") + (o.sponsored ? '<span class="vs-sp">Sponsored</span>' : "") + "</div>" +
      '<div class="vs-bd"><div class="vs-t">' + esc(it.title) + "</div>" +
      '<div class="vs-rate">' + (r.count ? stars(r.avg) + " <b>" + r.avg.toFixed(1) + "</b> (" + (r.count >= 1000 ? (r.count / 1000).toFixed(1) + "K" : r.count) + ")" : '<span style="font-weight:700">No ratings yet</span>') + "</div>" +
      '<div class="vs-price"><b>' + money(it.price) + "</b>" + (it.oldPrice ? "<s>" + money(it.oldPrice) + "</s>" : "") + "</div>" +
      '<div class="vs-foot"><div class="vs-store">' + icon("store", 18) + "<span>" + esc(it.seller ? it.seller.displayName : "") + "</span></div>" +
      (it.status === "sold" ? '<span class="vs-store" style="color:#b91c1c">Sold</span>' : '<button class="vs-btn vs-buy" type="button" data-id="' + it.id + '">' + icon("cart", 17) + " Buy Now</button>") + "</div></div></div>";
  }

  var READY = { home: "home.html", market: "vico-marketplace.html", partnership: "creator-partnership.html", videos: "vico-videos.html", sense: "", ai: "", messages: "vico-messages.html", wallet: "vico-wallet.html", vip: "vip-stage.html", profile: "profile.html" };
  var SETS = {
    market: [["home", "home", "Home"], ["market", "store", "Marketplace"], ["partnership", "handshake", "Creator Partnership"], ["videos", "play", "Videos"], ["sense", "star", "8 Sense"], ["ai", "chip", "Vico AI"], ["messages", "chat", "Messages"], ["wallet", "wallet", "Vico Wallet"], ["vip", "crown", "VIP Club"], ["profile", "user", "Profile"]],
    video: [["home", "home", "Home"], ["videos", "play", "Videos"], ["market", "bag", "Marketplace"], ["sense", "star", "8Sense"], ["profile", "user", "Profile"]]
  };
  function nav(kind, active, dark) {
    var bar = document.createElement("div"); bar.className = "vs-nav" + (dark ? " dark" : ""); var n = document.createElement("nav"); n.setAttribute("aria-label", "Vico Pay");
    SETS[kind].forEach(function (x) {
      var a = document.createElement("a"), href = READY[x[0]]; a.href = href || "#"; a.dataset.k = x[0]; if (x[0] === active) a.className = "on";
      a.innerHTML = icon(x[1], 26) + x[2];
      if (!href) a.addEventListener("click", function (e) { e.preventDefault(); if (window.gmToast) gmToast(x[2] + " is opening soon."); });
      n.appendChild(a);
    });
    bar.appendChild(n); document.body.appendChild(bar);
    if (kind === "market" && window.gmSignedIn && gmSignedIn()) gmApi("/api/dm/unread").then(function (d) { if (d && d.unread > 0) { var a = n.querySelector('[data-k="messages"]'); if (a) { var b = document.createElement("b"); b.textContent = d.unread > 99 ? "99+" : d.unread; a.appendChild(b); } } }).catch(function () {});
    return bar;
  }
  // red badges on the cart (purchases waiting for you to confirm) and the bell (unread notifications)
  function headerBadges(cartEl, bellEl) {
    function put(el, n) { if (!el) return; var b = el.querySelector("em"); if (!b) { b = document.createElement("em"); el.appendChild(b); } b.textContent = n > 99 ? "99+" : n; b.style.display = n > 0 ? "flex" : "none"; }
    if (!window.gmSignedIn || !gmSignedIn()) { put(cartEl, 0); put(bellEl, 0); return; }
    gmApi("/api/market/orders?role=buyer").then(function (d) { put(cartEl, (d.orders || []).filter(function (o) { return o.status === "paid" || o.status === "shipped"; }).length); }).catch(function () {});
    gmApi("/api/notifications").then(function (d) { put(bellEl, (d && d.unread) || 0); }).catch(function () {});
  }
  window.VicoShell = { icon: icon, card: card, stars: stars, nav: nav, headerBadges: headerBadges, esc: esc };
})();
