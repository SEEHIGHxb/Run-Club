// ============================================================================
//  Runaway · Friends
//  Friends list, incoming/outgoing requests, add-by-code form, shareable
//  friend link, and the ?f=CODE invite modal flow.
// ============================================================================

import {
  fetchProfile,
  fetchFriends,
  fetchPendingRequests,
  sendFriendRequest,
  getFriendByCode,
  acceptFriendRequest,
  removeFriendship,
} from './db.js?v=4';
import { state } from './state.js';
import { $, escapeHtml, formatDisplayName, avatarImg, copyInputToClipboard } from './util.js';

let pendingAction = null;   // friend link action from a URL (?f=CODE / ?add-friend=UUID)

export function initFriends() {
  $('#friend-add-form').addEventListener('submit', onFriendAddSubmit);
  $('#btn-copy-friend-link').addEventListener('click', () =>
    copyInputToClipboard('#my-friend-link', '#btn-copy-friend-link'));

  // Invite modal actions (friend links)
  $('#btn-invite-accept').addEventListener('click', acceptPendingAction);
  $('#btn-invite-decline').addEventListener('click', closeInviteModal);
}

export function setPendingFriendAction(action) {
  pendingAction = action;
}

export async function loadFriends() {
  try {
    const list = await fetchFriends();
    const { incoming, outgoing } = await fetchPendingRequests();
    renderFriendsView(list, incoming, outgoing);
    updateFriendBadge(incoming.length);
  } catch (err) {
    console.error('Error loading friends:', err);
  }
}

// ---------------------------------------------------------------------------
//  Friend invite links (?f=CODE)
// ---------------------------------------------------------------------------
export async function handlePendingFriendAction() {
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
    if (profile.id === state.me.id) {
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
//  Friends view rendering and handlers
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
    if (fid === state.me.id) {
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
