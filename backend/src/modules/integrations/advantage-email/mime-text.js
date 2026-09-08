/**
 * mime-text.js — pull the headers and the plain-text body out of a raw RFC 822
 * message. PURE: no I/O, no npm dependency, no prisma. Unit-tested directly.
 *
 * WHY NOT `mailparser`. This module needs one thing — the text/plain part of a
 * machine-generated report email — and the pipeline it feeds writes bookings
 * into a PCI-scoped production system. A full MIME parser brings a dependency
 * tree and a licence to audit for a job that is a few hundred lines of very
 * boring, very testable code. If Advantage ever starts sending something this
 * cannot read, the message is QUARANTINED with `no_text_body` and appears in
 * the panel — it is never silently misread.
 *
 * WHAT IT HANDLES
 *   - CRLF / LF / CR line endings, and the header/body split on the first blank
 *     line.
 *   - Folded (continued) header lines, per RFC 5322 §2.2.3.
 *   - RFC 2047 encoded words in header values (=?utf-8?B?…?= / =?…?Q?…?=),
 *     which is how a Subject with an accent arrives.
 *   - multipart/* — walks the parts and returns the FIRST text/plain it finds,
 *     at any nesting depth (multipart/mixed wrapping multipart/alternative is
 *     the common shape when a report has an attachment).
 *   - Content-Transfer-Encoding: quoted-printable and base64 (7bit/8bit/binary
 *     pass through).
 *   - charset= on the part, decoded through Node's own Buffer decoder, with a
 *     latin1 fallback for the legacy labels TSD-era systems still emit.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: attachments, nested message/rfc822,
 * signature verification. None of them are on the path from a confirmation
 * email to a staged reservation.
 */

/** CRLF / CR / LF -> LF. Every entry point runs input through this. */
export function normalizeEol(text) {
  return String(text == null ? '' : text)
    .split('\r\n').join('\n')
    .split('\r').join('\n');
}

/** Split a raw message into its header block and body, tolerating any EOL. */
export function splitMessage(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw || '').toString('binary');
  const normalized = normalizeEol(text);
  const idx = normalized.indexOf('\n\n');
  if (idx === -1) return { headerBlock: normalized, body: '' };
  return { headerBlock: normalized.slice(0, idx), body: normalized.slice(idx + 2) };
}

/**
 * Parse a header block into a lower-cased key → value map, unfolding
 * continuation lines. Repeated headers (Received:) keep the FIRST occurrence,
 * which is the one nearest the message for the headers we read.
 */
