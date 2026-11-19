/* Vico Pay — VicoSocial: Follow / Save / ⋯ menu / Download for short videos and product pictures.
   Needs gm-nav.js first (gmApi, gmSignedIn, gmNeedLogin, gmToast, gmEsc).  Server side: vico-engage.js. */
(function () {
  "use strict";
  if (window.VicoSocial) return;
  var css = document.createElement("style");
  css.textContent = ".vsoc-sheet{position:fixed;inset:0;z-index:120;background:rgba(10,10,30,.55);display:none;align-items:flex-end;justify-content:center}.vsoc-sheet.on{display:flex}" +
    ".vsoc-box{width:min(460px,100%);background:#fff;border-radius:24px 24px 0 0;padding:10px 10px 18px;box-shadow:0 -12px 40px rgba(20,20,80,.3)}" +
    ".vsoc-box h4{margin:6px 12px 8px;color:#14224d;font:800 15px system-ui,Arial;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".vsoc-box button,.vsoc-box a{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;text-align:left;border:0;background:none;border-radius:14px;padding:14px 14px;font:700 16px system-ui,Arial;color:#14224d;cursor:pointer;text-decoration:none}" +
    ".vsoc-box button:hover,.vsoc-box a:hover{background:#eef2ff}.vsoc-box .x{color:#5d7096;justify-content:center;margin-top:4px;background:#f1f4ff}.vsoc-box small{display:block;color:#5d7096;font-weight:600;font-size:12px}" +
    ".vsoc-c{display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:0;cursor:pointer;color:inherit;font:800 13px system-ui,Arial}" +
    ".vsoc-c i{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:22px;background:#eaf0ff;color:#2b2a8c;border:1px solid #d6e0ff}" +
    ".vsoc-c.on i{background:#ede9fe;border-color:#c4b5fd}.vsoc-c.liked i{background:#ffe4ea;border-color:#ffb3c4}";
  document.head.appendChild(css);
  var sheet = null;
  function $sheet() { if (!sheet) { sheet = document.createElement("div"); sheet.className = "vsoc-sheet"; sheet.innerHTML = '<div class="vsoc-box" role="dialog" aria-label="More"></div>'; sheet.onclick = function (e) { if (e.target === sheet) close(); }; document.body.appendChild(sheet); } return sheet; }
  function close() { if (sheet) sheet.classList.remove("on"); }
  function needLogin() { if (window.gmSignedIn && gmSignedIn()) return false; if (window.gmNeedLogin) gmNeedLogin(); return true; }
  function toast(m) { if (window.gmToast) gmToast(m); }
  function api(u, o) { return gmApi(u, o); }
  function token() { return window.VicoAuth && VicoAuth.getToken ? VicoAuth.getToken() : ""; }

  function state(kind, id) { return api("/api/social/state?kind=" + kind + "&id=" + encodeURIComponent(id)); }
  function save(kind, id) { if (needLogin()) return Promise.resolve({ success: false }); return api("/api/social/save", { body: { kind: kind, id: id } }); }
  function likeProduct(id) { if (needLogin()) return Promise.resolve({ success: false }); return api("/api/social/like", { body: { id: id } }); }
  function follow(handle, on) { if (needLogin()) return Promise.resolve({ success: false }); return api(on ? "/api/unfollow" : "/api/follow", { body: { hostId: handle } }); }
  function share(title, url) {
    if (navigator.share) return navigator.share({ title: title, text: title + " on Vico Pay", url: url }).catch(function () {});
    if (navigator.clipboard) { navigator.clipboard.writeText(url); toast("Link copied."); } else window.prompt("Copy this link", url);
    return Promise.resolve();
  }
  // fetch the file with the person's login, then hand it to the browser as a download
  function download(url, name, needsAuth) {
    if (needLogin()) return;
    toast("Preparing your download…");
    var h = {}; if (needsAuth && token()) h.Authorization = "Bearer " + token();
    fetch(url, { headers: h }).then(function (r) { if (!r.ok) throw new Error(r.status === 429 ? "One moment, then try again." : "Could not download."); return r.blob(); }).then(function (b) {
      var a = document.createElement("a"), u = URL.createObjectURL(b); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); toast("Saved to your device.");
    }).catch(function (e) { toast(e.message || "Could not download."); });
  }
  /* the "⋯" menu. opts: { title, website, shareUrl, downloadUrl, downloadName, downloadAuth, onReport } */
  function menu(opts) {
    var s = $sheet(), b = s.firstChild, esc = window.gmEsc || function (x) { return x; };
    b.innerHTML = '<h4>' + esc(opts.title || "More") + '</h4>' +
      (opts.website ? '<a id="vsW" target="_blank" rel="noopener noreferrer nofollow" href="' + esc(opts.website) + '">🌐 <span>Visit website<small>' + esc(opts.website.replace(/^https:\/\//, "").slice(0, 48)) + '</small></span></a>' : "") +
      (opts.downloadUrl ? '<button type="button" id="vsD">⬇️ <span>Save to my device<small>Download the file</small></span></button>' : "") +
      '<button type="button" id="vsL">🔗 Copy link</button>' +
      (opts.onReport ? '<button type="button" id="vsR">🚩 Report</button>' : "") +
      '<button type="button" class="x" id="vsX">Close</button>';
    var q = function (i) { return b.querySelector("#" + i); };
    if (q("vsD")) q("vsD").onclick = function () { close(); download(opts.downloadUrl, opts.downloadName || "vico-download", !!opts.downloadAuth); };
    q("vsL").onclick = function () { close(); if (navigator.clipboard) { navigator.clipboard.writeText(opts.shareUrl || location.href); toast("Link copied."); } else window.prompt("Copy this link", opts.shareUrl || location.href); };
    if (q("vsR")) q("vsR").onclick = function () { close(); opts.onReport(); };
    if (q("vsW")) q("vsW").onclick = function () { setTimeout(close, 50); };
    q("vsX").onclick = close; s.classList.add("on");
  }
  window.VicoSocial = { state: state, save: save, likeProduct: likeProduct, follow: follow, share: share, download: download, menu: menu, close: close };
})();
