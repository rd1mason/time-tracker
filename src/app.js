import {
  openDB, saveSession, getAllSessions, deleteSession,
  clearAllSessions, saveScreenshot, getScreenshotsBySession,
  getState, setState, importSessions,
} from './db.js';

// ── helpers ─────────────────────────────
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
  const d = new Date(dateStr);
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', weekday: 'short' });
}
function monthLabel(ym) {
  return new Date(ym+'-01').toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── timer state ──────────────────────────
let timerState = { status: 'idle', startTs: null, elapsed: 0 };
let timerInterval = null;
let pendingSession = null;
let pendingScreenshots = [];  // [{file, dataUrl, caption}]
let activeSessionId = null;
let currentMode = 'compact';
let drawerScreenshots = [];   // screens loaded for currently open drawer
let lbScreens = [];           // screens in current lightbox gallery
let lbIdx     = 0;            // current gallery index

function elapsed() {
  let e = timerState.elapsed || 0;
  if (timerState.status === 'running' && timerState.startTs) {
    e += Math.floor((Date.now() - timerState.startTs) / 1000);
  }
  return e;
}

// ── persist ──────────────────────────────
async function saveTimerState() {
  try { await setState('timerState', timerState); } catch(_) {}
}
async function loadTimerState() {
  try {
    const s = await getState('timerState');
    if (!s) return;
    timerState = s;
    if (timerState.status === 'running' && timerState.startTs) {
      timerState.elapsed = (timerState.elapsed||0) + Math.floor((Date.now()-timerState.startTs)/1000);
      timerState.startTs = Date.now();
    }
  } catch(_) {}
}

// ── timer actions ────────────────────────
function timerStart() {
  if (timerState.status === 'idle') {
    timerState = { status: 'running', startTs: Date.now(), elapsed: 0 };
  } else if (timerState.status === 'paused') {
    timerState = { ...timerState, status: 'running', startTs: Date.now() };
  }
  saveTimerState();
  if (!timerInterval) timerInterval = setInterval(tickUI, 1000);
  tickUI();
}
function timerPause() {
  if (timerState.status !== 'running') return;
  timerState = { ...timerState, status: 'paused', elapsed: elapsed(), startTs: null };
  saveTimerState();
  clearInterval(timerInterval); timerInterval = null;
  tickUI();
}
function timerStop() {
  if (timerState.status === 'idle') return;
  const dur = elapsed();
  clearInterval(timerInterval); timerInterval = null;
  pendingSession = { startTs: timerState.startTs || Date.now(), duration: dur, date: new Date().toISOString() };
  timerState = { status: 'idle', startTs: null, elapsed: 0 };
  saveTimerState();
  pendingScreenshots = [];
  openSessionEndForm(dur);
}

// ── mode switching ───────────────────────
function showMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode').forEach(el => el.classList.remove('active'));
  $(`mode${mode.charAt(0).toUpperCase()+mode.slice(1).replace('_e','E').replace('e','E')}`).classList.add('active');

  if (isEl) window.tt.setMode(mode === 'session_end' ? 'session_end' : mode === 'full' ? 'full' : 'compact');

  if (mode === 'full') renderTimeline();
}

// Map mode string to element id
function modeElId(mode) {
  if (mode === 'compact')     return 'modeCompact';
  if (mode === 'session_end') return 'modeSessionEnd';
  if (mode === 'full')        return 'modeFull';
}
function showModeEl(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode').forEach(el => el.classList.remove('active'));
  $(modeElId(mode)).classList.add('active');
  if (isEl) {
    window.tt.setMode(mode);
    // onMode callback handles updateStats/renderTimeline for Electron
  } else {
    if (mode === 'full') { updateStats(); renderTimeline(); }
  }
}

