// ============================================================================
//  Run or Lose Club — App logic
//  Handles login/logout, navigation tabs, theme toggling, friend system,
//  group invitations, floating log modals, and zero-sum Baht calculations.
// ============================================================================

import {
  isConfigured,
  supabase,
  loginWithGoogle,
  logout,
  onAuthChange,
  getCurrentUser,
  fetchRuns,
  addRun,
  deleteRun,
  subscribeToRuns,
  fetchProfile,
  fetchFriends,
  fetchPendingRequests,
  sendFriendRequest,
  acceptFriendRequest,
  removeFriendship,
  fetchGroups,
  createGroup,
  fetchGroupMembers,
  getOrCreateGroupInvite,
  fetchInvite,
  joinGroupByCode,
  updateProfile,
  uploadAvatar,
} from './db.js';
import { parseActivityFile } from './parse.js';

const $ = (sel) => document.querySelector(sel);

// ---- State Management ------------------------------------------------------
let me = null;                  // current logged-in user profile
let runs = [];                  // runs cache
let range = 'week';             // week | month | all
let onlyMine = false;
let unsubscribe = null;
let activeGroupId = null;       // null (friends/default) or group UUID
let activeTab = 'runs';         // runs | friends | groups
let activeManageGroupId = null; // currently selected group ID for members view
let pendingAction = null;       // friend link or group invite action
let pendingSharedFile = null;   // watch activity files from Android share sheet
let sharedHandled = false;

// ---------------------------------------------------------------------------
//  Startup
// ---------------------------------------------------------------------------
init();

