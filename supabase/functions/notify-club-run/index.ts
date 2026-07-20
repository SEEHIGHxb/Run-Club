import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";

// Constant-time comparison so a wrong secret can't be recovered by measuring
// how quickly this function rejects it.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  // This runs with the SERVICE-ROLE key (full DB access, RLS bypassed), so it
  // must authenticate its caller. It is invoked only by a Supabase Database
  // Webhook (server-to-server) on runs INSERT — no browser ever calls it, so
  // there is deliberately no CORS handling. The webhook is configured to send a
  // shared secret as the `x-webhook-secret` header; we verify it before trusting
  // the payload. Without this, anyone who reached the URL could POST a forged
  // `{type:"INSERT", table:"runs", record:{...}}` and blast fabricated push
  // notifications to a victim's club-mates.
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expectedSecret = Deno.env.get("WEBHOOK_SECRET");
  if (!expectedSecret) {
    console.error("WEBHOOK_SECRET is not set — refusing to process the webhook.");
    return json({ error: "Server not configured" }, 500);
  }
  const providedSecret = req.headers.get("x-webhook-secret") ?? "";
  if (!timingSafeEqual(providedSecret, expectedSecret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    console.log("Notification trigger received payload:", body);

    // Make sure it is an INSERT webhook on the runs table
    if (body.type !== "INSERT" || body.table !== "runs") {
      return json({ message: "Ignore non-insert operations" }, 200);
    }

    const run = body.record;
    const runnerId = run.user_id;
    const distanceKm = Number(run.distance_km).toFixed(2);

    // 1. Resolve runner display name
    const { data: runnerProfile, error: profileErr } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", runnerId)
      .single();

    if (profileErr || !runnerProfile) {
      throw new Error(`Runner profile not found: ${profileErr?.message}`);
    }
    const runnerName = runnerProfile.display_name || "A runner";

    // 2. Find all clubs this runner is in
    const { data: clubMemberships, error: membershipErr } = await supabase
      .from("club_members")
      .select("club_id, clubs(name)")
      .eq("user_id", runnerId);

    if (membershipErr || !clubMemberships || clubMemberships.length === 0) {
      console.log("Runner is not in any clubs. Skipping notifications.");
      return json({ message: "Runner is not in any clubs" }, 200);
    }

    const clubIds = clubMemberships.map((cm) => cm.club_id);
    const clubNamesMap = new Map(
      clubMemberships.map((cm) => [cm.club_id, (cm.clubs as any)?.name || "Club"])
    );

    // 3. Find other members in those clubs
    const { data: otherMembers, error: membersErr } = await supabase
      .from("club_members")
      .select("user_id, club_id")
      .in("club_id", clubIds)
      .neq("user_id", runnerId);

    if (membersErr || !otherMembers || otherMembers.length === 0) {
      console.log("No other members in these clubs. Skipping notifications.");
      return json({ message: "No other members to notify" }, 200);
    }

    const otherUserIds = [...new Set(otherMembers.map((m) => m.user_id))];

    // Map each user ID to the clubs they share with the runner (for customizable message strings)
    const userSharedClubs = new Map<string, string[]>();
    for (const m of otherMembers) {
      const list = userSharedClubs.get(m.user_id) || [];
      const clubName = clubNamesMap.get(m.club_id);
      if (clubName && !list.includes(clubName)) {
        list.push(clubName);
        userSharedClubs.set(m.user_id, list);
      }
    }

    // 4. Retrieve push subscriptions for those members
    const { data: subscriptions, error: subsErr } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("user_id", otherUserIds);

    if (subsErr) {
      throw new Error(`Failed to fetch subscriptions: ${subsErr.message}`);
    }

    if (!subscriptions || subscriptions.length === 0) {
      console.log("No push subscriptions found for other club members.");
      return json({ message: "No subscribers found" }, 200);
    }

    // Configure Web Push with VAPID credentials
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;

    if (!vapidPublicKey || !vapidPrivateKey) {
      throw new Error("Missing VAPID configuration secrets on Supabase.");
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    // 5. Broadcast notification to all subscriptions
    console.log(`Broadcasting to ${subscriptions.length} subscriptions...`);
    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const sharedClubs = userSharedClubs.get(sub.user_id) || [];
        const clubContext = sharedClubs.length > 0 ? ` [${sharedClubs[0]}]` : "";

        const payload = JSON.stringify({
          title: `New Run${clubContext}`,
          body: `${runnerName} logged ${distanceKm} km!`,
        });

        const pushSub = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSub, payload);
        } catch (err: any) {
          // If the push service returns 404 or 410, it means the subscription is expired/invalid. Clean it up.
          if (err.statusCode === 404 || err.statusCode === 410) {
            console.log(`Subscription for user ${sub.user_id} is stale (status ${err.statusCode}). Cleaning up database.`);
            await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          } else {
            throw err;
          }
        }
      })
    );

    const sentCount = results.filter((r) => r.status === "fulfilled").length;
    console.log(`Finished broadcasting. Successfully sent: ${sentCount}/${subscriptions.length}`);

    return json({ message: "Done", sent: sentCount }, 200);
  } catch (err: any) {
    console.error("Critical error in notify-club-run:", err);
    return json({ error: err.message }, 500);
  }
});
