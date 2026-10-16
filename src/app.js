const path = require('path');
const express = require('express');
const { db } = require('./db');
const config = require('./config');
const formsRouter = require('./routes/forms');
const publicRouter = require('./routes/public');
const authRouter = require('./routes/auth');
const meRouter = require('./routes/me');
const auth = require('./auth');

// Express 4 doesn't forward rejected promises from async handlers; this wrapper does.
function wrapAsync(router) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const l of layer.route.stack) {
      const fn = l.handle;
      l.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    }
  }
  return router;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '200kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      await db.raw('select 1');
      res.json({ status: 'ok', db: db.client.driverName });
    } catch (err) {
      res.status(503).json({ status: 'error', error: err.message });
    }
  });

  app.use(auth.attachUser);
  app.use('/api', auth.sameOrigin);

  app.get('/api/settings', (req, res) => res.json({ maxUploadMb: config.maxUploadMb }));
  app.use('/api/auth', wrapAsync(authRouter));
  // Everything about creating and managing forms needs a signed-in user.
  app.use('/api/forms', auth.requireUser, wrapAsync(formsRouter));
  app.use('/api/me', auth.requireUser, wrapAsync(meRouter));
  // Recipients answering through their personal link never need to sign in.
  app.use('/api/public', wrapAsync(publicRouter));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/f/:token', (req, res) => res.sendFile(path.join(publicDir, 'fill.html')));
  const noCache = { headers: { 'Cache-Control': 'no-cache' } };
  // The dashboard needs a signed-in user; the login page sends signed-in users to the dashboard.
  app.get(['/', '/index.html'], (req, res) => (req.user ? res.sendFile(path.join(publicDir, 'index.html'), noCache) : res.redirect('/login')));
  app.get(['/login', '/login.html'], (req, res) => {
    if (req.user) return res.redirect('/');
    // Google's sign-in button needs the page origin in the Referer header.
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.sendFile(path.join(publicDir, 'login.html'), noCache);
  });
  // no-cache = the browser re-checks each time, so the page and its scripts are always the same version.
  app.use(express.static(publicDir, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