function init() {
  registerServiceWorker();
  
  // Initialize Draggable Theme Switch
  initThemeSwitch();

  // Consume any watch activity shared from Android PWA targets
  consumeSharedFile().then((f) => {
    pendingSharedFile = f;
    maybeImportShared();
  });

  // If Supabase isn't configured, halt and show setup instructions
  if (!isConfigured) {
    showSetupNotice();
    return;
  }

  // 1. Check URL query parameters for invites first
  checkUrlParams();

  // 2. Auth state change listener
  onAuthChange(async (event, session) => {
    if (session) {
      try {
        me = await fetchProfile(session.user.id);
      } catch (err) {
        console.warn('Profile not found, attempting auto-creation:', err.message);
        try {
          const userMeta = session.user.user_metadata || {};
          const fallback = {
            id: session.user.id,
            display_name: userMeta.full_name || userMeta.name || 'Runner',
            avatar_url: userMeta.avatar_url || userMeta.picture || '',
            email: session.user.email
          };
          const { data, error } = await supabase.from('profiles').insert(fallback).select().single();
          if (error) throw error;
          me = data;
        } catch (insertErr) {
          console.error('Failed to create fallback profile:', insertErr.message);
          alert('Could not set up user profile: ' + insertErr.message);
          return;
        }
      }
      enterApp();
    } else {
      exitApp();
    }
  });

  // 3. Bind standard UI event listeners
  $('#btn-login-google').addEventListener('click', loginWithGoogle);
  $('#btn-logout').addEventListener('click', onLogoutClick);
  $('#run-form').addEventListener('submit', onAddRun);
  $('#f-file').addEventListener('change', onFilePicked);
  $('#f-date').value = todayISO();

  // Floating Action Button (FAB) triggers for logging runs
  $('#btn-open-log').addEventListener('click', () => {
    $('#run-log-modal').hidden = false;
    $('#run-msg').textContent = '';
  });
  $('#btn-close-log').addEventListener('click', () => {
    $('#run-log-modal').hidden = true;
  });

  // Tabs navigation
  document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Leaderboard filters
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

  // Group filter select
  $('#feed-filter').addEventListener('change', (e) => {
    const val = e.target.value;
    activeGroupId = val === 'friends' ? null : val;
    loadRuns();
  });

  // Friend actions
  $('#friend-add-form').addEventListener('submit', onFriendAddSubmit);
  $('#btn-copy-friend-link').addEventListener('click', copyFriendLink);

  // Group actions
  $('#group-create-form').addEventListener('submit', onGroupCreateSubmit);
  $('#group-join-form').addEventListener('submit', onGroupJoinSubmit);
  $('#btn-get-group-invite').addEventListener('click', onGenerateGroupInviteClick);
  $('#btn-copy-group-invite').addEventListener('click', copyGroupInviteLink);

  // Invite modal actions
  $('#btn-invite-accept').addEventListener('click', acceptPendingAction);
  $('#btn-invite-decline').addEventListener('click', closeInviteModal);

  // Profile navigation triggers
  $('.user-profile').addEventListener('click', () => switchTab('profile'));

  // Profile page actions
  $('.avatar-edit-container').addEventListener('click', () => $('#f-avatar-file').click());
  $('#f-avatar-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      $('#profile-edit-avatar').src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
  $('#profile-form').addEventListener('submit', onProfileSubmit);
}

// ---------------------------------------------------------------------------
//  Draggable Theme Switch Controller
// ---------------------------------------------------------------------------
function initThemeSwitch() {
  const seg = $('#theme-switch');
  if (!seg) return;
  const buttons = seg.querySelectorAll('.theme-seg-btn');
  const handle = seg.querySelector('.theme-seg-handle');
  if (buttons.length !== 2 || !handle) return;

  let theme = localStorage.getItem('theme') || 'light';

  function applyTheme(choice) {
    theme = choice === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    highlightTheme(theme);
    syncHandle();
  }

  function highlightTheme(choice) {
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeChoice === choice);
    });
  }

  function syncHandle() {
    const activeIndex = buttons[0].classList.contains('active') ? 0 : 1;
    const handleWidth = seg.offsetWidth / 2 - 2;
    seg.style.setProperty('--handle-offset', `${activeIndex * handleWidth}px`);
  }

  // Click handler for buttons
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    applyTheme(btn.dataset.themeChoice);
  });

  // Draggable Logic
  let isDragging = false;
  let currentOffset = 0;
  let handleWidth = seg.offsetWidth / 2 - 2;

  function onStart(e) {
    e.preventDefault();
    isDragging = true;
    handleWidth = seg.offsetWidth / 2 - 2;
    seg.classList.add('dragging');

    const rect = seg.getBoundingClientRect();
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clickX = clientX - rect.left;

    currentOffset = clickX - (handleWidth / 2);
    currentOffset = Math.max(0, Math.min(handleWidth, currentOffset));
    seg.style.setProperty('--handle-offset', `${currentOffset}px`);

    document.addEventListener('mousemove', onMove, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  }

  function onMove(e) {
    if (!isDragging) return;
    e.preventDefault();

    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    if (clientX === undefined) return;

    const rect = seg.getBoundingClientRect();
    const dragX = clientX - rect.left;
    const rawOffset = dragX - (handleWidth / 2);

    // Apply drag resistance (elastic bounds)
    if (rawOffset < 0) {
      currentOffset = rawOffset * 0.35;
    } else if (rawOffset > handleWidth) {
      currentOffset = handleWidth + (rawOffset - handleWidth) * 0.35;
    } else {
      currentOffset = rawOffset;
    }

    const maxStretch = 0.22;
    const centerOffset = rawOffset - (handleWidth / 2);
    const dragPercent = Math.min(Math.abs(centerOffset) / (handleWidth / 2), 1);
    const scaleX = 1 + (dragPercent * maxStretch);

    const origin = centerOffset >= 0 ? "left center" : "right center";
    seg.style.setProperty('--handle-origin', origin);
    seg.style.setProperty('--handle-scale-x', scaleX);
    seg.style.setProperty('--handle-offset', `${currentOffset}px`);
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    seg.classList.remove('dragging');
    seg.style.setProperty('--handle-scale-x', '1');

    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchend', onEnd);

    const threshold = handleWidth / 2;
    const targetIndex = currentOffset > threshold ? 1 : 0;
    const currentActiveIndex = buttons[0].classList.contains('active') ? 0 : 1;

    if (targetIndex !== currentActiveIndex) {
      applyTheme(buttons[targetIndex].dataset.themeChoice);
    } else {
      seg.style.setProperty('--handle-offset', `${currentActiveIndex * handleWidth}px`);
    }
  }

  seg.addEventListener('mousedown', onStart);
  seg.addEventListener('touchstart', onStart, { passive: false });

  // Initialize state
  applyTheme(theme);

  // Watch for window resize to resync handle width/offset
  window.addEventListener('resize', syncHandle);

  setTimeout(() => {
    seg.classList.add('seg-ready');
  }, 100);
}

