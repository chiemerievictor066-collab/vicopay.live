// =====================================================
// VicoPay Live — Help Center support tickets
//   Public:    GET  /api/support/config                    -> support email / WhatsApp shown on the Help Center
//   Signed in: POST /api/support/tickets                   -> open a ticket
//              GET  /api/support/tickets                   -> my tickets
//              GET  /api/support/tickets/:id               -> one ticket with its messages (only the owner)
//              POST /api/support/tickets/:id/reply         -> add a message
//              POST /api/support/tickets/:id/close         -> close it
//   Admin:     GET  /api/admin/support/tickets?status=     -> all tickets (x-admin-key header)
//              GET  /api/admin/support/tickets/:id
//              POST /api/admin/support/tickets/:id/reply   -> answer (the user gets a notification)
//              POST /api/admin/support/tickets/:id/status  -> open / answered / resolved / closed
// =====================================================
module.exports = function (ctx) {
  const { app, db, requireAuth, requireAdmin } = ctx;
  const lc = (v) => String(v || "").toLowerCase();
  const ok = (res, extra) => res.json({ success: true, ...(extra || {}) });
  const fail = (res, code, message) => res.status(code).json({ success: false, message });

  const CATEGORIES = ["payments", "coins", "live", "gifts", "withdrawals", "fanclub", "forex", "account", "safety", "bug", "other"];
  const STATUSES = ["open", "answered", "resolved", "closed"];
  const LIMITS = { subjectMin: 3, subjectMax: 120, bodyMin: 10, bodyMax: 2000, perHour: 5, openMax: 15, repliesPerHourPerTicket: 12 };

  const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n);
  const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };

  const notify = (email, text, link) =>
    db.run("INSERT INTO notifications (user_id, text, link, created_at) VALUES (?,?,?,?)", [lc(email), String(text).slice(0, 200), link || null, Date.now()]).catch(() => {});

  const ticketOut = (t) => ({
    id: Number(t.id), category: t.category, subject: t.subject, status: t.status, reference: t.reference || "",
    createdAt: Number(t.created_at), updatedAt: Number(t.updated_at), lastFrom: t.last_from, unread: Number(t.user_unread) === 1
  });
  const messageOut = (m) => ({ id: Number(m.id), from: m.sender, body: m.body, at: Number(m.created_at) });

  async function ownTicket(req, res) {
    const id = idOf(req); if (!id) { fail(res, 400, "Invalid ticket."); return null; }
    const t = await db.get("SELECT * FROM support_tickets WHERE id = ? AND email = ?", [id, lc(req.userEmail)]);
    if (!t) { fail(res, 404, "Ticket not found."); return null; }
    return t;
  }

  // ---------- public ----------
  app.get("/api/support/config", (req, res) => {
    ok(res, {
      email: process.env.SUPPORT_EMAIL || "",
      whatsapp: String(process.env.SUPPORT_WHATSAPP || "").replace(/[^\d]/g, ""),
      replyTime: process.env.SUPPORT_REPLY_TIME || "",
      categories: CATEGORIES
    });
  });

  // ---------- users ----------
  app.post("/api/support/tickets", requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const category = clean(b.category, 20).toLowerCase(), subject = clean(b.subject, LIMITS.subjectMax), body = clean(b.message, LIMITS.bodyMax);
      if (!CATEGORIES.includes(category)) return fail(res, 400, "Please choose what your question is about.");
      if (subject.length < LIMITS.subjectMin) return fail(res, 400, "Please add a short title (at least " + LIMITS.subjectMin + " characters).");
      if (body.length < LIMITS.bodyMin) return fail(res, 400, "Please describe the problem in a little more detail (at least " + LIMITS.bodyMin + " characters).");
      const email = lc(req.userEmail), now = Date.now();

      const recent = await db.get("SELECT COUNT(*) AS n FROM support_tickets WHERE email = ? AND created_at > ?", [email, now - 3600000]);
      if (Number(recent && recent.n) >= LIMITS.perHour) return fail(res, 429, "You have sent several tickets in the last hour. Please wait a little, or add to a ticket you already have.");
      const open = await db.get("SELECT COUNT(*) AS n FROM support_tickets WHERE email = ? AND status IN ('open','answered')", [email]);
      if (Number(open && open.n) >= LIMITS.openMax) return fail(res, 429, "You already have many open tickets. Please close the ones that are solved first.");

      const id = await db.tx(async (t) => {
        const row = await t.get(
          "INSERT INTO support_tickets (email, category, subject, status, reference, page, user_agent, created_at, updated_at, last_from, user_unread) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
          [email, category, subject, "open", clean(b.reference, 80), clean(b.page, 80), clean(req.headers["user-agent"], 200), now, now, "user", 0]);
        await t.run("INSERT INTO support_messages (ticket_id, sender, body, created_at) VALUES (?,?,?,?)", [row.id, "user", body, now]);
        return Number(row.id);
      });
      ok(res, { ticketId: id, message: "Ticket #" + id + " was sent. We will reply here and send you a notification." });
    } catch (e) { console.error("support create:", e.message); fail(res, 500, "Could not send your ticket. Please try again."); }
  });

  app.get("/api/support/tickets", requireAuth, async (req, res) => {
    try {
      const rows = await db.all("SELECT * FROM support_tickets WHERE email = ? ORDER BY updated_at DESC LIMIT 30", [lc(req.userEmail)]);
      ok(res, { tickets: rows.map(ticketOut) });
    } catch (e) { console.error("support list:", e.message); fail(res, 500, "Could not load your tickets."); }
  });

  app.get("/api/support/tickets/:id", requireAuth, async (req, res) => {
    try {
      const t = await ownTicket(req, res); if (!t) return;
      const msgs = await db.all("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC LIMIT 200", [t.id]);
      if (Number(t.user_unread) === 1) await db.run("UPDATE support_tickets SET user_unread = 0 WHERE id = ?", [t.id]);
      ok(res, { ticket: { ...ticketOut(t), unread: false }, messages: msgs.map(messageOut) });
    } catch (e) { console.error("support get:", e.message); fail(res, 500, "Could not load the ticket."); }
  });

  app.post("/api/support/tickets/:id/reply", requireAuth, async (req, res) => {
    try {
      const t = await ownTicket(req, res); if (!t) return;
      const body = clean(req.body && req.body.message, LIMITS.bodyMax);
      if (body.length < 2) return fail(res, 400, "Please write a message.");
      const recent = await db.get("SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id = ? AND sender = 'user' AND created_at > ?", [t.id, Date.now() - 3600000]);
      if (Number(recent && recent.n) >= LIMITS.repliesPerHourPerTicket) return fail(res, 429, "Please wait a little before sending more messages on this ticket.");
      const now = Date.now();
      await db.tx(async (tx) => {
        await tx.run("INSERT INTO support_messages (ticket_id, sender, body, created_at) VALUES (?,?,?,?)", [t.id, "user", body, now]);
        await tx.run("UPDATE support_tickets SET status = 'open', last_from = 'user', updated_at = ? WHERE id = ?", [now, t.id]);
      });
      ok(res, {});
    } catch (e) { console.error("support reply:", e.message); fail(res, 500, "Could not send your message."); }
  });

  app.post("/api/support/tickets/:id/close", requireAuth, async (req, res) => {
    try {
      const t = await ownTicket(req, res); if (!t) return;
      await db.run("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ?", [Date.now(), t.id]);
      ok(res, {});
    } catch (e) { console.error("support close:", e.message); fail(res, 500, "Could not close the ticket."); }
  });

  // ---------- admin ----------
  app.get("/api/admin/support/tickets", requireAdmin, async (req, res) => {
    try {
      const st = String(req.query.status || "active");
      let where = "status IN ('open','answered')", args = [];
      if (STATUSES.includes(st)) { where = "status = ?"; args = [st]; } else if (st === "all") where = "1=1";
      const rows = await db.all("SELECT * FROM support_tickets WHERE " + where + " ORDER BY (CASE WHEN last_from = 'user' THEN 0 ELSE 1 END), updated_at DESC LIMIT 200", args);
      ok(res, { tickets: rows.map((t) => ({ ...ticketOut(t), email: t.email })) });
    } catch (e) { console.error("admin support list:", e.message); fail(res, 500, "Could not load tickets."); }
  });

  app.get("/api/admin/support/tickets/:id", requireAdmin, async (req, res) => {
    try {
      const id = idOf(req); if (!id) return fail(res, 400, "Invalid ticket.");
      const t = await db.get("SELECT * FROM support_tickets WHERE id = ?", [id]); if (!t) return fail(res, 404, "Ticket not found.");
      const msgs = await db.all("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC LIMIT 200", [id]);
      ok(res, { ticket: { ...ticketOut(t), email: t.email, page: t.page || "", userAgent: t.user_agent || "" }, messages: msgs.map(messageOut) });
    } catch (e) { console.error("admin support get:", e.message); fail(res, 500, "Could not load the ticket."); }
  });

  app.post("/api/admin/support/tickets/:id/reply", requireAdmin, async (req, res) => {
    try {
      const id = idOf(req); if (!id) return fail(res, 400, "Invalid ticket.");
      const t = await db.get("SELECT * FROM support_tickets WHERE id = ?", [id]); if (!t) return fail(res, 404, "Ticket not found.");
      const body = clean(req.body && req.body.body, LIMITS.bodyMax); if (body.length < 2) return fail(res, 400, "Write a reply first.");
      const status = STATUSES.includes(String(req.body && req.body.status)) ? String(req.body.status) : "answered";
      const now = Date.now();
      await db.tx(async (tx) => {
        await tx.run("INSERT INTO support_messages (ticket_id, sender, body, created_at) VALUES (?,?,?,?)", [id, "support", body, now]);
        await tx.run("UPDATE support_tickets SET status = ?, last_from = 'support', user_unread = 1, updated_at = ? WHERE id = ?", [status, now, id]);
      });
      await notify(t.email, "Support replied to your ticket #" + id, "help-center.html#ticket-" + id);
      ok(res, {});
    } catch (e) { console.error("admin support reply:", e.message); fail(res, 500, "Could not send the reply."); }
  });

  app.post("/api/admin/support/tickets/:id/status", requireAdmin, async (req, res) => {
    try {
      const id = idOf(req); const status = String(req.body && req.body.status || "");
      if (!id || !STATUSES.includes(status)) return fail(res, 400, "Send a valid status.");
      await db.run("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?", [status, Date.now(), id]);
      ok(res, {});
    } catch (e) { console.error("admin support status:", e.message); fail(res, 500, "Could not change the status."); }
  });

  return { CATEGORIES, STATUSES };
};
