// =====================================================
// Vico Pay Live — VICO AI (secure backend)
// =====================================================
// The AI key stays on the SERVER (.env). The browser only talks to /api/ai/chat; it never sees a key.
//   GROQ_API_KEY    your Groq key (https://console.groq.com/keys). Used when AI_PROVIDER=groq
//   AI_API_KEY       your AI provider key for anthropic / openai (leave both empty and Vico AI shows "not switched on yet")
//   AI_PROVIDER      groq, anthropic (default) or openai  (openai also works with any OpenAI-compatible service via AI_BASE_URL)
//   AI_MODEL         the model name for that provider
//   AI_BASE_URL      optional, only for OpenAI-compatible services
//   AI_DAILY_LIMIT   messages one user may send per day (default 30)
//   AI_MAX_TOKENS    longest answer, in tokens (default 700)
// Vico AI can only READ: it is given a short summary of the signed-in user's OWN ad campaigns. It has no way to spend money,
// publish an ad or change anything, so it can never do those things (they need the normal pages and the user's own click).
// New tables only: ai_conversations, ai_messages, ai_usage.
// =====================================================
const SYSTEM_PROMPT = `You are Vico AI, the official intelligent advertising and business assistant inside Vico Pay Live's Ad Center.

Your responsibility is to help advertisers, businesses, product sellers, creators and companies create better advertisements and understand how to promote their products and services.

You must communicate professionally, clearly and politely.

Help users write advertising captions, create promotional strategies, understand campaign budgets, choose appropriate audiences and interpret advertising analytics.

When helping someone create an advertisement, ask only for information that is necessary.

Always explain the available options in simple language.

Never invent advertising statistics, customer numbers, campaign results, payment confirmations or guaranteed sales.

Use only authorized advertiser information when explaining campaign performance.

Never reveal another user's private information.

Never access or expose secret API keys, payment credentials or administrative secrets.

Never make a payment, spend advertising funds, modify a live campaign or publish an advertisement without the user's explicit confirmation and the appropriate backend authorization.

Follow Vico Pay Live's advertising policies.

If a user requests something prohibited, unsafe, fraudulent or misleading, explain why you cannot assist with that request and offer an appropriate alternative.

Your objective is to help businesses advertise responsibly, improve their marketing and grow through Vico Pay Live.

Extra rules for this chat: you can only talk and suggest; you cannot press buttons, pay, publish or edit anything yourself, so tell the user which page to use (Ad Center to create a campaign, Vico Wallet for money). Money amounts are in Nigerian Naira (₦) unless the user says otherwise. Keep answers short and practical.`;

const WELCOME = "Hello! I'm Vico AI, your personal advertising and business assistant. I can help you create professional advertisements, promote your products, find the right audience, plan your advertising budget and grow your business. What would you like to achieve today?";

