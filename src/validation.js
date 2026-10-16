const path = require('path');
const config = require('./config');

const FIELD_TYPES = ['text', 'email', 'number', 'textarea', 'select', 'checkbox', 'date', 'file', 'poll', 'ranking'];
const MAX_CHOICES = 50;
// Never accepted, even if a form lists them: these can run code when opened.
const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.jar', '.sh', '.dll', '.hta', '.lnk', '.reg', '.cpl'];
const EXT_RE = /^\.[a-z0-9]{1,10}$/;
const DEFAULT_FILE_MB = 10;

function normalizeExt(e) {
  let x = String(e).trim().toLowerCase();
  if (!x) return '';
  if (!x.startsWith('.')) x = `.${x}`;
  return x;
}
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 10000;

function validateFormInput(body) {
  const errors = [];
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (!title) errors.push('title is required');
  if (title.length > 200) errors.push('title must be 200 characters or fewer');

  const fields = body?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    errors.push('fields must be a non-empty array');
    return { errors };
  }
  if (fields.length > 100) errors.push('a form can have at most 100 fields');

  const seen = new Set();
  const clean = fields.map((f, i) => {
    const at = `fields[${i}]`;
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    const label = typeof f?.label === 'string' ? f.label.trim() : '';
    const type = f?.type;
    if (!NAME_RE.test(name)) errors.push(`${at}.name must start with a letter and use only letters, numbers, _`);
    else if (seen.has(name)) errors.push(`${at}.name "${name}" is duplicated`);
    seen.add(name);
    if (!label) errors.push(`${at}.label is required`);
    if (!FIELD_TYPES.includes(type)) errors.push(`${at}.type must be one of ${FIELD_TYPES.join(', ')}`);

    const field = { name, label, type, required: Boolean(f?.required) };
    if (type === 'select') {
      const options = Array.isArray(f?.options)
        ? f.options.map((o) => String(o).trim()).filter(Boolean)
        : [];
      if (options.length === 0) errors.push(`${at}.options must list at least one choice`);
      field.options = options;
    }
    if (type === 'poll' || type === 'ranking') {
      const options = Array.isArray(f?.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [];
      const what = type === 'poll' ? 'poll' : 'ranking';
      if (options.length < 2) errors.push(`${at}: a ${what} needs at least 2 ${type === 'poll' ? 'choices' : 'items'}`);
      if (options.length > MAX_CHOICES) errors.push(`${at}: at most ${MAX_CHOICES} ${type === 'poll' ? 'choices' : 'items'}`);
      const seenOpt = new Set();
      for (const o of options) {
        if (seenOpt.has(o.toLowerCase())) errors.push(`${at}: "${o}" is listed twice`);
        seenOpt.add(o.toLowerCase());
        if (o.length > 200) errors.push(`${at}: "${o.slice(0, 30)}…" is too long (max 200 characters)`);
      }
      field.options = options;
      if (type === 'poll') {
        const max = f?.maxChoices === undefined || f?.maxChoices === '' ? 1 : Number(f.maxChoices);
        if (!Number.isInteger(max) || max < 1) errors.push(`${at}: "how many can they choose" must be a whole number of 1 or more`);
        else if (options.length >= 2 && max > options.length) errors.push(`${at}: they can't choose ${max} out of only ${options.length} choices`);
        field.maxChoices = Number.isInteger(max) && max >= 1 ? max : 1;
      }
    }
    if (type === 'file') {
      const mb = f?.maxSizeMB === undefined || f?.maxSizeMB === '' ? Math.min(DEFAULT_FILE_MB, config.maxUploadMb) : Number(f.maxSizeMB);
      if (!Number.isFinite(mb) || mb <= 0 || mb > config.maxUploadMb) {
        errors.push(`${at}: max file size must be between 0.1 and ${config.maxUploadMb} MB`);
      }
      field.maxSizeMB = Math.round(mb * 10) / 10;
      const accept = [...new Set((Array.isArray(f?.accept) ? f.accept : []).map(normalizeExt).filter(Boolean))];
      for (const ext of accept) {
        if (!EXT_RE.test(ext)) errors.push(`${at}: "${ext}" is not a valid file extension`);
        else if (BLOCKED_EXT.includes(ext)) errors.push(`${at}: ${ext} files can't be accepted for security reasons`);
      }
      field.accept = accept; // empty = any type except blocked ones
    }
    const notes = typeof f?.notes === 'string' ? f.notes.trim() : '';
    if (notes.length > 500) errors.push(`${at}: notes must be 500 characters or fewer`);
    if (notes) field.notes = notes.slice(0, 500);
    if (typeof f?.placeholder === 'string' && f.placeholder.trim()) field.placeholder = f.placeholder.trim();
    return field;
  });

  return { errors, value: { title, description, fields: clean } };
}

