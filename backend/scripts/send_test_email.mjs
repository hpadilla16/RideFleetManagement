import { sendEmail } from '../src/lib/mailer.js';

const to = process.argv[2] || 'customerservice@ridecarsharing.com';

try {
  await sendEmail({
    to,
    subject: 'Test Email - Fleet SMTP',
    text: 'This is a test email from Fleet Management SMTP integration.'
  });
  console.log(`TEST_EMAIL_SENT:${to}`);
} catch (e) {
  console.error('TEST_EMAIL_FAILED', e?.message || e);
  process.exit(1);
}
