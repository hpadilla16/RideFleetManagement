/**
 * Tests for terms-templates.service.js (Interactive T&C V1).
 * Run: node --test backend/src/modules/terms/terms-templates.service.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarkers,
  validateTemplatePayload,
  listTemplatesForTenant,
  getTemplateById,
  createTemplate,
  updateTemplate,
  activateTemplate,
  deleteTemplate,
  getActiveTemplateForTenant,
  TermsTemplateError,
  FIELD_KINDS,
} from './terms-templates.service.js';

// ---------------------------------------------------------------------------
// In-memory fake Prisma
// ---------------------------------------------------------------------------

function makeFakePrisma({ tenants = [], templates = [], fields = [], signings = [] } = {}) {
  let nextId = 1;
  return {
    _state: { tenants, templates, fields, signings },
    tenant: {
      async findUnique({ where }) {
        return tenants.find((t) => t.id === where.id) || null;
      },
    },
    termsTemplate: {
      async findUnique({ where }) {
        if (where.id) return templates.find((t) => t.id === where.id) || null;
        if (where.tenantId_version) {
          return templates.find(
            (t) =>
              t.tenantId === where.tenantId_version.tenantId &&
              t.version === where.tenantId_version.version
          ) || null;
        }
        return null;
      },
      async findFirst({ where, include }) {
        const t = templates.find((x) => {
          if (where.id && x.id !== where.id) return false;
          if (where.tenantId && x.tenantId !== where.tenantId) return false;
          if (where.isActive !== undefined && x.isActive !== where.isActive) return false;
          return true;
        });
        if (!t) return null;
        const out = { ...t };
        if (include?.fields) {
          out.fields = fields.filter((f) => f.templateId === t.id);
        }
        if (include?._count?.select?.signings) {
          out._count = { signings: signings.filter((s) => s.templateId === t.id).length };
          if (include._count.select.fields) {
            out._count.fields = fields.filter((f) => f.templateId === t.id).length;
          }
        }
        return out;
      },
      async findMany({ where, include }) {
        const rows = templates.filter((t) => {
          if (where?.tenantId && t.tenantId !== where.tenantId) return false;
          return true;
        });
        return rows.map((t) => {
          const out = { ...t };
          if (include?._count?.select) {
            out._count = {};
            if (include._count.select.fields) {
              out._count.fields = fields.filter((f) => f.templateId === t.id).length;
            }
            if (include._count.select.signings) {
              out._count.signings = signings.filter((s) => s.templateId === t.id).length;
            }
          }
          return out;
        });
      },
      async create({ data, include }) {
        const id = `tpl_${nextId++}`;
        const row = {
          id,
          tenantId: data.tenantId,
          name: data.name,
          version: data.version,
          contentHtml: data.contentHtml,
          contentLanguage: data.contentLanguage || 'both',
          effectiveDate: data.effectiveDate,
          createdByUserId: data.createdByUserId || null,
          isActive: data.isActive || false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        templates.push(row);
        if (data.fields?.create) {
          for (const f of data.fields.create) {
            fields.push({
              id: `f_${nextId++}`,
              templateId: id,
              ...f,
            });
          }
        }
        const out = { ...row };
        if (include?.fields) out.fields = fields.filter((f) => f.templateId === id);
        return out;
      },
      async update({ where, data, include }) {
        const idx = templates.findIndex((t) => t.id === where.id);
        if (idx === -1) throw new Error('not found');
        templates[idx] = { ...templates[idx], ...data, updatedAt: new Date() };
        const out = { ...templates[idx] };
        if (include?.fields) out.fields = fields.filter((f) => f.templateId === where.id);
        return out;
      },
      async updateMany({ where, data }) {
        let n = 0;
        for (const t of templates) {
          if (where.tenantId && t.tenantId !== where.tenantId) continue;
          if (where.isActive !== undefined && t.isActive !== where.isActive) continue;
          if (where.id?.not && t.id === where.id.not) continue;
          Object.assign(t, data);
          n++;
        }
        return { count: n };
      },
      async delete({ where }) {
        const idx = templates.findIndex((t) => t.id === where.id);
        if (idx === -1) throw new Error('not found');
        const removed = templates.splice(idx, 1)[0];
        // Cascade fields
        for (let i = fields.length - 1; i >= 0; i--) {
          if (fields[i].templateId === where.id) fields.splice(i, 1);
        }
        return removed;
      },
    },
    termsTemplateField: {
      async findMany({ where, select }) {
        const rows = fields.filter((f) => {
          if (where.templateId && f.templateId !== where.templateId) return false;
          return true;
        });
        if (!select) return rows;
        return rows.map((r) => {
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
          return out;
        });
      },
      async count({ where }) {
        return fields.filter((f) => f.templateId === where.templateId).length;
      },
      async deleteMany({ where }) {
        let n = 0;
        for (let i = fields.length - 1; i >= 0; i--) {
          if (fields[i].templateId === where.templateId) {
            fields.splice(i, 1);
            n++;
          }
        }
        return { count: n };
      },
      async createMany({ data }) {
        for (const f of data) {
          fields.push({ id: `f_${nextId++}`, ...f });
        }
        return { count: data.length };
      },
    },
    $transaction: async function (fn) {
      return fn(this);
    },
  };
}

// ---------------------------------------------------------------------------
// extractMarkers
// ---------------------------------------------------------------------------

test('extractMarkers finds {{MARKER}} tokens', () => {
  const html = '<p>Initial {{INITIALS_S4}} and sign {{SIG_RENTER}} please.</p>';
  const set = extractMarkers(html);
  assert.equal(set.size, 2);
  assert.ok(set.has('INITIALS_S4'));
  assert.ok(set.has('SIG_RENTER'));
});

test('extractMarkers dedupes repeated markers', () => {
  const html = '{{X}} text {{X}} more {{Y}}';
  const set = extractMarkers(html);
  assert.deepEqual([...set].sort(), ['X', 'Y']);
});

test('extractMarkers handles empty / invalid input', () => {
  assert.equal(extractMarkers('').size, 0);
  assert.equal(extractMarkers(null).size, 0);
  assert.equal(extractMarkers(undefined).size, 0);
});

// ---------------------------------------------------------------------------
// validateTemplatePayload
// ---------------------------------------------------------------------------

test('validateTemplatePayload accepts a well-formed template', () => {
  validateTemplatePayload({
    contentHtml: '<p>{{SIG_A}}</p>',
    contentLanguage: 'en',
    fields: [{ kind: 'SIGNATURE', label: 'A', markerKey: 'SIG_A', required: true }],
  });
});

test('validateTemplatePayload rejects missing contentHtml', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '',
        fields: [],
      }),
    /contentHtml is required/
  );
});

test('validateTemplatePayload rejects bad contentLanguage', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '<p>hi</p>',
        contentLanguage: 'french',
        fields: [],
      }),
    /contentLanguage must be one of/
  );
});

test('validateTemplatePayload rejects invalid field.kind', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '<p>{{X}}</p>',
        fields: [{ kind: 'NOPE', label: 'X', markerKey: 'X', required: true }],
      }),
    /field.kind must be one of/
  );
});

test('validateTemplatePayload rejects bad markerKey format', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '<p>{{x}}</p>',
        fields: [{ kind: 'SIGNATURE', label: 'a', markerKey: 'lowercase', required: true }],
      }),
    /markerKey must match/
  );
});

test('validateTemplatePayload rejects duplicate markerKey', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '<p>{{X}}</p>',
        fields: [
          { kind: 'SIGNATURE', label: 'a', markerKey: 'X', required: true },
          { kind: 'INITIAL', label: 'b', markerKey: 'X', required: true },
        ],
      }),
    /Duplicate markerKey/
  );
});

test('validateTemplatePayload rejects required field missing from HTML', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '<p>no markers here</p>',
        fields: [{ kind: 'SIGNATURE', label: 'a', markerKey: 'SIG_RENTER', required: true }],
      }),
    /Required fields missing from contentHtml/
  );
});

test('validateTemplatePayload rejects HTML marker with no matching field', () => {
  assert.throws(
    () =>
      validateTemplatePayload({
        contentHtml: '<p>{{ORPHAN}} {{SIG_A}}</p>',
        fields: [{ kind: 'SIGNATURE', label: 'a', markerKey: 'SIG_A', required: true }],
      }),
    /HTML references \{\{markerKey\}\} with no matching field/
  );
});

test('validateTemplatePayload tolerates optional fields absent from HTML', () => {
  // required=false fields are not required to appear in HTML
  validateTemplatePayload({
    contentHtml: '<p>{{SIG_A}}</p>',
    fields: [
      { kind: 'SIGNATURE', label: 'a', markerKey: 'SIG_A', required: true },
      { kind: 'TEXT_FIELD', label: 'optional', markerKey: 'TEXT_OPT', required: false },
    ],
  });
});

// ---------------------------------------------------------------------------
// createTemplate
// ---------------------------------------------------------------------------

test('createTemplate creates a template + fields', async () => {
  const prisma = makeFakePrisma();
  const t = await createTemplate({
    tenantId: 't1',
    name: 'V1',
    version: '1.0',
    contentHtml: '<p>{{SIG_X}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'SIGNATURE', label: 'Sign', markerKey: 'SIG_X', required: true }],
    prisma,
  });
  assert.equal(t.tenantId, 't1');
  assert.equal(t.fields.length, 1);
  assert.equal(t.fields[0].markerKey, 'SIG_X');
  assert.equal(t.isActive, false);
});

test('createTemplate rejects duplicate (tenantId, version)', async () => {
  const prisma = makeFakePrisma();
  await createTemplate({
    tenantId: 't1',
    name: 'V1',
    version: '1.0',
    contentHtml: '<p>{{SIG_X}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'SIGNATURE', label: 'Sign', markerKey: 'SIG_X', required: true }],
    prisma,
  });
  await assert.rejects(
    () =>
      createTemplate({
        tenantId: 't1',
        name: 'V1 again',
        version: '1.0',
        contentHtml: '<p>{{SIG_X}}</p>',
        effectiveDate: '2026-05-21',
        fields: [{ kind: 'SIGNATURE', label: 'Sign', markerKey: 'SIG_X', required: true }],
        prisma,
      }),
    (err) => err instanceof TermsTemplateError && err.status === 409
  );
});

// ---------------------------------------------------------------------------
// activateTemplate
// ---------------------------------------------------------------------------

test('activateTemplate flips other active templates to false', async () => {
  const prisma = makeFakePrisma();
  const a = await createTemplate({
    tenantId: 't1', name: 'a', version: '1.0', contentHtml: '<p>{{X}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'SIGNATURE', label: 'x', markerKey: 'X', required: true }],
    prisma,
  });
  const b = await createTemplate({
    tenantId: 't1', name: 'b', version: '2.0', contentHtml: '<p>{{X}}</p>',
    effectiveDate: '2026-06-01',
    fields: [{ kind: 'SIGNATURE', label: 'x', markerKey: 'X', required: true }],
    prisma,
  });
  await activateTemplate({ id: a.id, prisma });
  let templates = prisma._state.templates;
  assert.equal(templates.find((t) => t.id === a.id).isActive, true);
  assert.equal(templates.find((t) => t.id === b.id).isActive, false);

  // Activating b should flip a back to false
  await activateTemplate({ id: b.id, prisma });
  templates = prisma._state.templates;
  assert.equal(templates.find((t) => t.id === a.id).isActive, false);
  assert.equal(templates.find((t) => t.id === b.id).isActive, true);
});

test('activateTemplate rejects template with zero fields', async () => {
  const prisma = makeFakePrisma({
    tenants: [{ id: 't1' }],
    templates: [{ id: 'tpl_empty', tenantId: 't1', name: 'x', version: '0.1', isActive: false }],
  });
  await assert.rejects(
    () => activateTemplate({ id: 'tpl_empty', prisma }),
    (err) => err instanceof TermsTemplateError && err.status === 422
  );
});

// ---------------------------------------------------------------------------
// updateTemplate
// ---------------------------------------------------------------------------

test('updateTemplate refuses when signings reference template', async () => {
  const prisma = makeFakePrisma({
    templates: [{ id: 'tpl1', tenantId: 't1', name: 'x', version: '1.0' }],
    signings: [{ id: 's1', templateId: 'tpl1', reservationId: 'r1' }],
  });
  await assert.rejects(
    () =>
      updateTemplate({
        id: 'tpl1',
        contentHtml: '<p>updated</p>',
        prisma,
      }),
    (err) => err instanceof TermsTemplateError && err.status === 409
  );
});

test('updateTemplate replaces fields when fields array passed', async () => {
  const prisma = makeFakePrisma();
  const t = await createTemplate({
    tenantId: 't1', name: 'x', version: '1.0', contentHtml: '<p>{{A}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'SIGNATURE', label: 'a', markerKey: 'A', required: true }],
    prisma,
  });
  await updateTemplate({
    id: t.id,
    contentHtml: '<p>{{B}} {{C}}</p>',
    fields: [
      { kind: 'INITIAL', label: 'b', markerKey: 'B', required: true },
      { kind: 'INITIAL', label: 'c', markerKey: 'C', required: true },
    ],
    prisma,
  });
  const refetched = await getTemplateById({ id: t.id, prisma });
  assert.equal(refetched.fields.length, 2);
  assert.deepEqual(
    refetched.fields.map((f) => f.markerKey).sort(),
    ['B', 'C']
  );
});

// ---------------------------------------------------------------------------
// deleteTemplate
// ---------------------------------------------------------------------------

test('deleteTemplate cascades fields when never used', async () => {
  const prisma = makeFakePrisma();
  const t = await createTemplate({
    tenantId: 't1', name: 'x', version: '1.0', contentHtml: '<p>{{A}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'SIGNATURE', label: 'a', markerKey: 'A', required: true }],
    prisma,
  });
  const r = await deleteTemplate({ id: t.id, prisma });
  assert.equal(r.deleted, true);
  assert.equal(prisma._state.templates.length, 0);
  assert.equal(prisma._state.fields.length, 0);
});

test('deleteTemplate refuses when signings exist', async () => {
  const prisma = makeFakePrisma({
    templates: [{ id: 'tpl1', tenantId: 't1', name: 'x', version: '1.0' }],
    signings: [{ id: 's1', templateId: 'tpl1' }],
  });
  await assert.rejects(
    () => deleteTemplate({ id: 'tpl1', prisma }),
    (err) => err instanceof TermsTemplateError && err.status === 409
  );
});

// ---------------------------------------------------------------------------
// getActiveTemplateForTenant
// ---------------------------------------------------------------------------

test('getActiveTemplateForTenant returns active row + fields ordered', async () => {
  const prisma = makeFakePrisma();
  const t = await createTemplate({
    tenantId: 't1', name: 'x', version: '1.0', contentHtml: '<p>{{A}}{{B}}</p>',
    effectiveDate: '2026-05-21',
    fields: [
      { kind: 'INITIAL', label: 'a', markerKey: 'A', required: true, order: 1 },
      { kind: 'SIGNATURE', label: 'b', markerKey: 'B', required: true, order: 2 },
    ],
    prisma,
  });
  await activateTemplate({ id: t.id, prisma });
  const active = await getActiveTemplateForTenant({ tenantId: 't1', prisma });
  assert.equal(active.id, t.id);
  assert.equal(active.fields.length, 2);
  assert.equal(active.fields[0].markerKey, 'A');
});

test('getActiveTemplateForTenant returns null when none active', async () => {
  const prisma = makeFakePrisma();
  await createTemplate({
    tenantId: 't1', name: 'x', version: '1.0', contentHtml: '<p>{{A}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'INITIAL', label: 'a', markerKey: 'A', required: true }],
    prisma,
  });
  // not activated
  const active = await getActiveTemplateForTenant({ tenantId: 't1', prisma });
  assert.equal(active, null);
});

// ---------------------------------------------------------------------------
// listTemplatesForTenant + constants
// ---------------------------------------------------------------------------

test('listTemplatesForTenant returns each template with field count', async () => {
  const prisma = makeFakePrisma();
  await createTemplate({
    tenantId: 't1', name: 'x', version: '1.0', contentHtml: '<p>{{A}}</p>',
    effectiveDate: '2026-05-21',
    fields: [{ kind: 'INITIAL', label: 'a', markerKey: 'A', required: true }],
    prisma,
  });
  const rows = await listTemplatesForTenant({ tenantId: 't1', prisma });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._count.fields, 1);
});

test('FIELD_KINDS exposes the 5 enum values', () => {
  assert.deepEqual([...FIELD_KINDS].sort(), ['CHECKBOX', 'DATE', 'INITIAL', 'SIGNATURE', 'TEXT_FIELD']);
});