// ── session end form ─────────────────────
function openSessionEndForm(dur) {
  $('seDur').textContent = fmtDur(dur);
  $('seNote').value = '';
  $('seCategory').value = '';
  $('seThumbs').innerHTML = '';
  pendingScreenshots = [];
  refreshCatDatalist();
  showModeEl('session_end');
  setTimeout(() => $('seNote').focus(), 200);
}

async function refreshCatDatalist() {
  const sessions = await getAllSessions();
  const cats = [...new Set(sessions.map(s=>s.category).filter(Boolean))];
  $('seCatList').innerHTML = cats.map(c=>`<option value="${esc(c)}">`).join('');
}

async function saveSessionEnd(withData) {
  if (!pendingSession) { showModeEl('compact'); return; }
  const note     = withData ? $('seNote').value.trim() : '';
  const category = withData ? $('seCategory').value.trim() : '';
  const sessionId = await saveSession({ ...pendingSession, note, category });
  for (const sc of pendingScreenshots) {
    await saveScreenshot({ sessionId, dataUrl: sc.dataUrl, caption: sc.caption, name: sc.file.name });
  }
  pendingSession = null;
  pendingScreenshots = [];
  tickUI();
  showModeEl('compact');
}

// ── screenshot handling ──────────────────
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

function pasteFromClipboard(e) {
  if (currentMode !== 'session_end') return;
  const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
  if (!items.length) return;
  e.preventDefault();
  items.forEach(item => {
    const blob = item.getAsFile();
    const ext  = item.type === 'image/png' ? 'png' : item.type.split('/')[1] || 'png';
    const name = `screenshot-${Date.now()}.${ext}`;
    const reader = new FileReader();
    reader.onload = ev => {
      pendingScreenshots.push({ file: { name }, dataUrl: ev.target.result, caption: '' });
      renderThumbs();
      flashDrop();
    };
    reader.readAsDataURL(blob);
  });
}

function flashDrop() {
  const d = $('seDrop');
  d.classList.add('flash');
  setTimeout(() => d.classList.remove('flash'), 600);
}
function renderThumbs() {
  $('seThumbs').innerHTML = pendingScreenshots.map((sc, i) => `
    <div class="se-thumb-item" data-i="${i}">
      <img class="se-thumb-img" src="${sc.dataUrl}" />
      <button class="se-thumb-rm" data-i="${i}">×</button>
      <input class="se-thumb-cap" type="text" placeholder="підпис…" value="${esc(sc.caption)}" data-i="${i}" />
    </div>`).join('');
  $('seThumbs').querySelectorAll('.se-thumb-rm').forEach(b =>
    b.addEventListener('click', () => { pendingScreenshots.splice(+b.dataset.i,1); renderThumbs(); }));
  $('seThumbs').querySelectorAll('.se-thumb-cap').forEach(inp =>
    inp.addEventListener('input', () => { pendingScreenshots[+inp.dataset.i].caption = inp.value; }));
}

// ── UI tick ──────────────────────────────
async function tickUI() {
  const e = elapsed();
  const clk = fmtClock(e);
  const st  = timerState.status;

  // compact widget buttons
  $('cwTime').textContent = clk;
  $('cwTime').className   = 'cw-time' + (st==='running'?' running':'');
  const dot = $('cwDot'), cst = $('cwStatus');
  dot.className   = 'cw-dot ' + (st==='running'?'running':st==='paused'?'paused':'ready');
  cst.className   = 'cw-status' + (st==='running'?' running':st==='paused'?' paused':'');
  cst.textContent = st==='running'?'Працює':st==='paused'?'Пауза':'Готовий';
  $('cwPlay').style.display   = st==='idle'   ? '' : 'none';   // Старт — тільки idle
  $('cwPause').style.display  = st==='running' ? '' : 'none';  // Пауза — тільки running
  $('cwResume').style.display = st==='paused'  ? '' : 'none';  // Продовжити — тільки paused
  $('cwStop').style.display   = st!=='idle'    ? '' : 'none';  // Завершити — running або paused

  // full mode mini-timer
  $('fvTimeSm').textContent = clk;
  const fvd = $('fvDot');
  fvd.className = 'fv-dot' + (st==='running'?' running':st==='paused'?' paused':'');
  $('fvPlay').style.display  = st==='idle'    ? '' : 'none';
  $('fvPause').style.display = st==='running' ? '' : 'none';
  $('fvStop').style.display  = st!=='idle'    ? '' : 'none';

  await updateStats();
}

