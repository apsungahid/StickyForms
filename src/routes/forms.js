// Admin API: manage forms, generate personal links, read submissions.
const express = require('express');
const { randomUUID, randomBytes } = require('crypto');
const { db, parseJson, toIso } = require('../db');
const { validateFormInput } = require('../validation');
const { parseRecipientFile, EMAIL_RE, MAX_RECIPIENTS } = require('../recipients');
const config = require('../config');
const ExcelJS = require('exceljs');
const storage = require('../storage');
const mailer = require('../mailer');
const path = require('path');
const fs = require('fs/promises');
const archiver = require('archiver');
const { tally, answerText } = require('../results');

const router = express.Router();
const { detectPosterType, POSTER_MAX_MB, sendPoster } = require('../poster');

const serializeForm = (row, extra = {}) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  fields: parseJson(row.fields, []),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
  locked: Boolean(row.locked_at),
  lockedAt: toIso(row.locked_at),
  // ?v= changes whenever the poster is replaced, so browsers don't show a stale cached image.
  posterUrl: row.poster_path ? `/api/forms/${row.id}/poster?v=${encodeURIComponent(toIso(row.poster_updated_at) || '')}` : null,
  ...extra,
});

// Titles must be unique (ignoring case) so forms are easy to tell apart.
// Titles are unique per account (two different people may both have a "Survey").
async function titleTaken(ownerId, title, exceptId = null) {
  const q = db('forms').where({ owner_id: ownerId }).whereRaw('lower(title) = ?', [title.trim().toLowerCase()]);
  if (exceptId) q.whereNot({ id: exceptId });
  return Boolean(await q.first('id'));
}
const titleTakenError = (title) => ({ error: 'Title already in use', details: [`A form called "${title}" already exists. Please choose a different title.`] });

