'use client';

/**
 * Report Builder (2026-07-26) — the TSD moment: pick a dataset, tick field
 * chips by category, watch the live preview, save. Edit mode via ?id=.
 *
 * The dataset catalog arrives ALREADY filtered to the caller's role
 * (GET /api/reports/custom/datasets) — fields this user can't see simply
 * don't render, and the engine re-validates at run anyway.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthGate } from '../../../components/AuthGate';
import { AppShell } from '../../../components/AppShell';
import { api } from '../../../lib/client';

const PRESETS = [
  ['TODAY', 'Today'], ['THIS_WEEK', 'This week'], ['THIS_MONTH', 'This month'],
  ['LAST_MONTH', 'Last month'], ['CUSTOM', 'Custom']
];
const BUCKETS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];

function money(n) { return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function cell(value, type) {
  if (value == null || value === '') return '-';
  if (type === 'money') return money(value);
  if (type === 'date') return new Date(value).toLocaleString();
  if (type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** One result table (flat or grouped) — shared by the single preview and the
 * per-section stacks (LAX #14). */
function PreviewTable({ result }) {
  if (!result?.rows?.length) return <div className="surface-note" style={{ margin: '8px 0' }}>No data in range.</div>;
  return (
    <table>
      <thead><tr>{result.columns.map((c) => <th key={c.key} style={['money', 'number'].includes(c.type) ? { textAlign: 'right' } : {}}>{c.label}</th>)}</tr></thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr key={i}>{row.map((v, j) => <td key={j} style={['money', 'number'].includes(result.columns[j].type) ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : {}}>{cell(v, result.columns[j].type)}</td>)}</tr>
        ))}
        {result.mode === 'grouped' && result.totals ? (
          <tr style={{ fontWeight: 700 }}>{result.totals.map((v, j) => <td key={j} style={j > 0 ? { textAlign: 'right' } : {}}>{j === 0 ? v : cell(v, result.columns[j]?.type)}</td>)}</tr>
        ) : null}
      </tbody>
    </table>
  );
}

