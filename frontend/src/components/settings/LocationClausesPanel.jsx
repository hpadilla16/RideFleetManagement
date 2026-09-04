'use client';

/**
 * Contract clauses — per-location editor (Settings → Locations → a location →
 * Contract Clauses). The last unbuilt item of "disclaimers configurables en los
 * settings".
 *
 * Self-contained, same reasoning as ShuttleTrackerSettings: settings/page.js is
 * 8,500 lines, and saving the location and saving its clause wording are
 * independent actions against different endpoints. "Save Location Settings" in
 * the modal footer does NOT carry clause text — the backend refuses
 * termsSectionsJson on that route precisely so the ADMIN gate, the validation
 * and the audit row cannot be walked around — so this panel owns its own Save
 * and says so.
 *
 * ── WHAT THE 250 MEANS, AND WHY IT IS NOT A STYLE RULE ──────────────────────
 * Terminal contract signing shows each clause through /v2/Common/UserChoice,
 * whose Title is capped at 250 characters, and the sequencer REFUSES to start
 * rather than truncate — truncating would have the renter pressing "I agree" on
 * a sentence that stops mid-word. So a clause of 251 characters does not look
 * slightly wrong: every check-out at that branch goes to the renter's phone
 * instead of the counter terminal. This panel therefore shows the count live,
 * warns before the edge, and spells the consequence out in words. It does NOT
 * block saving: a tenant may legitimately prefer a long clause and the phone
 * flow (LAX's California deposit wording is longer than the standard text for
 * real legal reasons), and quietly shortening a legal instrument is the one
 * thing an editor of legal text must never do.
 *
 * ── LANGUAGE ────────────────────────────────────────────────────────────────
 * The clause corpus in terms-content.js is a SINGLE body per clause. The public
 * signing page translates its own chrome and serves the clause bodies as-is —
 * its documented KNOWN LIMIT — and the terminal carries both languages inside
 * one string ("I agree / Acepto"). So there is no per-language field to expose:
 * a branch that needs Spanish writes Spanish into the body, and the renter
 * signs exactly the characters stored. Offering an en/es pair here would invent
 * a translation model the product does not have and let the two halves drift
 * apart from what was actually signed. This panel's own CHROME is translated,
 * like every other recent surface.
 *
 * Visual language follows tolls-redesign-A (approved 2026-08-28): flat
 * token-driven surfaces, 11px text floor, chips instead of raw status strings.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/client';

/** Mirrors CLAUSE_SCOPE in backend/src/modules/locations/location-clauses.service.js. */
const SCOPE_ALWAYS = 'ALWAYS';
const SCOPE_DECLINED = 'DECLINED_INSURANCE';
const SCOPE_DAMAGE = 'DAMAGE_REPORT';

/** The exact string the terminal receives — the server counts this, so we do too. */
const asSent = (body) => String(body ?? '').trim();

