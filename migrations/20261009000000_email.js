// Email sending: delivery status on links, "replaced by" for resends, per-form email template, and a send log.

exports.up = async function up(knex) {
  await knex.schema.alterTable('links', (t) => {
    t.timestamp('sent_at'); // last time an email with this link was sent
    t.integer('send_count').notNullable().defaultTo(0);
    t.string('last_email_status', 20); // sent | test | failed
    t.string('last_email_error', 500);
    t.string('replaced_by', 36); // id of the newer link created by "Resend"; this link no longer works
    t.timestamp('replaced_at');
  });

  await knex.schema.alterTable('forms', (t) => {
    t.string('email_subject', 300);
    t.text('email_message');
  });

  await knex.schema.createTable('email_log', (t) => {
    t.string('id', 36).primary();
    t.string('form_id', 36).notNullable().references('id').inTable('forms').onDelete('CASCADE');
    t.string('link_id', 36).references('id').inTable('links').onDelete('SET NULL');
    t.string('kind', 10).notNullable(); // send | resend
    t.string('to_email', 320).notNullable();
    t.string('subject', 300).notNullable();
    t.text('html');
    t.text('text');
    t.string('status', 20).notNullable(); // sent | test | failed
    t.string('error', 500);
    t.timestamp('created_at').notNullable();
    t.index(['form_id']);
    t.index(['link_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_log');
  await knex.schema.alterTable('forms', (t) => {
    t.dropColumn('email_subject');
    t.dropColumn('email_message');
  });
  await knex.schema.alterTable('links', (t) => {
    for (const c of ['sent_at', 'send_count', 'last_email_status', 'last_email_error', 'replaced_by', 'replaced_at']) t.dropColumn(c);
  });
};