async function updateStats() {
  const sessions = await getAllSessions();
  const todayStr = new Date().toISOString().slice(0,10);
  const monStr   = new Date().toISOString().slice(0,7);
  let todaySec=0, monSec=0, totalSec=0;
  sessions.forEach(s => {
    const d = s.duration||0;
    totalSec += d;
    if ((s.date||'').startsWith(todayStr)) todaySec += d;
    if ((s.date||'').startsWith(monStr))   monSec   += d;
  });
  const avg = sessions.length ? Math.round(totalSec/sessions.length) : 0;

  $('cwToday').textContent = fmtTotal(todaySec);

  $('fvToday').textContent = fmtTotal(todaySec);
  $('fvMonth').textContent = fmtTotal(monSec);
  $('fvCount').textContent = sessions.length;
  $('fvAvg').textContent   = sessions.length ? fmtDur(avg) : '—';
}

// ── timeline rendering ───────────────────
async function renderTimeline() {
  const sessions  = await getAllSessions();
  const container = $('fvTimeline');

  // update filters
  const fMonth = $('fvFilterMonth').value;
  const fCat   = $('fvFilterCat').value;

  // rebuild month filter
  const months = [...new Set(sessions.map(s=>(s.date||'').slice(0,7)))].sort().reverse();
  const mSel = $('fvFilterMonth');
  const mVal = mSel.value;
  mSel.innerHTML = '<option value="">Всі місяці</option>' +
    months.map(m=>`<option value="${m}"${m===mVal?' selected':''}>${monthLabel(m)}</option>`).join('');

  // rebuild category filter
  const cats = [...new Set(sessions.map(s=>s.category).filter(Boolean))].sort();
  const cSel = $('fvFilterCat');
  const cVal = cSel.value;
  cSel.innerHTML = '<option value="">Всі категорії</option>' +
    cats.map(c=>`<option value="${esc(c)}"${c===cVal?' selected':''}>${esc(c)}</option>`).join('');

  let filtered = sessions;
  if (fMonth) filtered = filtered.filter(s=>(s.date||'').startsWith(fMonth));
  if (fCat)   filtered = filtered.filter(s=>s.category===fCat);

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

  // group month → day
  const byMonth = {};
  filtered.forEach(s => {
    const m = (s.date||'').slice(0,7);
    const d = (s.date||'').slice(0,10);
    if (!byMonth[m]) byMonth[m] = {};
    if (!byMonth[m][d]) byMonth[m][d] = [];
    byMonth[m][d].push(s);
  });

  const html = Object.keys(byMonth).sort().reverse().map((m, mi) => {
    const mSec = Object.values(byMonth[m]).flat().reduce((a,s)=>a+(s.duration||0),0);
    const days = Object.keys(byMonth[m]).sort().reverse().map((d, di) => {
      const daySess = byMonth[m][d];
      const dSec = daySess.reduce((a,s)=>a+(s.duration||0),0);
      const sessRows = daySess.map(s => {
        const start = new Date(s.date);
        const ss = start.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
        const es = new Date(start.getTime()+(s.duration||0)*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
        const hasNote = s.note && s.note.trim();
        return `<div class="tl-sess${s.id===activeSessionId?' active':''}" data-sid="${s.id}">
          <span class="tl-sess-time">${ss} – ${es}</span>
          ${s.category ? `<span class="tl-sess-cat">${esc(s.category)}</span>` : ''}
          <span class="tl-sess-note">${esc(hasNote ? s.note : '—')}</span>
          <div class="tl-sess-actions">
            ${hasNote ? `<span class="tl-act-badge has-note" title="Є опис">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
            </span>` : ''}
            <span class="tl-act-badge" id="badge-${s.id}" title="Скріншоти" style="display:none">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              <span id="badge-count-${s.id}">0</span>
            </span>
          </div>
          <span class="tl-sess-dur">${fmtDur(s.duration||0)}</span>
        </div>`;
      }).join('');

      const isFirstDay = di===0 && mi===0;
      return `<div class="tl-day">
        <div class="tl-day-head" data-day="${d}">
          <span class="tl-day-arrow${isFirstDay?' open':''}">▶</span>
          <span class="tl-day-name">${dayLabel(d)}</span>
          <span class="tl-day-meta">${daySess.length} сес.</span>
          <span class="tl-day-dur">${fmtDur(dSec)}</span>
        </div>
        <div class="tl-day-body${isFirstDay?' open':''}">${sessRows}</div>
      </div>`;
    }).join('');

    const isFirstMonth = mi===0;
    return `<div class="tl-month">
      <div class="tl-month-head" data-month="${m}">
        <span class="tl-month-arrow${isFirstMonth?' open':''}">▶</span>
        <span class="tl-month-name">${monthLabel(m)}</span>
        <span class="tl-month-dur">${fmtTotal(mSec)}</span>
      </div>
      <div class="tl-month-body${isFirstMonth?' open':''}">${days}</div>
    </div>`;
  }).join('');

  container.innerHTML = html;
  bindTimelineEvents();
  loadBadges(filtered);
}

async function loadBadges(sessions) {
  for (const s of sessions) {
    const badge = $(`badge-${s.id}`);
    const count = $(`badge-count-${s.id}`);
    if (!badge) continue;
    const screens = await getScreenshotsBySession(s.id);
    if (screens.length) {
      badge.style.display = '';
      badge.classList.add('has-screens');
      if (count) count.textContent = screens.length;
    }
  }
}

function bindTimelineEvents() {
  $('fvTimeline').querySelectorAll('.tl-month-head').forEach(h => {
    h.addEventListener('click', () => {
      h.nextElementSibling.classList.toggle('open');
      h.querySelector('.tl-month-arrow').classList.toggle('open');
    });
  });
  $('fvTimeline').querySelectorAll('.tl-day-head').forEach(h => {
    h.addEventListener('click', () => {
      h.nextElementSibling.classList.toggle('open');
      h.querySelector('.tl-day-arrow').classList.toggle('open');
    });
  });
  $('fvTimeline').querySelectorAll('.tl-sess').forEach(el => {
    el.onclick = () => {
      const sid = +el.dataset.sid;
      el.classList.add('click-flash');
      setTimeout(() => el.classList.remove('click-flash'), 300);
      openDrawer(sid);
    };
  });
}

// ── session drawer ───────────────────────
async function openDrawer(sessionId) {
  activeSessionId = sessionId;
  const sessions = await getAllSessions();
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;

  const screens = await getScreenshotsBySession(sessionId);
  const start = new Date(s.date);
  const startStr = start.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
  const endStr   = new Date(start.getTime()+(s.duration||0)*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
  const dateStr  = start.toLocaleDateString('uk-UA',{day:'numeric',month:'long',year:'numeric'});

  drawerScreenshots = screens;   // store for download/lightbox — no base64 in attributes

  const screensHtml = screens.length ? `
    <div class="dr-field">
      <div class="dr-label">Скріншоти (${screens.length})</div>
      <div class="dr-screens">
        ${screens.map((sc, i) => `
          <div class="dr-screen-wrap">
            <img class="dr-screen-img" src="${sc.dataUrl}" alt="${esc(sc.caption)}" data-i="${i}"/>
            <div class="dr-screen-cap">${esc(sc.caption||'')}</div>
            <button class="dr-screen-dl" data-i="${i}" title="Завантажити">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            </button>
          </div>`).join('')}
      </div>
    </div>` : `
    <div class="dr-field">
      <div class="dr-label">Скріншоти</div>
      <div class="dr-no-screens">Скріншоти не додавались.<br>Додай їх через перетягування або Ctrl+V при завершенні сесії.</div>
    </div>`;

  $('drawerBody').innerHTML = `
    <div class="dr-field">
      <div class="dr-label">Час</div>
      <div class="dr-time-range">${startStr} – ${endStr}</div>
      <div class="dr-duration">${dateStr} · ${fmtDur(s.duration||0)}</div>
    </div>
    ${s.category ? `
    <div class="dr-field">
      <div class="dr-label">Категорія</div>
      <span class="dr-cat-chip">${esc(s.category)}</span>
    </div>` : ''}
    <div class="dr-field">
      <div class="dr-label">Опис роботи</div>
      ${s.note ? `<div class="dr-note-text">${esc(s.note)}</div>` : '<div class="dr-no-note">Опис не додано</div>'}
    </div>
    ${screensHtml}
    <button class="dr-del-btn" id="drDelBtn">Видалити сесію</button>
  `;

  // screenshot events — reference drawerScreenshots by index, never store base64 in attributes
  $('drawerBody').querySelectorAll('.dr-screen-img').forEach(img => {
    img.addEventListener('click', () => openLightbox(+img.dataset.i));
  });
  $('drawerBody').querySelectorAll('.dr-screen-dl').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const sc = drawerScreenshots[+btn.dataset.i];
      if (sc) downloadImg(sc.dataUrl, sc.name || 'screenshot.png');
    });
  });
  $('drDelBtn').addEventListener('click', async () => {
    if (!confirm('Видалити цю сесію?')) return;
    await deleteSession(sessionId);
    activeSessionId = null;
    closeDrawer();
    await updateStats();
    await renderTimeline();
  });

  $('fvDrawer').classList.add('open');

  // highlight active
  $('fvTimeline').querySelectorAll('.tl-sess').forEach(el => {
    el.classList.toggle('active', +el.dataset.sid === sessionId);
  });
}

