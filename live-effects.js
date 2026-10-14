/* =====================================================================
   VicoFX - live colour filters, face stickers and screen effects
   ---------------------------------------------------------------------
   * Everything is drawn on a canvas, so VIEWERS SEE IT TOO (not only you).
   * It plugs into LiveKit as a video "processor" (see createProcessor).
   * Three things can be active at the same time, like on Bigo Live:
        1 colour filter  +  1 face sticker  +  1 screen effect
   * Face stickers use MediaPipe face tracking, loaded from the internet the
     first time you pick a sticker (needs a normal internet connection).
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------------------- catalogue ---------------------------- */
  // layers: blend-mode overlays that work in every browser.  css: optional canvas filter (nicer where supported)
  var FILTERS = [
    { id: "none", icon: "🚫", name: "Normal" },
    { id: "pink", icon: "🌸", name: "Pink", layers: [["soft-light", "#ff4fa3", 0.9], ["screen", "#ff9ccc", 0.12]] },
    { id: "blue", icon: "🔵", name: "Blue", layers: [["soft-light", "#2f7bff", 0.9], ["screen", "#7db4ff", 0.08]] },
    { id: "black", icon: "⚫", name: "Black & White", css: "grayscale(1) contrast(1.15)", layers: [["saturation", "#000", 1]] },
    { id: "dark", icon: "🌑", name: "Dark Night", css: "brightness(.62) contrast(1.25) saturate(.8)", layers: [["multiply", "#8a8a95", 0.8]] },
    { id: "red", icon: "🔴", name: "Red", layers: [["soft-light", "#ff2a2a", 0.9], ["screen", "#ff7a7a", 0.08]] },
    { id: "yellow", icon: "🟡", name: "Yellow", layers: [["soft-light", "#ffe02e", 0.9], ["screen", "#fff08a", 0.1]] },
    { id: "green", icon: "🟢", name: "Green", layers: [["soft-light", "#2fd35a", 0.9]] },
    { id: "purple", icon: "🟣", name: "Purple", layers: [["soft-light", "#9b5cff", 0.9], ["screen", "#c9a6ff", 0.08]] },
    { id: "orange", icon: "🟠", name: "Orange", layers: [["soft-light", "#ff8a1f", 0.9]] },
    { id: "warm", icon: "☀️", name: "Warm", layers: [["soft-light", "#ff9a3c", 0.65]] },
    { id: "cool", icon: "🧊", name: "Cool", layers: [["soft-light", "#3cc3ff", 0.65]] },
    { id: "sunset", icon: "🌇", name: "Sunset", layers: [["soft-light", { v: [[0, "#ff5e3a"], [0.55, "#ff4fa3"], [1, "#7b2ff7"]] }, 0.9]] },
    { id: "neon", icon: "💡", name: "Neon", css: "contrast(1.25) saturate(1.8)", layers: [["overlay", "#00e5ff", 0.22]] },
    { id: "dreamy", icon: "☁️", name: "Dreamy", css: "blur(1.4px) brightness(1.1) saturate(1.2)", layers: [["screen", "#ffffff", 0.1], ["soft-light", "#ffb6e6", 0.35]] },
    { id: "beauty", icon: "💄", name: "Beauty", css: "brightness(1.1) contrast(.95) saturate(1.08) blur(.6px)", layers: [["screen", "#ffffff", 0.07], ["soft-light", "#ffc9c0", 0.3]] },
    { id: "vintage", icon: "📷", name: "Vintage", css: "sepia(.45) contrast(.92) saturate(.9)", layers: [["overlay", "#b07a3a", 0.3]] },
    { id: "sepia", icon: "🟤", name: "Sepia", css: "sepia(.95)", layers: [["color", "#704214", 0.5]] },
    { id: "rosegold", icon: "🌹", name: "Rose Gold", layers: [["soft-light", "#ff9d8a", 0.8], ["screen", "#ffd2c4", 0.08]] },
    { id: "mint", icon: "🍃", name: "Mint", layers: [["soft-light", "#5fffd0", 0.8]] }
  ];

  var STICKERS = [
    { id: "none", icon: "🚫", name: "None" },
    { id: "catears", icon: "🐱", name: "Cat Ears" },
    { id: "catface", icon: "😺", name: "Cat Face" },
    { id: "dogears", icon: "🐶", name: "Dog Ears" },
    { id: "dogface", icon: "🐕", name: "Dog Face" },
    { id: "bunny", icon: "🐰", name: "Bunny Ears" },
    { id: "foxears", icon: "🦊", name: "Fox Ears" },
    { id: "bear", icon: "🐻", name: "Bear Ears" },
    { id: "panda", icon: "🐼", name: "Panda Face" },
    { id: "pig", icon: "🐷", name: "Pig Nose" },
    { id: "reindeer", icon: "🦌", name: "Reindeer" },
    { id: "devil", icon: "😈", name: "Devil Horns" },
    { id: "halo", icon: "😇", name: "Angel Halo" },
    { id: "crown", icon: "👑", name: "Crown" },
    { id: "flowers", icon: "🌼", name: "Flower Crown" },
    { id: "partyhat", icon: "🥳", name: "Party Hat" },
    { id: "glasses", icon: "😎", name: "Sunglasses" },
    { id: "hearteyes", icon: "😍", name: "Heart Eyes" },
    { id: "stareyes", icon: "🤩", name: "Star Eyes" },
    { id: "clown", icon: "🤡", name: "Clown Nose" },
    { id: "mustache", icon: "👨", name: "Mustache" },
    { id: "blush", icon: "☺️", name: "Blush" }
  ];

  var EFFECTS = [
    { id: "none", icon: "🚫", name: "None" },
    { id: "sparkle", icon: "✨", name: "Sparkles" },
    { id: "hearts", icon: "❤️", name: "Hearts" },
    { id: "confetti", icon: "🎊", name: "Confetti" },
    { id: "snow", icon: "❄️", name: "Snow" },
    { id: "bubbles", icon: "🫧", name: "Bubbles" },
    { id: "starfall", icon: "🌟", name: "Star Fall" },
    { id: "petals", icon: "🌸", name: "Petals" },
    { id: "fire", icon: "🔥", name: "Fire" },
    { id: "gold", icon: "👑", name: "Gold Glow" },
    { id: "diamond", icon: "💎", name: "Diamond" },
    { id: "love", icon: "💗", name: "Love Glow" },
    { id: "party", icon: "🎉", name: "Party" },
    { id: "rain", icon: "🌧️", name: "Rain" },
    { id: "fireflies", icon: "🪄", name: "Fireflies" },
    { id: "bokeh", icon: "🔮", name: "Bokeh Lights" }
  ];

  var state = { filter: "none", sticker: "none", fx: "none" };
  try { var saved = JSON.parse(localStorage.getItem("vicoFx") || "null"); if (saved) { state.filter = saved.filter || "none"; state.sticker = saved.sticker || "none"; state.fx = saved.fx || "none"; } } catch (e) { }
  function persist() { try { localStorage.setItem("vicoFx", JSON.stringify(state)); } catch (e) { } }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0]; }
  function toast(m) { if (typeof window.showToast === "function") window.showToast(m); }

  var supportsCtxFilter = (function () { try { return "filter" in document.createElement("canvas").getContext("2d"); } catch (e) { return false; } })();

  /* ------------------------- face tracking --------------------------- */
  var tracker = { status: "idle", lm: null, promise: null, warned: false };
  var MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  var MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  function loadTracker() {
    if (tracker.promise) return tracker.promise;
    tracker.status = "loading";
    toast("🙂 Loading face tracking…");
    tracker.promise = import(MP + "/vision_bundle.mjs").then(function (mod) {
      return mod.FilesetResolver.forVisionTasks(MP + "/wasm").then(function (fileset) {
        function make(delegate) {
          return mod.FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate: delegate }, runningMode: "VIDEO", numFaces: 1 });
        }
        return make("GPU").catch(function () { return make("CPU"); });
      });
    }).then(function (lm) {
      tracker.lm = lm; tracker.status = "ready"; toast("🙂 Face tracking is ready.");
    }).catch(function (e) {
      console.error("Face tracking failed to load:", e);
      tracker.status = "failed";
      toast("⚠️ Face stickers need an internet connection to load. Colour filters and effects still work.");
    });
    return tracker.promise;
  }

  var KEYS = [10, 152, 1, 33, 133, 362, 263, 13, 14, 61, 291, 234, 454];
  function detectFace(video, W, H, prev) {
    if (tracker.status !== "ready") return prev;
    var res;
    try { res = tracker.lm.detectForVideo(video, performance.now()); } catch (e) { return prev; }
    if (!res || !res.faceLandmarks || !res.faceLandmarks.length) return null;
    var lm = res.faceLandmarks[0], out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], x = lm[k].x * W, y = lm[k].y * H, p = prev && prev[k];
      out[k] = p ? { x: p.x + (x - p.x) * 0.6, y: p.y + (y - p.y) * 0.6 } : { x: x, y: y };   // light smoothing so stickers do not shake
    }
    return out;
  }
  function faceFrame(P) {
    var cl = P[234], cr = P[454];
    var o = { x: (cl.x + cr.x) / 2, y: (cl.y + cr.y) / 2 };
    var ang = Math.atan2(cr.y - cl.y, cr.x - cl.x), w = Math.hypot(cr.x - cl.x, cr.y - cl.y);
    var ca = Math.cos(-ang), sa = Math.sin(-ang);
    function L(i) { var dx = P[i].x - o.x, dy = P[i].y - o.y; return { x: dx * ca - dy * sa, y: dx * sa + dy * ca }; }
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    var top = L(10), chin = L(152);
    return { o: o, ang: ang, w: w, h: chin.y - top.y, top: top, chin: chin, nose: L(1),
      eyeR: mid(L(33), L(133)), eyeL: mid(L(362), L(263)), mouth: mid(L(13), L(14)) };
  }

  /* --------------------------- drawing helpers ----------------------- */
  function tri(c, x1, y1, x2, y2, x3, y3, fill) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.lineTo(x3, y3); c.closePath(); c.fillStyle = fill; c.fill(); }
  function ell(c, x, y, rx, ry, rot, fill) { c.beginPath(); c.ellipse(x, y, Math.max(rx, 0.1), Math.max(ry, 0.1), rot || 0, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); }
  function line(c, x1, y1, x2, y2, w, col) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.lineWidth = w; c.strokeStyle = col; c.lineCap = "round"; c.stroke(); }
  function rr(c, x, y, w, h, r, fill) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); c.fillStyle = fill; c.fill();
  }
  function emoji(c, ch, x, y, size) {
    c.font = Math.round(size) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#000"; c.fillText(ch, x, y);
  }
  function catEar(c, s, u, ey, outer, inner) {
    tri(c, s * 0.12 * u, ey + 0.02 * u, s * 0.52 * u, ey + 0.10 * u, s * 0.46 * u, ey - 0.40 * u, outer);
    tri(c, s * 0.20 * u, ey + 0.00 * u, s * 0.44 * u, ey + 0.05 * u, s * 0.43 * u, ey - 0.26 * u, inner);
  }
  function dogEar(c, s, u, ey, col, inner) {
    ell(c, s * 0.52 * u, ey + 0.14 * u, 0.14 * u, 0.30 * u, s * 0.35, col);
    ell(c, s * 0.52 * u, ey + 0.16 * u, 0.08 * u, 0.20 * u, s * 0.35, inner);
  }
  function roundEar(c, s, u, ey, col, inner) {
    ell(c, s * 0.42 * u, ey + 0.02 * u, 0.15 * u, 0.15 * u, 0, col);
    ell(c, s * 0.42 * u, ey + 0.03 * u, 0.08 * u, 0.08 * u, 0, inner);
  }

  /* each sticker draws in "face space": origin between the cheeks, x along the ears, y down. u = face width */
  var DRAW = {
    catears: function (c, f) { var u = f.w, ey = f.top.y + 0.08 * u; catEar(c, -1, u, ey, "#2b2b33", "#ff9ec4"); catEar(c, 1, u, ey, "#2b2b33", "#ff9ec4"); },
    catface: function (c, f) {
      var u = f.w, ey = f.top.y + 0.08 * u; catEar(c, -1, u, ey, "#f2a65a", "#ffb6c9"); catEar(c, 1, u, ey, "#f2a65a", "#ffb6c9");
      tri(c, -0.05 * u, f.nose.y - 0.01 * u, 0.05 * u, f.nose.y - 0.01 * u, 0, f.nose.y + 0.05 * u, "#ff6f9c");
      for (var k = -1; k <= 1; k++) { line(c, -0.14 * u, f.nose.y + 0.05 * u + k * 0.02 * u, -0.62 * u, f.nose.y + 0.05 * u + k * 0.09 * u, 0.012 * u, "#ffffff"); line(c, 0.14 * u, f.nose.y + 0.05 * u + k * 0.02 * u, 0.62 * u, f.nose.y + 0.05 * u + k * 0.09 * u, 0.012 * u, "#ffffff"); }
    },
    dogears: function (c, f) { var u = f.w, ey = f.top.y + 0.04 * u; dogEar(c, -1, u, ey, "#7a4a21", "#4d2b10"); dogEar(c, 1, u, ey, "#7a4a21", "#4d2b10"); },
    dogface: function (c, f) {
      var u = f.w, ey = f.top.y + 0.04 * u; dogEar(c, -1, u, ey, "#8b5a2b", "#5a3314"); dogEar(c, 1, u, ey, "#8b5a2b", "#5a3314");
      ell(c, 0, f.nose.y + 0.015 * u, 0.075 * u, 0.055 * u, 0, "#1b1b1b"); ell(c, -0.02 * u, f.nose.y - 0.005 * u, 0.02 * u, 0.012 * u, 0, "#ffffff88");
      ell(c, 0, f.mouth.y + 0.12 * u, 0.06 * u, 0.1 * u, 0, "#ff6f8e"); line(c, 0, f.mouth.y + 0.12 * u, 0, f.mouth.y + 0.19 * u, 0.008 * u, "#c2415f");
    },
    bunny: function (c, f) {
      var u = f.w, ey = f.top.y + 0.05 * u;
      for (var s = -1; s <= 1; s += 2) { ell(c, s * 0.2 * u, ey - 0.3 * u, 0.09 * u, 0.38 * u, s * 0.12, "#ffffff"); ell(c, s * 0.2 * u, ey - 0.28 * u, 0.045 * u, 0.3 * u, s * 0.12, "#ffb3cc"); }
    },
    foxears: function (c, f) { var u = f.w, ey = f.top.y + 0.08 * u; catEar(c, -1, u, ey, "#ff8a1f", "#fff1d6"); catEar(c, 1, u, ey, "#ff8a1f", "#fff1d6"); ell(c, 0, f.nose.y + 0.02 * u, 0.04 * u, 0.03 * u, 0, "#1b1b1b"); },
    bear: function (c, f) { var u = f.w, ey = f.top.y + 0.06 * u; roundEar(c, -1, u, ey, "#7b4a2a", "#d9a371"); roundEar(c, 1, u, ey, "#7b4a2a", "#d9a371"); ell(c, 0, f.nose.y + 0.02 * u, 0.06 * u, 0.045 * u, 0, "#3a2314"); },
    panda: function (c, f) {
      var u = f.w, ey = f.top.y + 0.06 * u; roundEar(c, -1, u, ey, "#111", "#333"); roundEar(c, 1, u, ey, "#111", "#333");
      ell(c, f.eyeR.x, f.eyeR.y, 0.1 * u, 0.13 * u, 0.5, "#111111cc"); ell(c, f.eyeL.x, f.eyeL.y, 0.1 * u, 0.13 * u, -0.5, "#111111cc");
      ell(c, 0, f.nose.y + 0.02 * u, 0.055 * u, 0.04 * u, 0, "#111");
    },
    pig: function (c, f) {
      var u = f.w, ey = f.top.y + 0.1 * u;
      tri(c, -0.40 * u, ey + 0.02 * u, -0.14 * u, ey + 0.04 * u, -0.30 * u, ey - 0.20 * u, "#ff9db5"); tri(c, 0.40 * u, ey + 0.02 * u, 0.14 * u, ey + 0.04 * u, 0.30 * u, ey - 0.20 * u, "#ff9db5");
      ell(c, 0, f.nose.y + 0.05 * u, 0.13 * u, 0.095 * u, 0, "#ff8fab"); ell(c, -0.045 * u, f.nose.y + 0.05 * u, 0.02 * u, 0.034 * u, 0, "#b8456a"); ell(c, 0.045 * u, f.nose.y + 0.05 * u, 0.02 * u, 0.034 * u, 0, "#b8456a");
    },
    reindeer: function (c, f) {
      var u = f.w, ey = f.top.y + 0.08 * u, col = "#8b5a2b";
      for (var s = -1; s <= 1; s += 2) {
        line(c, s * 0.22 * u, ey, s * 0.38 * u, ey - 0.38 * u, 0.045 * u, col); line(c, s * 0.30 * u, ey - 0.18 * u, s * 0.52 * u, ey - 0.26 * u, 0.035 * u, col);
        line(c, s * 0.36 * u, ey - 0.32 * u, s * 0.20 * u, ey - 0.44 * u, 0.03 * u, col); line(c, s * 0.38 * u, ey - 0.38 * u, s * 0.5 * u, ey - 0.52 * u, 0.03 * u, col);
      }
      ell(c, 0, f.nose.y + 0.02 * u, 0.065 * u, 0.065 * u, 0, "#ff2d2d"); ell(c, -0.02 * u, f.nose.y, 0.02 * u, 0.02 * u, 0, "#ffffff99");
    },
    devil: function (c, f) {
      var u = f.w, ey = f.top.y + 0.1 * u;
      for (var s = -1; s <= 1; s += 2) tri(c, s * 0.14 * u, ey + 0.03 * u, s * 0.32 * u, ey + 0.06 * u, s * 0.36 * u, ey - 0.30 * u, "#e5173f");
    },
    halo: function (c, f) {
      var u = f.w, y = f.top.y - 0.2 * u;
      c.save(); c.shadowColor = "#ffe27a"; c.shadowBlur = 0.08 * u; c.beginPath(); c.ellipse(0, y, 0.28 * u, 0.065 * u, 0, 0, Math.PI * 2); c.lineWidth = 0.035 * u; c.strokeStyle = "#ffd84a"; c.stroke(); c.restore();
    },
    crown: function (c, f) { var u = f.w; emoji(c, "👑", 0, f.top.y - 0.08 * u, 0.75 * u); },
    flowers: function (c, f) {
      var u = f.w, fl = ["🌸", "🌼", "🌺", "🌷"];
      for (var i = -4; i <= 4; i++) { var t = i / 4; emoji(c, fl[(i + 4) % fl.length], i * 0.13 * u, f.top.y + 0.1 * u - 0.1 * u * (1 - t * t) + 0.02 * u * Math.abs(i), 0.22 * u); }
    },
    partyhat: function (c, f) {
      var u = f.w, ey = f.top.y + 0.06 * u, g = c.createLinearGradient(-0.2 * u, ey - 0.5 * u, 0.2 * u, ey);
      g.addColorStop(0, "#ff4fa3"); g.addColorStop(1, "#13d1ff");
      tri(c, -0.24 * u, ey + 0.02 * u, 0.24 * u, ey - 0.02 * u, 0.04 * u, ey - 0.56 * u, g);
      ell(c, -0.04 * u, ey - 0.16 * u, 0.02 * u, 0.02 * u, 0, "#fff"); ell(c, 0.07 * u, ey - 0.28 * u, 0.02 * u, 0.02 * u, 0, "#fff"); ell(c, 0.0 * u, ey - 0.38 * u, 0.018 * u, 0.018 * u, 0, "#fff");
      ell(c, 0.04 * u, ey - 0.58 * u, 0.045 * u, 0.045 * u, 0, "#ffe02e");
    },
    glasses: function (c, f) {
      var u = f.w, y = (f.eyeL.y + f.eyeR.y) / 2;
      rr(c, f.eyeR.x - 0.19 * u, y - 0.09 * u, 0.38 * u, 0.18 * u, 0.06 * u, "#111"); rr(c, f.eyeL.x - 0.19 * u, y - 0.09 * u, 0.38 * u, 0.18 * u, 0.06 * u, "#111");
      line(c, f.eyeR.x + 0.19 * u, y - 0.03 * u, f.eyeL.x - 0.19 * u, y - 0.03 * u, 0.025 * u, "#111");
      line(c, f.eyeR.x - 0.12 * u, y - 0.04 * u, f.eyeR.x - 0.04 * u, y - 0.07 * u, 0.012 * u, "#ffffff66"); line(c, f.eyeL.x - 0.12 * u, y - 0.04 * u, f.eyeL.x - 0.04 * u, y - 0.07 * u, 0.012 * u, "#ffffff66");
    },
    hearteyes: function (c, f, t) { var u = f.w, k = 1 + 0.12 * Math.sin(t * 6); emoji(c, "❤️", f.eyeR.x, f.eyeR.y, 0.26 * u * k); emoji(c, "❤️", f.eyeL.x, f.eyeL.y, 0.26 * u * k); },
    stareyes: function (c, f, t) { var u = f.w, k = 1 + 0.1 * Math.sin(t * 7); emoji(c, "⭐", f.eyeR.x, f.eyeR.y, 0.26 * u * k); emoji(c, "⭐", f.eyeL.x, f.eyeL.y, 0.26 * u * k); },
    clown: function (c, f) {
      var u = f.w; ell(c, 0, f.nose.y + 0.02 * u, 0.085 * u, 0.085 * u, 0, "#ff2d2d"); ell(c, -0.025 * u, f.nose.y - 0.01 * u, 0.025 * u, 0.02 * u, 0, "#ffffffaa");
      ell(c, -0.30 * u, f.nose.y + 0.04 * u, 0.07 * u, 0.05 * u, 0, "#ff6f9c88"); ell(c, 0.30 * u, f.nose.y + 0.04 * u, 0.07 * u, 0.05 * u, 0, "#ff6f9c88");
    },
    mustache: function (c, f) {
      var u = f.w, y = f.nose.y + 0.11 * u;
      ell(c, -0.085 * u, y, 0.12 * u, 0.045 * u, 0.28, "#2b1a10"); ell(c, 0.085 * u, y, 0.12 * u, 0.045 * u, -0.28, "#2b1a10");
      ell(c, -0.2 * u, y - 0.025 * u, 0.04 * u, 0.025 * u, 0.9, "#2b1a10"); ell(c, 0.2 * u, y - 0.025 * u, 0.04 * u, 0.025 * u, -0.9, "#2b1a10");
    },
    blush: function (c, f) {
      var u = f.w, y = f.nose.y + 0.05 * u;
      [-1, 1].forEach(function (s) {
        var g = c.createRadialGradient(s * 0.3 * u, y, 0, s * 0.3 * u, y, 0.13 * u); g.addColorStop(0, "rgba(255,80,130,.6)"); g.addColorStop(1, "rgba(255,80,130,0)");
        c.fillStyle = g; c.beginPath(); c.arc(s * 0.3 * u, y, 0.13 * u, 0, Math.PI * 2); c.fill();
      });
    }
  };

  /* ---------------------------- screen effects ----------------------- */
  var EFFECT_CFG = {
    sparkle: { kind: "twinkle", rate: 16, chars: ["✨"], size: [0.03, 0.06] },
    hearts: { kind: "rise", rate: 5, chars: ["❤️", "💗", "💖", "💕"], size: [0.05, 0.09] },
    confetti: { kind: "confetti", rate: 38 },
    snow: { kind: "dot", rate: 30, color: "#ffffff", fall: [40, 110], size: [0.004, 0.011] },
    bubbles: { kind: "bubble", rate: 7 },
    starfall: { kind: "fall", rate: 5, chars: ["⭐", "🌟"], size: [0.04, 0.07] },
    petals: { kind: "fall", rate: 6, chars: ["🌸", "🌺"], size: [0.04, 0.07] },
    fire: { kind: "spark", rate: 45, glow: "fire" },
    gold: { kind: "twinkle", rate: 12, chars: ["✨", "⭐"], size: [0.03, 0.05], glow: "gold" },
    diamond: { kind: "rise", rate: 3.5, chars: ["💎", "✨"], size: [0.04, 0.07], glow: "diamond" },
    love: { kind: "rise", rate: 4, chars: ["💗", "❤️"], size: [0.05, 0.08], glow: "love" },
    party: { kind: "confetti", rate: 30, glow: "party" },
    rain: { kind: "rain", rate: 90 },
    fireflies: { kind: "firefly", rate: 3 },
    bokeh: { kind: "bokeh", rate: 2.5 }
  };
  var CONFETTI = ["#ff4fa3", "#13d1ff", "#ffe02e", "#7cff6b", "#9b5cff", "#ff8a1f"];
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function spawn(cfg, W, H) {
    var p = { x: rnd(0, W), y: rnd(0, H), vx: 0, vy: 0, size: 10, life: 0, max: 3, rot: rnd(0, 6.28), vr: 0, ph: rnd(0, 6.28), ch: null, col: "#fff" };
    var S = Math.min(W, H);
    switch (cfg.kind) {
      case "twinkle": p.max = rnd(0.9, 1.6); p.size = rnd(cfg.size[0], cfg.size[1]) * H; p.ch = cfg.chars[Math.floor(Math.random() * cfg.chars.length)]; break;
      case "rise": p.y = H + 20; p.vy = -rnd(0.12, 0.28) * H; p.vx = rnd(-20, 20); p.max = 9; p.size = rnd(cfg.size[0], cfg.size[1]) * H; p.ch = cfg.chars[Math.floor(Math.random() * cfg.chars.length)]; break;
      case "fall": p.y = -20; p.vy = rnd(0.1, 0.22) * H; p.vx = rnd(-30, 30); p.vr = rnd(-2, 2); p.max = 12; p.size = rnd(cfg.size[0], cfg.size[1]) * H; p.ch = cfg.chars[Math.floor(Math.random() * cfg.chars.length)]; break;
      case "confetti": p.y = -20; p.vy = rnd(0.12, 0.3) * H; p.vx = rnd(-40, 40); p.vr = rnd(-8, 8); p.max = 10; p.size = rnd(0.008, 0.016) * S; p.col = CONFETTI[Math.floor(Math.random() * CONFETTI.length)]; break;
      case "dot": p.y = -10; p.vy = rnd(cfg.fall[0], cfg.fall[1]) * (H / 640); p.vx = rnd(-15, 15); p.max = 14; p.size = rnd(cfg.size[0], cfg.size[1]) * H; p.col = cfg.color; break;
      case "bubble": p.y = H + 20; p.vy = -rnd(0.06, 0.16) * H; p.vx = rnd(-10, 10); p.max = 12; p.size = rnd(0.012, 0.04) * H; break;
      case "spark": p.y = H + 5; p.x = rnd(0, W); p.vy = -rnd(0.15, 0.45) * H; p.vx = rnd(-25, 25); p.max = rnd(0.8, 1.6); p.size = rnd(0.003, 0.008) * H; p.col = ["#ff5a00", "#ff9d00", "#ffd24a"][Math.floor(Math.random() * 3)]; break;
      case "rain": p.y = -30; p.vy = rnd(0.7, 1.1) * H; p.vx = -rnd(30, 60); p.max = 3; p.size = rnd(0.02, 0.045) * H; break;
      case "firefly": p.vx = rnd(-18, 18); p.vy = rnd(-18, 18); p.max = rnd(3, 5); p.size = rnd(0.004, 0.009) * H; break;
      case "bokeh": p.vx = rnd(-8, 8); p.vy = rnd(-8, 8); p.max = rnd(3, 5); p.size = rnd(0.04, 0.09) * H; p.col = ["#ff9ccc", "#9fe8ff", "#fff3a0", "#d6b8ff"][Math.floor(Math.random() * 4)]; break;
    }
    return p;
  }
  function stepParticle(p, dt) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; }
  function drawParticle(c, cfg, p, W, H) {
    var a, k = p.life / p.max;
    switch (cfg.kind) {
      case "twinkle": a = Math.sin(Math.PI * k); c.globalAlpha = a; emoji(c, p.ch, p.x, p.y, p.size * (0.6 + 0.6 * a)); break;
      case "rise": c.globalAlpha = Math.min(1, (1 - k) * 2); emoji(c, p.ch, p.x + Math.sin(p.life * 2 + p.ph) * 18, p.y, p.size); break;
      case "fall": c.globalAlpha = Math.min(1, (1 - k) * 2); c.save(); c.translate(p.x + Math.sin(p.life * 1.5 + p.ph) * 22, p.y); c.rotate(p.rot); emoji(c, p.ch, 0, 0, p.size); c.restore(); break;
      case "confetti": c.globalAlpha = 1; c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.col; c.fillRect(-p.size, -p.size / 2, p.size * 2, p.size); c.restore(); break;
      case "dot": c.globalAlpha = 0.85; c.fillStyle = p.col; c.beginPath(); c.arc(p.x + Math.sin(p.life + p.ph) * 12, p.y, p.size, 0, 6.283); c.fill(); break;
      case "bubble": c.globalAlpha = 0.7; c.lineWidth = 1.5; c.strokeStyle = "rgba(255,255,255,.85)"; c.fillStyle = "rgba(190,230,255,.18)"; c.beginPath(); c.arc(p.x + Math.sin(p.life * 2 + p.ph) * 10, p.y, p.size, 0, 6.283); c.fill(); c.stroke(); break;
      case "spark": c.globalAlpha = 1 - k; c.fillStyle = p.col; c.beginPath(); c.arc(p.x, p.y, p.size, 0, 6.283); c.fill(); break;
      case "rain": c.globalAlpha = 0.55; line(c, p.x, p.y, p.x + p.vx * 0.03, p.y - p.size, 1.4, "#bfe3ff"); break;
      case "firefly": a = Math.sin(Math.PI * k); c.globalAlpha = a; c.save(); c.shadowColor = "#fff27a"; c.shadowBlur = p.size * 4; c.fillStyle = "#fff9b0"; c.beginPath(); c.arc(p.x, p.y, p.size, 0, 6.283); c.fill(); c.restore(); break;
      case "bokeh": a = Math.sin(Math.PI * k) * 0.45; c.globalAlpha = a; c.fillStyle = p.col; c.beginPath(); c.arc(p.x, p.y, p.size, 0, 6.283); c.fill(); break;
    }
    c.globalAlpha = 1;
  }
  function glow(c, W, H, kind, t) {
    var g;
    c.save();
    if (kind === "fire") { g = c.createLinearGradient(0, H, 0, H * 0.45); g.addColorStop(0, "rgba(255,90,0,.55)"); g.addColorStop(1, "rgba(255,90,0,0)"); c.globalCompositeOperation = "screen"; c.fillStyle = g; c.fillRect(0, 0, W, H); }
    else {
      var col = { gold: "255,200,40", diamond: "60,220,255", love: "255,80,150" }[kind];
      if (col) { g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75); g.addColorStop(0, "rgba(" + col + ",0)"); g.addColorStop(1, "rgba(" + col + ",.5)"); c.fillStyle = g; c.fillRect(0, 0, W, H); }
      if (kind === "party") { var h = (t * 60) % 360; c.globalCompositeOperation = "soft-light"; c.fillStyle = "hsla(" + h + ",90%,60%,.35)"; c.fillRect(0, 0, W, H); }
    }
    c.restore();
  }

  /* ------------------------------ engine ----------------------------- */
  function Engine() {
    this.name = "vico-fx";
    this.processedTrack = undefined;
    this.parts = []; this.acc = 0; this.last = 0; this.frame = 0; this.face = null; this.miss = 0; this.timer = null;
  }
  Engine.prototype.init = function (opts) {
    var self = this;
    self.stop();
    self.video = document.createElement("video");
    self.video.muted = true; self.video.playsInline = true; self.video.autoplay = true;
    self.video.srcObject = new MediaStream([opts.track]);
    self.canvas = document.createElement("canvas");
    var s = (opts.track.getSettings && opts.track.getSettings()) || {};
    self.canvas.width = s.width || 640; self.canvas.height = s.height || 480;
    self.ctx = self.canvas.getContext("2d");
    var cap = self.canvas.captureStream(30);
    self.processedTrack = cap.getVideoTracks()[0];
    self.last = performance.now();
    return self.video.play().catch(function () { }).then(function () {
      self.timer = setInterval(function () { self.draw(); }, 33);
    });
  };
  Engine.prototype.restart = function (opts) { return this.init(opts); };
  Engine.prototype.stop = function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } };
  Engine.prototype.destroy = function () {
    this.stop();
    if (this.video) { this.video.srcObject = null; this.video = null; }
    if (this.processedTrack) { try { this.processedTrack.stop(); } catch (e) { } }
    this.processedTrack = undefined;
    var i = engines.indexOf(this); if (i >= 0) engines.splice(i, 1);
    return Promise.resolve();
  };
  Engine.prototype.draw = function () {
    var v = this.video, c = this.ctx;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    var W = v.videoWidth, H = v.videoHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    var now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000), t = now / 1000; this.last = now;
    var flt = byId(FILTERS, state.filter);

    /* 1. camera picture + colour filter */
    c.globalCompositeOperation = "source-over"; c.globalAlpha = 1;
    if (flt.css && supportsCtxFilter) c.filter = flt.css;
    c.drawImage(v, 0, 0, W, H);
    if (supportsCtxFilter) c.filter = "none";
    if (flt.layers) {
      for (var i = 0; i < flt.layers.length; i++) {
        var L = flt.layers[i], mode = L[0], src = L[1], alpha = L[2];
        if (flt.css && supportsCtxFilter && (mode === "saturation" || mode === "color")) continue;   // the CSS filter already did this part
        c.globalCompositeOperation = mode; c.globalAlpha = alpha;
        if (typeof src === "string") c.fillStyle = src;
        else { var g = c.createLinearGradient(0, 0, 0, H); src.v.forEach(function (s) { g.addColorStop(s[0], s[1]); }); c.fillStyle = g; }
        c.fillRect(0, 0, W, H);
      }
      c.globalCompositeOperation = "source-over"; c.globalAlpha = 1;
    }

    /* 2. face sticker */
    if (state.sticker !== "none" && DRAW[state.sticker]) {
      this.frame++;
      if (this.frame % 2 === 0) {
        var f = detectFace(v, W, H, this.face);
        if (f === null) { if (++this.miss > 8) this.face = null; } else { this.face = f; this.miss = 0; }
      }
      if (this.face) {
        var fr = faceFrame(this.face);
        c.save(); c.translate(fr.o.x, fr.o.y); c.rotate(fr.ang);
        try { DRAW[state.sticker](c, fr, t); } catch (e) { /* never let one bad frame stop the live */ }
        c.restore();
      }
    } else { this.face = null; }

    /* 3. screen effect */
    var cfg = EFFECT_CFG[state.fx];
    if (cfg) {
      if (cfg.glow) glow(c, W, H, cfg.glow, t);
      this.acc += cfg.rate * dt;
      while (this.acc >= 1 && this.parts.length < 140) { this.acc -= 1; this.parts.push(spawn(cfg, W, H)); }
      if (this.acc > 3) this.acc = 0;
      for (var j = this.parts.length - 1; j >= 0; j--) {
        var p = this.parts[j]; stepParticle(p, dt);
        if (p.life >= p.max || p.y < -60 || p.y > H + 60 || p.x < -60 || p.x > W + 60) { this.parts.splice(j, 1); continue; }
        drawParticle(c, cfg, p, W, H);
      }
    } else if (this.parts.length) { this.parts.length = 0; }
  };

  var engines = [], preview = null;

  /* ------------------------------ public API ------------------------- */
  var API = {
    FILTERS: FILTERS, STICKERS: STICKERS, EFFECTS: EFFECTS, state: state,
    set: function (kind, id) {
      state[kind] = id; persist();
      if (kind === "sticker" && id !== "none" && tracker.status === "idle") loadTracker();
    },
    clear: function () { state.filter = "none"; state.sticker = "none"; state.fx = "none"; persist(); },
    // hand this to LiveKit:  videoTrack.setProcessor(VicoFX.createProcessor())
    createProcessor: function () {
      var e = new Engine(); engines.push(e);
      if (state.sticker !== "none" && tracker.status === "idle") loadTracker();
      return e;
    },
    // effects on the camera preview BEFORE you press Start Live
    startPreview: function (videoEl, mediaStream) {
      API.stopPreview();
      var vt = mediaStream && mediaStream.getVideoTracks()[0]; if (!vt) return Promise.resolve();
      var e = new Engine(); engines.push(e); preview = e;
      if (state.sticker !== "none" && tracker.status === "idle") loadTracker();
      return e.init({ track: vt }).then(function () { videoEl.srcObject = new MediaStream([e.processedTrack]); });
    },
    stopPreview: function () { if (preview) { preview.destroy(); preview = null; } }
  };
  window.VicoFX = API;
})();
