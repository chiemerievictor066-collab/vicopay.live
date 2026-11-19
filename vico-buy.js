/* Vico Pay — "Buy Now". VicoBuy.open(item): item = { id, title, price (Naira), saleMode: "vico" | "direct" }.
   saleMode "vico"   -> pay on Vico with Paystack (the money is held until you confirm you received the item).
   saleMode "direct" -> the seller deals directly: opens the seller's WhatsApp chat or phone call. */
(function () {
  "use strict";
  if (window.VicoBuy) return;
  var css = document.createElement("style");
  css.textContent = ".vb-chip{border:1px solid #c5dcf7;border-radius:16px;padding:9px 14px;font-weight:800;background:#fff;cursor:pointer;color:#14224d}.vb-chip.on{background:#4c1d95;color:#fff;border-color:#4c1d95}";
  document.head.appendChild(css);
  function box() { var m = document.getElementById("vbModal"); if (!m) { m = document.createElement("div"); m.id = "vbModal"; m.className = "gm-modal"; m.innerHTML = '<div class="box" id="vbBody"></div>'; document.body.appendChild(m); } return m; }
  function close() { box().classList.remove("on"); }
  function open(it) {
    if (!window.gmSignedIn || !gmSignedIn()) { gmNeedLogin(); return; }
    if (it.saleMode === "direct") return direct(it);
    var m = box(), b = document.getElementById("vbBody"), method = "address";
    b.innerHTML = '<h2 style="margin:0 0 4px">Buy: ' + gmEsc(it.title) + '</h2><div style="font-size:24px;font-weight:900;color:#4c1d95">' + gmM(it.price) + "</div>" +
      '<div id="vbNote" style="color:#5d7096;font-weight:600;font-size:13px;margin:6px 0"></div>' +
      '<label class="gm-lab">How do you want to receive it?</label><div style="display:flex;gap:8px;flex-wrap:wrap" id="vbM"><button type="button" class="vb-chip on" data-m="address">Send it to my address</button><button type="button" class="vb-chip" data-m="contact">Contact me to arrange</button></div>' +
      '<label class="gm-lab">Your phone number</label><input class="gm-in" id="vbP" inputmode="tel" maxlength="20"><div id="vbAW"><label class="gm-lab">Your delivery address</label><textarea class="gm-in" id="vbA" rows="2" maxlength="200"></textarea></div>' +
      '<div class="err" id="vbE" style="color:#dc2626;font-weight:700;font-size:13.5px;min-height:18px;margin-top:8px"></div><div style="display:flex;gap:10px;margin-top:12px"><button class="gm-btn" id="vbGo" type="button">Pay now</button><button class="gm-btn blue" id="vbX" type="button">Cancel</button></div>';
    function note() { document.getElementById("vbNote").innerHTML = "You pay in Naira (₦" + Number(it.price).toLocaleString() + ") with Paystack" + (gmIsUsd() ? " — the dollar price above is the same amount at today's rate" : "") + ". Vico holds the money and releases it to the seller when you confirm you received the item (or after a few days). Vico does not deliver: you and the seller arrange it."; }
    note(); window.gmOnCurrency = note;
    document.getElementById("vbM").onclick = function (e) { var x = e.target.closest("button"); if (!x) return; method = x.dataset.m; [].forEach.call(this.children, function (c) { c.classList.toggle("on", c === x); }); document.getElementById("vbAW").style.display = method === "address" ? "block" : "none"; };
    document.getElementById("vbX").onclick = close;
    document.getElementById("vbGo").onclick = function () { var go = this, e = document.getElementById("vbE"); e.textContent = ""; go.disabled = true;
      gmApi("/api/market/orders", { body: { listingId: it.id, method: method, phone: document.getElementById("vbP").value, address: document.getElementById("vbA").value } }).then(function (d) { go.disabled = false; if (d.success && d.url) location.href = d.url; else e.textContent = d.message || "Could not start the payment."; }); };
    m.classList.add("on");
  }
  function direct(it) {
    gmApi("/api/market/listings/" + it.id + "/contact", { method: "POST", body: {} }).then(function (d) {
      if (!d.success) { gmToast(d.message || "Could not get the seller's contact."); return; }
      var m = box(), b = document.getElementById("vbBody");
      b.innerHTML = '<h2 style="margin:0 0 4px">' + gmEsc(it.title) + '</h2><div style="font-size:24px;font-weight:900;color:#4c1d95">' + gmM(it.price) + '</div>' +
        '<p style="font-weight:600;color:#5d7096">This seller deals directly with buyers. Agree the price, payment and delivery with the seller. Vico does not hold money for direct deals, so never pay before you are sure.</p>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap"><a class="gm-btn" target="_blank" rel="noopener" href="' + gmEsc(d.link) + '">' + (d.mode === "phone" ? "📞 Call " : "💬 WhatsApp ") + gmEsc(d.number) + '</a><button class="gm-btn blue" id="vbX" type="button">Close</button></div>';
      document.getElementById("vbX").onclick = close; m.classList.add("on");
    });
  }
  window.VicoBuy = { open: open, close: close };
})();
