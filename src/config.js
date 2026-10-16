require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
  // Uploaded files are stored on disk here (outside the database).
  uploadDir: path.resolve(__dirname, '..', process.env.UPLOAD_DIR || './data/uploads'),
  // Hard cap per uploaded file, whatever a form allows.
  maxUploadMb: Math.min(Number(process.env.MAX_UPLOAD_MB) || 25, 200),
  // Email. Leave SMTP_HOST empty for TEST MODE: emails are saved to data/outbox instead of being sent.
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'StickyForms <no-reply@stickyforms.local>',
    replyTo: process.env.MAIL_REPLY_TO || '',
    outboxDir: path.resolve(__dirname, '..', process.env.OUTBOX_DIR || './data/outbox'),
  },
  auth: {
    // OAuth client ID from Google Cloud Console (APIs & Services > Credentials). Required to sign in.
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    // Local testing only: shows an email-only sign-in on http://localhost. Never enable on a public server.
    devLogin: process.env.DEV_LOGIN === 'true',
    sessionDays: Number(process.env.SESSION_DAYS) || 30,
  },
  dbClient: process.env.DB_CLIENT === 'pg' ? 'pg' : 'sqlite (built-in)',
};
