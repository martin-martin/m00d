'use strict';

/* ------------------------------------------------------------------ *
 * m00d: a tiny, private mood + cycle tracker.
 * Everything lives in localStorage under one key. No server.
 * ------------------------------------------------------------------ */

const STORE_KEY = 'm00d.v1';
const FLOWS = ['spotting', 'light', 'medium', 'heavy'];
const MAX_DIMS = 8;

// Defaults are loosely based on the DRSP (Daily Record of Severity of Problems),
// the standard daily form clinicians use for PMS/PMDD, trimmed to what's quick to tap.
const DEFAULT_DIMENSIONS = [
  { id: 'mood',      emoji: '🙂', label: 'Mood',         low: 'down',        high: 'great',        higherIsBetter: true,  color: 0 },
  { id: 'energy',    emoji: '⚡', label: 'Energy',       low: 'exhausted',   high: 'energetic',    higherIsBetter: true,  color: 1 },
  { id: 'focus',     emoji: '🎯', label: 'Focus',        low: 'scattered',   high: 'productive',   higherIsBetter: true,  color: 2 },
  { id: 'anxiety',   emoji: '😰', label: 'Anxiety',      low: 'calm',        high: 'on edge',      higherIsBetter: false, color: 3 },
  { id: 'irritable', emoji: '😤', label: 'Irritability', low: 'patient',     high: 'snappy',       higherIsBetter: false, color: 4 },
  { id: 'sensitive', emoji: '🥺', label: 'Sensitivity',  low: 'thick skin',  high: 'teary, raw',   higherIsBetter: false, color: 5 },
  { id: 'sleep',     emoji: '😴', label: 'Sleep',        low: 'poor',        high: 'restful',      higherIsBetter: true,  color: 6 },
];
const DEFAULT_SYMPTOMS = ['Cramps', 'Headache', 'Bloating', 'Breast tenderness', 'Cravings', 'Acne', 'Back pain', 'Nausea'];

const PHASES = {
  menstrual:  { label: 'Period',           hint: 'Hormones are at their lowest. Low energy and cramps are common in the first days.' },
  follicular: { label: 'Follicular',       hint: 'Estrogen is rising. For many people energy, mood and focus climb in this stretch.' },
  ovulation:  { label: 'Ovulation (est.)', hint: 'Around ovulation, estimated as ~14 days before the next period. Often a high point.' },
  luteal:     { label: 'Luteal',           hint: 'Progesterone takes over after ovulation. Things can feel a bit slower or calmer.' },
  pms:        { label: 'Late luteal (PMS)', hint: 'The week before a period, when hormones drop. Dips in mood and energy and more sensitivity are most common here. Be gentle with yourself.' },
};
const PHASE_ORDER = ['menstrual', 'follicular', 'ovulation', 'luteal', 'pms'];

/* ---------- tiny helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5); // days from a to b
const today = () => iso(new Date());
const fmt = (s, o = { month: 'short', day: 'numeric' }) => parse(s).toLocaleDateString(undefined, o);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/* ---------- state ---------- */
function defaultState() {
  return {
    version: 1,
    settings: {
      cycleLength: 28,
      periodLength: 5,
      lutealLength: 14,
      dimensions: structuredClone(DEFAULT_DIMENSIONS),
      symptoms: [...DEFAULT_SYMPTOMS],
    },
    // entries['2026-10-12'] = { m: {mood: 4, ...}, s: ['Cramps'], f: 'light'|null, n: 'note' }
    entries: {},
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
    }
  } catch (e) { console.warn('Could not read saved data', e); }
  return defaultState();
}
let state = load();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { alert('Could not save. Is storage full or disabled?'); }
  invalidate();
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const ui = { view: 'today', date: today(), month: today().slice(0, 7), range: 56, tlDims: null };
const dims = () => state.settings.dimensions;
const dimColor = d => cssVar(`--s${(d.color % 8) + 1}`);

/* ------------------------------------------------------------------ *
 * Cycle engine
 * ------------------------------------------------------------------ */
let _cyc = null, _pattern = null;
function invalidate() { _cyc = null; _pattern = null; _ciCache.clear(); }

function cycles() {
  if (_cyc) return _cyc;
  const S = state.settings, T = today();
  // Days with real bleeding (spotting doesn't start a period).
  const flowDays = Object.keys(state.entries)
    .filter(d => { const f = state.entries[d].f; return f && f !== 'spotting'; }).sort();

  // Group into periods: up to 2 missing days inside a period are tolerated,
  // and a new period needs to start at least 15 days after the previous one.
  const runs = [];
  for (const d of flowDays) {
    const r = runs[runs.length - 1];
    if (r && diff(r.end, d) <= 3) r.end = d;
    else if (!r || diff(r.start, d) >= 15) runs.push({ start: d, end: d, actual: true });
  }

  const lengths = [];
  for (let i = 1; i < runs.length; i++) {
    const L = diff(runs[i - 1].start, runs[i].start);
    if (L >= 15 && L <= 60) lengths.push(L);
  }
  const recent = lengths.slice(-6);
  const avgLen = recent.length ? Math.round(mean(recent)) : S.cycleLength;
  const sd = recent.length >= 2 ? Math.sqrt(mean(recent.map(l => (l - mean(recent)) ** 2))) : null;
  const pl = runs.slice(-6).map(r => diff(r.start, r.end) + 1).filter(n => n <= 10);
  const periodLen = pl.length >= 2 ? Math.round(mean(pl)) : S.periodLength;

  // Project future periods from the last real one.
  const starts = runs.slice();
  let late = 0, next = null;
  if (runs.length) {
    next = addDays(runs[runs.length - 1].start, avgLen);
    if (diff(next, T) > 0) { late = diff(next, T); next = addDays(T, 1); }
    for (let s = next; diff(T, s) < 200; s = addDays(s, avgLen)) {
      starts.push({ start: s, end: addDays(s, periodLen - 1), actual: false });
    }
  }
  _cyc = { runs, starts, lengths, avgLen, sd, periodLen, late, next };
  return _cyc;
}

