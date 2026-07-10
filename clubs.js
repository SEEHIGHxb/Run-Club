// ============================================================================
//  Runaway · Clubs
//  Club directory, dashboard (members, leaderboard, Run-or-Lose pool, runs),
//  create/join/leave/kick/settings flows, and the ?c=CODE invite modal.
//  Publishes the active club's data into shared state so the main-page
//  leaderboard's Club view can render it.
// ============================================================================

import {
  fetchClubs,
  fetchClubDetails,
  fetchClubMembers,
  fetchClubRuns,
  getClubByCode,
  createClub,
  joinClub,
  leaveClub,
  deleteClub,
  updateClubSettings,
} from './db.js?v=4';
import { state } from './state.js';
import { $, escapeHtml, formatDisplayName, avatarImg, rangeCutoff, copyInputToClipboard } from './util.js';
import {
  renderLeaderboard,
  renderClubBahtChallenge,
  computeRankedTotals,
  lbRowsHtml,
  runItemHtml,
  bindRunDeleteButtons,
} from './leaderboard.js';

// ---- Clubs state (private to this module) -----------------------------------
let clubs = [];                 // list of user's clubs
let activeClubId = null;        // active club ID ('directory' shows the empty state)
let lastActiveClubId = null;    // last viewed active club ID
let clubRange = 'all';          // week | month | all
let pendingClubAction = null;   // club invite link action from a URL (?c=INVITE_CODE)

// Injected by app.js at startup to avoid circular imports.
let deps = {
  switchTab: () => {},
  reloadRuns: async () => {},
};

export function initClubs(injected) {
  deps = injected;

  $('#club-create-form').addEventListener('submit', onClubCreateSubmit);
  $('#club-join-form').addEventListener('submit', onClubJoinSubmit);
  $('#club-selector').addEventListener('change', (e) => {
    activeClubId = e.target.value || null;
    loadClubs();
  });
  $('#btn-copy-club-link').addEventListener('click', () =>
    copyInputToClipboard('#club-invite-link', '#btn-copy-club-link'));
  $('#btn-leave-club').addEventListener('click', onLeaveClubClick);
  $('#btn-delete-club').addEventListener('click', onDeleteClubClick);
  $('#club-settings-form').addEventListener('submit', onClubSettingsSubmit);

  $('#btn-club-to-directory').addEventListener('click', () => {
    activeClubId = 'directory';
    loadClubs();
  });
  $('#btn-club-back-to-dashboard').addEventListener('click', () => {
    activeClubId = lastActiveClubId || (clubs.length > 0 ? clubs[0].id : null);
    loadClubs();
  });

  $('#f-club-create-pool').addEventListener('change', (e) => {
    $('#club-create-pool-details').style.display = e.target.checked ? 'flex' : 'none';
  });
  $('#f-club-settings-pool').addEventListener('change', (e) => {
    $('#club-settings-pool-details').style.display = e.target.checked ? 'flex' : 'none';
  });

  document.querySelectorAll('.club-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      clubRange = btn.dataset.range;
      document.querySelectorAll('.club-range-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderClubLeaderboard();
    });
  });

  $('#btn-club-invite-accept').addEventListener('click', acceptPendingClubAction);
  $('#btn-club-invite-decline').addEventListener('click', closeClubInviteModal);
}

export function setPendingClubAction(action) {
  pendingClubAction = action;
}

// The runs realtime subscription only refreshes club views when one is open.
export function hasActiveClub() {
  return Boolean(activeClubId);
}

// ---------------------------------------------------------------------------
//  Data loading
// ---------------------------------------------------------------------------
export async function loadClubs() {
  if (!state.me) return;
  try {
    clubs = await fetchClubs();
    if (clubs.length === 0) {
      activeClubId = null;
      state.activeClub = null;
      state.activeClubMembers = [];
      state.activeClubRuns = [];
      renderClubsView();
      renderLeaderboard();
      return;
    }

    if (activeClubId === 'directory') {
      state.activeClub = null;
      state.activeClubMembers = [];
      state.activeClubRuns = [];
      renderClubsView();
      renderLeaderboard();
      return;
    }

    // Populate active selector
    const selector = $('#club-selector');
    selector.innerHTML = clubs
      .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
      .join('');

    // Select first club if current active is invalid or unset
    if (!activeClubId || !clubs.some(c => c.id === activeClubId)) {
      activeClubId = clubs[0].id;
    }
    selector.value = activeClubId;
    // Load active club details
    state.activeClub = await fetchClubDetails(activeClubId);
    state.activeClubMembers = await fetchClubMembers(activeClubId);
    state.activeClubRuns = await fetchClubRuns(state.activeClubMembers.map(m => m.id));

    lastActiveClubId = activeClubId;
    renderClubsView();
    renderLeaderboard();
  } catch (err) {
    console.error('Error loading clubs:', err);
  }
}

