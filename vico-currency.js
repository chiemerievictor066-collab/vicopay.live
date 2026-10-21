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

  /* ---- the chooser: only on the Home page ---- */
  var page = (location.pathname.split("/").pop() || "").toLowerCase();
  var isHome = page === "" || page === "home.html" || page === "index.html";
  function paint() {
    var bar = document.getElementById("vicoCurBar"); if (!bar) return;
    var c = get();
    [].forEach.call(bar.querySelectorAll("button"), function (b) { b.classList.toggle("on", b.dataset.c === c); b.setAttribute("aria-pressed", b.dataset.c === c ? "true" : "false"); });
  }
  function build() {
    if (!isHome || document.getElementById("vicoCurBar")) return;
    var css = document.createElement("style");
    css.textContent =
      "#vicoCurBar{position:relative;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:52px;padding:8px max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left));background:linear-gradient(90deg,#04153a,#0a2d6e);border-bottom:1px solid #ffffff22;color:#fff;font-family:system-ui,Arial,sans-serif}" +
      "#vicoCurBar .t{font-size:12px;font-weight:700;line-height:1.25;max-width:calc(50% - 54px);color:#cfe3ff}#vicoCurBar .t b{display:block;color:#fff;font-size:13px}" +
      "#vicoCurBar .b{display:flex;gap:5px;flex:none;margin-left:auto}" +
      "#vicoCurBar button{border:1px solid #ffffff2e;background:#ffffff12;color:#fff;font:800 11px system-ui,Arial,sans-serif;padding:8px 9px;border-radius:999px;cursor:pointer;white-space:nowrap}" +
      "#vicoCurBar button.on{background:#19d98b;border-color:#19d98b;color:#04210f}" +
      "@media(min-width:700px){#vicoCurBar .t{max-width:none;font-size:13px}#vicoCurBar button{font-size:13px;padding:8px 14px}}";
    document.head.appendChild(css);
    var bar = document.createElement("div"); bar.id = "vicoCurBar"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Choose VicoPay preferred currency");
    bar.innerHTML = '<div class="t"><b>Choose VicoPay</b>preferred currency</div><div class="b"><button type="button" data-c="NGN">₦ Naira</button><button type="button" data-c="USD">$ Dollar</button></div>';
    bar.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) set(b.dataset.c); });
    document.body.insertBefore(bar, document.body.firstChild);
    paint();
  }
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
