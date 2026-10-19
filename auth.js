/* =====================================================
   VicoPay Live — shared sign-in helper
   Include on every page that talks to the server:
     <script src="auth.js"></script>
   It (1) stores the session, (2) automatically attaches the
   signed-in user's token to every /api/ request, and (3) sends
   people to the sign-in page when their session is missing/expired.
   ===================================================== */
(function () {
  var TOKEN_KEY = "vicoPayToken";
  var LOGIN_PAGE = "join-now.html";
  var PUBLIC_PAGES = ["join-now.html", "signup.html", "forgot-password.html", "reset-password.html", "terms.html", "privacy.html", "motivational-page.html", "welcome-page.html", "forex.html", "vicopay-global-livestream.html", "help-center.html", "about.html", "contact.html", "community-guidelines.html"];

  function page() {
    return (location.pathname.split("/").pop() || "").toLowerCase();
  }

  var Auth = {
    getToken: function () { return localStorage.getItem(TOKEN_KEY) || ""; },
    isSignedIn: function () { return !!Auth.getToken(); },

    setSession: function (token, user, remember) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem("vicoPayEmail", user.email);
      localStorage.setItem("vicoPayUser", user.email);
      localStorage.setItem("vicoPayDisplayName", user.displayName || user.email);
      localStorage.setItem("vicoPayRemember", remember ? "true" : "false");
    },

    clear: function () {
      ["vicoPayToken", "vicoPayEmail", "vicoPayUser", "vicoPayDisplayName", "vicoPayRemember", "vicoPayMe", "vicoPayProfileImage"].forEach(function (k) {
        localStorage.removeItem(k);
      });
    },

    signOut: function () {
      Auth.clear();
      location.href = LOGIN_PAGE;
    },

    // where to go after signing in (?next=page.html), otherwise the fallback
    nextUrl: function (fallback) {
      var next = new URLSearchParams(location.search).get("next") || "";
      // only allow local pages, never another website
      return /^[a-zA-Z0-9_\-]+\.html(\?[^\s]*)?$/.test(next) ? next : fallback;
    },

    // send visitors who are not signed in to the sign-in page
    requireLogin: function () {
      if (!Auth.isSignedIn() && PUBLIC_PAGES.indexOf(page()) === -1) {
        location.href = LOGIN_PAGE + "?next=" + encodeURIComponent(page() + location.search);
      }
    }
  };
  window.VicoAuth = Auth;

  // If a page asks for data and the server answers with a web page (Render is waking up, or the page was opened
  // from Live Server / a file instead of your VicoPay address), say so clearly instead of "Unexpected token '<'".
  (function () {
    var realJson = Response.prototype.json;
    Response.prototype.json = function () {
      var res = this;
      return res.clone().text().then(function (t) {
        try { return JSON.parse(t); } catch (e) {
          throw new Error(location.protocol === "file:"
            ? "Open this page through your VicoPay server (for example http://localhost:3000), not by double-clicking the file."
            : "The server sent back a web page instead of data. It may be starting up (wait 30 seconds and refresh), or this page was not opened from your VicoPay server address.");
        }
      });
    };
  })();

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var isApi = url.indexOf("/api/") !== -1 && (url.charAt(0) === "/" || url.indexOf(location.origin) === 0);
    var isAuthCall = url.indexOf("/api/auth/login") !== -1 || url.indexOf("/api/auth/register") !== -1;

    if (isApi && !isAuthCall && Auth.getToken()) {
      init = init || {};
      var headers = new Headers(init.headers || {});
      if (!headers.has("Authorization")) headers.set("Authorization", "Bearer " + Auth.getToken());
      init.headers = headers;
    }

    return realFetch(input, init).then(function (response) {
      if (response.status === 401 && isApi && !isAuthCall && PUBLIC_PAGES.indexOf(page()) === -1) {
        Auth.clear();
        location.href = LOGIN_PAGE + "?next=" + encodeURIComponent(page() + location.search);
      }
      return response;
    });
  };
})();