function baseUrl(req) {
  return config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

const serializeLink = (row, req) => ({
  id: row.id,
  formId: row.form_id,
  token: row.token,
  url: `${baseUrl(req)}/f/${row.token}`,
  recipientName: row.recipient_name,
  recipientEmail: row.recipient_email,
  maxSubmissions: row.max_submissions,
  submissionCount: row.submission_count,
  expiresAt: toIso(row.expires_at),
  createdAt: toIso(row.created_at),
  sentAt: toIso(row.sent_at),
  sendCount: row.send_count || 0,
  lastEmailStatus: row.last_email_status || null,
  lastEmailError: row.last_email_error || null,
  replacedBy: row.replaced_by || null,
  replacedAt: toIso(row.replaced_at),
  state: linkState(row),
});

// replaced | expired | used | active
function linkState(row) {
  if (row.replaced_by) return 'replaced';
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  if (row.max_submissions != null && row.submission_count >= row.max_submissions) return 'used';
  return 'active';
}

// Only the signed-in owner can see or change a form; anyone else gets "not found".
async function loadForm(req, res, next) {
  const row = await db('forms').where({ id: req.params.id, owner_id: req.user.id }).first();
  if (!row) return res.status(404).json({ error: 'Form not found' });
  req.formRow = row;
  next();
}

router.get('/', async (req, res) => {
  const rows = await db('forms')
    .select(
      'forms.*',
      db('submissions').count('*').whereRaw('submissions.form_id = forms.id').as('submission_count'),
      db('links').count('*').whereRaw('links.form_id = forms.id').as('link_count'),
    )
    .where('forms.owner_id', req.user.id)
    .orderBy('created_at', 'desc');
  res.json(
    rows.map((r) =>
      serializeForm(r, { submissionCount: Number(r.submission_count), linkCount: Number(r.link_count) }),
    ),
  );
});

router.post('/', async (req, res) => {
  const { errors, value } = validateFormInput(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid form', details: errors });
  if (await titleTaken(req.user.id, value.title)) return res.status(409).json(titleTakenError(value.title));
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    title: value.title,
    description: value.description || null,
    fields: JSON.stringify(value.fields),
    created_at: now,
    updated_at: now,
  };
  await db('forms').insert({ ...row, owner_id: req.user.id });
  res.status(201).json(serializeForm(row));
});

router.get('/:id', loadForm, (req, res) => res.json(serializeForm(req.formRow)));

router.put('/:id', loadForm, async (req, res) => {
  const { errors, value } = validateFormInput(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid form', details: errors });
  if (await titleTaken(req.user.id, value.title, req.params.id)) return res.status(409).json(titleTakenError(value.title));
  const changes = {
    title: value.title,
    description: value.description || null,
    fields: JSON.stringify(value.fields),
    updated_at: new Date().toISOString(),
  };
  await db('forms').where({ id: req.params.id }).update(changes);
  res.json(serializeForm({ ...req.formRow, ...changes }));
});

// Duplicate: copies the questions and email template, but no recipients, links or submissions.
router.post('/:id/duplicate', loadForm, async (req, res) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  const errors = [];
  if (!title) errors.push('A new title is required');
  if (title.length > 200) errors.push('Title must be 200 characters or fewer');
  if (errors.length) return res.status(400).json({ error: 'Invalid copy', details: errors });
  if (await titleTaken(req.user.id, title)) return res.status(409).json(titleTakenError(title));

  const now = new Date().toISOString();
  const src = req.formRow;
  const row = {
    id: randomUUID(),
    title,
    description: description || null,
    fields: typeof src.fields === 'string' ? src.fields : JSON.stringify(src.fields),
    email_subject: src.email_subject,
    email_message: src.email_message,
    locked_at: null, // the copy starts open
    created_at: now,
    updated_at: now,
  };
  if (src.poster_path) { // the copy gets its own copy of the poster image
    try {
      row.poster_path = await storage.copyPoster(src.poster_path, row.id);
      row.poster_type = src.poster_type;
      row.poster_updated_at = now;
    } catch { /* original poster file missing: copy without a poster */ }
  }
  await db('forms').insert({ ...row, owner_id: req.user.id });
  res.status(201).json(serializeForm(row));
});

// ---------- Poster image ----------
// Raw image body (Content-Type image/*). JPG, PNG, GIF or WebP, checked by the file's contents, not its name.
router.put(
  '/:id/poster',
  express.raw({ type: () => true, limit: `${POSTER_MAX_MB + 1}mb` }),
  loadForm,
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'No image received' });
    if (buf.length > POSTER_MAX_MB * 1024 * 1024) return res.status(413).json({ error: `The poster image is too large (max ${POSTER_MAX_MB} MB).` });
    const type = detectPosterType(buf);
    if (!type) return res.status(400).json({ error: 'The poster must be a JPG, PNG, GIF or WebP image.' });
    const rel = await storage.writePoster(req.params.id, buf, type.ext);
    const changes = { poster_path: rel, poster_type: type.mime, poster_updated_at: new Date().toISOString() };
    await db('forms').where({ id: req.params.id }).update(changes);
    if (req.formRow.poster_path) await storage.removeFile(req.formRow.poster_path);
    res.json(serializeForm({ ...req.formRow, ...changes }));
  },
);

router.delete('/:id/poster', loadForm, async (req, res) => {
  const changes = { poster_path: null, poster_type: null, poster_updated_at: null };
  await db('forms').where({ id: req.params.id }).update(changes);
  await storage.removeFile(req.formRow.poster_path);
  res.json(serializeForm({ ...req.formRow, ...changes }));
});

router.get('/:id/poster', loadForm, (req, res) => sendPoster(res, req.formRow));

// Lock = temporarily refuse new submissions on every link. Unlock = links work again (unless expired/used).
router.post('/:id/lock', loadForm, async (req, res) => {
  const lockedAt = req.formRow.locked_at || new Date().toISOString();
  await db('forms').where({ id: req.params.id }).update({ locked_at: lockedAt });
  res.json(serializeForm({ ...req.formRow, locked_at: lockedAt }));
});
router.post('/:id/unlock', loadForm, async (req, res) => {
  await db('forms').where({ id: req.params.id }).update({ locked_at: null });
  res.json(serializeForm({ ...req.formRow, locked_at: null }));
});

