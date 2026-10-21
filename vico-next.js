/* =====================================================
   VicoPay Live — "Next page" arrow
   Adds two round arrow buttons: one on the RIGHT that leads to the next page of the app and one on
   the LEFT that goes back to the previous page, in this order:
   Home -> Live Room -> Go Live -> Profile -> ... -> back to Home.
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
  // The arrows only appear on pages that have no button of their own leading to another page.
  // They are NOT on Home, Live Room, Go Live, Profile, Settings or the other pages that already have menus.
  var SHOW_ON = ["hosts.html", "gifters.html", "host-wallet.html", "creator-withdrawal.html", "buy-coin.html", "coin-history.html", "my-gifts.html", "forex.html", "terms.html", "privacy.html"];
  if (idx < 0 || SHOW_ON.indexOf(here) === -1 || document.getElementById("vicoNextBtn")) return;

  var signedIn = false;
  try { signedIn = !!(window.VicoAuth && VicoAuth.isSignedIn && VicoAuth.isSignedIn()) || !!localStorage.getItem("vicoPayToken"); } catch (e) {}
  // signed-out visitors only follow the public pages (so they are never sent to a login screen)
  var PUBLIC = ["home.html", "help-center.html", "about.html", "community-guidelines.html", "contact.html", "terms.html", "privacy.html", "forex.html"];
  function neighbour(step) {          // step = +1 (next) or -1 (previous); the list loops around
    var n = idx;
    for (var k = 0; k < ORDER.length; k++) {
      n = (n + step + ORDER.length) % ORDER.length;
      if (signedIn || PUBLIC.indexOf(ORDER[n][0]) !== -1) return ORDER[n];
    }
    return ORDER[(idx + step + ORDER.length) % ORDER.length];
  }
  var next = neighbour(1), prev = neighbour(-1);

  // Both arrows sit together at the TOP CENTER of the screen, small and slightly see-through, so they never cover
  // a button at the bottom (My Gifts, Go Live, menus) or the sides. Nothing expands on hover.
  var css = document.createElement("style");
  css.textContent =
    "#vicoPrevBtn,#vicoNextBtn{position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);z-index:9000;width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid #ffffff55;border-radius:50%;" +
    "background:linear-gradient(135deg,#10bfffd9,#0646b8d9);color:#fff;text-decoration:none;box-shadow:0 3px 10px rgba(3,28,93,.35);opacity:.8;cursor:pointer;transition:opacity .2s,transform .2s;-webkit-tap-highlight-color:transparent}" +
    "#vicoPrevBtn{left:calc(50% - 38px)}#vicoNextBtn{left:calc(50% + 6px)}" +
    "#vicoPrevBtn:hover,#vicoNextBtn:hover,#vicoPrevBtn:focus-visible,#vicoNextBtn:focus-visible{opacity:1;transform:scale(1.08)}" +
    "#vicoPrevBtn .arr,#vicoNextBtn .arr{display:grid;place-items:center;width:100%;height:100%}" +
    "#vicoPrevBtn .arr svg,#vicoNextBtn .arr svg{width:16px;height:16px}" +
    "#vicoPrevBtn .lbl,#vicoNextBtn .lbl{display:none}" +
    "@media print{#vicoNextBtn,#vicoPrevBtn{display:none}}";
  document.head.appendChild(css);

  function make(id, target, dir) {
    if (document.getElementById(id)) return;
    var a = document.createElement("a");
    a.id = id;
    a.href = target[0];
    a.title = (dir > 0 ? "Next: " : "Previous: ") + target[1];
    a.setAttribute("aria-label", (dir > 0 ? "Next page: " : "Previous page: ") + target[1]);
    var arrow = '<span class="arr"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="' + (dir > 0 ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7") + '"/></svg></span>';
    a.innerHTML = dir > 0 ? arrow + '<span class="lbl"></span>' : arrow + '<span class="lbl"></span>';
    a.querySelector(".lbl").textContent = target[1];
    document.body.appendChild(a);
  }
  function build() {
    make("vicoPrevBtn", prev, -1);
    make("vicoNextBtn", next, 1);
  }
  if (document.body) build(); else document.addEventListener("DOMContentLoaded", build);
})();
