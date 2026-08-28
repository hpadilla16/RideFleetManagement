// Security-log forwarder — ships the administrative/security AUDIT trail
// (the same events recordAudit writes: auth, role/user changes, exports,
// erasures, impersonation, sensitive reads) to an external log/SIEM platform.
// Maps to the "stream the AdminAuditLog security events" step of
// doc/logging-monitoring-siem-plan-2026-08-23.md (risk R8).
//
// ── LOAD-BEARING PROPERTIES ─────────────────────────────────────────────────
//  1. INERT BY DEFAULT. If SECURITY_LOG_FORWARD_URL is unset the forwarder is a
//     pure no-op: enqueue returns immediately, no buffer grows, no timer arms,
//     no fetch is ever attempted. Existing behaviour is byte-for-byte unchanged.
//  2. BEST-EFFORT / FIRE-AND-FORGET. forwardSecurityEvent() must NEVER throw
//     into the caller and NEVER block the request path. Every network + JSON
//     step is wrapped in try/catch; failures are logged at warn and dropped
//     after a bounded number of retries. Mirrors the recordAudit / Sentry
//     "best-effort; never break the request" precedent.
//  3. BOUNDED. The in-memory buffer is capped. When full, events are DROPPED
//     (never allowed to grow unbounded / leak memory) and the drop is logged.
//  4. PII-SAFE. It forwards ONLY the already-redacted audit fields it is handed
//     (action, actor id/email/role, tenant, target type/id, ip, userAgent,
//     outcome, timestamp, redacted metadata). Redaction is done UPSTREAM by the
//     audit module (redactSensitive) — this module does NOT reinvent a second
//     redactor and must never be handed raw request bodies / unredacted meta.
import defaultLogger from './logger.js';

// Defaults (all overridable via the factory for tests / tuning).
const DEFAULT_BATCH_SIZE = 20; // flush when this many events are buffered
const DEFAULT_FLUSH_INTERVAL_MS = 5000; // ...or after this long, whichever first
const DEFAULT_MAX_BUFFER = 500; // hard cap — beyond this we DROP, never grow
const DEFAULT_MAX_RETRIES = 2; // POST attempts beyond the first, then give up
const DEFAULT_TIMEOUT_MS = 5000; // per-POST abort timeout

// Only these fields are ever forwarded. metadata is assumed ALREADY REDACTED by
// the caller (recordAudit runs redactSensitive before persist AND before it
// hands the row here). We deliberately do not deep-copy/re-redact metadata —
// reusing the single audit redaction is a requirement, not an oversight.
function normalizeEvent(event, nowIso) {
  return {
    action: event.action ?? null,
    actorUserId: event.actorUserId ?? null,
    actorEmail: event.actorEmail ?? null,
    actorRole: event.actorRole ?? null,
    impersonatedByUserId: event.impersonatedByUserId ?? null,
    tenantId: event.tenantId ?? null,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    outcome: event.outcome ?? null,
    metadata: event.metadata ?? null, // already redacted upstream
    timestamp: event.timestamp ?? nowIso(),
  };
}

/**
 * Build a forwarder instance. Everything is injectable so the unit test can
 * drive it with a fake clock + fake fetch and never touch a real network or a
 * real timer.
 *
 * config: { url, token, batchSize, flushIntervalMs, maxBuffer, maxRetries,
 *           timeoutMs, fetch, logger, setTimeout, clearTimeout, now }
 */
