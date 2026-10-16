// Sign in / out. Recipients filling a form never need any of this.
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const { EMAIL_RE } = require('../recipients');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({ googleClientId: config.auth.googleClientId || null, devLogin: config.auth.devLogin && auth.isLoopback(req) });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json(auth.publicUser(req.user));
});

// Receives the ID token from Google's "Sign in with Google" button.
router.post('/google', async (req, res) => {
  const credential = req.body?.credential;
  if (typeof credential !== 'string' || !credential) return res.status(400).json({ error: 'Missing Google credential' });
  let g;
  try {
    g = await auth.verifyGoogle(credential);
  } catch (err) {
    if (err.expose) return res.status(err.status).json({ error: err.message });
    console.warn('Google sign-in failed:', err.message); // details stay in the server log
    return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
  }
  if (!g.email || !g.emailVerified) return res.status(403).json({ error: 'Your Google account email is not verified.' });
  const user = await auth.upsertUser(g);
  await auth.startSession(req, res, user);
  res.json(auth.publicUser(user));
});

// Local testing only (DEV_LOGIN=true and the request comes from this computer).
router.post('/dev', async (req, res) => {
  if (!config.auth.devLogin || !auth.isLoopback(req)) return res.status(404).json({ error: 'Not found' });
  const email = String(req.body?.email || '').trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  const user = await auth.upsertUser({ email, name: String(req.body?.name || '').trim() || email.split('@')[0] });
  await auth.startSession(req, res, user);
  res.json(auth.publicUser(user));
});

router.post('/logout', async (req, res) => {
  await auth.endSession(req, res);
  res.json({ ok: true });
});

module.exports = router;
