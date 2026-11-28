// =====================================================
// Vico Message — phone numbers, one-time codes and SMS delivery
// =====================================================
// Pure helpers (no database, no network unless sendSms() is called) so they can be tested: tests/vico-message.test.js
//
// .env settings for the SMS that carries the verification code (pick ONE provider):
//   Infobip (global, recommended):  INFOBIP_API_KEY   INFOBIP_BASE_URL (e.g. xxxxx.api.infobip.com)   [INFOBIP_SENDER]
//   Termii (Nigeria):               TERMII_API_KEY   TERMII_SENDER_ID   [TERMII_CHANNEL=generic|dnd|whatsapp]   [TERMII_BASE_URL]
//   Twilio:                         TWILIO_ACCOUNT_SID   TWILIO_AUTH_TOKEN   TWILIO_FROM  (or TWILIO_MESSAGING_SERVICE_SID)
//   SMS_PROVIDER=infobip|termii|twilio   (optional: only needed when more than one is configured; otherwise Infobip is used first)
// VicoPay creates, hashes, expires and checks every code itself (vico-messages.js). The provider is only the delivery truck:
// Infobip is called through its plain "send SMS" API, never through a provider-side OTP/2FA product.
// Without a provider, codes are printed in the server log while developing. In production (NODE_ENV=production) the app
// refuses to pretend a code was sent, so nobody is told to wait for an SMS that will never arrive.
const crypto = require("crypto");

// dial = country calling code. Nigeria first because it is the default.
const COUNTRIES = [
  { code: "NG", name: "Nigeria", dial: "234" }, { code: "GH", name: "Ghana", dial: "233" }, { code: "KE", name: "Kenya", dial: "254" },
  { code: "ZA", name: "South Africa", dial: "27" }, { code: "TZ", name: "Tanzania", dial: "255" }, { code: "UG", name: "Uganda", dial: "256" },
  { code: "CM", name: "Cameroon", dial: "237" }, { code: "SN", name: "Senegal", dial: "221" }, { code: "CI", name: "Côte d’Ivoire", dial: "225" },
  { code: "BJ", name: "Benin", dial: "229" }, { code: "TG", name: "Togo", dial: "228" }, { code: "RW", name: "Rwanda", dial: "250" },
  { code: "ZM", name: "Zambia", dial: "260" }, { code: "ZW", name: "Zimbabwe", dial: "263" }, { code: "EG", name: "Egypt", dial: "20" },
  { code: "MA", name: "Morocco", dial: "212" }, { code: "ET", name: "Ethiopia", dial: "251" },
  { code: "US", name: "United States", dial: "1" }, { code: "CA", name: "Canada", dial: "1" }, { code: "GB", name: "United Kingdom", dial: "44" },
  { code: "IE", name: "Ireland", dial: "353" }, { code: "FR", name: "France", dial: "33" }, { code: "DE", name: "Germany", dial: "49" },
  { code: "ES", name: "Spain", dial: "34" }, { code: "IT", name: "Italy", dial: "39" }, { code: "NL", name: "Netherlands", dial: "31" },
  { code: "PT", name: "Portugal", dial: "351" }, { code: "AE", name: "United Arab Emirates", dial: "971" }, { code: "SA", name: "Saudi Arabia", dial: "966" },
  { code: "IN", name: "India", dial: "91" }, { code: "PK", name: "Pakistan", dial: "92" }, { code: "BD", name: "Bangladesh", dial: "880" },
  { code: "CN", name: "China", dial: "86" }, { code: "PH", name: "Philippines", dial: "63" }, { code: "ID", name: "Indonesia", dial: "62" },
  { code: "BR", name: "Brazil", dial: "55" }, { code: "MX", name: "Mexico", dial: "52" }, { code: "AU", name: "Australia", dial: "61" }
];
const DIALS_LONGEST_FIRST = [...new Set(COUNTRIES.map((c) => c.dial))].sort((a, b) => b.length - a.length);

