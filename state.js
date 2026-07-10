// ============================================================================
//  Runaway · Shared UI state
//  The few pieces of in-memory state that more than one module needs. Each
//  feature module keeps its own private state (filters, pending actions);
//  only genuinely cross-module data lives here. Writers: app.js (me, runs),
//  clubs.js (activeClub*). Readers: leaderboard.js and everyone else.
// ============================================================================

export const state = {
  me: null,               // current logged-in user profile
  runs: [],               // runs cache (newest first, from fetchRuns)
  activeClub: null,       // active club details, null when none/directory
  activeClubMembers: [],  // profiles of the active club's members
  activeClubRuns: [],     // runs belonging to the active club's members
};
