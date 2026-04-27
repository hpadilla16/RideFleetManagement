/**
 * Pure template renderer - no prisma, no mailer, no settings. Substitutes
 * {{key}} placeholders with the values in `vars`. Null/undefined values are
 * rendered as empty strings; unknown placeholders are left intact.
 */
export function renderTemplate(template, vars = {}) {
  return Object.entries(vars || {}).reduce(
    (out, [k, v]) => out.replaceAll(`{{${k}}}`, v == null ? '' : String(v)),
    String(template || '')
  );
}
