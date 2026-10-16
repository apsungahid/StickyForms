// Initial schema. Uses only portable column types so it runs unchanged on SQLite and PostgreSQL.

exports.up = async function up(knex) {
  await knex.schema.createTable('forms', (t) => {
    t.string('id', 36).primary(); // UUID generated in app code
    t.string('title', 200).notNullable();
    t.text('description');
    t.json('fields').notNullable(); // array of field definitions
    t.timestamp('created_at').notNullable();
    t.timestamp('updated_at').notNullable();
  });

  await knex.schema.createTable('links', (t) => {
    t.string('id', 36).primary();
    t.string('form_id', 36).notNullable().references('id').inTable('forms').onDelete('CASCADE');
    t.string('token', 64).notNullable().unique(); // the secret part of the shareable URL
    t.string('recipient_name', 200);
    t.string('recipient_email', 320);
    t.integer('max_submissions').defaultTo(1); // null = unlimited
    t.integer('submission_count').notNullable().defaultTo(0);
    t.timestamp('expires_at'); // null = never expires
    t.timestamp('created_at').notNullable();
    t.index(['form_id']);
  });

  await knex.schema.createTable('submissions', (t) => {
    t.string('id', 36).primary();
    t.string('form_id', 36).notNullable().references('id').inTable('forms').onDelete('CASCADE');
    t.string('link_id', 36).references('id').inTable('links').onDelete('SET NULL');
    t.json('data').notNullable();
    t.string('ip', 64);
    t.string('user_agent', 500);
    t.timestamp('submitted_at').notNullable();
    t.index(['form_id']);
    t.index(['link_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('submissions');
  await knex.schema.dropTableIfExists('links');
  await knex.schema.dropTableIfExists('forms');
};
