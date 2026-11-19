// Vico Pay Live — free-first company / national organisation verification.
// This module does NOT claim to verify government records. CAC checks are recorded as manual
// official-source checks until Vico obtains an authorised registry API/data agreement.
const crypto = require('crypto');
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const TYPES = new Set(['cac_certificate','cac_status_report','business_address','tin_document','authorisation_letter','ownership_declaration','government_establishment_proof','official_letter','other']);

module.exports = function registerCompanyVerification({ app, db, requireAuth, requireAdmin }) {
  let schemaPromise;
  function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      await db.run(`CREATE TABLE IF NOT EXISTS company_verification_applications (
        id TEXT PRIMARY KEY, order_id BIGINT, applicant_email TEXT NOT NULL, organisation_type TEXT NOT NULL,
        legal_name TEXT NOT NULL, registration_number TEXT, tin TEXT, address TEXT NOT NULL,
        business_email TEXT, business_phone TEXT, website TEXT, representative_name TEXT NOT NULL,
        representative_role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted',
        risk_level TEXT NOT NULL DEFAULT 'review', checks_json TEXT NOT NULL DEFAULT '{}',
        admin_note TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
      )`);
      await db.run(`ALTER TABLE company_verification_applications ADD COLUMN IF NOT EXISTS order_id BIGINT`);
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_company_verification_order_unique ON company_verification_applications(order_id) WHERE order_id IS NOT NULL`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_company_verification_status ON company_verification_applications(status, created_at DESC)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_company_verification_applicant ON company_verification_applications(applicant_email, created_at DESC)`);
      await db.run(`CREATE TABLE IF NOT EXISTS company_verification_documents (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES company_verification_applications(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
        byte_size BIGINT NOT NULL, sha256 TEXT NOT NULL, file_data BYTEA NOT NULL, file_iv TEXT, file_tag TEXT,
        inspection_json TEXT NOT NULL DEFAULT '{}', created_at BIGINT NOT NULL
      )`);
      await db.run(`ALTER TABLE company_verification_documents ADD COLUMN IF NOT EXISTS file_iv TEXT`);
      await db.run(`ALTER TABLE company_verification_documents ADD COLUMN IF NOT EXISTS file_tag TEXT`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_company_verification_docs_app ON company_verification_documents(application_id)`);
      await db.run(`CREATE TABLE IF NOT EXISTS company_verification_audit (
        id BIGSERIAL PRIMARY KEY, application_id TEXT NOT NULL REFERENCES company_verification_applications(id) ON DELETE CASCADE,
        actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT, created_at BIGINT NOT NULL
      )`);
    })();
    return schemaPromise;
  }
  const clean = (v, n=500) => String(v || '').trim().slice(0,n);
  function organisationDocKey() {
    const seed=String(process.env.ID_DOC_KEY||'').trim();
    if(!seed) return null;
    return crypto.createHash('sha256').update('VicoPayLive:organisation-documents:v1:').update(seed).digest();
  }
  function encryptDocument(key, buf) {
    const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(buf),cipher.final()]);
    return { encrypted, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64') };
  }
  function decryptDocument(key, row) {
    if(!row.file_iv || !row.file_tag) return row.file_data; // legacy records created before encryption was added
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(row.file_iv,'base64'));
    decipher.setAuthTag(Buffer.from(row.file_tag,'base64'));
    return Buffer.concat([decipher.update(row.file_data),decipher.final()]);
  }
  const parseChecks = (s) => { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } };
  function inspectFile(mime, buf) {
    let actual = 'unknown';
    if (buf.subarray(0,5).toString() === '%PDF-') actual = 'application/pdf';
    else if (buf.length >= 3 && buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff) actual = 'image/jpeg';
    else if (buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) actual = 'image/png';
    const flags = [];
    if (actual === 'unknown') flags.push('File signature not recognised');
    if (actual !== 'unknown' && actual !== mime) flags.push('Declared file type does not match file signature');
    return { signatureType: actual, flags, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length,
      result: flags.length ? 'needs_review' : 'basic_file_checks_passed', note: 'File signature and hash checks are not proof that a document is genuine.' };
  }
  function riskFor(data, docs) {
    const flags=[];
    if (data.organisation_type === 'company' && !data.registration_number) flags.push('Company registration number missing');
    const needed = data.organisation_type === 'company' ? ['cac_certificate','cac_status_report','business_address','authorisation_letter','ownership_declaration'] : ['government_establishment_proof','official_letter','authorisation_letter'];
    const present = new Set(docs.map(d=>d.document_type));
    const missing = needed.filter(x=>!present.has(x));
    if (missing.length) flags.push('Required evidence missing: '+missing.join(', '));
    for (const d of docs) if (d.inspection.flags.length) flags.push(d.original_name+': '+d.inspection.flags.join('; '));
    return { level: flags.length ? 'review' : 'pending_external_check', flags, missing };
  }
  app.post('/api/company-verification/applications', requireAuth, async (req,res) => {
    await ensureSchema();
    try {
      const b=req.body||{}, orderId=Number(b.orderId);
      if (!Number.isSafeInteger(orderId) || orderId < 1) return res.status(400).json({success:false,message:'Your paid advert order could not be identified. Please return to your advert page.'});
      const order=await db.get("SELECT id,tier,job,status FROM ad_job_orders WHERE id=? AND user_email=?",[orderId,req.userEmail]);
      if(!order || !['paid','profile_saved','verified'].includes(order.status)) return res.status(403).json({success:false,message:'A confirmed paid advert is required before organisation verification.'});
      if(!['big-business','company','national'].includes(order.tier)) return res.status(403).json({success:false,message:'Organisation verification is only for Big Business, Company and National adverts.'});
      const profile=await db.get("SELECT complete,address,country,city,business_name FROM ad_job_profiles WHERE order_id=?",[orderId]);
      if(!profile || !Number(profile.complete) || !profile.address || !profile.city || !profile.country) return res.status(400).json({success:false,message:'Finish your advert details and location first.'});
      const expectedType=order.tier==='national'?'government':'company';
      const organisationType=clean(b.organisationType,30);
      if(organisationType!==expectedType) return res.status(400).json({success:false,message:expectedType==='government'?'This National advert requires national organisation verification.':'This advert requires company verification.'});
      const data={organisation_type:organisationType,legal_name:clean(b.legalName,180),registration_number:clean(b.registrationNumber,80),tin:clean(b.tin,80),address:clean(b.address,500),business_email:clean(b.businessEmail,180),business_phone:clean(b.businessPhone,60),website:clean(b.website,250),representative_name:clean(b.representativeName,180),representative_role:clean(b.representativeRole,120)};
      if (!data.legal_name || !data.address || !data.representative_name || !data.representative_role) return res.status(400).json({success:false,message:'Legal name, registered address and authorised representative details are required.'});
      if (organisationType==='company' && !data.registration_number) return res.status(400).json({success:false,message:'CAC registration number is required.'});
      const docKey=organisationDocKey();
      if(!docKey) return res.status(503).json({success:false,message:'Secure document storage is not configured. Set ID_DOC_KEY on the server before accepting organisation documents.'});
      const incoming=Array.isArray(b.documents)?b.documents:[]; if(incoming.length>10) return res.status(400).json({success:false,message:'Maximum 10 documents per application.'});
      const docs=[]; let totalBytes=0;
      for(const f of incoming){
        const type=clean(f.documentType,60), mime=clean(f.mimeType,80), name=clean(f.fileName,180)||'document';
        if(!TYPES.has(type)) return res.status(400).json({success:false,message:'Unsupported document category.'});
        if(!ALLOWED.has(mime)) return res.status(400).json({success:false,message:'Only PDF, JPG and PNG documents are accepted.'});
        const raw=String(f.dataBase64||'').replace(/^data:[^;]+;base64,/,'');
        if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return res.status(400).json({success:false,message:'Invalid document encoding.'});
        const buf=Buffer.from(raw,'base64'); totalBytes+=buf.length;
        if(!buf.length||buf.length>2*1024*1024) return res.status(400).json({success:false,message:'Each document must be no larger than 2 MB.'});
        if(totalBytes>4*1024*1024) return res.status(400).json({success:false,message:'Keep all uploaded documents together below 4 MB. You can upload clearer, smaller scans or PDFs.'});
        const inspection=inspectFile(mime,buf); docs.push({id:crypto.randomUUID(),type,name,mime,buf,inspection});
      }
      const needed=organisationType==='company'
        ? ['cac_certificate','cac_status_report','business_address','authorisation_letter','ownership_declaration']
        : ['government_establishment_proof','official_letter','authorisation_letter'];
      const present=new Set(docs.map(d=>d.type)), missing=needed.filter(x=>!present.has(x));
      if(missing.length) return res.status(400).json({success:false,message:'Please upload all required documents: '+missing.join(', ').replaceAll('_',' ')+'.'});
      const id=crypto.randomUUID(), now=Date.now(), risk=riskFor(data,docs);
      const previous=await db.get("SELECT id,status FROM company_verification_applications WHERE order_id=?",[orderId]);
      if(previous && !["rejected","more_documents_required"].includes(previous.status)) return res.status(409).json({success:false,message:"This organisation application is already submitted or approved. Wait for Vico's review decision before changing documents."});
      const applicationId=previous?previous.id:id;
      await db.tx(async tx=>{
        if(previous){
          await tx.run(`UPDATE company_verification_applications SET applicant_email=?,organisation_type=?,legal_name=?,registration_number=?,tin=?,address=?,business_email=?,business_phone=?,website=?,representative_name=?,representative_role=?,status='submitted',risk_level=?,checks_json=?,admin_note=NULL,updated_at=? WHERE id=?`,
            [req.userEmail,data.organisation_type,data.legal_name,data.registration_number,data.tin,data.address,data.business_email,data.business_phone,data.website,data.representative_name,data.representative_role,risk.level,JSON.stringify({automated_file_review:'completed',cac_registry:'not_connected_manual_check_required',nin_identity:'not_connected_not_verified',risk}),now,applicationId]);
          await tx.run("DELETE FROM company_verification_documents WHERE application_id=?",[applicationId]);
        } else {
          await tx.run(`INSERT INTO company_verification_applications (id,order_id,applicant_email,organisation_type,legal_name,registration_number,tin,address,business_email,business_phone,website,representative_name,representative_role,status,risk_level,checks_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [applicationId,orderId,req.userEmail,data.organisation_type,data.legal_name,data.registration_number,data.tin,data.address,data.business_email,data.business_phone,data.website,data.representative_name,data.representative_role,'submitted',risk.level,JSON.stringify({automated_file_review:'completed',cac_registry:'not_connected_manual_check_required',nin_identity:'not_connected_not_verified',risk}),now,now]);
        }
        for(const d of docs) {
          const enc=encryptDocument(docKey,d.buf);
          await tx.run(`INSERT INTO company_verification_documents (id,application_id,document_type,original_name,mime_type,byte_size,sha256,file_data,file_iv,file_tag,inspection_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[d.id,applicationId,d.type,d.name,d.mime,d.buf.length,d.inspection.sha256,enc.encrypted,enc.iv,enc.tag,JSON.stringify(d.inspection),now]);
        }
        await tx.run(`INSERT INTO company_verification_audit (application_id,actor,action,details,created_at) VALUES (?,?,?,?,?)`,[applicationId,req.userEmail,previous?'documents_resubmitted':'application_submitted',JSON.stringify({orderId,documents:docs.length,risk}),now]);
      });
      res.status(201).json({success:true,applicationId,orderId,status:'submitted',risk,message:'Organisation documents received. Vico will review the documents and check the official registry or government source.'});
    } catch(e){ console.error('COMPANY VERIFICATION SUBMIT:',e.message); res.status(500).json({success:false,message:'Could not submit verification application.'}); }
  });
  app.get('/api/company-verification/my-applications', requireAuth, async(req,res)=>{ await ensureSchema(); const rows=await db.all('SELECT id,order_id,organisation_type,legal_name,status,risk_level,created_at,updated_at FROM company_verification_applications WHERE applicant_email=? ORDER BY created_at DESC LIMIT 50',[req.userEmail]); res.json({success:true,applications:rows}); });
  app.get('/api/admin/company-verification', requireAdmin, async(req,res)=>{ await ensureSchema(); const rows=await db.all(`SELECT a.id,a.order_id,a.organisation_type,a.legal_name,a.registration_number,a.applicant_email,a.status,a.risk_level,a.created_at,a.updated_at,o.tier AS advert_tier,o.job AS advert_job,(SELECT COUNT(*) FROM company_verification_documents d WHERE d.application_id=a.id) AS document_count FROM company_verification_applications a LEFT JOIN ad_job_orders o ON o.id=a.order_id ORDER BY a.created_at DESC LIMIT 200`); res.json({success:true,applications:rows}); });
  app.get('/api/admin/company-verification/:id', requireAdmin, async(req,res)=>{ await ensureSchema(); const a=await db.get('SELECT * FROM company_verification_applications WHERE id=?',[req.params.id]); if(!a)return res.status(404).json({success:false,message:'Application not found.'}); const docs=await db.all('SELECT id,document_type,original_name,mime_type,byte_size,sha256,inspection_json,created_at FROM company_verification_documents WHERE application_id=? ORDER BY created_at',[a.id]); const audit=await db.all('SELECT actor,action,details,created_at FROM company_verification_audit WHERE application_id=? ORDER BY created_at DESC',[a.id]); res.json({success:true,application:{...a,checks:parseChecks(a.checks_json)},documents:docs.map(d=>({...d,inspection:parseChecks(d.inspection_json)})),audit}); });
  app.get('/api/admin/company-verification/:id/documents/:docId', requireAdmin, async(req,res)=>{ await ensureSchema(); const d=await db.get('SELECT original_name,mime_type,file_data,file_iv,file_tag FROM company_verification_documents WHERE id=? AND application_id=?',[req.params.docId,req.params.id]); if(!d)return res.status(404).json({success:false,message:'Document not found.'}); try { const key=organisationDocKey(); const bytes=d.file_iv ? (key ? decryptDocument(key,d) : null) : d.file_data; if(!bytes)return res.status(503).json({success:false,message:'Document decryption key is unavailable.'}); res.setHeader('Content-Type',d.mime_type); res.setHeader('Content-Disposition',`attachment; filename="${String(d.original_name).replace(/["\\\r\n]/g,'_')}"`); res.setHeader('Cache-Control','no-store'); res.send(bytes); } catch(e) { return res.status(500).json({success:false,message:'Could not decrypt this document. Check the server ID_DOC_KEY.'}); } });
  app.post('/api/admin/company-verification/:id/review', requireAdmin, async(req,res)=>{
    await ensureSchema();
    const status=clean(req.body&&req.body.status,40), note=clean(req.body&&req.body.note,2000), allowed=new Set(['under_review','more_documents_required','verified','rejected','suspended']);
    if(!allowed.has(status))return res.status(400).json({success:false,message:'Invalid review status.'});
    const application=await db.get('SELECT id,order_id,checks_json FROM company_verification_applications WHERE id=?',[req.params.id]);
    if(!application)return res.status(404).json({success:false,message:'Application not found.'});
    if(status==='verified'){
      const checks=parseChecks(application.checks_json);
      if(!checks.official_registry || checks.official_registry.result!=='match') return res.status(400).json({success:false,message:'Before approving, record a matching CAC or official government registry check.'});
    }
    const now=Date.now();
    await db.tx(async tx=>{
      await tx.run('UPDATE company_verification_applications SET status=?,admin_note=?,updated_at=? WHERE id=?',[status,note,now,req.params.id]);
      if(application.order_id && status==='verified') await tx.run("UPDATE ad_job_orders SET status='verified',updated_at=? WHERE id=?",[now,application.order_id]);
      else if(application.order_id && ['rejected','more_documents_required'].includes(status)) await tx.run("UPDATE ad_job_orders SET status='profile_saved',updated_at=? WHERE id=?",[now,application.order_id]);
      await tx.run('INSERT INTO company_verification_audit (application_id,actor,action,details,created_at) VALUES (?,?,?,?,?)',[req.params.id,'admin','status_changed',JSON.stringify({status,note,orderId:application.order_id}),now]);
    });
    res.json({success:true,status});
  });
  // Admin can record the result of a human CAC / official-government lookup. This is deliberately separate from OCR.
  app.post('/api/admin/company-verification/:id/official-check', requireAdmin, async(req,res)=>{ await ensureSchema(); const result=clean(req.body&&req.body.result,40), reference=clean(req.body&&req.body.reference,300), note=clean(req.body&&req.body.note,1500); if(!['match','mismatch','not_found','unavailable','not_checked'].includes(result))return res.status(400).json({success:false,message:'Invalid official check result.'}); const row=await db.get('SELECT checks_json FROM company_verification_applications WHERE id=?',[req.params.id]); if(!row)return res.status(404).json({success:false,message:'Application not found.'}); const checks=parseChecks(row.checks_json); checks.official_registry={result,reference,note,checked_at:Date.now(),checked_by:'admin',method:'manual_official_source_check'}; await db.run('UPDATE company_verification_applications SET checks_json=?,updated_at=? WHERE id=?',[JSON.stringify(checks),Date.now(),req.params.id]); await db.run('INSERT INTO company_verification_audit (application_id,actor,action,details,created_at) VALUES (?,?,?,?,?)',[req.params.id,'admin','official_registry_check_recorded',JSON.stringify(checks.official_registry),Date.now()]); res.json({success:true,officialRegistry:checks.official_registry}); });
};
