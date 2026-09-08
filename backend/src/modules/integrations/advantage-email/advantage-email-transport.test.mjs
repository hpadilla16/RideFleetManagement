/**
 * advantage-email-transport.test.mjs — the two pieces written from scratch
 * instead of pulled from npm: the MIME text extractor and the IMAP client.
 *
 * WHY THESE ARE TESTED HARD. Neither fails loudly. A MIME bug returns a
 * truncated body, which the parser then refuses with `layout` — a quarantined
 * message with a misleading reason. An IMAP literal bug returns HALF of
 * somebody's confirmation and everything downstream believes it. So the cases
 * here are mostly about the boundaries where truncation hides: a literal whose
 * payload contains CRLF, a literal whose payload contains a `{`, a
 * quoted-printable soft line break, a base64 part, and a text/plain buried
 * inside multipart/mixed → multipart/alternative.
 *
 * NO SOCKET: the client's read path is driven by feeding bytes to its own
 * `_onData`, which is exactly what the TLS socket does in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  extractMessage, parseHeaders, parseContentType,
  decodeQuotedPrintable, decodeEncodedWords,
} = await import('./mime-text.js');
const { ImapClient, ImapError, quote } = await import('./imap-client.js');

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

const CRLF = (s) => s.replace(/\n/g, '\r\n');

test('extracts a plain us-ascii message and its headers', () => {
  const raw = CRLF(
    'Message-ID: <a@advantage.com>\n'
    + 'From: "Advantage Rez" <rez@advantage.com>\n'
    + 'Subject: Confirmation AEXP141D54\n'
    + 'Date: Fri, 07 Aug 2026 13:53:16 -0400\n'
    + 'Content-Type: text/plain; charset=us-ascii\n'
    + '\nConfirmation #    : AEXP141D54\n',
  );
  const msg = extractMessage(raw);
  assert.equal(msg.messageId, '<a@advantage.com>');
  assert.equal(msg.from, '"Advantage Rez" <rez@advantage.com>');
  assert.equal(msg.subject, 'Confirmation AEXP141D54');
  assert.equal(msg.date.toISOString(), '2026-08-07T17:53:16.000Z');
  assert.match(msg.text, /Confirmation #\s+: AEXP141D54/);
});

test('unfolds a header split across lines', () => {
  const headers = parseHeaders('Subject: Advantage\r\n  Confirmation\r\n\tAEXP141D54\r\nFrom: a@b.c');
  assert.equal(headers.subject, 'Advantage Confirmation AEXP141D54');
  assert.equal(headers.from, 'a@b.c');
});

test('finds the text/plain inside multipart/mixed wrapping multipart/alternative', () => {
  // The shape a report email takes the day somebody attaches a PDF to it.
  const raw = CRLF(
    'From: rez@advantage.com\n'
    + 'Content-Type: multipart/mixed; boundary="OUTER"\n'
    + '\n--OUTER\n'
    + 'Content-Type: multipart/alternative; boundary="INNER"\n'
    + '\n--INNER\n'
    + 'Content-Type: text/html; charset=utf-8\n'
    + '\n<html>ignore me</html>\n'
    + '--INNER\n'
    + 'Content-Type: text/plain; charset=utf-8\n'
    + '\nConfirmation #    : AEXP141D54\n'
    + '--INNER--\n'
    + '--OUTER\n'
    + 'Content-Type: application/pdf; name="x.pdf"\n'
    + '\n%PDF-1.4\n'
    + '--OUTER--\n',
  );
  const msg = extractMessage(raw);
  assert.match(msg.text, /AEXP141D54/);
  assert.ok(!msg.text.includes('<html>'), 'the HTML alternative must not be returned');
});

test('decodes quoted-printable, including a soft line break mid-word', () => {
  // A fixed-column report is exactly the shape that hits the 76-column wrap.
  const raw = CRLF(
    'From: rez@advantage.com\n'
    + 'Content-Type: text/plain; charset=utf-8\n'
    + 'Content-Transfer-Encoding: quoted-printable\n'
    + '\nConfirmed Rate    : 14.72/Day  for 5 day(s) , 14.72/Extra D=\nay  UNL\n',
  );
  assert.match(extractMessage(raw).text, /14\.72\/Extra Day {2}UNL/);
  assert.equal(decodeQuotedPrintable('caf=C3=A9'), 'cafÃ©');
});

test('decodes a base64 part', () => {
  const body = 'Confirmation #    : AEXP141D54\r\nRenter Name       : SAMPLE, TESTER\r\n';
  const raw = CRLF(
    'From: rez@advantage.com\n'
    + 'Content-Type: text/plain; charset=utf-8\n'
    + 'Content-Transfer-Encoding: base64\n'
    + `\n${Buffer.from(body, 'utf8').toString('base64')}\n`,
  );
  assert.equal(extractMessage(raw).text.trim(), body.trim());
});

test('decodes an RFC 2047 encoded Subject', () => {
  assert.equal(
    decodeEncodedWords('=?utf-8?B?QWR2YW50YWdlIENvbmZpcm1hY2nDs24=?='),
    'Advantage Confirmación',
  );
  assert.equal(decodeEncodedWords('=?iso-8859-1?Q?Confirmaci=F3n?='), 'Confirmación');
  assert.equal(decodeEncodedWords('plain subject'), 'plain subject');
});

test('returns null text — never a guess — for an HTML-only message', () => {
  const raw = CRLF('From: a@b.c\nContent-Type: text/html\n\n<p>hi</p>\n');
  assert.equal(extractMessage(raw).text, null);
});

test('parses a Content-Type with quoted params', () => {
  assert.deepEqual(
    parseContentType('multipart/mixed; boundary="a=b; c"; charset=utf-8'),
    { type: 'multipart/mixed', params: { boundary: 'a=b; c', charset: 'utf-8' } },
  );
});

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

/** A client wired to a fake socket that records what was written. */
function fakeClient() {
  const client = new ImapClient({ host: 'imap.test', commandTimeoutMs: 2000 });
  const sent = [];
  client.socket = { write: (s) => sent.push(s), destroy() {} };
  client._closed = false;
  return { client, sent, feed: (s) => client._onData(Buffer.from(s, 'binary')) };
}