// "0801 234 5678", "+234 801 234 5678", "2348012345678" and "00234 801 234 5678" (with Nigeria chosen) are ONE number: +2348012345678
function normalizePhone(raw, country) {
  const fail = (message) => ({ ok: false, message });
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return fail("Enter your phone number.");
  if (/[^\d\s+().-]/.test(s)) return fail("A phone number can only contain digits, spaces and +.");
  let plus = s.startsWith("+");
  let d = s.replace(/\D/g, "");
  if (!plus && d.startsWith("00")) { plus = true; d = d.slice(2); }
  const chosen = COUNTRIES.find((c) => c.code === String(country || "NG").toUpperCase()) || COUNTRIES[0];
  if (!plus) {
    // the person may already have typed the country code ("2348012345678") even though a country is chosen
    if (d.startsWith(chosen.dial) && d.length - chosen.dial.length >= 9) { /* already international */ }
    else d = chosen.dial + d.replace(/^0+/, "");   // drop the local "0" in front (0801… -> 801…)
  }
  if (!/^[1-9]\d{7,14}$/.test(d)) return fail("That does not look like a full phone number. Check the digits and the country.");
  if (d.startsWith("234") && !/^234[789]\d{9}$/.test(d)) return fail("Enter a Nigerian mobile number such as 0801 234 5678.");
  const dial = DIALS_LONGEST_FIRST.find((p) => d.startsWith(p)) || "";
  const home = (COUNTRIES.find((c) => c.dial === dial) || {}).code || "";
  return { ok: true, e164: "+" + d, digits: d, dial, country: home };
}

// Two spellings of one number are equal (used to match an advertiser's business phone with a verified Vico Message number).
function samePhone(a, b) {
  const x = normalizePhone(a), y = normalizePhone(b);
  return !!(x.ok && y.ok && x.digits === y.digits);
}

// +2348012345678 -> "+234 ••• ••• 5678"  (what other screens show instead of the full number)
function maskPhone(e164) {
  const d = String(e164 || "").replace(/\D/g, "");
  if (d.length < 8) return "";
  const dial = DIALS_LONGEST_FIRST.find((p) => d.startsWith(p)) || d.slice(0, 3);
  return "+" + dial + " ••• ••• " + d.slice(-4);
}

// ---- one-time code ----
const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const makeSalt = () => crypto.randomBytes(12).toString("hex");
const hashCode = (salt, email, phone, code) =>
  crypto.createHash("sha256").update([salt, String(email).toLowerCase(), phone, String(code).trim()].join(":")).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const CODE_MINUTES = 10;
// The last line "@host #code" is the Web OTP format: Chrome on Android offers the code for one-tap autofill when the page is on that host.
function otpHost(env) {
  env = env || process.env;
  try { return new URL(String(env.APP_URL || "")).hostname; } catch (_) { return ""; }
}
const codeText = (code, env) => {
  const host = otpHost(env);
  return "Your Vico Message code is " + code + ". Do not share it with anyone. It expires in " + CODE_MINUTES + " minutes." + (host ? "\n\n@" + host + " #" + code : "");
};

