// ============================================================================
//  Run Club — App logic
//  Wires the gate, the run form, the realtime run list, and the leaderboard.
//  Entry point loaded by index.html. Depends on config.js and db.js.
// ============================================================================

import { APP_PASSCODE, ROSTER } from './config.js';
import {
  isConfigured, fetchRuns, addRun, deleteRun, subscribeToRuns,
} from './db.js';

// ---- Persistent identity (device-local, not a real account) ----------------
const NAME_KEY = 'runclub.name';
const GATE_KEY = 'runclub.unlocked';

const $ = (sel) => document.querySelector(sel);

let me = localStorage.getItem(NAME_KEY) || '';
let runs = [];              // full run list, newest first
let range = 'week';         // leaderboard range: week | month | all
let onlyMine = false;
let unsubscribe = null;

// ---------------------------------------------------------------------------
//  Startup
// ---------------------------------------------------------------------------
init();

function init() {
  populateRoster();

  // If Supabase isn't configured yet, tell the user plainly and stop.
  if (!isConfigured) {
    showSetupNotice();
    return;
  }

  $('#gate-form').addEventListener('submit', onGateSubmit);
  $('#run-form').addEventListener('submit', onAddRun);
  $('#btn-switch').addEventListener('click', switchUser);
  $('#f-date').value = todayISO();

  $('#only-mine').addEventListener('change', (e) => {
    onlyMine = e.target.checked;
    renderRuns();
  });
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.range;
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderLeaderboard();
    });
  });

  // Already unlocked on this device? Go straight in.
  if (localStorage.getItem(GATE_KEY) === '1' && me) {
    enterApp();
  }
}

// ---------------------------------------------------------------------------
//  Gate
// ---------------------------------------------------------------------------
function onGateSubmit(e) {
  e.preventDefault();
  const pass = $('#gate-pass').value.trim();
  const name = $('#gate-name').value.trim();
  const err = $('#gate-error');

  if (pass !== APP_PASSCODE) {
    err.textContent = 'Wrong passcode. Ask the group organizer.';
    err.hidden = false;
    return;
  }
  if (!name) {
    err.textContent = 'Please enter your name.';
    err.hidden = false;
    return;
  }
  err.hidden = true;
  me = name;
  localStorage.setItem(NAME_KEY, me);
  localStorage.setItem(GATE_KEY, '1');
  enterApp();
}

function switchUser() {
  localStorage.removeItem(GATE_KEY);
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  $('#app').hidden = true;
  $('#gate').style.display = '';
  $('#gate-pass').value = '';
  $('#gate-name').value = me;
}

async function enterApp() {
  $('#gate').style.display = 'none';
  $('#app').hidden = false;
  $('#who-name').textContent = me;
  $('#gate-name').value = me;

  await loadRuns();

  // Live updates: any change from any friend re-pulls the list. The status
  // callback drives the live-dot so it reflects the real connection state.
  unsubscribe = subscribeToRuns(
    async () => { await loadRuns(); },
    (status) => setLive(status === 'SUBSCRIBED'),
  );
}

// ---------------------------------------------------------------------------
//  Data load + render
// ---------------------------------------------------------------------------
async function loadRuns() {
  try {
    runs = await fetchRuns();
    setLive(true);
    renderAll();
  } catch (err) {
    setLive(false);
    $('#conn-note').textContent = 'Could not reach the database: ' + err.message;
  }
}

function renderAll() {
  renderSummary();
  renderLeaderboard();
  renderRuns();
}

// ---- Summary strip ----------------------------------------------------------
function renderSummary() {
  const totalKm = sum(runs.map((r) => Number(r.distance_km)));
  const runners = new Set(runs.map((r) => r.runner)).size;
  const myKm = sum(runs.filter((r) => r.runner === me).map((r) => Number(r.distance_km)));
  const cards = [
    { label: 'Total distance', value: fmtKm(totalKm) },
    { label: 'Runs logged', value: String(runs.length) },
    { label: 'Runners', value: String(runners) },
    { label: 'Your distance', value: fmtKm(myKm) },
  ];
  $('#summary').innerHTML = cards
    .map((c) => `<div class="stat"><div class="stat-value">${c.value}</div><div class="stat-label">${c.label}</div></div>`)
    .join('');
}