// ---------------------------------------------------------------------------
//  URL Query Parameters (Friend links and Group invites)
// ---------------------------------------------------------------------------
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const addFriend = params.get('add-friend');
  const invite = params.get('invite');

  if (addFriend) {
    pendingAction = { type: 'friend', id: addFriend };
  } else if (invite) {
    pendingAction = { type: 'group', code: invite };
  }

  // Clear query parameters from address bar to keep things tidy
  if (addFriend || invite) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function handlePendingAction() {
  if (!pendingAction) return;

  const modal = $('#invite-modal');
  const title = $('#invite-title');
  const desc = $('#invite-desc');
  const err = $('#invite-error');

  err.hidden = true;
  modal.hidden = false;

  try {
    if (pendingAction.type === 'friend') {
      title.textContent = 'Add Friend';
      desc.textContent = 'Loading friend profile...';
      const profile = await fetchProfile(pendingAction.id);
      
      if (profile.id === me.id) {
        throw new Error("You cannot add yourself as a friend!");
      }
      desc.textContent = `Would you like to send a friend request to "${profile.display_name}"?`;
    } else if (pendingAction.type === 'group') {
      title.textContent = 'Join Group';
      desc.textContent = 'Loading invitation details...';
      const invite = await fetchInvite(pendingAction.code);
      desc.textContent = `Would you like to join the group "${invite.groups.name}"?`;
    }
  } catch (e) {
    desc.textContent = 'Oops! Something went wrong.';
    err.textContent = e.message;
    err.hidden = false;
    $('#btn-invite-accept').disabled = true;
  }
}

