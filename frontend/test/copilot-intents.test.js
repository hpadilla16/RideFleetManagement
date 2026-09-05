/**
 * Agent Copilot Phase 1 — the intent map, the matcher, and the pre-flight.
 * Pins, in order:
 *  (1) map integrity: unique keys, every tourModuleKey is a real curriculum
 *      module, every articleSlug is a real Ride University slug (checked
 *      against the backend catalog itself), every intent carries a source and
 *      a bilingual summary — the "never invents" guardrail as a shape rule
 *  (2) matching: EN and ES phrasings land on the right intent (the owner's
 *      example verbatim), and questions the map does not cover return null
 *  (3) ctasFor: role gating — an AGENT asking about admin screens gets
 *      adminOnly (article kept, tour and navigation withheld)
 *  (4) preflightFor: the four outcomes, derived from the curriculum
 *  (5) the miss log: ring buffer semantics + flagging
 */
import { describe, it, expect } from 'vitest';
import {
  INTENTS, matchIntent, findIntent, ctasFor,
  preflightFor, PREFLIGHT, reservationIdFromPath, screenNameFor,
  normalize, logMiss, readMisses, flagLastMiss, MISS_LOG_MAX,
} from '../src/lib/training/intents.js';
import { allModules, findModule } from '../src/lib/training/curriculum.js';
import { DEFAULT_ARTICLES } from '../../backend/src/modules/knowledge-base/default-articles.js';

const AGENT = { role: 'AGENT' };
const ADMIN = { role: 'ADMIN' };

describe('intent map integrity', () => {
  it('every intent key is unique — misses and telemetry are stored against it', () => {
    const keys = INTENTS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every tourModuleKey names a real curriculum module', () => {
    for (const intent of INTENTS) {
      if (!intent.tourModuleKey) continue;
      expect(findModule(intent.tourModuleKey), `${intent.key} → ${intent.tourModuleKey}`).toBeTruthy();
    }
  });

  it('every articleSlug is a real Ride University slug from the backend catalog', () => {
    const slugs = new Set(DEFAULT_ARTICLES.map((a) => a.slug));
    for (const intent of INTENTS) {
      if (!intent.articleSlug) continue;
      expect(slugs.has(intent.articleSlug), `${intent.key} → ${intent.articleSlug}`).toBe(true);
    }
  });

  it("the owner's example is fully backed now: tour, article, playbook steps", () => {
    // Phase 2 left the additional-drivers intent article-less (articleSlug
    // null). The article shipped with the closers — the card gains the live
    // body and the "Ver artículo" deep link, and losing the slug again would
    // be a silent regression the generic loop above cannot see.
    const intent = findIntent('additional-drivers');
    expect(intent.articleSlug).toBe('additional-drivers');
    expect(intent.tourModuleKey).toBe('additional-drivers');
    expect(intent.steps?.en?.length).toBeTruthy();
  });

  it('no source, no answer — every intent carries a source and a bilingual summary', () => {
    for (const intent of INTENTS) {
      expect(intent.source?.label, `${intent.key} source`).toBeTruthy();
      expect(intent.summary?.en, `${intent.key} summary.en`).toBeTruthy();
      expect(intent.summary?.es, `${intent.key} summary.es`).toBeTruthy();
      expect(intent.aliases?.en?.length, `${intent.key} aliases.en`).toBeTruthy();
      expect(intent.aliases?.es?.length, `${intent.key} aliases.es`).toBeTruthy();
    }
  });

  it('curated steps and gotchas, when present, exist in both languages', () => {
    for (const intent of INTENTS) {
      if (intent.steps) {
        expect(intent.steps.en?.length, `${intent.key} steps.en`).toBeTruthy();
        expect(intent.steps.es?.length, `${intent.key} steps.es`).toBeTruthy();
        expect(intent.steps.en.length).toBe(intent.steps.es.length);
      }
      if (intent.gotcha) {
        expect(intent.gotcha.en, `${intent.key} gotcha.en`).toBeTruthy();
        expect(intent.gotcha.es, `${intent.key} gotcha.es`).toBeTruthy();
      }
    }
  });

  it('every curriculum module a staffer can be taught is reachable from some intent', () => {
    // The reverse-coverage check: a module with no intent is a question the
    // copilot cannot route to a walkthrough anyone can ask for.
    const mapped = new Set(INTENTS.map((i) => i.tourModuleKey).filter(Boolean));
    for (const m of allModules()) {
      expect(mapped.has(m.key), `curriculum module ${m.key} has no intent`).toBe(true);
    }
  });
});

