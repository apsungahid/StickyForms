// Local-disk file storage. Kept behind a tiny interface so it can be swapped for S3 / Azure Blob later.
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

const root = () => config.uploadDir;

function resolveSafe(rel) {
  const full = path.resolve(root(), rel);
  if (!full.startsWith(path.resolve(root()) + path.sep)) throw new Error('Invalid file path');
  return full;
}

async function ensureRoot() {
  await fs.mkdir(path.join(root(), 'tmp'), { recursive: true });
}

// Moves a temp upload into its permanent place; returns the relative path stored in the DB.
async function save(tempPath, { formId, submissionId, fileId, ext }) {
  const rel = path.posix.join(formId, submissionId, `${fileId}${ext}`);
  const dest = resolveSafe(rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(tempPath, dest);
  } catch {
    await fs.copyFile(tempPath, dest); // rename fails across drives
    await fs.rm(tempPath, { force: true });
  }
  return rel;
}

// Form poster images live in <formId>/poster/ next to the form's uploads (deleted with the form).
async function writePoster(formId, buffer, ext) {
  const rel = path.posix.join(formId, 'poster', `${require('crypto').randomUUID()}${ext}`);
  const dest = resolveSafe(rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buffer);
  return rel;
}
async function copyPoster(rel, toFormId) {
  const ext = path.extname(rel);
  return writePoster(toFormId, await fs.readFile(resolveSafe(rel)), ext);
}
const removeFile = (rel) => (rel ? fs.rm(resolveSafe(rel), { force: true }).catch(() => {}) : Promise.resolve());

const absolutePath = (rel) => resolveSafe(rel);
const removeTemp = (paths) => Promise.all(paths.filter(Boolean).map((p) => fs.rm(p, { force: true }).catch(() => {})));
const removeForm = (formId) => fs.rm(resolveSafe(formId), { recursive: true, force: true }).catch(() => {});
const removeSubmissionDir = (formId, submissionId) =>
  fs.rm(resolveSafe(path.posix.join(formId, submissionId)), { recursive: true, force: true }).catch(() => {});

module.exports = { ensureRoot, save, writePoster, copyPoster, removeFile, absolutePath, removeTemp, removeForm, removeSubmissionDir, tempDir: () => path.join(root(), 'tmp') };