router.delete('/:id', loadForm, async (req, res) => {
  await db('forms').where({ id: req.params.id }).del();
  await storage.removeForm(req.params.id); // uploaded files for this form
  res.status(204).end();
});

router.get('/:id/links', loadForm, async (req, res) => {
  const rows = await db('links').where({ form_id: req.params.id }).orderBy('created_at', 'desc');
  // Most recent email per link, for the "Preview" link in the admin.
  const logs = await db('email_log').where({ form_id: req.params.id }).select('id', 'link_id').orderBy('created_at', 'desc');
  const lastEmail = {};
  for (const l of logs) if (l.link_id && !lastEmail[l.link_id]) lastEmail[l.link_id] = l.id;
  res.json(rows.map((r) => ({ ...serializeLink(r, req), lastEmailId: lastEmail[r.id] || null })));
});

// ---------- Link settings shared by single and bulk creation ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Links stay valid until the END of the chosen day (server's local time zone).
function parseExpiry(b, errors) {
  if (b.expiresOn !== undefined && b.expiresOn !== null && b.expiresOn !== '') {
    const d = String(b.expiresOn);
    const end = new Date(`${d}T23:59:59.999`);
    if (!DATE_RE.test(d) || Number.isNaN(end.getTime())) errors.push('expiresOn must be a date like 2026-12-31');
    else if (end.getTime() < Date.now()) errors.push('The expiry date must be today or later');
    else return end.toISOString();
    return null;
  }
  // Legacy option kept for API clients.
  if (b.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== '') {
    const days = Number(b.expiresInDays);
    if (!Number.isFinite(days) || days <= 0) errors.push('expiresInDays must be a positive number');
    else return new Date(Date.now() + days * 86400000).toISOString();
  }
  return null; // never expires
}

function parseMax(b, errors) {
  if (b.maxSubmissions === undefined) return 1;
  if (b.maxSubmissions === null || Number(b.maxSubmissions) === 0) return null; // unlimited
  const n = Number(b.maxSubmissions);
  if (!Number.isInteger(n) || n < 1) errors.push('maxSubmissions must be a positive whole number, or 0 for unlimited');
  return n;
}

function newLinkRow(formId, { name, email }, expiresAt, maxSubmissions) {
  return {
    id: randomUUID(),
    form_id: formId,
    token: randomBytes(18).toString('base64url'),
    recipient_name: name || null,
    recipient_email: email || null,
    max_submissions: maxSubmissions,
    submission_count: 0,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };
}

// Create one link.
router.post('/:id/links', loadForm, async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const name = typeof b.recipientName === 'string' ? b.recipientName.trim().slice(0, 200) : '';
  const email = typeof b.recipientEmail === 'string' ? b.recipientEmail.trim().slice(0, 320) : '';
  if (email && !EMAIL_RE.test(email)) errors.push('Recipient email is not valid');
  const maxSubmissions = parseMax(b, errors);
  const expiresAt = parseExpiry(b, errors);
  if (errors.length) return res.status(400).json({ error: 'Invalid link', details: errors });

  const row = newLinkRow(req.params.id, { name, email }, expiresAt, maxSubmissions);
  await db('links').insert(row);
  res.status(201).json(serializeLink(row, req));
});

// Step 1 of bulk: upload a spreadsheet (.xlsx or .csv, raw file body) and get a preview of recipients.
router.post(
  '/:id/links/import',
  express.raw({ type: () => true, limit: '5mb' }),
  loadForm,
  async (req, res) => {
    if (!req.body?.length) return res.status(400).json({ error: 'No file received' });
    const filename = decodeURIComponent(req.get('x-filename') || '');
    try {
      const result = await parseRecipientFile(req.body, filename);
      if (!result.recipients.length) return res.status(400).json({ error: 'No recipients found in the file' });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not read the file' });
    }
  },
);

