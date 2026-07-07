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
export async function fetchRuns(groupId = null) {
  if (!supabase) return [];

  let query = supabase
    .from(TABLE)
    .select('*, profiles:user_id(display_name, avatar_url)');

  if (groupId) {
    // Get all user_ids of the group members first
    const { data: members, error: mErr } = await supabase
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId);
    if (mErr) throw mErr;
    
    const userIds = (members ?? []).map((m) => m.user_id);
    if (userIds.length === 0) return [];
    query = query.in('user_id', userIds);
  }

  const { data, error } = await query
    .order('run_date', { ascending: false })
    .order('created_at', { ascending: false });

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
//  Groups
// ---------------------------------------------------------------------------
export async function fetchGroups() {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) return [];

  const { data, error } = await supabase
    .from('group_members')
    .select('role, joined_at, groups:group_id(*)')
    .eq('user_id', myId);

  if (error) throw error;

  return (data ?? []).map((m) => ({
    role: m.role,
    joinedAt: m.joined_at,
    ...m.groups,
  }));
}

export async function createGroup(name) {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) throw new Error('Not authenticated');

  const { data: group, error: gErr } = await supabase
    .from('groups')
    .insert({ name, created_by: myId })
    .select()
    .single();

  if (gErr) throw gErr;

  const { error: mErr } = await supabase
    .from('group_members')
    .insert({
      group_id: group.id,
      user_id: myId,
      role: 'owner',
    });

  if (mErr) throw mErr;

  return group;
}

export async function fetchGroupMembers(groupId) {
  const { data, error } = await supabase
    .from('group_members')
    .select('role, joined_at, profiles:user_id(id, display_name, avatar_url)')
    .eq('group_id', groupId);

  if (error) throw error;

  return (data ?? []).map((m) => ({
    role: m.role,
    joinedAt: m.joined_at,
    ...m.profiles,
  }));
}

export async function getOrCreateGroupInvite(groupId) {
  const { data: { session } } = await supabase.auth.getSession();
  const myId = session?.user?.id;
  if (!myId) throw new Error('Not authenticated');

  const { data: existing, error: fErr } = await supabase
    .from('group_invites')
    .select('code')
    .eq('group_id', groupId)
    .limit(1);

  if (fErr) throw fErr;
  if (existing && existing.length > 0) {
    return existing[0].code;
  }

  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const { data, error } = await supabase
    .from('group_invites')
    .insert({
      code,
      group_id: groupId,
      created_by: myId,
    })
    .select()
    .single();

  // 23505 = unique_violation: a concurrent call already created the code for
  // this group (unique(group_id)). Re-read and return the winner's code.
  if (error) {
    if (error.code === '23505') {
      const { data: raced, error: reErr } = await supabase
        .from('group_invites')
        .select('code')
        .eq('group_id', groupId)
        .limit(1);
      if (reErr) throw reErr;
      if (raced && raced.length > 0) return raced[0].code;
    }
    throw error;
  }
  return data.code;
}

export async function fetchInvite(code) {
  // get_invite is a SECURITY DEFINER RPC so a prospective member (not yet in the
  // group) can preview just this one group's name; the group_invites table itself
  // is readable only by existing members.
  const { data, error } = await supabase.rpc('get_invite', { invite_code: code });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  // Preserve the previous shape ({ group_id, groups: { name } }) for callers.
  return { group_id: data[0].group_id, groups: { name: data[0].group_name } };
}

export async function joinGroupByCode(code) {
  // Joining goes through a SECURITY DEFINER RPC that validates the code, so a
  // user can't add themselves to an arbitrary group by guessing its UUID.
  const { data, error } = await supabase.rpc('join_group_by_code', { invite_code: code });
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('Invalid invite code');
  return { name: data[0].group_name };
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

export async function uploadAvatar(file, userId) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: true });

  if (error) throw error;

  const { data } = supabase.storage
    .from('avatars')
    .getPublicUrl(path);

  return data.publicUrl;
}
