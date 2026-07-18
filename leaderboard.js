// ============================================================================
//  Runaway · Leaderboard, runs list & Baht challenge rendering
//  Owns the main-page leaderboard (All Friends / Club views), the recent-runs
//  list, and the shared building blocks the clubs tab reuses: ranked-total
//  computation, leaderboard row HTML, run item HTML, and the Run-or-Lose Baht
//  challenge renderer.
// ============================================================================

import { deleteRun } from './db.js?v=4';
import { state } from './state.js';
import {
  $, escapeHtml, formatDisplayName, avatarImg,
  rangeCutoff, fmtKm, fmtDate, fmtDuration, paceLabel, sum,
} from './util.js';

// ---- Filter state (private to this module) ----------------------------------
let range = 'all';       // week | month | all
let onlyMine = false;    // recent-runs list: only my runs
let lbType = 'all';      // main page leaderboard type (all | club)

// Injected by app.js at startup to avoid circular imports.
let deps = {
  switchTab: () => {},
  reloadRuns: async () => {},
};

export function initLeaderboard(injected) {
  deps = injected;

  $('#only-mine').addEventListener('change', (e) => {
    onlyMine = e.target.checked;
    renderRuns();
  });

  document.querySelectorAll('#panel-runs .seg[aria-label="Leaderboard range"] .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.range;
      document.querySelectorAll('#panel-runs .seg[aria-label="Leaderboard range"] .seg-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderLeaderboard();
    });
  });

  // Main Page Leaderboard Switcher
  $('#btn-lb-type-all').addEventListener('click', () => {
    lbType = 'all';
    $('#btn-lb-type-all').classList.add('active');
    $('#btn-lb-type-club').classList.remove('active');
    renderLeaderboard();
  });
  $('#btn-lb-type-club').addEventListener('click', () => {
    lbType = 'club';
    $('#btn-lb-type-club').classList.add('active');
    $('#btn-lb-type-all').classList.remove('active');
    renderLeaderboard();
  });
}

// Fresh logins shouldn't inherit the previous session's filters.
export function resetLeaderboardFilters() {
  lbType = 'all';
  range = 'all';
  onlyMine = false;

  const onlyMineEl = $('#only-mine');
  if (onlyMineEl) onlyMineEl.checked = false;

  const btnAll = $('#btn-lb-type-all');
  const btnClub = $('#btn-lb-type-club');
  if (btnAll) btnAll.classList.add('active');
  if (btnClub) btnClub.classList.remove('active');

  document.querySelectorAll('#panel-runs .seg[aria-label="Leaderboard range"] .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === 'all');
  });
}

// ---------------------------------------------------------------------------
//  Shared building blocks (also used by clubs.js)
// ---------------------------------------------------------------------------

// Total up km/run-counts per user within the cutoff, ranked by km descending.
// With `members`, every member starts at 0 km (so non-runners still appear —
// the point of the challenge) and runs from non-members are ignored. Without
// it, entries are created from the runs themselves.
export function computeRankedTotals(runList, cutoff, members = null) {
  const inRange = runList.filter((r) => (cutoff ? r.run_date >= cutoff : true));

  const totals = new Map();
  if (members) {
    for (const m of members) {
      totals.set(m.id, { name: formatDisplayName(m.display_name || 'Anonymous'), avatar: m.avatar_url || '', km: 0, runs: 0 });
    }
  }

  for (const r of inRange) {
    if (members && !totals.has(r.user_id)) continue;
    const cur = totals.get(r.user_id) || {
      name: formatDisplayName(r.profiles?.display_name || 'Anonymous'),
      avatar: r.profiles?.avatar_url || '',
      km: 0,
      runs: 0,
    };
    cur.km += Number(r.distance_km);
    cur.runs += 1;
    totals.set(r.user_id, cur);
  }

  return [...totals.entries()]
    .map(([userId, t]) => ({ userId, ...t }))
    .sort((a, b) => b.km - a.km);
}

export function lbRowsHtml(ranked) {
  return ranked
    .map((row, i) => `
      <li class="lb-row${row.userId === state.me.id ? ' is-me' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <div class="user-profile">
          ${avatarImg(row.avatar, ' style="width:24px; height:24px;"')}
          <span class="lb-name">${escapeHtml(row.name)}</span>
        </div>
        <span class="lb-runs">${row.runs} run${row.runs === 1 ? '' : 's'}</span>
        <span class="lb-km">${fmtKm(row.km)}</span>
      </li>`)
    .join('');
}