function phaseOf(day, L, P) {
  const lut = state.settings.lutealLength;
  const ov = Math.max(P + 2, L - lut);
  if (day <= P) return 'menstrual';
  if (day >= ov - 1 && day <= ov + 1) return 'ovulation';
  if (day < ov - 1) return 'follicular';
  if (day > L - 7) return 'pms';
  return 'luteal';
}

// Map a day of a cycle with length L onto an "average cycle" of length A.
// Follicular part is stretched/squeezed; luteal part is anchored to the next period
// (it's the phase that stays constant), so PMS days line up across cycles.
function align(day, L, A) {
  const lut = state.settings.lutealLength;
  const fL = L - lut, fA = A - lut;
  let x;
  if (day <= fL) x = fL <= 1 ? day : 1 + (day - 1) * (fA - 1) / (fL - 1);
  else x = A - (L - day);
  return clamp(Math.round(x), 1, A);
}

const _ciCache = new Map();
function cycleInfo(d) {
  if (_ciCache.has(d)) return _ciCache.get(d);
  const c = cycles();
  let i = -1;
  for (let k = 0; k < c.starts.length; k++) { if (c.starts[k].start <= d) i = k; else break; }
  let info = null;
  if (i >= 0) {
    const cur = c.starts[i], nxt = c.starts[i + 1];
    const L = nxt ? diff(cur.start, nxt.start) : c.avgLen;
    const day = diff(cur.start, d) + 1;
    const P = cur.actual && cur.end !== cur.start ? diff(cur.start, cur.end) + 1 : (cur.actual ? Math.max(1, c.periodLen) : c.periodLen);
    info = {
      day, L, start: cur.start,
      phase: phaseOf(day, L, P),
      x: align(day, L, c.avgLen),
      predicted: !cur.actual || d > today(),
      predictedPeriod: !cur.actual && day <= P,
    };
  }
  _ciCache.set(d, info);
  return info;
}

/* ---------- pattern: average of every dimension per aligned cycle day ---------- */
function pattern() {
  if (_pattern) return _pattern;
  const c = cycles(), A = c.avgLen, T = today();
  const acc = {}, overall = {}, sym = {};
  for (const d of dims()) { acc[d.id] = Array.from({ length: A + 1 }, () => ({ s: 0, n: 0 })); overall[d.id] = []; }
  for (const s of state.settings.symptoms) sym[s] = new Array(A + 1).fill(0);
  const logged = new Array(A + 1).fill(0);
  let totalDays = 0;

  for (const [d, e] of Object.entries(state.entries)) {
    if (d > T) continue;
    const ci = cycleInfo(d);
    if (!ci) continue;
    totalDays++;
    logged[ci.x]++;
    for (const dim of dims()) {
      const v = e.m && e.m[dim.id];
      if (v) { acc[dim.id][ci.x].s += v; acc[dim.id][ci.x].n++; overall[dim.id].push(v); }
    }
    for (const s of e.s || []) if (sym[s]) sym[s][ci.x]++;
  }
  const usual = {};
  for (const id in overall) usual[id] = overall[id].length ? mean(overall[id]) : null;

  // Smoothed lookup: 1-2-1 weighted window across neighbouring cycle days (wraps around).
  const wrap = x => ((x - 1 + A) % A) + 1;
  function at(id, x) {
    const a = acc[id]; if (!a) return { avg: null, n: 0 };
    let s = 0, n = 0, raw = 0;
    for (const [dx, w] of [[-1, 1], [0, 2], [1, 1]]) { const b = a[wrap(x + dx)]; s += w * b.s; n += w * b.n; raw += b.n; }
    return { avg: n ? s / n : null, n: raw };
  }
  function symFreq(name, x) {
    let k = 0, n = 0;
    for (const dx of [-1, 0, 1]) { k += sym[name][wrap(x + dx)]; n += logged[wrap(x + dx)]; }
    return { freq: n ? k / n : null, n };
  }
  _pattern = { A, at, symFreq, usual, totalDays };
  return _pattern;
}

// How unusual is a value, oriented so positive = "better than usual"
function goodness(dim, avg) {
  const u = pattern().usual[dim.id];
  if (avg == null || u == null) return null;
  return dim.higherIsBetter ? avg - u : u - avg;
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */
function show(view) {
  ui.view = view;
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== 'view-' + view;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.view === view);
  hideTip();
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (ui.view === 'today') { renderStatus(); renderEntry(); }
  if (ui.view === 'insights') renderInsights();
  if (ui.view === 'calendar') renderCalendar();
  if (ui.view === 'settings') renderSettings();
}

function phasePill(phase, extra = '') {
  return `<span class="pill"><span class="swatch" style="background:var(--ph-${phase})"></span>${PHASES[phase].label}${extra}</span>`;
}

