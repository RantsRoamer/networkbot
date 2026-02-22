// utils/email.js – send email via SMTP for notifications and test

const nodemailer = require('nodemailer');
const { getConfig } = require('./config');

/**
 * Build nodemailer transport from config.email. Returns null if email not enabled or SMTP host missing.
 */
function getEmailTransport() {
  const config = getConfig().email;
  if (!config?.enabled || !config.smtp?.host?.trim()) return null;
  const opts = {
    host: config.smtp.host.trim(),
    port: parseInt(config.smtp.port, 10) || 587,
    secure: config.smtp.secure === true,
  };
  if (config.smtp.auth?.user?.trim()) {
    opts.auth = {
      user: config.smtp.auth.user.trim(),
      pass: config.smtp.auth.pass || '',
    };
  }
  return nodemailer.createTransport(opts);
}

/**
 * Send an email using current config. Uses config.email.from and config.email.to if not provided.
 * @param {Object} options - { to?, from?, subject, text, html? }
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
async function sendEmail(options = {}) {
  const config = getConfig().email;
  if (!config?.enabled || !config.smtp?.host?.trim()) {
    return { success: false, error: 'Email is not enabled or SMTP host is not set.' };
  }
  const to = options.to || config.to || '';
  const from = options.from || config.from || 'NetworkBot';
  if (!to.trim()) return { success: false, error: 'No recipient (to) address.' };
  const transport = getEmailTransport();
  if (!transport) return { success: false, error: 'Could not create SMTP transport.' };
  try {
    const info = await transport.sendMail({
      from: from.trim(),
      to: to.trim(),
      subject: options.subject || 'Notification',
      text: options.text || '',
      html: options.html,
    });
    return { success: true, message: info.messageId || 'Sent.' };
  } catch (err) {
    return { success: false, error: err.message || 'Send failed.' };
  }
}

/**
 * Send a test notification to the configured "to" address.
 */
async function sendTestEmail() {
  const config = getConfig().email;
  const to = config?.to?.trim();
  if (!to) return { success: false, error: 'No default recipient (To) address configured.' };
  return sendEmail({
    to,
    subject: 'NetworkBot – Test notification',
    text: `This is a test email from NetworkBot.\n\nIf you received this, the email configuration is working.\n\nTime: ${new Date().toISOString()}`,
  });
}

module.exports = { getEmailTransport, sendEmail, sendTestEmail };