// ---------------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------------
function renderClubsView() {
  const isEmpty = activeClubId === null;
  $('#club-empty-state').hidden = !isEmpty;
  $('#club-active-state').hidden = isEmpty;

  if (isEmpty) {
    const backBtn = $('#club-back-to-dashboard-container');
    if (backBtn) backBtn.style.display = (clubs.length > 0) ? 'block' : 'none';
    return;
  }

  const isOwner = state.activeClub.owner_id === state.me.id;
  const ownerProfile = state.activeClubMembers.find(m => m.id === state.activeClub.owner_id);
  $('#club-owner-name').textContent = ownerProfile ? formatDisplayName(ownerProfile.display_name) : 'Unknown';

  const link = window.location.origin + window.location.pathname + '?c=' + state.activeClub.invite_code;
  $('#club-invite-link').value = link;
  $('#club-display-code').textContent = state.activeClub.invite_code;

  // Manage owner settings card
  const settingsCard = $('#club-settings-card');
  if (isOwner) {
    settingsCard.hidden = false;
    $('#f-club-settings-name').value = state.activeClub.name;
    $('#f-club-settings-pool').checked = state.activeClub.pool_enabled;
    $('#f-club-settings-baht').value = state.activeClub.pool_baht_per_km;
    $('#f-club-settings-max-loss').value = state.activeClub.pool_max_loss;
    $('#club-settings-pool-details').style.display = state.activeClub.pool_enabled ? 'flex' : 'none';
  } else {
    settingsCard.hidden = true;
  }

  // Render Members
  const memList = $('#club-members-list');
  memList.innerHTML = state.activeClubMembers
    .map(member => {
      const isMemberOwner = member.id === state.activeClub.owner_id;
      const isSelf = member.id === state.me.id;

      let badge = '';
      if (isMemberOwner) badge += '<span class="owner-chip">Owner</span>';
      if (isSelf) badge += '<span class="you-chip">You</span>';

      let kickBtn = '';
      if (isOwner && !isSelf) {
        kickBtn = `<button class="btn btn-ghost btn-sm kick-member-btn" data-uid="${member.id}" data-name="${escapeHtml(member.display_name)}" style="color: var(--danger); padding: 2px 8px; font-size: 0.75rem;">Kick</button>`;
      }

      return `
        <li class="run-item">
          <div class="run-main" style="justify-content:space-between; width:100%; align-items:center;">
            <div class="user-profile">
              ${avatarImg(member.avatar_url, ' style="width:20px; height:20px;"')}
              <span class="lb-name" style="font-size:0.9rem;">${escapeHtml(formatDisplayName(member.display_name))}</span>
              ${badge}
            </div>
            ${kickBtn}
          </div>
        </li>`;
    })
    .join('');

  memList.querySelectorAll('.kick-member-btn').forEach(btn => {
    btn.addEventListener('click', () => onKickMemberClick(btn.dataset.uid, btn.dataset.name));
  });

  // Render Runs, Leaderboard, Pool
  renderClubLeaderboard();
  renderClubRuns();
}

function renderClubLeaderboard() {
  const ranked = computeRankedTotals(state.activeClubRuns, rangeCutoff(clubRange), state.activeClubMembers);
  const el = $('#club-leaderboard');
  if (ranked.length === 0) {
    el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
    $('#club-baht-section').hidden = true;
    return;
  }

  el.innerHTML = lbRowsHtml(ranked);

  // Handle Baht Challenge
  const bahtSection = $('#club-baht-section');
  if (state.activeClub.pool_enabled && ranked.length > 1) {
    bahtSection.hidden = false;
    renderClubBahtChallenge(ranked, '#club-baht-list');
  } else {
    bahtSection.hidden = true;
  }
}

function renderClubRuns() {
  const el = $('#club-run-list');
  if (state.activeClubRuns.length === 0) {
    el.innerHTML = `<li class="empty">No runs logged yet by club members.</li>`;
    return;
  }

  el.innerHTML = state.activeClubRuns.map(runItemHtml).join('');
  // Reload everything to sync after a delete
  bindRunDeleteButtons(el, async () => {
    await Promise.all([deps.reloadRuns(), loadClubs()]);
  });
}

