import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

function inferContentType(url: string, fallback: string | null) {
  const ct = (fallback || "").toLowerCase();
  if (ct && ct !== "application/octet-stream") return fallback!;

  const lower = url.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return fallback || "application/octet-stream";
}

// Auth is OPTIONAL here, not required. This proxy is a CORS fallback used
// by BOTH signed-in and anonymous singers (anonymous singing is a fully
// supported, first-class use case throughout this app) -- it was
// previously hard-requiring a signed-in session, which meant an anonymous
// user whose direct CDN fetch failed had no working fallback at all,
// right at the moment they needed one most.
//
// The real security boundary here is isAllowedAudioUrl() below (only
// jiosaavn.com/saavncdn.com domains are proxyable) -- that's what
// actually prevents this being abused as an open proxy, regardless of
// auth state. Requiring sign-in on top of that domain allowlist added
// friction without adding real protection.
//
// Also switched getClaims() -> getUser(): getClaims() is the same
// unstable method that was already identified and fixed in submit-score
// (see that function's changelog) after it caused 500 crashes -- this
// function had the same latent bug, just never hit it as visibly.
async function getUserIdIfPresent(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch (e) {
    console.warn("[proxy-audio] Auth check failed (non-fatal, proceeding as anonymous):", e);
    return null;
  }
}

function isAllowedAudioUrl(audioUrl: string) {
  try {
    const parsed = new URL(audioUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "jiosaavn.com" || host.endsWith(".jiosaavn.com") || host.endsWith(".saavncdn.com");
  } catch {
    return false;
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // userId is informational only (logged below) -- NOT required to
    // proceed. See getUserIdIfPresent()'s comment for why.
    const userId = await getUserIdIfPresent(req);

    let audioUrl: string | null = null;

    if (req.method === "GET") {
      const url = new URL(req.url);
      audioUrl = url.searchParams.get("url");
    } else if (req.method === "POST") {
      const body = await req.json();
      audioUrl = body?.url;
    }

    if (!audioUrl || typeof audioUrl !== "string") {
      return new Response(JSON.stringify({ error: "Audio URL is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isAllowedAudioUrl(audioUrl)) {
      return new Response(JSON.stringify({ error: "Audio URL is not allowed" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const range = req.headers.get("range");
    console.log("Proxying allowed audio:", { userId, host: new URL(audioUrl).hostname, range });

    // Forward range header to support streaming + seeking
    const upstreamHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "audio/*,*/*",
      Referer: "https://www.jiosaavn.com/",
    };

    if (range) upstreamHeaders.Range = range;

    const upstream = await fetch(audioUrl, { headers: upstreamHeaders });

    if (!upstream.ok) {
      console.error("Upstream audio fetch failed:", upstream.status, upstream.statusText);
      return new Response(
        JSON.stringify({ error: `Failed to fetch audio: ${upstream.status}` }),
        {
          status: upstream.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const contentType = inferContentType(audioUrl, upstream.headers.get("content-type"));

    const headers: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    };

    // Pass through key streaming headers
    const passThrough = [
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ];

    for (const h of passThrough) {
      const v = upstream.headers.get(h);
      if (v) headers[h.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("-")] = v;
    }

    return new Response(upstream.body, {
      status: upstream.status, // 200 or 206 for range
      headers,
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Proxy failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