// Step 2 of bulk: create one link per recipient, all sharing the same expiry date and limit.
router.post('/:id/links/bulk', loadForm, async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const maxSubmissions = parseMax(b, errors);
  const expiresAt = parseExpiry(b, errors);
  const list = Array.isArray(b.recipients) ? b.recipients : [];
  if (!list.length) errors.push('recipients must be a non-empty list');
  if (list.length > MAX_RECIPIENTS) errors.push(`At most ${MAX_RECIPIENTS} recipients per batch`);

  const seen = new Set();
  const recipients = [];
  list.forEach((r, i) => {
    const email = String(r?.email ?? '').trim().slice(0, 320);
    const name = String(r?.name ?? '').trim().slice(0, 200);
    if (!EMAIL_RE.test(email)) errors.push(`recipients[${i}]: invalid email "${email}"`);
    else if (seen.has(email.toLowerCase())) errors.push(`recipients[${i}]: duplicate email "${email}"`);
    seen.add(email.toLowerCase());
    recipients.push({ name, email });
  });
  if (errors.length) return res.status(400).json({ error: 'Invalid batch', details: errors.slice(0, 20) });

  const rows = recipients.map((r) => newLinkRow(req.params.id, r, expiresAt, maxSubmissions));
  await db.transaction(async (trx) => {
    for (let i = 0; i < rows.length; i += 100) await trx('links').insert(rows.slice(i, i + 100));
  });
  res.status(201).json({ created: rows.length, links: rows.map((r) => serializeLink(r, req)) });
});

const localDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Download all links for a form as CSV (for mail merge / sending from your own email).
router.get('/:id/links.csv', loadForm, async (req, res) => {
  const rows = await db('links').where({ form_id: req.params.id }).orderBy('created_at', 'asc');
  const q = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [['Name', 'Email', 'Link', 'Expires', 'Submissions used', 'Max submissions'].map(q).join(',')];
  for (const r of rows) {
    const l = serializeLink(r, req);
    lines.push([l.recipientName, l.recipientEmail, l.url, l.expiresAt ? localDate(l.expiresAt) : 'never',
      l.submissionCount, l.maxSubmissions ?? 'unlimited'].map(q).join(','));
  }
  const safeTitle = req.formRow.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'form';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeTitle}-links.csv"`);
  res.send('﻿' + lines.join('\r\n')); // BOM so Excel opens UTF-8 correctly
});

// Removes recipients (links) together with everything they submitted: submissions, file records
// and the uploaded files on disk. Returns counts of what was deleted.
async function removeLinks(formId, ids) {
  let removed = 0;
  let submissionsDeleted = 0;
  let filesDeleted = 0;
  const subIds = [];
  await db.transaction(async (trx) => {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const subs = await trx('submissions').where({ form_id: formId }).whereIn('link_id', chunk).select('id');
      const sids = subs.map((x) => x.id);
      subIds.push(...sids);
      for (let j = 0; j < sids.length; j += 500) {
        const sc = sids.slice(j, j + 500);
        filesDeleted += await trx('files').whereIn('submission_id', sc).del();
        submissionsDeleted += await trx('submissions').whereIn('id', sc).del();
      }
      removed += await trx('links').where({ form_id: formId }).whereIn('id', chunk).del();
    }
  });
  // Database is committed; now remove the files from disk.
  for (const sid of subIds) await storage.removeSubmissionDir(formId, sid);
  return { removed, submissionsDeleted, filesDeleted };
}

// Remove several recipients at once (and their submissions + uploaded files).
router.post('/:id/links/delete', loadForm, async (req, res) => {
  const ids = Array.isArray(req.body?.linkIds) ? [...new Set(req.body.linkIds.map(String))] : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one recipient to remove' });
  if (ids.length > 5000) return res.status(400).json({ error: 'Too many recipients at once' });
  res.json(await removeLinks(req.params.id, ids));
});

