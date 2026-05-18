// Pillar 2 (2026-05-18) — /checkout route now serves the wizard.
// Old single-form checkout preserved in git history before commit f9c7a85.
// The wizard module lives at ../checkout-wizard/page.js and is re-exported
// here so every existing UI button pointing to /checkout opens the wizard.
export { default } from '../checkout-wizard/page.js';
