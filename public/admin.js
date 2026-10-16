const TYPES = [
  ['text', 'Short text'], ['textarea', 'Long text (paragraph)'], ['email', 'Email'], ['number', 'Number'],
  ['date', 'Date'], ['select', 'Dropdown'], ['checkbox', 'Checkbox'], ['file', 'File upload'],
  ['poll', 'Poll'], ['ranking', 'Ranking'],
];
const FORMAT_GROUPS = [
  ['Documents', ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt']],
  ['Spreadsheets', ['.xls', '.xlsx', '.csv', '.ods']],
  ['Presentations', ['.ppt', '.pptx', '.odp']],
  ['Images', ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic']],
  ['Archives', ['.zip']],
];
let serverSettings = { maxUploadMb: 25 };
fetch('/api/settings').then((r) => r.json()).then((s) => (serverSettings = s)).catch(() => {});
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let currentId = null;
// Remembered while you move between forms, so a batch can share one expiry date.
const linkSettings = { expiresOn: '', max: '1' };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function humanize(name) {
  const t = String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

// One floating preview, shown while hovering a thumbnail.
const imgPop = document.createElement('div');
imgPop.className = 'img-pop';
imgPop.innerHTML = '<img alt="">';
document.body.appendChild(imgPop);
function placePop(thumb) {
  const r = thumb.getBoundingClientRect();
  const w = imgPop.offsetWidth;
  const h = imgPop.offsetHeight;
  let left = r.right + 12;
  if (left + w > window.innerWidth - 8) left = r.left - w - 12; // not enough room on the right
  if (left < 8) left = Math.max(8, (window.innerWidth - w) / 2);
  const top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), window.innerHeight - h - 8);
  imgPop.style.left = `${left}px`;
  imgPop.style.top = `${Math.max(8, top)}px`;
}
document.addEventListener('mouseover', (e) => {
  const thumb = e.target.closest?.('a.thumb');
  if (!thumb) return;
  const img = imgPop.querySelector('img');
  img.onload = () => placePop(thumb);
  img.src = thumb.querySelector('img').src;
  imgPop.classList.add('show');
  placePop(thumb);
});
document.addEventListener('mouseout', (e) => {
  const thumb = e.target.closest?.('a.thumb');
  if (thumb && !thumb.contains(e.relatedTarget)) imgPop.classList.remove('show');
});
window.addEventListener('scroll', () => imgPop.classList.remove('show'), true);

function fmtAnswer(field, v) {
  if (field.type === 'checkbox') return v ? 'Yes' : 'No';
  if (field.type === 'poll') return Array.isArray(v) && v.length ? v.map(esc).join('<br>') : '<span class="muted">—</span>';
  if (field.type === 'ranking') return Array.isArray(v) && v.length ? `<ol class="rank-ol">${v.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>` : '<span class="muted">—</span>';
  if (field.type === 'file') {
    if (!v?.fileId) return '<span class="muted">—</span>';
    const url = `/api/forms/${currentId}/files/${v.fileId}`;
    if (IMAGE_RE.test(v.name)) {
      // Thumbnail; hover shows a larger preview, click opens the full image in a new tab.
      return `<a class="thumb" href="${url}?view=1" target="_blank" rel="noopener" title="Open ${esc(v.name)} in a new tab"><img src="${url}?view=1" alt="${esc(v.name)}" loading="lazy"></a><div class="thumb-meta"><span title="${esc(v.name)}">${esc(v.name)}</span> · ${fmtSize(v.size)} · <a href="${url}" download title="Download">Download</a></div>`;
    }
    return `<a href="${url}" download>📎 ${esc(v.name)}</a><br><small class="muted">${fmtSize(v.size)}</small>`;
  }
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (field.type === 'date') {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return esc(v);
}
// Bars for a poll, average positions for a ranking.
function resultBlock(r) {
  if (r.type === 'poll') {
    return `<div class="result"><div class="result-q">${esc(r.label)}</div>
      ${r.options.map((o) => `<div class="bar-row"><div class="bar-label"><span>${esc(o.option)}</span><span class="muted">${o.count} · ${o.percent}%</span></div>
        <div class="bar"><span style="width:${o.percent}%"></span></div></div>`).join('')}
      <small class="muted">${r.responses} response${r.responses === 1 ? '' : 's'}${r.maxChoices > 1 ? ` · up to ${r.maxChoices} choices each` : ''}</small></div>`;
  }
  return `<div class="result"><div class="result-q">${esc(r.label)} <span class="muted" style="font-weight:400">(ranking)</span></div>
    <ol class="rank-results">${r.options.map((o) => `<li><span>${esc(o.option)}</span><span class="muted">${o.averageRank == null ? '—' : `avg. ${o.averageRank}`}${o.firstPlace ? ` · ${o.firstPlace}× #1` : ''}</span></li>`).join('')}</ol>
    <small class="muted">${r.responses} response${r.responses === 1 ? '' : 's'} · ordered by average position (1 = best)</small></div>`;
}

function fmtExpiry(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return d.getTime() < Date.now() ? `${label} <span class="error">(expired)</span>` : label;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 401) { location.href = '/login'; throw new Error('Please sign in'); } // session ended
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { details: data.details });
  return data;
}

let formsCache = [];
let builderDirty = false; // the builder has unsaved typing
$('#detail').addEventListener('input', () => { if ($('#b-save')) builderDirty = true; });
let formSearch = '';

// Newest first (the server already sorts by creation date); the search box only filters.
async function loadList() {
  formsCache = await api('/api/forms');
  renderFormList();
}

function renderFormList() {
  const forms = formsCache;
  const ul = $('#form-list');
  const info = $('#form-search-info') || { textContent: '' };
  const words = formSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? forms.filter((f) => { const hay = `${f.title} ${f.description || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    : forms;
  info.textContent = words.length ? `${shown.length} of ${forms.length} form${forms.length === 1 ? '' : 's'}` : '';
  if (!forms.length) { ul.innerHTML = '<li class="muted">No forms yet.</li>'; return; }
  if (!shown.length) { ul.innerHTML = `<li class="muted">No forms match “${esc(formSearch.trim())}”.</li>`; return; }
  const mark = (text) => {
    let out = esc(text);
    for (const w of words) out = out.replace(new RegExp(`(${esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
    return out;
  };
  ul.innerHTML = shown.map((f) => `
    <li data-id="${f.id}" class="${f.id === currentId ? 'active' : ''}">
      <div class="li-main">
        <span>${mark(f.title)} ${f.locked ? '<span class="badge bad" title="Locked: not accepting submissions">🔒 Locked</span>' : ''}</span>
        <small>${f.submissionCount} submissions · ${f.linkCount} links · ${esc(new Date(f.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</small>
      </div>
      <button class="kebab" data-menu="${f.id}" aria-label="More actions for ${esc(f.title)}" title="More actions">⋮</button>
    </li>`).join('');
  ul.querySelectorAll('li[data-id]').forEach((li) => li.onclick = () => showForm(li.dataset.id));
  ul.querySelectorAll('[data-menu]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    openFormMenu(b, forms.find((f) => f.id === b.dataset.menu));
  });
}

// Guarded so an outdated index.html (without the search box) can never stop the list from loading.
const formSearchEl = $('#form-search');
if (formSearchEl) {
  formSearchEl.addEventListener('input', (e) => { formSearch = e.target.value; renderFormList(); });
  formSearchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; formSearch = ''; renderFormList(); }
    if (e.key === 'Enter') { const first = $('#form-list li[data-id]'); if (first) showForm(first.dataset.id); }
  });
}

