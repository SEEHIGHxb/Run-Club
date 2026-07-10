// ============================================================================
//  Runaway — App logic
//  Handles login/logout, navigation tabs, theme toggling, the friend system,
//  floating log modals, the avatar cropper, and zero-sum Baht calculations.
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
  subscribeToFriends,
  fetchProfile,
  fetchFriends,
  fetchPendingRequests,
  sendFriendRequest,
  getFriendByCode,
  acceptFriendRequest,
  removeFriendship,
  updateProfile,
  uploadAvatar,
  fetchClubs,
  fetchClubDetails,
  fetchClubMembers,
  fetchClubRuns,
  createClub,
  joinClub,
  leaveClub,
  deleteClub,
  updateClubSettings,
  subscribeToClubs,
} from './db.js?v=3';
import { parseActivityFile } from './parse.js';

const $ = (sel) => document.querySelector(sel);

// ---- State Management ------------------------------------------------------
let me = null;                  // current logged-in user profile
let runs = [];                  // runs cache
let poolRoster = [];            // everyone eligible for the Run-or-Lose pool
                                // (friends + me), so non-runners are counted at
                                // 0 km.
let range = 'all';             // week | month | all
let onlyMine = false;
let unsubscribe = null;         // runs realtime teardown
let unsubscribeFriends = null;  // friends realtime teardown
let activeTab = 'runs';         // runs | friends | profile
let pendingAction = null;       // friend link action from a URL
let pendingSharedFile = null;   // watch activity files from Android share sheet
let sharedHandled = false;
let authResolved = false;       // has Supabase emitted its first auth event yet?
let pendingAvatarBlob = null;   // cropped avatar awaiting profile save

// Clubs State
let clubs = [];                 // list of user's clubs
let activeClubId = null;        // active club ID
let activeClub = null;          // active club details
let activeClubMembers = [];     // members of the active club
let activeClubRuns = [];        // runs of active club members
let clubRange = 'all';          // week | month | all
let unsubscribeClubs = null;    // clubs realtime teardown
let pendingClubAction = null;   // club invite link action from a URL (?c=INVITE_CODE)
let lbType = 'all';             // main page leaderboard type (all | club)
let lastActiveClubId = null;    // last viewed active club ID

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

  // 1. Check URL query parameters for links first
  checkUrlParams();

  // 2. Auth state change listener
  onAuthChange(async (event, session) => {
    authResolved = true;
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

  // Safety net: if Supabase never emits an auth event (network stalls, etc.),
  // stop showing the boot loader after a few seconds and fall back to the gate
  // instead of leaving the user staring at a spinner forever.
  setTimeout(() => {
    if (!authResolved) {
      hideBoot();
      exitApp();
    }
  }, 6000);

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
  document.querySelectorAll('#panel-runs .seg[aria-label="Leaderboard range"] .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.range;
      document.querySelectorAll('#panel-runs .seg[aria-label="Leaderboard range"] .seg-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderLeaderboard();
    });
  });

  // Friend actions
  $('#friend-add-form').addEventListener('submit', onFriendAddSubmit);
  $('#btn-copy-friend-link').addEventListener('click', copyFriendLink);

  // Invite modal actions (friend links)
  $('#btn-invite-accept').addEventListener('click', acceptPendingAction);
  $('#btn-invite-decline').addEventListener('click', closeInviteModal);

  // Profile navigation triggers
  $('.user-profile').addEventListener('click', () => switchTab('profile'));

  // Profile page actions — picking a file opens the cropper rather than
  // uploading the raw image directly.
  $('.avatar-edit-container').addEventListener('click', () => $('#f-avatar-file').click());
  $('#f-avatar-file').addEventListener('change', onAvatarFilePicked);
  $('#profile-form').addEventListener('submit', onProfileSubmit);

  // Avatar cropper controls
  initAvatarCropper();

  // Clubs Event Listeners
  $('#club-create-form').addEventListener('submit', onClubCreateSubmit);
  $('#club-join-form').addEventListener('submit', onClubJoinSubmit);
  $('#club-selector').addEventListener('change', (e) => {
    activeClubId = e.target.value || null;
    loadClubs();
  });
  $('#btn-copy-club-link').addEventListener('click', copyClubLink);
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
//  URL Query Parameters (Friend links)
// ---------------------------------------------------------------------------
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const friendCode = params.get('f');          // new short link: ?f=AB12CD
  const addFriend = params.get('add-friend');   // legacy link: ?add-friend=<uuid>
  const clubCode = params.get('c');            // club invite link: ?c=XY12AB

  if (friendCode) {
    pendingAction = { type: 'friend', code: friendCode };
  } else if (addFriend) {
    pendingAction = { type: 'friend', id: addFriend };
  }

  if (clubCode) {
    pendingClubAction = { type: 'club', code: clubCode };
  }

  // Clear query parameters from address bar to keep things tidy
  if (friendCode || addFriend || clubCode) {
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
    title.textContent = 'Add Friend';
    desc.textContent = 'Loading friend profile...';
    // New links carry a short code; legacy links carry the raw UUID.
    const profile = pendingAction.code
      ? await getFriendByCode(pendingAction.code)
      : await fetchProfile(pendingAction.id);

    if (!profile) {
      throw new Error('That friend link is invalid or has expired.');
    }
    if (profile.id === me.id) {
      throw new Error("You cannot add yourself as a friend!");
    }
    // Normalize to the UUID so acceptPendingAction() can reuse the existing
    // UUID-validated sendFriendRequest() path.
    pendingAction.id = profile.id;
    desc.textContent = `Would you like to send a friend request to "${profile.display_name}"?`;
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
    const res = await sendFriendRequest(pendingAction.id);
    if (res.status === 'accepted') {
      alert('Friend request accepted! You are now friends.');
    } else {
      alert('Friend request sent!');
    }
    loadFriends();
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
function resetLeaderboardFilters() {
  lbType = 'all';
  range = 'all';

  const btnAll = $('#btn-lb-type-all');
  const btnClub = $('#btn-lb-type-club');
  if (btnAll) btnAll.classList.add('active');
  if (btnClub) btnClub.classList.remove('active');

  document.querySelectorAll('#panel-runs .seg[aria-label="Leaderboard range"] .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === 'all');
  });
}

