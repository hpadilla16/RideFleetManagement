/**
 * imap-client.js — a deliberately small IMAP4rev1 client over node:tls.
 *
 * WHY NOT A LIBRARY. This pipeline needs six verbs against one folder — LOGIN,
 * SELECT, UID SEARCH UNSEEN, UID FETCH BODY.PEEK[], UID STORE +FLAGS \Seen and
 * (optionally) UID MOVE — to feed reservations into a PCI-scoped production
 * system. A general IMAP library brings a dependency tree and a licence to
 * audit for a surface this narrow. Everything here is RFC 3501 with no
 * extensions assumed.
 *
 * THE ONE PIECE OF REAL IMAP COMPLEXITY is the literal: a server answers
 *
 *     * 1 FETCH (UID 4021 BODY[] {2345}
 *     <exactly 2345 bytes, which may contain CRLF and may contain "{" >
 *     )
 *
 * so the reader cannot be line-oriented alone. `readResponseLine` reads a line,
 * and while that line ends in `{n}` it consumes exactly n bytes and keeps
 * going. Getting this wrong does not throw — it silently truncates somebody's
 * reservation — so it is the piece the unit tests exercise hardest.
 *
 * WHAT IT NEVER DOES: it does not EXPUNGE and it does not delete. The worst
 * this client can do to a mailbox we do not own the policy for is flag a
 * message \Seen, or move it to a folder an operator explicitly named.
 */

import tls from 'node:tls';
import net from 'node:net';

export class ImapError extends Error {
  constructor(message, { command = null, response = null } = {}) {
    super(message);
    this.name = 'ImapError';
    this.command = command;
    this.response = response;
  }
}

/** Login was rejected — distinct from a transport failure so the caller can
 *  stamp IntegrationCredential.lastTestStatus = 'EXPIRED'. */
export class ImapAuthError extends ImapError {
  constructor(message) {
    super(message);
    this.name = 'ImapAuthError';
  }
}

/**
 * Quote a string for an IMAP command. Backslash and double quote are escaped;
 * anything with a CR or LF is refused outright rather than smuggled into the
 * command stream (that is command injection, on a socket that can delete mail).
 */