describe('matching — EN and ES phrasings', () => {
  it('every alias of every intent resolves to ITS OWN intent — no alias is shadowed by another', () => {
    // Innovation, 2026-09-04: the kiosk course added 60+ aliases and nothing
    // asserted they do not collide with what was there. This does, for all.
    const wrong = [];
    for (const intent of INTENTS) {
      for (const lang of ['en', 'es']) {
        for (const alias of intent.aliases?.[lang] || []) {
          const got = matchIntent(alias)?.intent?.key;
          if (got !== intent.key) wrong.push(`${lang} "${alias}" → ${got || 'MISS'} (wanted ${intent.key})`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it("the owner's example, verbatim, in both languages", () => {
    expect(matchIntent('¿Cómo añado un conductor adicional?')?.intent.key).toBe('additional-drivers');
    expect(matchIntent('How do I add an additional driver?')?.intent.key).toBe('additional-drivers');
    expect(matchIntent('cómo pongo otro chofer')?.intent.key).toBe('additional-drivers');
  });

  it('counter work routes to the record-scoped modules', () => {
    expect(matchIntent('como hago un check-out')?.intent.key).toBe('check-out');
    expect(matchIntent('how do I check in a vehicle')?.intent.key).toBe('check-in');
    expect(matchIntent('¿cómo cobro un pago?')?.intent.key).toBe('take-payment');
    expect(matchIntent('how do i take a payment')?.intent.key).toBe('take-payment');
  });

  it('accents and punctuation never decide a match', () => {
    expect(normalize('¿Cómo añado un conductor adicional?')).toBe('como anado un conductor adicional');
    expect(matchIntent('COBRAR UN PAGO')?.intent.key).toBe('take-payment');
  });

  it('article-only intents match too', () => {
    expect(matchIntent('el cliente disputa un daño')?.intent.key).toBe('damage-disputes');
    expect(matchIntent('how do I process toll charges')?.intent.key).toBe('tolls');
    expect(matchIntent('renta mensual')?.intent.key).toBe('monthly-rentals');
    expect(matchIntent('multa de tránsito')?.intent.key).toBe('citations');
  });

  it('what the map does not cover is a MISS, not a guess', () => {
    expect(matchIntent('¿Cómo configuro el descuento de AAA?')).toBeNull();
    expect(matchIntent('how do I fly to the moon')).toBeNull();
    expect(matchIntent('')).toBeNull();
    expect(matchIntent('   ¿ ?  ')).toBeNull();
  });
});

describe('ctasFor — role & gate awareness (guardrail 4)', () => {
  it('an ADMIN gets the tour for an admin module', () => {
    const intent = findIntent('users-and-locations');
    const ctas = ctasFor(intent, ADMIN);
    expect(ctas.teach).toBe(true);
    expect(ctas.adminOnly).toBe(false);
    expect(ctas.go).toBe('/people');
    expect(ctas.article).toBe('security-basics-for-agents');
  });

  it('an AGENT asking the same question gets the honest adminOnly answer — article kept, tour and navigation withheld', () => {
    const ctas = ctasFor(findIntent('users-and-locations'), AGENT);
    expect(ctas.teach).toBe(false);
    expect(ctas.adminOnly).toBe(true);
    expect(ctas.go).toBeNull();
    expect(ctas.article).toBe('security-basics-for-agents');
  });

  it('a tenant module gate withholds the tour the same way a role does', () => {
    const viewer = { role: 'ADMIN', isModuleEnabled: (key) => key !== 'marketIntelligence' };
    const ctas = ctasFor(findIntent('market-pricing'), viewer);
    expect(ctas.teach).toBe(false);
    expect(ctas.adminOnly).toBe(true);
  });

  it('an intent with no tour degrades honestly: navigation and article only', () => {
    const ctas = ctasFor(findIntent('tolls'), AGENT);
    expect(ctas.teach).toBe(false);
    expect(ctas.adminOnly).toBe(false);
    expect(ctas.go).toBe('/tolls');
    expect(ctas.article).toBe('processing-toll-charges');
  });

  it("the owner's example now teaches (Phase 2): the micro-module closed the map's flagship gap", () => {
    const intent = findIntent('additional-drivers');
    expect(intent.tourModuleKey).toBe('additional-drivers');
    const mod = findModule('additional-drivers');
    expect(mod.needsRecord).toBe('/reservations');
    const ctas = ctasFor(intent, AGENT);
    expect(ctas.teach).toBe(true);
    expect(ctas.adminOnly).toBe(false);
    // Record-scoped, so the pre-flight question fires exactly like check-out.
    expect(preflightFor(mod, '/reservations/R-1').kind).toBe(PREFLIGHT.ASK_HERE);
    expect(preflightFor(mod, '/dashboard')).toEqual({ kind: PREFLIGHT.NEEDS_RECORD, go: '/reservations' });
  });
});

describe('preflightFor — the four outcomes, derived from the curriculum', () => {
  it('record-scoped + a reservation open → ASK_HERE with the record id (a question, never a blind dispatch)', () => {
    const out = preflightFor(findModule('check-out'), '/reservations/abc-123');
    expect(out).toEqual({ kind: PREFLIGHT.ASK_HERE, recordId: 'abc-123' });
  });

  it('record-scoped + no reservation open → NEEDS_RECORD pointing at the list', () => {
    const out = preflightFor(findModule('take-payment'), '/dashboard');
    expect(out).toEqual({ kind: PREFLIGHT.NEEDS_RECORD, go: '/reservations' });
  });

  it('/reservations/new is the wizard, not a record', () => {
    expect(reservationIdFromPath('/reservations/new')).toBeNull();
    expect(preflightFor(findModule('check-in'), '/reservations/new').kind).toBe(PREFLIGHT.NEEDS_RECORD);
  });

  it('route-anchored + elsewhere → NAVIGATE to the first step route (announced, never silent)', () => {
    const out = preflightFor(findModule('shuttle-dispatch'), '/');
    expect(out).toEqual({ kind: PREFLIGHT.NAVIGATE, to: '/shuttles' });
  });

  it('route-anchored + already there → HERE', () => {
    expect(preflightFor(findModule('shuttle-dispatch'), '/shuttles').kind).toBe(PREFLIGHT.HERE);
    expect(preflightFor(findModule('the-workspace'), '/').kind).toBe(PREFLIGHT.HERE);
  });

  it('every record-scoped curriculum module derives ASK_HERE inside a record and NEEDS_RECORD outside', () => {
    for (const m of allModules().filter((x) => x.needsRecord)) {
      expect(preflightFor(m, '/reservations/r-1').kind, m.key).toBe(PREFLIGHT.ASK_HERE);
      expect(preflightFor(m, m.needsRecord).kind, m.key).toBe(PREFLIGHT.NEEDS_RECORD);
    }
  });

  it('screen names exist for every route the map can navigate to', () => {
    for (const intent of INTENTS) {
      const mod = intent.tourModuleKey ? findModule(intent.tourModuleKey) : null;
      const first = mod?.steps?.[0];
      if (first?.route) {
        expect(screenNameFor(first.route, 'en'), `${intent.key} → ${first.route}`).not.toBe(first.route);
        expect(screenNameFor(first.route, 'es'), `${intent.key} → ${first.route}`).toBeTruthy();
      }
    }
  });
});

describe('the miss log — ring buffer + flagging', () => {
  function fakeStorage() {
    const bag = new Map();
    return {
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => bag.set(k, String(v)),
    };
  }

  it('records question, language and timestamp', () => {
    const store = fakeStorage();
    logMiss('¿Cómo configuro el descuento de AAA?', { lang: 'es', storage: store });
    const list = readMisses(store);
    expect(list).toHaveLength(1);
    expect(list[0].q).toBe('¿Cómo configuro el descuento de AAA?');
    expect(list[0].lang).toBe('es');
    expect(list[0].flagged).toBe(false);
    expect(new Date(list[0].at).toString()).not.toBe('Invalid Date');
  });

  it(`keeps only the newest ${MISS_LOG_MAX} — a ring buffer, not an archive`, () => {
    const store = fakeStorage();
    for (let i = 0; i < MISS_LOG_MAX + 10; i++) logMiss(`question ${i}`, { storage: store });
    const list = readMisses(store);
    expect(list).toHaveLength(MISS_LOG_MAX);
    expect(list[0].q).toBe('question 10');
    expect(list[list.length - 1].q).toBe(`question ${MISS_LOG_MAX + 9}`);
  });

  it('flagLastMiss marks the most recent entry for an admin', () => {
    const store = fakeStorage();
    logMiss('first', { storage: store });
    logMiss('second', { storage: store });
    const flagged = flagLastMiss(store);
    expect(flagged.q).toBe('second');
    const list = readMisses(store);
    expect(list[0].flagged).toBe(false);
    expect(list[1].flagged).toBe(true);
  });

  it('a corrupt buffer degrades to empty instead of throwing', () => {
    const store = fakeStorage();
    store.setItem('copilot.misses', '{not json');
    expect(readMisses(store)).toEqual([]);
    logMiss('after corruption', { storage: store });
    expect(readMisses(store)).toHaveLength(1);
  });
});
