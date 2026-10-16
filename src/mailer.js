// Sends link emails over SMTP, or saves them to an outbox folder in test mode (no SMTP configured).
const fs = require('fs/promises');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');

let transport;
const testMode = () => !config.mail.host;

function getTransport() {
  if (transport) return transport;
  transport = testMode()
    ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    : nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
      pool: true,
      maxConnections: 3,
    });
  return transport;
}

// Default email. Placeholders: {date} {name} {form} {description} {link} {expiry}
const DEFAULT_SUBJECT = '{form}';
const DEFAULT_MESSAGE = [
  '{date}',
  '',
  'Hi there {name},',
  '',
  'Hope you\'re doing well. You’re receiving this message because you are part of our valued member and we’ve prepared a quick form for you to fill out.',
  '',
  'Here’s your link: {link}',
  '',
  'It only takes a few minutes to complete, and your submission is highly appreciated. We’d really appreciate it if you could fill it out at your earliest convenience.',
  '',
  '{description}',
  '',
  'Thanks in advance, and we look forward to receiving your entry.',
].join('\n');

// Earlier built-in default, so forms still using it can be switched to the new one.
const OLD_DEFAULT_SUBJECT = 'Your personal link: {form}';
const OLD_DEFAULT_MESSAGE = [
  'Hi {name},',
  '',
  'You have been invited to fill in "{form}". Please use your personal link below. It is unique to you, so please don\'t forward it.',
  '',
  'Thank you!',
].join('\n');

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

function fill(template, vars) {
  return template.replace(/\{(name|form|link|expiry|date|description)\}/g, (_, k) => vars[k]);
}

// Tidies text after placeholders are filled: "Hi there ," -> "Hi there,", and no empty paragraphs
// left behind when e.g. the form has no description.
function tidy(text) {
  return text
    .replace(/[ \t]+([,.!?])/g, '$1')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Builds subject/text/html for one recipient. */
function render({ subject, message, formTitle, formDescription, name, url, expiresAt, sentAt = new Date() }) {
  const expiry = expiresAt ? longDate(new Date(expiresAt)) : '';
  const vars = {
    name: (name || '').trim(),
    form: formTitle,
    description: (formDescription || '').trim(),
    link: url,
    expiry: expiry || 'no expiry date',
    date: longDate(sentAt),
  };
  const subj = tidy(fill(subject || DEFAULT_SUBJECT, vars)).replace(/[\r\n]+/g, ' ').slice(0, 300) || formTitle;
  const body = tidy(fill(message || DEFAULT_MESSAGE, vars));
  const expiryNote = expiry ? `This link works until ${expiry}.` : '';
  const linkInBody = body.includes(url);

  const text = [body, '', linkInBody ? '' : `Open the form: ${url}`, expiryNote].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');

  // Where the message mentions the link, show a button right there; otherwise add one after the message.
  const button = `<a href="${escHtml(url)}" style="background:#3b5bdb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;display:inline-block;font-weight:600;margin:4px 0">Open the form</a>`;
  const paragraphs = escHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>').split(escHtml(url)).join(button)}</p>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif;color:#1d2330">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:28px">
    <div style="font-size:15px;line-height:1.55">${paragraphs}</div>
    ${linkInBody ? '' : `<p style="margin:22px 0">${button}</p>`}
    <p style="font-size:13px;color:#667085;margin:18px 0 0">${expiryNote ? `${escHtml(expiryNote)}<br>` : ''}If the button doesn't work, copy this address into your browser:<br><a href="${escHtml(url)}" style="color:#3b5bdb;word-break:break-all">${escHtml(url)}</a></p>
  </div></body></html>`;

  return { subject: subj, text, html };
}

/** Sends (or saves) one email. Returns { status: 'sent'|'test'|'failed', error? }. */
async function send({ to, subject, text, html }) {
  const msg = { from: config.mail.from, to, subject, text, html };
  if (config.mail.replyTo) msg.replyTo = config.mail.replyTo;
  try {
    const info = await getTransport().sendMail(msg);
    if (testMode()) {
      await fs.mkdir(config.mail.outboxDir, { recursive: true });
      const safe = to.replace(/[^\w.@-]+/g, '_');
      await fs.writeFile(path.join(config.mail.outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safe}.eml`), info.message);
      return { status: 'test' };
    }
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', error: String(err.message || err).slice(0, 500) };
  }
}

// Sends a list of jobs a few at a time.
async function sendAll(jobs, concurrency = 3) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await send(jobs[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

module.exports = { render, send, sendAll, testMode, DEFAULT_SUBJECT, DEFAULT_MESSAGE, OLD_DEFAULT_SUBJECT, OLD_DEFAULT_MESSAGE };