/* ---------- Today: status ---------- */
function renderStatus() {
  const box = $('#status-card');
  const c = cycles(), T = today(), ci = cycleInfo(T);
  if (!ci) {
    box.innerHTML = `<div class="big">Welcome 👋</div>
      <p class="line muted">Log a mood below whenever you like. To switch on cycle tracking, mark the <b>Period</b> row on the first day of your next period (or go back to the last one with ‹ / the Calendar).</p>`;
    return;
  }
  const nextIn = diff(T, c.next);
  let nextLine;
  if (c.late > 0) nextLine = `Period is <b>${c.late} day${c.late > 1 ? 's' : ''} later</b> than your ${c.avgLen}-day average.`;
  else if (ci.phase === 'menstrual' && !ci.predicted) nextLine = `Period day ${ci.day}. Next one around <b>${fmt(c.next)}</b>.`;
  else nextLine = `Next period in about <b>${nextIn} day${nextIn === 1 ? '' : 's'}</b> (${fmt(c.next, { weekday: 'short', month: 'short', day: 'numeric' })}${c.sd != null ? `, ±${Math.max(1, Math.round(c.sd))}` : ''}).`;
  const basis = c.lengths.length
    ? `Average cycle ${c.avgLen} days, from ${c.lengths.length} cycle${c.lengths.length > 1 ? 's' : ''}.`
    : `Using a ${c.avgLen}-day guess until two periods are logged.`;
  box.innerHTML = `
    <div class="big">Cycle day ${ci.day} ${phasePill(ci.phase)}</div>
    <p class="line">${nextLine}</p>
    <p class="line muted small">${PHASES[ci.phase].hint}</p>
    <p class="line muted small">${basis}</p>`;
}

/* ---------- Today: check-in form ---------- */
function getEntry(d) { return state.entries[d] || { m: {}, s: [], f: null, n: '' }; }
let savedTimer;
function update(d, fn) {
  const e = structuredClone(getEntry(d));
  fn(e);
  const empty = !Object.keys(e.m).length && !e.s.length && !e.f && !e.n;
  if (empty) delete state.entries[d]; else state.entries[d] = e;
  save();
  const s = $('#saved'); s.textContent = 'Saved ✓';
  clearTimeout(savedTimer); savedTimer = setTimeout(() => { s.textContent = ''; }, 1500);
  renderStatus();
}

function renderEntry() {
  const d = ui.date, T = today(), e = getEntry(d);
  $('#entry-date').textContent = d === T ? 'Today' : d === addDays(T, -1) ? 'Yesterday'
    : fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#next-day').disabled = d >= T;

  const box = $('#dims'); box.innerHTML = '';
  for (const dim of dims()) {
    const v = e.m[dim.id];
    const row = document.createElement('div');
    row.className = 'dim';
    row.style.setProperty('--c', dimColor(dim));
    row.innerHTML = `
      <div class="dim-head"><span class="dim-name">${esc(dim.emoji)} ${esc(dim.label)}</span>
        <span class="dim-val">${v ? v + ' / 5' : ''}</span></div>
      <div class="scale">${[1, 2, 3, 4, 5].map(i =>
        `<button data-v="${i}" class="${v === i ? 'on' : ''}" aria-label="${esc(dim.label)} ${i}">${i}</button>`).join('')}</div>
      <div class="ends"><span>${esc(dim.low)}</span><span>${esc(dim.high)}</span></div>`;
    row.querySelector('.scale').addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const nv = +b.dataset.v;
      update(d, x => { if (x.m[dim.id] === nv) delete x.m[dim.id]; else x.m[dim.id] = nv; });
      renderEntry();
    });
    box.appendChild(row);
  }

  const flow = $('#flow'); flow.innerHTML = '';
  for (const f of [null, ...FLOWS]) {
    const b = document.createElement('button');
    b.className = 'chip' + (f ? ' flow' : '') + ((e.f || null) === f ? ' on' : '');
    b.textContent = f ? f[0].toUpperCase() + f.slice(1) : 'None';
    b.onclick = () => { update(d, x => { x.f = f; }); renderEntry(); };
    flow.appendChild(b);
  }

  const sym = $('#symptoms'); sym.innerHTML = '';
  const known = new Set(state.settings.symptoms);
  for (const s of [...state.settings.symptoms, ...e.s.filter(x => !known.has(x))]) {
    const b = document.createElement('button');
    b.className = 'chip' + (e.s.includes(s) ? ' on' : '');
    b.textContent = s;
    b.onclick = () => { update(d, x => { x.s = x.s.includes(s) ? x.s.filter(y => y !== s) : [...x.s, s]; }); renderEntry(); };
    sym.appendChild(b);
  }

  const note = $('#note');
  if (document.activeElement !== note) note.value = e.n || '';
}

let noteTimer;
$('#note').addEventListener('input', ev => {
  const d = ui.date, v = ev.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => update(d, x => { x.n = v.trim() ? v : ''; }), 400);
});
$('#prev-day').onclick = () => { ui.date = addDays(ui.date, -1); renderEntry(); };
$('#next-day').onclick = () => { if (ui.date < today()) { ui.date = addDays(ui.date, 1); renderEntry(); } };

