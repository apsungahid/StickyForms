// The signed-in person's own dashboard data: forms that were sent to their email.
const express = require('express');
const { db, toIso } = require('../db');

const router = express.Router();

// Every personal link whose recipient email matches the signed-in Google account.
router.get('/invitations', async (req, res) => {
  const rows = await db('links')
    .join('forms', 'forms.id', 'links.form_id')
    .leftJoin('users as owner', 'owner.id', 'forms.owner_id')
    .whereRaw('lower(links.recipient_email) = ?', [req.user.email])
    .whereNull('links.replaced_by') // only the newest link if it was resent
    .select(
      'links.token', 'links.expires_at', 'links.max_submissions', 'links.submission_count', 'links.created_at', 'links.sent_at',
      'forms.title', 'forms.description', 'forms.locked_at', 'owner.name as owner_name', 'owner.email as owner_email',
    )
    .orderBy('links.created_at', 'desc');

  const now = Date.now();
  res.json(rows.map((r) => {
    const expired = r.expires_at && new Date(r.expires_at).getTime() < now;
    const usedUp = r.max_submissions != null && r.submission_count >= r.max_submissions;
    let status = 'open';
    if (r.submission_count > 0 && (usedUp || expired || r.locked_at)) status = 'submitted';
    else if (expired) status = 'expired';
    else if (r.locked_at) status = 'closed';
    else if (r.submission_count > 0) status = 'submitted-can-add'; // unlimited link already used at least once
    return {
      title: r.title,
      description: r.description,
      from: r.owner_name || r.owner_email || null,
      url: `/f/${r.token}`,
      status,
      submitted: r.submission_count > 0,
      expiresAt: toIso(r.expires_at),
      receivedAt: toIso(r.sent_at || r.created_at),
    };
  }));
});

module.exports = router;
