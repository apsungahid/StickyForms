// Google sign-in: users, login sessions, and an owner for every form.
exports.up = async function up(knex) {
  await knex.schema.createTable('users', (t) => {
    t.string('id', 36).primary();
    t.string('google_sub', 255).unique(); // Google's stable account id
    t.string('email', 320).notNullable().unique(); // stored lower-case
    t.string('name', 200);
    t.string('picture', 1000);
    t.timestamp('created_at').notNullable();
    t.timestamp('last_login_at');
  });
  await knex.schema.createTable('sessions', (t) => {
    t.string('id', 64).primary(); // SHA-256 of the cookie value (the cookie itself is never stored)
    t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('created_at').notNullable();
    t.timestamp('expires_at').notNullable();
    t.index(['user_id']);
  });
  await knex.schema.alterTable('forms', (t) => {
    t.string('owner_id', 36).references('id').inTable('users').onDelete('SET NULL');
    t.index(['owner_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('forms', (t) => { t.dropIndex(['owner_id']); t.dropColumn('owner_id'); });
  await knex.schema.dropTableIfExists('sessions');
  await knex.schema.dropTableIfExists('users');
};