export function runItemHtml(r) {
  const pace = paceLabel(r.distance_km, r.duration_min);
  const isMine = r.user_id === state.me.id;
  const runnerName = formatDisplayName(r.profiles?.display_name || 'Anonymous');
  const avatar = r.profiles?.avatar_url || '';
  const shareRight = isMine ? '36px' : '8px';

  return `
    <li class="run-item">
      <div class="run-main">
        <span class="run-km">${fmtKm(r.distance_km)}</span>
        <div class="user-profile" style="display:inline-flex;">
          ${avatarImg(avatar, ' style="width:18px; height:18px; border:1px solid var(--brand)"')}
          <span class="run-runner">${escapeHtml(runnerName)}</span>
        </div>
        ${pace ? `<span class="run-pace">${pace}</span>` : ''}
      </div>
      <div class="run-meta">
        <span>${fmtDate(r.run_date)}</span>
        ${r.duration_min ? `<span>${fmtDuration(r.duration_min)}</span>` : ''}
        ${r.notes ? `<span class="run-notes">${escapeHtml(r.notes)}</span>` : ''}
      </div>
      <button type="button" class="run-share" data-id="${r.id}" style="right:${shareRight}" title="Share this run" aria-label="Share run">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
      </button>
      ${isMine ? `<button class="run-del" data-id="${r.id}" title="Delete this run" aria-label="Delete run">✕</button>` : ''}
    </li>`;
}

// Wire up the ✕ buttons a run list rendered; afterDelete reloads whatever
// views the caller cares about.
export function bindRunDeleteButtons(el, afterDelete) {
  el.querySelectorAll('.run-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this run?')) return;
      try {
        await deleteRun(btn.dataset.id);
        await afterDelete();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    });
  });
}

// Wire up the share buttons
export function bindRunShareButtons(el, onShare) {
  el.querySelectorAll('.run-share').forEach((btn) => {
    btn.addEventListener('click', () => {
      onShare(btn.dataset.id);
    });
  });
}


// ---------------------------------------------------------------------------
//  Main-page leaderboard
// ---------------------------------------------------------------------------
export function renderLeaderboard() {
  const label = $('#lb-type-label');
  const mainBahtSection = $('#main-baht-section');
  const el = $('#leaderboard');

  if (lbType === 'all') {
    if (label) label.textContent = 'All Friends';
    if (mainBahtSection) mainBahtSection.hidden = true;

    const ranked = computeRankedTotals(state.runs, rangeCutoff(range));
    if (ranked.length === 0) {
      el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
      return;
    }
    el.innerHTML = lbRowsHtml(ranked);
    return;
  }

  // lbType === 'club'
  if (!state.activeClub) {
    if (label) label.textContent = 'No active club';
    if (mainBahtSection) mainBahtSection.hidden = true;
    el.innerHTML = `<li class="empty">You are not in any club yet. <a href="#" id="link-switch-to-clubs" style="color:var(--brand); font-weight:600; text-decoration:underline;">Join or create a club</a> to view the club leaderboard.</li>`;

    setTimeout(() => {
      const link = $('#link-switch-to-clubs');
      if (link) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          deps.switchTab('clubs');
        });
      }
    }, 0);
    return;
  }

  if (label) {
    label.innerHTML = `Club: ${escapeHtml(state.activeClub.name)} <button type="button" id="btn-share-club-board" class="btn btn-ghost btn-sm" style="padding: 2px 6px; font-size: 0.75rem; margin-left: 8px;" title="Share Leaderboard">Share</button>`;
    setTimeout(() => {
      const shareBtn = $('#btn-share-club-board');
      if (shareBtn) {
        shareBtn.addEventListener('click', () => {
          if (deps.onShareLeaderboard) {
            deps.onShareLeaderboard(state.activeClub.name, range, ranked);
          }
        });
      }
    }, 0);
  }

  const ranked = computeRankedTotals(state.activeClubRuns, rangeCutoff(range), state.activeClubMembers);
  if (ranked.length === 0) {
    el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
    if (mainBahtSection) mainBahtSection.hidden = true;
    return;
  }
  el.innerHTML = lbRowsHtml(ranked);

  // Handle Baht Challenge for club on the main page
  if (state.activeClub.pool_enabled && ranked.length > 1) {
    if (mainBahtSection) {
      mainBahtSection.hidden = false;
      renderClubBahtChallenge(ranked, '#main-baht-list');
    }
  } else {
    if (mainBahtSection) mainBahtSection.hidden = true;
  }
}

