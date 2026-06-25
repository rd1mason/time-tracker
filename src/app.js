import {
  openDB, saveSession, updateSession, deleteSession, getAllSessions,
  clearAllSessions, saveScreenshot, updateScreenshot, deleteScreenshot,
  getScreenshotsBySession, getState, setState, importSessions,
} from './db.js';

// ── helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const isEl = typeof window.tt !== 'undefined';

function pad(n) { return String(n).padStart(2, '0'); }
function fmtClock(s) {
  return `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
}
function fmtDur(s) {
  if (!s || s < 60) return `${s||0}s`;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtTotal(s) {
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}
function dayLabel(dateStr) {
  return new Date(dateStr).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', weekday: 'short' });
}
function monthLabel(ym) {
  return new Date(ym + '-01').toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function toTimeVal(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── timer state ───────────────────────────────────────────────────────────────
// New structure: startedAt (first start), currentRunStartedAt (segment start),
// elapsedBeforeCurrentRun (accumulated seconds before current segment)
let timerState = {
  status: 'idle',
  startedAt: null,
  currentRunStartedAt: null,
  elapsedBeforeCurrentRun: 0,
  plannedTask: '',
  category: '',
};
let timerInterval = null;
let pendingSession = null;
let pendingScreenshots = [];

// ── mode / drawer / lightbox state ───────────────────────────────────────────
let currentMode = 'compact';
let drawerOpenSessionId = null;
let drawerEditMode = false;
let drawerScreenshots = [];
let editPendingScreenshots = [];
let editDeletedIds = [];
let lbScreens = [];
let lbIdx = 0;

// ── elapsed calculation ───────────────────────────────────────────────────────
function elapsed() {
  let e = timerState.elapsedBeforeCurrentRun || 0;
  if (timerState.status === 'running' && timerState.currentRunStartedAt) {
    e += Math.floor((Date.now() - timerState.currentRunStartedAt) / 1000);
  }
  return e;
}

// ── persist timer state ───────────────────────────────────────────────────────
async function saveTimerState() {
  try { await setState('timerState', timerState); } catch (_) {}
}

async function loadTimerState() {
  try {
    const s = await getState('timerState');
    if (!s) return;
    // Migrate old format { startTs, elapsed } → new format
    if (s.currentRunStartedAt === undefined) {
      timerState = {
        status: s.status || 'idle',
        startedAt: s.startTs || null,
        currentRunStartedAt: s.status === 'running' ? (s.startTs || null) : null,
        elapsedBeforeCurrentRun: s.elapsed || 0,
        plannedTask: '',
        category: '',
      };
    } else {
      timerState = s;
    }
    // Recalculate elapsed if was running when closed
    if (timerState.status === 'running' && timerState.currentRunStartedAt) {
      const extra = Math.floor((Date.now() - timerState.currentRunStartedAt) / 1000);
      timerState.elapsedBeforeCurrentRun = (timerState.elapsedBeforeCurrentRun || 0) + extra;
      timerState.currentRunStartedAt = Date.now();
    }
  } catch (_) {}
}

// ── mode helpers ──────────────────────────────────────────────────────────────
function modeElId(mode) {
  return { compact: 'modeCompact', pre_start: 'modePreStart', session_end: 'modeSessionEnd', full: 'modeFull' }[mode];
}

function showModeEl(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode').forEach(el => el.classList.remove('active'));
  const id = modeElId(mode);
  if (id) $(id).classList.add('active');
  if (isEl) {
    window.tt.setMode(mode);
    // onMode callback handles updateStats/renderTimeline for Electron
  } else {
    if (mode === 'full') { updateStats(); renderTimeline(); }
  }
}

// ── pre-start form ────────────────────────────────────────────────────────────
function openPreStartForm() {
  $('psTask').value = '';
  $('psCategory').value = timerState.category || '';
  refreshCatDatalist('psCatList');
  showModeEl('pre_start');
  setTimeout(() => $('psTask').focus(), 200);
}

function submitPreStart() {
  const task     = $('psTask').value.trim();
  const category = $('psCategory').value.trim();
  timerBegin(task, category);
}

// ── timer actions ─────────────────────────────────────────────────────────────
function timerBegin(task, category) {
  const now = Date.now();
  timerState = {
    status: 'running',
    startedAt: now,
    currentRunStartedAt: now,
    elapsedBeforeCurrentRun: 0,
    plannedTask: task || '',
    category: category || '',
  };
  saveTimerState();
  if (!timerInterval) timerInterval = setInterval(tickUI, 1000);
  tickUI();
  showModeEl('compact');
}

function timerPause() {
  if (timerState.status !== 'running') return;
  timerState = {
    ...timerState,
    status: 'paused',
    elapsedBeforeCurrentRun: elapsed(),
    currentRunStartedAt: null,
  };
  saveTimerState();
  clearInterval(timerInterval);
  timerInterval = null;
  tickUI();
}

function timerResume() {
  if (timerState.status !== 'paused') return;
  timerState = {
    ...timerState,
    status: 'running',
    currentRunStartedAt: Date.now(),
  };
  saveTimerState();
  if (!timerInterval) timerInterval = setInterval(tickUI, 1000);
  tickUI();
}

function timerStop() {
  if (timerState.status === 'idle') return;
  const dur = elapsed();
  const endedAt = Date.now();
  clearInterval(timerInterval);
  timerInterval = null;

  const startedAt = timerState.startedAt || endedAt - dur * 1000;
  pendingSession = {
    startedAt,
    endedAt,
    duration: dur,
    date: new Date(startedAt).toISOString().slice(0, 10),
    plannedTask: timerState.plannedTask || '',
    category: timerState.category || '',
  };

  timerState = {
    status: 'idle',
    startedAt: null,
    currentRunStartedAt: null,
    elapsedBeforeCurrentRun: 0,
    plannedTask: '',
    category: '',
  };
  saveTimerState();
  pendingScreenshots = [];
  openSessionEndForm(dur);
}

// ── session end form ──────────────────────────────────────────────────────────
function openSessionEndForm(dur) {
  $('seDur').textContent = fmtDur(dur);
  $('seNote').value = '';
  $('seCategory').value = pendingSession?.category || '';
  $('seThumbs').innerHTML = '';
  pendingScreenshots = [];

  const task = pendingSession?.plannedTask || '';
  $('sePlanned').style.display = task ? '' : 'none';
  $('sePlannedText').textContent = task;

  refreshCatDatalist('seCatList');
  showModeEl('session_end');
  setTimeout(() => $('seNote').focus(), 200);
}

async function saveSessionEnd(action) {
  if (action === 'discard') {
    if (!confirm('Не зберігати цю сесію? Час буде втрачено.')) return;
    pendingSession = null;
    pendingScreenshots = [];
    await tickUI();
    showModeEl('compact');
    return;
  }
  if (!pendingSession) { showModeEl('compact'); return; }

  const resultNote = action === 'save' ? $('seNote').value.trim() : '';
  const category   = action === 'save'
    ? ($('seCategory').value.trim() || pendingSession.category || '')
    : (pendingSession.category || '');

  const sessionId = await saveSession({ ...pendingSession, resultNote, category });
  for (const sc of pendingScreenshots) {
    await saveScreenshot({
      sessionId,
      dataUrl: sc.dataUrl,
      caption: sc.caption || '',
      name: sc.file?.name || `screenshot-${Date.now()}.png`,
    });
  }
  pendingSession = null;
  pendingScreenshots = [];
  await tickUI();
  showModeEl('compact');
}

// ── category datalist ─────────────────────────────────────────────────────────
async function refreshCatDatalist(id = 'seCatList') {
  try {
    const sessions = await getAllSessions();
    const cats = [...new Set(sessions.map(s => s.category).filter(Boolean))].sort();
    const el = $(id);
    if (el) el.innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  } catch (_) {}
}

// ── screenshot handling (session end form) ────────────────────────────────────
function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = e => {
      pendingScreenshots.push({ file: f, dataUrl: e.target.result, caption: '' });
      renderThumbs();
    };
    reader.readAsDataURL(f);
  }
}

function flashDrop() {
  const d = $('seDrop');
  if (!d) return;
  d.classList.add('flash');
  setTimeout(() => d.classList.remove('flash'), 600);
}

function renderThumbs() {
  $('seThumbs').innerHTML = pendingScreenshots.map((sc, i) => `
    <div class="se-thumb-item">
      <img class="se-thumb-img" src="${sc.dataUrl}"/>
      <button class="se-thumb-rm" data-i="${i}">×</button>
      <input class="se-thumb-cap" type="text" placeholder="підпис…" value="${esc(sc.caption)}" data-i="${i}"/>
    </div>`).join('');
  $('seThumbs').querySelectorAll('.se-thumb-rm').forEach(b =>
    b.onclick = () => { pendingScreenshots.splice(+b.dataset.i, 1); renderThumbs(); });
  $('seThumbs').querySelectorAll('.se-thumb-cap').forEach(inp =>
    inp.oninput = () => { pendingScreenshots[+inp.dataset.i].caption = inp.value; });
}

// ── screenshot handling (drawer edit) ────────────────────────────────────────
function addEditFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = e => {
      editPendingScreenshots.push({ file: f, dataUrl: e.target.result, caption: '' });
      renderEditPending();
    };
    reader.readAsDataURL(f);
  }
}

function renderEditPending() {
  const c = $('drEditPending');
  if (!c) return;
  c.innerHTML = editPendingScreenshots.map((sc, i) => `
    <div class="dr-edit-screen-wrap pending">
      <img class="dr-edit-screen-img pending-img" src="${sc.dataUrl}"/>
      <input class="dr-edit-cap" type="text" placeholder="підпис…" value="${esc(sc.caption)}" data-pi="${i}"/>
      <button class="dr-edit-del-sc" data-pi="${i}">×</button>
    </div>`).join('');
  c.querySelectorAll('.dr-edit-del-sc').forEach(btn =>
    btn.onclick = () => { editPendingScreenshots.splice(+btn.dataset.pi, 1); renderEditPending(); });
  c.querySelectorAll('.dr-edit-cap').forEach(inp =>
    inp.oninput = () => { if (editPendingScreenshots[+inp.dataset.pi]) editPendingScreenshots[+inp.dataset.pi].caption = inp.value; });
}

// ── paste handler ─────────────────────────────────────────────────────────────
function pasteFromClipboard(e) {
  const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
  if (!items.length) return;

  if (currentMode === 'session_end') {
    e.preventDefault();
    items.forEach(item => {
      const blob = item.getAsFile();
      const ext  = item.type === 'image/png' ? 'png' : (item.type.split('/')[1] || 'png');
      const reader = new FileReader();
      reader.onload = ev => {
        pendingScreenshots.push({ file: { name: `screenshot-${Date.now()}.${ext}` }, dataUrl: ev.target.result, caption: '' });
        renderThumbs();
        flashDrop();
      };
      reader.readAsDataURL(blob);
    });
  } else if (drawerEditMode && drawerOpenSessionId) {
    e.preventDefault();
    items.forEach(item => {
      const blob = item.getAsFile();
      const ext  = item.type === 'image/png' ? 'png' : (item.type.split('/')[1] || 'png');
      const reader = new FileReader();
      reader.onload = ev => {
        editPendingScreenshots.push({ file: { name: `screenshot-${Date.now()}.${ext}` }, dataUrl: ev.target.result, caption: '' });
        renderEditPending();
      };
      reader.readAsDataURL(blob);
    });
  }
}

// ── UI tick ───────────────────────────────────────────────────────────────────
async function tickUI() {
  const e   = elapsed();
  const clk = fmtClock(e);
  const st  = timerState.status;
  const task = timerState.plannedTask || '';

  // Compact widget
  $('cwTime').textContent = clk;
  $('cwTime').className   = 'cw-time' + (st === 'running' ? ' running' : '');
  $('cwDot').className    = 'cw-dot ' + (st === 'running' ? 'running' : st === 'paused' ? 'paused' : 'ready');
  $('cwStatus').className = 'cw-status' + (st === 'running' ? ' running' : st === 'paused' ? ' paused' : '');
  $('cwStatus').textContent = st === 'running' ? 'Працює' : st === 'paused' ? 'Пауза' : 'Готовий';

  $('cwPlay').style.display   = st === 'idle'    ? '' : 'none';
  $('cwPause').style.display  = st === 'running' ? '' : 'none';
  $('cwResume').style.display = st === 'paused'  ? '' : 'none';
  $('cwStop').style.display   = st !== 'idle'    ? '' : 'none';

  // Compact task bar
  const tdot  = $('cwTaskDot');
  const ttext = $('cwTaskText');
  if (st === 'idle') {
    tdot.className  = 'cw-task-dot';
    ttext.className = 'cw-task-text hint';
    ttext.textContent = 'Натисни ▶ щоб почати';
  } else {
    tdot.className  = 'cw-task-dot ' + st;
    ttext.className = 'cw-task-text';
    ttext.textContent = task || '…';
  }

  // Full mode mini-timer
  $('fvTimeSm').textContent = clk;
  $('fvDot').className = 'fv-dot' + (st === 'running' ? ' running' : st === 'paused' ? ' paused' : '');
  $('fvPlay').style.display   = st === 'idle'    ? '' : 'none';
  $('fvPause').style.display  = st === 'running' ? '' : 'none';
  $('fvResume').style.display = st === 'paused'  ? '' : 'none';
  $('fvStop').style.display   = st !== 'idle'    ? '' : 'none';

  const fvTask = $('fvTaskSm');
  fvTask.textContent = task;
  fvTask.style.display = task ? '' : 'none';

  await updateStats();
}

// ── stats ─────────────────────────────────────────────────────────────────────
async function updateStats() {
  const sessions = await getAllSessions();
  const todayStr = new Date().toISOString().slice(0, 10);
  const monStr   = new Date().toISOString().slice(0, 7);
  let todaySec = 0, monSec = 0, totalSec = 0;
  sessions.forEach(s => {
    const d = s.duration || 0;
    totalSec += d;
    const ds = (s.date || s.startedAt ? new Date(s.startedAt || s.date).toISOString().slice(0, 10) : '');
    if (ds.startsWith(todayStr)) todaySec += d;
    if (ds.startsWith(monStr))   monSec   += d;
  });
  const avg = sessions.length ? Math.round(totalSec / sessions.length) : 0;

  $('cwToday').textContent = fmtTotal(todaySec);
  $('fvToday').textContent = fmtTotal(todaySec);
  $('fvMonth').textContent = fmtTotal(monSec);
  $('fvCount').textContent = sessions.length;
  $('fvAvg').textContent   = sessions.length ? fmtDur(avg) : '—';
}

// ── timeline ──────────────────────────────────────────────────────────────────
async function renderTimeline() {
  const sessions  = await getAllSessions();
  const container = $('fvTimeline');

  const fMonth = $('fvFilterMonth').value;
  const fCat   = $('fvFilterCat').value;

  // Rebuild month filter
  const months = [...new Set(sessions.map(s => (s.date || '').slice(0, 7)))].sort().reverse();
  const mSel = $('fvFilterMonth'), mVal = mSel.value;
  mSel.innerHTML = '<option value="">Всі місяці</option>' +
    months.map(m => `<option value="${m}"${m === mVal ? ' selected' : ''}>${monthLabel(m)}</option>`).join('');

  // Rebuild category filter
  const cats = [...new Set(sessions.map(s => s.category).filter(Boolean))].sort();
  const cSel = $('fvFilterCat'), cVal = cSel.value;
  cSel.innerHTML = '<option value="">Всі категорії</option>' +
    cats.map(c => `<option value="${esc(c)}"${c === cVal ? ' selected' : ''}>${esc(c)}</option>`).join('');

  let filtered = sessions;
  if (fMonth) filtered = filtered.filter(s => (s.date || '').startsWith(fMonth));
  if (fCat)   filtered = filtered.filter(s => s.category === fCat);

  if (!filtered.length) {
    container.innerHTML = `<div class="tl-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="48" height="48">
        <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
      </svg>
      <div>Ще немає сесій</div>
      <div style="font-size:12px;opacity:.5">Натисни ▶ і почни відлік</div>
    </div>`;
    return;
  }

  // Group month → day
  const byMonth = {};
  filtered.forEach(s => {
    const m = (s.date || '').slice(0, 7);
    const d = (s.date || '').slice(0, 10);
    if (!byMonth[m]) byMonth[m] = {};
    if (!byMonth[m][d]) byMonth[m][d] = [];
    byMonth[m][d].push(s);
  });

  const html = Object.keys(byMonth).sort().reverse().map((m, mi) => {
    const mSec = Object.values(byMonth[m]).flat().reduce((a, s) => a + (s.duration || 0), 0);
    const days = Object.keys(byMonth[m]).sort().reverse().map((d, di) => {
      const daySess = byMonth[m][d];
      const dSec = daySess.reduce((a, s) => a + (s.duration || 0), 0);
      const sessRows = daySess.map(s => {
        const startedAt = s.startedAt || s.startTs || new Date(s.date).getTime();
        const endedAt   = s.endedAt   || startedAt + (s.duration || 0) * 1000;
        const start = new Date(startedAt);
        const end   = new Date(endedAt);
        const ss = start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        const es = end.toLocaleTimeString('uk-UA',   { hour: '2-digit', minute: '2-digit' });

        // Display text priority: resultNote → note → plannedTask → empty
        const displayText = s.resultNote || s.note || s.plannedTask || '';
        const hasNote = !!(s.resultNote || s.note);
        const hasPlan = !!s.plannedTask;

        return `<div class="tl-sess${s.id === drawerOpenSessionId ? ' active' : ''}" data-sid="${s.id}">
          <span class="tl-sess-time">${ss} – ${es}</span>
          ${s.category ? `<span class="tl-sess-cat">${esc(s.category)}</span>` : ''}
          <span class="tl-sess-note">${esc(displayText || '—')}</span>
          <div class="tl-badges">
            ${hasPlan ? `<span class="tl-act-badge has-plan" title="Задача">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
            </span>` : ''}
            ${hasNote ? `<span class="tl-act-badge has-note" title="Підсумок">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
            </span>` : ''}
            <span class="tl-act-badge has-screens" id="badge-${s.id}" style="display:none">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              <span id="badge-count-${s.id}">0</span>
            </span>
          </div>
          <div class="tl-row-btns">
            <button class="tl-row-btn tl-edit-btn" data-sid="${s.id}" title="Редагувати">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="tl-row-btn tl-del-btn" data-sid="${s.id}" title="Видалити">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14a2,2 0,0,1-2,2H8a2,2 0,0,1-2,-2L5,6"/><path d="M10,11v6M14,11v6"/><path d="M9,6V4a1,1,0,0,1,1,-1h4a1,1,0,0,1,1,1V6"/></svg>
            </button>
          </div>
          <span class="tl-sess-dur">${fmtDur(s.duration || 0)}</span>
        </div>`;
      }).join('');

      const isFirstDay = di === 0 && mi === 0;
      return `<div class="tl-day">
        <div class="tl-day-head" data-day="${d}">
          <span class="tl-day-arrow${isFirstDay ? ' open' : ''}">▶</span>
          <span class="tl-day-name">${dayLabel(d)}</span>
          <span class="tl-day-meta">${daySess.length} сес.</span>
          <span class="tl-day-dur">${fmtDur(dSec)}</span>
        </div>
        <div class="tl-day-body${isFirstDay ? ' open' : ''}">${sessRows}</div>
      </div>`;
    }).join('');

    const isFirstMonth = mi === 0;
    return `<div class="tl-month">
      <div class="tl-month-head" data-month="${m}">
        <span class="tl-month-arrow${isFirstMonth ? ' open' : ''}">▶</span>
        <span class="tl-month-name">${monthLabel(m)}</span>
        <span class="tl-month-dur">${fmtTotal(mSec)}</span>
      </div>
      <div class="tl-month-body${isFirstMonth ? ' open' : ''}">${days}</div>
    </div>`;
  }).join('');

  container.innerHTML = html;
  bindTimelineEvents();
  loadBadges(filtered);
}

async function loadBadges(sessions) {
  for (const s of sessions) {
    const badge = $(`badge-${s.id}`);
    if (!badge) continue;
    const screens = await getScreenshotsBySession(s.id);
    if (screens.length) {
      badge.style.display = '';
      const cnt = $(`badge-count-${s.id}`);
      if (cnt) cnt.textContent = screens.length;
    }
  }
}

function bindTimelineEvents() {
  $('fvTimeline').querySelectorAll('.tl-month-head').forEach(h => {
    h.onclick = () => {
      h.nextElementSibling.classList.toggle('open');
      h.querySelector('.tl-month-arrow').classList.toggle('open');
    };
  });
  $('fvTimeline').querySelectorAll('.tl-day-head').forEach(h => {
    h.onclick = () => {
      h.nextElementSibling.classList.toggle('open');
      h.querySelector('.tl-day-arrow').classList.toggle('open');
    };
  });
  // Row click → view mode drawer (only blocked by row-action buttons)
  $('fvTimeline').querySelectorAll('.tl-sess').forEach(el => {
    el.onclick = e => {
      if (e.target.closest('.tl-row-btns')) return;
      const sid = +el.dataset.sid;
      el.classList.add('click-flash');
      setTimeout(() => el.classList.remove('click-flash'), 300);
      openDrawer(sid, false);
    };
  });
  // Screenshot badge → open drawer + open lightbox at first photo
  $('fvTimeline').querySelectorAll('.tl-act-badge.has-screens').forEach(badge => {
    badge.onclick = async e => {
      e.stopPropagation();
      const sid = +badge.closest('.tl-sess').dataset.sid;
      await openDrawer(sid, false);
      setTimeout(() => { if (drawerScreenshots.length) openLightbox(0); }, 150);
    };
  });
  // Edit button → edit mode drawer
  $('fvTimeline').querySelectorAll('.tl-edit-btn').forEach(btn => {
    btn.onclick = e => { e.stopPropagation(); openDrawer(+btn.dataset.sid, true); };
  });
  // Delete button
  $('fvTimeline').querySelectorAll('.tl-del-btn').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Видалити цю сесію?')) return;
      const sid = +btn.dataset.sid;
      await deleteSession(sid);
      if (drawerOpenSessionId === sid) closeDrawer();
      await updateStats();
      await renderTimeline();
    };
  });
}

// ── drawer: view mode ─────────────────────────────────────────────────────────
async function openDrawer(sessionId, inEditMode = false) {
  try {
    drawerOpenSessionId = sessionId;

    const sessions = await getAllSessions();
    const s = sessions.find(x => x.id === sessionId);
    if (!s) { console.warn('openDrawer: session not found', sessionId); return; }

    const screens = await getScreenshotsBySession(sessionId);
    drawerScreenshots = screens;

    if (inEditMode) {
      renderDrawerEdit(s, screens);
      drawerEditMode = true;
      editPendingScreenshots = [];
      editDeletedIds = [];
      $('drawerTitle').textContent  = 'Редагування';
      $('drawerEditBtn').style.display   = 'none';
      $('drawerSaveBtn').style.display   = '';
      $('drawerCancelBtn').style.display = '';
    } else {
      renderDrawerView(s, screens);
      drawerEditMode = false;
      $('drawerTitle').textContent  = 'Деталі сесії';
      $('drawerEditBtn').style.display   = '';
      $('drawerSaveBtn').style.display   = 'none';
      $('drawerCancelBtn').style.display = 'none';
    }

    const drawer = $('fvDrawer');
    drawer.classList.add('open');
    // Flash so the user sees it opened
    drawer.classList.remove('drawer-flash');
    requestAnimationFrame(() => { requestAnimationFrame(() => drawer.classList.add('drawer-flash')); });
    setTimeout(() => drawer.classList.remove('drawer-flash'), 600);
    // Scroll drawer body to top
    const body = $('drawerBody');
    if (body) body.scrollTop = 0;

    $('fvTimeline').querySelectorAll('.tl-sess').forEach(el => {
      el.classList.toggle('active', +el.dataset.sid === sessionId);
    });
  } catch (err) {
    console.error('openDrawer error:', err);
  }
}

function renderDrawerView(s, screens) {
  const startedAt = s.startedAt || s.startTs || new Date(s.date).getTime();
  const endedAt   = s.endedAt   || startedAt + (s.duration || 0) * 1000;
  const start     = new Date(startedAt);
  const end       = new Date(endedAt);
  const dateStr   = start.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
  const startStr  = start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const endStr    = end.toLocaleTimeString('uk-UA',   { hour: '2-digit', minute: '2-digit' });

  const plannedTask = s.plannedTask || '';
  const resultNote  = s.resultNote  || s.note || '';

  const screensHtml = screens.length
    ? `<div class="dr-screens">
        ${screens.map((sc, i) => `
          <div class="dr-screen-card" data-i="${i}" data-scid="${sc.id}">
            <div class="dr-screen-thumb" data-i="${i}">
              <img class="dr-screen-img" src="${sc.dataUrl}" alt="" data-i="${i}"/>
              <div class="dr-screen-overlay" data-i="${i}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </div>
            </div>
            ${sc.caption ? `<div class="dr-screen-cap">${esc(sc.caption)}</div>` : ''}
            <div class="dr-screen-actions">
              <button class="dr-screen-action-btn dr-screen-dl" data-i="${i}" title="Завантажити">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                Зберегти
              </button>
              <button class="dr-screen-action-btn dr-screen-rm" data-i="${i}" data-scid="${sc.id}" title="Видалити">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14a2,2 0,0,1-2,2H8a2,2 0,0,1-2,-2L5,6"/></svg>
                Видалити
              </button>
            </div>
          </div>`).join('')}
      </div>`
    : `<div class="dr-no-screens">Немає скріншотів</div>`;

  $('drawerBody').innerHTML = `
    ${plannedTask ? `
    <div class="dr-field">
      <div class="dr-label">Задача (план)</div>
      <div class="dr-planned-text">${esc(plannedTask)}</div>
    </div>` : ''}
    <div class="dr-field">
      <div class="dr-label">Підсумок</div>
      ${resultNote
        ? `<div class="dr-note-text">${esc(resultNote)}</div>`
        : '<div class="dr-no-note">Опис не додано</div>'}
    </div>
    ${s.category ? `
    <div class="dr-field">
      <div class="dr-label">Категорія</div>
      <span class="dr-cat-chip">${esc(s.category)}</span>
    </div>` : ''}
    <div class="dr-field">
      <div class="dr-label">Час</div>
      <div class="dr-time-range">${startStr} – ${endStr}</div>
      <div class="dr-duration">${dateStr} · ${fmtDur(s.duration || 0)}</div>
    </div>
    <div class="dr-field">
      <div class="dr-label">Скріншоти (${screens.length})</div>
      ${screensHtml}
      <button class="dr-add-screen-btn" id="drAddScreenBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Додати скріншот
      </button>
    </div>
    <button class="dr-del-btn" id="drDelBtn">Видалити сесію</button>
  `;

  // Click on image or overlay → lightbox
  $('drawerBody').querySelectorAll('.dr-screen-thumb, .dr-screen-overlay').forEach(el => {
    el.onclick = () => openLightbox(+el.dataset.i);
  });
  // Download button
  $('drawerBody').querySelectorAll('.dr-screen-dl').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const sc = drawerScreenshots[+btn.dataset.i];
      if (sc) downloadImg(sc.dataUrl, sc.name || 'screenshot.png');
    };
  });
  // Delete individual screenshot in view mode
  $('drawerBody').querySelectorAll('.dr-screen-rm').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Видалити цей скріншот?')) return;
      await deleteScreenshot(+btn.dataset.scid);
      // Refresh drawer
      const sid = drawerOpenSessionId;
      const allSessions = await getAllSessions();
      const sess = allSessions.find(x => x.id === sid);
      if (sess) {
        drawerScreenshots = await getScreenshotsBySession(sid);
        renderDrawerView(sess, drawerScreenshots);
      }
      await loadBadges(allSessions);
    };
  });
  // Add screenshot → switch to edit mode
  const addBtn = $('drAddScreenBtn');
  if (addBtn) {
    addBtn.onclick = () => {
      if (drawerOpenSessionId) openDrawer(drawerOpenSessionId, true);
    };
  }
  // Delete session
  const del = $('drDelBtn');
  if (del) {
    del.onclick = async () => {
      if (!confirm('Видалити цю сесію назавжди?')) return;
      await deleteSession(drawerOpenSessionId);
      drawerOpenSessionId = null;
      closeDrawer();
      await updateStats();
      await renderTimeline();
    };
  }
}

// ── drawer: edit mode ─────────────────────────────────────────────────────────
function renderDrawerEdit(s, screens) {
  const startedAt = s.startedAt || s.startTs || new Date(s.date).getTime();
  const endedAt   = s.endedAt   || startedAt + (s.duration || 0) * 1000;
  const startDate = new Date(startedAt);
  const endDate   = new Date(endedAt);
  const dateVal   = startDate.toISOString().slice(0, 10);

  const existingHtml = screens.map((sc, i) => `
    <div class="dr-edit-screen-wrap" data-scid="${sc.id}">
      <img class="dr-edit-screen-img" src="${sc.dataUrl}" data-i="${i}"/>
      <input class="dr-edit-cap" type="text" placeholder="підпис…" value="${esc(sc.caption||'')}" data-scid="${sc.id}"/>
      <button class="dr-edit-del-sc" data-scid="${sc.id}">×</button>
    </div>`).join('');

  $('drawerBody').innerHTML = `
    <div class="dr-edit-form">
      <div class="dr-field">
        <label class="dr-label">Задача (план)</label>
        <textarea id="drEditPlanned" class="dr-edit-textarea" rows="2">${esc(s.plannedTask||'')}</textarea>
      </div>
      <div class="dr-field">
        <label class="dr-label">Підсумок / результат</label>
        <textarea id="drEditResult" class="dr-edit-textarea" rows="3">${esc(s.resultNote||s.note||'')}</textarea>
      </div>
      <div class="dr-field">
        <label class="dr-label">Категорія</label>
        <input id="drEditCat" class="dr-edit-input" type="text" value="${esc(s.category||'')}" list="drEditCatList"/>
        <datalist id="drEditCatList"></datalist>
      </div>
      <div class="dr-field dr-field-row">
        <div class="dr-field-half">
          <label class="dr-label">Дата</label>
          <input id="drEditDate" class="dr-edit-input" type="date" value="${dateVal}"/>
        </div>
        <div class="dr-field-half">
          <label class="dr-label">Початок</label>
          <input id="drEditStart" class="dr-edit-input" type="time" value="${toTimeVal(startDate)}"/>
        </div>
        <div class="dr-field-half">
          <label class="dr-label">Кінець</label>
          <input id="drEditEnd" class="dr-edit-input" type="time" value="${toTimeVal(endDate)}"/>
        </div>
      </div>
      <div class="dr-field">
        <label class="dr-label">Скріншоти</label>
        <div class="dr-edit-screens" id="drEditScreens">${existingHtml}</div>
        <div class="dr-edit-drop" id="drEditDrop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          <label class="dr-edit-pick" for="drEditFileInput">Додати скріншоти</label> або Ctrl+V
          <input id="drEditFileInput" type="file" accept="image/*" multiple style="display:none"/>
        </div>
        <div id="drEditPending"></div>
      </div>
    </div>
  `;

  refreshCatDatalist('drEditCatList');

  // Existing screenshot events
  $('drawerBody').querySelectorAll('.dr-edit-del-sc').forEach(btn => {
    btn.onclick = () => {
      editDeletedIds.push(+btn.dataset.scid);
      btn.closest('.dr-edit-screen-wrap').remove();
    };
  });
  $('drawerBody').querySelectorAll('.dr-edit-screen-img').forEach(img => {
    img.onclick = () => openLightbox(+img.dataset.i);
  });
  $('drawerBody').querySelectorAll('.dr-edit-cap').forEach(inp => {
    inp.oninput = () => {
      const sc = drawerScreenshots.find(x => x.id === +inp.dataset.scid);
      if (sc) sc.caption = inp.value;
    };
  });

  // New screenshot picker
  const fi = $('drEditFileInput');
  fi.onchange = () => addEditFiles(fi.files);
  const drop = $('drEditDrop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addEditFiles(e.dataTransfer.files); };
}

async function saveDrawerEdit(sessionId) {
  const sessions = await getAllSessions();
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;

  const plannedTask = $('drEditPlanned')?.value.trim() || '';
  const resultNote  = $('drEditResult')?.value.trim()  || '';
  const category    = $('drEditCat')?.value.trim()     || '';
  const dateVal     = $('drEditDate')?.value || (s.date || '').slice(0, 10);
  const startTime   = $('drEditStart')?.value || '';
  const endTime     = $('drEditEnd')?.value   || '';

  // Reconstruct timestamps
  const startedAt0 = s.startedAt || s.startTs || new Date(s.date).getTime();
  const endedAt0   = s.endedAt   || startedAt0 + (s.duration || 0) * 1000;
  let startedAt = dateVal && startTime ? new Date(`${dateVal}T${startTime}:00`).getTime() : startedAt0;
  let endedAt   = dateVal && endTime   ? new Date(`${dateVal}T${endTime}:00`).getTime()   : endedAt0;
  if (endedAt <= startedAt) endedAt = startedAt + Math.max(s.duration || 60, 60) * 1000;

  const duration = Math.round((endedAt - startedAt) / 1000);
  const date     = new Date(startedAt).toISOString().slice(0, 10);

  // Delete removed screenshots
  for (const id of editDeletedIds) await deleteScreenshot(id);

  // Update captions for remaining existing screenshots
  for (const sc of drawerScreenshots) {
    if (!editDeletedIds.includes(sc.id)) await updateScreenshot(sc);
  }

  // Save new screenshots
  for (const sc of editPendingScreenshots) {
    await saveScreenshot({ sessionId, dataUrl: sc.dataUrl, caption: sc.caption || '', name: sc.file?.name || `screenshot-${Date.now()}.png` });
  }

  // Save updated session
  await updateSession({ ...s, plannedTask, resultNote, category, startedAt, endedAt, duration, date });

  editPendingScreenshots = [];
  editDeletedIds = [];
  drawerEditMode = false;

  await updateStats();
  await renderTimeline();
  await openDrawer(sessionId, false);
}

function closeDrawer() {
  $('fvDrawer').classList.remove('open');
  drawerOpenSessionId = null;
  drawerEditMode = false;
  drawerScreenshots = [];
  editPendingScreenshots = [];
  editDeletedIds = [];
  $('fvTimeline').querySelectorAll('.tl-sess.active').forEach(el => el.classList.remove('active'));
}

// ── lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(idx) {
  lbScreens = drawerScreenshots;
  lbIdx     = idx;
  renderLightboxFrame();
  $('lightbox').style.display = 'flex';
}

function renderLightboxFrame() {
  const sc    = lbScreens[lbIdx];
  const total = lbScreens.length;
  if (!sc) return;
  $('lbImg').src             = sc.dataUrl;
  $('lbCaption').textContent = sc.caption || '';
  $('lbCounter').textContent = `${lbIdx + 1} / ${total}`;
  $('lbDl').onclick          = () => downloadImg(sc.dataUrl, sc.name || 'screenshot.png');
  $('lbPrev').disabled       = lbIdx === 0;
  $('lbNext').disabled       = lbIdx === total - 1;
  // Delete button — remove this screenshot from DB and refresh
  $('lbDelBtn').onclick = async () => {
    if (!confirm('Видалити цей скріншот?')) return;
    const scid = sc.id;
    await deleteScreenshot(scid);
    // Remove from lbScreens
    lbScreens.splice(lbIdx, 1);
    drawerScreenshots = [...lbScreens];
    if (!lbScreens.length) {
      closeLightbox();
    } else {
      lbIdx = Math.min(lbIdx, lbScreens.length - 1);
      renderLightboxFrame();
    }
    // Refresh drawer view if open
    if (drawerOpenSessionId && !drawerEditMode) {
      const allSessions = await getAllSessions();
      const sess = allSessions.find(x => x.id === drawerOpenSessionId);
      if (sess) renderDrawerView(sess, drawerScreenshots);
      await loadBadges(allSessions);
    }
  };
}

function lbNavigate(dir) {
  const next = lbIdx + dir;
  if (next < 0 || next >= lbScreens.length) return;
  lbIdx = next;
  renderLightboxFrame();
}

function closeLightbox() {
  $('lightbox').style.display = 'none';
  lbScreens = [];
  lbIdx = 0;
}

// ── download ──────────────────────────────────────────────────────────────────
async function downloadImg(dataUrl, suggestedName) {
  if (isEl) {
    const [header] = dataUrl.split(',');
    const mime = (header.match(/:(.*?);/) || [])[1] || 'image/png';
    const ext  = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const name = (suggestedName || 'screenshot').replace(/\.[^.]+$/, '') + '.' + ext;
    try {
      const result = await window.tt.saveScreenshot(dataUrl, name);
      if (!result.success && !result.canceled) console.error('Save failed:', result.error);
    } catch (err) {
      console.error('Download error:', err);
    }
  } else {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = suggestedName || 'screenshot.png';
    a.click();
  }
}

// ── import ────────────────────────────────────────────────────────────────────
async function importFromJson(file) {
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    const sessions = data.sessions || data;
    if (!Array.isArray(sessions)) throw new Error('bad format');
    const count = await importSessions(sessions);
    await updateStats();
    await renderTimeline();
    alert(`✅ Імпортовано ${count} сесій`);
  } catch (e) {
    alert('❌ Помилка: ' + e.message);
  }
}

// ── init ──────────────────────────────────────────────────────────────────────
async function init() {
  await openDB();
  await loadTimerState();

  if (timerState.status === 'running') {
    timerInterval = setInterval(tickUI, 1000);
  }
  await tickUI();

  // Electron mode-changed callback (single source of truth for mode switch)
  if (isEl) {
    window.tt.onMode(mode => {
      currentMode = mode;
      document.querySelectorAll('.mode').forEach(el => el.classList.remove('active'));
      const id = modeElId(mode);
      if (id) $(id).classList.add('active');
      if (mode === 'full') { updateStats(); renderTimeline(); }
      if (mode === 'pre_start') {
        refreshCatDatalist('psCatList');
        setTimeout(() => { const el = $('psTask'); if (el) el.focus(); }, 200);
      }
    });
  }

  // ── Compact widget ──
  $('cwPlay').addEventListener('click', openPreStartForm);
  $('cwPause').addEventListener('click', timerPause);
  $('cwResume').addEventListener('click', timerResume);
  $('cwStop').addEventListener('click', timerStop);
  $('cwExpand').addEventListener('click', () => showModeEl('full'));
  $('cwQuit').addEventListener('click', () => isEl ? window.tt.quit() : window.close());

  // Dragging
  if (isEl) {
    const handle = $('dragHandle');
    let lx, ly, dragging = false;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      lx = e.screenX; ly = e.screenY; dragging = true;
      const mv = ev => {
        if (!dragging) return;
        window.tt.moveWidget(ev.screenX - lx, ev.screenY - ly);
        lx = ev.screenX; ly = ev.screenY;
      };
      const up = () => { dragging = false; removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
      addEventListener('mousemove', mv);
      addEventListener('mouseup', up);
    });
  }

  // ── Pre-start form ──
  $('psStart').addEventListener('click', submitPreStart);
  $('psCancel').addEventListener('click', () => showModeEl('compact'));
  $('psClose').addEventListener('click', () => showModeEl('compact'));
  $('psTask').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitPreStart();
  });

  // ── Session end form ──
  $('seSave').addEventListener('click', () => saveSessionEnd('save'));
  $('seSkip').addEventListener('click', () => saveSessionEnd('skip'));
  $('seDiscard').addEventListener('click', () => saveSessionEnd('discard'));

  const drop = $('seDrop'), fi = $('seFileInput');
  fi.addEventListener('change', () => addFiles(fi.files));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

  // ── Full view ──
  $('fvCollapse').addEventListener('click', () => showModeEl('compact'));
  $('fvQuit').addEventListener('click', () => isEl ? window.tt.quit() : window.close());
  $('fvPlay').addEventListener('click', openPreStartForm);
  $('fvPause').addEventListener('click', timerPause);
  $('fvResume').addEventListener('click', timerResume);
  $('fvStop').addEventListener('click', timerStop);
  $('fvFilterMonth').addEventListener('change', renderTimeline);
  $('fvFilterCat').addEventListener('change', renderTimeline);
  $('fvClear').addEventListener('click', async () => {
    if (!confirm('Видалити ВСЮ історію сесій?')) return;
    await clearAllSessions();
    await updateStats();
    await renderTimeline();
  });

  // ── Drawer ──
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerEditBtn').addEventListener('click', () => {
    if (drawerOpenSessionId) openDrawer(drawerOpenSessionId, true);
  });
  $('drawerSaveBtn').addEventListener('click', async () => {
    if (drawerOpenSessionId) await saveDrawerEdit(drawerOpenSessionId);
  });
  $('drawerCancelBtn').addEventListener('click', () => {
    if (drawerOpenSessionId) openDrawer(drawerOpenSessionId, false);
  });

  // ── Import ──
  const importBtn = $('fvImport'), importInp = $('importFileInput');
  importBtn.addEventListener('click', () => importInp.click());
  importInp.addEventListener('change', () => { if (importInp.files[0]) importFromJson(importInp.files[0]); });

  // ── Lightbox ──
  $('lbClose').addEventListener('click', closeLightbox);
  $('lbPrev').addEventListener('click', () => lbNavigate(-1));
  $('lbNext').addEventListener('click', () => lbNavigate(1));
  $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) closeLightbox(); });

  // ── Global shortcuts ──
  document.addEventListener('paste', pasteFromClipboard);

  document.addEventListener('keydown', e => {
    const lbVisible = $('lightbox').style.display !== 'none';
    if (lbVisible) {
      if (e.key === 'ArrowLeft')  { lbNavigate(-1); return; }
      if (e.key === 'ArrowRight') { lbNavigate(1);  return; }
      if (e.key === 'Escape')     { closeLightbox(); return; }
    }
    if (e.key === 'Escape') {
      if ($('fvDrawer').classList.contains('open')) closeDrawer();
      else if (currentMode === 'pre_start') showModeEl('compact');
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (currentMode === 'session_end') saveSessionEnd('save');
      else if (currentMode === 'pre_start') submitPreStart();
    }
  });
}

init();