export function parseHeaders(headerBlock) {
  const out = {};
  // Normalize here as well as in splitMessage. JS `.` does not match a CR,
  // so a header line still carrying its CRLF fails the `label:value` match
  // outright and the header VANISHES rather than arriving mangled — silent,
  // and exactly the class of loss this module exists to not have.
  const lines = normalizeEol(String(headerBlock || '')).split('\n');
  let currentKey = null;
  let currentVal = '';

  const flush = () => {
    if (currentKey && !(currentKey in out)) out[currentKey] = currentVal.trim();
    currentKey = null;
    currentVal = '';
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentKey) {
      // Folded continuation — a single space replaces the fold (RFC 5322).
      currentVal += ` ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([!-9;-~]+)[ \t]*:(.*)$/);
    if (!m) continue;
    flush();
    currentKey = m[1].toLowerCase();
    currentVal = m[2];
  }
  flush();

  for (const k of Object.keys(out)) out[k] = decodeEncodedWords(out[k]);
  return out;
}

/** Decode RFC 2047 encoded words inside a header value. Never throws. */
export function decodeEncodedWords(value) {
  const s = String(value ?? '');
  if (!s.includes('=?')) return s;
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, payload) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeQuotedPrintable(payload.replace(/_/g, ' '), { headerMode: true }), 'binary');
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}

/**
 * Decode quoted-printable. `headerMode` skips soft-line-break handling (a
 * header encoded word has no soft breaks) and returns a binary-safe string.
 */
export function decodeQuotedPrintable(input, { headerMode = false } = {}) {
  let s = String(input ?? '');
  if (!headerMode) s = s.replace(/=\n/g, '').replace(/=$/gm, '');
  return s.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Bytes → string for a declared charset. Node natively knows utf-8, latin1 and
 * the utf-16 pair; everything else (windows-1252, iso-8859-1, us-ascii) is
 * close enough to latin1 for a report of ASCII field labels that guessing wrong
 * costs an accent, never a field.
 */
export function decodeBytes(bytes, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    if (cs === 'utf-8' || cs === 'utf8') return bytes.toString('utf8');
    if (cs === 'us-ascii' || cs === 'ascii') return bytes.toString('ascii');
    if (cs === 'utf-16' || cs === 'utf-16le' || cs === 'ucs-2') return bytes.toString('utf16le');
    return bytes.toString('latin1');
  } catch {
    return bytes.toString('latin1');
  }
}

/**
 * Split a header value on ';' while respecting double-quoted runs. A boundary
 * MAY legally contain a semicolon (RFC 2045 quotes it for exactly that
 * reason), and a naive split truncates such a boundary to a prefix — which
 * does not throw. It just finds no parts, and the message quarantines as
 * "no text/plain" with nothing pointing at the real cause.
 */
function splitParams(value) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') { quoted = !quoted; current += ch; continue; }
    if (ch === ';' && !quoted) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Parse a Content-Type value into { type, params }. */
export function parseContentType(value) {
  const s = String(value || '').trim();
  if (!s) return { type: 'text/plain', params: {} };
  const [head, ...rest] = splitParams(s);
  const params = {};
  for (const chunk of rest) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const k = chunk.slice(0, eq).trim().toLowerCase();
    let v = chunk.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type: head.trim().toLowerCase(), params };
}

/** Decode one part's body given its transfer encoding + charset. */
function decodePart(body, headers) {
  const enc = String(headers['content-transfer-encoding'] || '').trim().toLowerCase();
  const { params } = parseContentType(headers['content-type']);
  const charset = params.charset;

  if (enc === 'base64') {
    const cleaned = body.replace(/[^A-Za-z0-9+/=]/g, '');
    return decodeBytes(Buffer.from(cleaned, 'base64'), charset);
  }
  if (enc === 'quoted-printable') {
    return decodeBytes(Buffer.from(decodeQuotedPrintable(body), 'binary'), charset);
  }
  // 7bit / 8bit / binary / absent. The raw text arrived as binary-safe chars.
  return decodeBytes(Buffer.from(body, 'binary'), charset || 'utf-8');
}

/** Split a multipart body on its boundary into raw part strings. */
function splitParts(body, boundary) {
  const marker = `--${boundary}`;
  const out = [];
  const lines = body.split('\n');
  let current = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === marker) {
      if (current !== null) out.push(current.join('\n'));
      current = [];
      continue;
    }
    if (trimmed === `${marker}--`) {
      if (current !== null) out.push(current.join('\n'));
      current = null;
      break;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) out.push(current.join('\n'));
  return out;
}

/**
 * Find the first text/plain body in a (possibly nested) part.
 * @returns {string|null}
 */
function firstTextPlain(rawPart, depth = 0) {
  if (depth > 8) return null; // pathological nesting — refuse rather than spin
  const { headerBlock, body } = splitMessage(rawPart);
  const headers = parseHeaders(headerBlock);
  const { type, params } = parseContentType(headers['content-type'] || 'text/plain');

  if (type.startsWith('multipart/')) {
    if (!params.boundary) return null;
    for (const part of splitParts(body, params.boundary)) {
      const hit = firstTextPlain(part, depth + 1);
      if (hit != null) return hit;
    }
    return null;
  }

  if (type === 'text/plain') return decodePart(body, headers);
  return null;
}

/**
 * Extract what the parser needs from a raw RFC 822 message.
 *
 * @param {string|Buffer} raw
 * @returns {{ headers: object, from: string|null, subject: string|null,
 *             messageId: string|null, date: Date|null, text: string|null }}
 *   `text` is null when the message carries no text/plain part at any depth —
 *   the caller QUARANTINES on that rather than guessing from HTML.
 */
export function extractMessage(raw) {
  const rawStr = typeof raw === 'string' ? raw : Buffer.from(raw || '').toString('binary');
  const { headerBlock, body } = splitMessage(rawStr);
  const headers = parseHeaders(headerBlock);
  const { type, params } = parseContentType(headers['content-type'] || 'text/plain');

  let text = null;
  if (type.startsWith('multipart/')) {
    if (params.boundary) {
      for (const part of splitParts(body, params.boundary)) {
        const hit = firstTextPlain(part, 1);
        if (hit != null) { text = hit; break; }
      }
    }
  } else if (type === 'text/plain') {
    text = decodePart(body, headers);
  }

  let date = null;
  if (headers.date) {
    const parsed = new Date(headers.date);
    if (Number.isFinite(parsed.valueOf())) date = parsed;
  }

  return {
    headers,
    from: headers.from || null,
    subject: headers.subject || null,
    messageId: (headers['message-id'] || '').trim() || null,
    date,
    text: text && text.trim() ? text : null,
  };
}

export default { extractMessage, splitMessage, parseHeaders, parseContentType, decodeQuotedPrintable, decodeEncodedWords, decodeBytes };
