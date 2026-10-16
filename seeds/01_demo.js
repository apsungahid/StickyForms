// Demo data so there is something to click on right after setup.
// Open http://localhost:3000/f/demo-token to fill in the demo form.
const { randomUUID } = require('crypto');

exports.seed = async function seed(knex) {
  await knex('submissions').del();
  await knex('links').del();
  await knex('forms').del();

  const now = new Date().toISOString();
  const formId = randomUUID();

  // Give the demo form to the first signed-in account, if there is one (otherwise the first sign-in claims it).
  const firstUser = await knex('users').orderBy('created_at').first('id').catch(() => null);
  await knex('forms').insert({
    owner_id: firstUser ? firstUser.id : null,
    id: formId,
    title: 'Client Onboarding',
    description: 'A quick demo form. Tell us a bit about yourself.',
    fields: JSON.stringify([
      { name: 'full_name', label: 'Full name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'company_size', label: 'Company size', type: 'select', required: false, options: ['1-10', '11-50', '51-200', '200+'] },
      { name: 'start_date', label: 'Preferred start date', type: 'date', required: false },
      { name: 'notes', label: 'Anything else?', type: 'textarea', required: false },
      { name: 'agree', label: 'I agree to be contacted', type: 'checkbox', required: true },
    ]),
    created_at: now,
    updated_at: now,
  });

  await knex('links').insert({
    id: randomUUID(),
    form_id: formId,
    token: 'demo-token',
    recipient_name: 'Demo recipient',
    recipient_email: null,
    max_submissions: null, // unlimited so the demo link keeps working
    submission_count: 0,
    expires_at: null,
    created_at: now,
  });
};