async function acceptPendingAction() {
  const err = $('#invite-error');
  const btn = $('#btn-invite-accept');
  btn.disabled = true;
  err.hidden = true;

  try {
    if (pendingAction.type === 'friend') {
      const res = await sendFriendRequest(pendingAction.id);
      if (res.status === 'accepted') {
        alert('Friend request accepted! You are now friends.');
      } else {
        alert('Friend request sent!');
      }
      loadFriends();
    } else if (pendingAction.type === 'group') {
      const group = await joinGroupByCode(pendingAction.code);
      alert(`Successfully joined group "${group.name}"!`);
      loadGroups();
      loadRuns();
    }
    closeInviteModal();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function closeInviteModal() {
  $('#invite-modal').hidden = true;
  $('#btn-invite-accept').disabled = false;
  pendingAction = null;
}

// ---------------------------------------------------------------------------
//  Auth Flow Controls
// ---------------------------------------------------------------------------
async function enterApp() {
  $('#gate').style.display = 'none';
  $('#app').hidden = false;
  
  // Set up profile displays
  $('#who-name').textContent = me.display_name;
  if (me.avatar_url) {
    const avatar = $('#who-avatar');
    avatar.src = me.avatar_url;
    avatar.hidden = false;
  }

  // Display user's own shareable friend link
  const link = window.location.origin + window.location.pathname + '?add-friend=' + me.id;
  $('#my-friend-link').value = link;
  $('#my-uid').textContent = me.id;

  maybeImportShared();

  // Load all initial segments
  await Promise.all([
    loadRuns(),
    loadFriends(),
    loadGroups(),
  ]);

  // Handle URL requests if they exist
  if (pendingAction) {
    handlePendingAction();
  }

  // Subscribe to changes on runs
  unsubscribe = subscribeToRuns(
    async () => { await loadRuns(); },
    (status) => setLive(status === 'SUBSCRIBED'),
  );
}

function exitApp() {
  $('#app').hidden = true;
  $('#gate').style.display = '';
  $('#gate-error').hidden = true;
  me = null;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

async function onLogoutClick() {
  if (confirm('Are you sure you want to sign out?')) {
    await logout();
  }
}

// ---------------------------------------------------------------------------
//  Tab Switching Navigation
// ---------------------------------------------------------------------------
function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${tabId}`;
  });

  // Manage visibility of the Floating log button (only visible on Runs tab)
  $('#btn-open-log').hidden = tabId !== 'runs';

  if (tabId === 'friends') {
    loadFriends();
  } else if (tabId === 'groups') {
    loadGroups();
  } else if (tabId === 'runs') {
    loadRuns();
  } else if (tabId === 'profile') {
    loadProfileTab();
  }
}

async function loadProfileTab() {
  if (!me) return;
  $('#f-display-name').value = me.display_name || '';
  
  const editAvatar = $('#profile-edit-avatar');
  editAvatar.src = me.avatar_url || 'https://authjs.dev/img/providers/google.svg';

  try {
    const session = await supabase.auth.getSession();
    const user = session.data.session?.user;
    if (user) {
      $('#info-email').textContent = user.email || 'N/A';
      $('#info-uid').textContent = user.id || 'N/A';
      
      const createdDate = new Date(user.created_at);
      $('#info-joined').textContent = createdDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }) || 'N/A';
    }
  } catch (err) {
    console.error('Error fetching account details:', err);
  }
}

async function onProfileSubmit(e) {
  e.preventDefault();
  const msg = $('#profile-msg');
  const nameField = $('#f-display-name');
  const fileField = $('#f-avatar-file');
  const submitBtn = $('#profile-form button[type="submit"]');

  const displayName = nameField.value.trim();
  if (!displayName) {
    msg.textContent = 'Display name is required.';
    return;
  }

  submitBtn.disabled = true;
  msg.textContent = 'Saving changes...';
  msg.style.color = 'var(--muted)';

  try {
    let avatarUrl = me.avatar_url;

    const file = fileField.files && fileField.files[0];
    if (file) {
      msg.textContent = 'Uploading avatar image...';
      avatarUrl = await uploadAvatar(file, me.id);
    }

    msg.textContent = 'Updating profile details...';
    const updatedProfile = await updateProfile({
      display_name: displayName,
      avatar_url: avatarUrl
    });

    me = updatedProfile;
    
    // Update header displays
    $('#who-name').textContent = me.display_name;
    if (me.avatar_url) {
      const avatar = $('#who-avatar');
      avatar.src = me.avatar_url;
      avatar.hidden = false;
    }

    msg.textContent = 'Profile saved successfully!';
    msg.style.color = '#22c55e'; // Green
    fileField.value = ''; // Reset file input

    // Refresh leaderboards/runs lists in case the name changed
    loadRuns();

    setTimeout(() => { msg.textContent = ''; }, 3000);
  } catch (err) {
    console.error('Error saving profile:', err);
    msg.textContent = 'Failed to save: ' + err.message;
    msg.style.color = 'var(--danger)';
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
//  Data Load Operations
// ---------------------------------------------------------------------------
async function loadRuns() {
  try {
    runs = await fetchRuns(activeGroupId);
    setLive(true);
    renderAll();
  } catch (err) {
    setLive(false);
    $('#conn-note').textContent = 'Could not fetch runs: ' + err.message;
  }
}

async function loadFriends() {
  try {
    const list = await fetchFriends();
    const { incoming, outgoing } = await fetchPendingRequests();
    renderFriendsView(list, incoming, outgoing);
  } catch (err) {
    console.error('Error loading friends:', err);
  }
}

async function loadGroups() {
  try {
    const list = await fetchGroups();
    renderGroupsView(list);
  } catch (err) {
    console.error('Error loading groups:', err);
  }
}

function renderAll() {
  renderSummary();
  renderLeaderboard();
  renderRuns();
}

// ---------------------------------------------------------------------------
//  Summary Panel rendering
// ---------------------------------------------------------------------------
function renderSummary() {
  const totalKm = sum(runs.map((r) => Number(r.distance_km)));
  const runners = new Set(runs.map((r) => r.user_id)).size;
  const myKm = sum(runs.filter((r) => r.user_id === me.id).map((r) => Number(r.distance_km)));
  
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

// ---------------------------------------------------------------------------
//  Leaderboard Panel & Baht Challenge rendering
// ---------------------------------------------------------------------------
function renderLeaderboard() {
  const cutoff = rangeCutoff(range);
  const inRange = runs.filter((r) => (cutoff ? r.run_date >= cutoff : true));

  const totals = new Map();
  for (const r of inRange) {
    const name = r.profiles?.display_name || 'Anonymous';
    const avatar = r.profiles?.avatar_url || '';
    const cur = totals.get(r.user_id) || { name, avatar, km: 0, runs: 0 };
    cur.km += Number(r.distance_km);
    cur.runs += 1;
    totals.set(r.user_id, cur);
  }

  const ranked = [...totals.entries()]
    .map(([userId, t]) => ({ userId, ...t }))
    .sort((a, b) => b.km - a.km);

  const el = $('#leaderboard');
  if (ranked.length === 0) {
    el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
    // Also clear Baht challenge list if empty
    const bahtList = $('#baht-challenge-list');
    if (bahtList) bahtList.innerHTML = `<li class="empty">No runs logged yet.</li>`;
    return;
  }
  
  el.innerHTML = ranked
    .map((row, i) => `
      <li class="lb-row${row.userId === me.id ? ' is-me' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <div class="user-profile">
          ${row.avatar ? `<img class="avatar" style="width:24px; height:24px;" src="${row.avatar}">` : ''}
          <span class="lb-name">${escapeHtml(row.name)}</span>
        </div>
        <span class="lb-runs">${row.runs} run${row.runs === 1 ? '' : 's'}</span>
        <span class="lb-km">${fmtKm(row.km)}</span>
      </li>`)
    .join('');

  // Calculate Baht Challenge
  renderBahtChallenge(ranked);
}

function renderBahtChallenge(ranked) {
  const bahtList = $('#baht-challenge-list');
  if (!bahtList) return;

  if (ranked.length <= 1) {
    bahtList.innerHTML = `<li class="empty">Need at least 2 runners to calculate pool.</li>`;
    return;
  }

  // 1. Calculate raw diff for each runner comparing to average of others
  const runnersCalculated = ranked.map((row) => {
    const otherRunners = ranked.filter((r) => r.userId !== row.userId);
    const otherSum = sum(otherRunners.map(r => r.km));
    const otherAvg = otherSum / otherRunners.length;
    const diff = row.km - otherAvg;
    return {
      ...row,
      diff,
      loss: diff < 0 ? -diff * 10 : 0
    };
  });

  const totalLossPool = sum(runnersCalculated.map(r => r.loss));
  const winnerCount = runnersCalculated.filter(r => r.diff > 0).length;

  // 2. Distribute total loss to winners
  const challengeRows = runnersCalculated.map((row) => {
    let amount = 0;
    let type = 'neutral'; // gain | lose | neutral

    if (row.diff < 0) {
      amount = row.loss;
      type = 'lose';
    } else if (row.diff > 0 && winnerCount > 0) {
      amount = totalLossPool / winnerCount;
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

      const isMe = row.userId === me.id;

      return `
        <li class="lb-row${isMe ? ' is-me' : ''}" style="grid-template-columns: auto 1fr auto;">
          <div class="user-profile">
            ${row.avatar ? `<img class="avatar" style="width:20px; height:20px;" src="${row.avatar}">` : ''}
            <span class="lb-name" style="font-size:0.9rem;">${escapeHtml(row.name)}</span>
          </div>
          <span></span>
          <span class="baht-badge ${badgeClass}">
            ${isMe ? 'You ' : ''}${text}
          </span>
        </li>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
//  Recent Runs List rendering
// ---------------------------------------------------------------------------
function renderRuns() {
  const list = onlyMine ? runs.filter((r) => r.user_id === me.id) : runs;
  const el = $('#run-list');
  
  if (list.length === 0) {
    el.innerHTML = `<li class="empty">No runs logged yet.</li>`;
    return;
  }

  el.innerHTML = list
    .map((r) => {
      const pace = paceLabel(r.distance_km, r.duration_min);
      const isMine = r.user_id === me.id;
      const runnerName = r.profiles?.display_name || 'Anonymous';
      const avatar = r.profiles?.avatar_url || '';
      
      return `
        <li class="run-item">
          <div class="run-main">
            <span class="run-km">${fmtKm(r.distance_km)}</span>
            <div class="user-profile" style="display:inline-flex;">
              ${avatar ? `<img class="avatar" style="width:18px; height:18px; border:1px solid var(--brand)" src="${avatar}">` : ''}
              <span class="run-runner">${escapeHtml(runnerName)}</span>
            </div>
            ${pace ? `<span class="run-pace">${pace}</span>` : ''}
          </div>
          <div class="run-meta">
            <span>${fmtDate(r.run_date)}</span>
            ${r.duration_min ? `<span>${fmtDuration(r.duration_min)}</span>` : ''}
            ${r.notes ? `<span class="run-notes">${escapeHtml(r.notes)}</span>` : ''}
          </div>
          ${isMine ? `<button class="run-del" data-id="${r.id}" title="Delete this run" aria-label="Delete run">✕</button>` : ''}
        </li>`;
    })
    .join('');

  el.querySelectorAll('.run-del').forEach((btn) => {
    btn.addEventListener('click', () => onDeleteRun(btn.dataset.id));
  });
}

// ---------------------------------------------------------------------------
//  Friends View rendering and handlers
// ---------------------------------------------------------------------------
function renderFriendsView(friends, incoming, outgoing) {
  // Friends List
  const flist = $('#friends-list');
  if (friends.length === 0) {
    flist.innerHTML = '<li class="empty">You have no friends added yet. Share your invite link above!</li>';
  } else {
    flist.innerHTML = friends
      .map((f) => `
        <li class="run-item">
          <div class="run-main" style="justify-content:space-between; width:100%; align-items:center;">
            <div class="user-profile">
              ${f.user.avatar_url ? `<img class="avatar" src="${f.user.avatar_url}">` : ''}
              <strong>${escapeHtml(f.user.display_name)}</strong>
            </div>
            <button class="btn btn-ghost btn-sm remove-friend-btn" data-id="${f.friendshipId}">Remove</button>
          </div>
        </li>`)
      .join('');
      
    flist.querySelectorAll('.remove-friend-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRemoveFriendshipClick(btn.dataset.id, 'Remove friend?'));
    });
  }

  // Incoming requests
  const incList = $('#incoming-requests-list');
  if (incoming.length === 0) {
    incList.innerHTML = '<li class="empty">No incoming requests.</li>';
  } else {
    incList.innerHTML = incoming
      .map((req) => `
        <li class="run-item">
          <div class="user-profile">
            ${req.sender.avatar_url ? `<img class="avatar" src="${req.sender.avatar_url}">` : ''}
            <span><strong>${escapeHtml(req.sender.display_name)}</strong> wants to be friends</span>
          </div>
          <div class="run-item-action">
            <button class="btn btn-primary btn-sm accept-req-btn" data-id="${req.friendshipId}">Accept</button>
            <button class="btn btn-ghost btn-sm decline-req-btn" data-id="${req.friendshipId}">Decline</button>
          </div>
        </li>`)
      .join('');
      
    incList.querySelectorAll('.accept-req-btn').forEach((btn) => {
      btn.addEventListener('click', () => onAcceptFriendRequestClick(btn.dataset.id));
    });
    incList.querySelectorAll('.decline-req-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRemoveFriendshipClick(btn.dataset.id, 'Decline request?'));
    });
  }

  // Outgoing requests
  const outList = $('#outgoing-requests-list');
  if (outgoing.length === 0) {
    outList.innerHTML = '<li class="empty">No outgoing requests.</li>';
  } else {
    outList.innerHTML = outgoing
      .map((req) => `
        <li class="run-item">
          <div class="user-profile">
            ${req.receiver.avatar_url ? `<img class="avatar" src="${req.receiver.avatar_url}">` : ''}
            <span>Pending response from <strong>${escapeHtml(req.receiver.display_name)}</strong></span>
          </div>
          <div class="run-item-action">
            <button class="btn btn-ghost btn-sm cancel-req-btn" data-id="${req.friendshipId}">Cancel</button>
          </div>
        </li>`)
      .join('');
      
    outList.querySelectorAll('.cancel-req-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRemoveFriendshipClick(btn.dataset.id, 'Cancel friend request?'));
    });
  }
}

