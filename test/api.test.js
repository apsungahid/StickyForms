// End-to-end API tests against an in-memory SQLite database.
process.env.DB_CLIENT = 'sqlite';
process.env.DB_FILE = ':memory:';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), `sf-test-uploads-${process.pid}`);
process.env.MAX_UPLOAD_MB = '5';
process.env.SMTP_HOST = ''; // test mode: emails saved to OUTBOX_DIR
process.env.DEV_LOGIN = 'true'; // tests sign in with the local developer login
process.env.OUTBOX_DIR = require('path').join(require('os').tmpdir(), `sf-test-outbox-${process.pid}`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { db } = require('../src/db');
const { createApp } = require('../src/app');

const app = createApp();
// Everything below runs as a signed-in user (Andre); `api` keeps the session cookie.
const api = request.agent(app);
// Form titles must be unique, so each test form gets a numbered title.
let formNo = 0;
const uniq = (f) => ({ ...f, title: `${f.title} ${++formNo}` });
const sampleForm = {
  title: 'Test form',
  description: 'desc',
  fields: [
    { name: 'full_name', label: 'Name', type: 'text', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'plan', label: 'Plan', type: 'select', options: ['basic', 'pro'] },
    { name: 'agree', label: 'Agree', type: 'checkbox', required: true },
  ],
};

let legacyFormId;
before(async () => {
  await db.migrate.latest();
  // A form created before sign-in existed (no owner) — the first account to sign in should get it.
  legacyFormId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  await db('forms').insert({ id: legacyFormId, title: 'Legacy Form', fields: JSON.stringify([{ name: 'a', label: 'A', type: 'text' }]), created_at: now, updated_at: now });
  await api.post('/api/auth/dev').send({ email: 'Andre@Example.com', name: 'Andre' }).expect(200);
});
after(async () => {
  await db.destroy();
  require('fs').rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
  require('fs').rmSync(process.env.OUTBOX_DIR, { recursive: true, force: true });
});

test('health check reports ok', async () => {
  const res = await api.get('/health').expect(200);
  assert.equal(res.body.status, 'ok');
});

test('rejects invalid form definitions', async () => {
  const res = await api.post('/api/forms').send({ title: '', fields: [{ name: '1bad', type: 'nope' }] }).expect(400);
  assert.ok(res.body.details.length >= 3);
});

test('full flow: create form, link, submit once, read submissions', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  assert.equal(form.fields.length, 4);

  const link = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Ana', expiresInDays: 7 }).expect(201)).body;
  assert.match(link.url, new RegExp(`/f/${link.token}$`));
  assert.equal(link.maxSubmissions, 1);

  const pub = (await api.get(`/api/public/${link.token}`).expect(200)).body;
  assert.equal(pub.title, form.title);
  assert.equal(pub.recipientName, 'Ana');

  const bad = await api.post(`/api/public/${link.token}`).send({ data: { full_name: '', email: 'x', plan: 'gold' } }).expect(400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['agree', 'email', 'full_name', 'plan']);

  await api.post(`/api/public/${link.token}`)
    .send({ data: { full_name: 'Ana', email: 'ana@example.com', plan: 'pro', agree: true } }).expect(201);

  // single-use link is now closed
  await api.post(`/api/public/${link.token}`)
    .send({ data: { full_name: 'Ana', email: 'ana@example.com', agree: true } }).expect(410);
  // ...but opening it again shows what they submitted (read-only)
  const view = (await api.get(`/api/public/${link.token}`).expect(200)).body;
  assert.equal(view.mode, 'view');
  assert.equal(view.canSubmitAgain, false);
  assert.equal(view.submissions[0].answers.find((a) => a.name === 'email').value, 'ana@example.com');

  const subs = (await api.get(`/api/forms/${form.id}/submissions`).expect(200)).body;
  assert.equal(subs.length, 1);
  assert.equal(subs[0].data.email, 'ana@example.com');
  assert.equal(subs[0].data.agree, true);
  assert.equal(subs[0].recipientName, 'Ana');

  const list = (await api.get('/api/forms').expect(200)).body;
  const row = list.find((f) => f.id === form.id);
  assert.equal(row.submissionCount, 1);
  assert.equal(row.linkCount, 1);
});

test('unknown tokens and deleted forms return 404', async () => {
  await api.get('/api/public/does-not-exist').expect(404);
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const link = (await api.post(`/api/forms/${form.id}/links`).send({ maxSubmissions: 0 }).expect(201)).body;
  assert.equal(link.maxSubmissions, null);
  await api.delete(`/api/forms/${form.id}`).expect(204);
  await api.get(`/api/forms/${form.id}`).expect(404);
  await api.get(`/api/public/${link.token}`).expect(404); // cascade removed the link
});

test('fill page is served for link URLs', async () => {
  const res = await api.get('/f/anything').expect(200);
  assert.match(res.text, /fill\.js/);
});

// ---------- Expiry date + spreadsheet upload ----------
const ExcelJS = require('exceljs');
const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('links use an exact expiry date (valid through end of that day)', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const tomorrow = localYmd(new Date(Date.now() + 86400000));
  const link = (await api.post(`/api/forms/${form.id}/links`).send({ expiresOn: tomorrow }).expect(201)).body;
  const exp = new Date(link.expiresAt);
  assert.equal(localYmd(exp), tomorrow);
  assert.equal(exp.getHours(), 23);
  const past = await api.post(`/api/forms/${form.id}/links`).send({ expiresOn: '2020-01-01' }).expect(400);
  assert.match(past.body.details[0], /today or later/);
  await api.post(`/api/forms/${form.id}/links`).send({ expiresOn: 'soon' }).expect(400);
});

test('CSV upload preview finds name/email columns and flags bad rows', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const csv = 'Full Name;E-mail Address\r\n"Doe, Jane";jane@example.com\r\nBob;not-an-email\r\n;\r\nJane again;JANE@example.com\r\nCarl;carl@example.com\r\n';
  const res = await api.post(`/api/forms/${form.id}/links/import`)
    .set('Content-Type', 'text/csv').set('X-Filename', 'list.csv').send(Buffer.from(csv)).expect(200);
  assert.equal(res.body.validCount, 2);
  assert.deepEqual(res.body.recipients.map((r) => [r.row, r.name, r.error]), [
    [2, 'Doe, Jane', null], [3, 'Bob', 'Invalid email'], [5, 'Jane again', 'Duplicate email'], [6, 'Carl', null],
  ]);
});