test('reads a FETCH literal whose payload contains CRLF and a brace', () => {
  // The bug this exists for does not throw: a line-oriented reader would stop
  // at the first CRLF inside the literal and hand the parser half a
  // confirmation, which then quarantines as a layout error.
  const payload = 'Confirmation #    : AEXP141D54\r\nNotes: {not a literal}\r\n';
  const { client, feed } = fakeClient();
  const p = client.execute('UID FETCH 4021 (BODY.PEEK[])');
  feed(
    `* 1 FETCH (UID 4021 BODY[] {${Buffer.byteLength(payload, 'binary')}}\r\n`
    + `${payload})\r\n`
    + 'A0001 OK FETCH completed\r\n',
  );
  return p.then((res) => {
    assert.equal(res.ok, true);
    assert.equal(res.untagged.length, 1);
    assert.equal(res.untagged[0].literals[0].toString('binary'), payload);
    // The two halves of the logical line are joined, so the ")" is not read as
    // a stray untagged response.
    assert.match(res.untagged[0].text, /UID 4021 BODY\[\]/);
  });
});

test('fetchRaw returns the literal body', () => {
  const payload = 'Advantage Orlando (61302)\r\n';
  const { client, feed } = fakeClient();
  const p = client.fetchRaw(4021);
  feed(
    `* 1 FETCH (UID 4021 BODY[] {${payload.length}}\r\n${payload})\r\n`
    + 'A0001 OK FETCH completed\r\n',
  );
  return p.then((buf) => assert.equal(buf.toString('binary'), payload));
});

test('parses a UID SEARCH response, and an empty one', () => {
  const a = fakeClient();
  const p1 = a.client.searchUnseen();
  a.feed('* SEARCH 7 3 11\r\nA0001 OK SEARCH completed\r\n');

  const b = fakeClient();
  const p2 = b.client.searchUnseen();
  b.feed('* SEARCH\r\nA0001 OK SEARCH completed\r\n');

  return Promise.all([p1, p2]).then(([withHits, empty]) => {
    assert.deepEqual(withHits, [3, 7, 11], 'oldest first');
    assert.deepEqual(empty, []);
  });
});

