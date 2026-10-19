/* =====================================================
   VicoPay Live — "Next page" arrow
   Adds a round arrow button (right side of the screen) that leads to the next page of the app,
   in this order:  Home -> Live Room -> Go Live -> Profile -> ... -> back to Home.
   The server adds this script to every page automatically (see server.js), so new pages only need
   to be added to the ORDER list below.
   ===================================================== */
(function () {
  "use strict";
  // [file, label shown on the button]
  var ORDER = [
    ["home.html", "Home"],
    ["live-room.html", "Live Room"],
    ["Go-Live.html", "Go Live"],
    ["profile.html", "Profile"],
    ["live-room-dashboard.html", "Creator Dashboard"],
    ["host-wallet.html", "Live Room Wallet"],
    ["creator-withdrawal.html", "Withdrawal"],
    ["hosts.html", "Host Ranking"],
    ["gifters.html", "Gifter Ranking"],
    ["gift-shop.html", "Gift Shop"],
    ["buy-coin.html", "Buy Coins"],
    ["coin-history.html", "Coin History"],
    ["my-gifts.html", "My Gifts"],
    ["followers.html", "Following"],
    ["pk-battles.html", "PK Battles"],
    ["fan-club.html", "Fan Club"],
    ["forex.html", "Forex"],
    ["settings.html", "Settings"],
    ["help-center.html", "Help Center"],
    ["about.html", "About Us"],
    ["community-guidelines.html", "Community Guidelines"],
    ["contact.html", "Contact"],
    ["terms.html", "Terms of Service"],
    ["privacy.html", "Privacy Policy"]
  ];
  // pages that are not part of the tour (sign-in, payments, admin, live viewing, errors) get no arrow
  var here = (location.pathname.split("/").pop() || "").toLowerCase();
  var idx = -1;
  for (var i = 0; i < ORDER.length; i++) if (ORDER[i][0].toLowerCase() === here) { idx = i; break; }
  if (idx < 0 || document.getElementById("vicoNextBtn")) return;

  var next = ORDER[(idx + 1) % ORDER.length];   // last page leads back to Home
  var signedIn = !!(window.VicoAuth && VicoAuth.isSignedIn && VicoAuth.isSignedIn());
  // signed-out visitors only follow the public pages
  if (!signedIn) {
    var PUBLIC = ["home.html", "help-center.html", "about.html", "community-guidelines.html", "contact.html", "terms.html", "privacy.html", "forex.html"];
    var n = idx;
    for (var k = 0; k < ORDER.length; k++) {
      n = (n + 1) % ORDER.length;
      if (PUBLIC.indexOf(ORDER[n][0]) !== -1) { next = ORDER[n]; break; }
    }
  }

  var css = document.createElement("style");
  css.textContent =
    "#vicoNextBtn{position:fixed;right:max(12px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);z-index:9000;" +
    "display:flex;align-items:center;flex-direction:row-reverse;gap:0;height:48px;min-width:48px;padding:0;border:0;border-radius:24px;" +
    "background:linear-gradient(135deg,#10bfff,#0646b8);color:#fff;text-decoration:none;font:700 13px system-ui,Arial,sans-serif;" +
    "box-shadow:0 6px 18px rgba(3,28,93,.35);opacity:.92;cursor:pointer;overflow:hidden;transition:all .2s}" +
    "#vicoNextBtn:hover,#vicoNextBtn:focus-visible{opacity:1;padding-left:14px;gap:8px}" +
    "#vicoNextBtn .arr{width:48px;height:48px;display:grid;place-items:center;flex:none}" +
    "#vicoNextBtn .arr svg{width:22px;height:22px}" +
    "#vicoNextBtn .lbl{max-width:0;overflow:hidden;white-space:nowrap;transition:max-width .2s}" +
    "#vicoNextBtn:hover .lbl,#vicoNextBtn:focus-visible .lbl{max-width:170px}" +
    "@media(max-width:700px){#vicoNextBtn{top:auto;bottom:calc(86px + env(safe-area-inset-bottom));transform:none;height:44px;min-width:44px}#vicoNextBtn .arr{width:44px;height:44px}}" +
    "@media print{#vicoNextBtn{display:none}}";
  document.head.appendChild(css);

  function build() {
    if (document.getElementById("vicoNextBtn")) return;
    var a = document.createElement("a");
    a.id = "vicoNextBtn";
    a.href = next[0];
    a.title = "Next: " + next[1];
    a.setAttribute("aria-label", "Next page: " + next[1]);
    a.innerHTML = '<span class="arr"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></span><span class="lbl"></span>';
    a.querySelector(".lbl").textContent = next[1];
    document.body.appendChild(a);
  }
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