test('XLSX upload (first/last name columns) then bulk create with one expiry date', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('People');
  ws.addRow(['First Name', 'Last Name', 'Email', 'Company']);
  ws.addRow(['Ana', 'Lima', 'ana@example.com', 'Acme']);
  ws.addRow(['Ben', 'Ng', { text: 'ben@example.com', hyperlink: 'mailto:ben@example.com' }, 'Beta']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const prev = (await api.post(`/api/forms/${form.id}/links/import`)
    .set('Content-Type', 'application/octet-stream').set('X-Filename', 'people.xlsx').send(buf).expect(200)).body;
  assert.deepEqual(prev.recipients.map((r) => [r.name, r.email]), [['Ana Lima', 'ana@example.com'], ['Ben Ng', 'ben@example.com']]);

  const day = localYmd(new Date(Date.now() + 5 * 86400000));
  const out = (await api.post(`/api/forms/${form.id}/links/bulk`)
    .send({ recipients: prev.recipients, expiresOn: day, maxSubmissions: 1 }).expect(201)).body;
  assert.equal(out.created, 2);
  assert.ok(out.links.every((l) => localYmd(new Date(l.expiresAt)) === day && l.maxSubmissions === 1));
  assert.equal(new Set(out.links.map((l) => l.token)).size, 2);

  const csv = await api.get(`/api/forms/${form.id}/links.csv`).expect(200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /"Ana Lima","ana@example.com","http:\/\/127\.0\.0\.1:\d+\/f\/[\w-]+"/);
  assert.ok(csv.text.includes(`"${day}"`));
});

test('bulk create rejects bad emails and duplicates; upload rejects junk', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  await api.post(`/api/forms/${form.id}/links/bulk`)
    .send({ recipients: [{ name: 'A', email: 'a@x.co' }, { name: 'B', email: 'A@x.co' }] }).expect(400);
  await api.post(`/api/forms/${form.id}/links/bulk`).send({ recipients: [] }).expect(400);
  const junk = await api.post(`/api/forms/${form.id}/links/import`)
    .set('Content-Type', 'text/csv').send(Buffer.from('hello,world\nfoo,bar\n')).expect(400);
  assert.match(junk.body.error, /email column/);
  await api.post(`/api/forms/${form.id}/links/import`)
    .set('Content-Type', 'application/octet-stream').set('X-Filename', 'old.xls').send(Buffer.from('xx')).expect(400);
  const links = (await api.get(`/api/forms/${form.id}/links`)).body;
  assert.equal(links.length, 0); // nothing partially created
});

test('submissions export to Excel with readable headers and Yes/No checkboxes', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const link = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Ana', recipientEmail: 'ana@x.co' }).expect(201)).body;
  await api.post(`/api/public/${link.token}`)
    .send({ data: { full_name: 'Ana Lima', email: 'ana@x.co', plan: 'pro', agree: true } }).expect(201);

  const res = await api.get(`/api/forms/${form.id}/submissions.xlsx`)
    .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); })
    .expect(200);
  assert.match(res.headers['content-disposition'], /Test-form-\d+-submissions-\d{4}-\d{2}-\d{2}\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const ws = wb.worksheets[0];
  assert.deepEqual(ws.getRow(1).values.slice(1), ['Submitted at', 'Recipient name', 'Recipient email', 'Name', 'Email', 'Plan', 'Agree']);
  assert.deepEqual(ws.getRow(2).values.slice(2), ['Ana', 'ana@x.co', 'Ana Lima', 'ana@x.co', 'pro', 'Yes']);
  assert.ok(ws.getRow(2).getCell(1).value instanceof Date);
});

// ---------- File upload fields ----------
const fs = require('fs');
const pathMod = require('path');

const fileForm = {
  title: 'Documents',
  fields: [
    { name: 'full_name', label: 'Name', type: 'text', required: true },
    { name: 'cv', label: 'Your CV', type: 'file', required: true, maxSizeMB: 1, accept: ['pdf', '.DOCX'] },
    { name: 'photo', label: 'Photo', type: 'file', maxSizeMB: 0.5, accept: [] },
  ],
};

test('file field definitions: formats normalized, limits and blocked types enforced', async () => {
  const form = (await api.post('/api/forms').send(uniq(fileForm)).expect(201)).body;
  assert.deepEqual(form.fields[1].accept, ['.pdf', '.docx']);
  assert.equal(form.fields[1].maxSizeMB, 1);
  assert.equal(form.fields[2].maxSizeMB, 0.5);

  const tooBig = await api.post('/api/forms').send({ ...fileForm, fields: [{ name: 'f', label: 'F', type: 'file', maxSizeMB: 50 }] }).expect(400);
  assert.match(tooBig.body.details[0], /between 0\.1 and 5 MB/);
  const blocked = await api.post('/api/forms').send({ ...fileForm, fields: [{ name: 'f', label: 'F', type: 'file', accept: ['.exe'] }] }).expect(400);
  assert.match(blocked.body.details[0], /security/);
  const settings = (await api.get('/api/settings').expect(200)).body;
  assert.equal(settings.maxUploadMb, 5);
});

