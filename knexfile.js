// Database configuration shared by the app and the knex CLI.
// Switching from SQLite to PostgreSQL is a config change: set DB_CLIENT=pg and DATABASE_URL.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');

// Any value other than 'pg' uses the built-in SQLite driver (no native build needed).
const client = process.env.DB_CLIENT || 'sqlite';

const common = {
  migrations: { directory: path.join(__dirname, 'migrations') },
  seeds: { directory: path.join(__dirname, 'seeds') },
};

function sqliteConfig() {
  const file = process.env.DB_FILE || path.join(__dirname, 'data', 'stickyforms.db');
  const filename = file === ':memory:' ? file : path.resolve(__dirname, file);
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });

  return {
    ...common,
    client: require('./src/sqlite-client'),
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(conn, done) {
        conn.exec('PRAGMA foreign_keys = ON');
        if (filename !== ':memory:') conn.exec('PRAGMA journal_mode = WAL');
        done();
      },
    },
  };
}

function postgresConfig() {
  return {
    ...common,
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 0, max: 10 },
  };
}

module.exports = client === 'pg' ? postgresConfig() : sqliteConfig();
