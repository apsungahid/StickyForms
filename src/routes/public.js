// Public API used by recipients who open a personal link (/f/:token).
const path = require('path');
const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { db, parseJson, toIso } = require('../db');
const { tally } = require('../results');
const { validateSubmission } = require('../validation');
const storage = require('../storage');
const config = require('../config');

const router = express.Router();

const LOCKED = { ok: false, code: 423, error: 'This form is temporarily closed and is not accepting responses right now. Please try again later.' };
const formStatus = (form) => (form?.locked_at ? LOCKED : { ok: true });

function linkStatus(link) {
  if (!link) return { ok: false, code: 404, error: 'This link is not valid.' };
  if (link.replaced_by) {
    return { ok: false, code: 410, error: 'This link has been replaced by a newer one. Please use the most recent email we sent you.' };
  }
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    return { ok: false, code: 410, error: 'This link has expired.' };
  }
  if (link.max_submissions != null && link.submission_count >= link.max_submissions) {
    return { ok: false, code: 410, error: 'This form has already been submitted.' };
  }
  return { ok: true };
}

const isExpired = (link) => link.expires_at && new Date(link.expires_at).getTime() < Date.now();
const isUsedUp = (link) => link.max_submissions != null && link.submission_count >= link.max_submissions;

// Read-only view of what this link's owner submitted, plus live poll results.
async function viewPayload(link, form) {
  const mine = await db('submissions').where({ link_id: link.id }).orderBy('submitted_at', 'desc');
  if (!mine.length) return null;
  const fields = parseJson(form.fields, []);
  const all = await db('submissions').where({ form_id: form.id }).select('data');
  const results = tally(fields, all);
  return {
    mode: 'view',
    title: form.title,
    description: form.description,
    recipientName: link.recipient_name,
    canSubmitAgain: !isExpired(link) && !isUsedUp(link) && !form.locked_at,
    submissions: mine.map((s) => {
      const data = parseJson(s.data, {});
      return {
        submittedAt: toIso(s.submitted_at),
        answers: fields.map((f) => {
          const v = data[f.name];
          const a = { name: f.name, label: f.label, type: f.type, value: f.type === 'file' ? (v?.name || null) : v ?? null };
          if (f.type === 'poll' || f.type === 'ranking') a.results = results[f.name];
          return a;
        }),
      };
    }),
  };
}

router.get('/:token', async (req, res) => {
  const link = await db('links').where({ token: req.params.token }).first();
  if (!link) return res.status(404).json({ error: 'This link is not valid.' });
  if (link.replaced_by) return res.status(410).json({ error: linkStatus(link).error });
  const form = await db('forms').where({ id: link.form_id }).first();

  // Already submitted and can't submit again (used up, expired or locked): show what they sent.
  const blocked = isExpired(link) || isUsedUp(link) || form.locked_at;
  if (blocked && link.submission_count > 0) {
    const view = await viewPayload(link, form);
    if (view) return res.json(view);
  }

  const status = linkStatus(link);
  if (!status.ok) return res.status(status.code).json({ error: status.error });
  const fst = formStatus(form);
  if (!fst.ok) return res.status(fst.code).json({ error: fst.error, locked: true });
  res.json({
    mode: 'form',
    title: form.title,
    description: form.description,
    fields: parseJson(form.fields, []),
    recipientName: link.recipient_name,
  });
});

// The person's own submission(s) for this link — shown right after submitting.
router.get('/:token/submission', async (req, res) => {
  const link = await db('links').where({ token: req.params.token }).first();
  if (!link || link.replaced_by) return res.status(404).json({ error: 'Nothing to show for this link.' });
  const form = await db('forms').where({ id: link.form_id }).first();
  const view = await viewPayload(link, form);
  if (!view) return res.status(404).json({ error: 'Nothing has been submitted with this link yet.' });
  res.json(view);
});

