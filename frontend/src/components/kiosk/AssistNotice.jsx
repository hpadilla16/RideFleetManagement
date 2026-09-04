'use client';

/**
 * Tells the guest, on their own screen, that someone touched their check-in.
 *
 * Two facts, both from the SERVER — never from what the Valet console claims:
 *
 *   1. THE PERMIT (transient): someone currently holds an assist grant. Shown
 *      while it is open. On its own this was not enough: a grant is consumed
 *      the instant the override is applied, so in the routine case it lived for
 *      the agent's typing speed and a 5-second poll never saw it.
 *
 *   2. THE ACT (durable): the guest's identity was confirmed by a person, in
 *      person or remotely. Read from idVerifyMethod, which F1 added precisely to
 *      distinguish the two, and which survives the grant. This is what the guest
 *      actually needs to know, and it stays for the rest of the session.
 *
 * Rendered IN FLOW, between the progress row and the screen, so it displaces
 * content instead of covering it. Two absolute placements each hid something
 * real — the bar's controls, then the five progress steps — and the class of
 * bug was the positioning, not the number. It still paints above the chat
 * overlay (same stacking context, z 84 over the overlay's 70); the agent toast
 * (85) wins for its 2.5 seconds. pointer-events: none — it informs, it never
 * blocks a control.
 *
 * The name is the VERIFIED actor (User.fullName via assistUserId), never the
 * free text Valet asserted. A service account is not a person, so it gets the
 * generic copy rather than a bot's display name on an official-looking notice.
 */
export function AssistNotice({ state, t }) {
  if (!state) return null;
  const name = state.helperName || null;
  let text = null;
  let tone = 'now';
  if (state.open) {
    text = name ? t('kiosk.assistNowNamed', { name }) : t('kiosk.assistNow');
  } else if (state.verifiedBy === 'REMOTE') {
    tone = 'done';
    text = name ? t('kiosk.assistRemoteDoneNamed', { name }) : t('kiosk.assistRemoteDone');
  } else if (state.verifiedBy === 'IN_PERSON') {
    tone = 'done';
    text = name ? t('kiosk.assistInPersonDoneNamed', { name }) : t('kiosk.assistInPersonDone');
  }
  if (!text) return null;
  return (
    <div
      className={`kio-assist-notice kio-assist-notice--${tone}`}
      role="status"
      aria-live="polite"
      data-testid="assist-notice"
      data-tone={tone}
    >
      <span aria-hidden="true">{tone === 'now' ? '👤' : '✓'}</span>
      <span>{text}</span>
    </div>
  );
}

export default AssistNotice;