export function createSecurityLogForwarder(config = {}) {
  const url = config.url || undefined;
  const token = config.token || undefined;
  const enabled = Boolean(url);
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBuffer = config.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetch || globalThis.fetch;
  const log = config.logger || defaultLogger;
  const setTimeoutImpl = config.setTimeout || setTimeout;
  const clearTimeoutImpl = config.clearTimeout || clearTimeout;
  const nowIso = config.now || (() => new Date().toISOString());

  let buffer = [];
  let timer = null;
  let flushing = false;
  let dropped = 0;

  function armTimer() {
    if (timer || !enabled) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      // Fire-and-forget: the timer callback must never reject.
      flush().catch(() => {});
    }, flushIntervalMs);
    // Don't keep the event loop (or a test process) alive just for a flush.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function disarmTimer() {
    if (timer) {
      try { clearTimeoutImpl(timer); } catch { /* noop */ }
      timer = null;
    }
  }

  // Enqueue ONE event. Synchronous, never throws, never blocks. When inert
  // (no url) this is a hard no-op — no buffering, no timer, no I/O.
  function enqueue(event) {
    try {
      if (!enabled || event == null) return;
      if (buffer.length >= maxBuffer) {
        dropped += 1;
        // Log the first drop, then only periodically, so a sustained outage
        // does not itself become a log flood.
        if (dropped === 1 || dropped % 100 === 0) {
          try {
            log.warn('[security-log-forwarder] buffer full — dropping event(s)', {
              dropped, maxBuffer,
            });
          } catch { /* logging is best-effort too */ }
        }
        return;
      }
      buffer.push(normalizeEvent(event, nowIso));
      if (buffer.length >= batchSize) {
        // Threshold reached: flush now (fire-and-forget — do NOT await here,
        // the caller is on the request path).
        flush().catch(() => {});
      } else {
        armTimer();
      }
    } catch (err) {
      try {
        log.warn('[security-log-forwarder] enqueue failed (swallowed)', {
          error: err?.message || String(err),
        });
      } catch { /* nothing left to do */ }
    }
  }

  // Flush the whole buffer as a single POST of a JSON array. Awaitable (used by
  // graceful shutdown) but also safe to fire-and-forget. Never rejects.
  async function flush() {
    if (!enabled || flushing || buffer.length === 0) return;
    disarmTimer();
    flushing = true;
    const batch = buffer;
    buffer = []; // take ownership; new events accumulate into a fresh buffer
    try {
      await postWithRetry(batch);
    } catch (err) {
      // Gave up after the bounded retries. DROP the batch (do not re-buffer —
      // that is how the buffer grows unbounded under a sustained outage) and
      // make the drop observable.
      try {
        log.warn('[security-log-forwarder] flush failed after retries — dropping batch', {
          count: batch.length,
          error: err?.message || String(err),
        });
      } catch { /* noop */ }
    } finally {
      flushing = false;
      // If events piled up during the await and we hit the threshold again,
      // keep draining; otherwise make sure a timer is armed for the remainder.
      if (enabled && buffer.length > 0) {
        if (buffer.length >= batchSize) flush().catch(() => {});
        else armTimer();
      }
    }
  }

  async function postWithRetry(batch) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const body = JSON.stringify(batch);

    let attempt = 0;
    let lastErr;
    while (attempt <= maxRetries) {
      try {
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let to = null;
        if (ac) {
          to = setTimeoutImpl(() => { try { ac.abort(); } catch { /* noop */ } }, timeoutMs);
          if (to && typeof to.unref === 'function') to.unref();
        }
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers,
            body,
            signal: ac ? ac.signal : undefined,
          });
          // 5xx → transient, retry. 4xx → our payload is wrong, retrying won't
          // help, so treat as done (logged upstream by the drop path only if it
          // throws). 2xx/3xx → success.
          if (res && typeof res.status === 'number' && res.status >= 500) {
            throw new Error(`ingest endpoint responded ${res.status}`);
          }
          return;
        } finally {
          if (to) { try { clearTimeoutImpl(to); } catch { /* noop */ } }
        }
      } catch (err) {
        lastErr = err;
        attempt += 1;
      }
    }
    throw lastErr || new Error('security-log-forwarder: POST failed');
  }

  return {
    enqueue,
    flush,
    // Cancel any pending timer (used on shutdown after a final flush).
    stop() { disarmTimer(); },
    get enabled() { return enabled; },
    // Test/introspection only.
    _stats() { return { buffered: buffer.length, dropped, hasTimer: Boolean(timer) }; },
  };
}

// ── Module-level default forwarder, configured from the environment ──────────
// Lazily constructed so a test can set env before first use, and so importing
// this module has zero side effects (no timer, no I/O) when unconfigured.
let _default = null;
function defaultForwarder() {
  if (!_default) {
    _default = createSecurityLogForwarder({
      url: process.env.SECURITY_LOG_FORWARD_URL,
      token: process.env.SECURITY_LOG_FORWARD_TOKEN,
    });
  }
  return _default;
}

/**
 * Public entrypoint the audit module calls. Enqueues one already-redacted
 * security event for forwarding. Inert unless SECURITY_LOG_FORWARD_URL is set.
 * NEVER throws, NEVER blocks the caller.
 */
export function forwardSecurityEvent(event) {
  try {
    defaultForwarder().enqueue(event);
  } catch { /* best-effort: never surface to the caller */ }
}

/**
 * Best-effort drain of the default forwarder — call on graceful shutdown so a
 * buffered batch is not lost. Never throws.
 */
export async function flushSecurityEvents() {
  try {
    await defaultForwarder().flush();
  } catch { /* best-effort */ }
}

/** Cancel the default forwarder's pending timer (shutdown). Never throws. */
export function stopSecurityLogForwarder() {
  try { if (_default) _default.stop(); } catch { /* noop */ }
}

/** Test hook: forget the env-configured default so a new env can take effect. */
export function _resetDefaultForwarderForTest() {
  try { if (_default) _default.stop(); } catch { /* noop */ }
  _default = null;
}

export const securityLogForwarder = {
  createSecurityLogForwarder,
  forwardSecurityEvent,
  flushSecurityEvents,
  stopSecurityLogForwarder,
};
