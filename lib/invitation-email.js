const roles = { admin: 'Library Admin', library_monitor: 'Library Monitor', security: 'Security' };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function configuration() {
  const production = process.env.NODE_ENV === 'production';
  let configuredBase = process.env.APP_BASE_URL;
  if (!configuredBase && !production) {
    configuredBase = process.env.APP_ORIGIN;
    if (!configuredBase) {
      // Mirror the existing HTTP server's local port; never derive links from request headers.
      const port = Number(process.env.PORT || 3000);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
      const local = new URL('http://localhost'); local.port = String(port); configuredBase = local.origin;
    }
  }
  let base; try { base = new URL(configuredBase); } catch { return null; }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/' || (production && base.protocol !== 'https:')) return null;
  const key = process.env.BREVO_API_KEY?.trim(), from = process.env.BREVO_SENDER_EMAIL?.trim();
  if (!key || /[\r\n]/.test(key) || !from || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(from)) return null;
  return { base: base.origin, key, from };
}

function invitationContent({ first_name, role }, setupUrl) {
  const firstName = first_name?.trim() || 'there', assignedRole = roles[role];
  if (!assignedRole) throw Error('Unsupported invitation role');
  const subject = 'Welcome to QuietSpace — Set Up Your Account';
  const text = `Hello ${firstName},\n\nYour QuietSpace staff account request has been approved!\n\nYou have been granted access to QuietSpace as a ${assignedRole}.\n\nTo finish setting up your account, please use the secure link below:\n\nSet Up Your Account\n${setupUrl}\n\nThis invitation link is valid for 24 hours and can only be used once.\n\nIf you did not request a QuietSpace account, you can disregard this email.\n\nBest regards,\nThe QuietSpace Team\nNorth Carolina A&T State University`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title><style>@media(max-width:600px){.email-content{padding:28px 22px!important}.setup-button{display:block!important;text-align:center!important}}</style></head><body style="margin:0;padding:0;background:#eef3fb;color:#1e3155;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef3fb"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #d4e0f3;border-radius:18px;overflow:hidden"><tr><td style="padding:26px 32px;background:#142750;color:#ffffff"><div style="font-size:28px;font-weight:700">QuietSpace</div><div style="margin-top:8px;font-size:14px;color:#c8d9f7">Your staff account is ready to set up</div></td></tr><tr><td class="email-content" style="padding:34px 32px;font-size:16px;line-height:1.65"><p style="margin-top:0">Hello ${escape(firstName)},</p><h1 style="font-size:24px;line-height:1.35;color:#18376c">Your QuietSpace staff account request has been approved!</h1><p>You have been granted access to QuietSpace as a <strong>${escape(assignedRole)}</strong>.</p><p>To finish setting up your account, please use the secure link below:</p><table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0"><tr><td style="background:#2468c5;border-radius:12px;text-align:center"><a class="setup-button" href="${escape(setupUrl)}" style="display:inline-block;padding:15px 26px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border:1px solid #2468c5;border-radius:12px">Set Up Your Account</a></td></tr></table><p style="padding:14px 16px;border-radius:10px;background:#edf4ff;font-size:14px">This invitation link is valid for <strong>24 hours</strong> and can only be used once.</p><p style="font-size:14px;color:#586985">If you did not request a QuietSpace account, you can disregard this email.</p><p>Best regards,<br><strong>The QuietSpace Team</strong><br>North Carolina A&amp;T State University</p></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

async function sendInvitation({ id, token, email, role, first_name }, transport = fetch) {
  const config = configuration(); if (!config) return { status: 'failed', code: 'configuration_missing' };
  const url = new URL('/setup-account', config.base); url.searchParams.set('token', token);
  const content = invitationContent({ first_name, role }, url.href);
  try {
    const response = await transport('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': config.key, accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'QuietSpace', email: config.from }, to: [{ email }],
        subject: content.subject, htmlContent: content.html, textContent: content.text,
        tags: ['quietspace-staff-invitation'], headers: { IdempotencyKey: `quietspace-invitation-${id}` } })
    });
    let data; try { data = await response.json(); } catch { data = {}; }
    if (response.status === 201 && typeof data.messageId === 'string' && data.messageId.length > 0 && data.messageId.length <= 255 && !data.messageId.includes(token) && !data.messageId.includes(config.key)) {
      return { status: 'accepted', providerId: data.messageId };
    }
    // Never persist/log raw provider errors: they can echo message content or credentials.
    return { status: 'failed', code: response.ok || response.status >= 500 ? 'delivery_unconfirmed' : `brevo_rejected_${response.status}` };
  } catch { return { status: 'failed', code: 'delivery_unconfirmed' }; }
}
module.exports = { configuration, invitationContent, sendInvitation };