// ---------- Form actions (⋮ menu) ----------
function closeMenu() { document.querySelector('.menu')?.remove(); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

function openFormMenu(anchor, form) {
  const wasOpen = document.querySelector(`.menu[data-for="${form.id}"]`);
  closeMenu();
  if (wasOpen) return;
  const m = document.createElement('div');
  m.className = 'menu';
  m.dataset.for = form.id;
  m.setAttribute('role', 'menu');
  const items = [
    ['edit', 'Edit questions'],
    ['duplicate', 'Duplicate…'],
    form.locked ? ['unlock', '🔓 Unlock form'] : ['lock', '🔒 Lock form'],
    ['delete', 'Delete…', 'danger'],
  ];
  m.innerHTML = items.map(([a, t, cls]) => `<button role="menuitem" data-act="${a}" class="${cls || ''}">${t}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8);
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${Math.max(8, left + window.scrollX)}px`;
  m.querySelector('button').focus();
  m.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    if (act === 'edit') { currentId = form.id; showBuilder(await api(`/api/forms/${form.id}`)); loadList(); }
    if (act === 'duplicate') duplicateDialog(form);
    if (act === 'lock') lockDialog(form);
    if (act === 'unlock') setLocked(form, false);
    if (act === 'delete') deleteForm(form);
  };
}

// Small reusable modal built on <dialog>.
function modal(html, onReady) {
  const d = document.createElement('dialog');
  d.className = 'modal';
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => d.close());
  d.showModal();
  onReady?.(d);
  return d;
}

function suggestCopyTitle(title) {
  const taken = new Set(formsCache.map((f) => f.title.toLowerCase()));
  let t = `${title} (copy)`;
  for (let n = 2; taken.has(t.toLowerCase()); n++) t = `${title} (copy ${n})`;
  return t;
}

function duplicateDialog(form) {
  modal(`
    <form method="dialog" class="modal-body">
      <h2>Duplicate form</h2>
      <p class="muted" style="margin-top:0">Copies all questions and the email template of <b>${esc(form.title)}</b>. No recipients, links or submissions are copied.</p>
      <label for="dup-title">New title</label>
      <input id="dup-title" maxlength="200" required value="${esc(suggestCopyTitle(form.title))}">
      <label for="dup-desc">Description</label>
      <textarea id="dup-desc" rows="3">${esc(form.description)}</textarea>
      <div id="dup-err" class="error"></div>
      <div class="row" style="justify-content:flex-end;margin-top:16px">
        <button type="button" data-close>Cancel</button>
        <button type="submit" class="primary" id="dup-go">Create copy</button>
      </div>
    </form>`, (d) => {
    const title = d.querySelector('#dup-title');
    title.select();
    const taken = () => formsCache.some((f) => f.title.toLowerCase() === title.value.trim().toLowerCase());
    title.oninput = () => { d.querySelector('#dup-err').textContent = taken() ? 'A form with this title already exists.' : ''; };
    d.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      if (!title.value.trim()) { d.querySelector('#dup-err').textContent = 'Please enter a title.'; return; }
      if (taken()) { d.querySelector('#dup-err').textContent = 'A form with this title already exists.'; return; }
      const btn = d.querySelector('#dup-go');
      btn.disabled = true;
      try {
        const copy = await api(`/api/forms/${form.id}/duplicate`, { method: 'POST', body: { title: title.value, description: d.querySelector('#dup-desc').value } });
        d.close();
        await showForm(copy.id);
      } catch (err) {
        d.querySelector('#dup-err').textContent = err.details?.[0] || err.message;
        btn.disabled = false;
      }
    };
  });
}

function lockDialog(form) {
  modal(`
    <div class="modal-body">
      <h2>Lock “${esc(form.title)}”?</h2>
      <p>While the form is locked, nobody can submit it. Anyone who opens their link sees that the form is temporarily closed.</p>
      <p class="muted">Links, submissions and expiry dates are not changed. When you unlock, every link that hasn't expired or been used up works again.</p>
      <div class="row" style="justify-content:flex-end;margin-top:16px">
        <button data-close>Cancel</button>
        <button class="primary" id="lock-go">Lock form</button>
      </div>
    </div>`, (d) => {
    d.querySelector('#lock-go').onclick = async () => { d.close(); await setLocked(form, true); };
  });
}

async function setLocked(form, locked) {
  try {
    await api(`/api/forms/${form.id}/${locked ? 'lock' : 'unlock'}`, { method: 'POST' });
    if (currentId === form.id) await showForm(form.id); else await loadList();
  } catch (e) { alert(e.message); }
}

async function deleteForm(form) {
  if (!confirm(`Delete "${form.title}" and all its links, submissions and uploaded files? This cannot be undone.`)) return;
  await api(`/api/forms/${form.id}`, { method: 'DELETE' });
  if (currentId === form.id) {
    currentId = null;
    await loadList();
    showMineDetail('Form deleted.');
    return;
  }
  loadList();
}

// ---------- Builder ----------
const slug = (t) => t.toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').trim().replace(/\s+/g, '_').replace(/^[^a-z]+/, '').slice(0, 64);

function fileSettingsHtml(f) {
  const accept = new Set(f.accept || []);
  const groupChecked = (exts) => exts.every((e) => accept.has(e));
  const inGroups = new Set(FORMAT_GROUPS.filter(([, exts]) => groupChecked(exts)).flatMap(([, exts]) => exts));
  const other = [...accept].filter((e) => !inGroups.has(e)).join(', ');
  return `
    <div class="sub-label">File upload settings</div>
    <div class="row" style="align-items:flex-start;gap:20px">
      <label class="inline">Max file size (MB)
        <input type="number" class="f-size" min="0.1" step="0.1" max="${serverSettings.maxUploadMb}" value="${esc(f.maxSizeMB ?? Math.min(10, serverSettings.maxUploadMb))}" style="width:110px;min-width:0">
        <small class="muted">Up to ${serverSettings.maxUploadMb} MB</small>
      </label>
      <div style="flex:1;min-width:240px">
        <div class="inline-title">Allowed formats</div>
        <div class="formats">
          ${FORMAT_GROUPS.map(([name, exts]) => `<label class="fmt"><input type="checkbox" class="f-fmt" data-exts="${exts.join(',')}" ${groupChecked(exts) ? 'checked' : ''}>
            <span><b>${name}</b> <small class="muted">${exts.map((e) => e.slice(1).toUpperCase()).join(', ')}</small></span></label>`).join('')}
        </div>
        <div class="inline-title" style="margin-top:10px">Other extensions</div>
        <input class="f-other" placeholder="e.g. .dwg, .mp4" value="${esc(other)}">
        <small class="muted">Nothing selected = any file type. Programs (.exe, .bat, .js…) are always blocked.</small>
      </div>
    </div>`;
}