async function enterApp() {
  resetLeaderboardFilters();
  hideBoot();
  $('#gate').style.display = 'none';
  $('#app').hidden = false;
  // Set up profile displays
  $('#who-name').textContent = formatDisplayName(me.display_name);
  if (me.avatar_url) {
    const avatar = $('#who-avatar');
    avatar.src = me.avatar_url;
    avatar.hidden = false;
  }

  // Display user's own shareable friend link. Prefer the short friend code
  // (?f=AB12CD); fall back to the full UUID only if the code is somehow missing
  // (e.g. a profile created before the friend_code column existed).
  const shareId = me.friend_code || me.id;
  const link = window.location.origin + window.location.pathname + '?f=' + shareId;
  $('#my-friend-link').value = link;
  $('#my-uid').textContent = me.friend_code || me.id;

  maybeImportShared();

  // Load all initial segments
  await Promise.all([
    loadRuns(),
    loadFriends(),
    loadClubs(),
  ]);

  // Handle URL requests if they exist
  if (pendingAction) {
    handlePendingAction();
  }
  if (pendingClubAction) {
    handlePendingClubAction();
  }

  // Subscribe to realtime changes. Runs drive the live feed; friend changes
  // refresh the requests list, the tab badge, and the pool (a new friend's runs
  // become visible).
  unsubscribe = subscribeToRuns(
    async () => { await loadRuns(); if (activeClubId) await loadClubs(); },
    (status) => setLive(status === 'SUBSCRIBED'),
  );
  unsubscribeFriends = subscribeToFriends(async () => {
    await Promise.all([loadFriends(), loadRuns()]);
  });
  unsubscribeClubs = subscribeToClubs(async () => {
    await loadClubs();
  });
}

function exitApp() {
  hideBoot();
  $('#app').hidden = true;
  $('#gate').style.display = '';
  $('#gate-error').hidden = true;
  me = null;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeFriends) {
    unsubscribeFriends();
    unsubscribeFriends = null;
  }
  if (unsubscribeClubs) {
    unsubscribeClubs();
    unsubscribeClubs = null;
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
  } else if (tabId === 'runs') {
    loadRuns();
  } else if (tabId === 'clubs') {
    loadClubs();
  } else if (tabId === 'profile') {
    loadProfileTab();
  }
}

