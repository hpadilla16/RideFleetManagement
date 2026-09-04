/**
 * terminal-contract.test.mjs — signing the rental agreement on a Dejavoo QD2.
 * Run: npm run test:terminal-contract
 *
 * THE TERMINAL IS MOCKED. No live calls, ever — the real device is a
 * production terminal bound to a live merchant, and a test that reaches it
 * would put a clause on a screen at a counter that is open for business.
 * What is NOT mocked is the terminal-config resolver: these tests drive it
 * through AppSetting rows, so the fail-closed refusal it is famous for is
 * exercised rather than stubbed away.
 *
 * The properties defended here, in the order they matter:
 *
 *   1. A clause is accepted ONLY on the affirmative value. A successful call
 *      with an unrecognized SelectedOption is not consent.
 *   2. A decline STOPS the sequence and is recorded, not swallowed.
 *   3. A failure mid-sequence persists NOTHING for that clause, so the next
 *      read resumes at exactly the clause that failed.
 *   4. Both signing paths stamp the SAME tcCompletedAt, and the terminal path
 *      writes the SAME AgreementSectionInitial shape the phone path writes.
 *   5. The agreement is never marked signed unless every clause is accepted
 *      and real ink is in hand.
 *   6. A clause too long for the terminal is refused before the device is
 *      touched, never truncated.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import {
  terminalContractService,
  CONTRACT_CHOICE,
  CONTRACT_CHOICE_OPTIONS,
  USER_CHOICE_TITLE_MAX,
  assertClausesFitTerminal,
  isAcceptChoice,
  buildLadder,
  inkForSection,
  normalizeSignaturePayload,
} from './terminal-contract.service.js';
import { TC_SECTIONS, DECLINED_INSURANCE_SECTION, sectionsForAgreement } from './terms-content.js';
import {
  classifyTerminalError, busyDelaySeconds, isSpinOk,
  TERMINAL_STATES, VERDICTS, DEFAULT_BUSY_DELAY_SECONDS,
} from '../payment-gateway/terminal-state.js';
import { normalizeContractMode, resolveContractMode } from './checkout-contract-mode.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// REAL PNG bytes, built here rather than pasted, so analyzeSignatureInk gets
// something it can actually decode and the "blank canvas is a valid PNG" case
// is a genuine white image rather than a string we hope is treated as one.
// Sized so the base64 clears the 200-character floor the phone path also
// enforces — the live probe measured 20,336 characters for a real capture.
function makePng(width, height, fill) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const v = fill(x, y);
      raw[rowStart + 1 + x * 3] = v;
      raw[rowStart + 2 + x * 3] = v;
      raw[rowStart + 3 + x * 3] = v;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

// A diagonal stroke on white — ink, and plenty of it.
const SIGNED_PNG = makePng(64, 64, (x, y) => (Math.abs(x - y) < 3 ? 0 : 255));
// Untouched pad: a perfectly valid PNG with nothing on it.
const BLANK_PNG = makePng(64, 64, () => 255);

let store;
let spinCalls;
let originalUserChoice;
let originalGetSignature;

function agreementRow(overrides = {}) {
  return {
    id: 'ag1',
    agreementNumber: 'RA-1',
    declinedInsurance: false,
    tcSignedAt: null,
    pickupLocation: { id: 'loc1', termsSectionsJson: null },
    ...overrides,
  };
}

function reset({ contractMode = 'TERMINAL', locations = {}, terminal = true, sectionOverrides = null } = {}) {
  // Both resolvers cache for 60 s. Without this a test that flips the mode
  // would read the previous test's answer — the same staleness an admin hits
  // when a write forgets to invalidate.
  cache.clear();

  store = {
    acceptances: [],
    initialUpserts: [],
    agreementUpdates: [],
    sessionUpdates: [],
    txBatches: [],
    session: {
      id: 's1',
      currentStep: 'TC_PENDING',
      tcCompletedAt: null,
      events: '[]',
      reservation: { id: 'r1', reservationNumber: 'RES-1', tenantId: 'ten1', pickupLocationId: 'loc1' },
      agreement: agreementRow({ pickupLocation: { id: 'loc1', termsSectionsJson: sectionOverrides } }),
    },
  };
  spinCalls = [];

  prisma.checkoutSession.findUnique = async () => store.session;
  prisma.checkoutSession.update = async (op) => { store.sessionUpdates.push(op); return {}; };
  prisma.rentalAgreement.update = async (op) => { store.agreementUpdates.push(op); return {}; };

  prisma.agreementClauseAcceptance = prisma.agreementClauseAcceptance || {};
  prisma.agreementClauseAcceptance.findMany = async (args) => {
    let rows = store.acceptances;
    if (args?.where?.accepted === true) rows = rows.filter((r) => r.accepted);
    return rows.map((r) => ({ ...r }));
  };
  prisma.agreementClauseAcceptance.upsert = async (op) => {
    const key = op.where.agreementId_sectionKey.sectionKey;
    const existing = store.acceptances.find((r) => r.sectionKey === key);
    if (existing) {
      Object.assign(existing, op.update);
      return { ...existing };
    }
    const row = { ...op.create, inkDataUrl: op.create.inkDataUrl ?? null };
    store.acceptances.push(row);
    return { ...row };
  };

  prisma.agreementSectionInitial.upsert = async (op) => { store.initialUpserts.push(op); return {}; };
  // The service builds prisma promises and hands the ARRAY to $transaction, so
  // the fake records the batch without awaiting: that is what lets a test prove
  // the initials and the tcCompletedAt stamp are in ONE transaction.
  prisma.$transaction = async (ops) => { store.txBatches.push(ops); return ops; };

  prisma.tenant.findUnique = async () => ({ name: 'Corpusa' });
  prisma.appSetting.findUnique = async ({ where }) => {
    if (where.key === 'tenant:ten1:checkoutContractPolicy') {
      return { value: JSON.stringify({ mode: contractMode, locations }) };
    }
    if (where.key === 'tenant:ten1:paymentGatewayConfig') {
      return terminal
        ? { value: JSON.stringify({ spin: { enabled: true, authKey: 'AK', tpn: '816026434206' } }) }
        : null;
    }
    return null;
  };

  originalUserChoice = spinClient.userChoice;
  originalGetSignature = spinClient.getSignature;
  spinClient.userChoice = async (payload, cfg) => {
    spinCalls.push({ op: 'userChoice', payload, cfg });
    return {
      SelectedOption: CONTRACT_CHOICE.ACCEPT,
      GeneralResponse: { ResultCode: '0', StatusCode: '0000', Message: 'Success', DetailedMessage: 'Success' },
    };
  };
  spinClient.getSignature = async (cfg) => {
    spinCalls.push({ op: 'getSignature', cfg });
    return {
      Signature: SIGNED_PNG,
      GeneralResponse: { ResultCode: '0', StatusCode: '0000', Message: 'OK', DetailedMessage: 'OK' },
    };
  };
}

function restore() {
  if (originalUserChoice) spinClient.userChoice = originalUserChoice;
  if (originalGetSignature) spinClient.getSignature = originalGetSignature;
}

beforeEach(() => { restore(); reset(); });

async function acceptAllClauses() {
  for (let i = 0; i < TC_SECTIONS.length; i += 1) {
    await terminalContractService.runClause({ sessionId: 's1' });
  }
}

// ---------------------------------------------------------------------------
// The option strings — one home, exact match, no inference
// ---------------------------------------------------------------------------

test('the accept/decline strings live in ONE place and are what goes on the wire', async () => {
  assert.deepEqual([...CONTRACT_CHOICE_OPTIONS], [CONTRACT_CHOICE.ACCEPT, CONTRACT_CHOICE.DECLINE]);
  await terminalContractService.runClause({ sessionId: 's1' });
  const call = spinCalls.find((c) => c.op === 'userChoice');
  assert.deepEqual(call.payload.options, [CONTRACT_CHOICE.ACCEPT, CONTRACT_CHOICE.DECLINE]);
});

test('acceptance requires the affirmative value — a bare success is NOT consent', () => {
  assert.equal(isAcceptChoice(CONTRACT_CHOICE.ACCEPT), true);
  for (const notAccept of [undefined, null, '', 'OK', 'Yes', 'i agree / acepto', CONTRACT_CHOICE.DECLINE]) {
    assert.equal(isAcceptChoice(notAccept), false, `${String(notAccept)} must not count as acceptance`);
  }
});

test('a successful call with an unrecognized SelectedOption records NOT accepted', async () => {
  spinClient.userChoice = async () => ({
    SelectedOption: 'Something else entirely',
    GeneralResponse: { ResultCode: '0', StatusCode: '0000', Message: 'Success' },
  });
  const out = await terminalContractService.runClause({ sessionId: 's1' });
  assert.equal(out.accepted, false);
  // The raw value is kept — an audit has to be able to see what came back.
  assert.equal(store.acceptances[0].choiceOption, 'Something else entirely');
  assert.equal(store.acceptances[0].accepted, false);
});

test('the verbatim option string and the timestamp are persisted per sectionKey', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  const row = store.acceptances[0];
  assert.equal(row.sectionKey, TC_SECTIONS[0].key);
  assert.equal(row.choiceOption, CONTRACT_CHOICE.ACCEPT);
  assert.equal(row.accepted, true);
  assert.ok(row.acceptedAt instanceof Date);
  assert.equal(row.capturedVia, 'TERMINAL');
  // Masked, never the raw TPN and never the auth key.
  assert.equal(row.terminalTpn, '8160****4206');
});

test('the clause BODY is what the terminal displays, snapshotted onto the record', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  const call = spinCalls.find((c) => c.op === 'userChoice');
  assert.equal(call.payload.title, TC_SECTIONS[0].body);
  assert.equal(store.acceptances[0].sectionBody, TC_SECTIONS[0].body);
});

// ---------------------------------------------------------------------------
// Sequencing and resume
// ---------------------------------------------------------------------------

test('clauses run in TC_SECTIONS order, one call each', async () => {
  await acceptAllClauses();
  const titles = spinCalls.filter((c) => c.op === 'userChoice').map((c) => c.payload.title);
  assert.deepEqual(titles, TC_SECTIONS.map((s) => s.body));
  assert.equal(store.acceptances.length, TC_SECTIONS.length);
});

test('MEASURED: the declined-insurance addendum does NOT fit the terminal, so that checkout goes to the phone', async () => {
  // The canonical `declined_insurance` body is 274 characters — over the 250
  // UserChoice cap. This is a real finding, not a hypothetical: a renter who
  // declines counter insurance signs a SEVENTH clause, and it cannot be
  // displayed on the QD2 as written. Refusing is correct; truncating a
  // liability waiver is not. Recorded here so shortening that text (a legal
  // change, Hector's and counsel's call) is a deliberate act with a test that
  // notices when it happens.
  reset();
  store.session.agreement.declinedInsurance = true;
  const sections = sectionsForAgreement({ declinedInsurance: true });
  assert.equal(sections.length, TC_SECTIONS.length + 1);
  assert.equal(sections[3].key, 'declined_insurance');
  assert.ok(sections[3].body.trim().length > USER_CHOICE_TITLE_MAX);

  await assert.rejects(
    () => terminalContractService.runClause({ sessionId: 's1' }),
    (e) => {
      assert.equal(e.code, 'CLAUSE_TOO_LONG_FOR_TERMINAL');
      // The agent is sent to the phone, NOT told to edit a text they do not own.
      assert.match(e.message, /signed on the renter's phone/);
      assert.doesNotMatch(e.message, /terms overrides/);
      return true;
    },
  );
  assert.equal(spinCalls.length, 0, 'refused before the device was touched');
});

test('the declined-insurance addendum WOULD be sequenced if it fit — the ladder already carries it', async () => {
  reset({ sectionOverrides: JSON.stringify({ declined_insurance: { body: 'Short enough to display.' } }) });
  store.session.agreement.declinedInsurance = true;
  await terminalContractService.runClause({ sessionId: 's1' });
  await terminalContractService.runClause({ sessionId: 's1' });
  await terminalContractService.runClause({ sessionId: 's1' });
  const out = await terminalContractService.runClause({ sessionId: 's1' });
  assert.equal(out.total, TC_SECTIONS.length + 1);
  assert.equal(store.acceptances[3].sectionKey, 'declined_insurance');
});

test('nextSectionKey is derived from the DB, so a dead session resumes where it stopped', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  await terminalContractService.runClause({ sessionId: 's1' });
  // Nothing is remembered in process — a fresh read answers the same thing.
  const state = await terminalContractService.getState({ sessionId: 's1' });
  assert.equal(state.acceptedCount, 2);
  assert.equal(state.nextSectionKey, TC_SECTIONS[2].key);
});

test('a failed clause persists NOTHING, so the resume lands on that exact clause', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  spinClient.userChoice = async () => {
    const err = new Error('gateway said no');
    err.spinStatusCode = '2201';
    throw err;
  };
  await assert.rejects(() => terminalContractService.runClause({ sessionId: 's1' }), /gateway said no/);
  assert.equal(store.acceptances.length, 1, 'the failed clause wrote no row');
  const state = await terminalContractService.getState({ sessionId: 's1' });
  assert.equal(state.nextSectionKey, TC_SECTIONS[1].key);
});

test('re-sending a clause overwrites its own row — one answer per question, never two', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  await terminalContractService.runClause({ sessionId: 's1', sectionKey: TC_SECTIONS[0].key });
  assert.equal(store.acceptances.length, 1);
  assert.equal(store.acceptances.filter((r) => r.sectionKey === TC_SECTIONS[0].key).length, 1);
});

// ---------------------------------------------------------------------------
// Decline stops the sequence
// ---------------------------------------------------------------------------

test('a decline is recorded and STOPS the sequence', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  spinClient.userChoice = async () => ({
    SelectedOption: CONTRACT_CHOICE.DECLINE,
    GeneralResponse: { ResultCode: '0', StatusCode: '0000', Message: 'Success' },
  });
  const out = await terminalContractService.runClause({ sessionId: 's1' });

  assert.equal(out.accepted, false);
  assert.equal(out.state, TERMINAL_STATES.DECLINED_BY_RENTER);
  assert.equal(out.verdict, VERDICTS.STOP);
  assert.equal(out.declinedSectionKey, TC_SECTIONS[1].key);
  // Recorded, not swallowed: the reason the checkout stopped is on the record.
  const row = store.acceptances.find((r) => r.sectionKey === TC_SECTIONS[1].key);
  assert.equal(row.choiceOption, CONTRACT_CHOICE.DECLINE);
  assert.equal(row.accepted, false);

  // There is no next clause while a decline stands.
  assert.equal(out.nextSectionKey, null);
  await assert.rejects(
    () => terminalContractService.runClause({ sessionId: 's1' }),
    (e) => e.code === 'CLAUSE_DECLINED',
  );
});

test('a declined contract cannot be signed', async () => {
  store.acceptances = TC_SECTIONS.map((s, i) => ({
    sectionKey: s.key, sectionLabel: s.label, sectionBody: s.body,
    choiceOption: i === 2 ? CONTRACT_CHOICE.DECLINE : CONTRACT_CHOICE.ACCEPT,
    accepted: i !== 2, acceptedAt: new Date(), inkDataUrl: null,
  }));
  await assert.rejects(
    () => terminalContractService.captureSignature({ sessionId: 's1' }),
    (e) => e.code === 'CLAUSE_DECLINED',
  );
  assert.equal(spinCalls.filter((c) => c.op === 'getSignature').length, 0, 'never reached the device');
});

test('the agent can re-send the declined clause after talking to the renter', async () => {
  store.acceptances = [{
    sectionKey: TC_SECTIONS[0].key, sectionLabel: TC_SECTIONS[0].label,
    sectionBody: TC_SECTIONS[0].body, choiceOption: CONTRACT_CHOICE.DECLINE,
    accepted: false, acceptedAt: new Date(), inkDataUrl: null,
  }];
  const out = await terminalContractService.runClause({ sessionId: 's1', sectionKey: TC_SECTIONS[0].key });
  assert.equal(out.accepted, true);
  assert.equal(out.declinedSectionKey, null);
});

// ---------------------------------------------------------------------------
// The signature, and the half-signed invariant
// ---------------------------------------------------------------------------

test('the signature is refused until every clause is accepted', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  await assert.rejects(
    () => terminalContractService.captureSignature({ sessionId: 's1' }),
    (e) => e.code === 'CLAUSES_INCOMPLETE',
  );
  assert.equal(store.txBatches.length, 0, 'nothing was written');
});

test('signing writes ONE GetSignature and one AgreementSectionInitial per section', async () => {
  await acceptAllClauses();
  await terminalContractService.captureSignature({ sessionId: 's1' });
  assert.equal(spinCalls.filter((c) => c.op === 'getSignature').length, 1);
  assert.equal(store.initialUpserts.length, TC_SECTIONS.length);
});

test('the persisted initial shape is IDENTICAL to the phone path — same table, same columns', async () => {
  await acceptAllClauses();
  await terminalContractService.captureSignature({ sessionId: 's1' });
  for (const op of store.initialUpserts) {
    assert.deepEqual(
      Object.keys(op.where.agreementId_sectionKey).sort(),
      ['agreementId', 'sectionKey'],
    );
    assert.deepEqual(
      Object.keys(op.create).sort(),
      ['agreementId', 'customerIp', 'initialDataUrl', 'sectionKey', 'sectionLabel', 'signedAt'],
    );
    assert.ok(op.create.initialDataUrl.startsWith('data:image/png;base64,'));
    assert.ok(op.create.signedAt instanceof Date);
  }
});

test('ONE ink capture is bound to every section, but each keeps its OWN signedAt', async () => {
  await acceptAllClauses();
  // Make the acceptance timestamps genuinely distinct, the way six real taps
  // thirty seconds apart would be.
  store.acceptances.forEach((r, i) => { r.acceptedAt = new Date(1_700_000_000_000 + i * 30_000); });
  await terminalContractService.captureSignature({ sessionId: 's1' });

  const inks = new Set(store.initialUpserts.map((op) => op.create.initialDataUrl));
  assert.equal(inks.size, 1, 'one ink capture, shared');
  const stamps = store.initialUpserts.map((op) => op.create.signedAt.getTime());
  assert.equal(new Set(stamps).size, TC_SECTIONS.length, 'six distinct acceptance times, not six copies of one');
  assert.deepEqual(stamps, store.acceptances.map((r) => r.acceptedAt.getTime()));
});

test('initials AND tcCompletedAt land in ONE transaction — no half-signed window', async () => {
  await acceptAllClauses();
  await terminalContractService.captureSignature({ sessionId: 's1' });
  assert.equal(store.txBatches.length, 1, 'exactly one transaction');
  // sections + the agreement update + the session update.
  assert.equal(store.txBatches[0].length, TC_SECTIONS.length + 2);
});

test('BOTH paths stamp tcCompletedAt, and the terminal path bumps stateVersion like the web one', async () => {
  await acceptAllClauses();
  await terminalContractService.captureSignature({ sessionId: 's1' });
  const sessionWrite = store.sessionUpdates.at(-1);
  assert.ok(sessionWrite.data.tcCompletedAt instanceof Date);
  assert.deepEqual(sessionWrite.data.stateVersion, { increment: 1 });

  // The field name is the contract between the two paths and the state
  // machine's ENTRY_REQUIRES guard. Read it out of the sources so a rename on
  // either side fails here rather than at a counter.
  const web = fs.readFileSync(path.join(here, 'terms-signing.service.js'), 'utf8');
  const machine = fs.readFileSync(path.join(here, 'state-machine.js'), 'utf8');
  assert.match(web, /tcCompletedAt: new Date\(\)/);
  assert.match(machine, /TC_SIGNED:\s*'tcCompletedAt'/);
});

test('the agreement gets the signature on the same columns the phone path uses', async () => {
  await acceptAllClauses();
  await terminalContractService.captureSignature({ sessionId: 's1' });
  const upd = store.agreementUpdates.at(-1);
  assert.ok(upd.data.tcSignatureDataUrl.startsWith('data:image/png;base64,'));
  assert.ok(upd.data.tcSignedAt instanceof Date);
  // No signer name and no IP: the renter signed on the counter's own device,
  // so the only IP available is the branch's, and recording that as the
  // signer's would be a fabricated provenance fact on a legal record.
  assert.equal(upd.data.tcSignerName, null);
  assert.equal(upd.data.tcCustomerIp, null);
});

test('a blank signature is refused — a blank canvas is a valid PNG', async () => {
  await acceptAllClauses();
  spinClient.getSignature = async () => ({
    Signature: BLANK_PNG,
    GeneralResponse: { StatusCode: '0000', Message: 'OK' },
  });
  await assert.rejects(
    () => terminalContractService.captureSignature({ sessionId: 's1' }),
    (e) => e.code === 'SIGNATURE_BLANK' || e.code === 'SIGNATURE_MISSING',
  );
  assert.equal(store.txBatches.length, 0);
});

test('a missing signature image is refused rather than persisted as an empty initial', async () => {
  await acceptAllClauses();
  spinClient.getSignature = async () => ({ GeneralResponse: { StatusCode: '0000', Message: 'OK' } });
  await assert.rejects(
    () => terminalContractService.captureSignature({ sessionId: 's1' }),
    (e) => e.code === 'SIGNATURE_MISSING',
  );
  assert.equal(store.txBatches.length, 0);
});

test('a failed GetSignature keeps every accepted clause — the resume is at the signature', async () => {
  await acceptAllClauses();
  spinClient.getSignature = async () => {
    const err = new Error('terminal not connected');
    err.spinStatusCode = '2001';
    throw err;
  };
  await assert.rejects(() => terminalContractService.captureSignature({ sessionId: 's1' }));
  const state = await terminalContractService.getState({ sessionId: 's1' });
  assert.equal(state.acceptedCount, TC_SECTIONS.length);
  assert.equal(state.allAccepted, true);
  assert.equal(state.signatureCaptured, false);
});

test('base64 from the terminal becomes a data URL — the same KIND of artifact the phone stores', () => {
  assert.equal(normalizeSignaturePayload('AAA'), 'data:image/png;base64,AAA');
  // Already-a-data-URL passes through, so nothing is ever double-wrapped.
  assert.equal(normalizeSignaturePayload('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(normalizeSignaturePayload(''), '');
  assert.equal(normalizeSignaturePayload(null), '');
});

// ---------------------------------------------------------------------------
// Per-clause ink — the later switch
// ---------------------------------------------------------------------------

test('inkForSection is the ONE branch that turns per-clause ink on', () => {
  const contract = 'data:image/png;base64,CONTRACT';
  assert.equal(inkForSection({ inkDataUrl: null }, contract), contract);
  assert.equal(inkForSection(undefined, contract), contract);
  assert.equal(inkForSection({ inkDataUrl: 'data:image/png;base64,CLAUSE' }, contract), 'data:image/png;base64,CLAUSE');
});

test('per-clause ink, when present, is what lands on that section\'s initial', async () => {
  await acceptAllClauses();
  store.acceptances[2].inkDataUrl = 'data:image/png;base64,CLAUSE3';
  await terminalContractService.captureSignature({ sessionId: 's1' });
  const third = store.initialUpserts.find((op) => op.where.agreementId_sectionKey.sectionKey === TC_SECTIONS[2].key);
  assert.equal(third.create.initialDataUrl, 'data:image/png;base64,CLAUSE3');
  const first = store.initialUpserts.find((op) => op.where.agreementId_sectionKey.sectionKey === TC_SECTIONS[0].key);
  assert.ok(first.create.initialDataUrl.startsWith('data:image/png;base64,iVBOR'), 'others still take the contract ink');
});

// ---------------------------------------------------------------------------
// Clause length — build-time for the canonical six, run-time for overrides
// ---------------------------------------------------------------------------

test('BUILD-TIME: every canonical clause in the STANDARD six fits the 250-character cap', () => {
  for (const s of TC_SECTIONS) {
    const len = s.body.trim().length;
    assert.ok(len <= USER_CHOICE_TITLE_MAX,
      `${s.key} is ${len} chars — over the ${USER_CHOICE_TITLE_MAX} cap the terminal enforces. `
      + 'Shorten it, or the terminal path stops working for every tenant.');
  }
  // The margin is real and small — 245 of 250 on insurance_coverage, which is
  // the clause the live probe ran. If this ever drops, the "no 4 / 6 prefix on
  // the Title" decision is what bought the room, and it reopens.
  const longest = Math.max(...TC_SECTIONS.map((s) => s.body.trim().length));
  assert.equal(longest, 245, `longest canonical clause is ${longest}, was 245 when this was measured`);
});

test('BUILD-TIME: the declined-insurance addendum is over the cap, and stays measured', () => {
  // Pinned as a KNOWN GAP rather than asserted to fit. If someone shortens it
  // to 250 or less, this fails and the terminal path opens up for
  // declined-insurance checkouts — which is a legal-text change that should be
  // noticed, not discovered at a counter.
  const len = DECLINED_INSURANCE_SECTION.body.trim().length;
  assert.equal(len, 274, `declined_insurance is ${len} chars, was 274 when measured`);
  assert.ok(len > USER_CHOICE_TITLE_MAX);
});

test('an over-length per-tenant override is REFUSED, never truncated', () => {
  const over = [{ key: 'k', label: 'L', body: 'x'.repeat(USER_CHOICE_TITLE_MAX + 1) }];
  assert.throws(() => assertClausesFitTerminal(over), (e) => e.code === 'CLAUSE_TOO_LONG_FOR_TERMINAL');
  assert.doesNotThrow(() => assertClausesFitTerminal([{ key: 'k', label: 'L', body: 'x'.repeat(USER_CHOICE_TITLE_MAX) }]));
});

test('an over-length override stops the clause BEFORE the device is touched', async () => {
  reset({ sectionOverrides: JSON.stringify({ deposit_post_charges: { body: 'y'.repeat(400) } }) });
  await assert.rejects(
    () => terminalContractService.runClause({ sessionId: 's1' }),
    (e) => e.code === 'CLAUSE_TOO_LONG_FOR_TERMINAL' && /deposit_post_charges \(400 chars\)/.test(e.message),
  );
  assert.equal(spinCalls.length, 0);
});

test('getState surfaces the length problem without breaking the read', async () => {
  reset({ sectionOverrides: JSON.stringify({ rental_period: { body: 'z'.repeat(300) } }) });
  const state = await terminalContractService.getState({ sessionId: 's1' });
  assert.match(state.clauseLengthError, /too long for the terminal/);
});

test('a PHONE tenant is never told its clause text is too long for a device it does not use', async () => {
  reset({ contractMode: 'PHONE', sectionOverrides: JSON.stringify({ rental_period: { body: 'z'.repeat(300) } }) });
  const state = await terminalContractService.getState({ sessionId: 's1' });
  assert.equal(state.mode, 'PHONE');
  assert.equal(state.clauseLengthError, null);
});

// ---------------------------------------------------------------------------
// Terminal state vocabulary
// ---------------------------------------------------------------------------

test('2008 is BUSY/WAIT and honours the gateway\'s own DelayBeforeNextRequest', () => {
  const err = new Error('Terminal in use, please wait 30 sec');
  err.spinStatusCode = '2008';
  err.spinResponse = { DelayBeforeNextRequest: 45, GeneralResponse: { StatusCode: '2008' } };
  const v = classifyTerminalError(err);
  assert.equal(v.state, TERMINAL_STATES.BUSY);
  assert.equal(v.verdict, VERDICTS.WAIT);
  assert.equal(v.retryAfterSeconds, 45, 'the countdown is what the gateway said, not a hardcoded 30');
});

test('a 2008 with no readable delay falls back to 30 — never to zero', () => {
  for (const body of [{}, { DelayBeforeNextRequest: '' }, { DelayBeforeNextRequest: -5 }, { DelayBeforeNextRequest: 99999 }]) {
    assert.equal(busyDelaySeconds(body), DEFAULT_BUSY_DELAY_SECONDS);
  }
  // Zero would mean "retry now", which is the one answer we know is wrong.
  assert.ok(busyDelaySeconds({}) > 0);
});

test('the delay is read from every shape the proxy has been seen to use', () => {
  assert.equal(busyDelaySeconds({ DelayBeforeNextRequest: 12 }), 12);
  assert.equal(busyDelaySeconds({ GeneralResponse: { DelayBeforeNextRequest: 13 } }), 13);
  assert.equal(busyDelaySeconds({ spinResponse: { DelayBeforeNextRequest: 14 } }), 14);
  assert.equal(busyDelaySeconds({ delayBeforeNextRequest: '15.2' }), 16, 'rounded up, never down');
});

test('2201 is GATEWAY_REJECTED and NEVER RETRY — the terminal never saw the payload', () => {
  const err = new Error('rejected');
  err.spinStatusCode = '2201';
  const v = classifyTerminalError(err);
  assert.equal(v.state, TERMINAL_STATES.GATEWAY_REJECTED);
  assert.equal(v.verdict, VERDICTS.FALL_BACK);
  assert.notEqual(v.verdict, VERDICTS.RETRY);
});

test('2001 is TERMINAL_OFFLINE → FALL BACK', () => {
  const err = new Error('not connected');
  err.spinStatusCode = '2001';
  const v = classifyTerminalError(err);
  assert.equal(v.state, TERMINAL_STATES.TERMINAL_OFFLINE);
  assert.equal(v.verdict, VERDICTS.FALL_BACK);
});

test('a client timeout is TIMED_OUT → RETRY (nothing was signed)', () => {
  const err = new Error('SPIn request timed out');
  err.spinTimeout = true;
  const v = classifyTerminalError(err);
  assert.equal(v.state, TERMINAL_STATES.TIMED_OUT);
  assert.equal(v.verdict, VERDICTS.RETRY);
});

test('TERMINAL_NOT_CONFIGURED is STOP — a config problem no button fixes', () => {
  const v = classifyTerminalError({ code: 'TERMINAL_NOT_CONFIGURED', message: 'nope' });
  assert.equal(v.state, TERMINAL_STATES.NOT_CONFIGURED);
  assert.equal(v.verdict, VERDICTS.STOP);
});

test('an unrecognized failure falls back rather than retrying blind', () => {
  const v = classifyTerminalError(new Error('who knows'));
  assert.equal(v.verdict, VERDICTS.FALL_BACK);
});

test('success is matched on the CODES, never on the message text', () => {
  // UserChoice answers "Success"; Disclaimer and GetSignature answer "OK" — on
  // the same device, in the same session. Keying off the message would treat
  // one of the three as a failure.
  assert.equal(isSpinOk({ GeneralResponse: { ResultCode: '0', StatusCode: '0000', Message: 'Success' } }), true);
  assert.equal(isSpinOk({ GeneralResponse: { ResultCode: 0, StatusCode: '0000', Message: 'OK' } }), true);
  assert.equal(isSpinOk({ GeneralResponse: { ResultCode: '2', StatusCode: '2201', Message: 'Success' } }), false);
  assert.equal(isSpinOk({}), false);
  assert.equal(isSpinOk(null), false);
});

test('a terminal failure carries its classification out to the route', async () => {
  spinClient.userChoice = async () => {
    const err = new Error('busy');
    err.spinStatusCode = '2008';
    err.spinResponse = { DelayBeforeNextRequest: 20 };
    throw err;
  };
  await assert.rejects(() => terminalContractService.runClause({ sessionId: 's1' }), (e) => {
    assert.equal(e.code, 'TERMINAL_ERROR');
    assert.equal(e.terminal.state, TERMINAL_STATES.BUSY);
    assert.equal(e.terminal.retryAfterSeconds, 20);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Config: default OFF, per-location override
// ---------------------------------------------------------------------------

test('the contract mode defaults to PHONE and only the exact string TERMINAL flips it', () => {
  for (const bad of [undefined, null, '', 'terminal', 'TERMINAL ', true, 1, {}, 'PHONE']) {
    assert.equal(normalizeContractMode(bad), 'PHONE', `${String(bad)} must resolve to PHONE`);
  }
  assert.equal(normalizeContractMode('TERMINAL'), 'TERMINAL');
});

test('an unconfigured tenant resolves to PHONE', async () => {
  cache.clear();
  prisma.appSetting.findUnique = async () => null;
  const out = await resolveContractMode('ten-unknown', { locationId: 'loc1' });
  assert.equal(out.mode, 'PHONE');
  assert.equal(out.source, 'DEFAULT');
});

test('a location override beats the tenant, in BOTH directions', async () => {
  reset({ contractMode: 'PHONE', locations: { loc1: 'TERMINAL' } });
  let out = await resolveContractMode('ten1', { locationId: 'loc1' });
  assert.equal(out.mode, 'TERMINAL');
  assert.equal(out.source, 'LOCATION');

  reset({ contractMode: 'TERMINAL', locations: { loc1: 'PHONE' } });
  out = await resolveContractMode('ten1', { locationId: 'loc1' });
  assert.equal(out.mode, 'PHONE');
  assert.equal(out.source, 'LOCATION');
});

test('a PHONE checkout refuses every terminal operation', async () => {
  reset({ contractMode: 'PHONE' });
  for (const fn of [
    () => terminalContractService.runClause({ sessionId: 's1' }),
    () => terminalContractService.captureSignature({ sessionId: 's1' }),
  ]) {
    await assert.rejects(fn, (e) => e.code === 'CONTRACT_MODE_NOT_TERMINAL');
  }
  assert.equal(spinCalls.length, 0);
});

test('a counter with no configured terminal fails CLOSED before any prompt', async () => {
  reset({ terminal: false });
  await assert.rejects(
    () => terminalContractService.runClause({ sessionId: 's1' }),
    (e) => e.code === 'TERMINAL_NOT_CONFIGURED',
  );
  assert.equal(spinCalls.length, 0);
});

test('the prompt runs on the register resolved for the PICKUP location', async () => {
  reset();
  prisma.appSetting.findUnique = async ({ where }) => {
    if (where.key === 'tenant:ten1:checkoutContractPolicy') {
      return { value: JSON.stringify({ mode: 'TERMINAL', locations: {} }) };
    }
    if (where.key === 'tenant:ten1:paymentGatewayConfig') {
      return {
        value: JSON.stringify({
          registers: [
            { id: 'r-lax', name: 'LAX Counter 1', locationId: 'loc1', authKey: 'AK1', tpn: '111122223333' },
            { id: 'r-mco', name: 'Orlando', locationId: 'loc2', authKey: 'AK2', tpn: '444455556666' },
          ],
        }),
      };
    }
    return null;
  };
  await terminalContractService.runClause({ sessionId: 's1' });
  assert.equal(spinCalls[0].cfg.spinTpn, '111122223333');
  assert.equal(store.acceptances[0].registerId, 'r-lax');
});

// ---------------------------------------------------------------------------
// Fallback to the phone, carrying the accepted clauses
// ---------------------------------------------------------------------------

test('the fallback carries the ACCEPTED clauses over and records the decision', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  await terminalContractService.runClause({ sessionId: 's1' });
  spinClient.userChoice = async () => ({
    SelectedOption: 'garbled', GeneralResponse: { StatusCode: '0000' },
  });
  await terminalContractService.runClause({ sessionId: 's1' });

  const out = await terminalContractService.switchToPhone({ sessionId: 's1', reason: 'TERMINAL_OFFLINE' });
  assert.deepEqual(out.carriedOverSectionKeys, [TC_SECTIONS[0].key, TC_SECTIONS[1].key]);

  const ev = JSON.parse(store.sessionUpdates.at(-1).data.events).at(-1);
  assert.equal(ev.kind, 'CONTRACT_FELL_BACK_TO_PHONE');
  assert.equal(ev.reason, 'TERMINAL_OFFLINE');
  assert.deepEqual(ev.clausesCarriedOver, [TC_SECTIONS[0].key, TC_SECTIONS[1].key]);
});

test('the fallback writes NO AgreementSectionInitial — there is no ink yet', async () => {
  await acceptAllClauses();
  await terminalContractService.switchToPhone({ sessionId: 's1' });
  assert.equal(store.initialUpserts.length, 0);
  assert.equal(store.txBatches.length, 0);
});

test('terminalAcceptedSectionKeys is what the phone flow reads, and it is accepted-only', async () => {
  await terminalContractService.runClause({ sessionId: 's1' });
  spinClient.userChoice = async () => ({
    SelectedOption: CONTRACT_CHOICE.DECLINE, GeneralResponse: { StatusCode: '0000' },
  });
  await terminalContractService.runClause({ sessionId: 's1' });
  const keys = await terminalContractService.terminalAcceptedSectionKeys('ag1');
  assert.deepEqual(keys, [TC_SECTIONS[0].key]);
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

test('buildLadder is pure and answers the whole agent screen', () => {
  const sections = TC_SECTIONS.slice(0, 3);
  const l = buildLadder(sections, [
    { sectionKey: sections[0].key, accepted: true, choiceOption: CONTRACT_CHOICE.ACCEPT, acceptedAt: new Date(1) },
  ]);
  assert.equal(l.total, 3);
  assert.equal(l.acceptedCount, 1);
  assert.equal(l.nextSectionKey, sections[1].key);
  assert.equal(l.allAccepted, false);
  assert.equal(l.clauses[0].accepted, true);
  assert.equal(l.clauses[0].choiceOption, CONTRACT_CHOICE.ACCEPT);
  assert.equal(l.clauses[1].accepted, false);
});

test('a declined clause suppresses nextSectionKey — the sequence has stopped', () => {
  const sections = TC_SECTIONS.slice(0, 3);
  const l = buildLadder(sections, [
    { sectionKey: sections[0].key, accepted: false, choiceOption: CONTRACT_CHOICE.DECLINE, acceptedAt: new Date(1) },
  ]);
  assert.equal(l.declinedSectionKey, sections[0].key);
  assert.equal(l.nextSectionKey, null);
});

test('getState hands the agent the exact button labels the terminal will show', async () => {
  const state = await terminalContractService.getState({ sessionId: 's1' });
  assert.equal(state.acceptOption, CONTRACT_CHOICE.ACCEPT);
  assert.equal(state.declineOption, CONTRACT_CHOICE.DECLINE);
  assert.equal(state.mode, 'TERMINAL');
  assert.equal(state.total, TC_SECTIONS.length);
});

// ---------------------------------------------------------------------------
// Structural: the minimal-payload discipline the 2201 lesson bought
// ---------------------------------------------------------------------------

test('userChoice still sends ONLY Title + ChoiceOptions beyond the common block', () => {
  const src = fs.readFileSync(path.join(here, '../payment-gateway/spin-client.js'), 'utf8');
  const body = src.slice(src.indexOf('async userChoice('), src.indexOf('async getSignature('));
  assert.match(body, /spinRequest\('POST', 'v2\/Common\/UserChoice', \{ Title: text, ChoiceOptions: choices \}, tenantConfig\)/);
  for (const forbidden of ['Amount', 'CaptureSignature', 'GetToken', 'EnableTip', 'PrintReceipt']) {
    assert.equal(body.includes(forbidden), false, `${forbidden} must not ride along`);
  }
});

test('the sequencer never truncates a clause on its way to the terminal', () => {
  const src = fs.readFileSync(path.join(here, 'terminal-contract.service.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function clauseTitle('), src.indexOf('export function isAcceptChoice('));
  assert.equal(/\.slice\(/.test(fn), false, 'silently cutting a clause changes what was agreed');
  assert.equal(/\.substring\(/.test(fn), false);
});

test('the routes carry no amount — this step moves no money', () => {
  const routes = fs.readFileSync(path.join(here, 'checkout-session.routes.js'), 'utf8');
  const block = routes.slice(
    routes.indexOf("checkoutSessionRouter.get('/:id/terminal-contract'"),
    routes.indexOf("checkoutSessionRouter.post('/:id/handoff-token'"),
  );
  assert.ok(block.length > 0);
  for (const forbidden of ['amount', 'Amount', 'depositAmount', 'charge']) {
    assert.equal(block.includes(forbidden), false, `${forbidden} has no business on the contract routes`);
  }
});
