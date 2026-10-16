// Files uploaded through "file" fields. The bytes live on disk (UPLOAD_DIR); this table holds the metadata.

exports.up = async function up(knex) {
  await knex.schema.createTable('files', (t) => {
    t.string('id', 36).primary();
    t.string('form_id', 36).notNullable().references('id').inTable('forms').onDelete('CASCADE');
    t.string('submission_id', 36).notNullable().references('id').inTable('submissions').onDelete('CASCADE');
    t.string('field_name', 64).notNullable();
    t.string('original_name', 255).notNullable();
    t.string('stored_path', 500).notNullable(); // relative to UPLOAD_DIR
    t.string('mime_type', 200);
    t.bigInteger('size_bytes').notNullable();
    t.timestamp('created_at').notNullable();
    t.index(['submission_id']);
    t.index(['form_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('files');
};
