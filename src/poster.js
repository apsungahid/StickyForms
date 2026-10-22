// Poster images: allowed types (checked by content) and a safe way to serve them.
const storage = require('./storage');

const POSTER_MAX_MB = 5;

// Looks at the first bytes of the file, so a renamed .exe can't pass as a picture.
function detectPosterType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif', ext: '.gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

function sendPoster(res, form) {
  if (!form?.poster_path) return res.status(404).json({ error: 'This form has no poster.' });
  res.set('Content-Type', form.poster_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.set('Cache-Control', 'private, max-age=86400'); // URL changes (?v=) when the poster is replaced
  res.sendFile(storage.absolutePath(form.poster_path), { dotfiles: 'allow', headers: { 'Content-Type': form.poster_type } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Poster file is missing from storage' });
  });
}

module.exports = { detectPosterType, POSTER_MAX_MB, sendPoster };
