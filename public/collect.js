const CONFIG = JSON.parse(document.getElementById('app-config').textContent);
const BASE = CONFIG.basePath;
const STORAGE_KEY = 'aila-collect-session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_RECORDING_MS = 500;

const MSG = {
  saved: 'Enregistré ✓',
  sending: 'Envoi en cours…',
  sendFailed: "Échec de l'envoi. Vérifiez votre connexion et réessayez.",
  tooShort: 'Enregistrement trop court, réessayez.',
  micDenied: "Le micro est bloqué. Autorisez l'accès au micro dans votre navigateur, puis réessayez.",
  noMic: 'Aucun micro détecté. Branchez un micro, puis réessayez.',
  unsupported: "Votre navigateur ne permet pas l'enregistrement audio. Vous pouvez tout de même écrire la traduction.",
  startFailed: 'Impossible de commencer. Vérifiez votre connexion et réessayez.',
  loadAudioFailed: "Impossible de lire l'enregistrement. Réessayez.",
  sessionExpired: 'Votre session a expiré. Saisissez à nouveau votre e-mail.',
  leaveUnsaved: "Vos dernières modifications n'ont pas pu être envoyées. Quitter quand même ?",
};

const $ = (id) => document.getElementById(id);
const el = {
  loading: $('loading'),
  screenStart: $('screen-start'),
  screenWord: $('screen-word'),
  startForm: $('start-form'),
  email: $('email'),
  languageList: $('language-list'),
  startBtn: $('start-btn'),
  startStatus: $('start-status'),
  wordCounter: $('word-counter'),
  doneLabel: $('done-label'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  doneBanner: $('done-banner'),
  categoryChip: $('category-chip'),
  categorySelect: $('category-select'),
  frenchText: $('french-text'),
  recordUnsupported: $('record-unsupported'),
  recordBtn: $('record-btn'),
  recordLabel: $('record-label'),
  recordTimer: $('record-timer'),
  existingNote: $('existing-note'),
  localPlayback: $('local-playback'),
  localAudio: $('local-audio'),
  savedPlayback: $('saved-playback'),
  recordActions: $('record-actions'),
  listenBtn: $('listen-btn'),
  rerecordBtn: $('rerecord-btn'),
  translation: $('translation'),
  status: $('status'),
  prevBtn: $('prev-btn'),
  nextBtn: $('next-btn'),
  nextPendingBtn: $('next-pending-btn'),
  changeBtn: $('change-btn'),
  sessionInfo: $('session-info'),
};

const languageLabel = (code) => CONFIG.languages.find((l) => l.code === code)?.label ?? code;

// ---------- Storage (must never break the app) ----------

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (s && typeof s.token === 'string' && typeof s.email === 'string' && typeof s.language === 'string') return s;
  } catch {}
  return null;
}
function saveSession(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}
function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ---------- State ----------

const state = {
  session: null,
  words: [],
  categories: [],
  index: 0,
  saving: false,
  // Recording
  recordMode: 'idle', // idle | recording | recorded | saved
  showExistingNote: false,
  newBlob: null,
  localUrl: null,
  recorder: null,
  stream: null,
  recordStart: 0,
  timerId: null,
  autoStopId: null,
  stopPromise: null,
  // Saved audio playback
  savedAudio: null,
  savedUrl: null,
};

const currentWord = () => state.words[state.index];
const doneCount = () => state.words.filter((w) => w.has_audio || w.has_text).length;
const normalize = (s) => String(s ?? '').normalize('NFC').trim();

function show(node, visible) { node.hidden = !visible; }