// ---------------------------------------------------------------------------
//  Create / join / leave / settings handlers
// ---------------------------------------------------------------------------
async function onClubCreateSubmit(e) {
  e.preventDefault();
  const nameField = $('#f-club-create-name');
  const poolCheck = $('#f-club-create-pool').checked;
  const bahtField = $('#f-club-create-baht');
  const maxLossField = $('#f-club-create-max-loss');
  const msg = $('#club-create-msg');

  const name = nameField.value.trim();
  if (name.length < 2) {
    msg.textContent = 'Name must be at least 2 characters.';
    return;
  }

  msg.textContent = 'Creating...';
  try {
    const club = await createClub(
      name,
      poolCheck,
      poolCheck ? Number(bahtField.value) : 10,
      poolCheck ? Number(maxLossField.value) : 200
    );
    nameField.value = '';
    activeClubId = club.id;
    await loadClubs();
    msg.textContent = '';
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
  }
}

async function onClubJoinSubmit(e) {
  e.preventDefault();
  const field = $('#f-club-join-code');
  const msg = $('#club-join-msg');
  const code = field.value.trim();

  if (!code) return;

  msg.textContent = 'Joining...';
  try {
    const club = await joinClub(code);
    field.value = '';
    activeClubId = club.id;
    await loadClubs();
    msg.textContent = '';
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
  }
}

async function onClubSettingsSubmit(e) {
  e.preventDefault();
  const name = $('#f-club-settings-name').value.trim();
  const pool = $('#f-club-settings-pool').checked;
  const baht = $('#f-club-settings-baht').value;
  const maxLoss = $('#f-club-settings-max-loss').value;
  const msg = $('#club-settings-msg');

  if (name.length < 2) {
    msg.textContent = 'Name must be at least 2 characters.';
    return;
  }

  msg.textContent = 'Saving...';
  try {
    await updateClubSettings(activeClubId, {
      name,
      pool_enabled: pool,
      pool_baht_per_km: pool ? Number(baht) : 10,
      pool_max_loss: pool ? Number(maxLoss) : 200
    });
    msg.textContent = 'Settings saved!';
    msg.style.color = '#22c55e';
    await loadClubs();
    setTimeout(() => { msg.textContent = ''; msg.style.color = 'var(--muted)'; }, 3000);
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
    msg.style.color = 'var(--danger)';
  }
}

async function onLeaveClubClick() {
  if (!confirm('Are you sure you want to leave this club?')) return;
  try {
    await leaveClub(activeClubId);
    activeClubId = null;
    await loadClubs();
  } catch (err) {
    alert('Error leaving club: ' + err.message);
  }
}

async function onDeleteClubClick() {
  if (!confirm('CRITICAL: Are you sure you want to delete this club? This will permanently remove all memberships. This cannot be undone!')) return;
  try {
    await deleteClub(activeClubId);
    activeClubId = null;
    await loadClubs();
  } catch (err) {
    alert('Error deleting club: ' + err.message);
  }
}

async function onKickMemberClick(userId, name) {
  if (!confirm(`Are you sure you want to kick "${name}" from this club?`)) return;
  try {
    await leaveClub(activeClubId, userId);
    await loadClubs();
  } catch (err) {
    alert('Error kicking member: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
//  Club invite links (?c=CODE)
// ---------------------------------------------------------------------------
export async function handlePendingClubAction() {
  if (!pendingClubAction) return;

  const modal = $('#club-invite-modal');
  const title = $('#club-invite-title');
  const desc = $('#club-invite-desc');
  const err = $('#club-invite-error');

  err.hidden = true;
  modal.hidden = false;

  try {
    title.textContent = 'Join Club';
    desc.textContent = 'Resolving club code...';

    const club = await getClubByCode(pendingClubAction.code);
    if (!club) {
      throw new Error('That club invite link is invalid or has expired.');
    }

    pendingClubAction.id = club.id;
    desc.textContent = `Would you like to join the club "${club.name}"?`;
  } catch (e) {
    desc.textContent = 'Oops! Something went wrong.';
    err.textContent = e.message;
    err.hidden = false;
    $('#btn-club-invite-accept').disabled = true;
  }
}

async function acceptPendingClubAction() {
  const err = $('#club-invite-error');
  const btn = $('#btn-club-invite-accept');
  btn.disabled = true;
  err.hidden = true;

  try {
    await joinClub(pendingClubAction.code);
    alert('Joined successfully!');
    activeClubId = pendingClubAction.id;
    await loadClubs();
    closeClubInviteModal();
    deps.switchTab('clubs');
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function closeClubInviteModal() {
  $('#club-invite-modal').hidden = true;
  $('#btn-club-invite-accept').disabled = false;
  pendingClubAction = null;
}
