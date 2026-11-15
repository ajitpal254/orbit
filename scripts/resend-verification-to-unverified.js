// One-off admin script: send verification emails to every account
// whose email is explicitly unverified.
//
// Background: email verification shipped in v0.5.1, but SMTP from
// Render to Brevo was broken until the Brevo HTTP API fallback
// (PR #18) — so accounts created in between never got a working
// verification email. This script finds them and (re)sends it.
//
// Usage (run in the Render service Shell tab, where MONGODB_URI and
// BREVO_API_KEY are already set — nothing secret leaves Render):
//   node scripts/resend-verification-to-unverified.js --dry-run
//   node scripts/resend-verification-to-unverified.js
//
// --dry-run lists the accounts that would be emailed and sends
// nothing. Without it, each account gets a fresh verification email
// via the app's own sendVerificationEmail (Brevo API when
// BREVO_API_KEY is set, else SMTP), one at a time with a short gap
// so the mail provider is not hammered.
//
// Scope: only users with emailVerified === false. Grandfathered
// accounts (no emailVerified field — created before verification
// existed) count as verified and are NOT emailed; neither are
// already-verified accounts. Tokens are never logged.
const mongoose = require('mongoose');
const User = require('../models/User');
const { sendVerificationEmail } = require('../lib/emailVerification');
const { pickEmailChannel, isBrevoApiConfigured } = require('../lib/brevoApi');
const { isSmtpConfigured } = require('../lib/emailVerification');

const GAP_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — run this where the app runs (Render Shell).');
    process.exitCode = 1;
    return;
  }
  const channel = pickEmailChannel({ smtpConfigured: isSmtpConfigured() });
  console.log(`Email channel: ${channel}${channel === 'brevo-api' ? ' (BREVO_API_KEY set)' : ''}${channel === 'none' ? ' — nothing will send' : ''}`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const users = await User.find({ emailVerified: false })
      .select('_id email name')
      .lean();
    console.log(`Found ${users.length} unverified account(s).`);
    if (dryRun) {
      for (const u of users) console.log(`  would email: ${u.email}`);
      console.log('Dry run — nothing sent.');
      return;
    }
    let sent = 0;
    let failed = 0;
    for (const u of users) {
      const result = await sendVerificationEmail({ _id: u._id, email: u.email });
      if (result.sent) {
        sent += 1;
        console.log(`  sent: ${u.email}`);
      } else {
        failed += 1;
        console.log(`  FAILED: ${u.email} (${result.reason || 'unknown'})`);
      }
      await sleep(GAP_MS);
    }
    console.log(`Done: ${sent} sent, ${failed} failed, ${users.length} total.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error('resend script failed:', err && err.message);
  process.exitCode = 1;
});