function fieldRow(f = { name: '', label: '', type: 'text', required: false }) {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.innerHTML = `
    <select class="f-order" aria-label="Order" title="Position of this field in the form"></select>
    <input placeholder="e.g. company_name" class="f-name" value="${esc(f.name)}" aria-label="Field name">
    <input placeholder="e.g. Company name" class="f-label" value="${esc(f.label)}" aria-label="Display name">
    <select class="f-type" aria-label="Type">${TYPES.map(([v, t]) => `<option value="${v}" ${v === f.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <input placeholder="Optional short guide" class="f-notes" value="${esc(f.notes)}" maxlength="500" aria-label="Notes">
    <label class="req-cell"><input type="checkbox" class="f-req" ${f.required ? 'checked' : ''} aria-label="Required"><span class="mobile-only">Required</span></label>
    <button type="button" class="danger f-del" title="Remove field">✕</button>
    <div class="extra f-opts-wrap"><div class="sub-label">Dropdown choices</div><input placeholder="Separate choices with commas, e.g. Small, Medium, Large" class="f-opts" value="${esc((f.options || []).join(', '))}"></div>
    <div class="extra f-file">${fileSettingsHtml(f)}</div>
    <div class="extra f-choices">
      <div class="row" style="align-items:flex-start;gap:20px">
        <div style="flex:1;min-width:240px">
          <div class="sub-label f-choices-title">Choices</div>
          <textarea class="f-items" rows="4" placeholder="One per line">${esc((['poll', 'ranking'].includes(f.type) ? f.options || [] : []).join('\n'))}</textarea>
          <small class="muted f-items-hint"></small>
        </div>
        <label class="inline f-max-wrap">How many can they choose?
          <input type="number" class="f-max" min="1" value="${esc(f.maxChoices || 1)}" style="width:110px;min-width:0">
          <small class="muted f-max-hint"></small>
        </label>
      </div>
    </div>`;
  const sync = () => {
    const t = $('.f-type', div).value;
    $('.f-opts-wrap', div).style.display = t === 'select' ? '' : 'none';
    $('.f-file', div).style.display = t === 'file' ? '' : 'none';
    $('.f-choices', div).style.display = t === 'poll' || t === 'ranking' ? '' : 'none';
    $('.f-max-wrap', div).style.display = t === 'poll' ? '' : 'none';
    $('.f-choices-title', div).textContent = t === 'ranking' ? 'Items to rank (one per line)' : 'Poll choices (one per line)';
    const n = $('.f-items', div).value.split('\n').map((x) => x.trim()).filter(Boolean).length;
    $('.f-items-hint', div).textContent = t === 'ranking'
      ? `People number these from 1 to ${n || 'n'} (1 = top choice).`
      : `${n} choice${n === 1 ? '' : 's'}`;
    const max = Number($('.f-max', div).value) || 1;
    $('.f-max-hint', div).textContent = max <= 1 ? 'Single choice (radio buttons)' : `Up to ${max} (checkboxes)`;
  };
  $('.f-items', div).oninput = sync;
  $('.f-max', div).oninput = sync;
  $('.f-type', div).onchange = sync; sync();
  $('.f-del', div).onclick = () => { const wrap = div.parentElement; div.remove(); renumberFields(wrap); };
  // Order dropdown: choosing a number moves this field to that position.
  $('.f-order', div).onchange = (e) => {
    const wrap = div.parentElement;
    const others = [...wrap.children].filter((r) => r !== div);
    wrap.insertBefore(div, others[Number(e.target.value) - 1] || null);
    renumberFields(wrap);
    div.classList.remove('moved'); void div.offsetWidth; div.classList.add('moved');
    $('.f-order', div).focus();
  };
  // Fill the field name from the display name until the user edits it themselves.
  const nameEl = $('.f-name', div);
  let autoName = !f.name;
  nameEl.oninput = () => { autoName = !nameEl.value; };
  $('.f-label', div).oninput = (e) => { if (autoName) nameEl.value = slug(e.target.value); };
  return div;
}

function renumberFields(wrap) {
  const rows = [...wrap.children];
  rows.forEach((r, i) => {
    $('.f-order', r).innerHTML = rows.map((_, j) => `<option value="${j + 1}" ${j === i ? 'selected' : ''}>${j + 1}</option>`).join('');
  });
}

function readField(r) {
  const field = {
    name: $('.f-name', r).value,
    label: $('.f-label', r).value,
    type: $('.f-type', r).value,
    required: $('.f-req', r).checked,
    notes: $('.f-notes', r).value,
  };
  if (field.type === 'select') field.options = $('.f-opts', r).value.split(',').map((x) => x.trim()).filter(Boolean);
  if (field.type === 'poll' || field.type === 'ranking') field.options = $('.f-items', r).value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (field.type === 'poll') field.maxChoices = Number($('.f-max', r).value) || 1;
  if (field.type === 'file') {
    field.maxSizeMB = $('.f-size', r).value;
    field.accept = [
      ...[...r.querySelectorAll('.f-fmt:checked')].flatMap((c) => c.dataset.exts.split(',')),
      ...$('.f-other', r).value.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean),
    ];
  }
  return field;
}

function showBuilder(form) {
  const editing = Boolean(form);
  builderDirty = false;
  $('#detail').innerHTML = `
    <div class="card">
      <h2>${editing ? 'Edit form' : 'New form'}</h2>
      <label>Title</label><input id="b-title" value="${esc(form?.title)}">
      <label>Description</label><textarea id="b-desc">${esc(form?.description)}</textarea>
      <h3>Fields</h3>
      <div class="field-head">
        <span title="Order of the field in the form">#</span>
        <span>Field name <small class="muted" title="Internal ID used in exports. Letters, numbers and _ only.">ⓘ</small></span>
        <span>Display name <small class="muted" title="The question your recipients see.">ⓘ</small></span>
        <span>Type</span>
        <span>Notes <small class="muted" title="Short guide shown under the field, in small italic text, while people fill in the form.">ⓘ</small></span>
        <span>Required</span><span></span>
      </div>
      <div id="b-fields"></div>
      <div class="row"><button id="b-add">+ Add field</button></div>
      <div id="b-err" class="error"></div>
      <div class="row" style="margin-top:16px">
        <button class="primary" id="b-save">${editing ? 'Save changes' : 'Create form'}</button>
        <button id="b-cancel">Cancel</button>
      </div>
    </div>`;
  const wrap = $('#b-fields');
  (form?.fields?.length ? form.fields : [undefined]).forEach((f) => wrap.appendChild(fieldRow(f)));
  renumberFields(wrap);
  $('#b-add').onclick = () => { wrap.appendChild(fieldRow()); renumberFields(wrap); };
  $('#b-cancel').onclick = () => { builderDirty = false; if (editing) showForm(form.id); else { currentId = null; showMineDetail(); } };
  $('#b-save').onclick = async () => {
    const body = {
      title: $('#b-title').value,
      description: $('#b-desc').value,
      fields: [...wrap.children].map(readField),
    };
    try {
      const saved = editing ? await api(`/api/forms/${form.id}`, { method: 'PUT', body }) : await api('/api/forms', { method: 'POST', body });
      builderDirty = false;
      await showForm(saved.id);
    } catch (e) {
      $('#b-err').innerHTML = esc(e.message) + (e.details ? '<br>' + e.details.map(esc).join('<br>') : '');
    }
  };
}

// ---------- Detail ----------
async function showForm(id) {
  currentId = id;
  builderDirty = false;
  const [form, links, subs, tpl, results] = await Promise.all([
    api(`/api/forms/${id}`), api(`/api/forms/${id}/links`), api(`/api/forms/${id}/submissions`), api(`/api/forms/${id}/email-template`),
    api(`/api/forms/${id}/results`),
  ]);
  const resultList = Object.values(results);
  loadList();
  $('#detail').innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${esc(form.title)} ${form.locked ? '<span class="badge bad">🔒 Locked</span>' : ''}</h2>
        <div class="row"><button id="d-edit">Edit</button><button class="kebab" id="d-menu" aria-label="More actions" title="More actions">⋮</button></div>
      </div>
      <p class="muted">${esc(form.description) || 'No description'} · ${form.fields.length} fields</p>
      ${form.locked ? `<div class="notice warn row" style="justify-content:space-between">
        <span><b>This form is locked</b> since ${esc(fmtDateTime(form.lockedAt))}. Recipients see that it's temporarily closed and can't submit.</span>
        <button class="primary" id="d-unlock">Unlock form</button>
      </div>` : ''}
    </div>
    <div class="card send-card ${sendLinksOpen() ? '' : 'collapsed'}">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">Send personal links</h2>
        <button type="button" class="toggle-btn" id="send-toggle" aria-expanded="${sendLinksOpen()}" aria-controls="send-body">
          <span class="chev" aria-hidden="true">▾</span> <span class="toggle-label">${sendLinksOpen() ? 'Hide' : 'Show'}</span>
        </button>
      </div>
      <div id="send-body" ${sendLinksOpen() ? '' : 'hidden'}>
      <h3>Link settings <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· used for new links below and for resends</span></h3>
      <div class="row">
        <label class="inline">Expires on
          <input id="l-exp" type="date" min="${todayStr()}" value="${esc(linkSettings.expiresOn)}">
        </label>
        <label class="inline">Max submissions per link
          <input id="l-max" type="number" min="0" value="${esc(linkSettings.max)}" style="width:90px">
        </label>
      </div>
      <p class="muted" style="font-size:13px;margin:6px 0 0">Links work until the end of the expiry date. Leave the date blank for no expiry. Max submissions 0 = unlimited.</p>

      <h3>Upload a spreadsheet</h3>
      <div class="dropzone" id="u-drop">
        <input type="file" id="u-file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
        <div><strong>Choose an Excel (.xlsx) or CSV file</strong>, or drop it here</div>
        <div class="muted" style="font-size:13px">Needs a <b>Name</b> column and an <b>Email</b> column. <a href="/recipients-template.csv" download>Download a template</a></div>
      </div>
      <div id="u-preview"></div>

      <h3>Or add one person</h3>
      <div class="row">
        <input id="l-name" placeholder="Recipient name" style="flex:1;min-width:140px">
        <input id="l-email" type="email" placeholder="Recipient email" style="flex:1;min-width:160px">
        <button class="primary" id="l-create">Create link</button>
      </div>
      </div>
    </div>
    <div class="card tabs-card">
      <div class="tabs" role="tablist" aria-label="Form data">
        ${tabsFor(resultList.length).map(([key, label]) => `<button role="tab" class="tab" id="tab-${key}" data-tab="${key}" aria-controls="panel-${key}">
          ${label}${key === 'results' ? '' : ` <span class="tab-count">${key === 'recipients' ? links.length : subs.length}</span>`}</button>`).join('')}
      </div>
    <div class="tab-panel" id="panel-recipients" role="tabpanel" aria-labelledby="tab-recipients">
    <div id="links-card">
      <div class="row" style="justify-content:space-between">
        <span class="muted">${links.length ? `${links.filter((l) => l.submissionCount > 0).length} of ${links.length} have submitted` : 'Add recipients above to get started.'}</span>
        ${links.length ? `<a class="btn" href="/api/forms/${id}/links.csv" download>Download links (CSV)</a>` : ''}
      </div>
      ${tpl.testMode ? `<div class="notice">Test mode: emails are saved to the <b>data\\outbox</b> folder and can be previewed here, but nothing is actually sent. Add your SMTP settings to <b>.env</b> to send real emails.</div>` : ''}
      ${tpl.baseUrlIsLocal ? `<div class="notice warn">Links point to <b>${esc(tpl.baseUrl)}</b>, which only works on this computer. Set <b>PUBLIC_BASE_URL</b> in .env before emailing real recipients.</div>` : ''}
      <div class="toolbar">
        <input type="search" id="l-search" placeholder="Search name or email…" value="${esc(linkView.search)}">
        <select id="l-filter" aria-label="Filter by status">
          ${LINK_FILTERS.map(([v, t]) => `<option value="${v}" ${v === linkView.filter ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap"><table class="links">
        <thead><tr>
          <th class="chk"><input type="checkbox" id="l-all" aria-label="Select all"></th>
          <th>Recipient</th><th>Link</th><th>Status</th><th>Used</th><th>Expires</th><th></th>
        </tr></thead>
        <tbody id="l-rows"></tbody>
      </table></div>
      <div class="action-bar">
        <span id="l-count" class="muted">0 selected</span>
        <div class="row">
          <button class="primary" id="a-send" disabled>Send email</button>
          <button id="a-resend" disabled title="Creates a new link for each selected person, deactivates their old link, and emails the new one">Resend email (new link)</button>
          <button class="danger" id="a-remove" disabled title="Remove the selected recipients and their links">Remove</button>
        </div>
      </div>
      <div id="compose"></div>
    </div>
    </div>
    ${resultList.length ? `<div class="tab-panel" id="panel-results" role="tabpanel" aria-labelledby="tab-results">
      <p class="muted" style="margin-top:0">Live totals from ${subs.length} submission${subs.length === 1 ? '' : 's'}.</p>
      <div class="results-grid">${resultList.map((r) => resultBlock(r)).join('')}</div>
    </div>` : ''}
    <div class="tab-panel" id="panel-submissions" role="tabpanel" aria-labelledby="tab-submissions">
      <div class="table-wrap"><table class="subs">
        <tr><th>Submitted</th><th>Recipient</th>${form.fields.map((f) => `<th>${esc(f.label || humanize(f.name))}</th>`).join('')}</tr>
        ${subs.map((s) => `<tr>
          <td style="white-space:nowrap">${fmtDateTime(s.submittedAt)}</td>
          <td>${esc(s.recipientName || '—')}${s.recipientEmail ? `<br><small class="muted">${esc(s.recipientEmail)}</small>` : ''}</td>
          ${form.fields.map((f) => `<td>${fmtAnswer(f, s.data[f.name])}</td>`).join('')}
        </tr>`).join('') || `<tr><td colspan="${form.fields.length + 2}" class="muted">No submissions yet.</td></tr>`}
      </table></div>
      ${subs.length ? `<div class="row" style="justify-content:flex-end;margin-top:14px">
        ${form.fields.some((f) => f.type === 'file')
    ? `<a class="btn" href="/api/forms/${id}/submissions.xlsx" download>Excel only</a>
        <a class="btn primary" href="/api/forms/${id}/submissions.zip" download title="Excel file plus all uploaded files, in one folder per upload question">Download all entries (Excel + files, .zip)</a>`
    : `<a class="btn primary" href="/api/forms/${id}/submissions.xlsx" download>Download all entries (Excel)</a>`}
      </div>` : ''}
    </div>
    </div>`;

  $('#d-edit').onclick = () => showBuilder(form);
  $('#d-menu').onclick = (e) => { e.stopPropagation(); openFormMenu(e.currentTarget, form); };
  if (form.locked) $('#d-unlock').onclick = () => setLocked(form, false);
  const settings = () => {
    linkSettings.expiresOn = $('#l-exp').value;
    linkSettings.max = $('#l-max').value === '' ? '0' : $('#l-max').value;
    return { expiresOn: linkSettings.expiresOn || null, maxSubmissions: Number(linkSettings.max) };
  };
  $('#l-exp').onchange = settings;
  $('#l-max').onchange = settings;

  $('#l-create').onclick = async () => {
    try {
      await api(`/api/forms/${id}/links`, { method: 'POST', body: {
        recipientName: $('#l-name').value, recipientEmail: $('#l-email').value, ...settings(),
      } });
      showForm(id);
    } catch (e) { alert(e.message + (e.details ? '\n' + e.details.join('\n') : '')); }
  };

  // ----- Spreadsheet upload: preview, then create all links at once -----
  const preview = $('#u-preview');
  const handleFile = async (file) => {
    if (!file) return;
    preview.innerHTML = `<p class="muted">Reading ${esc(file.name)}…</p>`;
    let result;
    try {
      const res = await fetch(`/api/forms/${id}/links/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || res.statusText);
    } catch (e) {
      preview.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    const valid = result.recipients.filter((r) => !r.error);
    const skipped = result.recipients.length - valid.length;
    preview.innerHTML = `
      <div class="preview">
        <div class="row" style="justify-content:space-between">
          <strong>${esc(file.name)}: ${valid.length} recipient${valid.length === 1 ? '' : 's'} ready${skipped ? `, <span class="error">${skipped} will be skipped</span>` : ''}</strong>
          <div class="row">
            <button id="u-cancel">Cancel</button>
            <button class="primary" id="u-create" ${valid.length ? '' : 'disabled'}>Create ${valid.length} link${valid.length === 1 ? '' : 's'}</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height:300px;overflow:auto;margin-top:10px"><table>
          <tr><th>Row</th><th>Name</th><th>Email</th><th>Status</th></tr>
          ${result.recipients.map((r) => `<tr>
            <td class="muted">${r.row}</td><td>${esc(r.name || '—')}</td><td>${esc(r.email)}</td>
            <td>${r.error ? `<span class="error">${esc(r.error)}</span>` : '<span class="success">OK</span>'}</td>
          </tr>`).join('')}
        </table></div>
      </div>`;
    $('#u-cancel').onclick = () => { preview.innerHTML = ''; $('#u-file').value = ''; };
    $('#u-create').onclick = async () => {
      const btn = $('#u-create');
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        const out = await api(`/api/forms/${id}/links/bulk`, { method: 'POST', body: {
          recipients: valid.map(({ name, email }) => ({ name, email })), ...settings(),
        } });
        await showForm(id);
        $('#u-preview').innerHTML = `<p class="success">Created ${out.created} links. Use “Download links (CSV)” below to send them out.</p>`;
      } catch (e) {
        btn.disabled = false; btn.textContent = `Create ${valid.length} links`;
        alert(e.message + (e.details ? '\n' + e.details.join('\n') : ''));
      }
    };
  };
  $('#u-file').onchange = (e) => handleFile(e.target.files[0]);
  const drop = $('#u-drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); };

  mountLinks(id, form, links, tpl, settings);
  mountTabs(id);
  $('#send-toggle').onclick = () => {
    const open = !sendLinksOpen();
    try { localStorage.setItem('sf:sendLinksOpen', open ? '1' : '0'); } catch { /* ignore */ }
    sendLinksState = open;
    $('#send-body').hidden = !open;
    $('.send-card').classList.toggle('collapsed', !open);
    $('#send-toggle').setAttribute('aria-expanded', open);
    $('#send-toggle .toggle-label').textContent = open ? 'Hide' : 'Show';
  };
}

