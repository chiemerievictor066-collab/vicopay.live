/* =====================================================
   VicoPay Live — VIP entrance player
   Usage (viewer page, when a live event arrives):
       if (ev.type === "vip_join" && window.VicoEntrance) VicoEntrance.play(ev, slideElement);
   The server decides WHO gets an entrance and WHICH videos play (/api/admin/vip/effects); this file only draws it:
     1. first video plays (the car), 2. then the second (the crown),
     3. when the crown starts, a notice "<name> joined the exclusive room" slides in from the RIGHT,
        stays 3 seconds and leaves to the LEFT.
   One entrance at a time, a small queue for bursts, one <video> element, nothing runs when idle - so live streaming is not slowed.
   ===================================================== */
(function () {
  var QUEUE = [], busy = false, cssDone = false, MAXQ = 4;
  var VID = /^gift-[a-z0-9-]+\.mp4$/;

  function css() {
    if (cssDone) return; cssDone = true;
    var s = document.createElement("style");
    s.textContent =
      ".vent{position:absolute;inset:0;z-index:9;pointer-events:none;overflow:hidden;display:grid;place-items:center}" +
      ".vent video{width:min(64%,330px);aspect-ratio:9/16;object-fit:cover;background:transparent;mix-blend-mode:screen;opacity:0;transition:opacity .45s ease;" +
      "-webkit-mask-image:radial-gradient(closest-side,#000 62%,transparent 100%);mask-image:radial-gradient(closest-side,#000 62%,transparent 100%)}" +
      ".vent video.on{opacity:1}" +
      ".vent-note{position:absolute;top:24%;right:0;left:0;display:flex;justify-content:center;padding:0 10px;opacity:0}" +
      ".vent-note span{max-width:92%;background:linear-gradient(90deg,#8a5a00,#ffc83d 55%,#ffe27a);color:#1b1300;font-weight:900;font-size:14px;line-height:1.3;" +
      "padding:9px 16px;border-radius:22px;box-shadow:0 6px 22px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.55);text-align:center;word-break:break-word}" +
      "@media (prefers-reduced-motion:reduce){.vent video{transition:none}}";
    document.head.appendChild(s);
  }

  function play(ev, host) {
    if (!ev || !host) return;
    if (QUEUE.length >= MAXQ) return;
    QUEUE.push({ ev: ev, host: host });
    next();
  }
  function next() {
    if (busy) return;
    var it = QUEUE.shift(); if (!it) return;
    busy = true;
    run(it.ev, it.host, function () { busy = false; next(); });
  }

  function run(ev, host, done) {
    css();
    var list = (ev.videos || []).filter(function (v) { return VID.test(String(v)); }).slice(0, 4);
    var fixed = host === document.body;
    if (!fixed && getComputedStyle(host).position === "static") host.style.position = "relative";
    var layer = document.createElement("div"); layer.className = "vent";
    var v = document.createElement("video");
    v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "auto"; v.volume = 0.8;
    layer.appendChild(v); host.appendChild(layer);

    var i = 0, over = false, timer = null;
    function finish() {
      if (over) return; over = true; clearTimeout(timer);
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) { /* ignore */ }
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      done();
    }
    function showNote() {
      var n = document.createElement("div"); n.className = "vent-note";
      var t = document.createElement("span");
      t.textContent = String(ev.text || ((ev.name || "A VIP") + " joined the exclusive room")).slice(0, 120);   // text only, never HTML
      n.appendChild(t); layer.appendChild(n);
      // in from the RIGHT (0.4s), stay 3s, out to the LEFT (0.4s)
      if (n.animate) {
        var a = n.animate([
          { transform: "translateX(110%)", opacity: 0 },
          { transform: "translateX(0)", opacity: 1, offset: 0.1 },
          { transform: "translateX(0)", opacity: 1, offset: 0.9 },
          { transform: "translateX(-110%)", opacity: 0 }
        ], { duration: 3800, easing: "ease-in-out", fill: "both" });
        a.onfinish = function () { if (n.parentNode) n.parentNode.removeChild(n); };
      } else { n.style.opacity = 1; setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 3000); }
      noteEnd = Date.now() + 3800;
    }
    var noteEnd = 0;
    function step() {
      if (over) return;
      if (i >= list.length) {
        if (!noteEnd) showNote();                                   // the last video failed to start: still show the notice
        setTimeout(finish, Math.max(300, noteEnd - Date.now()));    // wait for the notice to finish leaving
        return;
      }
      var isLast = i === list.length - 1;
      var src = "/" + list[i++];
      v.classList.remove("on");
      v.onended = function () { clearTimeout(timer); v.classList.remove("on"); setTimeout(step, 250); };
      v.onerror = function () { clearTimeout(timer); step(); };
      timer = setTimeout(function () { v.onended && v.onended(); }, 7500);   // never hang on a slow connection
      v.src = src;
      var p = v.play();
      if (p && p.catch) p.catch(function () { v.muted = true; var q = v.play(); if (q && q.catch) q.catch(function () { clearTimeout(timer); step(); }); });
      v.onplaying = function () { v.classList.add("on"); if (isLast && !noteEnd) showNote(); };
    }
    if (!list.length) { showNote(); setTimeout(finish, 3900); return; }
    step();
    // safety: the whole entrance can never run longer than 25 seconds
    setTimeout(finish, 25000);
  }

  window.VicoEntrance = { play: play };
})();