test('file upload flow: validate, store, download, export, delete', async () => {
  const form = (await api.post('/api/forms').send(uniq(fileForm)).expect(201)).body;
  const mk = async () => (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Ana' }).expect(201)).body.token;
  const pdf = Buffer.from('%PDF-1.4 test file');

  // wrong format + missing required name
  let token = await mk();
  let r = await api.post(`/api/public/${token}`)
    .field('data', JSON.stringify({ full_name: '' })).attach('cv', Buffer.from('x'), 'cv.png').expect(400);
  assert.equal(r.body.fields.cv, 'Allowed formats: PDF, DOCX');
  assert.ok(r.body.fields.full_name);

  // missing required file
  r = await api.post(`/api/public/${token}`).field('data', JSON.stringify({ full_name: 'Ana' })).expect(400);
  assert.equal(r.body.fields.cv, 'Please attach a file');

  // over this field's 0.5 MB limit
  r = await api.post(`/api/public/${token}`).field('data', JSON.stringify({ full_name: 'Ana' }))
    .attach('cv', pdf, 'cv.pdf').attach('photo', Buffer.alloc(600 * 1024, 1), 'me.jpg').expect(400);
  assert.match(r.body.fields.photo, /max 0\.5 MB/);

  // over the server-wide cap -> rejected while uploading
  r = await api.post(`/api/public/${token}`).field('data', JSON.stringify({ full_name: 'Ana' }))
    .attach('cv', Buffer.alloc(6 * 1024 * 1024, 1), 'big.pdf').expect(413);

  // link not consumed by the failed attempts; now succeed (non-English file name kept)
  r = await api.post(`/api/public/${token}`).field('data', JSON.stringify({ full_name: 'Ana' }))
    .attach('cv', pdf, 'Currículo João.pdf').expect(201);
  const tmpLeft = fs.readdirSync(pathMod.join(process.env.UPLOAD_DIR, 'tmp'));
  assert.equal(tmpLeft.length, 0, 'temp uploads cleaned up');

  const subs = (await api.get(`/api/forms/${form.id}/submissions`).expect(200)).body;
  assert.equal(subs.length, 1);
  const cv = subs[0].data.cv;
  assert.equal(cv.name, 'Currículo João.pdf');
  assert.equal(cv.size, pdf.length);
  assert.equal(subs[0].data.photo, null);

  const dl = await api.get(`/api/forms/${form.id}/files/${cv.fileId}`)
    .buffer(true).parse((res2, cb) => { const c = []; res2.on('data', (d) => c.push(d)); res2.on('end', () => cb(null, Buffer.concat(c))); })
    .expect(200);
  assert.ok(dl.body.equals(pdf));
  assert.match(dl.headers['content-disposition'], /attachment/);
  await api.get(`/api/forms/${form.id}/files/nope`).expect(404);

  const x = await api.get(`/api/forms/${form.id}/submissions.xlsx`)
    .buffer(true).parse((res2, cb) => { const c = []; res2.on('data', (d) => c.push(d)); res2.on('end', () => cb(null, Buffer.concat(c))); })
    .expect(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  const cell = wb.worksheets[0].getRow(2).getCell(5);
  assert.equal(cell.text, 'Currículo João.pdf');
  assert.match(cell.hyperlink, new RegExp(`/api/forms/${form.id}/files/${cv.fileId}$`));

  // JSON submissions still work for forms without a required file
  const plain = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const t2 = (await api.post(`/api/forms/${plain.id}/links`).send({}).expect(201)).body.token;
  await api.post(`/api/public/${t2}`).send({ data: { full_name: 'A', email: 'a@b.co', agree: true } }).expect(201);

  // deleting the form removes its files from disk
  const formDir = pathMod.join(process.env.UPLOAD_DIR, form.id);
  assert.ok(fs.existsSync(formDir));
  await api.delete(`/api/forms/${form.id}`).expect(204);
  assert.ok(!fs.existsSync(formDir));
});

// ---------- Emailing links ----------
test('send email: emails active links, skips the rest, records status and preview', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const mk = (b) => api.post(`/api/forms/${form.id}/links`).send(b).expect(201).then((r) => r.body);
  const ana = await mk({ recipientName: 'Ana', recipientEmail: 'ana@x.co' });
  const ben = await mk({ recipientName: 'Ben', recipientEmail: 'ben@x.co' });
  const noMail = await mk({ recipientName: 'No Mail' });
  // Ben submits, so his single-use link is used up
  await api.post(`/api/public/${ben.token}`).send({ data: { full_name: 'Ben', email: 'ben@x.co', agree: true } }).expect(201);

  const tpl = (await api.get(`/api/forms/${form.id}/email-template`).expect(200)).body;
  assert.equal(tpl.testMode, true);
  assert.equal(tpl.baseUrlIsLocal, true);

  await api.post(`/api/forms/${form.id}/links/send`).send({ linkIds: [], subject: 'x', message: 'y' }).expect(400);
  const out = (await api.post(`/api/forms/${form.id}/links/send`)
    .send({ linkIds: [ana.id, ben.id, noMail.id], subject: 'Hello {name}', message: 'Hi {name}, fill {form}: {link}' }).expect(200)).body;
  assert.equal(out.test, 1);
  assert.equal(out.skipped, 2);
  assert.deepEqual(out.skippedList.map((x) => x.reason).sort(), ['Already submitted — use Resend to send a new link', 'No email address']);

  const links = (await api.get(`/api/forms/${form.id}/links`).expect(200)).body;
  const a = links.find((l) => l.id === ana.id);
  assert.equal(a.sendCount, 1);
  assert.equal(a.lastEmailStatus, 'test');
  assert.ok(a.sentAt && a.lastEmailId);
  assert.equal(links.find((l) => l.id === ben.id).state, 'used');

  const prev = await api.get(`/api/forms/${form.id}/emails/${a.lastEmailId}`).expect(200);
  assert.match(prev.text, /Hello Ana/);
  assert.ok(prev.text.includes(`/f/${ana.token}`));
  assert.match(prev.headers['content-security-policy'], /sandbox/);
  assert.equal(fs.readdirSync(process.env.OUTBOX_DIR).filter((f) => f.includes('ana@x.co')).length, 1);

  // template is remembered for next time
  const tpl2 = (await api.get(`/api/forms/${form.id}/email-template`)).body;
  assert.equal(tpl2.subject, 'Hello {name}');

  // sending again counts up
  await api.post(`/api/forms/${form.id}/links/send`).send({ linkIds: [ana.id], subject: 's', message: 'm' }).expect(200);
  assert.equal((await api.get(`/api/forms/${form.id}/links`)).body.find((l) => l.id === ana.id).sendCount, 2);
});

test('resend: creates a new link, deactivates the old one, emails the new one', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const old = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Cy', recipientEmail: 'cy@x.co' }).expect(201)).body;
  await api.post(`/api/public/${old.token}`).send({ data: { full_name: 'Cy', email: 'cy@x.co', agree: true } }).expect(201);

  const day = localYmd(new Date(Date.now() + 3 * 86400000));
  const out = (await api.post(`/api/forms/${form.id}/links/resend`)
    .send({ linkIds: [old.id], subject: 'New link', message: 'Here you go', expiresOn: day, maxSubmissions: 2 }).expect(200)).body;
  assert.equal(out.created, 1);
  assert.equal(out.test, 1);

  const links = (await api.get(`/api/forms/${form.id}/links`)).body;
  assert.equal(links.length, 2);
  const fresh = links.find((l) => l.id !== old.id);
  const oldNow = links.find((l) => l.id === old.id);
  assert.equal(oldNow.state, 'replaced');
  assert.equal(oldNow.replacedBy, fresh.id);
  assert.equal(fresh.recipientEmail, 'cy@x.co');
  assert.equal(fresh.maxSubmissions, 2);
  assert.equal(localYmd(new Date(fresh.expiresAt)), day);
  assert.equal(fresh.sendCount, 1);
  assert.notEqual(fresh.token, old.token);

  // old link no longer works; new one does
  const gone = await api.get(`/api/public/${old.token}`).expect(410);
  assert.match(gone.body.error, /replaced/);
  await api.get(`/api/public/${fresh.token}`).expect(200);

  // a replaced link can't be resent or sent again
  const again = (await api.post(`/api/forms/${form.id}/links/resend`).send({ linkIds: [old.id], subject: 's', message: 'm' }).expect(200)).body;
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 1);
  const s2 = (await api.post(`/api/forms/${form.id}/links/send`).send({ linkIds: [old.id], subject: 's', message: 'm' }).expect(200)).body;
  assert.equal(s2.skipped, 1);
});