function closeDrawer() {
  $('fvDrawer').classList.remove('open');
  activeSessionId = null;
  drawerScreenshots = [];
  $('fvTimeline').querySelectorAll('.tl-sess.active').forEach(el => el.classList.remove('active'));
}

// ── lightbox gallery ──────────────────────
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
  $('lbImg').src            = sc.dataUrl;
  $('lbCaption').textContent = sc.caption || '';
  $('lbCounter').textContent = `${lbIdx + 1} / ${total}`;
  $('lbDl').onclick          = () => downloadImg(sc.dataUrl, sc.name || 'screenshot.png');
  $('lbPrev').disabled       = lbIdx === 0;
  $('lbNext').disabled       = lbIdx === total - 1;
}

function lbNavigate(dir) {
  const next = lbIdx + dir;
  if (next < 0 || next >= lbScreens.length) return;
  lbIdx = next;
  renderLightboxFrame();
}

function closeLightbox() {
  $('lightbox').style.display = 'none';
  lbScreens = []; lbIdx = 0;
}
function downloadImg(dataUrl, suggestedName) {
  if (isEl) {
    // Convert dataUrl → raw bytes and send to Electron's native save dialog
    const [header, b64] = dataUrl.split(',');
    const mime = (header.match(/:(.*?);/) || [])[1] || 'image/png';
    const ext  = mime.split('/')[1]?.replace('jpeg','jpg') || 'png';
    const name = suggestedName.replace(/\.[^.]+$/, '') + '.' + ext;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    window.tt.saveFile(name, Array.from(bytes));
  } else {
    const a = document.createElement('a');
    a.href = dataUrl; a.download = suggestedName; a.click();
  }
}

