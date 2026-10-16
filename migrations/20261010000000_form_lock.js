// Lets a form be temporarily locked (no submissions) without touching its links.
exports.up = async function up(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.timestamp('locked_at'); // null = open
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('forms', (t) => t.dropColumn('locked_at'));
};