// ---------- ZIP export (Excel + files grouped by question) ----------
test('submissions.zip contains the Excel file and uploads grouped in one folder per question', async () => {
  const JSZip = require('jszip'); // bundled with exceljs
  const form = (await api.post('/api/forms').send({
    title: 'Photo Contest',
    fields: [
      { name: 'full_name', label: 'Name', type: 'text', required: true },
      { name: 'photo', label: 'Your photo', type: 'file', required: true, accept: ['.jpg', '.png'] },
      { name: 'id_doc', label: 'ID: front/back?', type: 'file', accept: ['.pdf'] },
    ],
  }).expect(201)).body;
  const submit = async (name, files) => {
    const t = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: name, maxSubmissions: 0 }).expect(201)).body.token;
    let r = api.post(`/api/public/${t}`).field('data', JSON.stringify({ full_name: name }));
    for (const [field, buf, fname] of files) r = r.attach(field, buf, fname);
    await r.expect(201);
  };
  await submit('Maria Santos', [['photo', Buffer.from('JPEG-1'), 'IMG_001.JPG'], ['id_doc', Buffer.from('%PDF-1'), 'scan.pdf']]);
  await submit('Li Wei', [['photo', Buffer.from('PNG-2'), 'me.png']]);
  await submit('Maria Santos', [['photo', Buffer.from('JPEG-3'), 'another.jpg']]); // same person, second entry

  const res = await api.get(`/api/forms/${form.id}/submissions.zip`)
    .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); })
    .expect(200);
  assert.equal(res.headers['content-type'], 'application/zip');
  const base = res.headers['content-disposition'].match(/filename="(.+)\.zip"/)[1];
  assert.match(base, /^Photo-Contest-submissions-\d{4}-\d{2}-\d{2}$/);

  const zip = await JSZip.loadAsync(res.body);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.deepEqual(names, [
    `${base}/ID_ front_back_/scan.pdf`,
    `${base}/Photo-Contest-submissions.xlsx`,
    `${base}/Your photo/IMG_001.JPG`,
    `${base}/Your photo/another.jpg`,
    `${base}/Your photo/me.png`,
  ]);
  assert.equal(await zip.file(`${base}/Your photo/me.png`).async('string'), 'PNG-2');
  assert.equal(await zip.file(`${base}/Your photo/another.jpg`).async('string'), 'JPEG-3');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await zip.file(`${base}/Photo-Contest-submissions.xlsx`).async('nodebuffer'));
  const ws = wb.worksheets[0];
  assert.deepEqual(ws.getRow(1).values.slice(4), ['Name', 'Your photo', 'ID: front/back?']);
  const c = ws.getRow(2).getCell(5);
  assert.equal(c.text, 'Your photo/IMG_001.JPG');
  assert.equal(c.hyperlink, 'Your%20photo/IMG_001.JPG'); // relative: opens the file next to the workbook
  assert.equal(ws.getRow(3).getCell(6).text, ''); // Li Wei sent no ID document
});

test('zip keeps original file names and numbers duplicates', async () => {
  const JSZip = require('jszip');
  const form = (await api.post('/api/forms').send({
    title: 'Shared',
    fields: [{ name: 'full_name', label: 'Full name', type: 'text', required: true }, { name: 'pic', label: 'Picture', type: 'file', required: true }],
  }).expect(201)).body;
  const t = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Everyone', maxSubmissions: 0 }).expect(201)).body.token;
  for (const n of ['Ana Lima', 'Ben Ng']) {
    await api.post(`/api/public/${t}`).field('data', JSON.stringify({ full_name: n })).attach('pic', Buffer.from(n), 'x.png').expect(201);
  }
  const res = await api.get(`/api/forms/${form.id}/submissions.zip`)
    .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
  const zip = await JSZip.loadAsync(res.body);
  const pics = Object.keys(zip.files).filter((n) => n.includes('/Picture/')).map((n) => n.split('/').pop()).sort();
  assert.deepEqual(pics, ['x (2).png', 'x.png']);
});

