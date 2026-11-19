// =====================================================
// Vico Pay Live — ID CHECK APPROVAL (tells the approver an ID is waiting)
// =====================================================
// When an advertiser sends an ID, the person named in .env (ID_APPROVER_EMAIL) gets an email with a link to the review page.
// * The email NEVER contains the ID photo or the ID number. The approver opens the admin page to see them.
// * Nobody is approved by email. Approving / rejecting is still done by an admin on the review page.
// * If no approver email is set, nothing is sent and the ID simply waits in the review page (nothing breaks).
// .env:  ID_APPROVER_EMAIL=you@yourdomain.com   (falls back to PAYOUT_APPROVER_EMAIL, then INBOX_FORWARD_TO)
//        ID_REVIEW_URL=  optional, the page the link points to (default: APP_URL + /admin-community.html)
//        ID_REQUIRED_FOR_PRODUCT_LIVE=true   (default true) an advertiser must have an approved ID before selling in a live
// =====================================================
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const approverEmail = () => {
  for (const k of ["ID_APPROVER_EMAIL", "PAYOUT_APPROVER_EMAIL", "INBOX_FORWARD_TO"]) {
    const v = String(process.env[k] || "").trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v;
  }
  return "";
};
const reviewUrl = () => {
  const own = String(process.env.ID_REVIEW_URL || "").trim();
  if (/^https:\/\//.test(own)) return own;
  return String(process.env.APP_URL || process.env.PUBLIC_URL || "").replace(/\/$/, "") + "/admin-community.html";
};
const requiredForLive = () => !/^(false|0|no|off)$/i.test(String(process.env.ID_REQUIRED_FOR_PRODUCT_LIVE || "true").trim());
// builds the email (pure, tested): only names and the document TYPE, never the photo or number
function buildMail({ who, docLabel, source, url }) {
  const subject = "ID check waiting: " + String(who || "an advertiser").slice(0, 60);
  const text = "An advertiser sent an ID for checking.\n\nWho: " + who + "\nDocument: " + docLabel + "\nFrom: " + source + "\n\nOpen the review page to look at it and approve or reject:\n" + url + "\n\nThis email does not contain the ID photo. You cannot approve by replying to it.";
  const html = "<p>An advertiser sent an ID for checking.</p><p><b>Who:</b> " + esc(who) + "<br><b>Document:</b> " + esc(docLabel) + "<br><b>From:</b> " + esc(source) + "</p><p><a href=\"" + esc(url) + "\">Open the review page</a></p><p style=\"color:#667\">This email does not contain the ID photo. You cannot approve by replying to it.</p>";
  return { subject, text, html };
}
// fire-and-forget: a failed email must never block the advertiser
async function notifyIdSubmitted({ who, docLabel, source }) {
  try {
    const axios = require("axios");   // loaded here so a missing package can never break an ID upload
    const to = approverEmail();
    if (!to || !process.env.RESEND_API_KEY || !process.env.MAIL_FROM) { if (to) console.log("ID APPROVAL: email not sent (RESEND_API_KEY / MAIL_FROM missing). An ID is waiting in the review page."); return false; }
    const m = buildMail({ who, docLabel, source, url: reviewUrl() });
    await axios.post("https://api.resend.com/emails", { from: process.env.MAIL_FROM, to: [to], subject: m.subject, text: m.text, html: m.html }, { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY }, timeout: 12000 });
    return true;
  } catch (e) { console.error("ID APPROVAL MAIL ERROR:", e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message); return false; }
}
module.exports = { notifyIdSubmitted, buildMail, approverEmail, reviewUrl, requiredForLive };