async function onFriendAddSubmit(e) {
  e.preventDefault();
  const field = $('#f-friend-id');
  const msg = $('#friend-add-msg');
  const fid = field.value.trim();

  if (!fid) return;
  if (fid === me.id) {
    msg.textContent = 'You cannot add yourself!';
    return;
  }

  msg.textContent = 'Sending request...';
  try {
    const res = await sendFriendRequest(fid);
    if (res.status === 'accepted') {
      msg.textContent = 'You are now friends!';
    } else {
      msg.textContent = 'Friend request sent!';
    }
    field.value = '';
    loadFriends();
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
  }
}

async function onAcceptFriendRequestClick(id) {
  try {
    await acceptFriendRequest(id);
    loadFriends();
  } catch (e) {
    alert('Error accepting friend request: ' + e.message);
  }
}

async function onRemoveFriendshipClick(id, confirmMsg) {
  if (!confirm(confirmMsg)) return;
  try {
    await removeFriendship(id);
    loadFriends();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function copyFriendLink() {
  const linkEl = $('#my-friend-link');
  linkEl.select();
  linkEl.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(linkEl.value);
  
  const btn = $('#btn-copy-friend-link');
  const origText = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = origText; }, 2000);
}

// ---------------------------------------------------------------------------
//  Groups View rendering and handlers
// ---------------------------------------------------------------------------
function renderGroupsView(list) {
  const el = $('#groups-list');
  const filter = $('#feed-filter');

  const selectedFilter = filter.value;

  filter.innerHTML = `<option value="friends">All Friends & Me</option>`;
  list.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `Group: ${g.name}`;
    filter.appendChild(opt);
  });
  filter.value = selectedFilter;

  if (list.length === 0) {
    el.innerHTML = '<li class="empty">You are not in any groups yet. Create or join one above!</li>';
    return;
  }

  el.innerHTML = list
    .map((g) => `
      <li class="run-item">
        <div class="run-main" style="justify-content:space-between; width:100%; align-items:center;">
          <div>
            <strong>${escapeHtml(g.name)}</strong>
            <div style="font-size: 0.74rem; color: var(--muted); margin-top:2px;">Role: ${g.role}</div>
          </div>
          <button class="btn btn-primary btn-sm manage-group-btn" data-id="${g.id}">Manage</button>
        </div>
      </li>`)
    .join('');

  el.querySelectorAll('.manage-group-btn').forEach((btn) => {
    btn.addEventListener('click', () => onManageGroupClick(btn.dataset.id));
  });

  if (activeManageGroupId && list.some(g => g.id === activeManageGroupId)) {
    onManageGroupClick(activeManageGroupId);
  } else {
    $('#group-manage-card').hidden = true;
    activeManageGroupId = null;
  }
}