// ---------- Unique titles, duplicate, lock ----------
test('form titles are unique (ignoring case) on create and edit', async () => {
  await api.post('/api/forms').send({ ...sampleForm, title: 'Unique Title' }).expect(201);
  const dup = await api.post('/api/forms').send({ ...sampleForm, title: '  unique title ' }).expect(409);
  assert.match(dup.body.details[0], /already exists/);
  const other = (await api.post('/api/forms').send({ ...sampleForm, title: 'Other Title' }).expect(201)).body;
  await api.put(`/api/forms/${other.id}`).send({ ...sampleForm, title: 'UNIQUE TITLE' }).expect(409);
  await api.put(`/api/forms/${other.id}`).send({ ...sampleForm, title: 'Other Title' }).expect(200); // own title is fine
});

test('duplicate copies questions and email template, not recipients or submissions', async () => {
  const src = (await api.post('/api/forms').send({ ...fileForm, title: 'Original Form' }).expect(201)).body;
  const link = (await api.post(`/api/forms/${src.id}/links`).send({ recipientName: 'Ana', recipientEmail: 'ana@x.co' }).expect(201)).body;
  await api.post(`/api/forms/${src.id}/links/send`).send({ linkIds: [link.id], subject: 'Custom {form}', message: 'Custom body' }).expect(200);
  await api.post(`/api/forms/${src.id}/lock`).expect(200);

  await api.post(`/api/forms/${src.id}/duplicate`).send({ title: '' }).expect(400);
  await api.post(`/api/forms/${src.id}/duplicate`).send({ title: 'original form' }).expect(409);
  const copy = (await api.post(`/api/forms/${src.id}/duplicate`).send({ title: 'Original Form 2027', description: 'New year' }).expect(201)).body;
  assert.notEqual(copy.id, src.id);
  assert.equal(copy.description, 'New year');
  assert.deepEqual(copy.fields, src.fields);
  assert.equal(copy.locked, false); // copy starts open
  assert.equal((await api.get(`/api/forms/${copy.id}/links`)).body.length, 0);
  assert.equal((await api.get(`/api/forms/${copy.id}/submissions`)).body.length, 0);
  assert.equal((await api.get(`/api/forms/${copy.id}/email-template`)).body.subject, 'Custom {form}');
});

test('lock blocks opening and submitting; unlock restores unexpired links only', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const ok = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Ok' }).expect(201)).body;
  const soon = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Soon', expiresOn: localYmd(new Date()) }).expect(201)).body;
  const answer = { data: { full_name: 'Ok', email: 'ok@x.co', agree: true } };

  const locked = (await api.post(`/api/forms/${form.id}/lock`).expect(200)).body;
  assert.equal(locked.locked, true);
  assert.ok(locked.lockedAt);
  const list = (await api.get('/api/forms')).body.find((f) => f.id === form.id);
  assert.equal(list.locked, true);

  const g = await api.get(`/api/public/${ok.token}`).expect(423);
  assert.equal(g.body.locked, true);
  assert.match(g.body.error, /temporarily closed/);
  await api.post(`/api/public/${ok.token}`).send(answer).expect(423);
  // a multipart upload is refused before any bytes are stored
  await api.post(`/api/public/${ok.token}`).field('data', JSON.stringify(answer.data)).attach('x', Buffer.from('a'), 'a.pdf').expect(423);
  assert.equal((await api.get(`/api/forms/${form.id}/submissions`)).body.length, 0);
  assert.equal((await api.get(`/api/forms/${form.id}/links`)).body.find((l) => l.id === ok.id).submissionCount, 0);

  // simulate the "today" link expiring while the form was locked
  await db('links').where({ id: soon.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });

  const unlocked = (await api.post(`/api/forms/${form.id}/unlock`).expect(200)).body;
  assert.equal(unlocked.locked, false);
  await api.get(`/api/public/${ok.token}`).expect(200);
  await api.post(`/api/public/${ok.token}`).send(answer).expect(201);
  const exp = await api.get(`/api/public/${soon.token}`).expect(410);
  assert.match(exp.body.error, /expired/);
});

test('default email: title as subject, date, name, link button, description', async () => {
  const form = (await api.post('/api/forms').send({ ...sampleForm, title: 'Members Survey', description: 'Bring your member ID.' }).expect(201)).body;
  const tpl = (await api.get(`/api/forms/${form.id}/email-template`)).body;
  assert.equal(tpl.subject, '{form}');
  assert.match(tpl.message, /^\{date\}\n\nHi there \{name\},/);
  const link = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Maria', recipientEmail: 'maria@x.co' }).expect(201)).body;
  await api.post(`/api/forms/${form.id}/links/send`).send({ linkIds: [link.id], subject: tpl.subject, message: tpl.message }).expect(200);
  const log = await db('email_log').where({ link_id: link.id }).first();
  assert.equal(log.subject, 'Members Survey');
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  assert.ok(log.text.startsWith(`${today}\n\nHi there Maria,`));
  assert.match(log.text, new RegExp(`Here’s your link: http://[^\\s]+/f/${link.token}\\n`));
  assert.ok(log.text.includes('\n\nBring your member ID.\n\nThanks in advance'));
  assert.equal((log.html.match(/Open the form<\/a>/g) || []).length, 1); // button sits where the link is, not repeated
});

test('bulk remove deletes only the selected links of this form, with their submissions', async () => {
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const other = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const mk = (f, n) => api.post(`/api/forms/${f}/links`).send({ recipientName: n, maxSubmissions: 0 }).expect(201).then((r) => r.body);
  const a = await mk(form.id, 'A'); const b = await mk(form.id, 'B'); const c = await mk(form.id, 'C');
  const foreign = await mk(other.id, 'X');
  await api.post(`/api/public/${a.token}`).send({ data: { full_name: 'A', email: 'a@x.co', agree: true } }).expect(201);

  await api.post(`/api/forms/${form.id}/links/delete`).send({ linkIds: [] }).expect(400);
  const out = (await api.post(`/api/forms/${form.id}/links/delete`).send({ linkIds: [a.id, b.id, foreign.id] }).expect(200)).body;
  assert.equal(out.removed, 2); // the other form's link is not touched
  assert.equal(out.submissionsDeleted, 1);
  const left = (await api.get(`/api/forms/${form.id}/links`)).body.map((l) => l.id);
  assert.deepEqual(left, [c.id]);
  assert.equal((await api.get(`/api/forms/${other.id}/links`)).body.length, 1);
  await api.get(`/api/public/${a.token}`).expect(404);
  const subs = (await api.get(`/api/forms/${form.id}/submissions`)).body;
  assert.equal(subs.length, 0); // A's submission was deleted with the recipient
});

