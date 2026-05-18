// Pillar 2 (2026-05-18) — /checkin route now serves the wizard.
// Old single-form checkin preserved in git history before commit f9c7a85.
// The wizard module lives at ../checkin-wizard/page.js and is re-exported
// here so every existing UI button pointing to /checkin opens the wizard.
export { default } from '../checkin-wizard/page.js';