// ── import (from CRM JSON) ────────────────
async function importFromJson(file) {
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    const sessions = data.sessions || data; // support both formats
    if (!Array.isArray(sessions)) throw new Error('bad format');
    const count = await importSessions(sessions);
    await updateStats();
    await renderTimeline();
    alert(`✅ Імпортовано ${count} сесій`);
  } catch(e) {
    alert('❌ Помилка: ' + e.message);
  }
}

// ── event wiring ─────────────────────────
async function init() {
  await openDB();
  await loadTimerState();
  if (timerState.status === 'running') {
    timerInterval = setInterval(tickUI, 1000);
  }
  await tickUI();

  if (isEl) window.tt.onMode(mode => {
    currentMode = mode;
    document.querySelectorAll('.mode').forEach(el => el.classList.remove('active'));
    $(modeElId(mode)).classList.add('active');
    if (mode === 'full') { updateStats(); renderTimeline(); }
  });

  // Compact widget
  $('cwPlay').addEventListener('click', timerStart);
  $('cwPause').addEventListener('click', timerPause);
  $('cwResume').addEventListener('click', timerStart);   // resume = same as start
  $('cwStop').addEventListener('click', timerStop);
  $('cwExpand').addEventListener('click', () => showModeEl('full'));
  $('cwQuit').addEventListener('click', () => isEl ? window.tt.quit() : window.close());

  // Drag — whole .cw is the handle; skip if click was on a button
  if (isEl) {
    const handle = $('dragHandle');
    let lx, ly, dragging = false;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      lx = e.screenX; ly = e.screenY; dragging = true;
      const mv = ev => {
        if (!dragging) return;
        window.tt.moveWidget(ev.screenX-lx, ev.screenY-ly);
        lx = ev.screenX; ly = ev.screenY;
      };
      const up = () => { dragging = false; removeEventListener('mousemove',mv); removeEventListener('mouseup',up); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
  }

  // Session end form
  $('seSave').addEventListener('click', () => saveSessionEnd(true));
  $('seSkip').addEventListener('click', () => saveSessionEnd(false));

  const drop = $('seDrop'), fi = $('seFileInput');
  fi.addEventListener('change', () => addFiles(fi.files));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

  // Full view
  $('fvCollapse').addEventListener('click', () => showModeEl('compact'));
  $('fvQuit').addEventListener('click', () => isEl ? window.tt.quit() : window.close());
  $('fvPlay').addEventListener('click', timerStart);
  $('fvPause').addEventListener('click', timerPause);
  $('fvStop').addEventListener('click', timerStop);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('fvFilterMonth').addEventListener('change', renderTimeline);
  $('fvFilterCat').addEventListener('change', renderTimeline);
  $('fvClear').addEventListener('click', async () => {
    if (!confirm('Видалити ВСЮ історію сесій?')) return;
    await clearAllSessions(); await updateStats(); await renderTimeline();
  });

  // Import
  const importBtn = $('fvImport'), importInp = $('importFileInput');
  importBtn.addEventListener('click', () => importInp.click());
  importInp.addEventListener('change', () => { if(importInp.files[0]) importFromJson(importInp.files[0]); });

  // Lightbox gallery
  $('lbClose').addEventListener('click', closeLightbox);
  $('lbPrev').addEventListener('click', () => lbNavigate(-1));
  $('lbNext').addEventListener('click', () => lbNavigate(1));
  $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) closeLightbox(); });

  // Ctrl+V paste → pending screenshots
  document.addEventListener('paste', pasteFromClipboard);

  // Keyboard
  document.addEventListener('keydown', e => {
    const lbVisible = $('lightbox').style.display !== 'none';
    if (lbVisible) {
      if (e.key === 'ArrowLeft')  { lbNavigate(-1); return; }
      if (e.key === 'ArrowRight') { lbNavigate(1);  return; }
      if (e.key === 'Escape')     { closeLightbox(); return; }
    }
    if (e.key === 'Escape') {
      if ($('fvDrawer').classList.contains('open')) closeDrawer();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (currentMode === 'session_end') saveSessionEnd(true);
    }
  });
}

init();