// ---------- Polls and rankings ----------
const pollForm = {
  title: 'Team Outing',
  fields: [
    { name: 'full_name', label: 'Name', type: 'text', required: true },
    { name: 'venue', label: 'Where should we go?', type: 'poll', required: true, options: ['Beach', 'Mountains', 'City'] },
    { name: 'food', label: 'Food (pick up to 2)', type: 'poll', maxChoices: 2, options: ['Pizza', 'Sushi', 'BBQ', 'Salad'] },
    { name: 'days', label: 'Rank the days', type: 'ranking', required: true, options: ['Friday', 'Saturday', 'Sunday'] },
  ],
};

test('poll and ranking definitions are validated', async () => {
  const bad = await api.post('/api/forms').send({ title: 'Bad poll', fields: [
    { name: 'p', label: 'P', type: 'poll', options: ['Only one'] },
    { name: 'q', label: 'Q', type: 'poll', options: ['A', 'B'], maxChoices: 3 },
    { name: 'r', label: 'R', type: 'ranking', options: ['X', 'x'] },
  ] }).expect(400);
  assert.equal(bad.body.details.length, 3);
  const ok = (await api.post('/api/forms').send(uniq(pollForm)).expect(201)).body;
  assert.equal(ok.fields[1].maxChoices, 1);
  assert.equal(ok.fields[2].maxChoices, 2);
});

test('polls and rankings: submit, validate, view own answers with live totals', async () => {
  const form = (await api.post('/api/forms').send(uniq(pollForm)).expect(201)).body;
  const mk = async (n) => (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: n }).expect(201)).body.token;
  const [ta, tb, tc] = [await mk('Ana'), await mk('Ben'), await mk('Cy')];

  // invalid answers
  let r = await api.post(`/api/public/${ta}`).send({ data: {
    full_name: 'Ana', venue: ['Beach', 'City'], food: ['Pizza', 'Sushi', 'BBQ'], days: { Friday: 1, Saturday: 1, Sunday: 2 },
  } }).expect(400);
  assert.equal(r.body.fields.venue, 'Choose only one option');
  assert.equal(r.body.fields.food, 'Choose up to 2 options');
  assert.equal(r.body.fields.days, 'Each number can only be used once');
  r = await api.post(`/api/public/${ta}`).send({ data: { full_name: 'Ana', days: { Friday: 1 } } }).expect(400);
  assert.equal(r.body.fields.venue, 'Please choose an option');
  assert.equal(r.body.fields.days, 'Please give every item a number from 1 to 3');

  // valid answers from three people
  await api.post(`/api/public/${ta}`).send({ data: { full_name: 'Ana', venue: ['Beach'], food: ['Pizza', 'Sushi'], days: { Friday: 2, Saturday: 1, Sunday: 3 } } }).expect(201);
  await api.post(`/api/public/${tb}`).send({ data: { full_name: 'Ben', venue: 'Beach', food: ['Sushi'], days: { Friday: 1, Saturday: 2, Sunday: 3 } } }).expect(201);
  await api.post(`/api/public/${tc}`).send({ data: { full_name: 'Cy', venue: ['City'], days: ['Saturday', 'Sunday', 'Friday'] } }).expect(201);

  // stored as arrays (ranking in order 1..n)
  const subs = (await api.get(`/api/forms/${form.id}/submissions`)).body;
  const ana = subs.find((s) => s.data.full_name === 'Ana').data;
  assert.deepEqual(ana.venue, ['Beach']);
  assert.deepEqual(ana.days, ['Saturday', 'Friday', 'Sunday']);
  assert.equal(subs.find((s) => s.data.full_name === 'Cy').data.food, null);

  // Ana re-opens her (used) link: her answers + totals, her choices marked by value
  const view = (await api.get(`/api/public/${ta}`).expect(200)).body;
  assert.equal(view.mode, 'view');
  const venue = view.submissions[0].answers.find((a) => a.name === 'venue');
  assert.deepEqual(venue.value, ['Beach']);
  assert.deepEqual(venue.results.options.map((o) => [o.option, o.count, o.percent]), [['Beach', 2, 67], ['Mountains', 0, 0], ['City', 1, 33]]);
  assert.equal(venue.results.responses, 3);
  const food = view.submissions[0].answers.find((a) => a.name === 'food');
  assert.equal(food.results.responses, 2); // Cy skipped the optional poll
  assert.deepEqual(food.results.options.find((o) => o.option === 'Sushi'), { option: 'Sushi', count: 2, percent: 100 });
  const days = view.submissions[0].answers.find((a) => a.name === 'days');
  assert.deepEqual(days.results.options.map((o) => [o.option, o.averageRank, o.firstPlace]), [['Saturday', 1.3, 2], ['Friday', 2, 1], ['Sunday', 2.7, 0]]);
  // the same view is available right after submitting
  assert.equal((await api.get(`/api/public/${ta}/submission`).expect(200)).body.mode, 'view');

  // admin results + Excel (answers + results sheet)
  const results = (await api.get(`/api/forms/${form.id}/results`).expect(200)).body;
  assert.equal(results.venue.options[0].count, 2);
  const x = await api.get(`/api/forms/${form.id}/submissions.xlsx`)
    .buffer(true).parse((res2, cb) => { const c = []; res2.on('data', (d) => c.push(d)); res2.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  const ws = wb.getWorksheet('Submissions');
  assert.equal(ws.getRow(2).getCell(6).text, 'Pizza; Sushi');
  assert.equal(ws.getRow(2).getCell(7).text, '1. Saturday; 2. Friday; 3. Sunday');
  const rs = wb.getWorksheet('Poll results');
  assert.equal(rs.getRow(1).getCell(1).text, 'Where should we go?');
  assert.equal(rs.getRow(2).getCell(2).value, 2);
});

