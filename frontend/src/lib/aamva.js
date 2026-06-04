/**
 * AAMVA PDF417 barcode parser for US/Canada driver's licenses.
 *
 * The back-of-license PDF417 barcode encodes the holder's data as a set of
 * 3-letter element IDs (AAMVA DL/ID subfile), each followed by its value and
 * terminated by a line break. This parses the common identity fields we use
 * to pre-fill the loaner check-out wizard. Decoding the barcode is far more
 * reliable than OCR of the printed front (see doc/loaner-reimagining-plan).
 *
 * Reference: AAMVA DL/ID Card Design Standard, mandatory data elements.
 */

const ELEMENT_CODES = {
  firstName: 'DAC',
  middleName: 'DAD',
  lastName: 'DCS',
  // DCT = full given names (first + middle) — fallback when DAC absent.
  givenNames: 'DCT',
  dob: 'DBB',
  expiry: 'DBA',
  issued: 'DBD',
  licenseNumber: 'DAQ',
  address: 'DAG',
  city: 'DAI',
  state: 'DAJ',
  postalCode: 'DAK',
  country: 'DCG'
};

function extract(text, code) {
  // Anchor on start-of-record or a line break; tolerate the leading "DL"
  // subfile designator that precedes the very first element (e.g. "DLDAQ...").
  const re = new RegExp(`(?:^|[\\r\\n])(?:DL)?${code}([^\\r\\n]*)`);
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// AAMVA dates are 8 digits — MMDDYYYY for USA, CCYYMMDD elsewhere (and on
// newer US cards). Detect by leading 4-digit year, else fall back to country.
function parseAamvaDate(raw, country) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 8) return '';
  const leadYear = Number(digits.slice(0, 4));
  let y, mo, d;
  if (leadYear >= 1900 && leadYear <= 2100) {
    // CCYYMMDD
    y = digits.slice(0, 4); mo = digits.slice(4, 6); d = digits.slice(6, 8);
  } else if (String(country || '').toUpperCase().startsWith('CAN')) {
    y = digits.slice(0, 4); mo = digits.slice(4, 6); d = digits.slice(6, 8);
  } else {
    // MMDDYYYY (US default)
    mo = digits.slice(0, 2); d = digits.slice(2, 4); y = digits.slice(4, 8);
  }
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${mo}-${d}`;
}

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Parse a decoded PDF417 string into identity fields. Returns null if the
 * text doesn't look like an AAMVA license barcode.
 */
export function parseAamva(text) {
  if (!text || typeof text !== 'string') return null;
  // AAMVA payloads contain the "ANSI " header and DL/ID element codes.
  if (!/ANSI |DAQ|DCS/.test(text)) return null;

  const country = extract(text, ELEMENT_CODES.country);
  let firstName = extract(text, ELEMENT_CODES.firstName);
  const middleName = extract(text, ELEMENT_CODES.middleName);
  if (!firstName) {
    const given = extract(text, ELEMENT_CODES.givenNames);
    if (given) firstName = given.split(/[ ,]+/)[0];
  }
  const lastName = extract(text, ELEMENT_CODES.lastName);

  const fields = {
    firstName: titleCase(firstName),
    middleName: titleCase(middleName),
    lastName: titleCase(lastName),
    dateOfBirth: parseAamvaDate(extract(text, ELEMENT_CODES.dob), country),
    licenseNumber: extract(text, ELEMENT_CODES.licenseNumber),
    licenseExpiry: parseAamvaDate(extract(text, ELEMENT_CODES.expiry), country),
    licenseState: extract(text, ELEMENT_CODES.state).toUpperCase(),
    address: titleCase(extract(text, ELEMENT_CODES.address)),
    city: titleCase(extract(text, ELEMENT_CODES.city)),
    postalCode: extract(text, ELEMENT_CODES.postalCode),
    country: country.toUpperCase()
  };

  // Require at least a license number or a name to consider it a valid read.
  if (!fields.licenseNumber && !fields.lastName) return null;
  return fields;
}

/** Map parsed AAMVA fields to the loaner check-out wizard form shape. */
export function aamvaToLoanerForm(fields) {
  if (!fields) return {};
  return {
    customerFirstName: fields.firstName || '',
    customerLastName: fields.lastName || '',
    licenseNumber: fields.licenseNumber || '',
    licenseState: fields.licenseState || '',
    licenseExpiry: fields.licenseExpiry || ''
  };
}
