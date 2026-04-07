const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function parseDataUrl(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([^;,]+)(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error('attachments must be valid data URLs');
  }
  return {
    mimeType: String(match[1] || '').toLowerCase(),
    base64: !!match[2],
    payload: match[3] || '',
    dataUrl: raw
  };
}

function isAllowedMimeType(mimeType) {
  if (!mimeType) return false;
  if (mimeType.startsWith('image/')) return true;
  return [
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ].includes(mimeType);
}

function estimateBytes(parsed) {
  if (parsed.base64) {
    const normalized = parsed.payload.replace(/\s+/g, '');
    return Math.floor((normalized.length * 3) / 4);
  }
  return Buffer.byteLength(decodeURIComponent(parsed.payload), 'utf8');
}

export function normalizeIssueResponseAttachments(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error('attachments must be an array');
  }
  if (input.length > MAX_ATTACHMENTS) {
    throw new Error(`attachments must contain at most ${MAX_ATTACHMENTS} files`);
  }

  const normalized = [];
  let totalBytes = 0;

  for (const item of input) {
    const name = String(item?.name || 'document').trim().slice(0, 180) || 'document';
    const parsed = parseDataUrl(item?.dataUrl);
    if (!isAllowedMimeType(parsed.mimeType)) {
      throw new Error('attachments must be images, PDF, DOC, DOCX, or TXT');
    }
    const byteLength = estimateBytes(parsed);
    if (byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error('each attachment must be 3 MB or smaller');
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('combined attachment size must be 12 MB or smaller');
    }
    normalized.push({
      name,
      dataUrl: parsed.dataUrl,
      mimeType: parsed.mimeType,
      byteLength
    });
  }

  return normalized;
}

