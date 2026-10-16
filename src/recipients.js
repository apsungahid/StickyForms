// Reads a recipient list (name + email) from an uploaded .xlsx or .csv file.
const ExcelJS = require('exceljs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1000;

// ---------- File -> rows of strings ----------

function parseCsv(text) {
  text = text.replace(/^﻿/, ''); // strip BOM (Excel "CSV UTF-8")
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  // Excel in many regions saves CSV with ";" — pick whichever separator the header uses more.
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((s) => s.actualRowCount > 0) || wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (r) => {
    const cells = [];
    for (let c = 1; c <= r.cellCount; c++) cells.push(r.getCell(c).text ?? '');
    rows.push(cells);
  });
  return rows;
}

async function readRows(buffer, filename = '') {
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b; // .xlsx files are zip archives
  if (isZip) return parseXlsx(buffer);
  if (/\.xls$/i.test(filename)) {
    throw new Error('Old .xls files are not supported. In Excel use File > Save As > "Excel Workbook (.xlsx)" or "CSV".');
  }
  return parseCsv(buffer.toString('utf8'));
}

// ---------- Rows -> recipients ----------

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

function findColumns(rows) {
  // Look for a header row in the first few rows.
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const h = rows[i].map((v) => clean(v).toLowerCase());
    const email = h.findIndex((v) => /e-?mail/.test(v));
    if (email === -1) continue;
    const first = h.findIndex((v) => /first/.test(v));
    const last = h.findIndex((v) => /last|surname|family/.test(v));
    let name = h.findIndex((v, idx) => idx !== email && /name|recipient|contact|person/.test(v) && !/first|last|sur|family|company|user/.test(v));
    if (name === -1 && first === -1) name = h.findIndex((v, idx) => idx !== email && /name/.test(v));
    return { headerRow: i, email, name, first, last };
  }
  // No header: email = the column with the most "@" values; name = first other non-empty column.
  const width = Math.max(0, ...rows.map((r) => r.length));
  let email = -1;
  let best = 0;
  for (let c = 0; c < width; c++) {
    const hits = rows.filter((r) => EMAIL_RE.test(clean(r[c]))).length;
    if (hits > best) { best = hits; email = c; }
  }
  if (email === -1) return null;
  let name = -1;
  for (let c = 0; c < width && name === -1; c++) {
    if (c !== email && rows.some((r) => clean(r[c]))) name = c;
  }
  return { headerRow: -1, email, name, first: -1, last: -1 };
}

/**
 * Returns { recipients: [{ row, name, email, error }], validCount }.
 * `row` is the 1-based spreadsheet row so users can find problems in their file.
 */
function extractRecipients(rows) {
  const cols = findColumns(rows);
  if (!cols) {
    throw new Error('Could not find an email column. Add a header row with "Name" and "Email" columns.');
  }

  const seen = new Set();
  const recipients = [];
  for (let i = cols.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const email = clean(r[cols.email]).replace(/^mailto:/i, '');
    let name = cols.name !== -1 ? clean(r[cols.name]) : '';
    if (!name && (cols.first !== -1 || cols.last !== -1)) {
      name = clean(`${cols.first !== -1 ? clean(r[cols.first]) : ''} ${cols.last !== -1 ? clean(r[cols.last]) : ''}`);
    }
    if (!email && !name) continue; // blank row

    let error = null;
    if (!email) error = 'Missing email';
    else if (!EMAIL_RE.test(email)) error = 'Invalid email';
    else if (seen.has(email.toLowerCase())) error = 'Duplicate email';
    if (!error) seen.add(email.toLowerCase());

    recipients.push({ row: i + 1, name: name.slice(0, 200), email: email.slice(0, 320), error });
  }

  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(`Too many rows (${recipients.length}). The limit is ${MAX_RECIPIENTS} recipients per upload.`);
  }
  return { recipients, validCount: recipients.filter((r) => !r.error).length };
}

async function parseRecipientFile(buffer, filename) {
  const rows = await readRows(buffer, filename);
  return extractRecipients(rows);
}

module.exports = { parseRecipientFile, parseCsv, extractRecipients, EMAIL_RE, MAX_RECIPIENTS };
