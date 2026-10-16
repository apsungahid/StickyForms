// Sign in with Google + cookie sessions.
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { db, toIso } = require('./db');
const config = require('./config');

const COOKIE = 'sf_session';
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Verifies a Google ID token (from the "Sign in with Google" button). Replaceable in tests.
let verifyGoogle = async (credential) => {
  if (!config.auth.googleClientId) throw Object.assign(new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID is empty).'), { status: 503, expose: true });
  const client = new OAuth2Client(config.auth.googleClientId);
  const ticket = await client.verifyIdToken({ idToken: credential, audience: config.auth.googleClientId });
  const p = ticket.getPayload();
  return { sub: p.sub, email: p.email, emailVerified: p.email_verified === true, name: p.name, picture: p.picture };
};
const setGoogleVerifier = (fn) => { verifyGoogle = fn; };

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/** Creates or updates the user for a verified Google identity (or dev login). */
async function upsertUser({ sub = null, email, name, picture }) {
  const now = new Date().toISOString();
  const lower = String(email).trim().toLowerCase();
  return db.transaction(async (trx) => {
    let user = (sub && await trx('users').where({ google_sub: sub }).first()) || await trx('users').where({ email: lower }).first();
    const firstEver = !user && !(await trx('users').first('id'));
    if (user) {
      const changes = { email: lower, name: name || user.name, picture: picture || user.picture, last_login_at: now };
      if (sub && !user.google_sub) changes.google_sub = sub;
      await trx('users').where({ id: user.id }).update(changes);
      user = { ...user, ...changes };
    } else {
      user = { id: crypto.randomUUID(), google_sub: sub, email: lower, name: name || null, picture: picture || null, created_at: now, last_login_at: now };
      await trx('users').insert(user);
    }
    // Decision (Andre, 2026-10-09): forms created before sign-in existed go to the first account that signs in.
    if (firstEver) await trx('forms').whereNull('owner_id').update({ owner_id: user.id });
    return user;
  });
}

async function startSession(req, res, user) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = new Date(now + config.auth.sessionDays * 86400000);
  await db('sessions').insert({ id: hash(raw), user_id: user.id, created_at: new Date(now).toISOString(), expires_at: expires.toISOString() });
  res.cookie(COOKIE, raw, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires, path: '/' });
}

async function endSession(req, res) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (raw) await db('sessions').where({ id: hash(raw) }).del();
  res.clearCookie(COOKIE, { path: '/' });
}

// Adds req.user when a valid session cookie is present.
async function attachUser(req, res, next) {
  try {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (raw) {
      const s = await db('sessions').where({ id: hash(raw) }).first();
      if (s && new Date(s.expires_at).getTime() > Date.now()) {
        req.user = await db('users').where({ id: s.user_id }).first();
      } else if (s) {
        await db('sessions').where({ id: s.id }).del();
      }
    }
    next();
  } catch (err) { next(err); }
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.', signIn: '/login' });
  next();
}

// Blocks cross-site form posts: a state-changing request from a browser must come from this site.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request blocked' }); } catch {
      return res.status(403).json({ error: 'Cross-site request blocked' });
    }
  }
  next();
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, createdAt: toIso(u.created_at) });

module.exports = {
  verifyGoogle: (c) => verifyGoogle(c), setGoogleVerifier, upsertUser, startSession, endSession,
  attachUser, requireUser, sameOrigin, isLoopback, publicUser, COOKIE,
};
