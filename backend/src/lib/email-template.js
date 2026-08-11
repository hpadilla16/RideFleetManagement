/**
 * Unified branded transactional email template (2026-06-27).
 *
 * One shell for every customer-facing email: tenant logo/wordmark header,
 * tenant brand color (falls back to the RFM default), a single primary CTA,
 * and a standard footer. Produces BOTH html + plaintext so sendEmail() can
 * pass a proper fallback. Email-client safe: table layout + inline styles.
 *
 * Usage:
 *   const brand = await resolveEmailBrand(scope);            // tenant theme or RFM default
 *   const { html, text } = renderBrandedEmail({ brand, heading, bodyHtml, cta, ... });
 *   await sendEmail({ to, subject, html, text });
 */

export const RFM_DEFAULT_BRAND = Object.freeze({
  companyName: 'Ride Fleet',
  brandColor: '#8752FE',
  logoUrl: '',
  address: '',
  phone: '',
  supportUrl: '',
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function isHex(c) { return /^#[0-9a-fA-F]{6}$/.test(String(c || '')); }
function stripTags(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|tr|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Resolve a tenant's email brand from settings, falling back to the RFM default.
 * settingsService is injectable for tests.
 */
export async function resolveEmailBrand(scope = {}, deps = {}) {
  let settingsService = deps.settingsService;
  if (!settingsService) ({ settingsService } = await import('../modules/settings/settings.service.js'));
  let s = {};
  try { s = (await settingsService.getRentalAgreementConfig(scope)) || {}; } catch { s = {}; }
  const brandColor = isHex(s.emailBrandColor) ? s.emailBrandColor : RFM_DEFAULT_BRAND.brandColor;
  return {
    companyName: s.companyName || RFM_DEFAULT_BRAND.companyName,
    brandColor,
    logoUrl: s.companyLogoUrl || '',
    address: s.companyAddress || '',
    phone: s.companyPhone || '',
    supportUrl: s.emailSupportUrl || '',
    // Set only after the tenant's domain is verified in MailerSend — see the
    // emailFromAddress comment in settings.service.js.
    fromEmail: s.emailFromAddress || '',
  };
}

/**
 * Render the unified email. `brand` is the resolved theme (or omit for RFM default).
 * `bodyHtml` is trusted inner HTML (caller-built rows); `bodyText` optional explicit
 * plaintext (else derived from bodyHtml). `cta` = { label, url }. `locale` 'en'|'es'
 * only affects the footer's standard strings today.
 */
export function renderBrandedEmail({ brand, heading, bodyHtml, bodyText, cta, preheader, footerNote, locale = 'en' } = {}) {
  const b = { ...RFM_DEFAULT_BRAND, ...(brand || {}) };
  const color = isHex(b.brandColor) ? b.brandColor : RFM_DEFAULT_BRAND.brandColor;
  const L = (locale === 'es')
    ? { support: 'Soporte', unsubscribe: 'Cancelar suscripción' }
    : { support: 'Support', unsubscribe: 'Unsubscribe' };

  const header = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.companyName)}" height="32" style="height:32px;display:block;border:0;">`
    : `<span style="font-size:18px;font-weight:600;color:#ffffff;">${esc(b.companyName)}</span>`;

  const ctaHtml = (cta && cta.url && cta.label)
    ? `<tr><td style="padding:4px 0 8px;"><a href="${esc(cta.url)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;">${esc(cta.label)}</a></td></tr>`
    : '';

  const footerBits = [b.companyName, b.address, b.phone].filter(Boolean).map(esc).join(' · ');
  const footerLinks = [
    b.supportUrl ? `<a href="${esc(b.supportUrl)}" style="color:${color};text-decoration:none;">${L.support}</a>` : '',
    `<span style="color:#9b95b0;">${L.unsubscribe}</span>`,
  ].filter(Boolean).join(' · ');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ff;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ff;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6dfff;">
<tr><td style="background:${color};padding:18px 22px;">${header}</td></tr>
<tr><td style="padding:22px;font-family:Arial,Helvetica,sans-serif;color:#1f1f28;">
${heading ? `<div style="font-size:18px;font-weight:600;color:#211a38;margin:0 0 10px;">${esc(heading)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;color:#3f3f3f;">
<tr><td>${bodyHtml || ''}</td></tr>
${ctaHtml}
</table>
</td></tr>
<tr><td style="padding:14px 22px;background:#fcfbff;border-top:1px solid #e6dfff;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6f668f;line-height:1.5;">
${footerBits ? `<div>${footerBits}</div>` : ''}
<div style="margin-top:6px;">${footerLinks}</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const textParts = [
    heading || '',
    bodyText || stripTags(bodyHtml),
    cta && cta.url ? `\n${cta.label}: ${cta.url}` : '',
    footerNote ? `\n${footerNote}` : '',
    footerBits ? `\n${stripTags(footerBits)}` : '',
  ].filter(Boolean);
  const text = textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { html, text };
}

export default renderBrandedEmail;
