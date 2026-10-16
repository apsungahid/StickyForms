// Knex client for Node's built-in SQLite (node:sqlite, Node 22.13+).
// No native add-on to compile, so `npm install` works everywhere without build tools.
// It reuses Knex's better-sqlite3 dialect (same SQL, same migrations) and only swaps the driver.
const Client_BetterSQLite3 = require('knex/lib/dialects/better-sqlite3');

const READER_RE = /^\s*(select|pragma|with|values|explain)\b|\breturning\b/i;

function loadNodeSqlite() {
  // Hide the one-time "SQLite is an experimental feature" warning on older Node 22 releases.
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('SQLite is an experimental feature')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } catch (err) {
    throw new Error(
      `Built-in SQLite is not available in Node ${process.version}. Install Node.js 22.13 or newer (LTS recommended). (${err.message})`,
    );
  } finally {
    process.emitWarning = original;
  }
}

class Client_NodeSQLite extends Client_BetterSQLite3 {
  _driver() {
    return loadNodeSqlite();
  }

  async acquireRawConnection() {
    const options = this.connectionSettings.options || {};
    return new this.driver.DatabaseSync(this.connectionSettings.filename, {
      readOnly: Boolean(options.readonly),
    });
  }

  async destroyRawConnection(connection) {
    connection.close();
  }

  async _query(connection, obj) {
    if (!obj.sql) throw new Error('The query is empty');
    if (!connection) throw new Error('No connection provided');

    const statement = connection.prepare(obj.sql);
    const bindings = this._formatBindings(obj.bindings);

    const isReader =
      typeof statement.columns === 'function' ? statement.columns().length > 0 : READER_RE.test(obj.sql);

    if (isReader) {
      // node:sqlite returns null-prototype objects; convert to plain objects.
      obj.response = statement.all(...bindings).map((row) => ({ ...row }));
      return obj;
    }

    const response = statement.run(...bindings);
    obj.response = response;
    obj.context = { lastID: Number(response.lastInsertRowid), changes: Number(response.changes) };
    return obj;
  }

  _formatBindings(bindings) {
    return super._formatBindings(bindings).map((b) => (b === undefined ? null : b));
  }
}

Object.assign(Client_NodeSQLite.prototype, { driverName: 'node:sqlite' });

module.exports = Client_NodeSQLite;
