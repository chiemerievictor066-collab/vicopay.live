/* =====================================================
   VicoPay Live — VIP drawing helper (Stage 1)
   Include:  <script src="vip-ui.js"></script>
   Everything here only DRAWS what the server already approved (/api/vip/public).
   Frames are pure CSS: one rotating/pulsing pseudo-element per frame (GPU transform/opacity),
   no canvas and no timers, so a busy live room is not slowed down. Reduced-motion users get static frames.
   ===================================================== */
(function () {
  var HEX = /^#[0-9a-fA-F]{3,8}$/;
  var KEY = /^[a-z0-9-]{1,41}$/;
  var CACHE = {}, PENDING = {}, TTL = 30000;

  var css = [
    ".vip-av{position:relative;display:inline-block;border-radius:50%;isolation:isolate}",
    ".vip-av>img,.vip-av>.vip-av-in{position:relative;z-index:1;display:block;width:100%;height:100%;border-radius:50%;object-fit:cover}",
    ".vip-av.has-frame{padding:4px}",
    ".vip-av.has-frame::before{content:'';position:absolute;inset:0;border-radius:50%;z-index:0;",
    "  background:conic-gradient(from 0deg,var(--vc1,#ffe27a),var(--vc2,#e0a100),var(--vc1,#ffe27a));will-change:transform}",
    ".vip-av.vf-silver-shine::before{animation:vipSpin 6s linear infinite}",
    ".vip-av.vf-diamond-spin::before{animation:vipSpin 2.4s linear infinite}",
    ".vip-av.vf-royal-flame::before{animation:vipSpin 3.2s linear infinite;filter:drop-shadow(0 0 6px var(--vc2,#7b2ff7))}",
    ".vip-av.vf-legend-aurora::before{animation:vipSpin 4s linear infinite;filter:drop-shadow(0 0 8px var(--vc1,#ff5a7d))}",
    ".vip-av.vf-gold-pulse::before,.vip-av.vf-rose-glow::before{animation:vipPulse 1.8s ease-in-out infinite}",
    "@keyframes vipSpin{to{transform:rotate(360deg)}}",
    "@keyframes vipPulse{0%,100%{opacity:.75;transform:scale(1)}50%{opacity:1;transform:scale(1.06)}}",
    ".vip-av.static::before{animation:none!important}",
    "@media (prefers-reduced-motion:reduce){.vip-av.has-frame::before{animation:none!important}}",
    ".vip-name{font-weight:800}",
    ".vip-name.grad{-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}",
    ".vip-crown{margin-right:3px}",
    ".vip-badge{display:inline-flex;align-items:center;gap:3px;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:900;line-height:1.5;color:#1b1300;vertical-align:middle;margin-left:5px;white-space:nowrap}",
    ".vip-badge img{width:14px;height:14px;object-fit:contain}",
    ".vip-title{display:inline-block;font-size:11px;font-weight:800;opacity:.9;margin-left:6px;padding:1px 7px;border-radius:9px;background:rgba(255,200,61,.18);color:#b87a00;vertical-align:middle}",
    ".vip-verified{margin-left:4px;color:#1d9bf0}",
    /* identity card */
    ".vip-card{position:relative;overflow:hidden;border-radius:18px;padding:16px;color:#fff;min-width:260px;box-shadow:0 10px 28px rgba(0,0,0,.25)}",
    ".vip-card.t-silver{background:linear-gradient(135deg,#6b7586,#c3cad6)}",
    ".vip-card.t-gold{background:linear-gradient(135deg,#8a5a00,#ffc83d)}",
    ".vip-card.t-diamond{background:linear-gradient(135deg,#0b3d91,#4fd8ff)}",
    ".vip-card.t-royal{background:linear-gradient(135deg,#3b0d7a,#b57bff)}",
    ".vip-card.t-legend{background:linear-gradient(135deg,#8a0f3a,#ff9a3c)}",
    ".vip-card .vc-row{display:flex;align-items:center;gap:12px;position:relative;z-index:1}",
    ".vip-card .vc-tier{font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;opacity:.9}",
    ".vip-card .vc-name{font-size:18px;font-weight:900}"
  ].join("\n");
  function injectCss() {
    if (document.getElementById("vip-ui-css")) return;
    var s = document.createElement("style"); s.id = "vip-ui-css"; s.textContent = css; document.head.appendChild(s);
  }
  injectCss();

  // "gradient:#a,#b"  ->  CSS background;  "#abc" -> colour;  "url:/x.png" -> image
  function bg(value) {
    value = String(value || "");
    var g = /^gradient:(#[0-9a-fA-F]{3,8}),(#[0-9a-fA-F]{3,8})$/.exec(value);
    if (g) return "linear-gradient(135deg," + g[1] + "," + g[2] + ")";
    if (HEX.test(value)) return value;
    var u = /^url:((?:https:\/\/|\/)[A-Za-z0-9_\-./%~?=&]{1,300})$/.exec(value);
    if (u) return "url(\"" + u[1] + "\") center/cover";
    return "";
  }

  // Wrap an avatar <img> (or any element) in a frame. Returns the wrapper. size = px.
  function frame(node, vip, size) {
    var wrap = document.createElement("span");
    wrap.className = "vip-av";
    if (size) { wrap.style.width = size + "px"; wrap.style.height = size + "px"; }
    if (node.parentNode) node.parentNode.replaceChild(wrap, node);
    wrap.appendChild(node);
    if (vip && vip.frame) {
      var f = vip.frame;
      wrap.classList.add("has-frame");
      if (KEY.test(String(f.style))) wrap.classList.add("vf-" + f.style);
      if (HEX.test(f.color1 || "")) wrap.style.setProperty("--vc1", f.color1);
      if (HEX.test(f.color2 || "")) wrap.style.setProperty("--vc2", f.color2);
      if (!f.animated) wrap.classList.add("static");
    }
    return wrap;
  }

  // Colour/gradient a name element and add crown, badge, title. Uses textContent only (never innerHTML).
  function decorateName(el, vip, opts) {
    if (!el || !vip) return el;
    opts = opts || {};
    var text = el.textContent;
    el.textContent = "";
    if (vip.crown) { var c = document.createElement("span"); c.className = "vip-crown"; c.textContent = vip.crown; el.appendChild(c); }
    var n = document.createElement("span"); n.className = "vip-name"; n.textContent = text;
    if (vip.nameColor) {
      var v = bg(vip.nameColor);
      if (HEX.test(vip.nameColor)) n.style.color = vip.nameColor;
      else if (v) { n.classList.add("grad"); n.style.backgroundImage = v; }
    }
    el.appendChild(n);
    if (vip.verified) { var ck = document.createElement("span"); ck.className = "vip-verified"; ck.textContent = "✔"; ck.title = "Verified streamer"; el.appendChild(ck); }
    if (vip.badge && !opts.noBadge) el.appendChild(badge(vip.badge));
    if (vip.title && opts.showTitle) { var t = document.createElement("span"); t.className = "vip-title"; t.textContent = vip.title; el.appendChild(t); }
    return el;
  }

  function badge(b) {
    var s = document.createElement("span"); s.className = "vip-badge"; s.title = b.name;
    s.style.background = HEX.test(b.color || "") ? b.color : "#ffc83d";
    if (b.imageUrl && /^(https:\/\/|\/)[A-Za-z0-9_\-./%~?=&]{1,300}$/.test(b.imageUrl)) {
      var i = document.createElement("img"); i.src = b.imageUrl; i.alt = ""; i.loading = "lazy"; s.appendChild(i);
    } else if (b.icon) { var ic = document.createElement("span"); ic.textContent = b.icon; s.appendChild(ic); }
    var nm = document.createElement("span"); nm.textContent = String(b.name || "").replace(/\s*VIP$/i, ""); s.appendChild(nm);
    return s;
  }

  // Special VIP identity card (avatar, framed name, tier, title) — used on the VIP page and profile pages
  function card(vip, who) {
    var d = document.createElement("div");
    d.className = "vip-card t-" + (/^(silver|gold|diamond|royal|legend)$/.test(vip.card || vip.tier) ? (vip.card || vip.tier) : "silver");
    if (vip.background) { var b = bg(vip.background); if (b) d.style.background = b; }
    var row = document.createElement("div"); row.className = "vc-row";
    var av = document.createElement("img"); av.alt = ""; av.width = 56; av.height = 56; av.src = who.avatar || "data:image/svg+xml;utf8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><rect width='56' height='56' fill='#0646b8'/><text x='28' y='37' font-size='26' text-anchor='middle' fill='#fff' font-family='Arial'>" + (String(who.name || "?").charAt(0).toUpperCase().replace(/[<>&]/g, "")) + "</text></svg>");
    row.appendChild(frame(av, vip, 64));
    var box = document.createElement("div");
    var tier = document.createElement("div"); tier.className = "vc-tier"; tier.textContent = (vip.label || "VIP") + " VIP";
    var nm = document.createElement("div"); nm.className = "vc-name"; nm.textContent = who.name || "";
    decorateName(nm, vip, { showTitle: false });
    box.appendChild(tier); box.appendChild(nm);
    if (vip.title) { var t = document.createElement("div"); t.className = "vip-title"; t.style.marginLeft = "0"; t.textContent = vip.title; box.appendChild(t); }
    row.appendChild(box); d.appendChild(row);
    return d;
  }

  // Ask the server who is VIP. ids = handles the page already has. One request for many people, cached for 30s.
  function load(ids) {
    ids = (ids || []).filter(Boolean);
    var need = ids.filter(function (i) { var c = CACHE[i]; return !c || Date.now() - c.at > TTL; });
    if (!need.length) return Promise.resolve(pick(ids));
    var key = need.slice().sort().join(",");
    if (!PENDING[key]) {
      PENDING[key] = fetch("/api/vip/public?ids=" + encodeURIComponent(need.slice(0, 50).join(",")))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var users = (d && d.users) || {};
          need.forEach(function (i) { CACHE[i] = { at: Date.now(), v: users[i] || null }; });
        })
        .catch(function () { need.forEach(function (i) { CACHE[i] = { at: Date.now(), v: null }; }); })
        .then(function () { delete PENDING[key]; });
    }
    return PENDING[key].then(function () { return pick(ids); });
  }
  function pick(ids) { var o = {}; ids.forEach(function (i) { if (CACHE[i] && CACHE[i].v) o[i] = CACHE[i].v; }); return o; }

  window.VicoVIP = { load: load, frame: frame, decorateName: decorateName, badge: badge, card: card, bg: bg };
})();
