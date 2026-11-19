/* =====================================================================
   Vico Pay Live — ANIMAL FACE FILTERS  (vico-animal-filters.js)
   ---------------------------------------------------------------------
   31 kawaii animal face filters (Dog, Cat, Rabbit, Cow, Mouse, Fox, Panda, Lion, Tiger, Bear, Dolphin, Unicorn, Deer, Frog,
   Shark, Elephant, Pig, Goat, Zebra, Giraffe, Penguin, Owl, Wolf, Leopard, Koala, Sheep, Crown ...) cut from your sticker sheet
   (vico-animals.webp). They follow the face (position, size and head tilt).

   HOW VIEWERS SEE IT: this file wraps navigator.mediaDevices.getUserMedia. When the Go Live page (or LiveKit) asks for the camera,
   it receives a processed camera track (camera + filter drawn on a canvas). The host preview AND everything sent to viewers use that
   track, so no change to the page's broadcast code is needed. The server adds this script to Go-Live.html automatically.
   Face tracking (MediaPipe) is downloaded the first time a filter is chosen, so the host needs a normal internet connection.

   Page hooks (all optional):
     <button data-vico-filters>   any element with this attribute opens the filter panel (otherwise a floating "Filters" button is shown)
     VicoAnimals.open() / close() / select("lion") / select("none") / list / current
     window.VICO_HIDE_OLD_FILTERS = ["#oldFilterPanel", ".old-filter-btn"]   CSS selectors of the OLD filter picker to hide
   ===================================================================== */