export function LocationClausesPanel({ locationId, locationName, locationCode, scopedSettingsPath }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});      // key → body currently in the textarea
  const [cleared, setCleared] = useState({});    // key → true when restored to standard this session
  const [open, setOpen] = useState({});          // key → standard-text reveal
  const [status, setStatus] = useState('loading'); // loading | ready | saving | error
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Identity fallback so the panel still works mounted bare (tests, future use).
  const scoped = useCallback(
    (path) => (typeof scopedSettingsPath === 'function' ? scopedSettingsPath(path) : path),
    [scopedSettingsPath],
  );

  useEffect(() => {
    if (!locationId) return undefined;
    let alive = true;
    (async () => {
      setStatus('loading'); setMessage(''); setError('');
      try {
        const out = await api(scoped(`/api/locations/${locationId}/clauses`), { bypassCache: true });
        if (!alive) return;
        setData(out);
        setDrafts({});
        setCleared({});
        setStatus('ready');
      } catch (e) {
        if (!alive) return;
        setError(e?.message || t('locationClauses.loadFailed', 'Could not load this location’s clauses.'));
        setStatus('error');
      }
    })();
    return () => { alive = false; };
  }, [locationId, scoped, reloadKey, t]);

  /** The body currently on screen for a clause: the draft, or the saved state. */
  const bodyFor = useCallback((c) => {
    if (Object.prototype.hasOwnProperty.call(drafts, c.key)) return drafts[c.key];
    if (cleared[c.key]) return c.canonicalBody;
    return c.body;
  }, [drafts, cleared]);

  /** Is this clause currently a custom text, as the screen stands? */
  const isCustom = useCallback((c) => {
    if (cleared[c.key]) return false;
    return asSent(bodyFor(c)) !== asSent(c.canonicalBody);
  }, [bodyFor, cleared]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (Object.keys(cleared).length) return true;
    return data.clauses.some((c) => asSent(bodyFor(c)) !== asSent(c.body));
  }, [data, cleared, bodyFor]);

  const terminalMax = data?.terminal?.max ?? 250;
  const terminalWarnAt = data?.terminal?.warnAt ?? terminalMax - 20;

  /**
   * The verdict for one clause AS THE SCREEN STANDS — recomputed from the
   * textarea, never read from the last server response. An admin typing past
   * the cap has to be told while they are typing, not after they save.
   */
  const verdictFor = useCallback((c) => {
    const length = asSent(bodyFor(c)).length;
    if (c.scope === SCOPE_DAMAGE) return { length, level: 'na' };
    if (length > terminalMax) return { length, level: 'over' };
    if (length > terminalWarnAt) return { length, level: 'near' };
    return { length, level: 'ok' };
  }, [bodyFor, terminalMax, terminalWarnAt]);

  const blocked = useMemo(
    () => (data?.clauses || []).filter((c) => verdictFor(c).level === 'over'),
    [data, verdictFor],
  );

  function restore(c) {
    setCleared((p) => ({ ...p, [c.key]: true }));
    setDrafts((p) => {
      const next = { ...p };
      delete next[c.key];
      return next;
    });
    setMessage('');
  }

  function edit(c, value) {
    setCleared((p) => {
      if (!p[c.key]) return p;
      const next = { ...p };
      delete next[c.key];
      return next;
    });
    setDrafts((p) => ({ ...p, [c.key]: value }));
    setMessage('');
  }

  async function save() {
    if (!data) return;
    setStatus('saving'); setMessage(''); setError('');
    // FULL REPLACE of the override map: what is on screen IS the intended
    // state, and a clause showing the standard text is simply absent. That is
    // what makes restore-to-standard one action instead of "delete the text
    // until it looks empty".
    const overrides = {};
    for (const c of data.clauses) {
      const body = asSent(bodyFor(c));
      if (!body || body === asSent(c.canonicalBody)) continue;
      overrides[c.key] = { body };
    }
    try {
      const out = await api(
        scoped(`/api/locations/${locationId}/clauses`),
        { method: 'PUT', body: JSON.stringify({ overrides }) },
      );
      setData(out);
      setDrafts({});
      setCleared({});
      setStatus('ready');
      setMessage(
        out.changed?.length
          ? t('locationClauses.savedCount', 'Saved — {{count}} clause(s) changed', { count: out.changed.length })
          : t('locationClauses.savedNoChange', 'Saved — nothing had changed'),
      );
    } catch (e) {
      setError(e?.message || t('locationClauses.saveFailed', 'Save failed'));
      setStatus('ready');
    }
  }

  if (!locationId) return null;

  if (status === 'loading') {
    return <div className="label">{t('locationClauses.loading', 'Loading clauses…')}</div>;
  }
  if (status === 'error' || !data) {
    return (
      <div className="glass card section-card">
        <div className="section-title">{t('locationClauses.title', 'Contract clauses')}</div>
        <div className="lc-alert lc-bad">{error}</div>
        <div><button type="button" className="button-subtle" onClick={() => setReloadKey((k) => k + 1)}>
          {t('locationClauses.retry', 'Retry')}
        </button></div>
      </div>
    );
  }

  const always = data.clauses.filter((c) => c.scope === SCOPE_ALWAYS);
  const conditional = data.clauses.filter((c) => c.scope !== SCOPE_ALWAYS);

  return (
    <div className="stack lc-panel">
      {/* WHICH location. Scope is per branch, and an admin must never have to
          guess which contract they are about to change. */}
      <div className="app-banner">
        <span className="eyebrow">{t('locationClauses.eyebrow', 'Contract clauses')}</span>
        <h4 className="page-title" style={{ marginTop: 4, fontSize: 18 }}>
          {locationName || data.location?.name}
          {(locationCode || data.location?.code)
            ? <span className="ui-muted" style={{ fontWeight: 500, fontSize: 14 }}> · {locationCode || data.location?.code}</span>
            : null}
        </h4>
        <p className="ui-muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
          {t(
            'locationClauses.scopeNote',
            'These are the acknowledgements a renter reads and initials at THIS location only. Other locations keep their own wording. Text saved here is what the renter signs and what is re-printed inside the signed agreement.',
          )}
        </p>
      </div>

      {/* A broken or stranded stored blob is shown, never swallowed. Saving from
          this screen would overwrite it, so the admin has to see it first. */}
      {!data.storage?.ok && (
        <div className="lc-alert lc-bad">
          <strong>{t('locationClauses.storageBrokenTitle', 'The stored clause overrides for this location are not readable.')}</strong>
          <div>{t(
            'locationClauses.storageBrokenBody',
            'Every renter here is currently signing the standard text. The boxes below show the standard text; saving will replace the unreadable value.',
          )}</div>
        </div>
      )}
      {data.storage?.unknownKeys?.length > 0 && (
        <div className="lc-alert lc-warn">
          {t(
            'locationClauses.strandedKeys',
            'The stored value contains {{count}} entry that matches no clause and has never taken effect: {{keys}}. Saving will remove it.',
            { count: data.storage.unknownKeys.length, keys: data.storage.unknownKeys.join(', ') },
          )}
        </div>
      )}

      {/* THE CONSEQUENCE, said once at the top in plain words. */}
      <div className={blocked.length ? 'lc-alert lc-warn' : 'surface-note'} style={{ fontSize: 12.5 }}>
        {blocked.length ? (
          <>
            <strong>{t(
              'locationClauses.terminalBlockedTitle',
              'Check-outs at this location will be signed on the renter’s phone, not the counter terminal.',
            )}</strong>
            <div>{t(
              'locationClauses.terminalBlockedBody',
              'The counter terminal can display at most {{max}} characters per clause and refuses rather than cutting a clause in half. Over the limit: {{keys}}.',
              { max: terminalMax, keys: blocked.map((c) => c.label).join(', ') },
            )}</div>
          </>
        ) : (
          t(
            'locationClauses.terminalOkBody',
            'Every clause fits the counter terminal’s {{max}}-character limit, so check-outs here can be signed on the terminal.',
            { max: terminalMax },
          )
        )}
      </div>

      <ClauseList
        clauses={always}
        heading={t('locationClauses.alwaysHeading', 'Signed on every rental')}
        {...{ t, bodyFor, isCustom, verdictFor, edit, restore, open, setOpen, terminalMax, terminalWarnAt, data }}
      />
      <ClauseList
        clauses={conditional}
        heading={t('locationClauses.conditionalHeading', 'Signed only in certain cases')}
        {...{ t, bodyFor, isCustom, verdictFor, edit, restore, open, setOpen, terminalMax, terminalWarnAt, data }}
      />

      {error && <div className="lc-alert lc-bad">{error}</div>}
      {message && <div className="lc-alert lc-ok">{message}</div>}

      <div className="row-between" style={{ alignItems: 'center' }}>
        <span className="ui-muted" style={{ fontSize: 11.5 }}>
          {t('locationClauses.separateSave', 'Clauses save on their own — “Save Location Settings” below does not carry them.')}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {dirty && <span className="lc-chip lc-c-warn">{t('locationClauses.unsaved', 'Unsaved changes')}</span>}
          <button
            type="button"
            className="tq-btn-primary"
            onClick={save}
            disabled={status === 'saving' || !dirty}
          >
            {status === 'saving'
              ? t('locationClauses.saving', 'Saving…')
              : t('locationClauses.save', 'Save clauses')}
          </button>
        </span>
      </div>
    </div>
  );
}

