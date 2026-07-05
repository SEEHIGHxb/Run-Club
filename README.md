# 🏃 Run Club

A tiny, real-time group run tracker for a small circle of friends (5–6 people).
Log your runs — distance, date, duration, notes — and everyone sees a shared,
live-updating leaderboard. No build step, no server to run: it's a static site
backed by [Supabase](https://supabase.com) (free tier is plenty).

- **Stack:** vanilla HTML/CSS/JS (ES modules) + Supabase (Postgres + Realtime)
- **Hosting:** GitHub Pages, Netlify, or just open `index.html` locally
- **Auth:** one shared group passcode + pick-your-name (device-remembered)

---

## Setup (about 5 minutes)

### 1. Create a Supabase project
1. Go to <https://supabase.com> → sign in → **New project**.
2. Name it (e.g. `run-club`), set a database password, pick a region near you.
3. Wait ~1 minute for it to provision.

### 2. Create the table
1. In the project, open **SQL Editor** → **New query**.
2. Copy the entire contents of [`schema.sql`](schema.sql), paste, and click **Run**.
   - This creates the `runs` table, sets access policies, and turns on realtime.

### 3. Get your keys
1. Open **Project Settings** (gear icon) → **API**.
2. Copy the **Project URL** and the **anon / public** key.

### 4. Fill in config
Open [`config.js`](config.js) and replace:
```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...your-anon-key...';
export const APP_PASSCODE = 'pick-a-shared-passcode';
export const ROSTER = ['Jojo', 'Friend1', 'Friend2']; // optional name suggestions
```
> The anon key is **meant to be public** — access is controlled by the database
> policies in `schema.sql`. Don't paste the `service_role` key here.

### 5. Run it
- **Locally:** open `index.html` in a browser (or use a static server / the Live
  Preview panel).
- **Publicly (GitHub Pages):**
  1. Push this folder to a GitHub repo.
  2. Repo → **Settings → Pages** → Source: `main` branch, `/root`.
  3. Share the resulting URL + the passcode with your friends.

---

## How it works

- Everyone opens the same URL, enters the shared **passcode**, and types their
  **name** (remembered on their device via `localStorage`).
- Adding a run inserts a row into the Supabase `runs` table.
- Every open browser is subscribed to realtime changes, so a new run pops up on
  everyone's leaderboard within a second — no refresh needed.
- The **leaderboard** ranks total km per person for **this week / this month /
  all time**. Pace (min/km) is computed when a duration is entered.
- You can delete **your own** runs (matched by name).

## Files
| File | Purpose |
|------|---------|
| `index.html` | Markup / page structure |
| `index.css` | Styles |
| `config.js` | Your Supabase URL, key, passcode, roster |
| `db.js` | Supabase client + all data operations + realtime |
| `app.js` | UI logic: gate, form, leaderboard, list |
| `schema.sql` | Database table + policies + realtime (run once in Supabase) |

## Notes & limits
- **Security model** is intentionally light: a shared passcode + a public anon
  key with open table policies. Fine for a private friend group; anyone who has
  both the URL and passcode can read/write. For stronger guarantees, migrate to
  Supabase Auth (per-person accounts) and tighten the RLS policies.
- Free tier easily covers a handful of friends. A free Supabase project can be
  paused after long inactivity — just reopen the dashboard to wake it.

## Ideas to extend
- Weekly goal per person + progress ring
- Personal charts (km over time)
- Reactions / kudos on a run
- Export to CSV