(function () {
  "use strict";
  if (window.VicoAnimals) return;

  var ATLAS = "vico-animals.webp";
  // id, name, x, y, w, h (in the atlas), ax, ay (where the nose / eyes / mouth / forehead is inside the picture, 0-1), anchor, width as a multiple of the face width
  var RAW = [
  ["dog","Dog",0,0,315,235,0.505,0.655,"nose",1.95],
  ["cat","Cat",319,0,230,229,0.535,0.638,"nose",1.95],
  ["rabbit","Rabbit",553,0,211,242,0.488,0.678,"nose",1.95],
  ["cow","Cow",768,0,498,245,0.283,0.653,"nose",1.95],
  ["mouse","Mouse",1270,0,85,98,0.482,0.153,"nose",1.95],
  ["fox","Fox",1359,0,220,253,0.477,0.692,"nose",1.95],
  ["panda","Panda",1583,0,271,202,0.502,0.713,"nose",1.8],
  ["lion","Lion",0,257,282,267,0.518,0.667,"nose",1.85],
  ["tiger","Tiger",286,257,223,211,0.516,0.73,"nose",1.85],
  ["bear","Bear",513,257,226,211,0.496,0.621,"nose",1.85],
  ["dolphin","Dolphin",743,257,236,216,0.521,0.764,"nose",1.8],
  ["unicorn","Unicorn",983,257,212,194,0.528,0.912,"eyes",1.7],
  ["deer","Deer",1199,257,282,181,0.504,0.867,"nose",1.95],
  ["frog","Frog",1485,257,216,163,0.505,0.834,"mouth",1.8],
  ["shark","Shark",1705,257,214,163,0.505,0.626,"nose",1.8],
  ["elephant","Elephant",0,528,281,192,0.516,0.573,"nose",2.2],
  ["pig","Pig",285,528,194,140,0.495,0.743,"nose",1.95],
  ["goat","Goat",483,528,245,208,0.498,0.74,"nose",1.95],
  ["zebra","Zebra",732,528,248,180,0.508,0.778,"nose",1.9],
  ["giraffe","Giraffe",984,528,245,183,0.498,0.694,"nose",2.0],
  ["penguin","Penguin",1233,528,235,195,0.498,0.61,"nose",1.75],
  ["owl","Owl",1472,528,231,166,0.489,0.639,"eyes",1.4],
  ["spotted-cow","Spotted Cow",1707,528,248,211,0.48,0.668,"nose",1.95],
  ["wolf","Wolf",0,743,208,220,0.486,0.609,"nose",1.8],
  ["leopard","Leopard",212,743,193,151,0.497,0.795,"nose",1.95],
  ["koala","Koala",409,743,246,173,0.488,0.659,"nose",1.9],
  ["fox-cub","Fox Cub",659,743,190,159,0.484,0.849,"nose",1.95],
  ["sheep","Sheep",853,743,214,153,0.486,0.928,"nose",1.9],
  ["princess-cat","Princess Cat",1071,743,191,166,0.497,0.849,"nose",1.95],
  ["penguin-dj","Penguin DJ",1266,743,198,160,0.5,0.65,"nose",1.75],
  ["crown","Crown",1468,743,177,111,0.486,1.036,"top",1.05]
];
  var ITEMS = RAW.map(function (r) { return { id: r[0], name: r[1], x: r[2], y: r[3], w: r[4], h: r[5], ax: r[6], ay: r[7], at: r[8], k: r[9] }; });
  var BY = {}; ITEMS.forEach(function (i) { BY[i.id] = i; });
  var MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  var MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  var KEY = "vicoAnimalFilter";

  var cur = "none", atlasImg = null, atlasReady = false, tracker = { st: "idle", lm: null, p: null }, pipes = [], listeners = [], statusText = "";
  try { var saved = localStorage.getItem(KEY); if (saved && BY[saved]) cur = saved; } catch (e) { /* private mode */ }

  function setStatus(t) { statusText = t || ""; var el = document.getElementById("vaStatus"); if (el) el.textContent = statusText; }

  /* ---------------------------- loading ---------------------------- */
  function loadAtlas() {
    if (atlasImg) return;
    atlasImg = new Image(); atlasImg.onload = function () { atlasReady = true; }; atlasImg.onerror = function () { setStatus("Could not load the filter pictures."); }; atlasImg.src = ATLAS;
  }
  function loadTracker() {
    if (tracker.p) return tracker.p;
    tracker.st = "loading"; setStatus("Loading face tracking…");
    tracker.p = import(MP + "/vision_bundle.mjs").then(function (mod) {
      return mod.FilesetResolver.forVisionTasks(MP + "/wasm").then(function (fs) {
        function make(d) { return mod.FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: MODEL, delegate: d }, runningMode: "VIDEO", numFaces: 1 }); }
        return make("GPU").catch(function () { return make("CPU"); });
      });
    }).then(function (lm) { tracker.lm = lm; tracker.st = "ready"; setStatus("Face tracking ready. Look at the camera."); })
      .catch(function (e) { console.error("Face tracking failed:", e); tracker.st = "failed"; tracker.p = null; setStatus("Filters need an internet connection to start. Check your connection and pick the filter again."); });
    return tracker.p;
  }

  /* ---------------------- face pose from landmarks ---------------------- */
  function P(lm, i, W, H) { return { x: lm[i].x * W, y: lm[i].y * H }; }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function poseFrom(lm, W, H, item) {
    var l = P(lm, 234, W, H), r = P(lm, 454, W, H), e1 = P(lm, 33, W, H), e2 = P(lm, 263, W, H);
    var faceW = Math.hypot(r.x - l.x, r.y - l.y), angle = Math.atan2(e2.y - e1.y, e2.x - e1.x), a;
    if (item.at === "eyes") a = mid(e1, e2);
    else if (item.at === "mouth") a = mid(P(lm, 13, W, H), P(lm, 14, W, H));
    else if (item.at === "top") { var t = P(lm, 10, W, H), c = P(lm, 152, W, H), dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy) || 1; a = { x: t.x + dx / d * faceW * 0.06, y: t.y + dy / d * faceW * 0.06 }; }
    else a = P(lm, 1, W, H);
    return { x: a.x, y: a.y, w: faceW * item.k, a: angle };
  }

  /* ----------------------- the camera pipeline ----------------------- */
  function makeTicker(fn, ms) {   // a Worker timer keeps running at full speed even when the tab is in the background
    try {
      var w = new Worker(URL.createObjectURL(new Blob(["var t;onmessage=function(e){clearInterval(t);if(e.data)t=setInterval(function(){postMessage(1)},e.data)}"], { type: "text/javascript" })));
      w.onmessage = fn; w.postMessage(ms); return function () { w.postMessage(0); w.terminate(); };
    } catch (e) { var t = setInterval(fn, ms); return function () { clearInterval(t); }; }
  }
  function Pipe(raw) {
    var self = this, vt = raw.getVideoTracks()[0], s = vt.getSettings();
    self.raw = raw; self.vt = vt; self.pose = null; self.fade = 0; self.seen = 0; self.frame = 0; self.dead = false;
    self.video = document.createElement("video"); self.video.muted = true; self.video.playsInline = true; self.video.autoplay = true;
    self.video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1";
    self.video.srcObject = new MediaStream([vt]); document.documentElement.appendChild(self.video);
    self.canvas = document.createElement("canvas"); self.ctx = self.canvas.getContext("2d");
    self.canvas.width = s.width || 640; self.canvas.height = s.height || 480;
  }
  Pipe.prototype.start = function () {
    var self = this;
    return self.video.play().catch(function () {}).then(function () {
      return new Promise(function (ok) { if (self.video.videoWidth) return ok(); self.video.onloadeddata = ok; setTimeout(ok, 2500); });
    }).then(function () {
      if (self.video.videoWidth) { self.canvas.width = self.video.videoWidth; self.canvas.height = self.video.videoHeight; }
      var out = self.canvas.captureStream(30), nt = out.getVideoTracks()[0], rt = self.vt;
      // keep the page / LiveKit happy: the new track behaves like the real camera track
      var gs = nt.getSettings.bind(nt); nt.getSettings = function () { var a = {}, r = rt.getSettings(), c = gs(), k; for (k in r) a[k] = r[k]; for (k in c) a[k] = c[k]; return a; };
      nt.applyConstraints = function (c) { return rt.applyConstraints(c); };
      nt.getCapabilities = function () { return rt.getCapabilities ? rt.getCapabilities() : {}; };
      try { Object.defineProperty(nt, "label", { value: rt.label }); } catch (e) { /* ignore */ }
      var stop = nt.stop.bind(nt); nt.stop = function () { stop(); self.stop(); };
      self.out = new MediaStream([nt].concat(self.raw.getAudioTracks()));
      self.cancel = makeTicker(function () { self.tick(); }, 33);
      return self.out;
    });
  };
  Pipe.prototype.stop = function () {
    if (this.dead) return; this.dead = true; if (this.cancel) this.cancel();
    try { this.raw.getTracks().forEach(function (t) { if (t.kind === "video") t.stop(); }); } catch (e) { /* ignore */ }
    try { this.video.srcObject = null; this.video.remove(); } catch (e) { /* ignore */ }
    pipes = pipes.filter(function (p) { return p !== this; }, this);
  };
  Pipe.prototype.tick = function () {
    if (this.dead || this.ticking) return; this.ticking = true;
    try {
      var v = this.video, c = this.canvas, g = this.ctx;
      if (v.videoWidth && (v.videoWidth !== c.width || v.videoHeight !== c.height)) { c.width = v.videoWidth; c.height = v.videoHeight; }
      if (v.readyState >= 2) g.drawImage(v, 0, 0, c.width, c.height);
      var item = BY[cur];
      if (item && atlasReady) this.sticker(item, g, c.width, c.height);
    } finally { this.ticking = false; }
  };
  Pipe.prototype.sticker = function (item, g, W, H) {
    var now = performance.now(), lm = null;
    if (window.VicoAnimals && VicoAnimals._fake) lm = VicoAnimals._fake(W, H);   // test hook
    else if (tracker.st === "ready") {
      try { var r = tracker.lm.detectForVideo(this.video, now); lm = r && r.faceLandmarks && r.faceLandmarks[0]; } catch (e) { lm = null; }
    } else if (tracker.st === "idle") loadTracker();
    if (lm) {
      var p = poseFrom(lm, W, H, item), q = this.pose;
      if (q) { var al = 0.55; p.x = q.x + (p.x - q.x) * al; p.y = q.y + (p.y - q.y) * al; p.w = q.w + (p.w - q.w) * 0.4; p.a = q.a + (p.a - q.a) * 0.4; }
      this.pose = p; this.seen = now; this.fade = Math.min(1, this.fade + 0.25);
      if (this.noFace) { this.noFace = false; setStatus(""); }
    } else if (this.pose && now - this.seen > 450) { this.fade = Math.max(0, this.fade - 0.12); if (!this.fade && !this.noFace && tracker.st === "ready") { this.noFace = true; setStatus("Move into the camera so your face can be seen."); } }
    if (!this.pose || this.fade <= 0) return;
    var p2 = this.pose, w = p2.w, h = w * item.h / item.w;
    g.save(); g.globalAlpha = this.fade; g.translate(p2.x, p2.y); g.rotate(p2.a);
    g.drawImage(atlasImg, item.x, item.y, item.w, item.h, -item.ax * w, -item.ay * h, w, h);
    g.restore();
  };

  /* ------------- wrap getUserMedia so the page gets the filtered camera ------------- */
  var md = navigator.mediaDevices;
  if (md && md.getUserMedia && window.HTMLCanvasElement && HTMLCanvasElement.prototype.captureStream) {
    var orig = md.getUserMedia.bind(md);
    md.getUserMedia = function (c) {
      if (!c || !c.video) return orig(c);
      return orig(c).then(function (raw) {
        if (!raw.getVideoTracks().length) return raw;
        try { var pipe = new Pipe(raw); pipes.push(pipe); return pipe.start().then(function (out) { return out; }, function () { return raw; }); } catch (e) { console.error("Filter pipeline failed:", e); return raw; }
      });
    };
  }

  /* ------------------------------- panel ------------------------------- */
  function thumb(it) {   // a picture box exactly the size of this animal, so neighbours on the sheet never show
    var box = 58, s = box / Math.max(it.w, it.h);
    return '<span class="va-th"><i style="width:' + Math.round(it.w * s) + 'px;height:' + Math.round(it.h * s) + 'px;background-image:url(' + ATLAS + ');background-repeat:no-repeat;background-size:' + (2048 * s) + 'px auto;background-position:' + (-it.x * s) + 'px ' + (-it.y * s) + 'px"></i></span>';
  }
  var built = false;
  function build() {
    if (built || !document.body) return; built = true;
    var css = document.createElement("style");
    css.textContent = [
      "#vaBtn{position:fixed;right:12px;bottom:calc(150px + env(safe-area-inset-bottom));z-index:9500;display:flex;align-items:center;gap:6px;border:0;border-radius:24px;padding:11px 16px;background:linear-gradient(135deg,#1d6fe8,#0f4bb5);color:#fff;font:800 14px system-ui,Arial,sans-serif;box-shadow:0 8px 22px rgba(15,75,181,.45);cursor:pointer}",
      "#vaPanel{position:fixed;left:0;right:0;bottom:0;z-index:9600;display:none;background:rgba(10,32,78,.96);backdrop-filter:blur(8px);color:#fff;border-radius:22px 22px 0 0;padding:14px 12px calc(14px + env(safe-area-inset-bottom));font-family:system-ui,Arial,sans-serif;box-shadow:0 -12px 40px rgba(0,0,0,.45)}",
      "#vaPanel.on{display:block}#vaPanel .hd{display:flex;align-items:center;justify-content:space-between;padding:0 6px 8px}#vaPanel .hd b{font-size:17px}#vaPanel .hd button{border:0;background:rgba(255,255,255,.14);color:#fff;width:34px;height:34px;border-radius:50%;font-size:17px;cursor:pointer}",
      "#vaStatus{min-height:18px;padding:0 6px 8px;font-size:13px;font-weight:700;color:#9fd3ff}",
      "#vaGrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,auto);gap:8px;overflow-x:auto;padding:2px 6px 6px;scrollbar-width:none}#vaGrid::-webkit-scrollbar{display:none}",
      "#vaGrid button{width:76px;border:2px solid transparent;border-radius:16px;background:rgba(255,255,255,.1);color:#fff;padding:6px 4px 5px;display:flex;flex-direction:column;align-items:center;gap:3px;font:700 11px system-ui,Arial,sans-serif;cursor:pointer}",
      "#vaGrid button.on{border-color:#6ec1ff;background:rgba(110,193,255,.25)}.va-th{display:flex;align-items:center;justify-content:center;width:58px;height:58px}.va-th i{display:block}.va-none{display:flex;align-items:center;justify-content:center;width:58px;height:58px;font-size:26px}"
    ].join("");
    document.head.appendChild(css);
    var panel = document.createElement("div"); panel.id = "vaPanel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Animal filters");
    panel.innerHTML = '<div class="hd"><b>🐾 Animal Filters</b><button type="button" id="vaX" aria-label="Close">✕</button></div><div id="vaStatus"></div><div id="vaGrid"><button type="button" data-id="none"><span class="va-none">🚫</span>None</button>' +
      ITEMS.map(function (it) { return '<button type="button" data-id="' + it.id + '">' + thumb(it) + it.name + "</button>"; }).join("") + "</div>";
    document.body.appendChild(panel);
    panel.querySelector("#vaX").onclick = close;
    panel.querySelector("#vaGrid").onclick = function (e) { var b = e.target.closest("button"); if (b) select(b.dataset.id); };
    if (!document.querySelector("[data-vico-filters]")) {
      var btn = document.createElement("button"); btn.id = "vaBtn"; btn.type = "button"; btn.innerHTML = "🐾 Filters"; btn.onclick = open; document.body.appendChild(btn);
    }
    document.addEventListener("click", function (e) { var t = e.target.closest && e.target.closest("[data-vico-filters]"); if (t) { e.preventDefault(); open(); } });
    paintSel();
    // hide the OLD filter picker (selectors you list in VICO_HIDE_OLD_FILTERS, plus the usual ids)
    var list = (window.VICO_HIDE_OLD_FILTERS || []).concat(["#filterPanel", "#filtersPanel", "#filterBar", "#filterList", "#filtersBtn", "#filterBtn", "#effectsPanel", "#effectsBtn", ".filter-panel", ".filters-panel", ".filter-bar", ".filter-strip"]);
    var st = document.createElement("style"); st.textContent = list.join(",") + "{display:none!important}"; document.head.appendChild(st);
  }
  function paintSel() { var g = document.getElementById("vaGrid"); if (!g) return; [].forEach.call(g.children, function (b) { b.classList.toggle("on", b.dataset.id === cur); }); }
  function open() { build(); loadAtlas(); document.getElementById("vaPanel").classList.add("on"); var b = document.getElementById("vaBtn"); if (b) b.style.display = "none"; if (cur !== "none") loadTracker(); }
  function close() { var p = document.getElementById("vaPanel"); if (p) p.classList.remove("on"); var b = document.getElementById("vaBtn"); if (b) b.style.display = ""; }
  function select(id) {
    if (id !== "none" && !BY[id]) return; cur = id; try { localStorage.setItem(KEY, id); } catch (e) { /* ignore */ }
    paintSel(); pipes.forEach(function (p) { p.pose = null; p.fade = 0; p.noFace = false; });
    if (id !== "none") { loadAtlas(); loadTracker(); if (tracker.st === "ready") setStatus(BY[id].name + " is on."); } else setStatus("Filter off.");
    listeners.forEach(function (f) { try { f(id); } catch (e) { /* ignore */ } });
  }

  window.VicoAnimals = {
    list: ITEMS.map(function (i) { return { id: i.id, name: i.name }; }), get current() { return cur; },
    open: open, close: close, select: select, onChange: function (f) { listeners.push(f); }, _fake: null
  };
  loadAtlas(); if (cur !== "none") loadTracker();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
