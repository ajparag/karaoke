import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_RATINGS = new Set(["L", "S", "A", "B", "C", "D", "F"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") {
    if (required) throw new Error("Invalid text field");
    return null;
  }

  const cleaned = value.trim().replace(/[<>]/g, "").slice(0, maxLength);
  if (required && cleaned.length === 0) throw new Error("Missing required text field");
  return cleaned.length ? cleaned : null;
}

function cleanInteger(value: unknown, min: number, max: number, fallback: number | null = null) {
  if (value === null || value === undefined) {
    if (fallback === null) throw new Error("Missing numeric field");
    return fallback;
  }

  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Invalid numeric field");
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Resolves "City, Country" from the request's client IP when the client
// didn't already provide a city (this is the "no sign-in" / anonymous path
// -- signed-in users may have set a city on their profile in the future,
// but for now this covers everyone who submits without one).
// Uses ipapi.co (free tier, HTTPS, no API key needed for light usage).
// Any failure here is swallowed -- a broken geolocation lookup should never
// block a score submission, it just means city stays null.
async function geolocateFromIP(ip: string | null): Promise<string | null> {
  if (!ip || ip === "unknown") return null;
  try {
    const resp = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.error) return null; // ipapi.co returns { error: true, reason } on failure/rate-limit
    const city = typeof data.city === "string" && data.city.trim() ? data.city.trim() : null;
    const country = typeof data.country_name === "string" && data.country_name.trim() ? data.country_name.trim() : null;
    if (city && country) return `${city}, ${country}`;
    return city || country || null;
  } catch (e) {
    console.warn("[submit-score] IP geolocation failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // Auth is OPTIONAL. Signed-in users get their score attributed to
    // their account (userId set, feeds their profile stats via the
    // on_score_created trigger). Anyone else -- no account, no login --
    // still gets their score saved to the public leaderboard, just with
    // user_id left NULL. City/country for these anonymous submissions is
    // resolved from their IP address further below.
    const authHeader = req.headers.get("authorization");
    let userId: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      // getUser() is the stable method available in all supabase-js v2.x.
      // getClaims() was used before but is unstable/unavailable in some
      // versions and was causing the 500 crash.
      const { data: userData } = await authClient.auth.getUser();
      userId = userData?.user?.id ?? null;
    }

    const body = await req.json();
    const score = cleanInteger(body.score, 0, 1000);
    const rating = cleanText(body.rating, 1, true)!;

    if (!ALLOWED_RATINGS.has(rating)) {
      return json({ error: "Invalid score rating" }, 400);
    }

    const durationSeconds = cleanInteger(body.durationSeconds, 0, 24 * 60 * 60, 0);
    const minimumSessionSeconds = Math.min(20, Math.max(5, Math.floor(durationSeconds * 0.25)));
    const playedSeconds = cleanInteger(body.playedSeconds, 0, 24 * 60 * 60, 0);

    if (durationSeconds > 0 && playedSeconds < minimumSessionSeconds) {
      return json({ error: "Song session was too short to submit a score" }, 400);
    }

    const songTitle = cleanText(body.songTitle, 200, true)!;
    const trackId = cleanText(body.trackId, 200, true)!;
    const songArtist = cleanText(body.songArtist, 200);
    const thumbnailUrl = cleanText(body.thumbnailUrl, 1000);
    const displayName = cleanText(body.displayName, 50);
    const timingAccuracy = cleanInteger(body.timingAccuracy, 0, 100, 0);
    const rhythmAccuracy = cleanInteger(body.rhythmAccuracy, 0, 100, 0);

    // x-forwarded-for is the standard header for the originating client IP
    // behind Supabase's edge runtime proxy; first entry is the real client.
    const forwardedFor = req.headers.get("x-forwarded-for");
    const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : null;

    let city = cleanText(body.city, 50);
    if (!city) {
      const geolocated = await geolocateFromIP(clientIp);
      city = geolocated ? cleanText(geolocated, 50) : null;
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Duplicate-submission check. Signed-in users dedupe by user_id (as
    // before). Anonymous submissions have no user_id, so they dedupe by
    // IP address instead -- same "one score per song per 24h" rule,
    // applied via whichever identity we actually have.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let dedupeQuery = adminClient
      .from("scores")
      .select("id")
      .eq("track_id", trackId)
      .gte("created_at", since)
      .limit(1);

    dedupeQuery = userId
      ? dedupeQuery.eq("user_id", userId)
      : clientIp
        ? dedupeQuery.eq("ip_address", clientIp)
        : dedupeQuery; // no userId AND no IP available -- skip dedupe, don't block a legitimate submission

    if (userId || clientIp) {
      const { data: existing, error: existingError } = await dedupeQuery;
      if (existingError) throw existingError;
      if (existing && existing.length > 0) {
        return json({ error: "You already submitted a score for this song in the last 24 hours" }, 409);
      }
    }

    const { data, error } = await adminClient
      .from("scores")
      .insert({
        user_id: userId,
        song_title: songTitle,
        song_artist: songArtist,
        track_id: trackId,
        thumbnail_url: thumbnailUrl,
        score,
        rating,
        rhythm_accuracy: rhythmAccuracy,
        timing_accuracy: timingAccuracy,
        duration_seconds: durationSeconds,
        display_name: displayName,
        city,
        ip_address: userId ? null : clientIp, // only stored for anonymous dedupe -- not needed once a real account exists
      })
      .select("id")
      .single();

    if (error) throw error;

    return json({ id: data.id });
  } catch (error) {
    // Log the FULL error so Supabase function logs show the real cause
    // (Postgres constraint violation, auth issue, etc.) rather than just
    // the generic wrapper message.
    console.error("[submit-score] Error:", error);
    if (error instanceof Error) {
      console.error("[submit-score] Stack:", error.stack);
    }
    const message = error instanceof Error ? error.message : "Failed to submit score";
    return json({ error: message }, 500);
  }
});
