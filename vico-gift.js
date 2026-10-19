/* VicoGifts - full-screen animated gift effects (canvas + synthesized sound).
   VicoGifts.play("Lion",{container:el,from:"Ada",combo:1})   -> plays the effect over `container`
   VicoGifts.mini(canvas,"Lion")                               -> small looping preview (gift shop)  */
(function () {
  "use strict";
  var M = Math, PI = M.PI, TAU = PI * 2, rnd = function (a, b) { return a + M.random() * (b - a); };
  var cl = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  var outBack = function (x) { x = cl(x); var s = 1.7; return 1 + (s + 1) * M.pow(x - 1, 3) + s * M.pow(x - 1, 2); };
  var outCubic = function (x) { x = cl(x); return 1 - M.pow(1 - x, 3); };
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------ catalogue ------------------------------ */
  var G = {
    Like: { d: 2.8 }, Rose: { d: 4.2, t: "ROSE OF LOVE" }, Fire: { d: 3.4 }, Strawberry: { d: 3.6 }, Star: { d: 3.8 },
    Trophy: { d: 4.4, t: "CHAMPION" }, Car: { d: 4.2, t: "SUPERCAR" }, Silver: { d: 3.8, t: "SILVER MEDAL" },
    Diamond: { d: 4.4, t: "DIAMOND EXPLOSION" }, Gold: { d: 4.2, t: "GOLD RAIN" }, Eagle: { d: 4.6, t: "GOLDEN EAGLE" },
    Lion: { d: 5, t: "MEGA LION" }, Dragon: { d: 5.4, t: "MEGA DRAGON" }, Elephant: { d: 5.4, t: "MIGHTY ELEPHANT" }, Whale: { d: 5.8, t: "GIANT WHALE" }
  };

  /* -------------------------------- sound -------------------------------- */
  var AC = null, MG = null;
  function ac() {
    try {
      if (!AC) { AC = new (window.AudioContext || window.webkitAudioContext)(); MG = AC.createGain(); MG.gain.value = .55; MG.connect(AC.destination); }
      if (AC.state === "suspended") AC.resume();
    } catch (e) { AC = null; }
    return AC;
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (e) { addEventListener(e, ac, { once: true, passive: true }); });
  function gainEnv(T, a, d, v) { var g = AC.createGain(); g.gain.setValueAtTime(.0001, T); g.gain.exponentialRampToValueAtTime(v, T + a); g.gain.exponentialRampToValueAtTime(.0001, T + a + d); g.connect(MG); return g; }
  function noiseSrc(dur) { var b = AC.createBuffer(1, AC.sampleRate * dur, AC.sampleRate), d = b.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = rnd(-1, 1); var s = AC.createBufferSource(); s.buffer = b; return s; }
  function tone(type, f0, f1, T, dur, v, o) {
    o = o || {}; var s = AC.createOscillator(), g = gainEnv(T, o.a || .02, dur, v), n = s;
    s.type = type; s.frequency.setValueAtTime(f0, T); s.frequency.exponentialRampToValueAtTime(f1, T + dur);
    if (o.lp) { var f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; s.connect(f); f.connect(g); } else s.connect(g);
    if (o.vib) { var l = AC.createOscillator(), lg = AC.createGain(); l.frequency.value = o.vib; lg.gain.value = f0 * .04; l.connect(lg); lg.connect(s.frequency); l.start(T); l.stop(T + dur + .1); }
    s.start(T); s.stop(T + dur + .1);
  }
  function nz(T, dur, v, type, f0, f1, q) {
    var s = noiseSrc(dur + .1), f = AC.createBiquadFilter(), g = gainEnv(T, .03, dur, v); f.type = type; f.Q.value = q || 1;
    f.frequency.setValueAtTime(f0, T); f.frequency.exponentialRampToValueAtTime(f1, T + dur); s.connect(f); f.connect(g); s.start(T);
  }
  var SFX = {
    whoosh: function (T, d) { nz(T, d || .7, .5, "bandpass", 300, 2200, 1.2); },
    boom: function (T) { nz(T, 1.3, .9, "lowpass", 400, 40, .7); tone("sine", 90, 28, T, 1, .9); },
    thunder: function (T) { nz(T, 2, .8, "lowpass", 600, 50, .6); tone("sawtooth", 55, 30, T, 1.6, .25, { lp: 160 }); },
    roar: function (T, d) { tone("sawtooth", 95, 55, T, d, .55, { lp: 900, vib: 26 }); nz(T, d, .45, "bandpass", 700, 500, 2); },
    chime: function (T) { [880, 1109, 1319, 1760, 2093].forEach(function (f, i) { tone("sine", f, f, T + i * .08, .7, .09); }); },
    sparkle: function (T) { for (var i = 0; i < 8; i++) tone("sine", rnd(1800, 3800), rnd(1800, 3800), T + i * .06, .25, .05); },
    trumpet: function (T) { tone("sawtooth", 300, 470, T, 1.5, .4, { lp: 1900, vib: 6, a: .15 }); tone("square", 302, 474, T, 1.5, .12, { lp: 1500, a: .15 }); },
    whale: function (T) { tone("sine", 110, 330, T, 1.4, .55, { vib: 5, a: .3 }); tone("sine", 330, 85, T + 1.3, 1.6, .5, { vib: 5, a: .1 }); },
    engine: function (T) { tone("sawtooth", 50, 190, T, 1.4, .35, { lp: 500 }); tone("sawtooth", 190, 70, T + 1.3, 1.6, .3, { lp: 400 }); nz(T, 2.8, .12, "bandpass", 800, 2400, .8); },
    water: function (T) { nz(T, 1.4, .6, "lowpass", 2500, 300, .5); },
    fanfare: function (T) { [523, 659, 784, 1047, 784, 1047].forEach(function (f, i) { tone("square", f, f, T + i * .16, .35, .12, { lp: 2400 }); }); },
    coin: function (T) { for (var i = 0; i < 10; i++) tone("triangle", rnd(1400, 2600), rnd(1400, 2600), T + i * .09, .18, .07); },
    pop: function (T) { tone("sine", 500, 1200, T, .2, .3); },
    flame: function (T, d) { nz(T, d || 1.5, .55, "bandpass", 200, 900, .7); }
  };

  /* ------------------------------ scene core ------------------------------ */
  function mk(name, ctx, W, H, silent) { return { name: name, c: ctx, W: W, H: H, u: M.min(W, H) / 100, t: 0, dt: .016, parts: [], acc: {}, done: {}, flash: 0, fcol: "255,255,255", shake: 0, silent: !!silent, banner: null }; }
  function snd(S, f) { if (S.silent || !ac() || AC.state !== "running") return; try { f(AC.currentTime + .02); } catch (e) { } }
  function once(S, k, t, f) { if (S.t >= t && !S.done[k]) { S.done[k] = 1; f(); } }
  function rate(S, k, per, f) { S.acc[k] = (S.acc[k] || 0) + per * S.dt; while (S.acc[k] >= 1) { S.acc[k]--; f(); } }
  function add(S, o) { o.vx = o.vx || 0; o.vy = o.vy || 0; o.g = o.g || 0; o.a = o.a == null ? 1 : o.a; o.rot = o.rot || 0; o.vr = o.vr || 0; o.max = o.life = o.life || 1; o.sz = o.sz || 6; o.col = o.col || "255,255,255"; S.parts.push(o); if (S.parts.length > 700) S.parts.shift(); }
  function burst(S, x, y, n, k, col, sp, life, sz, g) { for (var i = 0; i < n; i++) { var a = rnd(0, TAU), s = rnd(.2, 1) * sp; add(S, { k: k, x: x, y: y, vx: M.cos(a) * s, vy: M.sin(a) * s, g: g || 0, col: col, life: rnd(life * .6, life), sz: rnd(sz * .6, sz), rot: rnd(0, TAU), vr: rnd(-4, 4) }); } }
  function rgba(col, a) { return "rgba(" + col + "," + a + ")"; }
  function glow(c, x, y, r, col, a) { var g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(col, a)); g.addColorStop(1, rgba(col, 0)); c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
  function heartP(c, x, y, s) { c.beginPath(); c.moveTo(x, y + s * .35); c.bezierCurveTo(x - s * .9, y - s * .3, x - s * .5, y - s * .95, x, y - s * .45); c.bezierCurveTo(x + s * .5, y - s * .95, x + s * .9, y - s * .3, x, y + s * .35); c.closePath(); }
  function starP(c, x, y, R, r, n, rot) { c.beginPath(); for (var i = 0; i < n * 2; i++) { var a = rot + i * PI / n - PI / 2, q = i % 2 ? r : R; c.lineTo(x + M.cos(a) * q, y + M.sin(a) * q); } c.closePath(); }
  function lg(c, x0, y0, x1, y1, stops) { var g = c.createLinearGradient(x0, y0, x1, y1); stops.forEach(function (s, i) { g.addColorStop(i / (stops.length - 1), s); }); return g; }
  function ell(c, x, y, rx, ry, rot) { c.beginPath(); c.ellipse(x, y, M.max(.1, rx), M.max(.1, ry), rot || 0, 0, TAU); }

  function drawParts(S) {
    var c = S.c, i, p, f, a, sz;
    for (i = S.parts.length - 1; i >= 0; i--) {
      p = S.parts[i]; p.life -= S.dt; if (p.life <= 0) { S.parts.splice(i, 1); continue; }
      p.vy += p.g * S.dt; p.x += p.vx * S.dt; p.y += p.vy * S.dt; p.rot += p.vr * S.dt;
      f = p.life / p.max; a = M.min(1, f * 2.2) * p.a; sz = p.sz * (p.grow ? 1 + (1 - f) * p.grow : 1);
      c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
      switch (p.k) {
        case "s": c.globalCompositeOperation = "lighter"; glow(c, 0, 0, sz, p.col, a); break;
        case "fl": c.globalCompositeOperation = "lighter"; glow(c, 0, 0, sz, f > .5 ? "255,150,30" : "255,70,20", a * .8); glow(c, 0, 0, sz * .4, "255,235,160", a); break;
        case "sm": glow(c, 0, 0, sz, "120,120,130", a * .45); break;
        case "h": c.fillStyle = rgba(p.col, a); heartP(c, 0, 0, sz); c.fill(); break;
        case "p": c.fillStyle = rgba(p.col, a); ell(c, 0, 0, sz, sz * .55); c.fill(); break;
        case "st": c.globalCompositeOperation = "lighter"; c.fillStyle = rgba(p.col, a); starP(c, 0, 0, sz, sz * .4, 4, 0); c.fill(); break;
        case "c": c.scale(M.cos(p.rot * 3), 1); c.fillStyle = rgba("255,200,50", a); ell(c, 0, 0, sz, sz); c.fill(); c.strokeStyle = rgba("170,110,10", a); c.lineWidth = sz * .15; ell(c, 0, 0, sz * .65, sz * .65); c.stroke(); break;
        case "b": c.strokeStyle = rgba(p.col, a); c.lineWidth = 1.5; ell(c, 0, 0, sz, sz); c.stroke(); break;
        case "cf": c.fillStyle = rgba(p.col, a); c.fillRect(-sz, -sz * .5, sz * 2, sz); break;
        case "f": c.fillStyle = rgba(p.col, a); ell(c, 0, 0, sz * 1.8, sz * .35); c.fill(); break;
        case "cr": c.globalCompositeOperation = "lighter"; c.fillStyle = rgba(p.col, a); c.beginPath(); c.moveTo(0, -sz); c.lineTo(sz * .5, sz * .6); c.lineTo(-sz * .5, sz * .6); c.fill(); break;
        case "w": c.fillStyle = rgba(p.col, a); ell(c, 0, 0, sz * .6, sz); c.fill(); break;
      }
      c.restore();
    }
  }

  /* ------------------------------- creatures ------------------------------- */
  function lion(c, x, y, R, t, mouth) {
    var i, n = 46, L, s, g;
    glow(c, x, y, R * 2.1, "255,190,40", .4);
    for (L = 0; L < 2; L++) {
      c.fillStyle = L ? "#e8a020" : "#6b3300";
      for (i = 0; i < n; i++) {
        var a = i / n * TAU + (L ? .07 : 0), len = R * (L ? 1.32 : 1.58) + M.sin(t * 7 + i * 1.9) * R * .07, w = .17;
        c.beginPath(); c.moveTo(x + M.cos(a - w) * R * .6, y + M.sin(a - w) * R * .6); c.lineTo(x + M.cos(a) * len, y + M.sin(a) * len); c.lineTo(x + M.cos(a + w) * R * .6, y + M.sin(a + w) * R * .6); c.fill();
      }
    }
    for (s = -1; s <= 1; s += 2) { c.fillStyle = "#b8741f"; ell(c, x + s * R * .62, y - R * .72, R * .2, R * .2); c.fill(); }
    g = c.createRadialGradient(x, y - R * .2, R * .1, x, y, R * .9); g.addColorStop(0, "#ffd98a"); g.addColorStop(1, "#c9822c");
    c.fillStyle = g; ell(c, x, y, R * .8, R * .88); c.fill();
    for (s = -1; s <= 1; s += 2) {
      c.fillStyle = "#fff3c4"; ell(c, x + s * R * .31, y - R * .2, R * .16, R * .075, s * .35); c.fill();
      c.fillStyle = "#2a1200"; ell(c, x + s * R * .31, y - R * .2, R * .05, R * .06); c.fill();
      c.strokeStyle = "#5a2a05"; c.lineWidth = R * .06; c.beginPath(); c.moveTo(x + s * R * .12, y - R * .4); c.lineTo(x + s * R * .5, y - R * .3); c.stroke();
    }
    c.fillStyle = "#f8dca2"; ell(c, x, y + R * .3, R * .4, R * .3); c.fill();
    var m = R * .38 * mouth;
    if (m > 1) {
      c.fillStyle = lg(c, x, y + R * .35, x, y + R * .35 + m, ["#7a0f12", "#3a0508"]); ell(c, x, y + R * .46 + m * .4, R * .3, m * .62); c.fill();
      c.fillStyle = "#fff";
      for (s = -1; s <= 1; s += 2) { [0, 1].forEach(function (u) { var px = x + s * R * (.1 + u * .14); c.beginPath(); c.moveTo(px - R * .04, y + R * .4); c.lineTo(px + R * .04, y + R * .4); c.lineTo(px, y + R * .4 + R * .13); c.fill(); c.beginPath(); c.moveTo(px - R * .04, y + R * .46 + m * .9); c.lineTo(px + R * .04, y + R * .46 + m * .9); c.lineTo(px, y + R * .46 + m * .9 - R * .1); c.fill(); }); }
      c.fillStyle = "#e0606a"; ell(c, x, y + R * .5 + m * .75, R * .16, m * .22); c.fill();
    }
    c.fillStyle = "#3b1a10"; c.beginPath(); c.moveTo(x - R * .12, y + R * .08); c.lineTo(x + R * .12, y + R * .08); c.lineTo(x, y + R * .22); c.fill();
  }
  function wing(c, x, y, s, ang, len, col1, col2) { // s = -1 left / 1 right
    c.save(); c.translate(x, y); c.scale(s, 1); c.rotate(ang);
    for (var i = 0; i < 8; i++) { c.save(); c.rotate(-i * .09 + .25); c.fillStyle = lg(c, 0, 0, len, 0, [col1, col2]); ell(c, len * .5, 0, len * (.5 - i * .02), len * .085); c.fill(); c.restore(); }
    c.restore();
  }
  function eagle(c, x, y, sc, t) {
    var fl = M.sin(t * 8) * .55;
    glow(c, x, y, sc * 70, "255,210,80", .35);
    wing(c, x - sc * 6, y - sc * 4, -1, -.15 - fl, sc * 62, "#8a5a10", "#f5c542"); wing(c, x + sc * 6, y - sc * 4, 1, -.15 - fl, sc * 62, "#8a5a10", "#f5c542");
    c.fillStyle = lg(c, x, y - sc * 20, x, y + sc * 30, ["#c98a1a", "#5a3608"]); ell(c, x, y + sc * 6, sc * 11, sc * 22); c.fill();
    c.fillStyle = "#fff8e6"; ell(c, x, y - sc * 20, sc * 8.5, sc * 9.5); c.fill();
    c.fillStyle = "#ffb400"; c.beginPath(); c.moveTo(x - sc * 4, y - sc * 18); c.lineTo(x + sc * 4, y - sc * 18); c.lineTo(x, y - sc * 7); c.fill();
    c.fillStyle = "#111"; ell(c, x - sc * 4, y - sc * 22, sc * 1.4, sc * 1.4); c.fill(); ell(c, x + sc * 4, y - sc * 22, sc * 1.4, sc * 1.4); c.fill();
  }
  function whale(c, x, y, sc, ang) {
    c.save(); c.translate(x, y); c.rotate(ang);
    var g = lg(c, 0, -sc * 14, 0, sc * 16, ["#1c4d8f", "#0b2a5e"]);
    c.fillStyle = g; c.beginPath(); c.moveTo(sc * 40, 0); c.bezierCurveTo(sc * 32, -sc * 24, -sc * 20, -sc * 24, -sc * 40, -sc * 4); c.bezierCurveTo(-sc * 20, sc * 20, sc * 30, sc * 22, sc * 40, 0); c.fill();
    c.fillStyle = "#cfe9ff"; c.beginPath(); c.moveTo(sc * 38, sc * 3); c.bezierCurveTo(sc * 20, sc * 20, -sc * 15, sc * 17, -sc * 30, sc * 4); c.bezierCurveTo(-sc * 10, sc * 11, sc * 22, sc * 9, sc * 38, sc * 3); c.fill();
    c.fillStyle = g; c.beginPath(); c.moveTo(-sc * 38, -sc * 4); c.lineTo(-sc * 58, -sc * 20); c.quadraticCurveTo(-sc * 50, -sc * 4, -sc * 58, sc * 12); c.lineTo(-sc * 38, sc * 2); c.fill();
    c.fillStyle = "#fff"; ell(c, sc * 28, -sc * 2, sc * 2.2, sc * 2.2); c.fill(); c.fillStyle = "#001"; ell(c, sc * 28.6, -sc * 2, sc, sc); c.fill();
    c.strokeStyle = "#07204a"; c.lineWidth = sc * .8; c.beginPath(); c.moveTo(sc * 38, sc * 3); c.quadraticCurveTo(sc * 26, sc * 8, sc * 14, sc * 6); c.stroke();
    c.restore();
  }
  function elephant(c, x, y, sc, t, trunk, step) {
    var s, g = lg(c, 0, y - sc * 30, 0, y + sc * 20, ["#9aa3b5", "#5a6378"]);
    var lift = M.abs(M.sin(step)) * sc * 2;
    c.fillStyle = "#4f5870"; [-24, -12, 14, 26].forEach(function (lx, i) { var u = (i % 2 ? 1 : 0) * lift; c.fillRect(x + sc * lx - sc * 5, y + sc * 4 - u, sc * 10, sc * 22); });
    c.fillStyle = g; ell(c, x, y - sc * 4, sc * 34, sc * 22); c.fill();
    ell(c, x + sc * 32, y - sc * 16, sc * 15, sc * 15); c.fill();
    c.fillStyle = "#7c8599"; ell(c, x + sc * 22, y - sc * 14, sc * 12, sc * 17, .2); c.fill();
    c.strokeStyle = "#8b94a8"; c.lineCap = "round";
    var tx = x + sc * 42, ty = y - sc * 8, ex = tx + sc * (6 + trunk * 6), ey = ty + sc * (30 - trunk * 58), cx1 = tx + sc * 18, cy1 = ty + sc * (22 - trunk * 22);
    for (var w = 10; w >= 3; w -= 2) { c.lineWidth = sc * w * .75; c.beginPath(); c.moveTo(tx, ty); c.quadraticCurveTo(cx1, cy1, ex, ey); c.stroke(); }
    c.strokeStyle = "#fff6e0"; c.lineWidth = sc * 3; c.beginPath(); c.moveTo(x + sc * 38, y - sc * 6); c.quadraticCurveTo(x + sc * 52, y - sc * 2, x + sc * 54, y - sc * 12); c.stroke();
    c.fillStyle = "#111"; ell(c, x + sc * 37, y - sc * 20, sc * 1.6, sc * 1.6); c.fill();
  }
  function car(c, x, y, sc, t) {
    glow(c, x + sc * 50, y, sc * 40, "255,255,200", .3);
    c.fillStyle = lg(c, x, y - sc * 14, x, y + sc * 6, ["#ff5a5a", "#a10d1a"]);
    c.beginPath(); c.moveTo(x - sc * 48, y); c.lineTo(x - sc * 46, y - sc * 8); c.quadraticCurveTo(x - sc * 20, y - sc * 11, x - sc * 8, y - sc * 15); c.quadraticCurveTo(x + sc * 12, y - sc * 20, x + sc * 26, y - sc * 10); c.quadraticCurveTo(x + sc * 46, y - sc * 8, x + sc * 52, y - sc * 2); c.lineTo(x + sc * 52, y + sc * 2); c.lineTo(x - sc * 48, y + sc * 2); c.fill();
    c.fillStyle = "#bfe6ff"; c.beginPath(); c.moveTo(x - sc * 6, y - sc * 13); c.quadraticCurveTo(x + sc * 10, y - sc * 17, x + sc * 20, y - sc * 10); c.lineTo(x - sc * 8, y - sc * 10); c.fill();
    [-30, 30].forEach(function (wx) { c.fillStyle = "#111"; ell(c, x + sc * wx, y + sc * 2, sc * 9, sc * 9); c.fill(); c.strokeStyle = "#ccd"; c.lineWidth = sc * 1.2; for (var i = 0; i < 5; i++) { var a = t * 28 + i * TAU / 5; c.beginPath(); c.moveTo(x + sc * wx, y + sc * 2); c.lineTo(x + sc * wx + M.cos(a) * sc * 7, y + sc * 2 + M.sin(a) * sc * 7); c.stroke(); } });
    c.globalCompositeOperation = "lighter"; var g = lg(c, x + sc * 52, y, x + sc * 130, y, ["rgba(255,255,210,.7)", "rgba(255,255,210,0)"]); c.fillStyle = g; c.beginPath(); c.moveTo(x + sc * 52, y - sc * 4); c.lineTo(x + sc * 130, y - sc * 16); c.lineTo(x + sc * 130, y + sc * 12); c.lineTo(x + sc * 52, y); c.fill(); c.globalCompositeOperation = "source-over";
  }
  function dragonBody(S, hx, hy, t, sc) {
    var c = S.c, i, n = 20, pts = [];
    for (i = 0; i < n; i++) pts.push([hx - i * sc * 4.2, hy + M.sin(t * 5 - i * .55) * sc * (3 + i * .5)]);
    [-1, 1].forEach(function (s) { c.save(); c.translate(pts[4][0], pts[4][1]); c.rotate(-.5 + M.sin(t * 9) * .55 * s * 0 + M.sin(t * 9) * .5); c.fillStyle = "rgba(160,20,40,.85)"; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(-sc * 12, -sc * 34, -sc * 40, -sc * 40 + s * 0); c.quadraticCurveTo(-sc * 28, -sc * 16, -sc * 34, -sc * 6); c.quadraticCurveTo(-sc * 18, -sc * 8, 0, 0); c.fill(); c.restore(); });
    for (i = n - 1; i >= 0; i--) { var r = sc * (7.5 - i * .27); c.fillStyle = lg(c, 0, pts[i][1] - r, 0, pts[i][1] + r, ["#e0402a", "#6b0a14"]); ell(c, pts[i][0], pts[i][1], r, r); c.fill(); c.fillStyle = "rgba(255,200,80,.5)"; ell(c, pts[i][0], pts[i][1] + r * .45, r * .7, r * .35); c.fill(); }
    c.fillStyle = "#ffcf4a"; for (i = 0; i < 4; i++) { c.beginPath(); c.moveTo(hx - sc * 4 - i * sc * 3, hy - sc * 8); c.lineTo(hx - sc * 1 - i * sc * 3, hy - sc * 15); c.lineTo(hx + sc * 2 - i * sc * 3, hy - sc * 8); c.fill(); }
    c.fillStyle = lg(c, hx, hy - sc * 9, hx, hy + sc * 9, ["#f05a35", "#8a1020"]); c.beginPath(); c.moveTo(hx - sc * 6, hy - sc * 9); c.lineTo(hx + sc * 20, hy - sc * 4); c.lineTo(hx + sc * 21, hy + sc * 1); c.lineTo(hx - sc * 6, hy + sc * 8); c.fill();
    c.fillStyle = "#ffe46a"; ell(c, hx + sc * 5, hy - sc * 4, sc * 2.2, sc * 1.5, .3); c.fill(); glow(c, hx + sc * 5, hy - sc * 4, sc * 5, "255,220,80", .6);
    c.fillStyle = "#ffd24a"; c.beginPath(); c.moveTo(hx - sc * 3, hy - sc * 9); c.lineTo(hx - sc * 11, hy - sc * 22); c.lineTo(hx + sc * 3, hy - sc * 10); c.fill();
  }
  function berry(c, x, y, s, rot) {
    c.save(); c.translate(x, y); c.rotate(rot); glow(c, 0, 0, s * 2, "255,60,80", .3);
    c.fillStyle = lg(c, 0, -s, 0, s, ["#ff5870", "#b8102a"]); c.beginPath(); c.moveTo(0, s * 1.15); c.bezierCurveTo(-s * 1.3, s * .3, -s * 1.15, -s * .8, 0, -s * .75); c.bezierCurveTo(s * 1.15, -s * .8, s * 1.3, s * .3, 0, s * 1.15); c.fill();
    c.fillStyle = "#ffe08a"; for (var i = 0; i < 12; i++) { ell(c, M.cos(i * 2.4) * s * .6 * ((i % 3 + 1) / 3), M.sin(i * 2.4) * s * .7 * ((i % 3 + 1) / 3) + s * .1, s * .06, s * .1, i); c.fill(); }
    c.fillStyle = "#22b04a"; for (i = 0; i < 5; i++) { c.save(); c.rotate(-1.2 + i * .6); ell(c, 0, -s * .95, s * .13, s * .4); c.fill(); c.restore(); }
    c.restore();
  }
  function rose(c, x, y, R, open) {
    glow(c, x, y, R * 2.4, "255,80,130", .35 * open);
    var L, i, n;
    for (L = 3; L >= 0; L--) { n = 5 + L; for (i = 0; i < n; i++) { var a = i / n * TAU + L * .5, d = R * (.1 + L * .22) * open, rr = R * (.32 + L * .09) * (.4 + .6 * open); c.fillStyle = lg(c, x, y - R, x, y + R, [["#ff6f91", "#e8305d", "#c01545", "#8d0a30"][L], "#7a0828"]); ell(c, x + M.cos(a) * d, y + M.sin(a) * d * .85 - R * .08 * L * open, rr, rr * .8, a); c.fill(); } }
    c.fillStyle = "rgba(255,200,215,.6)"; ell(c, x - R * .08, y - R * .12, R * .12, R * .08); c.fill();
  }
  function bigstar(c, x, y, R, rot) { glow(c, x, y, R * 2, "255,220,90", .45); c.fillStyle = lg(c, x, y - R, x, y + R, ["#fff6b0", "#ffb300"]); starP(c, x, y, R, R * .46, 5, rot); c.fill(); c.strokeStyle = "#fff"; c.lineWidth = R * .04; c.stroke(); }
  function trophy(c, x, y, sc) {
    var g = lg(c, x - sc * 20, y, x + sc * 20, y, ["#ffe27a", "#ffbf1a", "#b87700"]); glow(c, x, y - sc * 10, sc * 50, "255,215,80", .35);
    c.strokeStyle = "#e0a000"; c.lineWidth = sc * 3.5; [-1, 1].forEach(function (s) { c.beginPath(); c.moveTo(x + s * sc * 18, y - sc * 22); c.bezierCurveTo(x + s * sc * 36, y - sc * 22, x + s * sc * 32, y - sc * 2, x + s * sc * 14, y - sc * 4); c.stroke(); });
    c.fillStyle = g; c.beginPath(); c.moveTo(x - sc * 20, y - sc * 28); c.lineTo(x + sc * 20, y - sc * 28); c.bezierCurveTo(x + sc * 20, y + sc * 2, x + sc * 6, y + sc * 4, x + sc * 4, y + sc * 12); c.lineTo(x - sc * 4, y + sc * 12); c.bezierCurveTo(x - sc * 6, y + sc * 4, x - sc * 20, y + sc * 2, x - sc * 20, y - sc * 28); c.fill();
    c.fillRect(x - sc * 5, y + sc * 12, sc * 10, sc * 8); c.fillStyle = "#8a5a00"; c.fillRect(x - sc * 16, y + sc * 20, sc * 32, sc * 8); c.fillStyle = "#fff6c0"; ell(c, x - sc * 9, y - sc * 16, sc * 2.5, sc * 10, .1); c.fill();
  }
  function medal(c, x, y, R, t, col) {
    var sx = M.cos(t * 5); glow(c, x, y, R * 2, "220,235,255", .4);
    c.fillStyle = "#3b6cff"; c.fillRect(x - R * .45, y - R * 2, R * .9, R * 1.2);
    c.save(); c.translate(x, y); c.scale(sx, 1);
    c.fillStyle = lg(c, -R, -R, R, R, col); ell(c, 0, 0, R, R); c.fill(); c.strokeStyle = "rgba(255,255,255,.8)"; c.lineWidth = R * .08; ell(c, 0, 0, R * .78, R * .78); c.stroke();
    c.fillStyle = "rgba(255,255,255,.85)"; starP(c, 0, 0, R * .5, R * .22, 5, 0); c.fill(); c.restore();
  }
  function diamond(c, x, y, R, t) {
    var sx = M.cos(t * 3.2) * .8 + .2 * M.sign(M.cos(t * 3.2) || 1), g = lg(c, x, y - R, x, y + R, ["#e8fbff", "#7fd6ff", "#2a7bff"]);
    glow(c, x, y, R * 2.2, "150,220,255", .5); c.save(); c.translate(x, y); c.scale(sx, 1);
    c.fillStyle = g; c.beginPath(); c.moveTo(-R, -R * .25); c.lineTo(-R * .55, -R * .8); c.lineTo(R * .55, -R * .8); c.lineTo(R, -R * .25); c.lineTo(0, R); c.closePath(); c.fill();
    c.strokeStyle = "rgba(255,255,255,.85)"; c.lineWidth = R * .035; c.beginPath(); c.moveTo(-R, -R * .25); c.lineTo(R, -R * .25); c.moveTo(-R * .55, -R * .8); c.lineTo(-R * .3, -R * .25); c.lineTo(0, R); c.moveTo(R * .55, -R * .8); c.lineTo(R * .3, -R * .25); c.lineTo(0, R); c.moveTo(0, -R * .8); c.lineTo(-R * .3, -R * .25); c.moveTo(0, -R * .8); c.lineTo(R * .3, -R * .25); c.stroke(); c.restore();
  }
  function rays(c, x, y, R, n, t, col, a) { c.save(); c.translate(x, y); c.rotate(t); c.globalCompositeOperation = "lighter"; for (var i = 0; i < n; i++) { c.rotate(TAU / n); var g = lg(c, 0, 0, R, 0, [rgba(col, a), rgba(col, 0)]); c.fillStyle = g; c.beginPath(); c.moveTo(0, -R * .03); c.lineTo(R, -R * .09); c.lineTo(R, R * .09); c.lineTo(0, R * .03); c.fill(); } c.restore(); }

  /* ------------------------------- effects -------------------------------- */
  var FX = {
    Like: function (S) { var W = S.W, H = S.H; rate(S, "h", 26, function () { add(S, { k: "h", x: W * rnd(.3, .7), y: H * .85, vx: rnd(-25, 25), vy: -rnd(90, 190), g: -4, col: M.random() < .5 ? "255,90,140" : "255,60,100", life: rnd(1.4, 2.4), sz: rnd(10, 22), rot: rnd(-.5, .5) }); add(S, { k: "s", x: W * rnd(.3, .7), y: H * .85, vy: -rnd(60, 150), col: "255,190,220", life: 1.2, sz: 8 }); }); once(S, "p", 0, function () { snd(S, function (T) { SFX.pop(T); SFX.sparkle(T + .1); }); }); },
    Rose: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, o = outCubic((t - .5) / 1.5), x = W / 2 + M.sin(t * 1.3) * u * 3, y = H * .6 - M.max(0, t - 2.2) * u * 4, R = u * 15;
      var g = cl(t / .8); S.c.strokeStyle = "#1f8a3b"; S.c.lineWidth = u * 2; S.c.beginPath(); S.c.moveTo(x, H * .95); S.c.quadraticCurveTo(x - u * 6, (H * .95 + y) / 2, x, H * .95 + (y + R * .6 - H * .95) * g); S.c.stroke();
      if (t > .3) rose(S.c, x, y, R * cl(t / .5), o);
      once(S, "c", .5, function () { snd(S, SFX.chime); });
      if (t > 1.6 && t < 3.6) rate(S, "p", 50, function () { var k = M.random(); add(S, { k: k < .35 ? "p" : k < .6 ? "h" : k < .8 ? "st" : "s", x: x + rnd(-R * .4, R * .4), y: y, vx: rnd(-90, 90), vy: -rnd(40, 160), g: 55, col: k < .35 ? "255,110,150" : k < .6 ? "255,90,140" : "255,230,240", life: rnd(1.3, 2.5), sz: rnd(6, 14), rot: rnd(0, 6), vr: rnd(-3, 3) }); });
    },
    Fire: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, k = cl(t / 1.5), x = -u * 10 + (W * .52 + u * 10) * outCubic(k), y = H * .75 - H * .27 * k;
      once(S, "w", .05, function () { snd(S, function (T) { SFX.whoosh(T, 1.2); SFX.flame(T, 1.6); }); });
      if (t < 1.5) { glow(S.c, x, y, u * 18, "255,120,20", .9); glow(S.c, x, y, u * 9, "255,240,170", 1); rate(S, "f", 120, function () { add(S, { k: "fl", x: x + rnd(-6, 6), y: y + rnd(-6, 6), vx: rnd(-120, -20), vy: rnd(-40, 40), g: -30, life: rnd(.4, .9), sz: rnd(u * 5, u * 11), grow: 1.2 }); add(S, { k: "s", x: x, y: y, vx: rnd(-200, -50), vy: rnd(-80, 80), g: 80, col: "255,170,60", life: rnd(.5, 1.3), sz: rnd(3, 7) }); }); }
      once(S, "x", 1.5, function () { S.flash = .9; S.fcol = "255,150,40"; S.shake = 1.2; burst(S, x, y, 90, "fl", "255,140,30", 420, 1.4, u * 10); burst(S, x, y, 80, "s", "255,200,90", 520, 1.8, 6, 120); snd(S, function (T) { SFX.boom(T); SFX.thunder(T + .05); }); });
    },
    Strawberry: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, x = W / 2, y;
      if (t < 2) { var b = t < 1 ? H * .2 + (H * .35) * (t * t) : H * .55 - M.abs(M.sin((t - 1) * PI * 1.1)) * H * .14 * (2 - t); y = b; berry(S.c, x, y, u * 13, t * 7); }
      once(S, "b", 2, function () { S.flash = .5; S.fcol = "255,120,150"; burst(S, x, H * .55, 40, "h", "255,70,110", 330, 1.8, 16, 50); burst(S, x, H * .55, 60, "s", "255,200,220", 300, 1.5, 9, 30); snd(S, function (T) { SFX.pop(T); SFX.sparkle(T); }); });
      once(S, "i", .05, function () { snd(S, function (T) { SFX.whoosh(T, .5); }); });
    },
    Star: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, R = u * 20 * outBack(t / .8) * (1 + .05 * M.sin(t * 9));
      rays(S.c, W / 2, H * .5, u * 70, 14, t * 1.4, "255,230,120", .55 * cl(t / .5)); bigstar(S.c, W / 2, H * .5, R, t * 3);
      once(S, "s", .1, function () { snd(S, function (T) { SFX.sparkle(T); SFX.chime(T + .3); }); }); once(S, "f", .6, function () { S.flash = .6; S.fcol = "255,240,170"; });
      if (t > .5 && t < 3) rate(S, "t", 45, function () { var a = rnd(0, TAU); add(S, { k: "st", x: W / 2, y: H * .5, vx: M.cos(a) * rnd(100, 330), vy: M.sin(a) * rnd(100, 330), col: "255,235,140", life: rnd(.8, 1.7), sz: rnd(6, 15), rot: rnd(0, 6), vr: 3 }); });
    },
    Trophy: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, y = H * .95 - (H * .42) * outCubic(t / 1.2), c = S.c;
      c.globalCompositeOperation = "lighter"; [[.1, 1], [.9, -1]].forEach(function (s) { var gr = lg(c, W * s[0], 0, W / 2, H * .6, ["rgba(255,240,180,.55)", "rgba(255,240,180,0)"]); c.fillStyle = gr; c.beginPath(); c.moveTo(W * s[0] - 6, 0); c.lineTo(W * s[0] + 6, 0); c.lineTo(W / 2 + s[1] * -u * 18 + u * 18, H * .62); c.lineTo(W / 2 - u * 18, H * .62); c.fill(); }); c.globalCompositeOperation = "source-over";
      trophy(c, W / 2, y, u * 1.1);
      once(S, "f", 1.1, function () { S.flash = .5; S.fcol = "255,225,120"; snd(S, SFX.fanfare); });
      if (t > 1.1 && t < 3.6) rate(S, "c", 80, function () { var cols = ["255,200,50", "255,90,120", "90,180,255", "120,255,170", "255,255,255"]; add(S, { k: "cf", x: rnd(0, W), y: -10, vx: rnd(-30, 30), vy: rnd(80, 200), g: 40, col: cols[M.floor(rnd(0, 5))], life: rnd(2, 3.2), sz: rnd(3, 7), rot: rnd(0, 6), vr: rnd(-8, 8) }); });
    },
    Car: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, k = cl(t / 2.6), x = -u * 60 + (W + u * 140) * k * k * (3 - 2 * k) * .5 + (W + u * 140) * k * .5, y = H * .62, c = S.c;
      once(S, "e", .05, function () { snd(S, SFX.engine); });
      rate(S, "l", 50, function () { var ly = y + rnd(-u * 22, u * 12); add(S, { k: "s", x: x - rnd(0, u * 20), y: ly, vx: -rnd(400, 900), col: "200,225,255", life: .35, sz: rnd(10, 30) }); });
      rate(S, "sm", 60, function () { add(S, { k: "sm", x: x - u * 30, y: y + u * 10, vx: -rnd(20, 90), vy: -rnd(10, 60), life: rnd(.8, 1.6), sz: rnd(u * 5, u * 9), grow: 1.5 }); });
      if (t < 3) car(c, x, y, u * .85, t);
      once(S, "f", 1.1, function () { S.shake = .5; });
    },
    Silver: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, y = H * .62 - (H * .12) * outCubic(t / 1); medal(S.c, W / 2, y, u * 16 * outBack(t / .7), t, ["#ffffff", "#c8d0da", "#7d8794"]);
      once(S, "c", .6, function () { S.flash = .5; S.fcol = "230,240,255"; snd(S, function (T) { SFX.chime(T); SFX.sparkle(T + .2); }); });
      if (t > .5 && t < 3) rate(S, "g", 70, function () { var a = rnd(0, TAU), r = rnd(0, u * 18); add(S, { k: M.random() < .5 ? "s" : "st", x: W / 2 + M.cos(a) * r, y: y + M.sin(a) * r, vx: M.cos(a) * 90, vy: M.sin(a) * 90 - 20, g: 60, col: M.random() < .5 ? "235,245,255" : "170,210,255", life: rnd(.8, 1.8), sz: rnd(4, 11), rot: rnd(0, 6) }); });
    },
    Diamond: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, R = u * 17 * outBack(t / .8);
      rays(S.c, W / 2, H * .5, u * 80, 18, t * 1.1, "170,225,255", .6 * cl(t / .6)); diamond(S.c, W / 2, H * .5, R, t);
      once(S, "x", 1.4, function () { S.flash = .95; S.fcol = "210,240,255"; S.shake = .9; burst(S, W / 2, H * .5, 90, "cr", "160,225,255", 520, 2.2, 14, 120); burst(S, W / 2, H * .5, 60, "st", "255,255,255", 380, 1.8, 12); snd(S, function (T) { SFX.boom(T); SFX.sparkle(T); SFX.chime(T + .1); }); });
      once(S, "i", .1, function () { snd(S, SFX.whoosh); });
    },
    Gold: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t; glow(S.c, W / 2, H * .5, u * 70 * (1 + .06 * M.sin(t * 5)), "255,200,60", .4 * cl(t / .6));
      once(S, "c", .05, function () { S.flash = .5; S.fcol = "255,210,80"; snd(S, function (T) { SFX.chime(T); SFX.coin(T + .2); SFX.coin(T + 1.2); }); });
      if (t < 3.2) rate(S, "c", 38, function () { add(S, { k: "c", x: rnd(0, W), y: -20, vx: rnd(-25, 25), vy: rnd(150, 300), g: 220, life: rnd(2, 3), sz: rnd(u * 2.4, u * 4.2), rot: rnd(0, 6), vr: rnd(2, 6) }); if (M.random() < .5) add(S, { k: "s", x: rnd(0, W), y: rnd(0, H), col: "255,225,120", life: rnd(.6, 1.2), sz: rnd(6, 14) }); });
    },
    Eagle: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, k = cl(t / 3.2), sc = u * (.3 + 1.1 * outCubic(k)), x = W / 2 + M.sin(t * 1.6) * u * 12, y = H * (.9 - .45 * outCubic(k)) - M.sin(k * PI) * H * .05;
      once(S, "w", .1, function () { snd(S, function (T) { SFX.whoosh(T, 1.4); SFX.whoosh(T + 1.2, 1); tone("sawtooth", 1500, 900, T + .8, .8, .12, { lp: 3000, vib: 18 }); }); }); once(S, "f", 1.2, function () { S.flash = .35; S.fcol = "255,215,100"; });
      if (t < 4) eagle(S.c, x, y, sc, t);
      rate(S, "f", 55, function () { add(S, { k: M.random() < .6 ? "f" : "st", x: x + rnd(-sc * 50, sc * 50), y: y + rnd(-sc * 10, sc * 20), vx: rnd(-40, 40), vy: rnd(30, 120), g: 20, col: "255,210,80", life: rnd(1.2, 2.4), sz: rnd(5, 12), rot: rnd(0, 6), vr: rnd(-3, 3) }); });
    },
    Lion: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, k = outBack(t / .75), R = u * 21 * (t < .75 ? .25 + .75 * k : 1 + .02 * M.sin(t * 20)), x = W / 2, y = H * .78 - H * .26 * outCubic(t / .75);
      var m = t < .75 ? 0 : t < 3.4 ? .78 + .22 * M.sin(t * 15) : M.max(0, 1 - (t - 3.4) * 2);
      once(S, "a", .05, function () { snd(S, function (T) { SFX.whoosh(T, .7); }); });
      once(S, "b", .75, function () { S.flash = 1; S.fcol = "255,200,60"; S.shake = 1.5; snd(S, function (T) { SFX.boom(T); SFX.roar(T, 2.4); }); });
      if (t < 4.6) lion(S.c, x, y, R, t, m);
      if (t > .75 && t < 3.6) rate(S, "s", 90, function () { var a = rnd(0, TAU); add(S, { k: "s", x: x + M.cos(a) * R * 1.3, y: y + M.sin(a) * R * 1.3, vx: M.cos(a) * rnd(60, 220), vy: M.sin(a) * rnd(60, 220) - 60, g: 80, col: "255,200,70", life: rnd(.6, 1.4), sz: rnd(4, 10) }); if (M.random() < .5) add(S, { k: "fl", x: x + rnd(-R, R), y: y - R * 1.2, vy: -rnd(60, 160), life: rnd(.4, .8), sz: rnd(u * 4, u * 8), grow: 1 }); });
      if (t > .75 && t < 3.4) S.shake = M.max(S.shake, .35);
    },
    Dragon: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, k = cl(t / 4.2), hx = -u * 10 + (W + u * 70) * k, hy = H * .38 + M.sin(t * 2.1) * H * .06, sc = u * .95, c = S.c;
      once(S, "a", .1, function () { snd(S, function (T) { SFX.whoosh(T, 1.5); tone("sawtooth", 140, 60, T + .3, 1.2, .35, { lp: 700, vib: 20 }); }); });
      once(S, "t", 1.4, function () { snd(S, function (T) { SFX.flame(T, 2.4); SFX.thunder(T); }); });
      if (t < 4.8) dragonBody(S, hx, hy, t, sc);
      if (t > 1.4 && t < 3.8) { rate(S, "f", 160, function () { add(S, { k: "fl", x: hx + sc * 20, y: hy, vx: rnd(300, 560), vy: rnd(-30, 80), g: 30, life: rnd(.5, 1.1), sz: rnd(u * 5, u * 10), grow: 1.3 }); }); rate(S, "e", 30, function () { add(S, { k: "s", x: hx + sc * 30, y: hy, vx: rnd(200, 500), vy: rnd(-60, 160), g: 120, col: "255,190,80", life: rnd(.6, 1.4), sz: rnd(3, 7) }); }); S.shake = M.max(S.shake, .3); if (M.random() < .04) { S.flash = .7; S.fcol = "255,255,255"; } }
    },
    Elephant: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, x = -u * 40 + (W / 2 + u * 40) * outCubic(t / 2.2), y = H * .62, tr = cl((t - 2.3) / .5) * (t < 4.2 ? 1 : cl(1 - (t - 4.2) / .6)), st = t < 2.2 ? t * 7 : 99;
      if (t < 2.2) { var ph = M.floor(t * 7 / PI); if (ph !== S.lastStep) { S.lastStep = ph; if (ph > 0) { S.shake = M.max(S.shake, .5); burst(S, x - u * 20, y + u * 26, 6, "sm", "150,140,120", 90, 1.4, u * 6); snd(S, function (T) { tone("sine", 70, 38, T, .25, .6); nz(T, .3, .3, "lowpass", 400, 80); }); } } }
      elephant(S.c, x, y, u * .95, t, tr, st);
      once(S, "tr", 2.4, function () { S.flash = .35; S.fcol = "255,255,255"; S.shake = 1.2; snd(S, SFX.trumpet); });
      if (t > 2.4 && t < 4) rate(S, "w", 7, function () { add(S, { k: "b", x: x + u * 52, y: y - u * 52, vx: rnd(10, 60), vy: -rnd(30, 80), col: "255,255,255", life: 1.2, sz: rnd(u * 4, u * 9), grow: 1.6 }); });
    },
    Whale: function (S) {
      var W = S.W, H = S.H, u = S.u, t = S.t, k = cl((t - .6) / 3.6), x = -u * 40 + (W + u * 80) * k, y = H * .9 - M.sin(k * PI) * H * .62, ang = M.cos(k * PI) * -.9 * -1 * .8, c = S.c, i;
      once(S, "w", .3, function () { snd(S, function (T) { SFX.water(T); }); });
      once(S, "s", 1.4, function () { snd(S, function (T) { SFX.whale(T); }); });
      once(S, "e", 3.5, function () { S.shake = .8; snd(S, function (T) { SFX.water(T); SFX.boom(T); }); burst(S, x, H * .9, 70, "w", "190,225,255", 360, 1.8, 10, 400); });
      once(S, "b", .9, function () { S.shake = .8; burst(S, x, H * .88, 70, "w", "190,225,255", 360, 1.8, 10, 400); });
      glow(c, W / 2, H * .55, u * 60, "60,160,255", .22 * M.sin(k * PI));
      if (k > 0 && k < 1) whale(c, x, y, u * .78, ang);
      if (k > 0 && k < 1) rate(S, "b", 30, function () { add(S, { k: "b", x: x - u * 30 + rnd(-8, 8), y: y + u * 8, vy: -rnd(20, 60), col: "200,235,255", life: rnd(.8, 1.6), sz: rnd(3, 9) }); });
      c.fillStyle = "rgba(30,110,220,.55)"; c.beginPath(); c.moveTo(0, H); for (i = 0; i <= 20; i++) c.lineTo(W * i / 20, H * (.93 - .05 * M.sin(t * 3 + i * .6) * M.min(1, t / .8)) - M.sin(k * PI) * 6); c.lineTo(W, H); c.fill();
    }
  };

  /* -------------------------------- player -------------------------------- */
  function css() {
    if (document.getElementById("vgx-css")) return;
    var s = document.createElement("style"); s.id = "vgx-css";
    s.textContent = ".vgx-cv{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9}.vgx-cv.fx{position:fixed;z-index:99999}" +
      ".vgx-ban{position:absolute;left:50%;top:15%;z-index:10;pointer-events:none;text-align:center;transform:translate(-50%,0);font:900 clamp(22px,7vw,46px)/1.05 system-ui,Arial,sans-serif;letter-spacing:.04em;color:#fff;text-shadow:0 0 14px #5aa8ff,0 0 32px #2f6bff,0 3px 0 #0a2a80;animation:vgxb 2.9s ease both;white-space:nowrap}" +
      ".vgx-ban small{display:block;margin-top:6px;font:700 clamp(12px,3.2vw,17px)/1.2 system-ui,Arial,sans-serif;letter-spacing:.02em;text-shadow:0 2px 6px #000}" +
      "@keyframes vgxb{0%{opacity:0;transform:translate(-50%,-20px) scale(.4)}12%{opacity:1;transform:translate(-50%,0) scale(1.18)}22%{transform:translate(-50%,0) scale(1)}85%{opacity:1}100%{opacity:0;transform:translate(-50%,-10px) scale(1.05)}}" +
      "@media(prefers-reduced-motion:reduce){.vgx-ban{animation-duration:.01s}}";
    document.head.appendChild(s);
  }
  var active = new Map(), waiting = [];
  function play(name, o) {
    o = o || {}; css(); var host = o.container || document.body, fixed = host === document.body;
    if ((active.get(host) || 0) >= 2) { if (waiting.length < 6) waiting.push([name, o]); return; }
    active.set(host, (active.get(host) || 0) + 1);
    var cv = document.createElement("canvas"); cv.className = "vgx-cv" + (fixed ? " fx" : ""); host.appendChild(cv);
    if (!fixed && getComputedStyle(host).position === "static") host.style.position = "relative";
    var dpr = M.min(2, window.devicePixelRatio || 1), W = fixed ? innerWidth : host.clientWidth, H = fixed ? innerHeight : host.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; var ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    var S = mk(name, ctx, W, H, o.silent), cfg = G[name] || G.Like, last = performance.now(), ban = null, shaker = fixed ? document.body : host;
    if (cfg.t) { ban = document.createElement("div"); ban.className = "vgx-ban"; ban.innerHTML = cfg.t + "!<small>" + (o.from ? esc(o.from) + " sent " + name + (o.combo > 1 ? " x" + o.combo : "") : "") + "</small>"; host.appendChild(ban); }
    (function frame(now) {
      S.dt = M.min(.05, (now - last) / 1000); last = now; S.t += S.dt;
      ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = "source-over";
      (FX[name] || FX.Like)(S); drawParts(S); ctx.globalCompositeOperation = "source-over";
      if (S.flash > 0) { ctx.fillStyle = rgba(S.fcol, M.min(.8, S.flash)); ctx.fillRect(0, 0, W, H); S.flash -= S.dt * 2.2; }
      if (S.shake > 0 && !reduce) { var a = S.shake * 7; shaker.style.transform = "translate(" + rnd(-a, a).toFixed(1) + "px," + rnd(-a, a).toFixed(1) + "px)"; S.shake -= S.dt * 1.6; } else if (shaker.style.transform) shaker.style.transform = "";
      if (S.t < cfg.d + .4) requestAnimationFrame(frame);
      else { cv.remove(); if (ban) ban.remove(); shaker.style.transform = ""; active.set(host, active.get(host) - 1); var n = waiting.shift(); if (n) play(n[0], n[1]); }
    })(last);
  }
  function esc(t) { var d = document.createElement("div"); d.textContent = t == null ? "" : t; return d.innerHTML; }

  /* looping silent previews (gift shop) - one shared timer, only visible canvases animate */
  var minis = [], mt = 0, io = window.IntersectionObserver ? new IntersectionObserver(function (es) { es.forEach(function (e) { e.target._vis = e.isIntersecting; }); }) : null;
  function mini(cv, name) {
    var dpr = M.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 160, H = cv.clientHeight || 130; cv.width = W * dpr; cv.height = H * dpr;
    var ctx = cv.getContext("2d"); ctx.scale(dpr, dpr); cv._vis = true; if (io) io.observe(cv);
    minis.push({ cv: cv, ctx: ctx, W: W, H: H, name: name, S: mk(name, ctx, W, H, true), age: -M.random() * 1.2 });
    if (!mt) mt = setInterval(tickMini, 33);
  }
  function tickMini() {
    minis.forEach(function (m) {
      if (!m.cv.isConnected || !m.cv._vis) return; var S = m.S, d = (G[m.name] || G.Like).d; S.dt = .033; S.t += S.dt; m.age += S.dt;
      m.ctx.clearRect(0, 0, m.W, m.H); m.ctx.globalCompositeOperation = "source-over"; if (m.age < 0) return;
      (FX[m.name] || FX.Like)(S); drawParts(S); m.ctx.globalCompositeOperation = "source-over"; S.shake = 0;
      if (S.flash > 0) { m.ctx.fillStyle = rgba(S.fcol, M.min(.35, S.flash)); m.ctx.fillRect(0, 0, m.W, m.H); S.flash -= S.dt * 2.2; }
      if (S.t > d + .3) { m.S = mk(m.name, m.ctx, m.W, m.H, true); m.age = -.4; }
    });
  }
  window.VicoGifts = { play: play, mini: mini, names: Object.keys(G), _FX: FX, _mk: mk, _drawParts: drawParts };
})();
