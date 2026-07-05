// ============================================================================
//  Run Club — Data layer (Supabase)
//  Wraps all reads/writes to the `runs` table and the realtime subscription.
//  Consumed by app.js only. Import order: config.js -> db.js -> app.js.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured =
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_URL.startsWith('YOUR_') &&
  !SUPABASE_ANON_KEY.startsWith('YOUR_');

// Only build a client when configured, so the app can show a friendly setup
// message instead of throwing on load.
export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const TABLE = 'runs';

// Fetch every run, newest first. Throws on error (caller surfaces it).
export async function fetchRuns() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('run_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Insert a new run. `run` = { runner, distance_km, duration_min, run_date, notes }
export async function addRun(run) {
  const { data, error } = await supabase.from(TABLE).insert(run).select().single();
  if (error) throw error;
  return data;
}

// Delete a run by id.
export async function deleteRun(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}

// Subscribe to any change on the runs table. `onChange` fires on every
// INSERT/UPDATE/DELETE; `onStatus` (optional) receives the channel status
// string ('SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED').
// Returns an unsubscribe function.
export function subscribeToRuns(onChange, onStatus) {
  const channel = supabase
    .channel('runs-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, () => onChange())
    .subscribe((status) => { if (onStatus) onStatus(status); });
  return () => supabase.removeChannel(channel);
}