// Show/hide the "Send personal links" panel; remembered across forms and page reloads.
let sendLinksState = null;
function sendLinksOpen() {
  if (sendLinksState === null) {
    try { sendLinksState = localStorage.getItem('sf:sendLinksOpen') !== '0'; } catch { sendLinksState = true; }
  }
  return sendLinksState;
}

// ---------- Tabs: Recipients / Submissions / Results ----------
const TAB_LABELS = { recipients: 'Recipients', submissions: 'Submissions', results: 'Poll results' };
const tabsFor = (hasResults) => Object.entries(TAB_LABELS).filter(([k]) => k !== 'results' || hasResults);
const tabState = {}; // formId -> active tab, kept while the page is open
function rememberTab(formId, tab) {
  tabState[formId] = tab;
  try { localStorage.setItem(`sf:tab:${formId}`, tab); } catch { /* storage unavailable */ }
}
function mountTabs(formId) {
  const tabs = [...document.querySelectorAll('.tabs [role=tab]')];
  let saved = tabState[formId];
  if (!saved) { try { saved = localStorage.getItem(`sf:tab:${formId}`); } catch { /* ignore */ } }
  const select = (key, focus = false) => {
    if (!tabs.some((t) => t.dataset.tab === key)) key = 'recipients';
    for (const t of tabs) {
      const on = t.dataset.tab === key;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle('active', on);
      document.getElementById(`panel-${t.dataset.tab}`).hidden = !on;
      if (on && focus) t.focus();
    }
    rememberTab(formId, key);
  };
  tabs.forEach((t, i) => {
    t.onclick = () => select(t.dataset.tab);
    t.onkeydown = (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length].dataset.tab, true); }
    };
  });
  select(saved || 'recipients');
}