test('a tagged NO on LOGIN is an auth error, not a transport error', async () => {
  const { client, feed } = fakeClient();
  const p = client.login('user', 'pass');
  feed('A0001 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
  await assert.rejects(p, (err) => {
    assert.equal(err.name, 'ImapAuthError');
    assert.match(err.message, /Invalid credentials/);
    return true;
  });
});

test('MOVE reports failure instead of failing the run', () => {
  // A server without RFC 6851, or a folder that does not exist. The message is
  // already flagged \Seen, so tidy filing is not worth losing a run over.
  const { client, feed } = fakeClient();
  const p = client.move(4021, 'Processed');
  feed('A0001 NO [TRYCREATE] no such mailbox\r\n');
  return p.then((ok) => assert.equal(ok, false));
});

test('quote escapes what IMAP requires and refuses what it cannot escape', () => {
  assert.equal(quote('INBOX'), '"INBOX"');
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  // A CR/LF in a mailbox name or a password would be smuggled into the command
  // stream on a socket that can move mail.
  assert.throws(() => quote('INBOX\r\nA1 DELETE "x"'), ImapError);
});

test('refuses an implausible literal size rather than trying to buffer it', async () => {
  const { client, feed } = fakeClient();
  const p = client.execute('UID FETCH 1 (BODY.PEEK[])');
  feed('* 1 FETCH (UID 1 BODY[] {999999999}\r\n');
  await assert.rejects(p, /implausible IMAP literal size/);
});

test('login records the capabilities the server volunteers', () => {
  const { client, feed } = fakeClient();
  const p = client.login('u', 'p');
  feed('* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\nA0001 OK LOGIN completed\r\n');
  return p.then(() => {
    assert.equal(client.capabilities.has('MOVE'), true);
    assert.equal(client.capabilities.has('UIDPLUS'), true);
  });
});

// ---------------------------------------------------------------------------
// The read path must survive a socket that is in TEXT mode (2026-09-08).
//
// The header above says feeding _onData "is exactly what the TLS socket does in
// production". It was not. connect() called `socket.setEncoding(null)`, which
// reads as "give me Buffers" and does the opposite — Node builds a
// StringDecoder from the argument and `new StringDecoder(null)` defaults to
// utf8, so every chunk arrived as a STRING. Buffer.concat threw inside the
// 'data' handler, the connect promise never settled, and the caller saw a
// connect TIMEOUT naming the host and port — pointing at the network, which was
// fine. The first real connection ever attempted (Titan, 2026-09-08) failed
// this way, and every one of the sixteen tests above passed while it did,
// because they all feed Buffers.
//
// The setEncoding call is gone. This pins the defence that goes with it.
// ---------------------------------------------------------------------------
test('a chunk arriving as a STRING is handled, not thrown on', () => {
  const { client } = fakeClient();
  const greeting = '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR ID LITERAL-] At Your Service\r\n';

  assert.doesNotThrow(() => client._onData(greeting), 'a text-mode socket must not crash the reader');
  assert.ok(Buffer.isBuffer(client._buffer), 'the internal buffer stays a Buffer');
  assert.equal(client._buffer.toString('latin1'), greeting, 'and the bytes are intact');
});

test('string and Buffer chunks interleave without corrupting the stream', () => {
  const { client } = fakeClient();
  client._onData('* OK part one ');
  client._onData(Buffer.from('and part two\r\n', 'binary'));
  assert.equal(client._buffer.toString('latin1'), '* OK part one and part two\r\n');
});

test('a high byte survives a string chunk — latin1, not utf8', () => {
  // IMAP literals are octet-counted, so a byte-count read must not be shifted
  // by a multi-byte decode. 0xE9 is one octet and has to stay one octet.
  const { client } = fakeClient();
  client._onData(Buffer.from([0xE9]).toString('latin1'));
  assert.equal(client._buffer.length, 1, 'one byte in, one byte held');
  assert.equal(client._buffer[0], 0xE9);
});
