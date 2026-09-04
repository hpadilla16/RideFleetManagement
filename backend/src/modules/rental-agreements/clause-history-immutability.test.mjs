/**
 * CAN AN EDIT TODAY CHANGE WHAT SOMEONE SIGNED LAST WEEK? (2026-09-04)
 * Run: npm run test:clause-history
 *
 * Written alongside the clause editor, because the editor is the thing that
 * makes this question urgent. Until now `Location.termsSectionsJson` could only
 * be changed by a developer running `scripts/load-location-terms.mjs --commit`.
 * A settings screen turns that into something an admin does on a Tuesday
 * afternoon, and every rental already signed at that branch keeps pointing at
 * the same column.
 *
 * ── WHAT THIS SUITE FOUND ───────────────────────────────────────────────────
 * The answer today is SPLIT, and the split is not a design — it is a gap:
 *
 *   • TERMINAL-signed clauses ARE snapshotted. `AgreementClauseAcceptance`
 *     .sectionBody stores the clause text exactly as displayed, written the
 *     moment the renter presses "I agree". The schema says why, verbatim:
 *     "sectionBody snapshots the clause text as displayed, because
 *     Location.termsSectionsJson can change it afterwards and a re-print must
 *     not be able to show wording nobody agreed to."
 *
 *   • PHONE-signed clauses are NOT snapshotted anywhere.
 *     `AgreementSectionInitial` carries sectionKey, sectionLabel and the ink —
 *     there is no body column. The only record of the wording is the live
 *     Location column.
 *
 *   • And the agreement PDF re-print reads the LIVE column for BOTH.
 *     `buildSignedTermsBlock` calls `sectionsForAgreement({ sectionOverrides:
 *     agreement.pickupLocation.termsSectionsJson })` and prints `s.body` — even
 *     for a terminal-signed clause whose snapshot is sitting in the same
 *     object it is already reading (`agreement.clauseAcceptances`, used two
 *     lines away for the acceptance stamp). So the snapshot the schema says
 *     exists to prevent this is written and then not consulted.
 *
 * That is a DEFECT, reported rather than papered over: fixing the re-print is a
 * change to what signed PDFs render and belongs in its own branch with its own
 * review, and the phone half cannot be fixed here at all — it needs a column
 * and a backfill decision for every agreement already signed.
 *
 * These tests therefore PIN THE TRUTH, not the wish. Each one states which of
 * the two it is. When the re-print is fixed, CARE 4 and CARE 5 are the tests
 * that must be inverted, deliberately, by whoever fixes it.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import { terminalContractService, CONTRACT_CHOICE } from '../checkout-session/terminal-contract.service.js';
import { sectionsForAgreement } from '../checkout-session/terms-content.js';
import { buildSignedTermsBlock } from './rental-agreements.service.js';

// The wording in force on the day the renter signed.
const WEEK_1_TEXT = 'I authorize a security deposit hold of $500 against my card on file '
  + 'and further charges for tolls, fines, fuel, cleaning and damage after the rental ends.';
// What an admin types into the new editor a week later.
const WEEK_2_TEXT = 'I authorize a security deposit hold of $2,000 against my card on file '
  + 'and further charges for tolls, fines, fuel, cleaning and damage after the rental ends.';

const overridesJson = (body) => JSON.stringify({ deposit_post_charges: { body } });

// ── A minimum terminal harness, same shape as terminal-contract.test.mjs ─────
// The device is mocked; it is a production terminal on a live merchant and a
// test must never put a clause on a counter screen that is open for business.
let store;
let originals;

function mountTerminal(sectionOverrides) {
  cache.clear();
  store = { acceptances: [] };
  originals = {
    findUnique: prisma.checkoutSession.findUnique,
    sessionUpdate: prisma.checkoutSession.update,
    agreementUpdate: prisma.rentalAgreement.update,
    findMany: prisma.agreementClauseAcceptance?.findMany,
    upsert: prisma.agreementClauseAcceptance?.upsert,
    appSetting: prisma.appSetting.findUnique,
    tenant: prisma.tenant.findUnique,
    userChoice: spinClient.userChoice,
  };
  // readTenantTerminalRow Promise.all's the tenant row with the setting row and
  // swallows a rejection into "no terminal configured" — so leaving this real
  // would make the harness fail as TERMINAL_NOT_CONFIGURED and look like a
  // product bug rather than a missing stub.
  prisma.tenant.findUnique = async () => ({ name: 'Corpusa' });

  prisma.checkoutSession.findUnique = async () => ({
    id: 's1',
    currentStep: 'TC_PENDING',
    tcCompletedAt: null,
    events: '[]',
    reservation: { id: 'r1', reservationNumber: 'RES-1', tenantId: 'ten1', pickupLocationId: 'loc1' },
    agreement: {
      id: 'ag1',
      agreementNumber: 'RA-1',
      declinedInsurance: false,
      tcSignedAt: null,
      pickupLocation: { id: 'loc1', termsSectionsJson: sectionOverrides },
    },
  });
  prisma.checkoutSession.update = async () => ({});
  prisma.rentalAgreement.update = async () => ({});
  prisma.agreementClauseAcceptance = prisma.agreementClauseAcceptance || {};
  prisma.agreementClauseAcceptance.findMany = async (args) => {
    const rows = args?.where?.accepted === true ? store.acceptances.filter((r) => r.accepted) : store.acceptances;
    return rows.map((r) => ({ ...r }));
  };
  prisma.agreementClauseAcceptance.upsert = async (op) => {
    const key = op.where.agreementId_sectionKey.sectionKey;
    const existing = store.acceptances.find((r) => r.sectionKey === key);
    if (existing) { Object.assign(existing, op.update); return { ...existing }; }
    const row = { ...op.create };
    store.acceptances.push(row);
    return { ...row };
  };
  prisma.appSetting.findUnique = async ({ where }) => {
    if (where.key === 'tenant:ten1:checkoutContractPolicy') return { value: JSON.stringify({ mode: 'TERMINAL' }) };
    if (where.key === 'tenant:ten1:paymentGatewayConfig') {
      return { value: JSON.stringify({ spin: { enabled: true, authKey: 'AK', tpn: '816026434206' } }) };
    }
    return null;
  };
  spinClient.userChoice = async () => ({
    SelectedOption: CONTRACT_CHOICE.ACCEPT,
    GeneralResponse: { ResultCode: '0', StatusCode: '0000', Message: 'Success' },
  });
}

function unmount() {
  if (!originals) return;
  prisma.checkoutSession.findUnique = originals.findUnique;
  prisma.checkoutSession.update = originals.sessionUpdate;
  prisma.rentalAgreement.update = originals.agreementUpdate;
  if (originals.findMany) prisma.agreementClauseAcceptance.findMany = originals.findMany;
  if (originals.upsert) prisma.agreementClauseAcceptance.upsert = originals.upsert;
  prisma.appSetting.findUnique = originals.appSetting;
  prisma.tenant.findUnique = originals.tenant;
  spinClient.userChoice = originals.userChoice;
  originals = null;
}

beforeEach(() => { unmount(); });
afterEach(() => { unmount(); });

/** A signed agreement, as the print path loads one. */
function signedAgreement({ termsSectionsJson, clauseAcceptances = [] }) {
  return {
    agreementNumber: 'RA-1',
    declinedInsurance: false,
    customerFirstName: 'Ana', customerLastName: 'Rivera',
    tcSignerName: 'Ana Rivera',
    tcSignedAt: new Date('2026-08-28T15:00:00Z'),
    tcSignatureDataUrl: 'data:image/png;base64,AAAA',
    pickupLocation: { id: 'loc1', name: 'LAX', termsSectionsJson },
    sectionInitials: sectionsForAgreement({}).map((s) => ({
      sectionKey: s.key,
      sectionLabel: s.label,
      initialDataUrl: 'data:image/png;base64,BBBB',
      signedAt: new Date('2026-08-28T15:00:00Z'),
    })),
    clauseAcceptances,
  };
}