// Accepts JSON ({ data }) or multipart/form-data (a "data" JSON part + one file part per file field).
function receiveFiles(req, res) {
  if (!req.is('multipart/form-data')) return Promise.resolve();
  const upload = multer({
    storage: multer.diskStorage({ destination: storage.tempDir() }),
    defParamCharset: 'utf8', // keep non-English file names intact
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20, fields: 20, fieldSize: 1024 * 1024 },
  }).any();
  return new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
}

router.post('/:token', async (req, res) => {
  // Check the link before accepting any upload bytes.
  const preLink = await db('links').where({ token: req.params.token }).first();
  const pre = linkStatus(preLink);
  if (!pre.ok) return res.status(pre.code).json({ error: pre.error });
  const preForm = formStatus(await db('forms').where({ id: preLink.form_id }).first('locked_at'));
  if (!preForm.ok) return res.status(preForm.code).json({ error: preForm.error, locked: true });

  await storage.ensureRoot();
  try {
    await receiveFiles(req, res);
  } catch (err) {
    await storage.removeTemp((req.files || []).map((f) => f.path));
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than the ${config.maxUploadMb} MB limit.` : `Upload problem: ${err.message}`;
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
    }
    throw err;
  }

  const uploaded = req.files || [];
  const tempPaths = uploaded.map((f) => f.path);
  let data = req.body?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  const filesByField = {};
  for (const f of uploaded) if (!filesByField[f.fieldname]) filesByField[f.fieldname] = f;

  let submissionDir = null;
  try {
    const result = await db.transaction(async (trx) => {
      const link = await trx('links').where({ token: req.params.token }).first();
      const status = linkStatus(link);
      if (!status.ok) return { code: status.code, body: { error: status.error } };

      const form = await trx('forms').where({ id: link.form_id }).first();
      const fst = formStatus(form); // re-checked inside the transaction in case it was just locked
      if (!fst.ok) return { code: fst.code, body: { error: fst.error, locked: true } };
      const fields = parseJson(form.fields, []);
      const check = validateSubmission(fields, data, filesByField);
      if (!check.ok) return { code: 400, body: { error: 'Please fix the highlighted fields.', fields: check.errors } };

      // Guarded increment so two simultaneous submits can't exceed max_submissions.
      const q = trx('links').where({ id: link.id });
      if (link.max_submissions != null) q.andWhere('submission_count', '<', link.max_submissions);
      const updated = await q.increment('submission_count', 1);
      if (!updated) return { code: 410, body: { error: 'This form has already been submitted.' } };

      const id = randomUUID();
      const now = new Date().toISOString();
      const fileRows = [];
      submissionDir = [form.id, id];
      for (const field of fields.filter((f) => f.type === 'file')) {
        const file = filesByField[field.name];
        if (!file) continue;
        const fileId = randomUUID();
        const ext = path.extname(file.originalname).toLowerCase();
        const storedPath = await storage.save(file.path, { formId: form.id, submissionId: id, fileId, ext });
        const meta = { fileId, name: file.originalname.slice(0, 255), size: file.size, type: file.mimetype };
        check.value[field.name] = meta;
        fileRows.push({
          id: fileId, form_id: form.id, submission_id: id, field_name: field.name,
          original_name: meta.name, stored_path: storedPath, mime_type: (file.mimetype || '').slice(0, 200),
          size_bytes: file.size, created_at: now,
        });
      }

      await trx('submissions').insert({
        id,
        form_id: form.id,
        link_id: link.id,
        data: JSON.stringify(check.value),
        ip: (req.ip || '').slice(0, 64),
        user_agent: (req.get('user-agent') || '').slice(0, 500),
        submitted_at: now,
      });
      if (fileRows.length) await trx('files').insert(fileRows);
      submissionDir = null; // committed: keep the files
      return { code: 201, body: { id, message: 'Thanks! Your response was recorded.' } };
    });
    res.status(result.code).json(result.body);
  } catch (err) {
    if (submissionDir) await storage.removeSubmissionDir(...submissionDir);
    throw err;
  } finally {
    await storage.removeTemp(tempPaths); // leftovers: rejected or unused uploads
  }
});

module.exports = router;
