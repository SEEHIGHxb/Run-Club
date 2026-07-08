// ============================================================================
//  Runaway · Data layer (Supabase)
//  Wraps all authentication, reads/writes, and realtime subscriptions.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured =
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('YOUR-PROJECT') &&
  !SUPABASE_ANON_KEY.includes('your-anon-key');

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const TABLE = 'runs';

// Cap on how many runs we ever pull in one query: the newest N by date. Plenty
// of history for a small friend group (years' worth), while keeping the request
// bounded so it can't balloon as runs accumulate. The leaderboard's "All time"
// view is computed from this same window.
const RUN_FETCH_LIMIT = 500;

// ---------------------------------------------------------------------------
//  Authentication
// ---------------------------------------------------------------------------
export async function loginWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

export async function getCurrentUser() {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ---------------------------------------------------------------------------
//  Runs
// ---------------------------------------------------------------------------
export async function fetchRuns() {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from(TABLE)
    .select('*, profiles:user_id(display_name, avatar_url)')
    .order('run_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(RUN_FETCH_LIMIT);

  if (error) throw error;
  return data ?? [];
}

export async function addRun(runData) {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) throw new Error('Not authenticated');

  const run = {
    user_id: myId,
    distance_km: Number(runData.distance_km),
    duration_min: runData.duration_min ? Number(runData.duration_min) : null,
    run_date: runData.run_date,
    notes: runData.notes || null,
  };

  const { data, error } = await supabase.from(TABLE).insert(run).select().single();
  if (error) throw error;
  return data;
}

export async function deleteRun(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}

export function subscribeToRuns(onChange, onStatus) {
  const channel = supabase
    .channel('runs-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, () => onChange())
    .subscribe((status) => { if (onStatus) onStatus(status); });
  return () => supabase.removeChannel(channel);
}

// Live updates to the friends table (requests sent to/from me, accepts, removals)
// so incoming requests and the tab badge appear without a reload. RLS scopes the
// stream to rows involving the signed-in user.
export function subscribeToFriends(onChange) {
  const channel = supabase
    .channel('friends-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---------------------------------------------------------------------------
//  Profiles
// ---------------------------------------------------------------------------
export async function fetchProfile(profileId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileId)
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
//  Friends
// ---------------------------------------------------------------------------
export async function fetchFriends() {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) return [];

  const { data, error } = await supabase
    .from('friends')
    .select('*, user:user_id(id, display_name, avatar_url), friend:friend_id(id, display_name, avatar_url)')
    .eq('status', 'accepted');

  if (error) throw error;

  return (data ?? []).map((f) => {
    const otherUser = f.user_id === myId ? f.friend : f.user;
    return {
      friendshipId: f.id,
      user: otherUser,
    };
  });
}

export async function fetchPendingRequests() {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) return { incoming: [], outgoing: [] };

  const { data, error } = await supabase
    .from('friends')
    .select('*, user:user_id(id, display_name, avatar_url), friend:friend_id(id, display_name, avatar_url)')
    .eq('status', 'pending');

  if (error) throw error;

  const incoming = [];
  const outgoing = [];

  for (const f of (data ?? [])) {
    if (f.friend_id === myId) {
      incoming.push({ friendshipId: f.id, sender: f.user });
    } else if (f.user_id === myId) {
      outgoing.push({ friendshipId: f.id, receiver: f.friend });
    }
  }

  return { incoming, outgoing };
}

// Resolve a short friend code (e.g. "AB12CD") to its profile. The profiles
// select policy is readable by any signed-in user, so a prospective friend can
// look someone up by code — no RPC needed. Returns null when no code matches.
export async function getFriendByCode(code) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, friend_code')
    .eq('friend_code', String(code).trim().toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Matches a canonical UUID (Supabase user ids). Validating here keeps a
// free-text friend id out of the PostgREST .or() filter string below, where
// stray commas/parens would otherwise corrupt the query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sendFriendRequest(friendId) {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) throw new Error('Not authenticated');

  if (!UUID_RE.test(friendId)) throw new Error('That does not look like a valid User ID.');

  // Check if friendship already exists
  const { data: existing, error: checkErr } = await supabase
    .from('friends')
    .select('*')
    .or(`and(user_id.eq.${myId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${myId})`);

  if (checkErr) throw checkErr;
  if (existing && existing.length > 0) {
    const friendship = existing[0];
    if (friendship.status === 'pending' && friendship.friend_id === myId) {
      await acceptFriendRequest(friendship.id);
      return { status: 'accepted', friendshipId: friendship.id };
    }
    return { status: friendship.status, friendshipId: friendship.id };
  }

  const { data, error } = await supabase
    .from('friends')
    .insert({
      user_id: myId,
      friend_id: friendId,
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw error;
  return { status: 'pending', friendshipId: data.id };
}

export async function acceptFriendRequest(friendshipId) {
  const { error } = await supabase
    .from('friends')
    .update({ status: 'accepted' })
    .eq('id', friendshipId);
  if (error) throw error;
}

export async function removeFriendship(friendshipId) {
  const { error } = await supabase
    .from('friends')
    .delete()
    .eq('id', friendshipId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
//  Profile Management
// ---------------------------------------------------------------------------
export async function updateProfile(profileData) {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('profiles')
    .update({
      display_name: profileData.display_name,
      avatar_url: profileData.avatar_url,
    })
    .eq('id', myId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Upload a cropped avatar. The caller passes an already-processed square WebP
// Blob (see the cropper in app.js), so files land small and consistent. Stored
// at "<uid>/<timestamp>.webp" — the leading folder is the owner id, which the
// storage RLS policy checks.
export async function uploadAvatar(blob, userId) {
  const path = `${userId}/${Date.now()}.webp`;

  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, blob, { upsert: true, contentType: 'image/webp' });

  if (error) throw error;

  const { data } = supabase.storage
    .from('avatars')
    .getPublicUrl(path);

  return data.publicUrl;
}