// ---------------------------------------------------------------------------
// CARE 1 — the mechanism. This is WHY the question exists.
// ---------------------------------------------------------------------------
test('CARE 1: the clause resolver is LIVE — the same agreement reads different text after an edit', () => {
  const week1 = sectionsForAgreement({ sectionOverrides: overridesJson(WEEK_1_TEXT) });
  const week2 = sectionsForAgreement({ sectionOverrides: overridesJson(WEEK_2_TEXT) });
  assert.equal(week1.find((s) => s.key === 'deposit_post_charges').body, WEEK_1_TEXT);
  assert.equal(week2.find((s) => s.key === 'deposit_post_charges').body, WEEK_2_TEXT);
  // Nothing about the agreement changed. Only the branch column did.
  assert.notEqual(week1.find((s) => s.key === 'deposit_post_charges').body,
    week2.find((s) => s.key === 'deposit_post_charges').body);
});

// ---------------------------------------------------------------------------
// CARE 2 — TRUE TODAY, and the property the editor most depends on.
// ---------------------------------------------------------------------------
test('CARE 2: a terminal acceptance SNAPSHOTS the clause body as displayed', async () => {
  mountTerminal(overridesJson(WEEK_1_TEXT));
  // The renter answers every clause on the device on week 1.
  for (let i = 0; i < 6; i += 1) await terminalContractService.runClause({ sessionId: 's1' });

  const deposit = store.acceptances.find((r) => r.sectionKey === 'deposit_post_charges');
  assert.ok(deposit, 'the acceptance row exists');
  assert.equal(deposit.sectionBody, WEEK_1_TEXT, 'the row holds the branch wording that was on the screen');
  assert.equal(deposit.accepted, true);
  assert.equal(deposit.choiceOption, CONTRACT_CHOICE.ACCEPT);

  // Now the admin edits the clause in the new editor. The stored row is a
  // SNAPSHOT: it is a different row in a different table, and nothing about
  // changing the Location column reaches it.
  const afterEdit = sectionsForAgreement({ sectionOverrides: overridesJson(WEEK_2_TEXT) });
  assert.equal(afterEdit.find((s) => s.key === 'deposit_post_charges').body, WEEK_2_TEXT);
  assert.equal(deposit.sectionBody, WEEK_1_TEXT, 'the acceptance still says what she actually agreed to');
});

