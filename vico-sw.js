// VicoPay service worker: shows Vico Message verification codes sent by Web Push, even when the page is closed.
// It stores nothing and does nothing else.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  var code = d.data && d.data.code ? String(d.data.code) : (d.code ? String(d.code) : "");
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      // a Vico Message page is open: hand the code to it so it can fill the box
      list.forEach(function (c) { if (code) c.postMessage({ type: "vm_code", code: code }); });
      return self.registration.showNotification(d.title || "VicoPay", {
        body: d.body || "", tag: d.tag || "vm", renotify: true,
        icon: "/vico-app-icon-192.png", badge: "/favicon-32x32.png",
        data: { url: d.url || (d.data && d.data.url) || "vico-messages.html" }
      });
    })
  );
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "vico-messages.html", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].url.split("#")[0] === url.split("#")[0] && "focus" in list[i]) return list[i].focus();
      return self.clients.openWindow(url);
    })
  );
});