// ---- pure helpers (tested) ----
function providerRequest({ provider, model, baseUrl, key, system, messages, maxTokens }) {
  if (provider === "groq") {   // Groq speaks the OpenAI chat format. gpt-oss models "think" first, so keep that short or the answer is cut off.
    const body = { model, max_completion_tokens: maxTokens, messages: [{ role: "system", content: system }].concat(messages) };
    if (/gpt-oss/i.test(model)) body.reasoning_effort = "low";
    return { url: (baseUrl || "https://api.groq.com/openai/v1").replace(/\/+$/, "") + "/chat/completions", headers: { Authorization: "Bearer " + key, "content-type": "application/json" }, body };
  }
  if (provider === "openai") {
    return { url: (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "") + "/chat/completions",
      headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
      body: { model, max_tokens: maxTokens, messages: [{ role: "system", content: system }].concat(messages) } };
  }
  return { url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: { model, max_tokens: maxTokens, system, messages } };
}
function readReply(provider, data) {
  if (provider === "openai" || provider === "groq") {
    const c = data && data.choices && data.choices[0] && data.choices[0].message;
    return { text: String((c && c.content) || "").trim(), input: Number(data && data.usage && data.usage.prompt_tokens) || 0, output: Number(data && data.usage && data.usage.completion_tokens) || 0 };
  }
  const text = [].concat((data && data.content) || []).filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
  return { text, input: Number(data && data.usage && data.usage.input_tokens) || 0, output: Number(data && data.usage && data.usage.output_tokens) || 0 };
}
// the model must see strictly alternating user/assistant turns starting with "user"
function cleanHistory(rows) {
  const out = [];
  for (const r of rows) {
    if (r.role !== "user" && r.role !== "assistant") continue;
    if (out.length && out[out.length - 1].role === r.role) out[out.length - 1].content += "\n" + r.content; else out.push({ role: r.role, content: r.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

module.exports = function makeAi({ app, db, requireAuth, requireAdmin, axios }) {
  const now = () => Date.now();
  const bad = (res, code, msg, extra) => res.status(code).json({ success: false, message: msg, ...(extra || {}) });
  const cfg = () => ({
    provider: ({ groq: "groq", openai: "openai" })[String(process.env.AI_PROVIDER || "anthropic").toLowerCase()] || "anthropic",
    get key() { return String((this.provider === "groq" ? process.env.GROQ_API_KEY || process.env.AI_API_KEY : process.env.AI_API_KEY) || "").trim(); },
    model: String(process.env.AI_MODEL || "").trim(),
    baseUrl: String(process.env.AI_BASE_URL || "").trim(),
    daily: Math.max(1, Number(process.env.AI_DAILY_LIMIT) || 30),
    maxTokens: Math.min(2000, Math.max(100, Number(process.env.AI_MAX_TOKENS) || 700))
  });
  const defaultModel = (c) => c.model || (c.provider === "groq" ? "openai/gpt-oss-20b" : c.provider === "openai" ? "gpt-4o-mini" : "claude-haiku-5-5");

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS ai_conversations (id BIGSERIAL PRIMARY KEY, user_email TEXT NOT NULL, title TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_email, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ai_messages (id BIGSERIAL PRIMARY KEY, conversation_id BIGINT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON ai_messages(conversation_id, id)`,
    `CREATE TABLE IF NOT EXISTS ai_usage (id BIGSERIAL PRIMARY KEY, user_email TEXT NOT NULL, day TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage(user_email, day)`
  ];
  const ready = (async function migrate() {
    const client = await db.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(727278)"); for (const sql of SCHEMA) await client.query(sql); }
    finally { try { await client.query("SELECT pg_advisory_unlock(727278)"); } catch (_) { /* ignore */ } client.release(); }
  })().catch((e) => { console.error("AI MIGRATE ERROR:", e); });

  const today = () => new Date().toISOString().slice(0, 10);
  const busy = new Map();   // one question at a time per user, and a short pause between questions (abuse protection)

  // READ-ONLY summary of the signed-in user's own ad campaigns (the ad tables exist once vico-ads.js has started)
  async function adContext(email) {
    let open = "";
    try {
      const ads = require("./vico-ads"), row = await db.get("SELECT value FROM ad_settings WHERE key = 'activePlacements'");
      const ids = (row ? row.value : "short_videos").split(",").filter((p) => ads.PLACEMENTS[p]);
      open = " Ad placements open right now: " + ids.map((p) => ads.PLACEMENTS[p].label).join(", ") + ". Other placements (Marketplace, Search Results, Discovery, Business Profiles, Creator Videos, Promotions, Events) open in later versions, so only recommend placements that are open now and mention the others as coming later. For example, a shoe seller is best placed in Marketplace, Home Feed and Short Videos once those are open.";
    } catch (_) { /* ad tables not there yet */ }
    try {
      const rows = await db.all("SELECT name, status, ad_type AS \"adType\", budget_ngn AS budget FROM ad_campaigns WHERE owner_email = ? ORDER BY id DESC LIMIT 10", [email]);
      if (!rows.length) return "The user has no ad campaigns yet." + open;
      return "The user's own ad campaigns (newest first; impressions, clicks and spend are not recorded yet because ad delivery has not launched): " +
        rows.map((r) => `"${String(r.name).slice(0, 60)}" (${r.adType}, ${r.status}, budget ₦${Number(r.budget).toLocaleString()})`).join("; ") + "." + open;
    } catch (_) { return ""; }
  }

  app.get("/api/ai/status", async (req, res) => {
    const c = cfg(); res.json({ success: true, enabled: !!c.key, welcome: WELCOME });
  });

  app.post("/api/ai/chat", requireAuth, async (req, res) => {
    const email = req.userEmail;
    try {
      await ready;
      const c = cfg();
      if (!c.key) return bad(res, 503, "Vico AI is not switched on yet. Please try again soon.");
      const text = String((req.body && req.body.message) || "").trim();
      if (!text) return bad(res, 400, "Type a message first.");
      if (text.length > 2000) return bad(res, 400, "That message is too long (2,000 letters at most).");
      const last = busy.get(email);
      if (last && (last.running || now() - last.at < 1500)) return bad(res, 429, "One moment, Vico AI is still answering.");
      const used = await db.get("SELECT COUNT(*) AS n FROM ai_usage WHERE user_email = ? AND day = ?", [email, today()]);
      if (Number(used.n) >= c.daily) return bad(res, 429, "You reached today's Vico AI limit (" + c.daily + " messages). It opens again tomorrow.");
      busy.set(email, { running: true, at: now() });

      let convId = Math.floor(Number(req.body.conversationId));
      if (Number.isFinite(convId) && convId > 0) {
        const own = await db.get("SELECT id FROM ai_conversations WHERE id = ? AND user_email = ?", [convId, email]);   // never someone else's chat
        if (!own) { busy.set(email, { running: false, at: now() }); return bad(res, 404, "Conversation not found."); }
      } else {
        const r = await db.get("INSERT INTO ai_conversations (user_email, title, created_at, updated_at) VALUES (?,?,?,?) RETURNING id", [email, text.slice(0, 60), now(), now()]);
        convId = Number(r.id);
      }
      const hist = await db.all("SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 16", [convId]);
      const messages = cleanHistory(hist.reverse().concat([{ role: "user", content: text }]));
      const ctxWanted = String((req.body && req.body.context) || "") === "ads";
      const system = SYSTEM_PROMPT + "\n\nToday is " + today() + "." + (ctxWanted ? "\n\n" + (await adContext(email)) : "");
      const model = defaultModel(c);
      const rq = providerRequest({ provider: c.provider, model, baseUrl: c.baseUrl, key: c.key, system, messages, maxTokens: c.maxTokens });
      let out;
      try { out = readReply(c.provider, (await axios.post(rq.url, rq.body, { headers: rq.headers, timeout: 45000 })).data); }
      catch (e) {
        console.error("AI PROVIDER ERROR:", e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message);
        busy.set(email, { running: false, at: now() });
        return bad(res, 502, "Vico AI could not answer right now. Please try again in a moment.");
      }
      if (!out.text) { busy.set(email, { running: false, at: now() }); return bad(res, 502, "Vico AI gave an empty answer. Please try again."); }
      const t = now();
      await db.run("INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)", [convId, "user", text, t]);
      await db.run("INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)", [convId, "assistant", out.text, t + 1]);
      await db.run("UPDATE ai_conversations SET updated_at = ? WHERE id = ?", [t, convId]);
      await db.run("INSERT INTO ai_usage (user_email, day, model, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?)", [email, today(), model, out.input, out.output, t]);
      busy.set(email, { running: false, at: now() });
      return res.json({ success: true, conversationId: convId, reply: out.text, remainingToday: Math.max(0, c.daily - Number(used.n) - 1) });
    } catch (e) { busy.set(email, { running: false, at: now() }); console.error("AI CHAT ERROR:", e); return bad(res, 500, "Something went wrong. Please try again."); }
  });

  app.get("/api/ai/conversations", requireAuth, async (req, res) => {
    try { await ready;
      const rows = await db.all("SELECT id, title, updated_at AS \"updatedAt\" FROM ai_conversations WHERE user_email = ? ORDER BY updated_at DESC LIMIT 30", [req.userEmail]);
      res.json({ success: true, conversations: rows.map((r) => ({ id: Number(r.id), title: r.title, updatedAt: Number(r.updatedAt) })) });
    } catch (e) { bad(res, 500, "Could not load your chats."); }
  });
  app.get("/api/ai/conversations/:id", requireAuth, async (req, res) => {
    try { await ready;
      const id = Math.floor(Number(req.params.id));
      const own = Number.isFinite(id) && await db.get("SELECT id FROM ai_conversations WHERE id = ? AND user_email = ?", [id, req.userEmail]);
      if (!own) return bad(res, 404, "Conversation not found.");
      const rows = await db.all("SELECT role, content, created_at AS \"at\" FROM ai_messages WHERE conversation_id = ? ORDER BY id", [id]);
      res.json({ success: true, messages: rows.map((r) => ({ role: r.role, content: r.content, at: Number(r.at) })) });
    } catch (e) { bad(res, 500, "Could not load that chat."); }
  });

  // admin: AI usage and cost monitoring (tokens per day and per model)
  app.get("/api/admin/ai/usage", requireAdmin, async (req, res) => {
    try { await ready;
      const days = await db.all("SELECT day, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM ai_usage GROUP BY day, model ORDER BY day DESC LIMIT 60");
      const top = await db.all("SELECT user_email AS email, COUNT(*) AS calls FROM ai_usage WHERE day = ? GROUP BY user_email ORDER BY calls DESC LIMIT 10", [today()]);
      const c = cfg();
      res.json({ success: true, enabled: !!c.key, provider: c.provider, model: defaultModel(c), dailyLimit: c.daily,
        days: days.map((d) => ({ day: d.day, model: d.model, calls: Number(d.calls), input: Number(d.input), output: Number(d.output) })), topToday: top.map((t) => ({ email: t.email, calls: Number(t.calls) })) });
    } catch (e) { bad(res, 500, "Could not load AI usage."); }
  });
  return { ready };
};
module.exports.providerRequest = providerRequest;
module.exports.readReply = readReply;
module.exports.cleanHistory = cleanHistory;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