// ---- SMS providers ----
// INFOBIP_BASE_URL is shown in the Infobip portal as "xxxxx.api.infobip.com" (with or without https://). Only the host is kept, always over https.
// Pasted keys often carry spaces, quotes, "App " or ${...}: keep only the raw key.
function infobipKey(env) {
  return String(env.INFOBIP_API_KEY || "").trim().replace(/^["']|["']$/g, "").replace(/^App\s+/i, "").trim();
}
function infobipHost(env) {
  env = env || process.env;
  const h = String(env.INFOBIP_BASE_URL || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/[\/?#].*$/, "");
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h) && h.indexOf(".") > 0 ? h.toLowerCase() : "";
}
function providerName(env) {
  env = env || process.env;
  const want = String(env.SMS_PROVIDER || "").toLowerCase();
  const infobip = !!(infobipKey(env) && infobipHost(env));
  const termii = !!env.TERMII_API_KEY;
  const twilio = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID));
  if (want === "infobip" && infobip) return "infobip";
  if (want === "termii" && termii) return "termii";
  if (want === "twilio" && twilio) return "twilio";
  if (infobip) return "infobip";
  if (termii) return "termii";
  if (twilio) return "twilio";
  return "none";
}

// The exact HTTP request for a provider (kept separate from sending so it can be checked without a network).
function buildSmsRequest(provider, { to, text }, env) {
  env = env || process.env;
  if (provider === "termii") {
    const base = String(env.TERMII_BASE_URL || "https://api.ng.termii.com").replace(/\/$/, "");
    return { url: base + "/api/sms/send", headers: { "Content-Type": "application/json" },
      data: { to: String(to).replace(/^\+/, ""), from: env.TERMII_SENDER_ID || "Vico", sms: text, type: "plain", channel: env.TERMII_CHANNEL || "generic", api_key: env.TERMII_API_KEY } };
  }
  if (provider === "infobip") {
    // Infobip "Send SMS" API v3: POST https://{baseUrl}/sms/3/messages, header "Authorization: App {apiKey}"
    return { url: "https://" + infobipHost(env) + "/sms/3/messages", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "App " + infobipKey(env) },
      data: { messages: [{ sender: env.INFOBIP_SENDER || "InfoSMS", destinations: [{ to: String(to).replace(/^\+/, "") }], content: { text } }] } };
  }
  if (provider === "twilio") {
    const form = new URLSearchParams({ To: to, Body: text });
    if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID); else form.set("From", env.TWILIO_FROM);
    return { url: "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(env.TWILIO_ACCOUNT_SID) + "/Messages.json",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN).toString("base64") },
      data: form.toString() };
  }
  return null;
}

// Returns { via }.  Throws an Error with .code = "not_configured" | "send_failed".
async function sendSms({ to, text, axios, env, log }) {
  env = env || process.env; log = log || console.log;
  const provider = providerName(env);
  if (provider === "none") {
    if (env.NODE_ENV === "production") { const e = new Error("SMS is not configured"); e.code = "not_configured"; throw e; }
    log("VICO MESSAGE CODE (no SMS provider is set up, development only) for " + to + ": " + text);
    return { via: "console" };
  }
  const rq = buildSmsRequest(provider, { to, text }, env);
  try {
    const r = await (axios || require("axios")).post(rq.url, rq.data, { headers: rq.headers, timeout: 12000 });
    // Termii answers 200 with a message_id on success; Twilio answers 201 with a sid.
    if (provider === "termii" && r.data && r.data.code && String(r.data.code).toLowerCase() !== "ok") throw new Error(String(r.data.message || "Termii refused the message"));
    // Infobip answers 200 with messages[0].status.groupId: 0 accepted, 1 pending (normal), 2 undeliverable, 4 expired, 5 rejected.
    if (provider === "infobip") {
      const m = r.data && Array.isArray(r.data.messages) && r.data.messages[0];
      const g = m && m.status ? Number(m.status.groupId) : NaN;
      if (!m || !Number.isFinite(g)) throw new Error("Infobip gave no message status");
      if (g === 2 || g === 4 || g === 5) throw new Error("Infobip refused the message: " + String((m.status && (m.status.name || m.status.groupName)) || g));
    }
    return { via: provider };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    console.error("VICO MESSAGE SMS ERROR (" + provider + "):", detail);
    const e = new Error("SMS could not be sent"); e.code = "send_failed"; throw e;
  }
}

module.exports = { COUNTRIES, normalizePhone, samePhone, maskPhone, makeCode, makeSalt, hashCode, safeEq, CODE_MINUTES, codeText, otpHost, infobipHost, infobipKey, providerName, buildSmsRequest, sendSms };
