/* =====================================================
   VicoPay Live — ONE currency choice for the whole app (Naira or Dollar)
   The choice is made once at the top of the Home page. Every page with prices (Gift Shop, Buy Coins, Forex)
   reads it from here:   VicoCurrency.get()  ->  "NGN" | "USD"
                         VicoCurrency.set("USD")
                         VicoCurrency.on(function (c) { ...redraw prices... })
   Rate: 10 coins = ₦100 = $0.07
   ===================================================== */
(function () {
  "use strict";
  if (window.VicoCurrency) return;
  var KEY = "vicoCurrency", listeners = [];
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function guess() {
    var tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    return tz === "Africa/Lagos" ? "NGN" : "USD";
  }
  function get() {
    var v = ls(KEY);
    if (v !== "USD" && v !== "NGN") v = ls("vicoPayCurrency") || ls("giftShopCurrency") || ls("vicoForexCur");
    return v === "USD" || v === "NGN" ? v : guess();
  }
  function set(c) {
    c = c === "USD" ? "USD" : "NGN";
    ls(KEY, c); ls("vicoPayCurrency", c); ls("giftShopCurrency", c); ls("vicoForexCur", c);   // keeps older pages in step
    paint();
    listeners.slice().forEach(function (fn) { try { fn(c); } catch (e) {} });
  }
  function on(fn) { if (typeof fn === "function") listeners.push(fn); }
  window.addEventListener("storage", function (e) {
    if (e.key === KEY && (e.newValue === "USD" || e.newValue === "NGN")) { paint(); listeners.slice().forEach(function (fn) { try { fn(e.newValue); } catch (x) {} }); }
  });
  window.VicoCurrency = { get: get, set: set, on: on };

  /* ---- the chooser sits in the Home page (under the hero tags): <div id="vicoCurBar"> with two buttons ---- */
  function paint() {
    var bar = document.getElementById("vicoCurBar"); if (!bar) return;
    var c = get();
    [].forEach.call(bar.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.dataset.c === c); b.setAttribute("aria-pressed", b.dataset.c === c ? "true" : "false"); });
  }
  function bind() {
    var bar = document.getElementById("vicoCurBar"); if (!bar) return;
    bar.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) set(b.dataset.c); });
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
})();