// `files` maps field name -> uploaded file ({ originalname, size }) for "file" fields.
function validateSubmission(fields, data, files = {}) {
  const errors = {};
  const clean = {};
  const input = data && typeof data === 'object' ? data : {};

  for (const f of fields) {
    if (f.type === 'file') {
      const file = files[f.name];
      clean[f.name] = null;
      if (!file) {
        if (f.required) errors[f.name] = 'Please attach a file';
        continue;
      }
      const err = checkFile(f, file);
      if (err) errors[f.name] = err;
      continue;
    }

    let v = input[f.name];

    if (f.type === 'poll') {
      const picked = [...new Set((Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x)))];
      clean[f.name] = picked.length ? picked : null;
      if (!picked.length) { if (f.required) errors[f.name] = f.maxChoices > 1 ? 'Please choose at least one option' : 'Please choose an option'; continue; }
      if (picked.some((x) => !f.options.includes(x))) errors[f.name] = 'Choose from the listed options';
      else if (picked.length > (f.maxChoices || 1)) errors[f.name] = f.maxChoices > 1 ? `Choose up to ${f.maxChoices} options` : 'Choose only one option';
      continue;
    }

    if (f.type === 'ranking') {
      const n = f.options.length;
      let order = null; // options from rank 1 to rank n
      let err = null;
      if (Array.isArray(v)) {
        const ok = v.length === n && new Set(v).size === n && v.every((x) => f.options.includes(x));
        if (v.length === 0) order = null;
        else if (ok) order = v.map(String);
        else err = `Please rank all ${n} items`;
      } else if (v && typeof v === 'object') {
        const ranks = f.options.map((o) => (v[o] === '' || v[o] == null ? null : Number(v[o])));
        const given = ranks.filter((r) => r !== null);
        if (given.length === 0) order = null;
        else if (given.length < n) err = `Please give every item a number from 1 to ${n}`;
        else if (given.some((r) => !Number.isInteger(r) || r < 1 || r > n)) err = `Use numbers from 1 to ${n}`;
        else if (new Set(given).size !== n) err = 'Each number can only be used once';
        else order = f.options.map((o, i) => [o, ranks[i]]).sort((a, b) => a[1] - b[1]).map(([o]) => o);
      } else if (v != null && v !== '') err = 'Invalid ranking';
      if (err) errors[f.name] = err;
      else if (!order && f.required) errors[f.name] = `Please rank all ${n} items`;
      clean[f.name] = order;
      continue;
    }

    if (f.type === 'checkbox') {
      const checked = v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
      if (f.required && !checked) errors[f.name] = 'This box must be checked';
      clean[f.name] = checked;
      continue;
    }

    if (v == null) v = '';
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') {
      errors[f.name] = 'Invalid value';
      continue;
    }
    v = v.trim();

    if (v === '') {
      if (f.required) errors[f.name] = 'This field is required';
      clean[f.name] = null;
      continue;
    }
    if (v.length > MAX_TEXT) {
      errors[f.name] = 'Value is too long';
      continue;
    }

    switch (f.type) {
      case 'email':
        if (!EMAIL_RE.test(v)) errors[f.name] = 'Enter a valid email address';
        clean[f.name] = v;
        break;
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) errors[f.name] = 'Enter a number';
        clean[f.name] = n;
        break;
      }
      case 'date':
        if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) errors[f.name] = 'Enter a valid date';
        clean[f.name] = v;
        break;
      case 'select':
        if (!f.options.includes(v)) errors[f.name] = 'Choose one of the listed options';
        clean[f.name] = v;
        break;
      default:
        clean[f.name] = v;
    }
  }

  return { errors, value: clean, ok: Object.keys(errors).length === 0 };
}

function checkFile(field, file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ext || BLOCKED_EXT.includes(ext)) return 'This type of file is not allowed';
  if (field.accept?.length && !field.accept.includes(ext)) {
    return `Allowed formats: ${field.accept.map((e) => e.slice(1).toUpperCase()).join(', ')}`;
  }
  const maxMb = Math.min(field.maxSizeMB || DEFAULT_FILE_MB, config.maxUploadMb);
  if (file.size > maxMb * 1024 * 1024) return `File is too large (max ${maxMb} MB)`;
  if (file.size === 0) return 'The file is empty';
  return null;
}

module.exports = { FIELD_TYPES, BLOCKED_EXT, validateFormInput, validateSubmission, checkFile };