// ---------- Recipients & links table ----------
const LINK_FILTERS = [
  ['all', 'All statuses'], ['not-sent', 'Not emailed yet'], ['emailed', 'Emailed'], ['failed', 'Email failed'],
  ['active', 'Waiting for response'], ['used', 'Submitted'], ['expired', 'Expired'], ['replaced', 'Replaced'],
];
// Remembered while the page is open so re-renders keep your search, filter and ticks.
const linkView = { formId: null, search: '', filter: 'all', selected: new Set() };

function matchesFilter(l, f) {
  switch (f) {
    case 'not-sent': return !l.sendCount && l.lastEmailStatus !== 'failed';
    case 'emailed': return l.sendCount > 0;
    case 'failed': return l.lastEmailStatus === 'failed';
    case 'active': case 'used': case 'expired': case 'replaced': return l.state === f;
    default: return true;
  }
}

function emailCell(formId, l) {
  const preview = l.lastEmailId ? ` · <a href="/api/forms/${formId}/emails/${l.lastEmailId}" target="_blank">Preview</a>` : '';
  if (l.lastEmailStatus === 'failed') {
    return `<span class="badge bad" title="${esc(l.lastEmailError)}">Failed</span>${preview}<br><small class="error">${esc((l.lastEmailError || '').slice(0, 80))}</small>`;
  }
  if (!l.sendCount) return l.recipientEmail ? '<span class="muted">Not sent</span>' : '<span class="muted">No email</span>';
  const when = new Date(l.sentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const label = l.lastEmailStatus === 'test' ? 'Saved (test)' : 'Sent';
  return `<span class="badge ${l.lastEmailStatus === 'test' ? '' : 'ok'}">${label}</span> ${when}${l.sendCount > 1 ? ` ×${l.sendCount}` : ''}${preview}`;
}

function stateBadge(l) {
  return { replaced: '<span class="badge">Replaced</span>', used: '<span class="badge ok">Submitted</span>', expired: '<span class="badge bad">Expired</span>' }[l.state] || '';
}

function mountLinks(formId, form, links, tpl, settings) {
  if (linkView.formId !== formId) Object.assign(linkView, { formId, search: '', filter: 'all', selected: new Set() });
  const ids = new Set(links.map((l) => l.id));
  for (const sel of [...linkView.selected]) if (!ids.has(sel)) linkView.selected.delete(sel);
  $('#l-search').value = linkView.search;
  $('#l-filter').value = linkView.filter;

  const visible = () => {
    const q = linkView.search.trim().toLowerCase();
    return links.filter((l) => matchesFilter(l, linkView.filter)
      && (!q || `${l.recipientName || ''} ${l.recipientEmail || ''}`.toLowerCase().includes(q)));
  };

  const updateSelectionUi = () => {
    const vis = visible();
    const visSel = vis.filter((l) => linkView.selected.has(l.id)).length;
    const all = $('#l-all');
    all.checked = vis.length > 0 && visSel === vis.length;
    all.indeterminate = visSel > 0 && visSel < vis.length;
    all.disabled = vis.length === 0;
    const n = linkView.selected.size;
    const hidden = n - visSel;
    $('#l-count').textContent = `${n} selected${hidden ? ` (${hidden} hidden by search/filter)` : ''}`;
    $('#a-send').disabled = !n;
    $('#a-resend').disabled = !n;
    $('#a-remove').disabled = !n;
    $('#a-remove').textContent = n ? `Remove (${n})` : 'Remove';
  };

  const render = () => {
    const vis = visible();
    $('#l-rows').innerHTML = vis.map((l) => `
      <tr class="${l.state === 'replaced' ? 'dim' : ''} ${linkView.selected.has(l.id) ? 'sel' : ''}">
        <td class="chk"><input type="checkbox" class="l-chk" data-id="${l.id}" ${linkView.selected.has(l.id) ? 'checked' : ''} aria-label="Select ${esc(l.recipientName || l.recipientEmail || 'link')}"></td>
        <td>${esc(l.recipientName || '—')} ${stateBadge(l)}<br><small class="muted">${esc(l.recipientEmail || '')}</small></td>
        <td><a class="mono" href="${esc(l.url)}" target="_blank">${esc(l.url)}</a></td>
        <td>${emailCell(formId, l)}</td>
        <td>${l.submissionCount}/${l.maxSubmissions ?? '∞'}</td>
        <td style="white-space:nowrap">${fmtExpiry(l.expiresAt)}</td>
        <td style="white-space:nowrap"><button data-copy="${esc(l.url)}">Copy</button> <button class="danger" data-del="${l.id}" title="Delete link">✕</button></td>
      </tr>`).join('') || `<tr><td colspan="7" class="muted">${links.length ? 'No recipients match your search.' : 'No links yet.'}</td></tr>`;

    $('#l-rows').querySelectorAll('.l-chk').forEach((c) => c.onchange = () => {
      if (c.checked) linkView.selected.add(c.dataset.id); else linkView.selected.delete(c.dataset.id);
      c.closest('tr').classList.toggle('sel', c.checked);
      updateSelectionUi();
    });
    $('#l-rows').querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { prompt('Copy link:', b.dataset.copy); }
    });
    $('#l-rows').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => removeDialog([b.dataset.del]));
    updateSelectionUi();
  };

  $('#l-search').oninput = (e) => { linkView.search = e.target.value; render(); };
  $('#l-filter').onchange = (e) => { linkView.filter = e.target.value; render(); };
  $('#l-all').onchange = (e) => {
    for (const l of visible()) { if (e.target.checked) linkView.selected.add(l.id); else linkView.selected.delete(l.id); }
    render();
  };
  $('#a-send').onclick = () => openCompose('send');
  $('#a-resend').onclick = () => openCompose('resend');
  $('#a-remove').onclick = () => removeDialog([...linkView.selected]);

  // Asks for confirmation with the exact count before removing recipients.
  function removeDialog(ids) {
    const chosen = links.filter((l) => ids.includes(l.id));
    const n = chosen.length;
    if (!n) return;
    const visibleIds = new Set(visible().map((l) => l.id));
    const hidden = chosen.filter((l) => !visibleIds.has(l.id)).length;
    const answered = chosen.filter((l) => l.submissionCount > 0).length;
    const subCount = chosen.reduce((t, l) => t + (l.submissionCount || 0), 0);
    const label = (l) => esc(l.recipientName || l.recipientEmail || 'Unnamed link') + (l.recipientName && l.recipientEmail ? ` <span class="muted">· ${esc(l.recipientEmail)}</span>` : '')
      + (l.submissionCount ? ` <span class="badge bad">${l.submissionCount} submission${l.submissionCount === 1 ? '' : 's'}</span>` : '');
    const preview = chosen.slice(0, 8).map((l) => `<li>${label(l)}</li>`).join('') + (n > 8 ? `<li class="muted">…and ${n - 8} more</li>` : '');
    modal(`
      <div class="modal-body">
        <h2>Remove ${n} recipient${n === 1 ? '' : 's'}?</h2>
        <p>You are about to remove <b>${n}</b> selected recipient${n === 1 ? '' : 's'}${hidden ? ` (<b>${hidden}</b> of them hidden by your current search or filter)` : ''}. Their personal links will stop working right away.</p>
        <ul class="remove-list">${preview}</ul>
        <div class="notice warn" style="margin-top:4px">
          <b>Their results will be deleted too.</b> Removing a recipient also permanently deletes everything they submitted, including any files they uploaded, from Submissions, the downloads and the poll results.
          ${subCount ? `<br>This will delete <b>${subCount} submission${subCount === 1 ? '' : 's'}</b> from <b>${answered}</b> recipient${answered === 1 ? '' : 's'}.` : '<br>None of the selected recipients has submitted yet.'}
        </div>
        ${subCount ? `<label class="check" style="font-weight:400;margin-top:12px"><input type="checkbox" id="rm-ok"> I understand that ${subCount === 1 ? 'this submission' : `these ${subCount} submissions`} and attached files will be permanently deleted.</label>` : ''}
        <p class="muted" style="font-size:13px">This cannot be undone. Tip: download the entries first if you want to keep a copy.</p>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button data-close>Cancel</button>
          <button class="danger-solid" id="rm-go" ${subCount ? 'disabled' : ''}>Remove ${n} recipient${n === 1 ? '' : 's'}${subCount ? ' &amp; results' : ''}</button>
        </div>
      </div>`, (d) => {
      const ok = d.querySelector('#rm-ok');
      if (ok) ok.onchange = () => { d.querySelector('#rm-go').disabled = !ok.checked; };
      d.querySelector('[data-close]').focus(); // safer default
      d.querySelector('#rm-go').onclick = async () => {
        const btn = d.querySelector('#rm-go');
        btn.disabled = true; btn.textContent = 'Removing…';
        try {
          const out = await api(`/api/forms/${formId}/links/delete`, { method: 'POST', body: { linkIds: chosen.map((l) => l.id) } });
          for (const l of chosen) linkView.selected.delete(l.id);
          d.close();
          await showForm(formId);
          const extra = out.submissionsDeleted
            ? ` Also deleted ${out.submissionsDeleted} submission${out.submissionsDeleted === 1 ? '' : 's'}${out.filesDeleted ? ` and ${out.filesDeleted} file${out.filesDeleted === 1 ? '' : 's'}` : ''}.` : '';
          $('#compose').innerHTML = `<div class="preview"><strong class="success">Removed ${out.removed} recipient${out.removed === 1 ? '' : 's'}.</strong>${extra}</div>`;
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Try again';
          alert(e.message);
        }
      };
    });
  }

  function openCompose(kind) {
    const chosen = links.filter((l) => linkView.selected.has(l.id));
    const n = chosen.length;
    const noEmail = chosen.filter((l) => !l.recipientEmail).length;
    const s = settings();
    const isResend = kind === 'resend';
    const willSkip = isResend
      ? chosen.filter((l) => !l.recipientEmail || l.state === 'replaced').length
      : chosen.filter((l) => !l.recipientEmail || l.state !== 'active').length;
    const box = $('#compose');
    box.innerHTML = `
      <div class="preview compose">
        <strong>${isResend ? `Resend to ${n} recipient${n === 1 ? '' : 's'} with a new link` : `Email ${n} recipient${n === 1 ? '' : 's'} their link`}</strong>
        <p class="muted" style="margin:6px 0 0;font-size:13px">${isResend
    ? `A new link is created for each person and emailed to them. Their current link stops working. New links expire <b>${s.expiresOn ? esc(new Date(`${s.expiresOn}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })) : 'never'}</b> and allow <b>${s.maxSubmissions ? s.maxSubmissions : 'unlimited'}</b> submission${s.maxSubmissions === 1 ? '' : 's'} (change this in Link settings above).`
    : 'Each person receives their current personal link.'}
          ${willSkip ? `<br><span class="error">${willSkip} will be skipped (${isResend ? 'no email address or already replaced' : 'no email address, expired, submitted or replaced — use Resend for those'}).</span>` : ''}
          ${form.locked ? '<br><span class="error"><b>This form is locked</b> — recipients will see it as closed until you unlock it.</span>' : ''}
          ${noEmail && !willSkip ? `<br><span class="error">${noEmail} have no email address and will be skipped.</span>` : ''}
        </p>
        <label>Subject</label><input id="c-subject" value="${esc(tpl.subject)}">
        <label>Message</label><textarea id="c-message" rows="8">${esc(tpl.message)}</textarea>
        <small class="muted">You can use {date}, {name}, {form} (title), {description}, {link} and {expiry}. {link} appears as an "Open the form" button (one is added at the end if you leave it out).${tpl.testMode ? ' <b>Test mode:</b> emails are saved, not sent.' : ` Sent from ${esc(tpl.from)}.`}</small>
        <div class="row" style="margin-top:12px;justify-content:flex-end">
          <button id="c-cancel">Cancel</button>
          <button class="primary" id="c-go" ${n - willSkip > 0 ? '' : 'disabled'}>${isResend ? 'Create new links &amp; send' : 'Send'} ${n - willSkip} email${n - willSkip === 1 ? '' : 's'}</button>
        </div>
      </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#c-cancel').onclick = () => (box.innerHTML = '');
    $('#c-go').onclick = async () => {
      const go = $('#c-go');
      go.disabled = true; go.textContent = 'Sending…';
      const subject = $('#c-subject').value;
      const message = $('#c-message').value;
      try {
        const out = await api(`/api/forms/${formId}/links/${kind}`, { method: 'POST', body: {
          linkIds: chosen.map((l) => l.id), subject, message, ...(isResend ? s : {}),
        } });
        linkView.selected.clear();
        await showForm(formId);
        showResult(out, isResend);
      } catch (e) {
        go.disabled = false; go.textContent = 'Try again';
        alert(e.message + (e.details ? '\n' + e.details.join('\n') : ''));
      }
    };
  }

  function showResult(out, isResend) {
    const parts = [];
    if (out.sent) parts.push(`<span class="success">${out.sent} sent</span>`);
    if (out.test) parts.push(`<span class="success">${out.test} saved to outbox (test mode)</span>`);
    if (out.failed) parts.push(`<span class="error">${out.failed} failed</span>`);
    if (out.skipped) parts.push(`<span class="muted">${out.skipped} skipped</span>`);
    const problems = [
      ...out.results.filter((r) => r.status === 'failed').map((r) => `${esc(r.name || r.email)}: ${esc(r.error)}`),
      ...out.skippedList.map((r) => `${esc(r.name || r.email || 'Link')}: ${esc(r.reason)}`),
    ];
    $('#compose').innerHTML = `<div class="preview">
      <strong>${isResend ? `${out.created} new link${out.created === 1 ? '' : 's'} created. ` : ''}${parts.join(' · ') || 'Nothing to send.'}</strong>
      ${problems.length ? `<ul class="problems">${problems.map((p) => `<li>${p}</li>`).join('')}</ul>` : ''}
      <div class="row" style="justify-content:flex-end"><button id="r-close">Close</button></div>
    </div>`;
    $('#r-close').onclick = () => ($('#compose').innerHTML = '');
  }

  render();
}

$('#new-form').onclick = () => { currentId = null; showSide('mine'); loadList(); showBuilder(null); };

// ---------- Signed-in user, "Sent to me" ----------
const INV_STATUS = {
  open: ['To fill in', ''], 'submitted-can-add': ['Submitted', 'ok'], submitted: ['Submitted', 'ok'],
  expired: ['Expired', 'bad'], closed: ['Closed for now', 'bad'],
};

function showSide(which) {
  const mine = which === 'mine';
  $('#side-mine').classList.toggle('active', mine);
  $('#side-inv').classList.toggle('active', !mine);
  $('#side-mine').setAttribute('aria-selected', mine);
  $('#side-inv').setAttribute('aria-selected', !mine);
  $('#side-mine-panel').hidden = !mine;
  $('#side-inv-panel').hidden = mine;
  try { localStorage.setItem('sf:side', which); } catch { /* ignore */ }
}

let invCache = [];
async function loadInvitations() {
  const inv = invCache = await api('/api/me/invitations');
  $('#inv-count').textContent = inv.length;
  $('#inv-list').innerHTML = inv.map((i) => {
    const [label, cls] = INV_STATUS[i.status] || [i.status, ''];
    return `<li><a href="${esc(i.url)}" target="_blank" rel="noopener" title="${i.submitted ? 'View your answers' : 'Open the form'}">
      ${esc(i.title)} <span class="badge ${cls}">${label}</span>
      <small>${i.from ? `From ${esc(i.from)} · ` : ''}${esc(new Date(i.receivedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}${i.expiresAt && !i.submitted ? ` · until ${esc(new Date(i.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}` : ''}</small>
    </a></li>`;
  }).join('') || '<li class="muted" style="padding:10px 0">Nothing has been sent to you yet.</li>';
}

async function boot() {
  let me;
  try { me = await api('/api/auth/me'); } catch { return; } // api() sends signed-out visitors to /login
  $('#user-name').textContent = me.name || me.email;
  $('#user-email').textContent = me.email;
  $('#inv-email').textContent = me.email;
  $('#user-pic').innerHTML = me.picture
    ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar">${esc((me.name || me.email).charAt(0).toUpperCase())}</span>`;
  $('#user-menu').hidden = false;
  $('#sign-out').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };
  $('#side-mine').onclick = () => openSide('mine');
  $('#side-inv').onclick = () => openSide('inv');
  let side = 'mine';
  try { side = localStorage.getItem('sf:side') || 'mine'; } catch { /* ignore */ }
  showSide(side);
  await Promise.all([
    loadList().catch((e) => ($('#form-list').innerHTML = `<li class="error">${esc(e.message)}</li>`)),
    loadInvitations().catch((e) => ($('#inv-list').innerHTML = `<li class="error">${esc(e.message)}</li>`)),
  ]);
  if (side === 'inv') showInvDetail(); else showMineDetail();
}

// Clicking a sidebar tab reloads its list and shows matching content on the right.
async function openSide(which) {
  if (builderDirty && !confirm('Leave the form editor? Your unsaved changes will be lost.')) return;
  builderDirty = false;
  showSide(which);
  $('#detail').innerHTML = '<div class="card muted">Loading…</div>';
  try {
    if (which === 'mine') { await loadList(); await showMineDetail(); }
    else { await loadInvitations(); showInvDetail(); }
  } catch (e) {
    $('#detail').innerHTML = `<div class="card error">${esc(e.message)}</div>`;
  }
}

// Right side for "My forms": the open form (refreshed), a hint, or a start screen when there are no forms.
async function showMineDetail(note) {
  if (currentId && formsCache.some((f) => f.id === currentId)) return showForm(currentId);
  currentId = null;
  renderFormList();
  if (!formsCache.length) {
    $('#detail').innerHTML = `
      <div class="card empty-state">
        ${note ? `<p class="muted">${esc(note)}</p>` : ''}
        <div class="empty-icon" aria-hidden="true">📝</div>
        <h2>Start creating your forms</h2>
        <p class="muted">Build a form, send each person their own link, and watch the answers come in.</p>
        <button class="primary" id="empty-new">+ Create your first form</button>
      </div>`;
    $('#empty-new').onclick = () => $('#new-form').click();
    return;
  }
  $('#detail').innerHTML = `<div class="card muted">${note ? esc(note) + ' ' : ''}Select a form on the left, or create a new one. You have ${formsCache.length} form${formsCache.length === 1 ? '' : 's'}.</div>`;
}

// Right side for "Sent to me": every form sent to this email, with its status.
function showInvDetail() {
  const inv = invCache;
  if (!inv.length) {
    $('#detail').innerHTML = `
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">📬</div>
        <h2>Nothing has been sent to you yet</h2>
        <p class="muted">When someone sends a form to <b>${esc($('#inv-email').textContent)}</b>, it will show up here.</p>
      </div>`;
    return;
  }
  const fmt = (iso, withYear = true) => esc(new Date(iso).toLocaleDateString(undefined, { year: withYear ? 'numeric' : undefined, month: 'short', day: 'numeric' }));
  const todo = inv.filter((i) => i.status === 'open').length;
  $('#detail').innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">Sent to me</h2>
      <p class="muted" style="margin-top:0">${inv.length} form${inv.length === 1 ? '' : 's'} sent to <b>${esc($('#inv-email').textContent)}</b>${todo ? ` · <b>${todo}</b> still to fill in` : ''}.</p>
      <div class="table-wrap"><table class="inv-table">
        <thead><tr><th>Form</th><th>From</th><th>Received</th><th>Open until</th><th>Status</th><th></th></tr></thead>
        <tbody>${inv.map((i) => {
          const [label, cls] = INV_STATUS[i.status] || [i.status, ''];
          return `<tr>
            <td><b>${esc(i.title)}</b>${i.description ? `<br><small class="muted">${esc(i.description)}</small>` : ''}</td>
            <td>${esc(i.from || '—')}</td>
            <td>${fmt(i.receivedAt)}</td>
            <td>${i.expiresAt ? fmt(i.expiresAt) : 'No end date'}</td>
            <td><span class="badge ${cls}">${label}</span></td>
            <td style="text-align:right"><a class="btn${i.status === 'open' ? ' primary' : ''}" href="${esc(i.url)}" target="_blank" rel="noopener">${i.submitted ? 'View answers' : 'Open form'}</a></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;
}
boot();
