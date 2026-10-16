const knex = require('knex');
const config = require('../knexfile');

const db = knex(config);

// SQLite returns JSON columns as strings; PostgreSQL returns parsed objects. Normalize both.
function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// SQLite returns timestamps as strings; PostgreSQL returns Date objects. Normalize to ISO strings.
function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

module.exports = { db, parseJson, toIso };