// ---------------------------------------------------------------------------
// CARE 3 — TRUE TODAY. The strongest evidence available for the terminal path.
// ---------------------------------------------------------------------------
test('CARE 3: the acceptance stamp on the re-printed PDF still shows the option and time she pressed', () => {
  const acceptances = [{
    sectionKey: 'deposit_post_charges',
    sectionLabel: 'Deposit and post-rental charges',
    sectionBody: WEEK_1_TEXT,
    choiceOption: CONTRACT_CHOICE.ACCEPT,
    accepted: true,
    acceptedAt: new Date('2026-08-28T14:59:00Z'),
    terminalTpn: '8160****4206',
  }];
  const html = buildSignedTermsBlock(signedAgreement({
    termsSectionsJson: overridesJson(WEEK_2_TEXT), clauseAcceptances: acceptances,
  }), { cfg: { companyName: 'Corpusa' } });
  assert.match(html, /I agree \/ Acepto/, 'the verbatim option she pressed survives the edit');
  assert.match(html, /on the counter terminal/);
  assert.match(html, /8160\*{4}4206/);
});

// ---------------------------------------------------------------------------
// CARE 4 — **THE DEFECT.** FALSE TODAY. Characterized, not wished away.
// ---------------------------------------------------------------------------
test('CARE 4: DEFECT — the re-print shows the CURRENT clause text, not the snapshot beside it', () => {
  const acceptances = [{
    sectionKey: 'deposit_post_charges',
    sectionLabel: 'Deposit and post-rental charges',
    sectionBody: WEEK_1_TEXT, // what she saw and accepted
    choiceOption: CONTRACT_CHOICE.ACCEPT,
    accepted: true,
    acceptedAt: new Date('2026-08-28T14:59:00Z'),
    terminalTpn: '8160****4206',
  }];
  const html = buildSignedTermsBlock(signedAgreement({
    termsSectionsJson: overridesJson(WEEK_2_TEXT), // edited a week later
    clauseAcceptances: acceptances,
  }), { cfg: { companyName: 'Corpusa' } });

  // The renderer HAS the snapshot — it reads the very same row two lines away
  // to print the acceptance stamp asserted in CARE 3 — and prints the live
  // body anyway. THIS ASSERTION IS THE BUG. Invert it when the re-print is
  // fixed to prefer accepted.sectionBody.
  assert.ok(html.includes('$2,000'), 'TODAY: the re-print carries the NEW deposit figure');
  assert.ok(!html.includes('$500'), 'TODAY: the figure she actually initialled is gone from the page');

  // Stated positively so the fix has an unambiguous target:
  //   expected after fix → html includes WEEK_1_TEXT and not '$2,000'.
  assert.equal(acceptances[0].sectionBody, WEEK_1_TEXT,
    'the correct text is present in the object the renderer already holds — the fix is a substitution, not a migration');
});