async function onGroupCreateSubmit(e) {
  e.preventDefault();
  const field = $('#f-group-name');
  const msg = $('#group-create-msg');
  const name = field.value.trim();

  if (!name) return;

  msg.textContent = 'Creating...';
  try {
    const group = await createGroup(name);
    msg.textContent = `Group "${group.name}" created!`;
    field.value = '';
    loadGroups();
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
  }
}

async function onGroupJoinSubmit(e) {
  e.preventDefault();
  const field = $('#f-invite-code');
  const msg = $('#group-join-msg');
  const code = field.value.trim().toUpperCase();

  if (!code) return;

  msg.textContent = 'Joining...';
  try {
    const group = await joinGroupByCode(code);
    msg.textContent = `Joined "${group.name}"!`;
    field.value = '';
    loadGroups();
    loadRuns();
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } catch (err) {
    msg.textContent = 'Error: ' + err.message;
  }
}

async function onManageGroupClick(groupId) {
  activeManageGroupId = groupId;
  
  const card = $('#group-manage-card');
  const nameEl = $('#manage-group-name');
  const membersList = $('#group-members-list');

  $('#group-invite-display').hidden = true;

  try {
    const members = await fetchGroupMembers(groupId);
    const opt = document.querySelector(`#feed-filter option[value="${groupId}"]`);
    const groupName = opt ? opt.textContent.replace('Group: ', '') : 'Group Details';

    nameEl.textContent = groupName;
    card.hidden = false;

    membersList.innerHTML = members
      .map((m) => `
        <li class="run-item">
          <div class="run-main" style="justify-content:space-between; width:100%; align-items:center;">
            <div class="user-profile">
              ${m.avatar_url ? `<img class="avatar" src="${m.avatar_url}">` : ''}
              <strong>${escapeHtml(m.display_name)}</strong>
            </div>
            <span style="font-size:0.75rem; color:var(--muted); font-weight:600; text-transform:uppercase;">${m.role}</span>
          </div>
        </li>`)
      .join('');
  } catch (e) {
    membersList.innerHTML = `<li class="empty">Error: ${e.message}</li>`;
  }
}