async function loadProfileTab() {
  if (!me) return;
  // A crop picked but not saved shouldn't linger into a fresh visit.
  pendingAvatarBlob = null;
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

    if (pendingAvatarBlob) {
      msg.textContent = 'Uploading avatar image...';
      avatarUrl = await uploadAvatar(pendingAvatarBlob, me.id);
    }

    msg.textContent = 'Updating profile details...';
    const updatedProfile = await updateProfile({
      display_name: displayName,
      avatar_url: avatarUrl
    });

    me = updatedProfile;
    pendingAvatarBlob = null;

    // Update header displays
    $('#who-name').textContent = formatDisplayName(me.display_name);
    if (me.avatar_url) {
      const avatar = $('#who-avatar');
      avatar.src = me.avatar_url;
      avatar.hidden = false;
    }

    msg.textContent = 'Profile saved successfully!';
    msg.style.color = '#22c55e'; // Green

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
//  Avatar Cropper (pan + zoom → small square WebP)
//  Lets the user reposition/zoom an oversized photo to fit the round avatar,
//  and exports a capped-size WebP so Supabase storage stays lean.
// ---------------------------------------------------------------------------
const CROP_VIEW = 280;                    // on-screen crop viewport edge (px)
const CROP_OUTPUT = 400;                   // exported image edge (px)
const CROP_MAX_INPUT_BYTES = 15 * 1024 * 1024; // reject absurd source files early
const crop = {
  img: null, baseCover: 1, zoom: 1,
  offsetX: 0, offsetY: 0,
  dragging: false, lastX: 0, lastY: 0,
};

function initAvatarCropper() {
  const canvas = $('#crop-canvas');
  if (!canvas) return;
  $('#crop-zoom').addEventListener('input', onCropZoom);
  canvas.addEventListener('pointerdown', onCropDown);
  canvas.addEventListener('pointermove', onCropMove);
  canvas.addEventListener('pointerup', onCropUp);
  canvas.addEventListener('pointercancel', onCropUp);
  $('#btn-crop-save').addEventListener('click', saveCrop);
  $('#btn-crop-cancel').addEventListener('click', () => {
    $('#avatar-crop-modal').hidden = true;
  });
}

function onAvatarFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-picking the same file later
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('Please choose an image file.');
    return;
  }
  if (file.size > CROP_MAX_INPUT_BYTES) {
    alert('That image is too large. Please pick one under 15 MB.');
    return;
  }
  openCropper(file);
}

function openCropper(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    crop.img = img;
    // "Cover" scale so the image fully fills the square at zoom = 1.
    crop.baseCover = Math.max(CROP_VIEW / img.width, CROP_VIEW / img.height);
    crop.zoom = 1;
    $('#crop-zoom').value = '1';
    centerCrop();
    drawCrop();
    $('#avatar-crop-modal').hidden = false;
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert('Could not read that image. Try a different file.');
  };
  img.src = url;
}

function cropScale() { return crop.baseCover * crop.zoom; }
function cropDrawW() { return crop.img.width * cropScale(); }
function cropDrawH() { return crop.img.height * cropScale(); }

// Keep the image covering the viewport on all sides (no empty gaps).
function clampCrop() {
  const minX = CROP_VIEW - cropDrawW();
  const minY = CROP_VIEW - cropDrawH();
  crop.offsetX = Math.min(0, Math.max(minX, crop.offsetX));
  crop.offsetY = Math.min(0, Math.max(minY, crop.offsetY));
}

function centerCrop() {
  crop.offsetX = (CROP_VIEW - cropDrawW()) / 2;
  crop.offsetY = (CROP_VIEW - cropDrawH()) / 2;
}

function drawCrop() {
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CROP_VIEW, CROP_VIEW);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.img, crop.offsetX, crop.offsetY, cropDrawW(), cropDrawH());
}

