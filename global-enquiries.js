// Vico Pay Global Enquiries + Paystack invoice billing.
module.exports = function ({ app, db, axios, requireAdmin }) {
  const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
  const fail = (res, code, message) => res.status(code).json({ success: false, message });
  const ref = () => "VGE-" + require("crypto").randomBytes(6).toString("hex").toUpperCase();
  async function migrate() {
    await db.run(`CREATE TABLE IF NOT EXISTS global_enquiries (
      id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
      phone TEXT, organisation TEXT, organisation_type TEXT NOT NULL, country TEXT NOT NULL,
      category TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, budget TEXT,
      status TEXT NOT NULL DEFAULT 'new', admin_reply TEXT, replied_at BIGINT,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_global_enquiries_status ON global_enquiries(status, created_at DESC)`);
    await db.run(`CREATE TABLE IF NOT EXISTS global_invoices (
      id BIGSERIAL PRIMARY KEY, enquiry_id BIGINT REFERENCES global_enquiries(id),
      invoice_number TEXT, paystack_request_code TEXT UNIQUE, paystack_request_id TEXT,
      customer_email TEXT NOT NULL, description TEXT NOT NULL, amount_kobo BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'NGN', status TEXT NOT NULL DEFAULT 'pending',
      pdf_url TEXT, offline_reference TEXT, created_at BIGINT NOT NULL, paid_at BIGINT)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_global_invoices_enquiry ON global_invoices(enquiry_id)`);
  }
  app.post("/api/global-enquiries", async (req, res) => {
    try {
      const b = req.body || {};
      const v = {
        name: clean(b.name, 100), email: clean(b.email, 180).toLowerCase(),
        phone: clean(b.phone, 40), organisation: clean(b.organisation, 140),
        organisation_type: clean(b.organisationType, 40), country: clean(b.country, 80),
        category: clean(b.category, 60), subject: clean(b.subject, 140),
        message: clean(b.message, 4000), budget: clean(b.budget, 80)
      };
      if (v.name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ||
          !v.organisation_type || !v.country || !v.category || v.subject.length < 4 || v.message.length < 20) {
        return fail(res, 400, "Please complete the required fields and provide a valid email address and a detailed enquiry.");
      }
      const ip = String(req.ip || "").slice(0, 80);
      const recent = await db.get("SELECT COUNT(*) AS n FROM global_enquiries WHERE created_at > ? AND email = ?", [Date.now()-3600000, v.email]);
      if (Number(recent?.n || 0) >= 4) return fail(res, 429, "You have sent several enquiries recently. Please try again later.");
      const now = Date.now(), reference = ref();
      await db.run(`INSERT INTO global_enquiries
        (reference,name,email,phone,organisation,organisation_type,country,category,subject,message,budget,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [reference,v.name,v.email,v.phone,v.organisation,v.organisation_type,v.country,v.category,v.subject,v.message,v.budget,"new",now,now]);
      return res.status(201).json({ success:true, reference, message:"Your enquiry has been sent to Vico Pay. Keep your reference number to check for a response." });
    } catch (e) { console.error("Global enquiry submit:", e.message); return fail(res,500,"We could not submit your enquiry. Please try again."); }
  });
  app.get("/api/global-enquiries/status/:reference", async (req,res) => {
    const reference = clean(req.params.reference, 30).toUpperCase();
    const email = clean(req.query.email,180).toLowerCase();
    if (!email) return fail(res,400,"Enter the email address used for the enquiry.");
    const row = await db.get("SELECT reference,subject,status,admin_reply,created_at,replied_at FROM global_enquiries WHERE reference=? AND email=?",[reference,email]);
    if (!row) return fail(res,404,"We could not find an enquiry matching those details.");
    res.json({success:true,enquiry:{reference:row.reference,subject:row.subject,status:row.status,reply:row.admin_reply||"",createdAt:row.created_at,repliedAt:row.replied_at}});
  });
  app.get("/api/admin/global-enquiries", requireAdmin, async (req,res) => {
    const status = clean(req.query.status,20);
    const rows = await db.all(`SELECT e.*, (SELECT COUNT(*) FROM global_invoices i WHERE i.enquiry_id=e.id) AS invoice_count
      FROM global_enquiries e ${["new","reviewing","awaiting_customer","quoted","closed"].includes(status)?"WHERE e.status = ?":""}
      ORDER BY e.created_at DESC LIMIT 300`, ["new","reviewing","awaiting_customer","quoted","closed"].includes(status)?[status]:[]);
    res.json({success:true,enquiries:rows});
  });
  app.post("/api/admin/global-enquiries/:id/reply", requireAdmin, async (req,res) => {
    const id=Number(req.params.id), reply=clean(req.body?.reply,4000), status=clean(req.body?.status,30);
    if(!Number.isInteger(id)||id<1||reply.length<3) return fail(res,400,"Enter a response.");
    const allowed=["reviewing","awaiting_customer","quoted","closed"];
    const next=allowed.includes(status)?status:"awaiting_customer";
    const row=await db.get("SELECT * FROM global_enquiries WHERE id=?",[id]);
    if(!row) return fail(res,404,"Enquiry not found.");
    const now=Date.now();
    await db.run("UPDATE global_enquiries SET admin_reply=?,status=?,replied_at=?,updated_at=? WHERE id=?",[reply,next,now,now,id]);
    if(process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
      try {
        await axios.post("https://api.resend.com/emails",{from:process.env.MAIL_FROM,to:[row.email],subject:"Vico Pay response to enquiry "+row.reference,
          html:`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172554"><h2>Vico Pay</h2><p>Hello ${row.name.replace(/[<>&"]/g,"")},</p><p>Our team has responded to your enquiry <b>${row.reference}</b> — ${row.subject.replace(/[<>&"]/g,"")}.</p><div style="padding:18px;background:#eff6ff;border-radius:12px;white-space:pre-wrap">${reply.replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]))}</div><p>Reply to this email if you need further assistance.</p></div>`},
          {headers:{Authorization:"Bearer "+process.env.RESEND_API_KEY}});
      } catch(e) { console.error("Enquiry reply email:",e.message); }
    }
    res.json({success:true,message:"Response saved. Email delivery was attempted if Resend is configured."});
  });
  app.post("/api/admin/global-enquiries/:id/invoice", requireAdmin, async (req,res) => {
    try {
      const id=Number(req.params.id), b=req.body||{}, amount=Math.round(Number(b.amountNgn)*100);
      const description=clean(b.description,180), dueDate=clean(b.dueDate,30);
      if(!Number.isInteger(id)||id<1||!Number.isSafeInteger(amount)||amount<100 || amount>100000000000 || description.length<3)
        return fail(res,400,"Enter a valid invoice amount (at least ₦1) and description.");
      const enquiry=await db.get("SELECT * FROM global_enquiries WHERE id=?",[id]);
      if(!enquiry) return fail(res,404,"Enquiry not found.");
      const secret=process.env.PAYSTACK_SECRET_KEY;
      if(!secret) return fail(res,503,"Paystack is not configured on the server.");
      const headers={Authorization:"Bearer "+secret,"Content-Type":"application/json"};
      let customerCode = "";
      try {
        const customer=await axios.post("https://api.paystack.co/customer",{email:enquiry.email,first_name:enquiry.name.split(" ")[0],last_name:enquiry.name.split(" ").slice(1).join(" "),phone:enquiry.phone||undefined},{headers});
        if(customer.data?.status) customerCode=customer.data.data.customer_code;
      } catch (customerError) {
        // The email may already belong to a Paystack customer; look it up before failing.
        const existing=await axios.get("https://api.paystack.co/customer",{headers,params:{email:enquiry.email}});
        const found=(existing.data?.data||[]).find(c=>String(c.email||"").toLowerCase()===enquiry.email);
        if(found) customerCode=found.customer_code;
        else throw customerError;
      }
      if(!customerCode) return fail(res,502,"Paystack could not create or find the customer record.");
      const payload={customer:customerCode,description,line_items:[{name:description,amount,quantity:1}],currency:"NGN",send_notification:true,has_invoice:true,
        redirect_url:(process.env.APP_URL||"https://vicopay.live")+"/global-enquiry.html?invoice=success"};
      if(dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) payload.due_date=dueDate+"T23:59:59.000Z";
      const created=await axios.post("https://api.paystack.co/paymentrequest",payload,{headers});
      const d=created.data?.data;
      if(!created.data?.status||!d?.request_code) return fail(res,502,"Paystack did not return a valid invoice.");
      const now=Date.now();
      const saved=await db.get(`INSERT INTO global_invoices(enquiry_id,invoice_number,paystack_request_code,paystack_request_id,customer_email,description,amount_kobo,currency,status,pdf_url,offline_reference,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [id,String(d.invoice_number||""),d.request_code,String(d.id||""),enquiry.email,description,amount,"NGN",d.status||"pending",d.pdf_url||null,d.offline_reference||null,now]);
      await db.run("UPDATE global_enquiries SET status='quoted',updated_at=? WHERE id=?",[now,id]);
      res.status(201).json({success:true,invoice:{id:saved.id,invoiceNumber:d.invoice_number||"",requestCode:d.request_code,amountNgn:amount/100,status:d.status||"pending",pdfUrl:d.pdf_url||"",offlineReference:d.offline_reference||""},message:"Paystack invoice created and email notification requested."});
    } catch(e) { console.error("Create Paystack invoice:",e.response?.data||e.message); return fail(res,502,e.response?.data?.message||"Unable to create the Paystack invoice."); }
  });
  async function handleInvoiceWebhook(event) {
    if(event?.event!=="paymentrequest.success") return false;
    const d=event.data||{}, code=d.request_code||d.requestCode;
    if(!code) return false;
    await db.run("UPDATE global_invoices SET status='success',paid_at=? WHERE paystack_request_code=?",[Date.now(),code]);
    return true;
  }
  return { migrate, handleInvoiceWebhook };
};