function BuilderInner({ me, token, logout }) {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get('id') || '';

  const [datasets, setDatasets] = useState([]);
  const [msg, setMsg] = useState('');
  const [dsKey, setDsKey] = useState('');
  const [columns, setColumns] = useState([]);
  const [dateField, setDateField] = useState('');
  const [preset, setPreset] = useState('THIS_MONTH');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [grouped, setGrouped] = useState(false);
  const [groupField, setGroupField] = useState('');
  const [groupBucket, setGroupBucket] = useState('day');
  const [aggs, setAggs] = useState([{ fn: 'count' }]);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('PRIVATE');
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState('idle');
  const [saving, setSaving] = useState(false);
  // Definition keys the UI doesn't edit (filters, sort, future versions) —
  // carried through untouched on edit-save (QA: they were silently stripped).
  const [preservedDef, setPreservedDef] = useState({});
  // LAX #14 — multi-dataset modes. SINGLE = the classic one-dataset report;
  // SECTIONS = stacked tables sharing one range; JOINED = reservations +
  // per-reservation aggregates from joinable datasets.
  const [reportMode, setReportMode] = useState('SINGLE');
  const [sections, setSections] = useState([]); // [{ dataset, columns: [], dateField: '' }]
  const [joins, setJoins] = useState({});       // { [datasetKey]: ['count', ...metricKeys] }
  const debounceRef = useRef(null);

  const ds = useMemo(() => datasets.find((d) => d.key === dsKey) || null, [datasets, dsKey]);
  const groups = useMemo(() => {
    if (!ds) return [];
    const map = new Map();
    for (const f of ds.fields) {
      if (!map.has(f.group)) map.set(f.group, []);
      map.get(f.group).push(f);
    }
    return [...map.entries()];
  }, [ds]);
  const numberFields = useMemo(() => (ds ? ds.fields.filter((f) => ['money', 'number'].includes(f.type) && columns.includes(f.key)) : []), [ds, columns]);
  const dateFieldKeys = useMemo(() => (ds ? Object.entries(ds.dateFields || {}) : []), [ds]);

  const joinableDatasets = useMemo(() => datasets.filter((d) => d.reservationJoin?.metrics?.length), [datasets]);
  const rangeDef = useMemo(() => (preset === 'CUSTOM'
    ? { preset: 'CUSTOM', from: customFrom, to: customTo }
    : { preset }), [preset, customFrom, customTo]);

  const definition = useMemo(() => {
    if (reportMode === 'SECTIONS') {
      const ready = sections.filter((s) => s.dataset && s.columns.length);
      if (!ready.length) return null;
      return {
        mode: 'SECTIONS',
        range: rangeDef,
        sections: ready.map((s) => ({ dataset: s.dataset, columns: s.columns, ...(s.dateField ? { dateField: s.dateField } : {}) }))
      };
    }
    if (reportMode === 'JOINED') {
      const joinList = Object.entries(joins).filter(([, m]) => m.length).map(([dataset, metrics]) => ({ dataset, metrics }));
      if (!columns.length || !joinList.length) return null;
      return {
        mode: 'JOINED',
        range: rangeDef,
        anchor: { columns, ...(dateField ? { dateField } : {}) },
        joins: joinList
      };
    }
    if (!ds || !columns.length) return null;
    // A report edited FROM a multi mode back to SINGLE must not drag the
    // multi keys along via preservedDef — the backend would re-run it multi.
    const { mode: _m, sections: _s, anchor: _an, joins: _j, ...cleanPreserved } = preservedDef;
    const def = { ...cleanPreserved, columns };
    if (dateFieldKeys.length) {
      def.dateField = dateField || dateFieldKeys[0][0];
      def.range = rangeDef;
    }
    if (grouped && groupField) {
      const isDate = ds.dateFields && ds.dateFields[groupField];
      def.groupBy = isDate ? { field: groupField, bucket: groupBucket } : { field: groupField };
      def.aggregates = aggs;
    }
    return def;
  }, [reportMode, sections, joins, rangeDef, ds, columns, dateField, grouped, groupField, groupBucket, aggs, dateFieldKeys, preservedDef]);

  // JOINED anchors on the reservations dataset — force the chip catalog there.
  useEffect(() => {
    if (reportMode === 'JOINED' && dsKey !== 'reservations') {
      setDsKey('reservations'); setColumns([]); setGrouped(false); setGroupField('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportMode]);

  useEffect(() => {
    (async () => {
      try {
        const out = await api('/api/reports/custom/datasets', {}, token);
        setDatasets(Array.isArray(out?.datasets) ? out.datasets : []);
        if (editId) {
          const saved = await api(`/api/reports/custom/${editId}`, { bypassCache: true }, token);
          setDsKey(saved.dataset);
          setName(saved.name);
          setVisibility(saved.visibility || 'PRIVATE');
          const def = saved.definition || {};
          const { columns: _c, dateField: _d, range: _r, groupBy: _g, aggregates: _a, ...rest } = def;
          setPreservedDef(rest);
          if (def.range?.preset) setPreset(def.range.preset);
          if (def.range?.from) setCustomFrom(String(def.range.from).slice(0, 10));
          if (def.range?.to) setCustomTo(String(def.range.to).slice(0, 10));
          // LAX #14 — hydrate multi modes; classic reports fall through.
          if (String(def.mode || '').toUpperCase() === 'SECTIONS') {
            setReportMode('SECTIONS');
            setSections((def.sections || []).map((s) => ({
              dataset: s.dataset, columns: Array.isArray(s.columns) ? s.columns : [], dateField: s.dateField || ''
            })));
          } else if (String(def.mode || '').toUpperCase() === 'JOINED') {
            setReportMode('JOINED');
            setColumns(Array.isArray(def.anchor?.columns) ? def.anchor.columns : []);
            if (def.anchor?.dateField) setDateField(def.anchor.dateField);
            setJoins(Object.fromEntries((def.joins || []).map((j) => [j.dataset, Array.isArray(j.metrics) ? j.metrics : ['count']])));
          } else {
            setColumns(Array.isArray(def.columns) ? def.columns : []);
            if (def.dateField) setDateField(def.dateField);
            if (def.groupBy?.field) {
              setGrouped(true);
              setGroupField(def.groupBy.field);
              if (def.groupBy.bucket) setGroupBucket(def.groupBy.bucket);
              if (Array.isArray(def.aggregates) && def.aggregates.length) setAggs(def.aggregates);
            }
          }
        }
      } catch (e) { setMsg(e.message); }
    })();
  }, [token, editId]);

  useEffect(() => {
    if (!definition) { setPreview(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setPreviewState('loading');
      try {
        const out = await api('/api/reports/custom/run', {
          method: 'POST',
          body: JSON.stringify({ dataset: dsKey, definition })
        }, token);
        setPreview(out);
        setPreviewState('ready');
      } catch (e) {
        setPreview(null);
        setPreviewState('error');
        setMsg(e.message);
      }
    }, 450);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [definition, dsKey, token]);

  const pickDataset = (key) => {
    if (dsKey && key !== dsKey && columns.length && !window.confirm('Changing the dataset clears your selections. Continue?')) return;
    setDsKey(key); setColumns([]); setDateField(''); setGrouped(false); setGroupField(''); setAggs([{ fn: 'count' }]); setPreview(null);
  };
  const toggleColumn = (key) => setColumns((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  const toggleAgg = (fn, field) => setAggs((prev) => {
    const has = prev.some((a) => a.fn === fn && (a.field || null) === (field || null));
    if (has) return prev.filter((a) => !(a.fn === fn && (a.field || null) === (field || null)));
    return [...prev, field ? { fn, field } : { fn }];
  });

  const save = async () => {
    if (!definition) {
      return setMsg(reportMode === 'SECTIONS'
        ? 'Add at least one section with a dataset and columns'
        : reportMode === 'JOINED'
          ? 'Pick reservation columns and at least one dataset to join'
          : 'Pick a dataset and at least one column');
    }
    if (!name.trim()) return setMsg('Give the report a name');
    const datasetParam = reportMode === 'SECTIONS'
      ? (sections.find((s) => s.dataset)?.dataset || 'reservations')
      : (reportMode === 'JOINED' ? 'reservations' : dsKey);
    setSaving(true);
    try {
      if (editId) {
        await api(`/api/reports/custom/${editId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim(), dataset: datasetParam, definition, visibility })
        }, token);
        router.push(`/reports-v2/custom/${editId}`);
      } else {
        const out = await api('/api/reports/custom', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), dataset: datasetParam, definition, visibility })
        }, token);
        router.push(`/reports-v2/custom/${out.id}`);
      }
    } catch (e) { setMsg(e.message); } finally { setSaving(false); }
  };

  // LAX #14 — section + join editing helpers.
  const addSection = () => setSections((prev) => (prev.length >= 5 ? prev : [...prev, { dataset: '', columns: [], dateField: '' }]));
  const removeSection = (i) => setSections((prev) => prev.filter((_, idx) => idx !== i));
  const patchSection = (i, patch) => setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const toggleSectionColumn = (i, key) => setSections((prev) => prev.map((s, idx) => (idx === i
    ? { ...s, columns: s.columns.includes(key) ? s.columns.filter((k) => k !== key) : [...s.columns, key] }
    : s)));
  const toggleJoinMetric = (datasetKey, metricKey) => setJoins((prev) => {
    const current = prev[datasetKey] || [];
    const next = current.includes(metricKey) ? current.filter((k) => k !== metricKey) : [...current, metricKey];
    const out = { ...prev };
    if (next.length) out[datasetKey] = next; else delete out[datasetKey];
    return out;
  });

  return (
    <AppShell me={me} logout={logout}>
      <section className="glass card-lg stack">
        <div className="row-between">
          <div>
            <span className="eyebrow">Report Builder</span>
            <h2 className="page-title" style={{ marginTop: 6 }}>{editId ? 'Edit report' : 'New report'}</h2>
          </div>
          <button className="button-subtle" onClick={() => router.push('/reports-v2')}>Back to Reports</button>
        </div>
        {msg ? <div className="surface-note" style={{ color: '#b3261e' }}>{msg}</div> : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 400px) 1fr', gap: 16, alignItems: 'start' }}>
          <div className="stack" style={{ gap: 12 }}>

            <div className="glass card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Report type</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[['SINGLE', 'One dataset'], ['SECTIONS', 'Sections (stacked)'], ['JOINED', 'Combined by reservation']].map(([k, label]) => (
                  <button key={k} className="button-subtle" onClick={() => setReportMode(k)}
                    style={reportMode === k ? { background: '#534AB7', color: '#fff', borderColor: '#534AB7' } : {}}>
                    {label}
                  </button>
                ))}
              </div>
              {reportMode === 'SECTIONS' ? (
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginTop: 6 }}>Several datasets as stacked tables — one sheet each in Excel, sharing one date range.</div>
              ) : reportMode === 'JOINED' ? (
                <div className="label" style={{ textTransform: 'none', letterSpacing: 0, marginTop: 6 }}>One row per reservation, with toll/citation/incident totals appended.</div>
              ) : null}
            </div>

            {reportMode === 'SINGLE' ? (
            <div className="glass card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>1 · Dataset</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {datasets.map((d) => (
                  <button key={d.key} className="button-subtle" onClick={() => pickDataset(d.key)}
                    style={dsKey === d.key ? { borderColor: '#534AB7', background: '#eceafd', fontWeight: 700 } : {}}>
                    <div style={{ textAlign: 'left' }}>
                      <div>{d.label}</div>
                      <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>{d.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            ) : null}

            {reportMode === 'SECTIONS' ? (
              <div className="glass card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>1 · Sections <span className="label" style={{ textTransform: 'none' }}>{sections.length}/5</span></div>
                {sections.map((section, i) => {
                  const sds = datasets.find((d) => d.key === section.dataset) || null;
                  const sDateKeys = sds ? Object.entries(sds.dateFields || {}) : [];
                  return (
                    <div key={i} style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                      <div className="row-between" style={{ marginBottom: 6 }}>
                        <select value={section.dataset} onChange={(e) => patchSection(i, { dataset: e.target.value, columns: [], dateField: '' })}>
                          <option value="">Pick a dataset…</option>
                          {datasets.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                        </select>
                        <button className="button-subtle" style={{ fontSize: 12 }} onClick={() => removeSection(i)}>Remove</button>
                      </div>
                      {sds ? (
                        <>
                          {sDateKeys.length > 1 ? (
                            <select value={section.dateField || sDateKeys[0][0]} onChange={(e) => patchSection(i, { dateField: e.target.value })} style={{ marginBottom: 6 }}>
                              {sDateKeys.map(([k, label]) => <option key={k} value={k}>By {label}</option>)}
                            </select>
                          ) : null}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {sds.fields.map((f) => (
                              <button key={f.key} className="button-subtle" onClick={() => toggleSectionColumn(i, f.key)}
                                style={{ borderRadius: 999, padding: '3px 10px', fontSize: 12,
                                  ...(section.columns.includes(f.key) ? { background: '#534AB7', color: '#fff', borderColor: '#534AB7' } : {}) }}>
                                {section.columns.includes(f.key) ? '✓ ' : ''}{f.label}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : null}
                    </div>
                  );
                })}
                {sections.length < 5 ? (
                  <button className="button-subtle" onClick={addSection}>+ Add section</button>
                ) : null}
              </div>
            ) : null}

            {reportMode === 'JOINED' && joinableDatasets.length ? (
              <div className="glass card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>1 · Datasets to combine</div>
                {joinableDatasets.map((d) => (
                  <div key={d.key} style={{ marginBottom: 8 }}>
                    <div className="label" style={{ marginBottom: 4 }}>{d.label}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12.5 }}>
                      {d.reservationJoin.metrics.map((m) => (
                        <label key={m.key}>
                          <input type="checkbox"
                            checked={(joins[d.key] || []).includes(m.key)}
                            onChange={() => toggleJoinMetric(d.key, m.key)} /> {m.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {(reportMode === 'SINGLE' || reportMode === 'JOINED') && ds ? (
              <div className="glass card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>2 · {reportMode === 'JOINED' ? 'Reservation columns' : 'Columns'} <span className="label" style={{ textTransform: 'none' }}>{columns.length} selected</span></div>
                {groups.map(([group, fields]) => (
                  <div key={group} style={{ marginBottom: 10 }}>
                    <div className="label" style={{ marginBottom: 6 }}>{group}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {fields.map((f) => (
                        <button key={f.key} className="button-subtle" onClick={() => toggleColumn(f.key)}
                          style={{ borderRadius: 999, padding: '4px 12px', fontSize: 12.5,
                            ...(columns.includes(f.key) ? { background: '#534AB7', color: '#fff', borderColor: '#534AB7' } : {}) }}>
                          {columns.includes(f.key) ? '✓ ' : ''}{f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {reportMode === 'SECTIONS' || (ds && dateFieldKeys.length) ? (
              <div className="glass card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>{reportMode === 'SECTIONS' ? '2 · Shared date range' : '3 · Date range'}</div>
                {reportMode !== 'SECTIONS' && dateFieldKeys.length > 1 ? (
                  <select value={dateField || dateFieldKeys[0][0]} onChange={(e) => setDateField(e.target.value)} style={{ marginBottom: 8 }}>
                    {dateFieldKeys.map(([k, label]) => <option key={k} value={k}>By {label}</option>)}
                  </select>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {PRESETS.map(([k, label]) => (
                    <button key={k} className="button-subtle" onClick={() => setPreset(k)}
                      style={{ borderRadius: 999, padding: '4px 12px', fontSize: 12.5,
                        ...(preset === k ? { background: '#eceafd', borderColor: '#534AB7', fontWeight: 700 } : {}) }}>{label}</button>
                  ))}
                </div>
                {preset === 'CUSTOM' ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                  </div>
                ) : null}
              </div>
            ) : null}

            {reportMode === 'SINGLE' && ds ? (
              <div className="glass card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>4 · Grouping &amp; totals</div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button className="button-subtle" onClick={() => setGrouped(false)}
                    style={!grouped ? { background: '#534AB7', color: '#fff', borderColor: '#534AB7' } : {}}>Flat list</button>
                  <button className="button-subtle" onClick={() => setGrouped(true)}
                    style={grouped ? { background: '#534AB7', color: '#fff', borderColor: '#534AB7' } : {}}>Grouped summary</button>
                </div>
                {grouped ? (
                  <>
                    <select value={groupField} onChange={(e) => setGroupField(e.target.value)} style={{ marginBottom: 6 }}>
                      <option value="">Group by…</option>
                      {dateFieldKeys.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      {ds.groupByKeys.map((k) => {
                        const f = ds.fields.find((x) => x.key === k);
                        return f ? <option key={k} value={k}>{f.label}</option> : null;
                      })}
                    </select>
                    {groupField && ds.dateFields?.[groupField] ? (
                      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                        {BUCKETS.map(([k, label]) => (
                          <button key={k} className="button-subtle" onClick={() => setGroupBucket(k)}
                            style={{ fontSize: 12, ...(groupBucket === k ? { background: '#eceafd', borderColor: '#534AB7', fontWeight: 700 } : {}) }}>{label}</button>
                        ))}
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12.5 }}>
                      <label><input type="checkbox" checked={aggs.some((a) => a.fn === 'count')} onChange={() => toggleAgg('count', null)} /> Count</label>
                      {numberFields.map((f) => (
                        <span key={f.key} style={{ display: 'inline-flex', gap: 10 }}>
                          <label><input type="checkbox" checked={aggs.some((a) => a.fn === 'sum' && a.field === f.key)} onChange={() => toggleAgg('sum', f.key)} /> Sum of {f.label}</label>
                          <label><input type="checkbox" checked={aggs.some((a) => a.fn === 'avg' && a.field === f.key)} onChange={() => toggleAgg('avg', f.key)} /> Avg of {f.label}</label>
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="glass card" style={{ padding: 12, position: 'sticky', bottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input placeholder="Report name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
              <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                <option value="PRIVATE">Only me</option>
                <option value="TENANT">Everyone</option>
              </select>
              <button className="ios-action-btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save report'}</button>
            </div>
          </div>

          <div className="glass card" style={{ padding: 0, minHeight: 320 }}>
            <div className="row-between" style={{ padding: '12px 16px', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 700 }}>Live preview</div>
              <span className="label" style={{ textTransform: 'none' }}>
                {previewState === 'loading' ? 'Updating…'
                  : preview && preview.mode === 'sections' ? `${preview.sections.length} section${preview.sections.length === 1 ? '' : 's'}`
                  : preview && preview.mode === 'grouped' && preview.truncated ? `⚠ totals incomplete (over ${5000} rows) — narrow the range`
                  : preview ? `${preview.rowCount} row${preview.rowCount === 1 ? '' : 's'}${preview.truncated ? ' (first 200 — export for all)' : ''}` : ''}
              </span>
            </div>
            <div style={{ padding: '0 16px 16px', overflowX: 'auto' }}>
              {!definition && !preview ? (
                <div className="surface-note" style={{ margin: 16 }}>
                  {reportMode === 'SECTIONS' ? 'Add a section, pick its dataset and tick some columns.'
                    : reportMode === 'JOINED' ? 'Tick reservation columns and at least one metric to combine.'
                    : !ds ? 'Pick a dataset to start.' : 'Tick some columns and the preview appears here.'}
                </div>
              ) : preview && preview.mode === 'sections' ? (
                preview.sections.map((section, si) => (
                  <div key={si} style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {section.label}
                      <span className="label" style={{ textTransform: 'none', marginLeft: 8 }}>
                        {section.rowCount} row{section.rowCount === 1 ? '' : 's'}{section.truncated ? ' (truncated)' : ''}
                      </span>
                    </div>
                    <PreviewTable result={section} />
                  </div>
                ))
              ) : preview && preview.rows?.length ? (
                <PreviewTable result={preview} />
              ) : previewState === 'ready' ? <div className="surface-note" style={{ margin: 16 }}>No data matches these filters — try widening the date range.</div>
                : previewState === 'loading' ? <div className="surface-note" style={{ margin: 16 }}>Loading…</div>
                : null}
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

export default function BuilderPage() {
  return (
    <AuthGate>
      {({ me, token, logout }) => (
        <Suspense fallback={null}>
          <BuilderInner me={me} token={token} logout={logout} />
        </Suspense>
      )}
    </AuthGate>
  );
}
