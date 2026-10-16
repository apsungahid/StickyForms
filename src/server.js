const config = require('./config');
const { db } = require('./db');
const { createApp } = require('./app');

async function main() {
  if (config.autoMigrate) {
    const [, applied] = await db.migrate.latest();
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  }

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`StickyForms running at http://${shownHost}:${config.port}  (db: ${config.dbClient})`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(async () => {
      await db.destroy();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('Failed to start server:', err);
  await db.destroy().catch(() => {});
  process.exit(1);
});
