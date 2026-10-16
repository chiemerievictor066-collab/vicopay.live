// =====================================================
// VicoPay Live — email through Resend (sending AND receiving)
//
// Environment variables (set them in Render > Environment):
//   RESEND_API_KEY         your Resend API key (starts with re_)
//   MAIL_FROM              the sender, on your VERIFIED domain, e.g.  VicoPay Live <hello@yourdomain.com>
//   INBOX_FORWARD_TO       (receiving) your real inbox. Every email sent to your Resend receiving address is forwarded here
//   RESEND_WEBHOOK_SECRET  (receiving) the "Signing secret" of your Resend webhook (starts with whsec_)
//
// SENDING:    const { data, error } = await resend.emails.send({ from, to, subject, html });
//             (same call and same { data, error } answer as Resend's own library, so it can be swapped later)
//             or the shortcut:  await sendMail({ to, subject, html })   <- uses MAIL_FROM for you
// RECEIVING:  Resend calls  POST /api/resend/webhook  (see features.js), which uses verifyWebhook() and
//             resend.emails.receiving.get(id) below to read the email and forward it to INBOX_FORWARD_TO.
//
// No extra package is needed: this talks to https://api.resend.com with axios, which the site already has.
// =====================================================
const axios = require("axios");
const crypto = require("crypto");

const API = "https://api.resend.com";
const apiKey = () => String(process.env.RESEND_API_KEY || "").trim();
const mailFrom = () => String(process.env.MAIL_FROM || "").trim();

// Turn any answer from Resend into { data, error } (never throws)
async function call(method, path, body) {
  if (!apiKey()) return { data: null, error: { name: "missing_api_key", message: "RESEND_API_KEY is not set.", statusCode: null } };
  try {
    const r = await axios({
      method, url: API + path, data: body, timeout: 15000, validateStatus: () => true,
      headers: { Authorization: "Bearer " + apiKey(), "Content-Type": "application/json" }
    });
    if (r.status >= 200 && r.status < 300) return { data: r.data, error: null };
    const d = r.data || {};
    return { data: null, error: { name: d.name || "resend_error", message: d.message || ("Resend answered with status " + r.status), statusCode: r.status } };
  } catch (e) {
    return { data: null, error: { name: "network_error", message: e.message, statusCode: null } };
  }
}

const resend = {
  emails: {
    // resend.emails.send({ from, to, subject, html, text, replyTo, cc, bcc, tags, attachments })
    send(p) {
      const body = Object.assign({}, p);
      if (body.replyTo !== undefined) { body.reply_to = body.replyTo; delete body.replyTo; }
      if (typeof body.to === "string") body.to = [body.to];
      return call("post", "/emails", body);
    },
    // resend.emails.receiving.get(emailId): the full received email (html, text, headers, attachments)
    receiving: {
      get: (id) => call("get", "/emails/receiving/" + encodeURIComponent(String(id || ""))),
      list: () => call("get", "/emails/receiving")
    }
  }
};

// Easy sender: fills in MAIL_FROM. Returns { ok, id, error }
async function sendMail({ to, subject, html, text, replyTo, from }) {
  const sender = from || mailFrom();
  if (!sender) return { ok: false, id: null, error: { name: "missing_mail_from", message: "MAIL_FROM is not set." } };
  const payload = { from: sender, to, subject };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (!html && !text) payload.text = " ";
  if (replyTo) payload.replyTo = replyTo;
  const { data, error } = await resend.emails.send(payload);
  return { ok: !error, id: data && data.id ? data.id : null, error };
}

// true when this server can send email
const ready = () => !!(apiKey() && mailFrom());

// Check that a webhook call really came from Resend (Svix signature). rawBody = the exact bytes received.
function verifyWebhook(rawBody, headers, secret) {
  try {
    const id = headers["svix-id"], ts = headers["svix-timestamp"], sigHeader = headers["svix-signature"];
    if (!id || !ts || !sigHeader || !secret || !rawBody) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false; // too old / replayed
    const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
    const expected = crypto.createHmac("sha256", key).update(id + "." + ts + "." + rawBody.toString("utf8")).digest("base64");
    const exp = Buffer.from(expected);
    return String(sigHeader).split(" ").some((part) => {
      const sig = part.split(",")[1] || "";
      const got = Buffer.from(sig);
      return got.length === exp.length && crypto.timingSafeEqual(got, exp);
    });
  } catch (e) { return false; }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

module.exports = { resend, sendMail, ready, verifyWebhook, esc, mailFrom };
