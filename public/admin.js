// Security note: user-provided values (French text, e-mail, translation) are
// always rendered with textContent, never innerHTML.
const CONFIG = JSON.parse(document.getElementById('app-config').textContent);
const BASE = CONFIG.basePath;
const PAGE_SIZE = 50;

const $ = (id) => document.getElementById(id);
const el = {
  stats: $('stats'),
  language: $('f-language'),
  category: $('f-category'),
  q: $('f-q'),
  audio: $('f-audio'),
  text: $('f-text'),
  rows: $('rows'),
  empty: $('empty'),
  total: $('total'),
  error: $('error'),
  prev: $('prev'),
  next: $('next'),
  pageInfo: $('page-info'),
  exportCsv: $('export-csv'),
  exportZip: $('export-zip'),
};

const languageLabel = (code) => CONFIG.languages.find((l) => l.code === code)?.label ?? code;
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const numFmt = new Intl.NumberFormat('fr-FR');

let page = 1;
let totalPages = 1;
let requestSeq = 0;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

async function getJson(path) {
  const res = await fetch(`${BASE}/api/${path}`, { cache: 'no-store' });
  if (!res.ok) {
    let msg = `Erreur ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function filterParams({ paging = false } = {}) {
  const p = new URLSearchParams();
  if (el.language.value) p.set('language', el.language.value);
  if (el.category.value) p.set('category', el.category.value);
  if (el.q.value.trim()) p.set('q', el.q.value.trim());
  if (el.audio.checked) p.set('has_audio', '1');
  if (el.text.checked) p.set('has_text', '1');
  if (paging) {
    p.set('page', String(page));
    p.set('page_size', String(PAGE_SIZE));
  }
  return p;
}

function updateExportLinks() {
  el.exportCsv.href = `${BASE}/api/export.csv?${filterParams()}`;
  const zip = new URLSearchParams();
  if (el.language.value) zip.set('language', el.language.value);
  el.exportZip.href = `${BASE}/api/export.zip${zip.size ? `?${zip}` : ''}`;
}

// ---------- Stats ----------

function statLine(label, value) {
  const row = h('div', 'flex items-baseline justify-between gap-3 py-1');
  row.append(h('dt', 'text-sm text-stone-600', label), h('dd', 'text-base font-semibold tabular-nums', value));
  return row;
}

async function loadStats() {
  const data = await getJson('stats');

  if (el.category.options.length === 1) {
    for (const name of data.categories) {
      const opt = h('option', '', name);
      opt.value = name;
      el.category.append(opt);
    }
  }

  el.stats.replaceChildren(...data.languages.map((s) => {
    const card = h('article', 'rounded-xl bg-white p-4 shadow-sm ring-1 ring-stone-200');
    card.append(h('h2', 'text-lg font-bold text-stone-900', s.label));
    const pct = s.total_words ? Math.round((s.words_covered / s.total_words) * 100) : 0;
    const bar = h('div', 'mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-200');
    const fill = h('div', 'h-full rounded-full bg-emerald-600');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const dl = h('dl', 'mt-3 divide-y divide-stone-100');
    dl.append(
      statLine('Contributeurs', numFmt.format(s.contributors)),
      statLine('Réponses', numFmt.format(s.responses)),
      statLine('Avec audio', numFmt.format(s.with_audio)),
      statLine('Avec texte', numFmt.format(s.with_text)),
      statLine('Mots couverts', `${numFmt.format(s.words_covered)} sur ${numFmt.format(s.total_words)}`),
    );
    card.append(bar, dl);
    return card;
  }));
}

// ---------- Table ----------

function renderRow(r) {
  const tr = h('tr', 'align-top hover:bg-stone-50');
  const td = (text, cls = '') => h('td', `px-4 py-3 ${cls}`, text);

  tr.append(
    td(r.word_id, 'whitespace-nowrap font-mono text-xs text-stone-600'),
    td(r.category, 'whitespace-nowrap'),
    td(r.french_text, 'min-w-[12rem] max-w-xs break-words font-medium'),
    td(languageLabel(r.language), 'whitespace-nowrap'),
    td(r.email, 'whitespace-nowrap text-stone-700'),
  );

  const audioCell = td(null, 'min-w-[16rem]');
  if (r.has_audio) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.className = 'h-10 w-64 max-w-full';
    audio.src = `${BASE}/api/audio/${encodeURIComponent(r.response_id)}`;
    audioCell.append(audio);
  } else {
    audioCell.append(h('span', 'text-stone-400', '—'));
  }
  tr.append(audioCell);

  tr.append(
    td(r.text ?? '—', `min-w-[10rem] max-w-xs whitespace-pre-wrap break-words ${r.text ? '' : 'text-stone-400'}`),
    td(dateFmt.format(new Date(r.updated_at)), 'whitespace-nowrap text-stone-600'),
  );
  return tr;
}

async function loadRows() {
  const seq = ++requestSeq;
  el.error.textContent = '';
  let data;
  try {
    data = await getJson(`responses?${filterParams({ paging: true })}`);
  } catch (err) {
    if (seq === requestSeq) el.error.textContent = err.message;
    return;
  }
  if (seq !== requestSeq) return; // a newer request is in flight

  totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  if (page > totalPages) {
    page = totalPages;
    return loadRows();
  }
  el.rows.replaceChildren(...data.rows.map(renderRow));
  el.empty.hidden = data.total > 0;
  el.total.textContent = `${numFmt.format(data.total)} réponse${data.total > 1 ? 's' : ''}`;
  el.pageInfo.textContent = `Page ${page} sur ${totalPages}`;
  el.prev.disabled = page <= 1;
  el.next.disabled = page >= totalPages;
}

function onFiltersChanged() {
  page = 1;
  updateExportLinks();
  loadRows();
}

// ---------- Boot ----------

for (const l of CONFIG.languages) {
  const opt = h('option', '', l.label);
  opt.value = l.code;
  el.language.append(opt);
}

let searchTimer = null;
el.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(onFiltersChanged, 300);
});
for (const input of [el.language, el.category, el.audio, el.text]) input.addEventListener('change', onFiltersChanged);
$('filters').addEventListener('submit', (e) => { e.preventDefault(); onFiltersChanged(); });

el.prev.addEventListener('click', () => { if (page > 1) { page--; loadRows(); } });
el.next.addEventListener('click', () => { if (page < totalPages) { page++; loadRows(); } });

updateExportLinks();
loadStats().catch((err) => { el.error.textContent = err.message; });
loadRows();