async function onGenerateGroupInviteClick() {
  if (!activeManageGroupId) return;
  const linkInput = $('#group-invite-link');
  const box = $('#group-invite-display');
  
  try {
    const code = await getOrCreateGroupInvite(activeManageGroupId);
    const link = window.location.origin + window.location.pathname + '?invite=' + code;
    linkInput.value = link;
    box.hidden = false;
  } catch (e) {
    alert('Error generating invite link: ' + e.message);
  }
}

function copyGroupInviteLink() {
  const linkEl = $('#group-invite-link');
  linkEl.select();
  navigator.clipboard.writeText(linkEl.value);
  
  const btn = $('#btn-copy-group-invite');
  const origText = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = origText; }, 2000);
}

// ---------------------------------------------------------------------------
//  Mutations (Runs logging)
// ---------------------------------------------------------------------------
async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await importFile(file);
  e.target.value = '';
}

async function importFile(file) {
  const msg = $('#import-msg');
  msg.textContent = `Reading ${file.name}…`;
  try {
    const { distanceKm, durationMin, dateISO } = await parseActivityFile(file);
    if (distanceKm > 0) $('#f-distance').value = distanceKm;
    if (durationMin != null) $('#f-duration').value = durationMin;
    if (dateISO) $('#f-date').value = dateISO;

    const bits = [];
    if (distanceKm > 0) bits.push(`${distanceKm} km`);
    if (durationMin != null) bits.push(`${durationMin} min`);
    msg.textContent = bits.length
      ? `Imported ${bits.join(' · ')} · review and press Add run.`
      : 'File read, but no distance found. Enter it manually.';
  } catch (err) {
    msg.textContent = err.message;
  }
}

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
    await loadRuns();
    e.target.reset();
    $('#f-date').value = todayISO();
    
    // Close the floating modal log dialog
    $('#run-log-modal').hidden = true;
    alert('Added!');
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
function showSetupNotice() {
  $('#gate').innerHTML = `
    <div class="gate-card">
      <div class="gate-emoji">🛠️</div>
      <h1>Almost there</h1>
      <p class="gate-sub">Add your Supabase URL and anon key in <code>config.js</code>,
      then run the SQL in <code>schema.sql</code>. See <code>README.md</code> for the setup.</p>
    </div>`;
}

