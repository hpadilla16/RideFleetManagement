/**
 * i18n GUARD — per-screen tool, NOT a CI gate (set up 2026-06-29).
 *
 * Purpose: "stop the bleeding" as we convert the app to i18n screen by screen.
 * This config flags hardcoded user-facing strings via eslint-plugin-i18next's
 * `no-literal-string` rule so we can run it against a screen WHILE converting it
 * and confirm nothing was missed.
 *
 * WHY IT IS NOT WIRED INTO THE BUILD / CI:
 *   The codebase still has a large backlog of un-converted screens. Enabling this
 *   globally in CI today would flood the pipeline with hundreds of pre-existing
 *   violations and block every PR. Instead it's an on-demand tool:
 *       npm run lint:i18n
 *   Run it after converting a screen to verify full coverage. As more screens are
 *   converted we can tighten/auto-fix and eventually promote it to the CI gate.
 *
 * markupOnly:false => also catches strings in props like title/placeholder/aria-label,
 * not just JSX text children (those are common hiding spots for untranslated copy).
 */
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['i18next'],
  // Only the surfaces we're actively converting. Add globs as the program advances.
  overrides: [
    {
      files: ['src/app/**/*.{js,jsx}', 'src/components/**/*.{js,jsx}'],
      rules: {
        'i18next/no-literal-string': [
          'warn',
          {
            markupOnly: false,
            // Don't flag values that aren't human copy.
            ignore: [
              // pure numbers, currency/units, single symbols, separators
              '^[0-9$%.,:#/\\-+()·•|→←↑↓☰●—–\\s]*$',
            ],
            // The brand name is intentionally not translated.
            words: { exclude: ['Ride Fleet', 'Ride', 'EN', 'ES'] },
            'jsx-attributes': {
              // attributes that never carry user-facing copy
              exclude: [
                'className', 'style', 'href', 'src', 'id', 'key', 'type',
                'name', 'role', 'tabIndex', 'width', 'height', 'viewBox',
                'fill', 'stroke', 'data-theme', 'rx', 'cx', 'cy', 'r',
                'x', 'y', 'x1', 'x2', 'y1', 'y2', 'd', 'transform',
                'strokeWidth', 'strokeDasharray', 'strokeDashoffset',
                'strokeLinecap', 'offset', 'stopColor', 'stopOpacity',
                'fontSize', 'textAnchor', 'opacity', 'loader', 'method',
              ],
            },
            callees: {
              // don't flag args to non-UI helpers
              exclude: [
                't', 'i18n', 'i18next', 'require', 'import',
                'localStorage', 'getItem', 'setItem', 'removeItem',
                'setAttribute', 'querySelector', 'addEventListener',
                'removeEventListener', 'push', 'replace', 'api', 'authApi',
                'console', 'log', 'error', 'warn',
              ],
            },
          },
        ],
      },
    },
  ],
};
