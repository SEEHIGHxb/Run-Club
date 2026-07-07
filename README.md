# Runaway

A tiny, real-time group run tracker for a small circle of friends.
Log your runs · distance, date, duration, notes · and everyone sees a shared, live-updating leaderboard and zero-sum Baht loss pool. No build step, no server to run: it's a static site backed by Supabase.

*   **Stack:** vanilla HTML/CSS/JS (ES modules) + Supabase (Postgres + Realtime)
*   **Hosting:** GitHub Pages, Netlify, or just open the server locally
*   **Auth:** Google OAuth (Supabase Auth)

---

## Setup

### 1. Create a Supabase project
1. Go to <https://supabase.com> · sign in · **New project**.
2. Name it (e.g. `run-club`), set a database password, pick a region near you.
3. Wait for it to provision.

### 2. Create the tables
1. In the project, open **SQL Editor** · **New query**.
2. Copy the entire contents of `schema.sql`, paste, and click **Run**.
   * This creates the required tables, sets access policies, turns on realtime, and creates the `avatars` storage bucket used for custom profile pictures.
   * Re-run the whole file any time you pull schema changes (note: it drops and recreates the tables, so it also clears existing data).

### 3. Setup Google OAuth in Google Cloud Console
1. Go to the [Google Cloud Console Credentials Page](https://console.cloud.google.com/apis/credentials).
2. Create or select a project.
3. Click **Create Credentials** · select **OAuth client ID**.
4. Set application type to **Web application**.
5. Under **Authorized redirect URIs**, paste the Callback URL from your Supabase Dashboard:
   * Go to Supabase · **Authentication** · **Providers** · **Google**.
   * Copy the **Callback URL (for OAuth)** (looks like `https://<your-project-id>.supabase.co/auth/v1/callback`).
   * Paste it into the Google Cloud Console.
6. Under **Authorized JavaScript origins**, paste your base Supabase project URL (e.g. `https://<your-project-id>.supabase.co`).
7. Copy the generated **Client ID** and **Client Secret**.

### 4. Enable Google Auth in Supabase
1. In your Supabase Dashboard, go to **Authentication** · **Providers** · **Google**.
2. Toggle Google auth to **Enabled**.
3. Paste the Google **Client ID** and **Client Secret** into the inputs and click **Save**.

### 5. Configure Redirect URLs in Supabase
1. Go to Supabase · **Authentication** · **URL Configuration**.
2. Under **Redirect URLs**, add the host URLs where you run the site.
   * For local testing: add `http://localhost:5500`.
   * For deployment: add your hosted site URL.
3. Under **Site URL**, change it from the database API URL to your local testing URL `http://localhost:5500` or production URL.

### 6. Fill in config.js
Open `config.js` and replace:
```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
```

---

## How it works

*   Everyone opens the same URL, signs in with Google, and their display name and profile picture are automatically synchronized.
*   Adding a run inserts a row into the Supabase `runs` table.
*   The **leaderboard** ranks total km per person for the selected range (week / month / all time).
*   The **Run or Lose Pool** automatically calculates zero-sum payouts:
    *   For each runner, calculate their distance difference from the average of all other runners.
    *   If below average, they lose 10 Baht per km difference.
    *   If above average, they split the total lost pool equally.
*   You can delete your own runs.