function setLive(on) {
  const dot = $('#live-dot');
  if (!dot) return;
  dot.classList.toggle('on', on);
  dot.classList.toggle('off', !on);
  $('#conn-note').textContent = on ? 'Connected · updates live' : 'Offline · retrying…';
}

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function rangeCutoff(r) {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const local = new Date(now.getTime() - off * 60000);
  if (r === 'all') return null;
  if (r === 'month') {
    return local.toISOString().slice(0, 7) + '-01';
  }
  const day = (local.getUTCDay() + 6) % 7; 
  const monday = new Date(local.getTime() - day * 86400000);
  return monday.toISOString().slice(0, 10);
}

function paceLabel(km, min) {
  const d = Number(km);
  const m = Number(min);
  if (!(d > 0) || !(m > 0)) return '';
  const pace = m / d;
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

// ---------------------------------------------------------------------------
//  PWA · Web Share Target
// ---------------------------------------------------------------------------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

async function consumeSharedFile() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share-target')) return null;
  history.replaceState({}, '', location.pathname);
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open('runclub-shared');
    const res = await cache.match('shared-activity');
    if (!res) return null;
    const name = res.headers.get('x-filename') || 'activity';
    const blob = await res.blob();
    await cache.delete('shared-activity');
    return new File([blob], name);
  } catch (_) {
    return null;
  }
}

function maybeImportShared() {
  if (sharedHandled || !pendingSharedFile) return;
  if ($('#app').hidden) return; 
  sharedHandled = true;
  const file = pendingSharedFile;
  pendingSharedFile = null;
  importFile(file);
  // Show the log modal since we have a shared file to import!
  $('#run-log-modal').hidden = false;
}