function setStatus(text, kind = 'info') {
  el.status.textContent = text;
  el.status.className = 'mt-4 min-h-6 text-center text-base font-medium ' +
    (kind === 'error' ? 'text-red-700' : kind === 'ok' ? 'text-emerald-800' : 'text-stone-700');
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body, json } = {}) {
  const headers = {};
  if (state.session?.token) headers['X-Contributor-Token'] = state.session.token;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}/api/${path}`, { method, headers, body, cache: 'no-store' });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch {}
    throw new ApiError(res.status, data);
  }
  return res;
}

// ---------- Screen A ----------

let selectedLanguage = null;

function renderLanguageButtons() {
  el.languageList.replaceChildren();
  for (const lang of CONFIG.languages) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.dataset.code = lang.code;
    btn.textContent = lang.label;
    btn.addEventListener('click', () => {
      selectedLanguage = lang.code;
      updateLanguageButtons();
      updateStartButton();
    });
    el.languageList.append(btn);
  }
  updateLanguageButtons();
}

function updateLanguageButtons() {
  for (const btn of el.languageList.children) {
    const on = btn.dataset.code === selectedLanguage;
    btn.setAttribute('aria-checked', String(on));
    btn.className = 'flex h-16 w-full items-center gap-4 rounded-xl border-2 px-4 text-left text-lg font-semibold transition focus:outline-none focus:ring-4 focus:ring-emerald-700/20 ' +
      (on ? 'border-emerald-700 bg-emerald-50 text-emerald-900' : 'border-stone-300 bg-white text-stone-800 hover:border-stone-400');
    const dot = document.createElement('span');
    dot.setAttribute('aria-hidden', 'true');
    dot.className = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ' +
      (on ? 'border-emerald-700' : 'border-stone-400');
    if (on) {
      const inner = document.createElement('span');
      inner.className = 'h-3 w-3 rounded-full bg-emerald-700';
      dot.append(inner);
    }
    const label = document.createElement('span');
    label.textContent = CONFIG.languages.find((l) => l.code === btn.dataset.code).label;
    btn.replaceChildren(dot, label);
  }
}

function emailValid() {
  const v = el.email.value.trim();
  return v.length <= 254 && EMAIL_RE.test(v);
}

function updateStartButton() {
  el.startBtn.disabled = !(emailValid() && selectedLanguage);
}

function showStart(message = '') {
  show(el.loading, false);
  show(el.screenWord, false);
  show(el.screenStart, true);
  el.startStatus.textContent = message;
  if (state.session?.email) el.email.value = state.session.email;
  updateStartButton();
}

el.email.addEventListener('input', updateStartButton);

el.startForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (el.startBtn.disabled) return;
  el.startBtn.disabled = true;
  el.startStatus.textContent = '';
  try {
    state.session = null;
    const res = await api('session', { method: 'POST', json: { email: el.email.value.trim(), language: selectedLanguage } });
    const data = await res.json();
    state.session = { email: data.email, language: data.language, token: data.token };
    saveSession(state.session);
    await enterWordScreen();
  } catch (err) {
    el.startStatus.textContent = err instanceof ApiError && err.status < 500 && err.body?.message
      ? err.body.message
      : MSG.startFailed;
  } finally {
    updateStartButton();
  }
});

// ---------- Screen B ----------

async function enterWordScreen() {
  const res = await api('words');
  const data = await res.json();
  state.words = data.words;
  state.categories = data.categories;

  el.categorySelect.replaceChildren();
  for (const c of state.categories) {
    const opt = document.createElement('option');
    opt.value = c.first_word_id;
    opt.textContent = c.name;
    opt.dataset.category = c.name;
    el.categorySelect.append(opt);
  }
  el.translation.maxLength = CONFIG.maxTextChars;
  el.translation.placeholder = `Écrivez la traduction en ${languageLabel(state.session.language)}`;
  el.sessionInfo.textContent = `${state.session.email} · ${languageLabel(state.session.language)}`;

  // The server puts this contributor's least-covered pending words right after their done ones.
  const pendingIndex = state.words.findIndex((w) => !w.has_audio && !w.has_text);
  let banner = false;
  if (pendingIndex !== -1) {
    state.index = pendingIndex;
  } else {
    state.index = state.words.length - 1;
    banner = true;
  }

  show(el.loading, false);
  show(el.screenStart, false);
  show(el.screenWord, true);
  renderWord();
  show(el.doneBanner, banner);
}

function renderWord() {
  const w = currentWord();
  const total = state.words.length;
  const done = doneCount();

  el.wordCounter.textContent = `Mot ${state.index + 1} sur ${total}`;
  el.doneLabel.textContent = done > 1 ? `${done} mots complétés` : `${done} mot complété`;
  el.progressBar.style.width = total ? `${(done / total) * 100}%` : '0%';
  el.progress.setAttribute('aria-valuemax', String(total));
  el.progress.setAttribute('aria-valuenow', String(done));

  el.categoryChip.textContent = w.category;
  const cat = state.categories.find((c) => c.name === w.category);
  if (cat) el.categorySelect.value = cat.first_word_id;

  el.frenchText.textContent = w.french_text;
  el.translation.value = w.text ?? '';
  show(el.doneBanner, false);
  setStatus(w.has_audio || w.has_text ? MSG.saved : '', 'ok');

  discardLocalRecording();
  releaseSavedAudio();
  state.showExistingNote = false;
  state.recordMode = w.has_audio ? 'saved' : 'idle';
  renderRecordArea();
  updateNavButtons();
}

function updateNavButtons() {
  const busy = state.saving || state.recordMode === 'recording';
  el.prevBtn.disabled = state.saving || state.index === 0;
  el.nextBtn.disabled = state.saving;
  el.nextPendingBtn.disabled = state.saving;
  el.changeBtn.disabled = state.saving;
  el.categorySelect.disabled = state.saving;
  el.recordBtn.disabled = state.saving;
  el.rerecordBtn.disabled = busy;
  el.listenBtn.disabled = busy;
}

// ---------- Recording ----------

const recordingSupported = () =>
  window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder === 'function';

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return candidates.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderRecordArea() {
  const supported = recordingSupported();
  const mode = state.recordMode;
  show(el.recordUnsupported, !supported && mode !== 'saved');
  show(el.recordBtn, supported && (mode === 'idle' || mode === 'recording'));
  show(el.recordTimer, mode === 'recording');
  show(el.existingNote, mode === 'idle' && state.showExistingNote);
  show(el.localPlayback, mode === 'recorded');
  show(el.savedPlayback, mode === 'saved');
  show(el.recordActions, mode === 'recorded' || mode === 'saved');
  show(el.listenBtn, mode === 'saved');
  show(el.rerecordBtn, supported);

  const recording = mode === 'recording';
  el.recordLabel.textContent = recording ? 'Arrêter' : 'Appuyez pour enregistrer';
  el.recordBtn.setAttribute('aria-pressed', String(recording));
  el.recordBtn.classList.toggle('bg-red-600', recording);
  el.recordBtn.classList.toggle('hover:bg-red-700', recording);
  el.recordBtn.classList.toggle('animate-pulse', recording);
  el.recordBtn.classList.toggle('bg-emerald-700', !recording);
  el.recordBtn.classList.toggle('hover:bg-emerald-800', !recording);
  el.listenBtn.textContent = state.savedAudio && !state.savedAudio.paused ? 'Pause' : 'Écouter';
}

function stopTracks() {
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }
}

function clearTimers() {
  clearInterval(state.timerId);
  clearTimeout(state.autoStopId);
  state.timerId = state.autoStopId = null;
}

async function startRecording() {
  if (!recordingSupported()) {
    setStatus(MSG.unsupported, 'error');
    return;
  }
  releaseSavedAudio();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  } catch (err) {
    const name = err?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') setStatus(MSG.micDenied, 'error');
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') setStatus(MSG.noMic, 'error');
    else setStatus(MSG.unsupported, 'error');
    return;
  }

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    for (const t of stream.getTracks()) t.stop();
    setStatus(MSG.unsupported, 'error');
    return;
  }

  const chunks = [];
  state.stream = stream;
  state.recorder = recorder;
  recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); });
  state.stopPromise = new Promise((resolve) => {
    recorder.addEventListener('stop', () => {
      if (state.recorder !== recorder) { resolve(); return; } // aborted
      const duration = Date.now() - state.recordStart;
      clearTimers();
      stopTracks();
      state.recorder = null;
      const type = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (duration < MIN_RECORDING_MS || blob.size === 0) {
        state.recordMode = 'idle';
        setStatus(MSG.tooShort, 'error');
      } else {
        setLocalRecording(blob);
        state.recordMode = 'recorded';
        setStatus('');
      }
      renderRecordArea();
      updateNavButtons();
      resolve();
    }, { once: true });
  });

  state.recordStart = Date.now();
  recorder.start();
  state.recordMode = 'recording';
  setStatus('');
  el.recordTimer.textContent = '0:00';
  state.timerId = setInterval(() => { el.recordTimer.textContent = formatTime(Date.now() - state.recordStart); }, 250);
  state.autoStopId = setTimeout(() => stopRecording(), CONFIG.maxAudioSeconds * 1000);
  renderRecordArea();
  updateNavButtons();
}

/** Stops an ongoing recording and waits until the blob is ready. */
async function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') {
    const done = state.stopPromise;
    try { state.recorder.stop(); } catch {}
    await done;
  }
}

/** Stops without keeping anything (used when leaving the session). */
function abortRecording() {
  clearTimers();
  const recorder = state.recorder;
  state.recorder = null;
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
  stopTracks();
  state.recordMode = 'idle';
}

function setLocalRecording(blob) {
  if (state.localUrl) URL.revokeObjectURL(state.localUrl);
  state.newBlob = blob;
  state.localUrl = URL.createObjectURL(blob);
  el.localAudio.src = state.localUrl;
}

function discardLocalRecording() {
  el.localAudio.pause();
  el.localAudio.removeAttribute('src');
  el.localAudio.load();
  if (state.localUrl) URL.revokeObjectURL(state.localUrl);
  state.localUrl = null;
  state.newBlob = null;
}

function releaseSavedAudio() {
  if (state.savedAudio) {
    state.savedAudio.pause();
    state.savedAudio = null;
  }
  if (state.savedUrl) URL.revokeObjectURL(state.savedUrl);
  state.savedUrl = null;
}

el.recordBtn.addEventListener('click', () => {
  if (state.recordMode === 'recording') stopRecording();
  else startRecording();
});

el.rerecordBtn.addEventListener('click', () => {
  const hadSaved = currentWord().has_audio;
  discardLocalRecording();
  releaseSavedAudio();
  state.showExistingNote = hadSaved;
  state.recordMode = 'idle';
  setStatus('');
  renderRecordArea();
  updateNavButtons();
});

el.listenBtn.addEventListener('click', async () => {
  if (state.savedAudio) {
    if (state.savedAudio.paused) state.savedAudio.play().catch(() => {});
    else state.savedAudio.pause();
    return;
  }
  const w = currentWord();
  el.listenBtn.disabled = true;
  try {
    const res = await api(`responses/${encodeURIComponent(w.id)}/audio`);
    const blob = await res.blob();
    if (currentWord() !== w) return; // user moved on meanwhile
    state.savedUrl = URL.createObjectURL(blob);
    const audio = new Audio(state.savedUrl);
    state.savedAudio = audio;
    const refresh = () => { if (state.savedAudio === audio) renderRecordArea(); };
    audio.addEventListener('play', refresh);
    audio.addEventListener('pause', refresh);
    audio.addEventListener('ended', refresh);
    await audio.play();
  } catch {
    releaseSavedAudio();
    setStatus(MSG.loadAudioFailed, 'error');
  } finally {
    updateNavButtons();
    renderRecordArea();
  }
});

// ---------- Saving and navigation ----------

function hasPendingChanges() {
  const w = currentWord();
  if (!w) return false;
  return Boolean(state.newBlob) || normalize(el.translation.value) !== (w.text ?? '');
}

function extensionFor(type) {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

/** Sends pending changes of the current word. Returns true when nothing is left to send. */
async function saveCurrent() {
  if (state.recordMode === 'recording') await stopRecording();
  if (!hasPendingChanges()) return true;

  const w = currentWord();
  const form = new FormData();
  const textValue = normalize(el.translation.value);
  if (textValue !== (w.text ?? '')) form.append('text', textValue);
  if (state.newBlob) form.append('audio', state.newBlob, `recording.${extensionFor(state.newBlob.type)}`);

  state.saving = true;
  updateNavButtons();
  setStatus(MSG.sending);
  try {
    const res = await api(`responses/${encodeURIComponent(w.id)}`, { method: 'PUT', body: form });
    const data = await res.json();
    w.has_audio = data.has_audio;
    w.has_text = data.has_text;
    w.text = data.text;
    if (state.newBlob) {
      discardLocalRecording();
      state.recordMode = w.has_audio ? 'saved' : 'idle';
      state.showExistingNote = false;
    }
    el.translation.value = w.text ?? '';
    setStatus(w.has_audio || w.has_text ? MSG.saved : '', 'ok');
    return true;
  } catch (err) {
    // Keep the recording and text in memory so nothing is lost.
    const specific = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.body?.message;
    setStatus(specific || MSG.sendFailed, 'error');
    return false;
  } finally {
    state.saving = false;
    renderRecordArea();
    updateNavButtons();
  }
}

/** Auto-saves then moves. `target` returns the next index, or null to show the end banner. */
async function navigate(target) {
  if (state.saving) return;
  const ok = await saveCurrent();
  if (!ok) return;
  const next = target();
  if (next === null) {
    renderWord();
    show(el.doneBanner, true);
    el.doneBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  releaseSavedAudio();
  stopTracks();
  state.index = next;
  renderWord();
  window.scrollTo({ top: 0 });
}

function nextPendingIndex() {
  const n = state.words.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.index + k) % n;
    const w = state.words[i];
    if (!w.has_audio && !w.has_text) return i;
  }
  return null;
}

el.nextBtn.addEventListener('click', () =>
  navigate(() => (state.index < state.words.length - 1 ? state.index + 1 : null)));

el.prevBtn.addEventListener('click', () => navigate(() => Math.max(0, state.index - 1)));

el.nextPendingBtn.addEventListener('click', () => navigate(nextPendingIndex));

el.categorySelect.addEventListener('change', () => {
  const targetId = el.categorySelect.value;
  const current = state.categories.find((c) => c.name === currentWord().category);
  el.categorySelect.value = current?.first_word_id ?? targetId; // stays put until the save succeeds
  navigate(() => state.words.findIndex((w) => w.id === targetId));
});

el.changeBtn.addEventListener('click', async () => {
  if (state.saving) return;
  const ok = await saveCurrent();
  if (!ok && !window.confirm(MSG.leaveUnsaved)) return;
  abortRecording();
  discardLocalRecording();
  releaseSavedAudio();
  clearSession();
  const email = state.session?.email ?? '';
  state.session = null;
  state.words = [];
  selectedLanguage = null;
  updateLanguageButtons();
  el.email.value = email;
  showStart();
});

window.addEventListener('beforeunload', (e) => {
  if (state.words.length && (hasPendingChanges() || state.recordMode === 'recording')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- Boot ----------

async function boot() {
  renderLanguageButtons();
  const saved = loadSession();
  if (!saved) return showStart();

  state.session = saved;
  selectedLanguage = saved.language;
  updateLanguageButtons();
  try {
    await enterWordScreen();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearSession();
      state.session = { email: saved.email };
      showStart(MSG.sessionExpired);
    } else {
      state.session = saved;
      showStart(MSG.startFailed);
    }
  }
}

boot();
