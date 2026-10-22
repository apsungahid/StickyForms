// Optional poster image shown at the top of a form.
exports.up = async function up(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.string('poster_path', 500); // relative to UPLOAD_DIR; null = no poster
    t.string('poster_type', 50); // image/jpeg, image/png, image/gif, image/webp
    t.timestamp('poster_updated_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.dropColumn('poster_path');
    t.dropColumn('poster_type');
    t.dropColumn('poster_updated_at');
  });
};
