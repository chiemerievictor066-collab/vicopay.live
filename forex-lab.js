/* =====================================================================
   ForexLab — the Practice Trading engine used by forex.html
   * A SIMULATED market: prices wander randomly (with trends) from realistic starting levels.
     They are for learning only and are NOT real quotes.
   * Virtual account, leverage 1:30, market orders, stop-loss / take-profit, margin and stop-out.
   * No DOM in here, so it can be tested on its own.
   ===================================================================== */
(function (root) {
  "use strict";

  var LOT = 100000;
  var PAIRS = {
    EURUSD: { base: "EUR", quote: "USD", start: 1.0850, dec: 5, spread: 1.2, vol: 0.000030 },
    GBPUSD: { base: "GBP", quote: "USD", start: 1.2700, dec: 5, spread: 1.5, vol: 0.000036 },
    AUDUSD: { base: "AUD", quote: "USD", start: 0.6600, dec: 5, spread: 1.4, vol: 0.000034 },
    NZDUSD: { base: "NZD", quote: "USD", start: 0.6100, dec: 5, spread: 1.7, vol: 0.000036 },
    USDJPY: { base: "USD", quote: "JPY", start: 150.00, dec: 3, spread: 1.4, vol: 0.000032 },
    USDCAD: { base: "USD", quote: "CAD", start: 1.3600, dec: 5, spread: 1.6, vol: 0.000030 },
    USDCHF: { base: "USD", quote: "CHF", start: 0.8800, dec: 5, spread: 1.6, vol: 0.000030 }
  };
  Object.keys(PAIRS).forEach(function (k) { PAIRS[k].pip = Math.pow(10, -(PAIRS[k].dec - 1)); PAIRS[k].name = PAIRS[k].base + "/" + PAIRS[k].quote; });

  var DEFAULTS = { speed: 3, startBalance: 10000, leverage: 30, ticksPerCandle: 5, maxCandles: 90, maxOpen: 15, minLots: 0.01, maxLots: 5 };

  function round(n, d) { var m = Math.pow(10, d); return Math.round(n * m) / m; }
  function randn(rng) { var u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /* ---------------------------- market ---------------------------- */
  function createMarket(opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random, saved = opts.prices || {};
    var m = { rng: rng, sym: {}, t: 0 };
    Object.keys(PAIRS).forEach(function (s) {
      var p = PAIRS[s], mid = Number(saved[s]) > 0 ? Number(saved[s]) : p.start;
      m.sym[s] = { mid: mid, drift: 0, candles: [], cur: null, ticks: 0 };
    });
    // build some history so the chart is not empty
    for (var i = 0; i < DEFAULTS.maxCandles * DEFAULTS.ticksPerCandle; i++) step(m);
    return m;
  }
  function step(m) {
    m.t++;
    Object.keys(PAIRS).forEach(function (s) {
      var p = PAIRS[s], st = m.sym[s];
      // drift slowly changes (trends come and go), pulls gently back to zero
      var vol = p.vol * DEFAULTS.speed;
      st.drift = st.drift * 0.985 + randn(m.rng) * vol * 0.06;
      var shock = randn(m.rng) * vol;
      st.mid = st.mid * (1 + st.drift + shock);
      if (st.mid <= 0) st.mid = p.start;
      var px = st.mid;
      if (!st.cur) st.cur = { o: px, h: px, l: px, c: px, n: 0 };
      st.cur.c = px; if (px > st.cur.h) st.cur.h = px; if (px < st.cur.l) st.cur.l = px; st.cur.n++;
      if (st.cur.n >= DEFAULTS.ticksPerCandle) {
        st.candles.push({ o: st.cur.o, h: st.cur.h, l: st.cur.l, c: st.cur.c });
        if (st.candles.length > DEFAULTS.maxCandles) st.candles.shift();
        st.cur = null;
      }
    });
  }
  function quote(m, s) {
    var p = PAIRS[s], half = (p.spread * p.pip) / 2, mid = m.sym[s].mid;
    return { bid: mid - half, ask: mid + half, mid: mid };
  }
  function candlesOf(m, s) {
    var st = m.sym[s], arr = st.candles.slice();
    if (st.cur) arr.push({ o: st.cur.o, h: st.cur.h, l: st.cur.l, c: st.cur.c });
    return arr;
  }
  function prices(m) { var o = {}; Object.keys(PAIRS).forEach(function (s) { o[s] = m.sym[s].mid; }); return o; }


  /* ---------------------- money helpers & coach ---------------------- */
  function pipValueUsd(s, lots, price) { var p = PAIRS[s], per = units(lots) * p.pip; return p.base === "USD" ? per / price : per; }
  function ema(vals, n) { var k = 2 / (n + 1), e = vals[0]; for (var i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
  function rsi(closes, n) {
    n = n || 14; if (closes.length <= n) return 50;
    var g = 0, l = 0; for (var i = closes.length - n; i < closes.length; i++) { var d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    if (l === 0) return 100; var rs = g / l; return 100 - 100 / (1 + rs);
  }
  function suggestLots(a, s, slPips, price, riskPct) {
    riskPct = riskPct || 1;
    var per = pipValueUsd(s, 1, price) * slPips; if (!(per > 0)) return DEFAULTS.minLots;
    var lots = Math.floor(((a.balance * riskPct) / 100 / per) * 100) / 100;
    return Math.min(DEFAULTS.maxLots, Math.max(DEFAULTS.minLots, lots));
  }
  function riskOf(a, s, lots, slPips, price) {
    if (!(slPips > 0)) return { usd: 0, pct: 0 };
    var usd = slPips * pipValueUsd(s, lots, price); return { usd: usd, pct: a.balance > 0 ? (usd / a.balance) * 100 : 0 };
  }
  // Reads the practice chart like a beginner's checklist: trend, momentum, levels, and a practice idea.
  function analyze(m, s, a) {
    var cs = candlesOf(m, s); if (cs.length < 30) return null;
    var p = PAIRS[s], q = quote(m, s), price = q.mid, closes = cs.map(function (c) { return c.c; });
    var e9 = ema(closes.slice(-40), 9), e21 = ema(closes.slice(-60), 21);
    var last = cs.slice(-14), atr = last.reduce(function (t, c) { return t + (c.h - c.l); }, 0) / last.length, atrPips = atr / p.pip;
    var diffPips = (e9 - e21) / p.pip, thr = Math.max(0.3, atrPips * 0.25);
    var trend = diffPips > thr ? "up" : diffPips < -thr ? "down" : "range";
    var rec = cs.slice(-30), sup = Math.min.apply(null, rec.map(function (c) { return c.l; })), res = Math.max.apply(null, rec.map(function (c) { return c.h; }));
    var pos = res > sup ? (price - sup) / (res - sup) : 0.5, r = rsi(closes);
    var out = { sym: s, price: price, trend: trend, e9: e9, e21: e21, rsi: r, support: sup, resistance: res, posInRange: pos, atrPips: atrPips, idea: null, verdict: "", why: [] };
    var dir = 0, why = "";
    if (trend === "up") {
      if (pos <= 0.65 && r < 72) { dir = 1; why = "Uptrend (fast average above slow) and price is not stretched at the top of its range, with support close by to hide a stop-loss behind: a trend-following BUY area."; }
      else out.verdict = "Uptrend, but price is already high in its range. A patient trader waits for a pullback toward support before buying.";
    } else if (trend === "down") {
      if (pos >= 0.35 && r > 28) { dir = -1; why = "Downtrend (fast average below slow) and price is not stretched at the bottom of its range, with resistance close by to hide a stop-loss behind: a trend-following SELL area."; }
      else out.verdict = "Downtrend, but price is already low in its range. A patient trader waits for a bounce toward resistance before selling.";
    } else {
      if (pos <= 0.3) { dir = 1; why = "Sideways market and price is at the bottom of its range (support). A small BUY back toward the middle is possible."; }
      else if (pos >= 0.7) { dir = -1; why = "Sideways market and price is at the top of its range (resistance). A small SELL back toward the middle is possible."; }
      else out.verdict = "No clear trend and price is in the middle of its range. This is a 'no trade' moment. Waiting is a skill.";
    }
    if (dir) {
      var sl = dir === 1 ? (price - sup) / p.pip + 2 : (res - price) / p.pip + 2;
      sl = Math.max(8, Math.round(sl));
      if (sl > 60) { out.verdict = "The nearest logical stop-loss is too far away (" + sl + " pips) for a good risk-to-reward. Skip this one."; }
      else {
        var tp = sl * 2, lots = a ? suggestLots(a, s, sl, price, 1) : 0.01;
        out.idea = { dir: dir, slPips: sl, tpPips: tp, lots: lots, risk: a ? riskOf(a, s, lots, sl, price) : null, why: why };
        out.verdict = (dir === 1 ? "BUY idea. " : "SELL idea. ") + why;
      }
    }
    return out;
  }
  // Plain-English feedback on a CLOSED practice trade.
  function reviewTrade(h) {
    var n = [];
    if (!h.hadSL) n.push({ ok: false, text: "No stop-loss: your risk was unlimited. Always decide your exit first." });
    else if (h.riskPct != null) {
      if (h.riskPct > 2) n.push({ ok: false, text: "You risked " + h.riskPct.toFixed(1) + "% of your account. Most traders keep it at 1% to 2% or less." });
      else n.push({ ok: true, text: "Risk was " + h.riskPct.toFixed(1) + "% of your account, within the 1% to 2% guideline." });
    }
    if (h.rrPlanned != null) n.push(h.rrPlanned >= 1.5 ? { ok: true, text: "Planned reward-to-risk 1:" + h.rrPlanned.toFixed(1) + ", a healthy ratio." } : { ok: false, text: "Planned reward-to-risk only 1:" + h.rrPlanned.toFixed(1) + ". Aim for at least 1:1.5." });
    else if (h.hadSL && !h.hadTP) n.push({ ok: null, text: "No take-profit set. Know your target before you enter." });
    if (h.trend === "up" || h.trend === "down") {
      var aligned = (h.trend === "up" && h.dir === 1) || (h.trend === "down" && h.dir === -1);
      n.push(aligned ? { ok: true, text: "You traded WITH the trend, which is usually the easier side." } : { ok: false, text: "You traded AGAINST the trend. That is lower-probability, so it needs a very good reason." });
    } else if (h.trend === "range") n.push({ ok: null, text: "The market was ranging. Range trades need tight stops and small size." });
    if (h.reason === "stop-out") n.push({ ok: false, text: "Stop-out: your position was too big for your account. Use smaller lots." });
    if (h.reason === "stop-loss") n.push({ ok: null, text: "Stop-loss worked as designed: a planned small loss protects the account." });
    if (h.reason === "take-profit") n.push({ ok: true, text: "Take-profit hit: you stuck to your plan until the target." });
    return n;
  }

  /* ---------------------------- account ---------------------------- */
  function createAccount(saved) {
    var a = { balance: DEFAULTS.startBalance, start: DEFAULTS.startBalance, leverage: DEFAULTS.leverage, positions: [], history: [], nextId: 1, peak: DEFAULTS.startBalance };
    if (saved && typeof saved === "object") {
      if (isFinite(saved.balance)) a.balance = Number(saved.balance);
      if (isFinite(saved.start)) a.start = Number(saved.start);
      if (isFinite(saved.nextId)) a.nextId = Number(saved.nextId);
      if (isFinite(saved.peak)) a.peak = Number(saved.peak);
      if (Array.isArray(saved.positions)) a.positions = saved.positions.filter(validPos).slice(0, DEFAULTS.maxOpen);
      if (Array.isArray(saved.history)) a.history = saved.history.slice(0, 100);
    }
    return a;
  }
  function validPos(p) { return p && PAIRS[p.sym] && (p.dir === 1 || p.dir === -1) && isFinite(p.lots) && isFinite(p.entry) && isFinite(p.id); }

  function units(lots) { return lots * LOT; }
  function notionalUsd(s, lots, price) { var p = PAIRS[s]; return p.base === "USD" ? units(lots) : units(lots) * price; }
  function marginFor(s, lots, price, leverage) { return notionalUsd(s, lots, price) / leverage; }
  function pnlUsd(pos, closePrice) {
    var p = PAIRS[pos.sym], diff = pos.dir * (closePrice - pos.entry), u = units(pos.lots);
    return p.quote === "USD" ? diff * u : (diff * u) / closePrice;     // USD-base pairs: profit is in the quote currency, convert back
  }
  function closePriceOf(m, pos) { var q = quote(m, pos.sym); return pos.dir === 1 ? q.bid : q.ask; }

  function summary(a, m) {
    var floating = 0, used = 0;
    a.positions.forEach(function (pos) { floating += pnlUsd(pos, closePriceOf(m, pos)); used += pos.margin; });
    var equity = a.balance + floating;
    return { balance: a.balance, floating: floating, equity: equity, used: used, free: equity - used, level: used > 0 ? (equity / used) * 100 : null };
  }

  function open(a, m, s, dir, lots, slPips, tpPips) {
    if (!PAIRS[s]) return { ok: false, error: "Unknown pair." };
    lots = round(Number(lots), 2);
    if (!(lots >= DEFAULTS.minLots) || lots > DEFAULTS.maxLots) return { ok: false, error: "Lot size must be between " + DEFAULTS.minLots + " and " + DEFAULTS.maxLots + "." };
    if (a.positions.length >= DEFAULTS.maxOpen) return { ok: false, error: "You can hold up to " + DEFAULTS.maxOpen + " open trades." };
    var q = quote(m, s), p = PAIRS[s], entry = dir === 1 ? q.ask : q.bid;
    var margin = marginFor(s, lots, entry, a.leverage), sm = summary(a, m);
    if (margin > sm.free) return { ok: false, error: "Not enough free margin. This trade needs $" + margin.toFixed(2) + " but you have $" + Math.max(0, sm.free).toFixed(2) + " free. Try a smaller lot size." };
    slPips = Number(slPips) || 0; tpPips = Number(tpPips) || 0;
    var an = analyze(m, s, a);
    var pos = {
      id: a.nextId++, sym: s, dir: dir, lots: lots, entry: entry, margin: margin, t: Date.now(),
      sl: slPips > 0 ? entry - dir * slPips * p.pip : 0,
      tp: tpPips > 0 ? entry + dir * tpPips * p.pip : 0,
      riskUsd: slPips > 0 ? slPips * pipValueUsd(s, lots, entry) : 0, balAtOpen: a.balance, trend: an ? an.trend : "range"
    };
    a.positions.push(pos);
    return { ok: true, pos: pos };
  }

  function closeById(a, m, id, reason, atPrice) {
    var i = a.positions.findIndex(function (p) { return p.id === id; });
    if (i < 0) return null;
    var pos = a.positions[i], px = atPrice != null ? atPrice : closePriceOf(m, pos), pnl = pnlUsd(pos, px);
    a.positions.splice(i, 1);
    a.balance += pnl;
    if (a.balance > a.peak) a.peak = a.balance;
    var P = PAIRS[pos.sym];
    var rec = { id: pos.id, sym: pos.sym, dir: pos.dir, lots: pos.lots, entry: pos.entry, exit: px, pnl: pnl, reason: reason || "manual", tOpen: pos.t, tClose: Date.now(),
      pips: (pos.dir * (px - pos.entry)) / P.pip, hadSL: !!pos.sl, hadTP: !!pos.tp, trend: pos.trend || "range",
      riskUsd: pos.riskUsd || 0, riskPct: pos.riskUsd && pos.balAtOpen ? (pos.riskUsd / pos.balAtOpen) * 100 : null,
      rMult: pos.riskUsd ? pnl / pos.riskUsd : null,
      rrPlanned: pos.sl && pos.tp ? Math.abs(pos.tp - pos.entry) / Math.abs(pos.entry - pos.sl) : null };
    a.history.unshift(rec);
    if (a.history.length > 100) a.history.length = 100;
    return rec;
  }

  // run after every price update: stop-loss, take-profit and stop-out. Returns the trades it closed.
  function checkStops(a, m) {
    var closed = [];
    a.positions.slice().forEach(function (pos) {
      var q = quote(m, pos.sym), hit = null;
      if (pos.dir === 1) {
        if (pos.sl && q.bid <= pos.sl) hit = ["stop-loss", pos.sl]; else if (pos.tp && q.bid >= pos.tp) hit = ["take-profit", pos.tp];
      } else {
        if (pos.sl && q.ask >= pos.sl) hit = ["stop-loss", pos.sl]; else if (pos.tp && q.ask <= pos.tp) hit = ["take-profit", pos.tp];
      }
      if (hit) { var r = closeById(a, m, pos.id, hit[0], hit[1]); if (r) closed.push(r); }
    });
    // stop-out: if equity falls below 50% of used margin, close the worst trade first
    var guard = 0;
    while (a.positions.length && guard++ < 50) {
      var sm = summary(a, m);
      if (sm.level === null || sm.level >= 50) break;
      var worst = a.positions.slice().sort(function (x, y) { return pnlUsd(x, closePriceOf(m, x)) - pnlUsd(y, closePriceOf(m, y)); })[0];
      var r2 = closeById(a, m, worst.id, "stop-out"); if (r2) closed.push(r2);
    }
    return closed;
  }

  function stats(a) {
    var h = a.history, wins = h.filter(function (x) { return x.pnl > 0; }).length, total = h.reduce(function (s, x) { return s + x.pnl; }, 0);
    var best = h.reduce(function (b, x) { return Math.max(b, x.pnl); }, 0), worst = h.reduce(function (b, x) { return Math.min(b, x.pnl); }, 0);
    var dd = a.peak > 0 ? Math.max(0, ((a.peak - a.balance) / a.peak) * 100) : 0;
    return { trades: h.length, wins: wins, winRate: h.length ? (wins / h.length) * 100 : 0, total: total, best: best, worst: worst, drawdown: dd };
  }
  function serialize(a, m) {
    return { acct: { balance: a.balance, start: a.start, nextId: a.nextId, peak: a.peak, positions: a.positions, history: a.history }, prices: prices(m) };
  }

  var API = { PAIRS: PAIRS, DEFAULTS: DEFAULTS, createMarket: createMarket, step: step, quote: quote, candlesOf: candlesOf, createAccount: createAccount,
    analyze: analyze, reviewTrade: reviewTrade, suggestLots: suggestLots, riskOf: riskOf, pipValueUsd: pipValueUsd, summary: summary, open: open, closeById: closeById, checkStops: checkStops, pnlUsd: pnlUsd, marginFor: marginFor, stats: stats, serialize: serialize, round: round };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.ForexLab = API;
})(typeof window !== "undefined" ? window : this);
