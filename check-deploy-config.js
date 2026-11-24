// Safe pre-deployment check: reports missing variable NAMES only; never prints secret values.
// Load a local .env without requiring third-party packages; existing process env wins.
const fs = require('fs');
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || Object.prototype.hasOwnProperty.call(process.env, m[1])) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
const required = [
  'DATABASE_URL', 'APP_URL', 'AUTH_SECRET', 'ADMIN_KEY',
  'PAYSTACK_SECRET_KEY', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'
];
const optionalForEnquiryEmail = ['RESEND_API_KEY', 'MAIL_FROM'];
const smsReady = !!(process.env.TERMII_API_KEY || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)));
if (!smsReady) console.warn('Vico Message phone verification will NOT work until an SMS service is set: TERMII_API_KEY (+ TERMII_SENDER_ID) or TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.');
const missing = required.filter((key) => !String(process.env[key] || '').trim());
const missingMail = optionalForEnquiryEmail.filter((key) => !String(process.env[key] || '').trim());
if (missing.length) {
  console.error('Deployment is NOT ready. Missing required environment variables:');
  for (const key of missing) console.error(` - ${key}`);
} else {
  console.log('Required environment variable names are present.');
}
if (missingMail.length) {
  console.warn('Enquiry replies by email will not be sent until these are configured:');
  for (const key of missingMail) console.warn(` - ${key}`);
} else {
  console.log('Resend email configuration variables are present (domain verification must still be confirmed at Resend).');
}
if (process.env.PAYSTACK_SECRET_KEY && !/^sk_(test|live)_/.test(process.env.PAYSTACK_SECRET_KEY)) {
  console.warn('PAYSTACK_SECRET_KEY does not look like a standard Paystack test/live secret key. Check it in the Paystack dashboard.');
}
if (process.env.APP_URL && !/^https:\/\//i.test(process.env.APP_URL)) {
  console.warn('APP_URL should use your public HTTPS website URL for production.');
}
if (missing.length) process.exitCode = 1;