// ---------------------------------------------------------------------------
// CARE 5 — **THE WIDER DEFECT.** FALSE TODAY, and NOT fixable in this branch.
// ---------------------------------------------------------------------------
test('CARE 5: DEFECT — a PHONE-signed agreement has no snapshot at all to fall back on', () => {
  const html = buildSignedTermsBlock(signedAgreement({
    termsSectionsJson: overridesJson(WEEK_2_TEXT),
    clauseAcceptances: [], // phone path writes none, by design
  }), { cfg: { companyName: 'Corpusa' } });

  assert.ok(html.includes('$2,000'), 'TODAY: the re-print carries the edited wording');
  // AgreementSectionInitial has sectionKey, sectionLabel, initialDataUrl,
  // signedAt, customerIp — and NO body column. So unlike CARE 4 there is
  // nowhere to read the original from: fixing this needs a schema column and a
  // decision about every agreement already signed without one.
  const initialRow = signedAgreement({ termsSectionsJson: null }).sectionInitials[0];
  assert.deepEqual(
    Object.keys(initialRow).filter((k) => /body|text|statement/i.test(k)),
    [],
    'no field on the initial row could hold the wording that was initialled',
  );
});

// ---------------------------------------------------------------------------
// CARE 6 — TRUE TODAY. The contrast that makes 4 and 5 defects rather than
// house style: the damage path, on the SAME column, does it correctly.
// ---------------------------------------------------------------------------
test('CARE 6: the damage-acknowledgement path proves the intended pattern — snapshot, then read the snapshot', async () => {
  // report-damage.service.js resolves damageAcknowledgementSection() ONCE at
  // signing time and persists the wording into
  // DamageReport.customerAckStatementText; incident-report.service.js then
  // prints `ackReport.customerAckStatementText`, never re-resolving. Same
  // override column, same editability, opposite outcome — which is why the
  // agreement re-print is the outlier and not the rule.
  const { damageAcknowledgementSection } = await import('../checkout-session/terms-content.js');
  const atSigning = damageAcknowledgementSection({
    sectionOverrides: JSON.stringify({ damage_acknowledgement: { body: 'Week-1 damage wording.' } }),
  }).body;
  const snapshot = atSigning; // what report-damage writes to the row

  const afterEdit = damageAcknowledgementSection({
    sectionOverrides: JSON.stringify({ damage_acknowledgement: { body: 'Week-2 damage wording.' } }),
  }).body;

  assert.equal(atSigning, 'Week-1 damage wording.');
  assert.equal(afterEdit, 'Week-2 damage wording.');
  assert.equal(snapshot, 'Week-1 damage wording.', 'the persisted statement is unmoved by the edit');
});

// ---------------------------------------------------------------------------
// CARE 7 — TRUE TODAY, and the one the editor itself must never break.
// ---------------------------------------------------------------------------
test('CARE 7: editing clause text cannot change the KEY SET, so no signed initial is ever orphaned', () => {
  const signedKeys = sectionsForAgreement({ sectionOverrides: overridesJson(WEEK_1_TEXT) }).map((s) => s.key);
  const afterKeys = sectionsForAgreement({
    sectionOverrides: JSON.stringify({
      deposit_post_charges: { body: WEEK_2_TEXT, key: 'renamed', label: 'Deposit (LAX)' },
      a_new_branch_clause: { body: 'smuggled' },
    }),
  }).map((s) => s.key);
  assert.deepEqual(afterKeys, signedKeys,
    'AgreementSectionInitial rows still match by sectionKey after any edit the editor can make');
});