test('unlimited link keeps showing the form; locked or expired links with answers show the answers', async () => {
  const form = (await api.post('/api/forms').send(uniq(pollForm)).expect(201)).body;
  const link = (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: 'Dee', maxSubmissions: 0 }).expect(201)).body;
  const answer = { data: { full_name: 'Dee', venue: ['City'], days: ['Sunday', 'Saturday', 'Friday'] } };
  await api.post(`/api/public/${link.token}`).send(answer).expect(201);
  assert.equal((await api.get(`/api/public/${link.token}`)).body.mode, 'form'); // can still submit
  await api.post(`/api/forms/${form.id}/lock`).expect(200);
  const v = (await api.get(`/api/public/${link.token}`).expect(200)).body;
  assert.equal(v.mode, 'view');
  assert.equal(v.canSubmitAgain, false);
  await api.post(`/api/public/${link.token}`).send(answer).expect(423); // still can't submit
  // a link with no answers on a locked form still gets the "closed" message
  const fresh = (await api.post(`/api/forms/${form.id}/links`).send({}).expect(201)).body;
  await api.get(`/api/public/${fresh.token}`).expect(423);
});

test('field notes are saved, limited, and sent to the form page; field order is kept', async () => {
  const form = (await api.post('/api/forms').send({ title: 'Notes Form', fields: [
    { name: 'b_second', label: 'Second', type: 'text', notes: '  Use your legal name  ' },
    { name: 'a_first', label: 'First', type: 'email' },
  ] }).expect(201)).body;
  assert.equal(form.fields[0].notes, 'Use your legal name');
  assert.equal(form.fields[1].notes, undefined);
  // reorder by saving the fields in a new order
  const upd = (await api.put(`/api/forms/${form.id}`).send({ title: 'Notes Form', fields: [form.fields[1], form.fields[0]] }).expect(200)).body;
  assert.deepEqual(upd.fields.map((f) => f.name), ['a_first', 'b_second']);
  const link = (await api.post(`/api/forms/${form.id}/links`).send({}).expect(201)).body;
  const pub = (await api.get(`/api/public/${link.token}`).expect(200)).body;
  assert.deepEqual(pub.fields.map((f) => [f.name, f.notes]), [['a_first', undefined], ['b_second', 'Use your legal name']]);
  const tooLong = await api.post('/api/forms').send({ title: 'Long notes', fields: [{ name: 'x', label: 'X', type: 'text', notes: 'n'.repeat(501) }] }).expect(400);
  assert.match(tooLong.body.details[0], /500 characters/);
});

