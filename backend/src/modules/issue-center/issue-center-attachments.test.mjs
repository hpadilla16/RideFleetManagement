import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIssueResponseAttachments } from './issue-center-attachments.js';

test('normalizeIssueResponseAttachments accepts a supported image data URL', () => {
  const rows = normalizeIssueResponseAttachments([
    {
      name: 'photo.png',
      dataUrl: 'data:image/png;base64,ZmFrZQ=='
    }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mimeType, 'image/png');
  assert.equal(rows[0].name, 'photo.png');
});

test('normalizeIssueResponseAttachments rejects unsupported mime types', () => {
  assert.throws(() => normalizeIssueResponseAttachments([
    {
      name: 'script.js',
      dataUrl: 'data:application/javascript;base64,ZmFrZQ=='
    }
  ]), /images, PDF, DOC, DOCX, or TXT/i);
});

test('normalizeIssueResponseAttachments rejects too many attachments', () => {
  const attachments = Array.from({ length: 7 }, (_, index) => ({
    name: `file-${index}.txt`,
    dataUrl: 'data:text/plain;base64,ZmFrZQ=='
  }));
  assert.throws(() => normalizeIssueResponseAttachments(attachments), /at most 6/i);
});

