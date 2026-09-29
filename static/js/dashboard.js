/* Infinite dashboard logic — progress, goals, life sheet, daily quote.
   FIX (2026-09-29): year/month/week/quarter percentages now count the current
   day as elapsed (day-of-year/365 etc.), matching the elapsed/remaining day
   counters. The "pace" stat is now a true ratio of actual time passed vs the
   calendar-day average, so it reads ~1.00x of average instead of 8.93x. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const QUARTERS = ['Q1 / SPRING','Q2 / SUMMER','Q3 / AUTUMN','Q4 / WINTER'];
  const daysWord = (n) => (n === 1 ? ' Day' : ' Days');

  /* ---------------- time engine ---------------- */
  function yearInfo(now) {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear() + 1, 0, 1);
    const total = Math.round((end - start) / 864e5);
    const dayOfYear = Math.floor((now - start) / 864e5) + 1;
    const pct = (dayOfYear / total) * 100;              // current day counts as elapsed
    const elapsed = dayOfYear;
    const left = total - elapsed;
    const fracDays = (now - start) / 864e5;             // continuous, for pace only
    const pace = fracDays / (dayOfYear - 0.5);          // vs. midpoint of the current day
    return { pct, elapsed, left, total, dayOfYear, pace };
  }
  function monthInfo(now) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const total = Math.round((end - start) / 864e5);
    const dayOfMonth = now.getDate();                   // current day counts as elapsed
    const pct = (dayOfMonth / total) * 100;
    const elapsed = dayOfMonth;
    const left = total - elapsed;
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { pct, elapsed, left, total, name: MONTHS[now.getMonth()], nextName: MONTHS[next.getMonth()] };
  }
  function weekInfo(now) {
    const day = now.getDay();
    const sinceMon = (day + 6) % 7;
    const dayIndex = sinceMon + 1;                      // Monday = 1 ... Sunday = 7
    const pct = (dayIndex / 7) * 100;
    const elapsed = dayIndex;
    const left = 7 - dayIndex;
    // ISO week number
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 864e5) + 1) / 7);
    return { pct, elapsed, left, num: week };
  }

  function setDonut(circleEl, valEl, pct, color) {
    const r = 40, c = 2 * Math.PI * r;
    circleEl.style.strokeDasharray = String(c);
    circleEl.style.strokeDashoffset = String(c);
    circleEl.style.stroke = color;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        circleEl.style.strokeDashoffset = String(c * (1 - Math.min(100, pct) / 100));
      });
    });
    valEl.textContent = pct.toFixed(1).replace(/\.0$/, '') + '%';
  }

  function renderTime() {
    const now = new Date();
    const y = yearInfo(now), m = monthInfo(now), w = weekInfo(now);

    $('hero-year').textContent = now.getFullYear();
    $('hero-pct').textContent = y.pct.toFixed(2) + '%';
    $('hero-elapsed').textContent = y.elapsed;
    $('hero-left').textContent = y.left;
    $('hero-velocity').textContent = y.pace.toFixed(2) + '×';   // FIX: was pct/100*12 (=8.93x)

    $('yt-fill').style.width = y.pct + '%';
    $('yt-badge').textContent = y.pct.toFixed(2) + '%';
    const flag = $('today-flag');
    flag.style.left = Math.min(97, Math.max(3, y.pct)) + '%';
    $('today-lbl').textContent = MONTHS[now.getMonth()].toUpperCase() + ' ' + now.getDate();

    // month ticks
    const ticks = $('yt-ticks');
    ticks.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const t = document.createElement('span');
      t.className = 'tick' + (i === now.getMonth() ? ' now' : '');
      t.textContent = MONTHS[i].toUpperCase();
      ticks.appendChild(t);
    }

    // quarters — count the current day (Q3 on Sep 29 = 91/92, not 98%)
    const qWrap = $('quarters');
    qWrap.innerHTML = '';
    for (let q = 0; q < 4; q++) {
      const qs = new Date(now.getFullYear(), q * 3, 1);
      const qe = new Date(now.getFullYear(), q * 3 + 3, 1);
      const qTotal = Math.round((qe - qs) / 864e5);
      let qPct, qElapsed, state;
      if (now < qs) { qPct = 0; qElapsed = 0; state = ''; }
      else if (now >= qe) { qPct = 100; qElapsed = qTotal; state = 'done'; }
      else { qElapsed = Math.floor((now - qs) / 864e5) + 1; qPct = (qElapsed / qTotal) * 100; state = 'active'; }
      const card = document.createElement('div');
      card.className = 'q-card ' + state;
      card.innerHTML =
        '<div class="qh"><span>' + QUARTERS[q] + '</span><span class="st">' +
        (state === 'done' ? '<i class="fa-solid fa-circle-check"></i>' : state === 'active' ? Math.round(qPct) + '%' : '<i class="fa-solid fa-lock"></i>') +
        '</span></div>' +
        '<div class="qp"><b>' + qElapsed + ' / ' + qTotal + '</b> Days</div>' +
        '<div class="q-track"><div class="q-fill" style="width:' + qPct + '%"></div></div>';
      qWrap.appendChild(card);
    }

    setDonut($('donut-year'), $('dval-year'), y.pct, '#8f8ff0');
    setDonut($('donut-month'), $('dval-month'), m.pct, '#3ddc97');
    setDonut($('donut-week'), $('dval-week'), w.pct, '#f5b04a');

    $('cad-year-name').textContent = 'Year ' + now.getFullYear();
    $('y-elapsed').textContent = y.elapsed;
    $('y-left').textContent = y.left;
    $('y-left').nextSibling.textContent = daysWord(y.left);      // "1 Day" not "1 Days"
    $('y-weeks').textContent = Math.floor(y.dayOfYear / 7) + ' WEEKS DONE';
    $('cad-month-name').textContent = m.name + ' Finale';
    $('m-elapsed').textContent = m.elapsed;
    $('m-left').textContent = m.left;
    $('m-left').nextSibling.textContent = daysWord(m.left);
    $('m-next').textContent = m.nextName.toUpperCase() + ' STARTS NEXT';
    $('cad-week-name').textContent = 'Week ' + w.num + ' / 52';
    $('w-elapsed').textContent = w.elapsed;
    $('w-left').textContent = w.left;
    $('w-left').nextSibling.textContent = daysWord(w.left);
    $('w-dayname').textContent = now.toLocaleDateString(undefined, { weekday: 'long' });
    $('monthly-meta').textContent = m.name.toUpperCase() + ' GOALS';
    $('weekly-meta').textContent = 'WEEK ' + w.num + '';

    $('side-day').textContent = 'DAY ' + y.dayOfYear + ' / ' + y.total;
    $('side-year-fill').style.width = y.pct + '%';
    // Today's date (e.g. WED, 30 SEP 2026) — refreshed by renderTime() so it rolls over at midnight
    const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    $('epoch-lbl').textContent = DOW[now.getDay()] + ', ' + now.getDate() + ' ' + MON[now.getMonth()] + ' ' + now.getFullYear();
    const tzMin = -now.getTimezoneOffset();
    const sign = tzMin >= 0 ? '+' : '-';
    const abs = Math.abs(tzMin);
    $('tz-lbl').textContent = 'UTC' + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0') + ' · LOCAL';

    $('axiom-day').textContent = '· Day ' + y.dayOfYear;
  }

  function tickClock() {
    const now = new Date();
    $('utc-clock').textContent =
      String(now.getUTCHours()).padStart(2, '0') + ':' +
      String(now.getUTCMinutes()).padStart(2, '0') + ':' +
      String(now.getUTCSeconds()).padStart(2, '0') + ' UTC';
  }

  /* ---------------- axiom ---------------- */
  const QUOTES = [
    ['The trouble is, you think you have time.', 'Jack Kornfield'],
    ['You could be good today; instead you choose tomorrow.', 'Marcus Aurelius'],
    ['It is not that we have a short time to live, but that we waste a great deal of it.', 'Seneca'],
    ['Do not act as if you had ten thousand years to throw away.', 'Marcus Aurelius'],
    ['Begin at once to live, and count each separate day as a separate life.', 'Seneca'],
    ['How we spend our days is, of course, how we spend our lives.', 'Annie Dillard'],
    ['Lost time is never found again.', 'Benjamin Franklin'],
    ["Don't count the days, make the days count.", 'Muhammad Ali']
  ];
  let quoteIdx = 0;
  function setQuote(i) {
    quoteIdx = ((i % QUOTES.length) + QUOTES.length) % QUOTES.length;
    $('axiom-text').textContent = '"' + QUOTES[quoteIdx][0] + '"';
    $('axiom-by').textContent = '— ' + QUOTES[quoteIdx][1];
  }
  function copyAxiom() {
    const text = $('axiom-text').textContent + ' ' + $('axiom-by').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Quote copied'));
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1700);
  }

  /* ---------------- goals ---------------- */
  const GOAL_TYPES = ['daily', 'weekly', 'monthly', 'yearly'];
  let goals = [];

  function loadGoals() {
    try {
      const raw = JSON.parse(localStorage.getItem('goals') || '[]');
      goals = Array.isArray(raw) ? raw.filter(g => g && g.goal_type) : [];
    } catch (e) { goals = []; }
  }
  function saveGoals() {
    localStorage.setItem('goals', JSON.stringify(goals));
    renderGoals();
  }
  function addGoal(type, text) {
    const t = (text || '').trim();
    if (!t) return;
    goals.push({ id: Date.now() + Math.floor(Math.random() * 999), text: t, goal_type: type, done: false, created: new Date().toISOString() });
    saveGoals();
    toast(type.charAt(0).toUpperCase() + type.slice(1) + ' goal added');
  }
  function toggleGoal(id) {
    const g = goals.find(x => x.id === id);
    if (!g) return;
    g.done = !g.done;
    saveGoals();
    if (g.done) toast('Goal complete');
  }
  function deleteGoal(id) {
    goals = goals.filter(x => x.id !== id);
    saveGoals();
  }

  function renderGoalItems(type) {
    const list = goals.filter(g => g.goal_type === type);
    const el = $(type + '-list');
    if (!list.length) {
      el.innerHTML = '<div class="empty-hint">No goals yet. Add one below.</div>';
      return;
    }
    el.innerHTML = '';
    list.forEach(g => {
      const row = document.createElement('div');
      row.className = 'v-item' + (g.done ? ' done' : '');
      const check = document.createElement('button');
      check.className = 'v-check' + (g.done ? ' on' : '');
      check.innerHTML = '<i class="fa-solid fa-check"></i>';
      check.setAttribute('aria-label', g.done ? 'Mark pending' : 'Mark done');
      check.addEventListener('click', () => toggleGoal(g.id));
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = g.text;
      txt.title = g.text;
      const del = document.createElement('button');
      del.className = 'v-del';
      del.innerHTML = '×';
      del.setAttribute('aria-label', 'Delete goal');
      del.addEventListener('click', () => deleteGoal(g.id));
      row.appendChild(check); row.appendChild(txt); row.appendChild(del);
      el.appendChild(row);
    });
  }

  function renderGoals() {
    GOAL_TYPES.forEach(renderGoalItems);
    const d = goals.filter(g => g.goal_type === 'daily');
    $('daily-count').textContent = d.filter(g => g.done).length + '/' + d.length + ' DONE';
    const wk = goals.filter(g => g.goal_type === 'weekly');
    const we = goals.filter(g => g.goal_type === 'weekly' && g.done).length;
    $('w-done-count').textContent = we + ' OF ' + wk.length + ' COMPLETED';
    const now = new Date();
    const yEnd = new Date(now.getFullYear(), 11, 31);
    const daysLeft = Math.max(0, Math.ceil((yEnd - now) / 864e5));
    $('yearly-meta').textContent = now.getFullYear() + ' · ' + daysLeft + 'd LEFT';
  }

  /* ---------------- life sheet ---------------- */
  const SHEET_KEY = 'life_sheet_data_v2';
  const SHEET_ACTIVE_KEY = 'life_sheet_active_index';
  const SHEET_COLORS = ['#1c2b3a','#16332a','#3a2b16','#2b1c3a','#0f3d4a','#3a1616','#223047','#1f2937'];

  function blankSheet(name) {
    return { name: name, data: Array.from({ length: 3 }, () => ['', '', '']), headers: [], rowColors: [], colColors: [], cellColors: [] };
  }
  // A fresh, empty sheet: people build their own table with + Row / + Col / + Sheet.
  function defaultSheets() { return [blankSheet('Life Sheet 1')]; }
  const isEmptySheet = (sh) => Array.isArray(sh && sh.data) && sh.data.every(r => Array.isArray(r) && r.every(c => !String(c == null ? '' : c).trim()))
    && !(sh.headers || []).some(h => h && String(h).trim())
    && !(sh.rowColors || []).some(Boolean) && !(sh.colColors || []).some(Boolean)
    && !(sh.cellColors || []).some(r => Array.isArray(r) && r.some(Boolean));
  const isPresetName = (n) => /^Reading List \(\d{4}\)$/.test(n || '') || n === 'Health Habits';
  function normSheets() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SHEET_KEY) || 'null'); } catch (e) {}
    if (!Array.isArray(saved) || !saved.length) return defaultSheets();
    const SAMPLES = ['Deep Work: 4hr Daily Focus Block', 'Study: 4 hours of focused work'];
    if (saved[0] && Array.isArray(saved[0].data) && saved[0].data[0] && SAMPLES.includes(saved[0].data[0][0])) {
      saved[0].data = defaultSheets()[0].data;
      saved[0].rowColors = []; saved[0].colColors = []; saved[0].cellColors = [];
    }
    // Drop the old built-in example sheets if the person never wrote in them.
    saved = saved.filter(sh => !(sh && isPresetName(sh.name) && isEmptySheet(sh)));
    saved = saved.map(sh => (sh && sh.name === 'Life Sheet 1' && isEmptySheet(sh) && sh.data.length === 5) ? blankSheet('Life Sheet 1') : sh);
    if (!saved.length) return defaultSheets();
    return saved.map((s, i) => ({
      name: (s && typeof s.name === 'string' && s.name.trim()) ? s.name : 'Sheet ' + (i + 1),
      headers: Array.isArray(s.headers) ? s.headers.map(h => String(h == null ? '' : h)) : [],
      data: (Array.isArray(s.data) && s.data.length ? s.data : [['','','']]).map(r => Array.isArray(r) ? r.map(c => String(c == null ? '' : c)) : ['']),
      rowColors: Array.isArray(s.rowColors) ? s.rowColors : [],
      colColors: Array.isArray(s.colColors) ? s.colColors : [],
      cellColors: Array.isArray(s.cellColors) ? s.cellColors : []
    }));
  }
  function saveSheets(sheets) { localStorage.setItem(SHEET_KEY, JSON.stringify(sheets)); }
  function activeSheetIndex() {
    const n = Number(localStorage.getItem(SHEET_ACTIVE_KEY) || 0);
    const sheets = normSheets();
    return (Number.isInteger(n) && n >= 0 && n < sheets.length) ? n : 0;
  }
  function getCellColor(sheet, r, c) {
    if (sheet.cellColors && sheet.cellColors[r] && sheet.cellColors[r][c]) return sheet.cellColors[r][c];
    if (sheet.rowColors && sheet.rowColors[r]) return sheet.rowColors[r];
    if (sheet.colColors && sheet.colColors[c]) return sheet.colColors[c];
    return '';
  }
  function isLightColor(hex) {
    if (!hex || hex === 'transparent') return false;
    const h = hex.replace('#','');
    if (h.length < 6) return true;
    const v = parseInt(h, 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return (0.2126*r + 0.7152*g + 0.0722*b) / 255 > 0.6;
  }

  let colorTarget = null;

  function renderSheetTabs() {
    const sheets = normSheets();
    const ai = activeSheetIndex();
    const wrap = $('sheet-tabs');
    wrap.innerHTML = '';
    sheets.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet-tab' + (i === ai ? ' active' : '');
      b.textContent = s.name;
      b.addEventListener('click', () => {
        if (i === ai) {
          const next = window.prompt('Rename sheet', s.name);
          if (next && next.trim()) {
            s.name = next.trim();
            saveSheets(sheets);
          }
        }
        localStorage.setItem(SHEET_ACTIVE_KEY, String(i));
        renderSheetTabs(); renderSheet();
      });
      wrap.appendChild(b);
    });
  }

  function renderSheet() {
    const sheets = normSheets();
    const ai = activeSheetIndex();
    const sheet = sheets[ai] || sheets[0];
    const table = $('life-sheet');
    table.innerHTML = '';
    const cols = Math.max(1, ...sheet.data.map(r => r.length));

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th'); corner.textContent = '#'; hr.appendChild(corner);
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      const colColor = sheet.colColors[c] || '';
      if (colColor) { th.style.background = colColor; th.style.color = isLightColor(colColor) ? '#1a2233' : '#e9eff7'; }
      th.innerHTML = '';
      const inner = document.createElement('div'); inner.className = 'th-inner';
      const span = document.createElement('span'); span.className = 'lhead';
      span.contentEditable = 'true'; span.spellcheck = false;
      span.dataset.c = c; span.dataset.ph = String.fromCharCode(65 + (c % 26));
      span.textContent = (sheet.headers && sheet.headers[c]) || '';
      const tools = document.createElement('span'); tools.className = 'cell-tools';
      const dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'cell-dot'; dot.title = 'Colour column';
      dot.addEventListener('click', (e) => { e.stopPropagation(); openColorPop({ type: 'col', c, anchor: dot }); });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'cell-x'; del.title = 'Delete column'; del.setAttribute('aria-label', 'Delete column'); del.textContent = '×';
      del.addEventListener('click', (e) => { e.stopPropagation(); delCol(c); });
      tools.appendChild(dot); tools.appendChild(del);
      inner.appendChild(span); inner.appendChild(tools);
      th.appendChild(inner);
      hr.appendChild(th);
    }
    thead.appendChild(hr); table.appendChild(thead);

    const tbody = document.createElement('tbody');
    sheet.data.forEach((row, r) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      const rowColor = sheet.rowColors[r] || '';
      if (rowColor) { th.style.background = rowColor; th.style.color = isLightColor(rowColor) ? '#1a2233' : '#e9eff7'; }
      const rh = document.createElement('div'); rh.className = 'row-head';
      const num = document.createElement('span'); num.className = 'row-num'; num.textContent = String(r + 1);
      const dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'cell-dot'; dot.title = 'Colour row';
      dot.addEventListener('click', (e) => { e.stopPropagation(); openColorPop({ type: 'row', r, anchor: dot }); });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'cell-x'; del.title = 'Delete row'; del.setAttribute('aria-label', 'Delete row'); del.textContent = '×';
      del.addEventListener('click', (e) => { e.stopPropagation(); delRow(r); });
      rh.appendChild(num); rh.appendChild(dot); rh.appendChild(del);
      th.appendChild(rh);
      tr.appendChild(th);
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        const color = getCellColor(sheet, r, c);
        if (color) { td.style.background = color; td.style.color = isLightColor(color) ? '#1a2233' : '#e9eff7'; }
        const wrap = document.createElement('div');
        wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '8px';
        const dot = document.createElement('button');
        dot.className = 'cell-dot'; dot.title = 'Colour cell';
        dot.addEventListener('click', (e) => { e.stopPropagation(); openColorPop({ type: 'cell', r, c, anchor: dot }); });
        const cell = document.createElement('div');
        cell.className = 'lcell';
        cell.contentEditable = 'true';
        cell.dataset.r = r; cell.dataset.c = c;
        cell.textContent = row[c] || '';
        if (color) cell.style.color = isLightColor(color) ? '#1a2233' : '#e9eff7';
        wrap.appendChild(dot); wrap.appendChild(cell);
        td.appendChild(wrap);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    $('sheet-stats').textContent = 'ROWS: ' + sheet.data.length;
  }

  function updateCell(r, c, value) {
    const sheets = normSheets();
    const ai = activeSheetIndex();
    const sheet = sheets[ai];
    if (!sheet) return;
    while (sheet.data.length <= r) sheet.data.push([]);
    while (sheet.data[r].length <= c) sheet.data[r].push('');
    sheet.data[r][c] = value;
    saveSheets(sheets);
  }

  function addRow() {
    const sheets = normSheets(); const ai = activeSheetIndex(); const s = sheets[ai];
    const cols = Math.max(1, ...s.data.map(r => r.length));
    s.data.push(Array(cols).fill(''));
    saveSheets(sheets); renderSheet();
  }
  function delRow(r) {
    const sheets = normSheets(); const ai = activeSheetIndex(); const s = sheets[ai];
    if (s.data.length <= 1) return;
    if (!window.confirm('Delete row ' + (r + 1) + '?')) return;
    s.data.splice(r, 1);
    if (Array.isArray(s.rowColors)) s.rowColors.splice(r, 1);
    if (Array.isArray(s.cellColors)) s.cellColors.splice(r, 1);
    saveSheets(sheets); renderSheet();
  }
  function addCol() {
    const sheets = normSheets(); const ai = activeSheetIndex(); const s = sheets[ai];
    s.data.forEach(r => r.push(''));
    saveSheets(sheets); renderSheet();
  }
  function delCol(c) {
    const sheets = normSheets(); const ai = activeSheetIndex(); const s = sheets[ai];
    if (s.data[0].length <= 1) return;
    if (!window.confirm('Delete column ' + ((s.headers && s.headers[c]) || String.fromCharCode(65 + c)) + '?')) return;
    s.data.forEach(r => r.splice(c, 1));
    if (Array.isArray(s.colColors)) s.colColors.splice(c, 1);
    if (Array.isArray(s.headers)) s.headers.splice(c, 1);
    if (Array.isArray(s.cellColors)) s.cellColors.forEach(rc => rc.splice(c, 1));
    saveSheets(sheets); renderSheet();
  }
  function addSheet() {
    const sheets = normSheets();
    sheets.push(blankSheet('Sheet ' + (sheets.length + 1)));
    saveSheets(sheets);
    localStorage.setItem(SHEET_ACTIVE_KEY, String(sheets.length - 1));
    renderSheetTabs(); renderSheet();
  }
  function deleteSheet() {
    const sheets = normSheets(); const ai = activeSheetIndex();
    if (!window.confirm('Delete "' + sheets[ai].name + '"?')) return;
    if (sheets.length <= 1) { saveSheets(defaultSheets()); localStorage.setItem(SHEET_ACTIVE_KEY, '0'); }
    else { sheets.splice(ai, 1); saveSheets(sheets); localStorage.setItem(SHEET_ACTIVE_KEY, String(Math.max(0, ai - 1))); }
    renderSheetTabs(); renderSheet();
  }

  function openColorPop(target) {
    colorTarget = target;
    const pop = $('sheet-color-pop');
    const grid = $('color-grid');
    grid.innerHTML = '';
    SHEET_COLORS.forEach(color => {
      const b = document.createElement('button');
      b.type = 'button'; b.style.background = color;
      b.addEventListener('click', () => applyColor(color));
      grid.appendChild(b);
    });
    pop.classList.add('open');
    const rect = target.anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 8, window.innerHeight - 200);
    const left = Math.min(rect.left, window.innerWidth - 230);
    pop.style.top = Math.max(60, top) + 'px';
    pop.style.left = Math.max(8, left) + 'px';
  }
  function closeColorPop() { $('sheet-color-pop').classList.remove('open'); colorTarget = null; }
  function applyColor(color) {
    if (!colorTarget) return;
    const sheets = normSheets(); const ai = activeSheetIndex(); const s = sheets[ai];
    const t = colorTarget;
    if (t.type === 'cell') {
      if (!Array.isArray(s.cellColors)) s.cellColors = [];
      while (s.cellColors.length <= t.r) s.cellColors.push([]);
      while ((s.cellColors[t.r] || []).length <= t.c) s.cellColors[t.r].push('');
      s.cellColors[t.r][t.c] = color;
    } else if (t.type === 'row') {
      if (!Array.isArray(s.rowColors)) s.rowColors = [];
      s.rowColors[t.r] = color;
    } else if (t.type === 'col') {
      if (!Array.isArray(s.colColors)) s.colColors = [];
      s.colColors[t.c] = color;
    }
    saveSheets(sheets);
    closeColorPop(); renderSheet();
  }

  /* ---------------- user chip ---------------- */
  function refreshUser() {
    const name = localStorage.getItem('life_user_name') || (window.lifeIsShortUser && (window.lifeIsShortUser.displayName || window.lifeIsShortUser.email)) || 'Guest';
    const mode = localStorage.getItem('lifeIsShort_mode');
    $('user-name').textContent = name;
    $('user-initial').textContent = (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    $('side-sync').textContent = mode === 'account' ? 'SYNCED · CLOUD' : (mode === 'guest' ? 'SYNCED · LOCAL GUEST' : 'SYNCED · LOCAL');
  }

  /* ---------------- init ---------------- */
  function init() {
    renderTime();
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(renderTime, 30000);

    setQuote(Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 864e5));
    $('axiom-refresh').addEventListener('click', () => setQuote(quoteIdx + 1));
    $('axiom-copy').addEventListener('click', copyAxiom);

    loadGoals(); renderGoals();
    [['daily'], ['weekly'], ['monthly'], ['yearly']].forEach(([t]) => {
      $(t + '-add').addEventListener('click', () => {
        addGoal(t, $(t + '-input').value);
        $(t + '-input').value = '';
      });
      $(t + '-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $(t + '-add').click(); }
      });
    });

    renderSheetTabs(); renderSheet();
    $('add-sheet-btn').addEventListener('click', addSheet);
    $('add-sheet-row').addEventListener('click', addRow);
    $('add-sheet-col').addEventListener('click', addCol);
    $('delete-sheet-btn').addEventListener('click', deleteSheet);
    $('color-none').addEventListener('click', () => {
      if (!colorTarget) return;
      const sheets = normSheets(); const ai = activeSheetIndex(); const s = sheets[ai];
      const t = colorTarget;
      if (t.type === 'cell' && s.cellColors[t.r]) s.cellColors[t.r][t.c] = '';
      else if (t.type === 'row') s.rowColors[t.r] = '';
      else if (t.type === 'col') s.colColors[t.c] = '';
      saveSheets(sheets); closeColorPop(); renderSheet();
    });
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (t.classList && t.classList.contains('lcell')) {
        updateCell(Number(t.dataset.r), Number(t.dataset.c), t.textContent || '');
      } else if (t.classList && t.classList.contains('lhead')) {
        const sheets = normSheets(); const sh = sheets[activeSheetIndex()]; if (!sh) return;
        const c = Number(t.dataset.c);
        while (sh.headers.length <= c) sh.headers.push('');
        sh.headers[c] = (t.textContent || '').replace(/\n/g, ' ');
        saveSheets(sheets);
      }
    });
    // Enter in a column title just confirms it (no line breaks in headers).
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('lhead')) { e.preventDefault(); e.target.blur(); }
    });
    document.addEventListener('click', (e) => {
      const pop = $('sheet-color-pop');
      if (pop.classList.contains('open') && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.cell-dot'))) {
        closeColorPop();
      }
    });

    refreshUser();
    document.addEventListener('lifeIsShortAuthState', refreshUser);
    document.addEventListener('lifeIsShortDataReady', () => {
      loadGoals(); renderGoals(); renderSheetTabs(); renderSheet(); refreshUser();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();