test('image uploads can be viewed inline; other files (and SVG) always download', async () => {
  const form = (await api.post('/api/forms').send({ title: 'Image Form', fields: [
    { name: 'pic', label: 'Picture', type: 'file' }, { name: 'doc', label: 'Doc', type: 'file' }, { name: 'vec', label: 'Vector', type: 'file' },
  ] }).expect(201)).body;
  const t = (await api.post(`/api/forms/${form.id}/links`).send({}).expect(201)).body.token;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await api.post(`/api/public/${t}`).field('data', '{}')
    .attach('pic', png, 'Photo.PNG').attach('doc', Buffer.from('%PDF-1'), 'a.pdf').attach('vec', Buffer.from('<svg/>'), 'x.svg').expect(201);
  const d = (await api.get(`/api/forms/${form.id}/submissions`)).body[0].data;
  const base = `/api/forms/${form.id}/files`;

  const img = await api.get(`${base}/${d.pic.fileId}?view=1`).expect(200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.match(img.headers['content-disposition'], /^inline/);
  assert.match(img.headers['content-security-policy'], /default-src 'none'/);
  assert.match((await api.get(`${base}/${d.pic.fileId}`)).headers['content-disposition'], /^attachment/);

  for (const f of [d.doc, d.vec]) {
    const r = await api.get(`${base}/${f.fileId}?view=1`).expect(200);
    assert.match(r.headers['content-disposition'], /^attachment/);
  }
});

test('removing recipients deletes their submissions, file records and files on disk', async () => {
  const form = (await api.post('/api/forms').send({ title: 'Remove With Files', fields: [
    { name: 'full_name', label: 'Name', type: 'text' }, { name: 'pic', label: 'Picture', type: 'file' },
    { name: 'vote', label: 'Vote', type: 'poll', options: ['Yes', 'No'] },
  ] }).expect(201)).body;
  const mk = async (n) => (await api.post(`/api/forms/${form.id}/links`).send({ recipientName: n }).expect(201)).body;
  const keep = await mk('Keep'); const drop = await mk('Drop');
  for (const [l, v] of [[keep, 'Yes'], [drop, 'No']]) {
    await api.post(`/api/public/${l.token}`).field('data', JSON.stringify({ full_name: l.recipientName, vote: [v] }))
      .attach('pic', Buffer.from(l.recipientName), `${l.recipientName}.png`).expect(201);
  }
  const subs = (await api.get(`/api/forms/${form.id}/submissions`)).body;
  const dropSub = subs.find((x) => x.data.full_name === 'Drop');
  const dropDir = pathMod.join(process.env.UPLOAD_DIR, form.id, dropSub.id);
  assert.ok(fs.existsSync(dropDir));

  const out = (await api.delete(`/api/forms/${form.id}/links/${drop.id}`).expect(200)).body;
  assert.deepEqual(out, { removed: 1, submissionsDeleted: 1, filesDeleted: 1 });
  assert.ok(!fs.existsSync(dropDir));
  assert.equal(await db('files').where({ submission_id: dropSub.id }).first(), undefined);
  const left = (await api.get(`/api/forms/${form.id}/submissions`)).body;
  assert.deepEqual(left.map((x) => x.data.full_name), ['Keep']);
  const results = (await api.get(`/api/forms/${form.id}/results`)).body;
  assert.deepEqual(results.vote.options.map((o) => o.count), [1, 0]); // poll totals recalculated
  await api.get(`/api/forms/${form.id}/files/${dropSub.data.pic.fileId}`).expect(404);
  await api.delete(`/api/forms/${form.id}/links/${drop.id}`).expect(404);
});

// ---------- Sign in with Google, ownership, "sent to me" ----------
const authMod = require('../src/auth');

test('signed-out visitors: admin API is closed, dashboard redirects to login, forms still open', async () => {
  const anon = request(app);
  await anon.get('/api/forms').expect(401);
  await anon.get('/api/me/invitations').expect(401);
  await anon.get('/api/auth/me').expect(401);
  const home = await anon.get('/').expect(302);
  assert.equal(home.headers.location, '/login');
  const login = await anon.get('/login').expect(200);
  assert.match(login.text, /accounts\.google\.com\/gsi\/client/);
  assert.equal(login.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  // a recipient opening their personal link needs no account
  const form = (await api.post('/api/forms').send(uniq(sampleForm)).expect(201)).body;
  const link = (await api.post(`/api/forms/${form.id}/links`).send({}).expect(201)).body;
  await anon.get(`/api/public/${link.token}`).expect(200);
  await anon.post(`/api/public/${link.token}`).send({ data: { full_name: 'X', email: 'x@y.co', agree: true } }).expect(201);
  // signed-in users skip the login page
  assert.equal((await api.get('/login').expect(302)).headers.location, '/');
});

test('the first account to sign in received the forms made before sign-in existed', async () => {
  const forms = (await api.get('/api/forms').expect(200)).body;
  assert.ok(forms.some((f) => f.id === legacyFormId));
  assert.equal((await api.get('/api/auth/me').expect(200)).body.email, 'andre@example.com'); // stored lower-case
});

test('Google sign-in: verified email required; accounts only see their own forms', async () => {
  authMod.setGoogleVerifier(async (cred) => {
    if (cred === 'bad') throw new Error('invalid');
    if (cred === 'unverified') return { sub: 'g-2', email: 'eve@example.com', emailVerified: false };
    return { sub: 'g-1', email: 'Beth@Example.com', emailVerified: true, name: 'Beth', picture: 'https://x/p.png' };
  });
  const beth = request.agent(app);
  await beth.post('/api/auth/google').send({}).expect(400);
  await beth.post('/api/auth/google').send({ credential: 'bad' }).expect(401);
  await beth.post('/api/auth/google').send({ credential: 'unverified' }).expect(403);
  const me = (await beth.post('/api/auth/google').send({ credential: 'good' }).expect(200)).body;
  assert.equal(me.email, 'beth@example.com');
  assert.equal(me.name, 'Beth');

  // Beth sees none of Andre's forms and can't open them
  assert.equal((await beth.get('/api/forms').expect(200)).body.length, 0);
  await beth.get(`/api/forms/${legacyFormId}`).expect(404);
  await beth.get(`/api/forms/${legacyFormId}/submissions`).expect(404);
  await beth.delete(`/api/forms/${legacyFormId}`).expect(404);
  await api.get(`/api/forms/${legacyFormId}`).expect(200); // still there for Andre

  // titles only need to be unique per account
  await beth.post('/api/forms').send({ ...sampleForm, title: 'Legacy Form' }).expect(201);
  await api.post('/api/forms').send({ ...sampleForm, title: 'legacy form' }).expect(409);

  // signing in again with the same Google account reuses the user
  const again = request.agent(app);
  assert.equal((await again.post('/api/auth/google').send({ credential: 'good' }).expect(200)).body.id, me.id);

  // logout ends the session
  await beth.post('/api/auth/logout').expect(200);
  await beth.get('/api/forms').expect(401);
});

test('forms sent to my email appear in my dashboard with their status', async () => {
  authMod.setGoogleVerifier(async () => ({ sub: 'g-cara', email: 'cara@example.com', emailVerified: true, name: 'Cara' }));
  const cara = request.agent(app);
  await cara.post('/api/auth/google').send({ credential: 'x' }).expect(200);

  const f1 = (await api.post('/api/forms').send({ ...sampleForm, title: 'Invite One', description: 'First' }).expect(201)).body;
  const f2 = (await api.post('/api/forms').send({ ...sampleForm, title: 'Invite Two' }).expect(201)).body;
  const f3 = (await api.post('/api/forms').send({ ...sampleForm, title: 'Invite Three' }).expect(201)).body;
  const l1 = (await api.post(`/api/forms/${f1.id}/links`).send({ recipientName: 'Cara', recipientEmail: 'CARA@example.com' }).expect(201)).body;
  const l2 = (await api.post(`/api/forms/${f2.id}/links`).send({ recipientName: 'Cara', recipientEmail: 'cara@example.com' }).expect(201)).body;
  await api.post(`/api/forms/${f3.id}/links`).send({ recipientName: 'Someone', recipientEmail: 'other@example.com' }).expect(201);
  // Cara answers form 2; form 1 gets resent (old link replaced) and locked
  await request(app).post(`/api/public/${l2.token}`).send({ data: { full_name: 'Cara', email: 'cara@example.com', agree: true } }).expect(201);
  await api.post(`/api/forms/${f1.id}/links/resend`).send({ linkIds: [l1.id], subject: 's', message: 'm' }).expect(200);
  await api.post(`/api/forms/${f1.id}/lock`).expect(200);

  const inv = (await cara.get('/api/me/invitations').expect(200)).body;
  assert.deepEqual(inv.map((i) => [i.title, i.status]).sort(), [['Invite One', 'closed'], ['Invite Two', 'submitted']]);
  const one = inv.find((i) => i.title === 'Invite One');
  assert.equal(one.from, 'Andre');
  assert.equal(one.description, 'First');
  assert.notEqual(one.url, `/f/${l1.token}`); // points at the newest link, not the replaced one
  // Cara can't manage these forms
  await cara.get(`/api/forms/${f1.id}`).expect(404);
  // and Andre, who isn't a recipient, has no invitations
  assert.equal((await api.get('/api/me/invitations').expect(200)).body.length, 0);
});

test('requests from another website are blocked', async () => {
  await api.post('/api/forms').set('Origin', 'https://evil.example').send(uniq(sampleForm)).expect(403);
  await api.post('/api/forms').set('Origin', `http://${'127.0.0.1'}`).send(uniq(sampleForm)).expect((r) => assert.notEqual(r.status, 201));
});