router.delete('/:id/links/:linkId', loadForm, async (req, res) => {
  const out = await removeLinks(req.params.id, [req.params.linkId]);
  if (!out.removed) return res.status(404).json({ error: 'Link not found' });
  res.json(out);
});

async function loadSubmissions(formId, order = 'desc') {
  const rows = await db('submissions')
    .leftJoin('links', 'links.id', 'submissions.link_id')
    .where('submissions.form_id', formId)
    .select('submissions.*', 'links.recipient_name', 'links.recipient_email')
    .orderBy('submissions.submitted_at', order);
  return rows.map((r) => ({
    id: r.id,
    linkId: r.link_id,
    recipientName: r.recipient_name,
    recipientEmail: r.recipient_email,
    data: parseJson(r.data, {}),
    submittedAt: toIso(r.submitted_at),
  }));
}

router.get('/:id/submissions', loadForm, async (req, res) => {
  res.json(await loadSubmissions(req.params.id));
});

// Builds the submissions workbook. `fileCell(submission, field, value)` decides what a file cell shows.
function buildSubmissionsWorkbook(form, subs, fileCell) {
  const fields = parseJson(form.fields, []);
  // Answers to fields that were later removed from the form are kept as extra columns.
  const known = new Set(fields.map((f) => f.name));
  const extra = [...new Set(subs.flatMap((s) => Object.keys(s.data)))].filter((k) => !known.has(k));
  const columns = [
    ...fields.map((f) => ({ key: f.name, header: f.label || humanize(f.name), type: f.type, field: f })),
    ...extra.map((k) => ({ key: k, header: `${humanize(k)} (removed field)`, type: 'text' })),
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'StickyForms';
  const ws = wb.addWorksheet('Submissions', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Submitted at', key: '_at', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Recipient name', key: '_name', width: 22 },
    { header: 'Recipient email', key: '_email', width: 28 },
    ...columns.map((c, i) => ({ header: c.header, key: `f${i}`, width: Math.min(45, Math.max(14, c.header.length + 4, c.type === 'file' ? 30 : 0)) })),
  ];
  for (const s of subs) {
    const row = { _at: excelLocalDate(s.submittedAt), _name: s.recipientName || '', _email: s.recipientEmail || '' };
    columns.forEach((c, i) => {
      const v = s.data[c.key];
      if (c.type === 'checkbox') row[`f${i}`] = v ? 'Yes' : 'No';
      else if (c.type === 'file') row[`f${i}`] = v?.fileId ? fileCell(s, c.field, v) : '';
      else if (c.type === 'poll' || c.type === 'ranking') row[`f${i}`] = answerText(c.field, v);
      else row[`f${i}`] = v ?? '';
    });
    const added = ws.addRow(row);
    columns.forEach((c, i) => {
      const cell = added.getCell(`f${i}`);
      if (c.type === 'file' && cell.value?.hyperlink) cell.font = { color: { argb: 'FF3B5BDB' }, underline: true };
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  // Second sheet with poll totals and ranking averages.
  const results = Object.values(tally(fields, subs));
  if (results.length) {
    const rs = wb.addWorksheet('Poll results');
    rs.columns = [{ width: 40 }, { width: 16 }, { width: 16 }, { width: 16 }];
    for (const r of results) {
      const head = rs.addRow([r.label, r.type === 'poll' ? 'Votes' : 'Average rank', r.type === 'poll' ? '% of responses' : '1st-place votes']);
      head.font = { bold: true };
      for (const o of r.options) {
        rs.addRow(r.type === 'poll' ? [o.option, o.count, o.percent / 100] : [o.option, o.averageRank ?? '', o.firstPlace]);
        if (r.type === 'poll') rs.lastRow.getCell(3).numFmt = '0%';
      }
      rs.addRow([`${r.responses} response${r.responses === 1 ? '' : 's'}`]).font = { italic: true, color: { argb: 'FF667085' } };
      rs.addRow([]);
    }
  }
  return wb;
}

const exportName = (form) => `${(form.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'form')}-submissions`;

// Excel only: file cells link to the download URL on this server.
router.get('/:id/submissions.xlsx', loadForm, async (req, res) => {
  const subs = await loadSubmissions(req.params.id, 'asc');
  const wb = buildSubmissionsWorkbook(req.formRow, subs, (s, f, v) => ({
    text: v.name, hyperlink: `${baseUrl(req)}/api/forms/${req.params.id}/files/${v.fileId}`,
  }));
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${exportName(req.formRow)}-${localDate(new Date().toISOString())}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// Windows-safe file/folder name.
function safeName(name, fallback = 'file', max = 80) {
  let n = String(name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = `_${n}`;
  return n.slice(0, max).trim() || fallback;
}

// ZIP: the Excel workbook plus every uploaded file, one folder per file question.
//   <Form>-submissions-<date>/
//     <Form>-submissions.xlsx      (file cells link to the files next to it)
//     <Question label>/<Recipient name>.<ext>
router.get('/:id/submissions.zip', loadForm, async (req, res) => {
  const subs = await loadSubmissions(req.params.id, 'asc');
  const fields = parseJson(req.formRow.fields, []);
  const fileRows = await db('files').where({ form_id: req.params.id });
  const byId = new Map(fileRows.map((f) => [f.id, f]));

  // One folder per file field, named after its display name.
  const folderOf = {};
  const usedFolders = new Set();
  for (const f of fields.filter((x) => x.type === 'file')) {
    let name = safeName(f.label || humanize(f.name), f.name);
    for (let n = 2; usedFolders.has(name.toLowerCase()); n++) name = `${safeName(f.label || f.name)} (${n})`;
    usedFolders.add(name.toLowerCase());
    folderOf[f.name] = name;
  }

  const entries = []; // { abs, name }
  const usedPaths = new Set();
  // Files keep the name they were uploaded with. Only characters Windows can't use in file names
  // are replaced, and if two people uploaded the same name into one folder the later one gets " (2)".
  const placeFile = (s, f, v) => {
    const row = byId.get(v.fileId);
    const folder = folderOf[f.name];
    if (!row || !folder) return `${v.name} (file missing)`;
    const ext = path.extname(row.original_name);
    const base = safeName(path.basename(row.original_name, ext), 'file', 150);
    const cleanExt = ext.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
    let rel = `${folder}/${base}${cleanExt}`;
    for (let n = 2; usedPaths.has(rel.toLowerCase()); n++) rel = `${folder}/${base} (${n})${cleanExt}`;
    usedPaths.add(rel.toLowerCase());
    entries.push({ abs: storage.absolutePath(row.stored_path), name: rel });
    return { text: rel, hyperlink: rel.split('/').map(encodeURIComponent).join('/') };
  };

  const wb = buildSubmissionsWorkbook(req.formRow, subs, placeFile);
  const base = `${exportName(req.formRow)}-${localDate(new Date().toISOString())}`;

  // Skip files that are gone from disk instead of failing the whole download.
  const present = [];
  for (const e of entries) {
    try { await fs.access(e.abs); present.push(e); } catch { /* missing */ }
  }

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${base}.zip"`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('warning', (err) => console.warn('zip warning:', err.message));
  zip.on('error', (err) => { console.error('zip error:', err); res.destroy(err); });
  zip.pipe(res);
  zip.append(Buffer.from(await wb.xlsx.writeBuffer()), { name: `${base}/${exportName(req.formRow)}.xlsx` });
  for (const e of present) zip.file(e.abs, { name: `${base}/${e.name}` });
  await zip.finalize();
});

// Live totals for polls and rankings.
router.get('/:id/results', loadForm, async (req, res) => {
  const rows = await db('submissions').where({ form_id: req.params.id }).select('data');
  res.json(tally(parseJson(req.formRow.fields, []), rows));
});

// Download a file someone attached to a submission.
// Images that browsers can safely show inline. (No SVG: it can contain scripts.)
const INLINE_IMAGES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
};

router.get('/:id/files/:fileId', loadForm, async (req, res) => {
  const file = await db('files').where({ id: req.params.fileId, form_id: req.params.id }).first();
  if (!file) return res.status(404).json({ error: 'File not found' });
  const type = INLINE_IMAGES[path.extname(file.original_name).toLowerCase()];
  // ?view=1 shows an image in the browser (thumbnails, open in new tab) instead of downloading it.
  if (req.query.view === '1' && type) {
    res.set('Content-Type', type);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.set('Cache-Control', 'private, max-age=3600');
    return res.sendFile(storage.absolutePath(file.stored_path), { dotfiles: 'allow', headers: { 'Content-Type': type } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'File is missing from storage' });
    });
  }
  res.download(storage.absolutePath(file.stored_path), file.original_name, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File is missing from storage' });
  });
});

function humanize(name) {
  const s = String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Excel has no time zones; shift so the cell shows the server's local time.
function excelLocalDate(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
}

// ---------- Emailing links ----------

function isLocalUrl(u) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname); } catch { return false; }
}