/* ---------- Insights ---------- */
function renderInsights() {
  renderForecast();
  renderTimelineControls();
  renderTimeline();
  renderPattern();
  renderPhaseSummary();
  $('#phase-legend').innerHTML = PHASE_ORDER.map(p =>
    `<span><span class="swatch" style="background:var(--ph-${p}-t);outline:1px solid var(--ph-${p})"></span>${PHASES[p].label}</span>`).join('');
}

function notableFor(x, limit = 2) {
  const P = pattern();
  const out = [];
  for (const dim of dims()) {
    const a = P.at(dim.id, x);
    if (a.avg == null || a.n < 3) continue;
    const g = goodness(dim, a.avg);
    const raw = a.avg - P.usual[dim.id];
    if (Math.abs(raw) >= 0.4) out.push({ dim, g, raw });
  }
  return out.sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw)).slice(0, limit);
}

function renderForecast() {
  const box = $('#forecast'), T = today();
  if (!cycleInfo(T)) { box.innerHTML = `<div class="empty" style="grid-column:1/-1">Log a period start to see what's coming.</div>`; return; }
  const P = pattern();
  let html = '';
  const notes = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(T, i), ci = cycleInfo(d);
    const flags = P.totalDays >= 20 ? notableFor(ci.x) : [];
    html += `<div class="fday${i === 0 ? ' today' : ''}" style="--pc:var(--ph-${ci.phase})" title="${PHASES[ci.phase].label}">
      <div class="wd">${i === 0 ? 'Today' : fmt(d, { weekday: 'short' })}</div>
      <div class="cd">day ${ci.day}</div>
      ${ci.phase === 'menstrual' ? '<div class="flag">🩸</div>' : ''}
      ${flags.map(f => `<div class="flag ${f.g >= 0 ? 'up' : 'down'}" title="${esc(f.dim.label)} ${f.raw > 0 ? 'higher' : 'lower'} than usual">${esc(f.dim.emoji)}${f.raw > 0 ? '↑' : '↓'}</div>`).join('')}
    </div>`;
    if (i > 0) {
      const prev = cycleInfo(addDays(d, -1));
      if (prev.phase !== ci.phase) notes.push(`<b>${fmt(d, { weekday: 'long' })}</b>: ${PHASES[ci.phase].label} ${ci.predicted && ci.phase === 'menstrual' ? 'likely starts' : 'begins'}.`);
    }
  }
  let foot = '';
  if (P.totalDays < 20) foot = `<p class="forecast-note muted small">Mood forecasts appear after about 3 weeks of check-ins; they get good after 2–3 cycles.</p>`;
  else foot = `<p class="forecast-note muted small"><span class="up">↑/↓ blue</span> = better than your usual, <span class="down">↑/↓ red</span> = harder than usual (arrow = the scale goes up or down).</p>`;
  box.innerHTML = html + `<div style="grid-column:1/-1">${notes.map(n => `<p class="forecast-note">${n}</p>`).join('')}${foot}</div>`;
}

function renderTimelineControls() {
  if (!ui.tlDims) ui.tlDims = new Set(dims().slice(0, 2).map(d => d.id));
  const box = $('#tl-dims'); box.innerHTML = '';
  for (const dim of dims()) {
    const b = document.createElement('button');
    b.className = 'chip' + (ui.tlDims.has(dim.id) ? ' on' : '');
    b.innerHTML = `<span class="swatch" style="background:${dimColor(dim)}"></span>${esc(dim.label)}`;
    b.onclick = () => { ui.tlDims.has(dim.id) ? ui.tlDims.delete(dim.id) : ui.tlDims.add(dim.id); renderTimelineControls(); renderTimeline(); };
    box.appendChild(b);
  }
  const seg = $('#tl-range'); seg.innerHTML = '';
  for (const [n, l] of [[28, '4 wk'], [56, '8 wk'], [91, '3 mo'], [182, '6 mo']]) {
    const b = document.createElement('button');
    b.textContent = l; b.className = ui.range === n ? 'on' : '';
    b.onclick = () => { ui.range = n; renderTimelineControls(); renderTimeline(); };
    seg.appendChild(b);
  }
}

const FLOW_R = { spotting: 1.5, light: 2.5, medium: 3.5, heavy: 4.5 };

