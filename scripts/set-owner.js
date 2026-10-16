// Gives every existing form to one account (by email).
//   npm run set-owner -- someone@gmail.com
// If that person hasn't signed in yet, their account is created now and is linked to
// their Google login the first time they sign in with that email.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const { db } = require('../src/db');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: npm run set-owner -- someone@gmail.com');
    process.exitCode = 1;
    return;
  }
  await db.migrate.latest();
  const result = await db.transaction(async (trx) => {
    let user = await trx('users').where({ email }).first();
    const created = !user;
    if (!user) {
      user = { id: crypto.randomUUID(), google_sub: null, email, name: null, picture: null, created_at: new Date().toISOString(), last_login_at: null };
      await trx('users').insert(user);
    }
    // Titles must be unique per account: rename a moved form if this account already has that title.
    const taken = new Set((await trx('forms').where({ owner_id: user.id }).pluck('title')).map((t) => t.toLowerCase()));
    const others = await trx('forms').where((q) => q.whereNull('owner_id').orWhereNot('owner_id', user.id)).orderBy('created_at').select('id', 'title');
    const renamed = [];
    for (const f of others) {
      let title = f.title;
      for (let n = 2; taken.has(title.toLowerCase()); n++) title = `${f.title} (${n})`;
      taken.add(title.toLowerCase());
      if (title !== f.title) renamed.push(`"${f.title}" → "${title}"`);
      await trx('forms').where({ id: f.id }).update({ owner_id: user.id, title });
    }
    const total = await trx('forms').where({ owner_id: user.id }).count({ n: '*' }).first();
    return { created, moved: others.length, total: Number(total.n), renamed };
  });
  console.log(`${result.created ? 'Created account' : 'Found account'} ${email}.`);
  console.log(`Moved ${result.moved} form(s); ${email} now owns ${result.total} form(s).`);
  if (result.renamed.length) console.log(`Renamed to keep titles unique: ${result.renamed.join(', ')}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => db.destroy());