router.get('/:id/email-template', loadForm, (req, res) => {
  const url = baseUrl(req);
  res.json({
    subject: req.formRow.email_subject || mailer.DEFAULT_SUBJECT,
    message: req.formRow.email_message || mailer.DEFAULT_MESSAGE,
    testMode: mailer.testMode(),
    from: config.mail.from,
    baseUrl: url,
    baseUrlIsLocal: isLocalUrl(url),
  });
});

function readEmailRequest(b, errors) {
  const ids = Array.isArray(b.linkIds) ? [...new Set(b.linkIds.map(String))] : [];
  if (!ids.length) errors.push('Select at least one recipient');
  if (ids.length > MAX_RECIPIENTS) errors.push(`At most ${MAX_RECIPIENTS} recipients at a time`);
  const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
  const message = typeof b.message === 'string' ? b.message.replace(/\r\n/g, '\n').trim() : '';
  if (!subject) errors.push('Subject is required');
  if (subject.length > 300) errors.push('Subject must be 300 characters or fewer');
  if (!message) errors.push('Message is required');
  if (message.length > 5000) errors.push('Message must be 5000 characters or fewer');
  return { ids, subject, message };
}

// Emails the given link rows, updates their delivery status and writes the log.
async function emailLinks(req, form, links, kind, { subject, message }) {
  const now = () => new Date().toISOString();
  const jobs = links.map((l) => {
    const url = `${baseUrl(req)}/f/${l.token}`;
    return { link: l, mail: { to: l.recipient_email, ...mailer.render({ subject, message, formTitle: form.title, formDescription: form.description, name: l.recipient_name, url, expiresAt: l.expires_at }) } };
  });
  const outcomes = await mailer.sendAll(jobs.map((j) => j.mail));

  const results = [];
  await db.transaction(async (trx) => {
    for (let i = 0; i < jobs.length; i++) {
      const { link, mail } = jobs[i];
      const o = outcomes[i];
      const ok = o.status !== 'failed';
      const upd = { last_email_status: o.status, last_email_error: o.error || null };
      if (ok) upd.sent_at = now();
      const q = trx('links').where({ id: link.id });
      await (ok ? q.update(upd).increment('send_count', 1) : q.update(upd));
      await trx('email_log').insert({
        id: randomUUID(), form_id: form.id, link_id: link.id, kind, to_email: mail.to, subject: mail.subject,
        html: mail.html, text: mail.text, status: o.status, error: o.error || null, created_at: now(),
      });
      results.push({ linkId: link.id, email: mail.to, name: link.recipient_name, status: o.status, error: o.error || null });
    }
  });
  return results;
}

