const token = decodeURIComponent(location.pathname.split('/').pop());
const root = document.getElementById('root');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DRAFT_KEY = `stickyforms:draft:${token}`;
const API = `/api/public/${encodeURIComponent(token)}`;

// "Sticky" drafts: answers survive a refresh or closed tab until submitted.
const draft = {
  load() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } },
  save(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  clear() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } },
};

// ---------- Form inputs ----------

function inputFor(f, value) {
  const id = `f_${f.name}`;
  const req = f.required ? 'required' : '';
  const reqCls = f.required ? 'req' : '';
  const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '';
  if (f.type === 'checkbox') {
    return `<label class="check ${reqCls}"><input type="checkbox" id="${id}" name="${f.name}" ${value ? 'checked' : ''} ${req}> ${esc(f.label)}</label>`;
  }
  if (f.type === 'poll') {
    const max = f.maxChoices || 1;
    const multi = max > 1;
    const picked = Array.isArray(value) ? value : [];
    return `<div class="label ${reqCls}" style="font-weight:600;margin:12px 0 4px">${esc(f.label)}</div>
      <div class="choices" data-poll="${f.name}" data-max="${max}" role="${multi ? 'group' : 'radiogroup'}" aria-label="${esc(f.label)}">
        ${f.options.map((o) => `<label class="choice"><input type="${multi ? 'checkbox' : 'radio'}" name="${f.name}" value="${esc(o)}" ${picked.includes(o) ? 'checked' : ''}> <span>${esc(o)}</span></label>`).join('')}
      </div>
      <small class="muted">${multi ? `Choose up to ${max}.` : 'Choose one.'}</small>`;
  }
  if (f.type === 'ranking') {
    const n = f.options.length;
    const ranks = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return `<div class="label ${reqCls}" style="font-weight:600;margin:12px 0 4px">${esc(f.label)}</div>
      <div class="ranking" data-rank="${f.name}">
        ${f.options.map((o) => `<div class="rank-item">
          <select data-item="${esc(o)}" aria-label="Rank for ${esc(o)}">
            <option value="">–</option>${f.options.map((_, i) => `<option value="${i + 1}" ${String(ranks[o]) === String(i + 1) ? 'selected' : ''}>${i + 1}</option>`).join('')}
          </select><span>${esc(o)}</span></div>`).join('')}
      </div>
      <small class="muted">Number the items from 1 (your top choice) to ${n}. Each number can be used once.</small>`;
  }
  let control;
  if (f.type === 'file') {
    const accept = (f.accept || []).join(',');
    const formats = f.accept?.length ? f.accept.map((e) => e.slice(1).toUpperCase()).join(', ') : 'Any file type';
    control = `<input id="${id}" name="${f.name}" type="file" ${accept ? `accept="${esc(accept)}"` : ''} ${req}>
      <small class="muted">${esc(formats)} · up to ${f.maxSizeMB} MB</small>`;
  } else if (f.type === 'textarea') control = `<textarea id="${id}" name="${f.name}" ${req} ${ph}>${esc(value)}</textarea>`;
  else if (f.type === 'select') {
    control = `<select id="${id}" name="${f.name}" ${req}><option value="">Choose…</option>${f.options
      .map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else control = `<input id="${id}" name="${f.name}" type="${f.type}" value="${esc(value)}" ${req} ${ph}>`;
  return `<label for="${id}" class="${reqCls}">${esc(f.label)}</label>${control}`;
}

const BLOCKED = ['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.jar', '.sh', '.dll', '.hta', '.lnk', '.reg', '.cpl'];

// Same rules as the server, checked first so people don't wait for a big upload to be rejected.
function checkFile(f, file) {
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!ext || BLOCKED.includes(ext)) return 'This type of file is not allowed';
  if (f.accept?.length && !f.accept.includes(ext)) return `Allowed formats: ${f.accept.map((e) => e.slice(1).toUpperCase()).join(', ')}`;
  if (file.size > f.maxSizeMB * 1024 * 1024) return `File is too large (max ${f.maxSizeMB} MB)`;
  if (file.size === 0) return 'The file is empty';
  return null;
}

function collect(form, fields) {
  const data = {};
  for (const f of fields) {
    if (f.type === 'file') continue; // files are sent separately and can't be kept in drafts
    if (f.type === 'poll') {
      data[f.name] = [...form.querySelectorAll(`[data-poll="${f.name}"] input:checked`)].map((i) => i.value);
      continue;
    }
    if (f.type === 'ranking') {
      const ranks = {};
      form.querySelectorAll(`[data-rank="${f.name}"] select`).forEach((s) => { ranks[s.dataset.item] = s.value; });
      data[f.name] = ranks;
      continue;
    }
    const el = form.elements[f.name];
    data[f.name] = f.type === 'checkbox' ? el.checked : el.value;
  }
  return data;
}

// Multi-choice polls: once the limit is reached, the other boxes are disabled.
function enforcePollLimits(form) {
  form.querySelectorAll('[data-poll]').forEach((group) => {
    const max = Number(group.dataset.max) || 1;
    if (max <= 1) return;
    const boxes = [...group.querySelectorAll('input')];
    const full = boxes.filter((b) => b.checked).length >= max;
    boxes.forEach((b) => {
      b.disabled = full && !b.checked;
      b.closest('.choice').classList.toggle('disabled', b.disabled);
    });
  });
}

// Rankings: picking a number another item already has swaps the two.
function wireRankings(form, onChange) {
  form.querySelectorAll('[data-rank]').forEach((group) => {
    const selects = [...group.querySelectorAll('select')];
    selects.forEach((sel) => {
      sel.addEventListener('focus', () => { sel.dataset.prev = sel.value; });
      sel.addEventListener('change', () => {
        const other = selects.find((o) => o !== sel && o.value && o.value === sel.value);
        if (other) other.value = sel.dataset.prev || '';
        sel.dataset.prev = sel.value;
        onChange();
      });
    });
  });
}

// ---------- After submitting: read-only view with poll results ----------

const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function pollResultsHtml(a) {
  const mine = Array.isArray(a.value) ? a.value : [];
  const r = a.results;
  return `${r.options.map((o) => {
    const isMine = mine.includes(o.option);
    return `<div class="bar-row ${isMine ? 'mine' : ''}">
      <div class="bar-label"><span>${isMine ? '✓ ' : ''}${esc(o.option)}${isMine ? '<span class="mine-tag">Your choice</span>' : ''}</span>
        <span class="muted">${o.count} vote${o.count === 1 ? '' : 's'} · ${o.percent}%</span></div>
      <div class="bar"><span style="width:${o.percent}%"></span></div></div>`;
  }).join('')}
  <small class="muted">${r.responses} response${r.responses === 1 ? '' : 's'} so far</small>`;
}

function rankingHtml(a) {
  if (!Array.isArray(a.value) || !a.value.length) return '<span class="muted">Not answered</span>';
  const overall = a.results?.options?.filter((o) => o.averageRank != null) || [];
  return `<ol class="rank-results">${a.value.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>
    ${overall.length ? `<small class="muted">Everyone so far: ${overall.map((o, i) => `${i + 1}. ${esc(o.option)}`).join(' · ')}</small>` : ''}`;
}

function answerHtml(a) {
  if (a.type === 'poll') return pollResultsHtml(a);
  if (a.type === 'ranking') return rankingHtml(a);
  if (a.type === 'checkbox') return a.value ? 'Yes' : 'No';
  if (a.value === null || a.value === '' || (Array.isArray(a.value) && !a.value.length)) return '<span class="muted">Not answered</span>';
  if (a.type === 'file') return `📎 ${esc(a.value)}`;
  if (a.type === 'date') {
    const d = new Date(`${a.value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? esc(a.value) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  return `<span style="white-space:pre-wrap">${esc(a.value)}</span>`;
}

// Poster image at the top of the form; click to open it full size.
const posterHtml = (info) => (info.posterUrl
  ? `<a class="poster" href="${esc(info.posterUrl)}" target="_blank" rel="noopener" title="Open full size"><img src="${esc(info.posterUrl)}" alt="${esc(info.title)} poster"></a>` : '');

function renderView(info, { justSubmitted = false } = {}) {
  document.title = info.title;
  const many = info.submissions.length > 1;
  root.innerHTML = `
    ${justSubmitted ? '<p class="success" style="margin-top:0"><b>Thank you! Your response was recorded.</b></p>' : ''}
    ${posterHtml(info)}
    <h2>${esc(info.title)}</h2>
    <p class="muted">${info.recipientName ? `Hi ${esc(info.recipientName)}! ` : ''}${many ? `You've sent ${info.submissions.length} responses. Here they are, newest first.` : "Here's what you submitted."}</p>
    ${info.submissions.map((s, i) => `
      <div class="${many ? 'preview' : ''}" style="${many ? 'margin-top:14px' : ''}">
        <small class="muted">${many ? `Response ${info.submissions.length - i} · ` : ''}Submitted ${esc(fmtDate(s.submittedAt))}</small>
        ${s.answers.map((a) => `<div class="answer"><div class="q">${esc(a.label)}</div>${answerHtml(a)}</div>`).join('')}
      </div>`).join('')}
    ${info.canSubmitAgain ? '<button class="primary" id="again" style="margin-top:18px">Submit another response</button>' : ''}`;
  const again = document.getElementById('again');
  if (again) again.onclick = () => init({ forceForm: true });
}

// ---------- Main ----------

function renderForm(info) {
  document.title = info.title;
  const saved = draft.load();
  root.innerHTML = `
    ${posterHtml(info)}
    <h2>${esc(info.title)}</h2>
    ${info.recipientName ? `<p class="muted">Hi ${esc(info.recipientName)}!</p>` : ''}
    ${info.description ? `<p>${esc(info.description)}</p>` : ''}
    <form id="f" novalidate>
      ${info.fields.map((f) => `<div>${inputFor(f, saved[f.name])}${f.notes ? `<div class="field-note">${esc(f.notes)}</div>` : ''}<div class="error" data-err="${f.name}"></div></div>`).join('')}
      <div id="form-err" class="error"></div>
      <button class="primary" style="margin-top:18px" type="submit">Submit</button>
    </form>`;

  const form = document.getElementById('f');
  const saveDraft = () => draft.save(collect(form, info.fields));
  enforcePollLimits(form);
  wireRankings(form, saveDraft);
  form.addEventListener('change', () => enforcePollLimits(form));
  form.addEventListener('input', saveDraft);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('[data-err]').forEach((el) => (el.textContent = ''));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const fileFields = info.fields.filter((f) => f.type === 'file');
    let clientErr = false;
    for (const f of fileFields) {
      const file = form.elements[f.name].files[0];
      const msg = file ? checkFile(f, file) : (f.required ? 'Please attach a file' : null);
      if (msg) { form.querySelector(`[data-err="${f.name}"]`).textContent = msg; clientErr = true; }
    }
    if (clientErr) {
      document.getElementById('form-err').textContent = 'Please fix the highlighted fields.';
      btn.disabled = false;
      return;
    }
    try {
      let body;
      const headers = {};
      if (fileFields.length) {
        body = new FormData();
        body.append('data', JSON.stringify(collect(form, info.fields)));
        for (const f of fileFields) {
          const file = form.elements[f.name].files[0];
          if (file) body.append(f.name, file, file.name);
        }
        btn.textContent = 'Uploading…';
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ data: collect(form, info.fields) });
      }
      const r = await fetch(API, { method: 'POST', headers, body });
      const out = await r.json().catch(() => ({}));
      if (r.ok) {
        draft.clear();
        const v = await fetch(`${API}/submission`);
        if (v.ok) { renderView(await v.json(), { justSubmitted: true }); window.scrollTo(0, 0); return; }
        root.innerHTML = `<h2 class="success">Submitted</h2><p>${esc(out.message)}</p>`;
        return;
      }
      for (const [name, msg] of Object.entries(out.fields || {})) {
        const el = form.querySelector(`[data-err="${name}"]`);
        if (el) el.textContent = msg;
      }
      document.getElementById('form-err').textContent = out.error || 'Something went wrong.';
    } catch {
      document.getElementById('form-err').textContent = 'Network error, please try again. Your answers are saved.';
    }
    btn.disabled = false;
    btn.textContent = 'Submit';
  });
}

async function init({ forceForm = false } = {}) {
  const res = await fetch(API);
  const info = await res.json().catch(() => ({}));
  if (!res.ok) {
    const heading = info.locked ? 'Temporarily closed' : 'Unavailable';
    root.innerHTML = `<h2>${heading}</h2><p class="muted">${esc(info.error || 'This link is not valid.')}</p>`;
    return;
  }
  if (info.mode === 'view' && !forceForm) return renderView(info);
  renderForm(info);
}

init();