// ---------------------------------------------------------------------------
//  Recent runs list
// ---------------------------------------------------------------------------
export function renderRuns() {
  const list = onlyMine ? state.runs.filter((r) => r.user_id === state.me.id) : state.runs;
  const el = $('#run-list');

  if (list.length === 0) {
    el.innerHTML = `<li class="empty">No runs logged yet.</li>`;
    return;
  }

  el.innerHTML = list.map(runItemHtml).join('');
  bindRunDeleteButtons(el, deps.reloadRuns);
  bindRunShareButtons(el, (runId) => {
    const run = list.find(r => r.id === runId);
    if (run && deps.onShareRun) {
      deps.onShareRun(run);
    }
  });
}

// ---------------------------------------------------------------------------
//  Run or Lose · zero-sum Baht challenge
//  Losers pay the club's Baht-per-km rate on their shortfall vs the average of
//  the OTHER runners (capped at pool_max_loss); the lost pool is split among
//  above-average runners proportionally to how far above average they ran.
// ---------------------------------------------------------------------------
export function renderClubBahtChallenge(ranked, targetSelector = '#club-baht-list') {
  const bahtList = $(targetSelector);
  if (!bahtList) return;
  const bahtPerKm = Number(state.activeClub.pool_baht_per_km);
  const maxLoss = Number(state.activeClub.pool_max_loss);

  // 1. Calculate raw diff for each runner comparing to average of others
  const runnersCalculated = ranked.map((row) => {
    const otherRunners = ranked.filter((r) => r.userId !== row.userId);
    const otherSum = sum(otherRunners.map(r => r.km));
    const otherAvg = otherSum / otherRunners.length;
    const diff = row.km - otherAvg;
    const rawLoss = diff < 0 ? -diff * bahtPerKm : 0;
    const loss = Math.min(rawLoss, maxLoss);
    return {
      ...row,
      diff,
      loss
    };
  });

  const totalLossPool = sum(runnersCalculated.map(r => r.loss));
  const winners = runnersCalculated.filter(r => r.diff > 0);
  const totalWinnerDiffs = sum(winners.map(r => r.diff));

  // 2. Distribute total loss to winners proportionally
  const challengeRows = runnersCalculated.map((row) => {
    let amount = 0;
    let type = 'neutral'; // gain | lose | neutral

    if (row.diff < 0) {
      amount = row.loss;
      type = 'lose';
    } else if (row.diff > 0 && totalWinnerDiffs > 0) {
      amount = totalLossPool * (row.diff / totalWinnerDiffs);
      type = 'gain';
    }

    return {
      ...row,
      amount,
      type
    };
  });

  // 3. Render challenge rows
  bahtList.innerHTML = challengeRows
    .map((row) => {
      let text = '';
      let badgeClass = '';
      if (row.type === 'gain') {
        text = `gain ${row.amount.toFixed(2)} baht`;
        badgeClass = 'baht-gain';
      } else if (row.type === 'lose') {
        text = `lose ${row.amount.toFixed(2)} baht`;
        badgeClass = 'baht-lose';
      } else {
        text = `gain 0.00 baht`;
        badgeClass = 'baht-neutral';
      }

      const isMe = row.userId === state.me.id;

      return `
        <li class="lb-row${isMe ? ' is-me' : ''}" style="grid-template-columns: auto 1fr auto;">
          <div class="user-profile">
            ${avatarImg(row.avatar, ' style="width:20px; height:20px;"')}
            <span class="lb-name" style="font-size:0.9rem;">${escapeHtml(row.name)}</span>
            ${isMe ? '<span class="you-chip">You</span>' : ''}
          </div>
          <span></span>
          <span class="baht-badge ${badgeClass}">
            ${text}
          </span>
        </li>`;
    })
    .join('');
}