const skipReasons = {
  noEmail: 'No email address',
  replaced: 'This link was replaced by a newer one — select the newest link',
  expired: 'Link has expired — use Resend to send a new link',
  used: 'Already submitted — use Resend to send a new link',
};

function summarize(results, skipped) {
  const count = (st) => results.filter((r) => r.status === st).length;
  return { sent: count('sent'), test: count('test'), failed: count('failed'), skipped: skipped.length, results, skippedList: skipped, testMode: mailer.testMode() };
}

async function saveTemplate(formId, subject, message) {
  await db('forms').where({ id: formId }).update({ email_subject: subject, email_message: message });
}

// Send email: emails each selected recipient their CURRENT link.
router.post('/:id/links/send', loadForm, async (req, res) => {
  const errors = [];
  const { ids, subject, message } = readEmailRequest(req.body || {}, errors);
  if (errors.length) return res.status(400).json({ error: 'Cannot send', details: errors });

  const rows = await db('links').where({ form_id: req.params.id }).whereIn('id', ids);
  const skipped = [];
  const toSend = [];
  for (const r of rows) {
    const st = linkState(r);
    const reason = !r.recipient_email ? skipReasons.noEmail : st !== 'active' ? skipReasons[st] : null;
    if (reason) skipped.push({ linkId: r.id, name: r.recipient_name, email: r.recipient_email, reason });
    else toSend.push(r);
  }
  await saveTemplate(req.params.id, subject, message);
  const results = await emailLinks(req, req.formRow, toSend, 'send', { subject, message });
  res.json(summarize(results, skipped));
});