function ClauseList({
  clauses, heading, t, bodyFor, isCustom, verdictFor, edit, restore, open, setOpen,
  terminalMax, terminalWarnAt,
}) {
  if (!clauses.length) return null;
  return (
    <div className="stack">
      <div className="label">{heading}</div>
      {clauses.map((c) => (
        <ClauseCard
          key={c.key}
          clause={c}
          {...{ t, bodyFor, isCustom, verdictFor, edit, restore, open, setOpen, terminalMax, terminalWarnAt }}
        />
      ))}
    </div>
  );
}

function ClauseCard({
  clause: c, t, bodyFor, isCustom, verdictFor, edit, restore, open, setOpen,
  terminalMax, terminalWarnAt,
}) {
  const body = bodyFor(c);
  const custom = isCustom(c);
  const { length, level } = verdictFor(c);
  const showing = !!open[c.key];

  const whenLabel = c.scope === SCOPE_DECLINED
    ? t('locationClauses.whenDeclined', 'Only when the renter declines counter insurance')
    : c.scope === SCOPE_DAMAGE
      ? t('locationClauses.whenDamage', 'Only in the Report Damage wizard — never on the counter terminal')
      : null;

  return (
    <div className="glass card lc-clause" data-clause={c.key}>
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div className="lc-clause-label">{c.label}</div>
          {whenLabel && <div className="ui-muted" style={{ fontSize: 11.5 }}>{whenLabel}</div>}
        </div>
        <div className="lc-chips">
          <span className={custom ? 'lc-chip lc-c-info' : 'lc-chip'}>
            {custom
              ? t('locationClauses.chipCustom', 'Custom for this location')
              : t('locationClauses.chipStandard', 'Standard text')}
          </span>
          {c.scope !== SCOPE_DAMAGE && (
            <span className={`lc-chip ${level === 'over' ? 'lc-c-bad' : level === 'near' ? 'lc-c-warn' : 'lc-c-ok'}`}>
              {level === 'over'
                ? t('locationClauses.chipPhoneOnly', 'Phone signing only')
                : t('locationClauses.chipFitsTerminal', 'Fits the terminal')}
            </span>
          )}
        </div>
      </div>

      <textarea
        rows={5}
        aria-label={c.label}
        value={body}
        onChange={(e) => edit(c, e.target.value)}
      />

      {/* THE COUNT, and next to it what crossing it costs — in a sentence, not
          a colour. A colour alone tells an admin that something is wrong and
          not what it will do to their counter. */}
      <div className="lc-meter">
        <span className={`lc-count lc-count-${level}`}>
          {c.scope === SCOPE_DAMAGE
            ? t('locationClauses.countPlain', '{{n}} characters', { n: length })
            : t('locationClauses.count', '{{n}} / {{max}} characters', { n: length, max: terminalMax })}
        </span>
        {c.scope !== SCOPE_DAMAGE && (
          <span className="lc-bar" aria-hidden="true">
            <i
              className={`lc-bar-${level}`}
              style={{ width: `${Math.min(100, Math.round((length / terminalMax) * 100))}%` }}
            />
          </span>
        )}
        <span className="lc-consequence">
          {c.scope === SCOPE_DAMAGE
            ? t('locationClauses.consequenceDamage', 'Signed on a tablet in the damage wizard — no length limit applies.')
            : level === 'over'
              ? t(
                'locationClauses.consequenceOver',
                'Over {{max}}. The counter terminal will refuse this clause, so check-outs here move to the renter’s phone. You can still save it.',
                { max: terminalMax },
              )
              : level === 'near'
                ? t(
                  'locationClauses.consequenceNear',
                  '{{left}} characters left before the terminal refuses this clause and check-outs move to the phone.',
                  { left: terminalMax - length },
                )
                : t('locationClauses.consequenceOk', 'Fits on the counter terminal.')}
        </span>
      </div>

      {/* The canonical text is over the cap and no admin can fix it — say so
          rather than inviting them to shorten a legal text they do not own. */}
      {c.canonicalOverTerminal && !custom && (
        <div className="lc-alert lc-warn" style={{ fontSize: 11.5 }}>
          {t(
            'locationClauses.canonicalOver',
            'The standard wording for this clause is {{n}} characters — longer than the terminal can show. Until this location replaces it with a shorter text, any check-out that includes this clause is signed on the renter’s phone.',
            { n: c.canonicalLength },
          )}
        </div>
      )}

      {/* What the renter actually sees on the device, at the length as typed. */}
      {c.scope !== SCOPE_DAMAGE && (
        <div className="lc-preview">
          <div className="lc-preview-cap">{t('locationClauses.previewTitle', 'On the counter terminal')}</div>
          {level === 'over' ? (
            <div className="lc-preview-screen lc-preview-refused">
              {t(
                'locationClauses.previewRefused',
                'The terminal never shows this clause. The check-out stops before the device is touched and the agent is sent to the phone flow — the clause is not cut short.',
              )}
            </div>
          ) : (
            <div className="lc-preview-screen">
              <div className="lc-preview-body">{asSent(body)}</div>
              <div className="lc-preview-buttons">
                <span>I agree / Acepto</span>
                <span>Decline / No acepto</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="row-between" style={{ alignItems: 'center' }}>
        <button
          type="button"
          className="button-subtle lc-mini"
          onClick={() => setOpen((p) => ({ ...p, [c.key]: !p[c.key] }))}
        >
          {showing
            ? t('locationClauses.hideStandard', 'Hide standard text')
            : t('locationClauses.showStandard', 'Show standard text')}
        </button>
        <button
          type="button"
          className="button-subtle lc-mini"
          onClick={() => restore(c)}
          disabled={!custom}
        >
          {t('locationClauses.restore', 'Restore standard text')}
        </button>
      </div>

      {showing && (
        <div className="lc-standard">
          <div className="lc-preview-cap">
            {t('locationClauses.standardCaption', 'Standard text — {{n}} characters', { n: c.canonicalLength })}
          </div>
          <div className="lc-standard-body">{c.canonicalBody}</div>
        </div>
      )}
    </div>
  );
}

export default LocationClausesPanel;
