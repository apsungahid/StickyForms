// Forms still using the old built-in email wording switch to the new default (stored as null = "use default").
// Wording someone customised is left alone.
const OLD_SUBJECT = 'Your personal link: {form}';
const OLD_MESSAGE = [
  'Hi {name},',
  '',
  'You have been invited to fill in "{form}". Please use your personal link below. It is unique to you, so please don\'t forward it.',
  '',
  'Thank you!',
].join('\n');

exports.up = async function up(knex) {
  await knex('forms').where({ email_subject: OLD_SUBJECT }).update({ email_subject: null });
  await knex('forms').where({ email_message: OLD_MESSAGE }).update({ email_message: null });
};

exports.down = async function down() {};
