/**
 * Ride University — the handful of AUTHORED strings inside the drawn kiosk
 * screens. Everything else in a figure is the kiosk's own label via
 * t('kiosk.*'); these are the exceptions — a chat bubble, a shortened list
 * item, the "where am I" eyebrow — and they are translatable like the rest of
 * the curriculum (keys under training.figures.*, checked by the i18n test).
 */
export const FIGURE_TEXT = Object.freeze({
  'where-guest': 'On the guest’s iPad',
  'where-staff': 'Staff panel on the iPad',
  'chat-guest': 'Hi, I can’t scan my license…',
  'chat-agent': 'I see you at the ID step. Let me help.',
  'remote-cannot-skip': 'Skip the ID check',
  'remote-cannot-sign': 'Sign or pay for the guest',
  'remote-cannot-car': 'Open the car — keys at the counter',
});

export const figureTextKey = (id) => `training.figures.${id}`;
export function figureTextKeys() {
  return Object.keys(FIGURE_TEXT).map(figureTextKey);
}