export function quote(value) {
  const s = String(value ?? '');
  if (/[\r\n]/.test(s)) throw new ImapError('IMAP argument may not contain CR or LF');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class ImapClient {
  constructor({
    host,
    port = 993,
    secure = true,
    connectTimeoutMs = 20000,
    commandTimeoutMs = 60000,
    logger = null,
  } = {}) {
    this.host = host;
    this.port = port;
    this.secure = secure !== false;
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.logger = logger;
    this.socket = null;
    this.capabilities = new Set();

    this._buffer = Buffer.alloc(0);
    this._waiter = null;   // { need: 'line'|number, resolve, reject }
    this._closed = false;
    this._error = null;
    this._tagSeq = 0;
  }

  // -------------------------------------------------------------------------
  // Socket plumbing
  // -------------------------------------------------------------------------

  connect() {
    if (!this.host) return Promise.reject(new ImapError('IMAP host is not configured'));
    return new Promise((resolve, reject) => {
      const onFail = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new ImapError(String(err)));
      };
      const timer = setTimeout(
        () => onFail(new ImapError(`IMAP connect to ${this.host}:${this.port} timed out`)),
        this.connectTimeoutMs,
      );
      const cleanup = () => clearTimeout(timer);

      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });

      // NOT setEncoding(null). That reads as "give me Buffers" and does the
      // opposite: Node builds a StringDecoder from the argument, and
      // `new StringDecoder(null)` defaults to utf8 — so the socket switches to
      // TEXT mode and every chunk arrives as a string. Buffer.concat then throws
      // inside the 'data' handler, the connect promise never settles, and the
      // caller sees a connect TIMEOUT with no hint of the real cause. That is
      // exactly what happened on the first real connection (Titan, 2026-09-08).
      // A socket with no encoding set is already in Buffer mode, so the correct
      // code is no call at all.
      socket.on('error', (err) => {
        this._error = err;
        this._rejectWaiter(err);
        onFail(err);
      });
      socket.on('close', () => {
        this._closed = true;
        this._rejectWaiter(new ImapError('IMAP connection closed'));
      });
      socket.on('data', (chunk) => this._onData(chunk));

      socket.once(this.secure ? 'secureConnect' : 'connect', async () => {
        this.socket = socket;
        try {
          const greeting = await this._readResponseLine();
          cleanup();
          if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting.text)) {
            return reject(new ImapError(`IMAP server refused the connection: ${greeting.text}`));
          }
          return resolve(this);
        } catch (err) {
          return onFail(err);
        }
      });
    });
  }

  _onData(chunk) {
    // Defensive: a caller that hands us a stream someone else already put in
    // text mode must not crash the socket. Binary-safe because IMAP literals
    // are octet counted — latin1 round-trips every byte 1:1, which utf8 would
    // not.
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'latin1');
    this._buffer = Buffer.concat([this._buffer, buf]);
    this._pump();
  }

  _pump() {
    while (this._waiter) {
      const { need, resolve } = this._waiter;
      if (need === 'line') {
        const idx = this._buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = this._buffer.subarray(0, idx);
        this._buffer = this._buffer.subarray(idx + 2);
        this._waiter = null;
        resolve(line);
      } else {
        if (this._buffer.length < need) return;
        const bytes = this._buffer.subarray(0, need);
        this._buffer = this._buffer.subarray(need);
        this._waiter = null;
        resolve(bytes);
      }
    }
  }

  _rejectWaiter(err) {
    if (!this._waiter) return;
    const { reject } = this._waiter;
    this._waiter = null;
    reject(err instanceof Error ? err : new ImapError(String(err)));
  }

  _read(need) {
    if (this._error) return Promise.reject(this._error);
    if (this._waiter) return Promise.reject(new ImapError('concurrent IMAP reads are not supported'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiter = null;
        reject(new ImapError('IMAP read timed out'));
      }, this.commandTimeoutMs);
      this._waiter = {
        need,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this._pump();
      if (this._closed && this._waiter) {
        this._waiter = null;
        clearTimeout(timer);
        reject(new ImapError('IMAP connection closed'));
      }
    });
  }

  /**
   * Read one logical response line, consuming any literals it announces.
   * @returns {Promise<{text: string, literals: Buffer[]}>}
   */
  async _readResponseLine() {
    const literals = [];
    let text = (await this._read('line')).toString('binary');

    // While the line ends with a literal marker, consume the octets and then
    // the rest of the line that follows them.
    for (let guard = 0; guard < 64; guard += 1) {
      const m = text.match(/\{(\d+)\}$/);
      if (!m) break;
      const size = Number(m[1]);
      if (!Number.isFinite(size) || size < 0 || size > 64 * 1024 * 1024) {
        throw new ImapError(`refusing an implausible IMAP literal size: ${m[1]}`);
      }
      literals.push(size === 0 ? Buffer.alloc(0) : await this._read(size));
      const rest = (await this._read('line')).toString('binary');
      text = `${text}${rest}`;
    }

    return { text, literals };
  }

  _send(raw) {
    if (!this.socket) throw new ImapError('IMAP socket is not connected');
    this.socket.write(`${raw}\r\n`);
  }

  /**
   * Run one tagged command.
   * @returns {Promise<{ok: boolean, status: string, tagLine: string, untagged: Array}>}
   */
  async execute(command, { expectOk = true } = {}) {
    this._tagSeq += 1;
    const tag = `A${String(this._tagSeq).padStart(4, '0')}`;
    this._send(`${tag} ${command}`);

    const untagged = [];
    for (let guard = 0; guard < 100000; guard += 1) {
      const line = await this._readResponseLine();
      if (line.text.startsWith(`${tag} `)) {
        const status = (line.text.slice(tag.length + 1).split(/\s+/)[0] || '').toUpperCase();
        const ok = status === 'OK';
        if (!ok && expectOk) {
          throw new ImapError(`IMAP ${command.split(' ')[0]} failed: ${line.text}`, {
            command, response: line.text,
          });
        }
        return { ok, status, tagLine: line.text, untagged };
      }
      if (line.text.startsWith('+ ')) continue; // continuation we never solicit
      untagged.push(line);
    }
    throw new ImapError(`IMAP command produced no tagged response: ${command}`);
  }

  // -------------------------------------------------------------------------
  // The six verbs
  // -------------------------------------------------------------------------

  async login(username, password) {
    try {
      const res = await this.execute(`LOGIN ${quote(username)} ${quote(password)}`);
      for (const u of res.untagged) {
        const caps = u.text.match(/^\*\s+CAPABILITY\s+(.*)$/i);
        if (caps) for (const c of caps[1].split(/\s+/)) this.capabilities.add(c.toUpperCase());
      }
      return res;
    } catch (err) {
      // A tagged NO on LOGIN is bad credentials, not a broken socket.
      if (err instanceof ImapError && /IMAP LOGIN failed/i.test(err.message)) {
        throw new ImapAuthError(`IMAP login rejected: ${err.response || err.message}`);
      }
      throw err;
    }
  }

  async capability() {
    const res = await this.execute('CAPABILITY');
    for (const u of res.untagged) {
      const caps = u.text.match(/^\*\s+CAPABILITY\s+(.*)$/i);
      if (caps) for (const c of caps[1].split(/\s+/)) this.capabilities.add(c.toUpperCase());
    }
    return this.capabilities;
  }

  async select(mailbox) {
    const res = await this.execute(`SELECT ${quote(mailbox)}`);
    let exists = null;
    for (const u of res.untagged) {
      const m = u.text.match(/^\*\s+(\d+)\s+EXISTS\b/i);
      if (m) exists = Number(m[1]);
    }
    return { exists };
  }

  /** UIDs of messages without the \Seen flag, oldest first. */
  async searchUnseen() {
    const res = await this.execute('UID SEARCH UNSEEN');
    const uids = [];
    for (const u of res.untagged) {
      const m = u.text.match(/^\*\s+SEARCH\b(.*)$/i);
      if (!m) continue;
      for (const tok of m[1].trim().split(/\s+/)) {
        const n = Number(tok);
        if (Number.isInteger(n) && n > 0) uids.push(n);
      }
    }
    return uids.sort((a, b) => a - b);
  }

  /**
   * Fetch one message in full WITHOUT marking it read (BODY.PEEK[]). Reading
   * and flagging are separate steps on purpose: a message is only flagged once
   * it has been recorded, so a crash mid-run re-delivers it instead of losing
   * a reservation.
   */
  async fetchRaw(uid) {
    const res = await this.execute(`UID FETCH ${Number(uid)} (BODY.PEEK[])`);
    for (const u of res.untagged) {
      if (!/FETCH/i.test(u.text) || !u.literals.length) continue;
      return u.literals[0];
    }
    return null;
  }

  async markSeen(uid) {
    await this.execute(`UID STORE ${Number(uid)} +FLAGS (\\Seen)`);
  }

  /**
   * Move a message to another folder. Best effort: a server without MOVE
   * (RFC 6851) returns a tagged NO, which is reported as `false` rather than
   * failing the run — the message is already flagged \Seen, so it will not be
   * picked up again, and tidy filing is not worth losing a run over.
   */
  async move(uid, mailbox) {
    const res = await this.execute(`UID MOVE ${Number(uid)} ${quote(mailbox)}`, { expectOk: false });
    return res.ok;
  }

  async logout() {
    try {
      if (this.socket && !this._closed) await this.execute('LOGOUT', { expectOk: false });
    } catch { /* a failed goodbye is not a failure */ }
    this.close();
  }

  close() {
    try { this.socket?.destroy(); } catch { /* already gone */ }
    this.socket = null;
    this._closed = true;
  }
}

export default { ImapClient, ImapError, ImapAuthError, quote };
