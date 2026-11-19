/* Vico Pay Live — creator promotion and lifetime live-hours card. */
(function () {
  "use strict";
  function formatHours(value) {
    var minutes = Math.floor(Math.max(0, Number(value) || 0) * 60);
    return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  }
  function mount() {
    if (document.querySelector(".vico-live-summary") || !document.body) return;
    var card = document.createElement("section");
    card.className = "vico-live-summary";
    card.style.cssText = "max-width:900px;margin:18px auto;padding:18px;border:1px solid #b9ddf5;border-radius:18px;background:linear-gradient(135deg,#eff8ff,#fff);color:#12345b;box-shadow:0 8px 24px #0b4b8010;font-family:Arial,sans-serif";
    card.innerHTML = '<div style="font-weight:900;color:#0757a6;font-size:18px;margin-bottom:12px">📣 Streamer promotion & live hours</div>' +
      '<div class="lp-status" style="display:inline-flex;align-items:center;padding:8px 12px;border-radius:20px;background:#e7eef5;color:#53677d;font-weight:900;font-size:12px">NOT PROMOTED</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:14px">' +
      '<div>Followers<div class="lp-followers" style="font-size:24px;font-weight:900">—</div><small>Requirement: 1,000</small></div>' +
      '<div>Golden Stars<div class="lp-stars" style="font-size:24px;font-weight:900">—</div><small>Requirement: 12,000</small></div>' +
      '<div>Total live time<div class="lp-hours" style="font-size:24px;font-weight:900">—</div><small>Saved in Vico Pay Live</small></div></div>' +
      '<div class="lp-profile" style="margin-top:12px;font-size:13px;color:#45617f">Your profile story and joining date will appear here.</div>' +
      '<div style="margin-top:8px;font-size:12px;color:#45617f">Promotion is automatic when both requirements are met.</div>';
    var header = document.querySelector("header");
    if (header && header.parentNode) header.parentNode.insertBefore(card, header.nextSibling);
    else document.body.insertBefore(card, document.body.firstChild);
  }
  async function refresh() {
    var card = document.querySelector(".vico-live-summary");
    if (!card) return;
    try {
      var response = await fetch(location.origin + "/api/creator/live-summary", { credentials: "same-origin" });
      var data = await response.json();
      if (!response.ok || !data.success) return;
      var status = card.querySelector(".lp-status"), profile = data.profile || {};
      status.textContent = data.promoted ? "✓ PROMOTED · VIP LIVE" : "NOT PROMOTED";
      status.style.background = data.promoted ? "#dcfce7" : "#e7eef5";
      status.style.color = data.promoted ? "#166534" : "#53677d";
      card.querySelector(".lp-followers").textContent = Number(data.followers || 0).toLocaleString();
      card.querySelector(".lp-stars").textContent = Number(data.stars || 0).toLocaleString();
      card.querySelector(".lp-hours").textContent = formatHours(data.liveHours);
      var joined = profile.joinedAt ? new Date(profile.joinedAt).toLocaleString() : "Joining date unavailable";
      card.querySelector(".lp-profile").textContent = (profile.bio || "No personal story added yet.") + " · Joined Vico Pay Live: " + joined;
    } catch (e) { /* Keep the card visible; it will retry on the next refresh. */ }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { mount(); refresh(); });
  else { mount(); refresh(); }
  setInterval(refresh, 30000);
})();