// ---- Leaderboard ------------------------------------------------------------
function renderLeaderboard() {
  const cutoff = rangeCutoff(range);
  const inRange = runs.filter((r) => (cutoff ? r.run_date >= cutoff : true));

  const totals = new Map();
  for (const r of inRange) {
    const cur = totals.get(r.runner) || { km: 0, runs: 0 };
    cur.km += Number(r.distance_km);
    cur.runs += 1;
    totals.set(r.runner, cur);
  }

  const ranked = [...totals.entries()]
    .map(([runner, t]) => ({ runner, ...t }))
    .sort((a, b) => b.km - a.km);

  const el = $('#leaderboard');
  if (ranked.length === 0) {
    el.innerHTML = `<li class="empty">No runs in this range yet — be the first! 🎉</li>`;
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  el.innerHTML = ranked
    .map((row, i) => `
      <li class="lb-row${row.runner === me ? ' is-me' : ''}">
        <span class="lb-rank">${medals[i] || i + 1}</span>
        <span class="lb-name">${escapeHtml(row.runner)}</span>
        <span class="lb-runs">${row.runs} run${row.runs === 1 ? '' : 's'}</span>
        <span class="lb-km">${fmtKm(row.km)}</span>
      </li>`)
    .join('');
}

// ---- Recent runs ------------------------------------------------------------
function renderRuns() {
  const list = onlyMine ? runs.filter((r) => r.runner === me) : runs;
  const el = $('#run-list');
  if (list.length === 0) {
    el.innerHTML = `<li class="empty">No runs logged yet.</li>`;
    return;
  }
  el.innerHTML = list
    .map((r) => {
      const pace = paceLabel(r.distance_km, r.duration_min);
      const mine = r.runner === me;
      return `
        <li class="run-item">
          <div class="run-main">
            <span class="run-km">${fmtKm(r.distance_km)}</span>
            <span class="run-runner">${escapeHtml(r.runner)}</span>
            ${pace ? `<span class="run-pace">${pace}</span>` : ''}
          </div>
          <div class="run-meta">
            <span>${fmtDate(r.run_date)}</span>
            ${r.duration_min ? `<span>${fmtDuration(r.duration_min)}</span>` : ''}
            ${r.notes ? `<span class="run-notes">${escapeHtml(r.notes)}</span>` : ''}
          </div>
          ${mine ? `<button class="run-del" data-id="${r.id}" title="Delete this run" aria-label="Delete run">✕</button>` : ''}
        </li>`;
    })
    .join('');

  el.querySelectorAll('.run-del').forEach((btn) => {
    btn.addEventListener('click', () => onDeleteRun(btn.dataset.id));
  });
}

// ---------------------------------------------------------------------------
//  Mutations
// ---------------------------------------------------------------------------
async function onAddRun(e) {
  e.preventDefault();
  const msg = $('#run-msg');
  const distance = Number($('#f-distance').value);
  const date = $('#f-date').value;
  const durationRaw = $('#f-duration').value.trim();
  const notes = $('#f-notes').value.trim();

  if (!(distance > 0)) { msg.textContent = 'Enter a distance greater than 0.'; return; }
  if (!date) { msg.textContent = 'Pick a date.'; return; }

  const run = {
    runner: me,
    distance_km: distance,
    run_date: date,
    duration_min: durationRaw ? Number(durationRaw) : null,
    notes: notes || null,
  };

  const btn = $('#run-form button[type="submit"]');
  btn.disabled = true;
  msg.textContent = 'Saving…';
  try {
    await addRun(run);
    // Realtime will also refresh, but update now for snappiness.
    await loadRuns();
    e.target.reset();
    $('#f-date').value = todayISO();
    msg.textContent = 'Added! 🎉';
    setTimeout(() => (msg.textContent = ''), 2000);
  } catch (err) {
    msg.textContent = 'Save failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function onDeleteRun(id) {
  if (!confirm('Delete this run?')) return;
  try {
    await deleteRun(id);
    await loadRuns();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function populateRoster() {
  const dl = $('#roster');
  if (!dl) return;
  dl.innerHTML = (ROSTER || []).map((n) => `<option value="${escapeHtml(n)}">`).join('');
}

function showSetupNotice() {
  $('#gate').innerHTML = `
    <div class="gate-card">
      <div class="gate-emoji">🛠️</div>
      <h1>Almost there</h1>
      <p class="gate-sub">Add your Supabase URL and anon key in <code>config.js</code>,
      then run the SQL in <code>schema.sql</code>. See <code>README.md</code> for the 5-minute setup.</p>
    </div>`;
}

function setLive(on) {
  const dot = $('#live-dot');
  if (!dot) return;
  dot.classList.toggle('on', on);
  dot.classList.toggle('off', !on);
  $('#conn-note').textContent = on ? 'Connected · updates live' : 'Offline — retrying…';
}

// Date-only ISO (YYYY-MM-DD) in local time.
function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// Returns the ISO date (YYYY-MM-DD) cutoff for a range, or null for "all".
function rangeCutoff(r) {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const local = new Date(now.getTime() - off * 60000);
  if (r === 'all') return null;
  if (r === 'month') {
    return local.toISOString().slice(0, 7) + '-01';
  }
  // week: Monday as start of week
  const day = (local.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(local.getTime() - day * 86400000);
  return monday.toISOString().slice(0, 10);
}

function paceLabel(km, min) {
  const d = Number(km);
  const m = Number(min);
  if (!(d > 0) || !(m > 0)) return '';
  const pace = m / d; // min per km
  const mm = Math.floor(pace);
  const ss = Math.round((pace - mm) * 60);
  const ssStr = ss === 60 ? '00' : String(ss).padStart(2, '0');
  return `${ss === 60 ? mm + 1 : mm}:${ssStr}/km`;
}

function fmtKm(km) {
  const n = Number(km);
  return (Number.isInteger(n) ? n : Number(n.toFixed(2))) + ' km';
}

function fmtDuration(min) {
  const m = Number(min);
  if (m < 60) return `${m % 1 === 0 ? m : m.toFixed(1)} min`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return `${h}h ${rem}m`;
}

function fmtDate(iso) {
  // iso is YYYY-MM-DD; render as e.g. "Sun 5 Jul"
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
