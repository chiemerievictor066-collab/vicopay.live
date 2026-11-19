/* Vico Pay Live - the small panel under the moving chat on Go Live and Watch Live:
   [ Processing Promotion (blue)  |  Promotion Successful (green, circle with a tick) ]
   [ the streamer's story: first line, "Show more" opens the rest ]
   [ 🔴 Live since 3:42 PM · 00:12:35  (ticking) ]
   Used by Go-Live.html (role "host": the buttons work) and live-feed.html / vip-live-feed.html (role "viewer": read only). */
(function () {
  "use strict";
  if (window.VicoLivePanel) return;
  var css = document.createElement("style");
  css.textContent =
    ".vlp{display:flex;flex-direction:column;gap:6px;width:100%;pointer-events:auto;color:#fff;font-family:inherit}" +
    ".vlp-promo{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;border:0;border-radius:22px;padding:9px 16px 9px 10px;font:800 14px system-ui,Arial,sans-serif;color:#fff;cursor:pointer;background:linear-gradient(180deg,#2a8cff,#0b5fe0);box-shadow:0 6px 16px rgba(10,80,220,.45)}" +
    ".vlp-promo .vlp-ic{width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.22);display:inline-flex;align-items:center;justify-content:center;font-size:13px}" +
    ".vlp-promo.ok{background:linear-gradient(180deg,#22c55e,#15803d);box-shadow:0 6px 16px rgba(20,160,80,.5)}" +
    ".vlp-promo.ok .vlp-ic{background:#fff;color:#16a34a;font-weight:900;font-size:15px}" +
    ".vlp-promo.ro{cursor:default}" +
    ".vlp-story{background:rgba(3,16,48,.58);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:7px 11px;backdrop-filter:blur(6px);max-width:100%}" +
    ".vlp-text{font-size:13px;line-height:1.35;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;text-shadow:0 1px 3px #000}" +
    ".vlp-story.open .vlp-text{-webkit-line-clamp:unset;display:block;max-height:140px;overflow-y:auto;overscroll-behavior:contain}" +
    ".vlp-more{border:0;background:none;color:#7fd0ff;font:800 12px system-ui,Arial,sans-serif;padding:3px 0 0;cursor:pointer}" +
    ".vlp-clock{font-size:12px;font-weight:700;opacity:.95;text-shadow:0 1px 3px #000;display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
    ".vlp-clock b{font-variant-numeric:tabular-nums;letter-spacing:.3px}";
  document.head.appendChild(css);
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dur(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60); }
  function clock(t) { var d = new Date(t), h = d.getHours(), ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + pad(d.getMinutes()) + " " + ap; }

  function create(opts) {
    opts = opts || {};
    var host = opts.role === "host", st = { promoted: false, story: "", startedAt: 0, endedAt: 0 }, timer = null;
    var el = document.createElement("div"); el.className = "vlp";
    el.innerHTML = '<button type="button" class="vlp-promo"></button><div class="vlp-story" hidden><div class="vlp-text"></div><button type="button" class="vlp-more" hidden>Show more</button></div><div class="vlp-clock" hidden></div>';
    var btn = el.querySelector(".vlp-promo"), box = el.querySelector(".vlp-story"), txt = el.querySelector(".vlp-text"), more = el.querySelector(".vlp-more"), clk = el.querySelector(".vlp-clock");
    function paintPromo() {
      btn.className = "vlp-promo" + (st.promoted ? " ok" : "") + (host ? "" : " ro");
      btn.innerHTML = st.promoted ? '<span class="vlp-ic">✓</span>Promotion Successful' : '<span class="vlp-ic">⏳</span>Processing Promotion';
      btn.title = host ? (st.promoted ? "You are promoted. Open your VIP features." : "Tap to get promoted now") : (st.promoted ? "This streamer is promoted" : "This streamer has not been promoted yet");
      if (!host) btn.setAttribute("aria-disabled", "true"); else btn.removeAttribute("aria-disabled");
    }
    function measure() { if (!st.story) return; var open = box.classList.contains("open"); more.hidden = !(open || txt.scrollHeight > txt.clientHeight + 1 || /\n/.test(st.story)); }
    function paintStory() {
      box.hidden = !st.story; txt.textContent = st.story; box.classList.remove("open"); more.textContent = "Show more";
      requestAnimationFrame(measure);
    }
    function tick() {
      if (!st.startedAt) { clk.hidden = true; return; }
      clk.hidden = false;
      var end = st.endedAt || Date.now();
      clk.innerHTML = st.endedAt ? '⚫ Live ended · lasted <b>' + dur(end - st.startedAt) + '</b>' : '🔴 Live since ' + clock(st.startedAt) + ' · <b>' + dur(end - st.startedAt) + '</b>';
    }
    btn.onclick = function () { if (!host) return; if (st.promoted) { if (opts.onVip) opts.onVip(); } else if (opts.onPromo) opts.onPromo(); };
    more.onclick = function () { var o = box.classList.toggle("open"); more.textContent = o ? "Show less" : "Show more"; };
    window.addEventListener("resize", measure);
    paintPromo(); tick(); timer = setInterval(tick, 1000);
    return {
      el: el,
      set: function (o) {
        if (o.promoted !== undefined && !!o.promoted !== st.promoted) { st.promoted = !!o.promoted; paintPromo(); }
        if (o.story !== undefined && String(o.story || "") !== st.story) { st.story = String(o.story || ""); paintStory(); }
        if (o.startedAt !== undefined) { var t = typeof o.startedAt === "number" ? o.startedAt : Date.parse(o.startedAt); st.startedAt = isFinite(t) ? t : 0; tick(); }
      },
      end: function () { if (!st.endedAt) { st.endedAt = Date.now(); tick(); } clearInterval(timer); },
      reset: function () { st.endedAt = 0; st.startedAt = 0; clearInterval(timer); timer = setInterval(tick, 1000); tick(); },
      destroy: function () { clearInterval(timer); window.removeEventListener("resize", measure); if (el.parentNode) el.parentNode.removeChild(el); }
    };
  }
  window.VicoLivePanel = { create: create, fmtDuration: dur };
})();