function onCropZoom(e) {
  if (!crop.img) return;
  const prevScale = cropScale();
  const center = CROP_VIEW / 2;
  // Image-space point currently under the viewport centre — keep it fixed.
  const imgX = (center - crop.offsetX) / prevScale;
  const imgY = (center - crop.offsetY) / prevScale;
  crop.zoom = Number(e.target.value);
  const newScale = cropScale();
  crop.offsetX = center - imgX * newScale;
  crop.offsetY = center - imgY * newScale;
  clampCrop();
  drawCrop();
}

function onCropDown(e) {
  if (!crop.img) return;
  crop.dragging = true;
  crop.lastX = e.clientX;
  crop.lastY = e.clientY;
  if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
}

function onCropMove(e) {
  if (!crop.dragging) return;
  crop.offsetX += e.clientX - crop.lastX;
  crop.offsetY += e.clientY - crop.lastY;
  crop.lastX = e.clientX;
  crop.lastY = e.clientY;
  clampCrop();
  drawCrop();
}

function onCropUp() {
  crop.dragging = false;
}

function saveCrop() {
  if (!crop.img) return;
  const factor = CROP_OUTPUT / CROP_VIEW;
  const out = document.createElement('canvas');
  out.width = CROP_OUTPUT;
  out.height = CROP_OUTPUT;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    crop.img,
    crop.offsetX * factor, crop.offsetY * factor,
    cropDrawW() * factor, cropDrawH() * factor,
  );
  out.toBlob((blob) => {
    if (!blob) { alert('Could not process that image. Try another.'); return; }
    pendingAvatarBlob = blob;
    $('#profile-edit-avatar').src = URL.createObjectURL(blob);
    $('#avatar-crop-modal').hidden = true;
  }, 'image/webp', 0.85);
}

// ---------------------------------------------------------------------------
//  Data Load Operations
// ---------------------------------------------------------------------------
async function loadRuns() {
  try {
    runs = await fetchRuns();
    poolRoster = await buildPoolRoster();
    setLive(true);
    renderAll();
  } catch (err) {
    setLive(false);
    const connNote = $('#conn-note');
    if (connNote) connNote.textContent = 'Could not fetch runs: ' + err.message;
  }
}
// The set of people who should be in the Run-or-Lose pool: me plus my accepted
// friends. Anyone here who hasn't logged a run counts as 0 km — that's the point
// of the challenge. Returns [{ userId, name, avatar }].
async function buildPoolRoster() {
  try {
    const friends = await fetchFriends();
    const roster = [{
      userId: me.id,
      name: formatDisplayName(me.display_name || 'Anonymous'),
      avatar: me.avatar_url || '',
    }];
    for (const f of friends) {
      if (f.user) {
        roster.push({
          userId: f.user.id,
          name: formatDisplayName(f.user.display_name || 'Anonymous'),
          avatar: f.user.avatar_url || '',
        });
      }
    }
    return roster;
  } catch (err) {
    console.error('Error building pool roster:', err);
    return [];
  }
}

async function loadFriends() {
  try {
    const list = await fetchFriends();
    const { incoming, outgoing } = await fetchPendingRequests();
    renderFriendsView(list, incoming, outgoing);
    updateFriendBadge(incoming.length);
  } catch (err) {
    console.error('Error loading friends:', err);
  }
}

function renderAll() {
  renderLeaderboard();
  renderRuns();
}

