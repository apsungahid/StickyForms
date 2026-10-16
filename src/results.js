// Tallies poll votes and ranking positions across all submissions of a form.
const { parseJson } = require('./db');

/**
 * @param fields  the form's field definitions
 * @param rows    submission rows (with a `data` column, JSON string or object)
 * @returns { [fieldName]: PollResult | RankingResult }
 *   PollResult    { type:'poll', label, maxChoices, responses, options:[{ option, count, percent }] }
 *   RankingResult { type:'ranking', label, responses, options:[{ option, averageRank, firstPlace }] } (best first)
 */
function tally(fields, rows) {
  const out = {};
  const datas = rows.map((r) => (typeof r.data === 'string' ? parseJson(r.data, {}) : r.data || {}));

  for (const f of fields) {
    if (f.type === 'poll') {
      const counts = Object.fromEntries(f.options.map((o) => [o, 0]));
      let responses = 0;
      for (const d of datas) {
        const picked = Array.isArray(d[f.name]) ? d[f.name] : [];
        if (!picked.length) continue;
        responses++;
        for (const p of picked) if (p in counts) counts[p]++;
      }
      out[f.name] = {
        type: 'poll',
        label: f.label,
        maxChoices: f.maxChoices || 1,
        responses,
        options: f.options.map((o) => ({ option: o, count: counts[o], percent: responses ? Math.round((counts[o] / responses) * 100) : 0 })),
      };
    }

    if (f.type === 'ranking') {
      const sum = Object.fromEntries(f.options.map((o) => [o, 0]));
      const first = Object.fromEntries(f.options.map((o) => [o, 0]));
      let responses = 0;
      for (const d of datas) {
        const order = Array.isArray(d[f.name]) ? d[f.name] : null;
        if (!order?.length) continue;
        responses++;
        order.forEach((o, i) => { if (o in sum) sum[o] += i + 1; });
        if (order[0] in first) first[order[0]]++;
      }
      out[f.name] = {
        type: 'ranking',
        label: f.label,
        responses,
        options: f.options
          .map((o) => ({ option: o, averageRank: responses ? Math.round((sum[o] / responses) * 10) / 10 : null, firstPlace: first[o] }))
          .sort((a, b) => (a.averageRank ?? 99) - (b.averageRank ?? 99)),
      };
    }
  }
  return out;
}

// Plain-text version of an answer, for tables and spreadsheets.
function answerText(field, v) {
  if (v === null || v === undefined || v === '') return '';
  if (field?.type === 'poll') return Array.isArray(v) ? v.join('; ') : String(v);
  if (field?.type === 'ranking') return Array.isArray(v) ? v.map((o, i) => `${i + 1}. ${o}`).join('; ') : '';
  if (field?.type === 'checkbox') return v ? 'Yes' : 'No';
  if (field?.type === 'file') return v?.name || '';
  return String(v);
}

module.exports = { tally, answerText };