function renderTimeline() {
  const box = $('#timeline'); box.innerHTML = '';
  const T = today(), past = ui.range, fut = 14, n = past + fut;
  const start = addDays(T, -(past - 1));
  const W = Math.max(280, box.clientWidth || 340), H = 230;
  const m = { l: 22, r: 6, t: 8, b: 42 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b, dw = pw / n;
  const X = i => m.l + i * dw + dw / 2;
  const Y = v => m.t + (5 - v) / 4 * ph;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Mood timeline with cycle phases' }, box);

  const days = [];
  for (let i = 0; i < n; i++) { const d = addDays(start, i); days.push({ d, ci: cycleInfo(d), e: state.entries[d] }); }

  // phase bands
  days.forEach(({ d, ci }, i) => {
    if (!ci) return;
    el('rect', { x: m.l + i * dw, y: m.t, width: dw + 0.6, height: ph, fill: `var(--ph-${ci.phase}-t)`, opacity: d > T ? 0.55 : 1 }, svg);
  });
  // grid + y labels
  for (let v = 1; v <= 5; v++) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1, opacity: 0.8 }, svg);
    if (v % 2) el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v;
  }
  // today marker
  const tx = m.l + past * dw;
  el('line', { x1: tx, x2: tx, y1: m.t - 4, y2: H - m.b + 18, stroke: 'var(--ink-2)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }, svg);
  el('text', { x: tx + 3, y: m.t + 9, class: 'lbl' }, svg).textContent = 'now';

  // lines
  const P = pattern();
  for (const dim of dims()) {
    if (!ui.tlDims.has(dim.id)) continue;
    const color = dimColor(dim);
    // expected (dashed), from today into the future
    if (P.totalDays >= 20) {
      let dd = '';
      days.forEach(({ d, ci }, i) => {
        if (d < T || !ci) return;
        const a = P.at(dim.id, ci.x);
        if (a.avg == null || a.n < 2) return;
        dd += (dd ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(a.avg).toFixed(1);
      });
      if (dd) el('path', { d: dd, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '4 4', 'stroke-linecap': 'round', opacity: 0.85 }, svg);
    }
    // actual: connect across gaps of up to 2 missing days
    let path = '', lastI = -99;
    const pts = [];
    days.forEach(({ e }, i) => {
      const v = e && e.m && e.m[dim.id];
      if (!v) return;
      path += (i - lastI <= 3 ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
      lastI = i; pts.push([i, v]);
    });
    if (path) el('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    if (dw >= 5) for (const [i, v] of pts) el('circle', { cx: X(i), cy: Y(v), r: 2.5, fill: color, stroke: 'var(--surface)', 'stroke-width': 1 }, svg);
  }

  // period row
  const fy = H - m.b + 10;
  days.forEach(({ d, ci, e }, i) => {
    if (e && e.f) el('circle', { cx: X(i), cy: fy, r: Math.min(FLOW_R[e.f], dw * 0.6 + 1), fill: 'var(--ph-menstrual)' }, svg);
    else if (ci && ci.predictedPeriod && d >= T) el('circle', { cx: X(i), cy: fy, r: Math.min(2.5, dw * 0.5 + 0.5), fill: 'none', stroke: 'var(--ph-menstrual)', 'stroke-width': 1.2 }, svg);
  });

  // x labels: weekly, anchored on today
  const step = past > 100 ? 28 : past > 60 ? 14 : 7;
  days.forEach(({ d }, i) => {
    if (diff(d, T) % step !== 0) return;
    el('text', { x: X(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = fmt(d);
  });

  // hover / touch layer
  const cross = el('line', { y1: m.t, y2: H - m.b + 14, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0 }, svg);
  const hit = el('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' }, svg);
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const i = clamp(Math.floor((ev.clientX - r.left - m.l) / dw), 0, n - 1);
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 0.5);
    showTip(ev, timelineTip(days[i]));
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
}

function timelineTip({ d, ci, e }) {
  const T = today(), P = pattern();
  let h = `<b>${fmt(d, { weekday: 'short', month: 'short', day: 'numeric' })}</b>`;
  if (ci) h += `<br><span class="muted">Day ${ci.day} · ${PHASES[ci.phase].label}${ci.predicted ? ' (predicted)' : ''}</span>`;
  for (const dim of dims()) {
    if (!ui.tlDims.has(dim.id)) continue;
    const v = e && e.m && e.m[dim.id];
    let val = v ? String(v) : '–';
    if (!v && d >= T && ci && P.totalDays >= 20) { const a = P.at(dim.id, ci.x); if (a.avg != null) val = `~${a.avg.toFixed(1)} typical`; }
    h += `<div class="tt-row"><span class="swatch" style="background:${dimColor(dim)}"></span>${esc(dim.label)}<span class="v">${val}</span></div>`;
  }
  if (e && e.f) h += `<div>🩸 ${e.f}</div>`;
  if (e && e.s && e.s.length) h += `<div class="muted">${e.s.map(esc).join(', ')}</div>`;
  if (e && e.n) h += `<div><i>${esc(e.n)}</i></div>`;
  return h;
}

/* diverging color: worse (red) ← usual (gray) → better (blue) */
function hexToRgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; }
function divColor(g) {
  const t = clamp(Math.abs(g) / 1.2, 0, 1);
  return mix(cssVar('--div-mid'), cssVar(g >= 0 ? '--div-good' : '--div-bad'), t);
}

function renderPattern() {
  const box = $('#pattern'); box.innerHTML = '';
  const c = cycles(), P = pattern(), A = P.A;
  if (!c.runs.length || P.totalDays < 10) {
    box.innerHTML = `<div class="empty">This fills in once a period is logged and there are a couple of weeks of check-ins.<br>Want a preview? Settings → Load demo data.</div>`;
    $('#pattern-legend').innerHTML = '';
    return;
  }
  const syms = state.settings.symptoms.filter(s => { for (let x = 1; x <= A; x++) if (P.symFreq(s, x).freq) return true; return false; });
  const W = Math.max(280, box.clientWidth || 340);
  const labW = Math.min(118, W * 0.32), m = { t: 18, b: 22 };
  const cw = (W - labW) / A, rh = 22, gap = 1;
  const rows = [...dims().map(d => ({ type: 'dim', d })), ...(syms.length ? [{ type: 'sep' }] : []), ...syms.map(s => ({ type: 'sym', s }))];
  const rowY = []; let y = m.t;
  for (const r of rows) { rowY.push(y); y += r.type === 'sep' ? 14 : rh; }
  const H = y + m.b;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Average cycle heatmap' }, box);

  // phase strip on top
  for (let x = 1; x <= A; x++) {
    el('rect', { x: labW + (x - 1) * cw, y: 2, width: cw + 0.3, height: 8, fill: `var(--ph-${phaseOf(x, A, c.periodLen)})` }, svg);
  }
  rows.forEach((r, ri) => {
    const ry = rowY[ri];
    if (r.type === 'sep') { el('text', { x: 0, y: ry + 11, class: 'lbl' }, svg).textContent = 'How often…'; return; }
    const label = r.type === 'dim' ? `${r.d.emoji} ${r.d.label}` : r.s;
    el('text', { x: 0, y: ry + rh / 2 + 4, class: 'lbl' }, svg).textContent = label.length > 16 ? label.slice(0, 15) + '…' : label;
    for (let x = 1; x <= A; x++) {
      let fill = null;
      if (r.type === 'dim') { const a = P.at(r.d.id, x); if (a.n) fill = divColor(goodness(r.d, a.avg)); }
      else { const f = P.symFreq(r.s, x); if (f.n) fill = mix(cssVar('--surface-2'), cssVar('--seq'), clamp(f.freq, 0, 1)); }
      el('rect', { x: labW + (x - 1) * cw + gap / 2, y: ry + gap / 2, width: Math.max(1, cw - gap), height: rh - gap, rx: Math.min(3, cw / 4),
        fill: fill || 'transparent', stroke: fill ? 'none' : 'var(--grid)', 'stroke-width': 1 }, svg);
    }
  });
  // x axis: cycle days
  for (const x of [1, 7, 14, 21, A]) {
    if (x > A) continue;
    el('text', { x: labW + (x - 0.5) * cw, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = x;
  }
  el('text', { x: 0, y: H - 6 }, svg).textContent = 'cycle day →';
  // today marker
  const ci = cycleInfo(today());
  if (ci) {
    const tx = labW + (ci.x - 0.5) * cw;
    el('path', { d: `M${tx - 4} ${H - m.b + 2} L${tx + 4} ${H - m.b + 2} L${tx} ${H - m.b - 3}Z`, fill: 'var(--ink)' }, svg);
  }

  const hit = el('rect', { x: labW, y: 0, width: W - labW, height: H, fill: 'transparent' }, svg);
  const move = ev => {
    const rc = svg.getBoundingClientRect();
    const px = ev.clientX - rc.left, py = ev.clientY - rc.top;
    const x = clamp(Math.floor((px - labW) / cw) + 1, 1, A);
    let ri = -1; rowY.forEach((ry, i) => { if (py >= ry && py < ry + (rows[i].type === 'sep' ? 14 : rh)) ri = i; });
    const phase = phaseOf(x, A, c.periodLen);
    let h = `<b>Cycle day ${x}</b> <span class="muted">· ${PHASES[phase].label}</span>`;
    const r = rows[ri];
    if (r && r.type === 'dim') {
      const a = P.at(r.d.id, x), u = P.usual[r.d.id];
      h += a.avg == null ? `<div>${esc(r.d.label)}: no data</div>`
        : `<div>${esc(r.d.emoji)} ${esc(r.d.label)}: <b>${a.avg.toFixed(1)}</b> <span class="muted">(usual ${u.toFixed(1)})</span></div><div class="muted small">${a.n} day${a.n > 1 ? 's' : ''} logged around here</div>`;
    } else if (r && r.type === 'sym') {
      const f = P.symFreq(r.s, x);
      h += `<div>${esc(r.s)}: <b>${f.freq != null ? Math.round(f.freq * 100) + '%' : '–'}</b> of logged days</div>`;
    } else {
      for (const f of notableFor(x, 3)) h += `<div>${esc(f.dim.emoji)} ${esc(f.dim.label)} ${f.raw > 0 ? 'higher' : 'lower'} than usual</div>`;
    }
    showTip(ev, h);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', hideTip);

  $('#pattern-legend').innerHTML = `
    <span>harder <span class="gradient" style="background:linear-gradient(90deg,${cssVar('--div-bad')},${cssVar('--div-mid')},${cssVar('--div-good')})"></span> better than usual</span>
    ${syms.length ? `<span>rare <span class="gradient" style="background:linear-gradient(90deg,${cssVar('--surface-2')},${cssVar('--seq')})"></span> often</span>` : ''}
    <span>▲ today</span>`;
}

function renderPhaseSummary() {
  const box = $('#phase-summary'), T = today(), P = pattern();
  const by = {};
  for (const p of PHASE_ORDER) by[p] = { days: 0, v: {} };
  for (const [d, e] of Object.entries(state.entries)) {
    if (d > T) continue;
    const ci = cycleInfo(d); if (!ci) continue;
    const b = by[ci.phase]; b.days++;
    for (const dim of dims()) { const v = e.m && e.m[dim.id]; if (v) (b.v[dim.id] = b.v[dim.id] || []).push(v); }
  }
  let html = '';
  for (const p of PHASE_ORDER) {
    const b = by[p];
    if (b.days < 3) continue;
    const items = [];
    for (const dim of dims()) {
      const vs = b.v[dim.id]; if (!vs || vs.length < 3) continue;
      const avg = mean(vs), u = P.usual[dim.id], raw = avg - u;
      if (Math.abs(raw) >= 0.3) items.push({ dim, avg, u, raw, g: goodness(dim, avg) });
    }
    items.sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw));
    html += `<div class="phase-block">${phasePill(p)} <span class="muted small">${b.days} days logged</span>
      ${items.length ? `<ul>${items.slice(0, 3).map(i =>
        `<li class="${i.g >= 0 ? 'up' : 'down'}"><span style="color:var(--ink)">${esc(i.dim.emoji)} ${esc(i.dim.label)} ${i.raw > 0 ? 'higher' : 'lower'}</span> <span class="muted">(${i.avg.toFixed(1)} vs usual ${i.u.toFixed(1)})</span></li>`).join('')}</ul>`
        : `<p class="muted small" style="margin:4px 0 0">Pretty much your usual.</p>`}
    </div>`;
  }
  box.innerHTML = html || `<div class="empty">Needs at least a few logged days in each phase.</div>`;
}

/* ---------- Calendar ---------- */
function renderCalendar() {
  const [y, mo] = ui.month.split('-').map(Number);
  const first = new Date(y, mo - 1, 1, 12);
  $('#month-label').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const box = $('#calendar'); box.innerHTML = '';
  const wds = [];
  for (let i = 0; i < 7; i++) wds.push(new Date(2024, 0, 1 + i, 12).toLocaleDateString(undefined, { weekday: 'narrow' })); // Jan 1 2024 = Monday
  for (const w of wds) box.insertAdjacentHTML('beforeend', `<div class="wd">${w}</div>`);
  const lead = (first.getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) box.insertAdjacentHTML('beforeend', '<div class="cday blank"></div>');
  const T = today(), daysIn = new Date(y, mo, 0).getDate();
  for (let dd = 1; dd <= daysIn; dd++) {
    const d = `${y}-${pad(mo)}-${pad(dd)}`, ci = cycleInfo(d), e = state.entries[d];
    const b = document.createElement('button');
    b.className = 'cday' + (d === T ? ' today' : '') + (d > T ? ' future' : '') + (ci && ci.predicted ? ' pred' : '');
    if (ci) b.style.setProperty('--bg', `var(--ph-${ci.phase}-t)`);
    let dots = '';
    if (e && e.f) dots += '<span class="dot flow"></span>';
    else if (ci && ci.predictedPeriod && d >= T) dots += '<span class="dot pflow"></span>';
    if (e && e.m && Object.keys(e.m).length) dots += '<span class="dot"></span>';
    b.innerHTML = `${dd}<span class="dots">${dots}</span>`;
    b.title = ci ? `Day ${ci.day} · ${PHASES[ci.phase].label}` : '';
    if (d <= T) b.onclick = () => { ui.date = d; show('today'); };
    box.appendChild(b);
  }
  $('#cal-legend').innerHTML = PHASE_ORDER.map(p =>
    `<span><span class="swatch" style="background:var(--ph-${p}-t);outline:1px solid var(--ph-${p})"></span>${PHASES[p].label}</span>`).join('')
    + `<span><span class="swatch" style="background:var(--ph-menstrual);border-radius:50%"></span>period</span>`
    + `<span><span class="swatch" style="border:1.5px solid var(--ph-menstrual);border-radius:50%"></span>predicted</span>`
    + `<span><span class="swatch" style="background:var(--ink-2);border-radius:50%"></span>checked in</span>`;
}
function shiftMonth(k) {
  const [y, m] = ui.month.split('-').map(Number);
  const d = new Date(y, m - 1 + k, 1, 12);
  ui.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  renderCalendar();
}
$('#prev-month').onclick = () => shiftMonth(-1);
$('#next-month').onclick = () => shiftMonth(1);

/* ---------- Settings ---------- */
function renderSettings() {
  const S = state.settings;
  $('#set-cycle').value = S.cycleLength;
  $('#set-period').value = S.periodLength;
  $('#set-luteal').value = S.lutealLength;
  $('#set-symptoms').value = S.symptoms.join('\n');
  const box = $('#dim-editor'); box.innerHTML = '';
  S.dimensions.forEach((dim, idx) => {
    const row = document.createElement('div');
    row.className = 'dim-row';
    row.innerHTML = `
      <input class="emoji" type="text" value="${esc(dim.emoji)}" aria-label="Emoji" maxlength="4">
      <input type="text" value="${esc(dim.label)}" aria-label="Name">
      <button class="x-btn" aria-label="Remove ${esc(dim.label)}">✕</button>
      <div class="sub">
        <input type="text" value="${esc(dim.low)}" aria-label="Label for 1" placeholder="1 means…">
        <input type="text" value="${esc(dim.high)}" aria-label="Label for 5" placeholder="5 means…">
        <select aria-label="Direction">
          <option value="1" ${dim.higherIsBetter ? 'selected' : ''}>Higher is better</option>
          <option value="0" ${!dim.higherIsBetter ? 'selected' : ''}>Higher is harder</option>
        </select>
      </div>`;
    const [emoji, label, low, high] = row.querySelectorAll('input');
    const commit = () => {
      Object.assign(dim, { emoji: emoji.value.trim() || '•', label: label.value.trim() || 'Untitled', low: low.value.trim(), high: high.value.trim(),
        higherIsBetter: row.querySelector('select').value === '1' });
      save();
    };
    row.addEventListener('change', commit);
    row.querySelector('.x-btn').onclick = () => {
      if (!confirm(`Remove "${dim.label}"? Its past data is kept and comes back if you restore a backup.`)) return;
      S.dimensions.splice(idx, 1); ui.tlDims = null; save(); renderSettings();
    };
    box.appendChild(row);
  });
  $('#add-dim').disabled = S.dimensions.length >= MAX_DIMS;
}
$('#add-dim').onclick = () => {
  const S = state.settings;
  if (S.dimensions.length >= MAX_DIMS) return;
  const used = new Set(S.dimensions.map(d => d.color));
  let color = 0; while (used.has(color)) color++;
  S.dimensions.push({ id: 'd' + Date.now().toString(36), emoji: '✨', label: 'New scale', low: 'low', high: 'high', higherIsBetter: true, color });
  save(); renderSettings();
};
for (const [id, key, lo, hi] of [['#set-cycle', 'cycleLength', 18, 60], ['#set-period', 'periodLength', 1, 12], ['#set-luteal', 'lutealLength', 9, 17]]) {
  $(id).addEventListener('change', ev => {
    const v = parseInt(ev.target.value, 10);
    if (!isNaN(v)) { state.settings[key] = clamp(v, lo, hi); save(); }
    ev.target.value = state.settings[key];
  });
}
$('#set-symptoms').addEventListener('change', ev => {
  state.settings.symptoms = [...new Set(ev.target.value.split('\n').map(s => s.trim()).filter(Boolean))];
  save();
});

$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `m00d-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#import').onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || typeof data.entries !== 'object') throw new Error('Not an m00d backup');
    if (!confirm(`Replace current data with this backup (${Object.keys(data.entries).length} days)?`)) return;
    const d = defaultState();
    state = { ...d, ...data, settings: { ...d.settings, ...data.settings } };
    ui.tlDims = null; save(); show('today');
  } catch (e) { alert('Could not import: ' + e.message); }
  ev.target.value = '';
};
$('#demo').onclick = () => {
  if (Object.keys(state.entries).length && !confirm('Replace current data with ~4 months of made-up demo data? (Export first if you want to keep yours.)')) return;
  state.entries = demoEntries(); ui.tlDims = null; save(); show('insights');
};
$('#clear').onclick = () => {
  if (!confirm('Delete ALL entries on this device? This cannot be undone.')) return;
  state.entries = {}; save(); show('today');
};

/* ---------- demo data ---------- */
function demoEntries() {
  const T = today(), out = {};
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const noise = k => (rnd() - 0.5) * k;
  const lens = [29, 27, 30, 28];
  const starts = [addDays(T, -17)];
  for (const L of lens) starts.unshift(addDays(starts[0], -L));
  const flowSeq = ['medium', 'heavy', 'medium', 'light', 'spotting'];
  const ids = new Set(dims().map(d => d.id));
  for (let d = starts[0]; d <= T; d = addDays(d, 1)) {
    let k = 0; while (k + 1 < starts.length && starts[k + 1] <= d) k++;
    const day = diff(starts[k], d) + 1;
    const L = k + 1 < starts.length ? diff(starts[k], starts[k + 1]) : 28;
    const pms = day > L - 8 ? (day - (L - 8)) / 8 : 0;          // ramps up in the last week
    const fol = day > 5 && day < L - 12 ? Math.sin(Math.PI * (day - 5) / (L - 17)) : 0; // mid-follicular lift
    const per = day <= 2 ? 1 : day <= 4 ? 0.5 : 0;
    const e = { m: {}, s: [], f: day <= 5 ? flowSeq[day - 1] : null, n: '' };
    if (rnd() < 0.85) {
      const v = { mood: 3.4 + 0.8 * fol - 1.3 * pms - 0.5 * per, energy: 3.2 + 0.9 * fol - 1.1 * pms - 1.0 * per,
        focus: 3.2 + 0.8 * fol - 0.9 * pms - 0.4 * per, anxiety: 2.1 + 1.2 * pms - 0.3 * fol, irritable: 1.8 + 1.7 * pms + 0.3 * per,
        sensitive: 2.0 + 1.9 * pms - 0.2 * fol, sleep: 3.5 - 0.8 * pms - 0.4 * per + 0.2 * fol };
      for (const id in v) if (ids.has(id)) e.m[id] = clamp(Math.round(v[id] + noise(1.3)), 1, 5);
      const p = (name, prob) => { if (rnd() < prob) e.s.push(name); };
      p('Cramps', day <= 2 ? 0.85 : day === 3 ? 0.3 : 0.02);
      p('Back pain', per * 0.4);
      p('Bloating', pms * 0.8 + 0.05);
      p('Breast tenderness', pms * 0.7);
      p('Cravings', pms * 0.8 + 0.05);
      p('Headache', 0.06 + pms * 0.25 + per * 0.2);
      p('Acne', pms * 0.4);
      e.s = e.s.filter(s => state.settings.symptoms.includes(s));
    }
    if (Object.keys(e.m).length || e.f || e.s.length) out[d] = e;
  }
  return out;
}

/* ---------- tooltip ---------- */
const tip = $('#tooltip');
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY - r.height - 12;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
  if (x < 8) x = 8;
  if (y < 8) y = ev.clientY + 18;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { tip.hidden = true; }
document.addEventListener('pointerdown', ev => { if (!ev.target.closest('.chart')) hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });

/* ---------- boot ---------- */
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => show(b.dataset.view);
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
// Roll "today" over if the app stays open past midnight.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { invalidate(); if (ui.date > today()) ui.date = today(); render(); }
});
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