// ---------------------------------------------------------------------------
//  Leaderboard Panel & Baht Challenge rendering
// ---------------------------------------------------------------------------
function renderLeaderboard() {
  const label = $('#lb-type-label');
  const mainBahtSection = $('#main-baht-section');
  const el = $('#leaderboard');

  if (lbType === 'all') {
    if (label) label.textContent = 'All Friends';
    if (mainBahtSection) mainBahtSection.hidden = true;

    const cutoff = rangeCutoff(range);
    const inRange = runs.filter((r) => (cutoff ? r.run_date >= cutoff : true));

    const totals = new Map();
    for (const r of inRange) {
      const name = formatDisplayName(r.profiles?.display_name || 'Anonymous');
      const avatar = r.profiles?.avatar_url || '';
      const cur = totals.get(r.user_id) || { name, avatar, km: 0, runs: 0 };
      cur.km += Number(r.distance_km);
      cur.runs += 1;
      totals.set(r.user_id, cur);
    }

    const ranked = [...totals.entries()]
      .map(([userId, t]) => ({ userId, ...t }))
      .sort((a, b) => b.km - a.km);

    if (ranked.length === 0) {
      el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
      return;
    }

    el.innerHTML = ranked
      .map((row, i) => `
        <li class="lb-row${row.userId === me.id ? ' is-me' : ''}">
          <span class="lb-rank">${i + 1}</span>
          <div class="user-profile">
            ${avatarImg(row.avatar, ' style="width:24px; height:24px;"')}
            <span class="lb-name">${escapeHtml(row.name)}</span>
          </div>
          <span class="lb-runs">${row.runs} run${row.runs === 1 ? '' : 's'}</span>
          <span class="lb-km">${fmtKm(row.km)}</span>
        </li>`)
      .join('');
  } else {
    // lbType === 'club'
    if (!activeClub) {
      if (label) label.textContent = 'No active club';
      if (mainBahtSection) mainBahtSection.hidden = true;
      el.innerHTML = `<li class="empty">You are not in any club yet. <a href="#" id="link-switch-to-clubs" style="color:var(--brand); font-weight:600; text-decoration:underline;">Join or create a club</a> to view the club leaderboard.</li>`;
      
      setTimeout(() => {
        const link = $('#link-switch-to-clubs');
        if (link) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            switchTab('clubs');
          });
        }
      }, 0);
      return;
    }

    if (label) label.textContent = `Club: ${activeClub.name}`;

    const cutoff = rangeCutoff(range);
    const inRange = activeClubRuns.filter((r) => (cutoff ? r.run_date >= cutoff : true));

    const totals = new Map();
    // Initialize everyone in the club to 0 km
    for (const m of activeClubMembers) {
      totals.set(m.id, { name: formatDisplayName(m.display_name || 'Anonymous'), avatar: m.avatar_url || '', km: 0, runs: 0 });
    }

    for (const r of inRange) {
      if (totals.has(r.user_id)) {
        const cur = totals.get(r.user_id);
        cur.km += Number(r.distance_km);
        cur.runs += 1;
      }
    }

    const ranked = [...totals.entries()]
      .map(([userId, t]) => ({ userId, ...t }))
      .sort((a, b) => b.km - a.km);

    if (ranked.length === 0) {
      el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
      if (mainBahtSection) mainBahtSection.hidden = true;
      return;
    }

    el.innerHTML = ranked
      .map((row, i) => `
        <li class="lb-row${row.userId === me.id ? ' is-me' : ''}">
          <span class="lb-rank">${i + 1}</span>
          <div class="user-profile">
            ${avatarImg(row.avatar, ' style="width:24px; height:24px;"')}
            <span class="lb-name">${escapeHtml(row.name)}</span>
          </div>
          <span class="lb-runs">${row.runs} run${row.runs === 1 ? '' : 's'}</span>
          <span class="lb-km">${fmtKm(row.km)}</span>
        </li>`)
      .join('');

    // Handle Baht Challenge for club on the main page
    if (activeClub.pool_enabled && ranked.length > 1) {
      if (mainBahtSection) {
        mainBahtSection.hidden = false;
        renderClubBahtChallenge(ranked, '#main-baht-list');
      }
    } else {
      if (mainBahtSection) mainBahtSection.hidden = true;
    }
  }
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
      const runnerName = formatDisplayName(r.profiles?.display_name || 'Anonymous');
      const avatar = r.profiles?.avatar_url || '';

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
    flist.innerHTML = '<li class="empty">You have no friends added yet. Share your invite link below!</li>';
  } else {
    flist.innerHTML = friends
      .map((f) => `
        <li class="run-item">
          <div class="run-main" style="justify-content:space-between; width:100%; align-items:center;">
            <div class="user-profile">
              ${avatarImg(f.user.avatar_url)}
              <strong>${escapeHtml(formatDisplayName(f.user.display_name))}</strong>
            </div>
            <button class="btn btn-ghost btn-sm remove-friend-btn" data-id="${f.friendshipId}">Remove</button>
          </div>
        </li>`)
      .join('');

    flist.querySelectorAll('.remove-friend-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRemoveFriendshipClick(btn.dataset.id, 'Remove friend?'));
    });
  }

  // Requests: each section only appears when it has items, and the whole card
  // is hidden unless there's at least one request either way.
  const incBlock = $('#incoming-requests-block');
  const outBlock = $('#outgoing-requests-block');
  const card = $('#friend-requests-card');

  if (incoming.length > 0) {
    incBlock.hidden = false;
    const incList = $('#incoming-requests-list');
    incList.innerHTML = incoming
      .map((req) => `
        <li class="run-item">
            <div class="user-profile">
              ${avatarImg(req.sender.avatar_url)}
              <span><strong>${escapeHtml(formatDisplayName(req.sender.display_name))}</strong> wants to be friends</span>
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
  } else {
    incBlock.hidden = true;
  }

  if (outgoing.length > 0) {
    outBlock.hidden = false;
    const outList = $('#outgoing-requests-list');
    outList.innerHTML = outgoing
      .map((req) => `
        <li class="run-item">
            <div class="user-profile">
              ${avatarImg(req.receiver.avatar_url)}
              <span>Pending response from <strong>${escapeHtml(formatDisplayName(req.receiver.display_name))}</strong></span>
            </div>
          <div class="run-item-action">
            <button class="btn btn-ghost btn-sm cancel-req-btn" data-id="${req.friendshipId}">Cancel</button>
          </div>
        </li>`)
      .join('');

    outList.querySelectorAll('.cancel-req-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRemoveFriendshipClick(btn.dataset.id, 'Cancel friend request?'));
    });
  } else {
    outBlock.hidden = true;
  }

  card.hidden = incoming.length === 0 && outgoing.length === 0;
}

// Show/clear the incoming-request count badge on the Friends nav tab.
function updateFriendBadge(count) {
  const badge = $('#friends-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// A friend code is 6 characters (letters/digits); anything longer is treated as
// a raw UUID and validated downstream by sendFriendRequest().
const FRIEND_CODE_RE = /^[A-Za-z0-9]{6}$/;

async function onFriendAddSubmit(e) {
  e.preventDefault();
  const field = $('#f-friend-id');
  const msg = $('#friend-add-msg');
  const input = field.value.trim();

  if (!input) return;

  msg.textContent = 'Sending request...';
  try {
    // Accept either a short friend code or a full User ID.
    let fid = input;
    if (FRIEND_CODE_RE.test(input)) {
      const profile = await getFriendByCode(input);
      if (!profile) throw new Error('No runner found with that code.');
      fid = profile.id;
    }
    if (fid === me.id) {
      msg.textContent = 'You cannot add yourself!';
      return;
    }
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
  try {
    navigator.clipboard.writeText(linkEl.value);
  } catch (_) {
    // Older/non-secure contexts: the text is already selected for manual copy.
    document.execCommand && document.execCommand('copy');
  }

  const btn = $('#btn-copy-friend-link');
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
    let { distanceKm, durationMin, dateISO } = await parseActivityFile(file);
    let capped = false;
    if (distanceKm >= 100) {
      distanceKm = 99.99;
      capped = true;
    }
    if (distanceKm > 0) $('#f-distance').value = distanceKm;
    if (durationMin != null) $('#f-duration').value = durationMin;
    if (dateISO) $('#f-date').value = dateISO;

    const bits = [];
    if (distanceKm > 0) bits.push(`${distanceKm} km`);
    if (durationMin != null) bits.push(`${durationMin} min`);
    
    let info = bits.join(' · ');
    if (capped) info += ' (capped at 99.99 km)';
    msg.textContent = bits.length
      ? `Imported ${info} · review and press Add run.`
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

  if (!(distance > 0 && distance < 100)) { msg.textContent = 'Enter a distance between 0.01 and 99.99 km.'; return; }
  if (!date) { msg.textContent = 'Pick a date.'; return; }
  if (durationRaw && !(Number(durationRaw) > 0)) {
    msg.textContent = 'Duration must be greater than 0, or leave it blank.';
    return;
  }

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
  hideBoot();
  $('#gate').innerHTML = `
    <div class="gate-card">
      <div class="gate-emoji">🛠️</div>
      <h1>Almost there</h1>
      <p class="gate-sub">Add your Supabase URL and anon key in <code>config.js</code>,
      then run the SQL in <code>schema.sql</code>. See <code>README.md</code> for the setup.</p>
    </div>`;
}

function hideBoot() {
  const boot = $('#boot');
  if (boot) boot.hidden = true;
}

function setLive(on) {
  const dot = $('#live-dot');
  if (dot) {
    dot.classList.toggle('on', on);
    dot.classList.toggle('off', !on);
  }
  const note = $('#conn-note');
  if (note) note.textContent = on ? 'Connected · updates live' : 'Offline · retrying…';
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

function formatDisplayName(name) {
  if (!name) return 'Anonymous';
  const trimmed = name.trim();
  if (trimmed.length > 15) {
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex !== -1) {
      const firstName = trimmed.substring(0, spaceIndex);
      const surname = trimmed.substring(spaceIndex + 1).trim();
      if (surname.length > 0) {
        return `${firstName} ${surname[0].toUpperCase()}.`;
      }
    }
  }
  return trimmed;
}

// Sanitize a user-supplied avatar URL before it goes into an <img src> template.
// Only http(s) URLs pass; anything else (javascript:, attribute-breakout
// payloads, etc.) becomes empty so the <img> is simply omitted. Callers must
// still escapeHtml() the result to neutralise quotes in an otherwise valid URL.
function safeUrl(u) {
  if (!u) return '';
  try {
    const parsed = new URL(u, window.location.href);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch {
    return '';
  }
}

// Render an avatar <img> tag from an untrusted URL, or '' when there's none.
function avatarImg(url, attrs = '') {
  const safe = safeUrl(url);
  return safe ? `<img class="avatar"${attrs} src="${escapeHtml(safe)}">` : '';
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

// ---------------------------------------------------------------------------
//  Clubs Feature Operations
// ---------------------------------------------------------------------------
async function loadClubs() {
  if (!me) return;
  try {
    clubs = await fetchClubs();
    if (clubs.length === 0) {
      activeClubId = null;
      activeClub = null;
      activeClubMembers = [];
      activeClubRuns = [];
      renderClubsView();
      renderLeaderboard();
      return;
    }

    if (activeClubId === 'directory') {
      activeClub = null;
      activeClubMembers = [];
      activeClubRuns = [];
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
    activeClub = await fetchClubDetails(activeClubId);
    activeClubMembers = await fetchClubMembers(activeClubId);
    activeClubRuns = await fetchClubRuns(activeClubMembers.map(m => m.id));

    lastActiveClubId = activeClubId;
    renderClubsView();
    renderLeaderboard();
  } catch (err) {
    console.error('Error loading clubs:', err);
  }
}

function renderClubsView() {
  const isEmpty = activeClubId === null;
  $('#club-empty-state').hidden = !isEmpty;
  $('#club-active-state').hidden = isEmpty;

  if (isEmpty) {
    const backBtn = $('#club-back-to-dashboard-container');
    if (backBtn) backBtn.style.display = (clubs.length > 0) ? 'block' : 'none';
    return;
  }

  const isOwner = activeClub.owner_id === me.id;
  const ownerProfile = activeClubMembers.find(m => m.id === activeClub.owner_id);
  $('#club-owner-name').textContent = ownerProfile ? formatDisplayName(ownerProfile.display_name) : 'Unknown';

  const link = window.location.origin + window.location.pathname + '?c=' + activeClub.invite_code;
  $('#club-invite-link').value = link;
  $('#club-display-code').textContent = activeClub.invite_code;

  // Manage owner settings card
  const settingsCard = $('#club-settings-card');
  if (isOwner) {
    settingsCard.hidden = false;
    $('#f-club-settings-name').value = activeClub.name;
    $('#f-club-settings-pool').checked = activeClub.pool_enabled;
    $('#f-club-settings-baht').value = activeClub.pool_baht_per_km;
    $('#f-club-settings-max-loss').value = activeClub.pool_max_loss;
    $('#club-settings-pool-details').style.display = activeClub.pool_enabled ? 'flex' : 'none';
  } else {
    settingsCard.hidden = true;
  }

  // Render Members
  const memList = $('#club-members-list');
  memList.innerHTML = activeClubMembers
    .map(member => {
      const isMemberOwner = member.id === activeClub.owner_id;
      const isSelf = member.id === me.id;
      
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
  const cutoff = rangeCutoff(clubRange);
  const inRange = activeClubRuns.filter((r) => (cutoff ? r.run_date >= cutoff : true));

  const totals = new Map();
  // Initialize everyone in the club to 0 km so they appear on the leaderboard
  for (const m of activeClubMembers) {
    totals.set(m.id, { name: formatDisplayName(m.display_name || 'Anonymous'), avatar: m.avatar_url || '', km: 0, runs: 0 });
  }

  for (const r of inRange) {
    if (totals.has(r.user_id)) {
      const cur = totals.get(r.user_id);
      cur.km += Number(r.distance_km);
      cur.runs += 1;
    }
  }

  const ranked = [...totals.entries()]
    .map(([userId, t]) => ({ userId, ...t }))
    .sort((a, b) => b.km - a.km);
  const el = $('#club-leaderboard');
  if (ranked.length === 0) {
    el.innerHTML = `<li class="empty">No runs in this range yet.</li>`;
    $('#club-baht-section').hidden = true;
    return;
  }

  el.innerHTML = ranked
    .map((row, i) => `
      <li class="lb-row${row.userId === me.id ? ' is-me' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <div class="user-profile">
          ${avatarImg(row.avatar, ' style="width:24px; height:24px;"')}
          <span class="lb-name">${escapeHtml(row.name)}</span>
        </div>
        <span class="lb-runs">${row.runs} run${row.runs === 1 ? '' : 's'}</span>
        <span class="lb-km">${fmtKm(row.km)}</span>
      </li>`)
    .join('');

  // Handle Baht Challenge
  const bahtSection = $('#club-baht-section');
  if (activeClub.pool_enabled && ranked.length > 1) {
    bahtSection.hidden = false;
    renderClubBahtChallenge(ranked, '#club-baht-list');
  } else {
    bahtSection.hidden = true;
  }
}

function renderClubBahtChallenge(ranked, targetSelector = '#club-baht-list') {
  const bahtList = $(targetSelector);
  if (!bahtList) return;
  const bahtPerKm = Number(activeClub.pool_baht_per_km);
  const maxLoss = Number(activeClub.pool_max_loss);

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

      const isMe = row.userId === me.id;

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

function renderClubRuns() {
  const el = $('#club-run-list');
  if (activeClubRuns.length === 0) {
    el.innerHTML = `<li class="empty">No runs logged yet by club members.</li>`;
    return;
  }

  el.innerHTML = activeClubRuns
    .map((r) => {
      const pace = paceLabel(r.distance_km, r.duration_min);
      const isMine = r.user_id === me.id;
      const runnerName = formatDisplayName(r.profiles?.display_name || 'Anonymous');
      const avatar = r.profiles?.avatar_url || '';

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
          ${isMine ? `<button class="run-del" data-id="${r.id}" title="Delete this run" aria-label="Delete run">✕</button>` : ''}
        </li>`;
    })
    .join('');

  el.querySelectorAll('.run-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (confirm('Delete this run?')) {
        try {
          await deleteRun(btn.dataset.id);
          // Reload everything to sync
          await Promise.all([loadRuns(), loadClubs()]);
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      }
    });
  });
}

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

function copyClubLink() {
  const linkEl = $('#club-invite-link');
  linkEl.select();
  linkEl.setSelectionRange(0, 99999);
  try {
    navigator.clipboard.writeText(linkEl.value);
  } catch (_) {
    document.execCommand && document.execCommand('copy');
  }

  const btn = $('#btn-copy-club-link');
  const origText = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = origText; }, 2000);
}

// ---------------------------------------------------------------------------
//  Club URL Invites Handling
// ---------------------------------------------------------------------------
async function handlePendingClubAction() {
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

    // Retrieve basic details
    const code = String(pendingClubAction.code).trim().toUpperCase();
    const { data: club, error: findErr } = await supabase
      .from('clubs')
      .select('id, name')
      .eq('invite_code', code)
      .maybeSingle();

    if (findErr) throw findErr;
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
    switchTab('clubs');
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
