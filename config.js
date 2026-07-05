// ============================================================================
//  Run Club — Configuration
//  Fill in the three values below, then commit. See README.md for how to get
//  the Supabase URL + anon key. The anon key is safe to expose publicly (it is
//  the "publishable" key) because access is controlled by the database's
//  Row Level Security policies — see schema.sql.
// ============================================================================

export const SUPABASE_URL = 'https://hzgmjfgezlduxezbwpkm.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_1qQr0FV7gADjFUUaSMrbGA_QAdIZVvl';

// The single passcode your friend group shares to open the app.
// This is a soft gate (client-side only), enough to keep the URL from being
// usable by strangers who stumble onto it. Change it to anything you like.
export const APP_PASSCODE = 'lose1kmlose100baht';

// Optional: pre-fill the roster of names people can pick from.
// They can still type a custom name. Leave [] to allow free typing only.
export const ROSTER = ['Jojo'];