// Resend email: creates a NEW link for each selected recipient (using the given expiry/limit),
// deactivates the old link, and emails the new one.
router.post('/:id/links/resend', loadForm, async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const { ids, subject, message } = readEmailRequest(b, errors);
  const maxSubmissions = parseMax(b, errors);
  const expiresAt = parseExpiry(b, errors);
  if (errors.length) return res.status(400).json({ error: 'Cannot resend', details: errors });

  const rows = await db('links').where({ form_id: req.params.id }).whereIn('id', ids);
  const skipped = [];
  const newLinks = [];
  await db.transaction(async (trx) => {
    for (const old of rows) {
      if (!old.recipient_email) { skipped.push({ linkId: old.id, name: old.recipient_name, email: null, reason: skipReasons.noEmail }); continue; }
      if (old.replaced_by) { skipped.push({ linkId: old.id, name: old.recipient_name, email: old.recipient_email, reason: skipReasons.replaced }); continue; }
      const fresh = newLinkRow(req.params.id, { name: old.recipient_name, email: old.recipient_email }, expiresAt, maxSubmissions);
      await trx('links').insert(fresh);
      await trx('links').where({ id: old.id }).update({ replaced_by: fresh.id, replaced_at: new Date().toISOString() });
      newLinks.push(fresh);
    }
  });
  await saveTemplate(req.params.id, subject, message);
  const results = await emailLinks(req, req.formRow, newLinks, 'resend', { subject, message });
  res.json({ ...summarize(results, skipped), created: newLinks.length });
});

// Preview an email exactly as it was sent (or saved in test mode).
router.get('/:id/emails/:logId', loadForm, async (req, res) => {
  const log = await db('email_log').where({ id: req.params.logId, form_id: req.params.id }).first();
  if (!log) return res.status(404).send('Email not found');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  const banner = `<div style="font:13px Segoe UI,Arial,sans-serif;background:#fff3cd;border-bottom:1px solid #e0c96a;padding:10px 16px">
    <b>To:</b> ${escapeHtml(log.to_email)} · <b>Subject:</b> ${escapeHtml(log.subject)} · <b>Status:</b> ${escapeHtml(
  { sent: 'Sent', test: 'Test mode (not actually sent)', failed: `Failed: ${log.error || ''}` }[log.status] || log.status,
)} · ${escapeHtml(new Date(log.created_at).toLocaleString())}</div>`;
  res.type('html').send(banner + (log.html || `<pre>${escapeHtml(log.text)}</pre>`));
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = router;
