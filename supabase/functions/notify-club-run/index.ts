import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    console.log("Notification trigger received payload:", body);

    // Make sure it is an INSERT webhook on the runs table
    if (body.type !== "INSERT" || body.table !== "runs") {
      return new Response(JSON.stringify({ message: "Ignore non-insert operations" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
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
      return new Response(JSON.stringify({ message: "Runner is not in any clubs" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
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
      return new Response(JSON.stringify({ message: "No other members to notify" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
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
      return new Response(JSON.stringify({ message: "No subscribers found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
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

    return new Response(JSON.stringify({ message: "Done", sent: sentCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err: any) {
    console.error("Critical error in notify-club-run:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
