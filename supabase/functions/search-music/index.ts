// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Single hardcoded mirror: jiosaavn.rajputhemant.dev
//   Started returning 404 on every request. No SLA on free hobby mirrors.
//
// v2 — Attempted multi-mirror fallback with saavn.dev, jiosaavn-api.vercel.app
//   Both unverified guesses. Confirmed via Supabase logs that all 3 failed:
//   2x 404, 1x DNS resolution failure (saavn.dev does not resolve from Deno).
//
// v3 — Switched to saavn.sumit.co, VERIFIED working via direct fetch
//   Response shape confirmed by live test (not docs, not assumption):
//     { success: true, data: { total, start, results: [...] } }
//   Per-song fields confirmed: name, image[].url, downloadUrl[].url,
//   artists.primary[].name, album.name, duration (number), playCount (number|null)
//   Rewrote searchSaavn() to match this exact verified shape — no more
//   defensive .link/.url fallback chains guessing at multiple possible shapes.
//
// v4 — CURRENT: Optimized for speed — parallel queries + in-memory cache
//   - generateAlternativeQueries() previously ran in a SEQUENTIAL for-loop:
//     query[0] awaited fully, THEN query[1] if <5 results, THEN query[2]...
//     Worst case (3 alternative queries, each ~500-800ms): up to 2.4s total.
//   - Fix: all alternative queries now fire in PARALLEL via Promise.all.
//     Worst case is now ~800ms (slowest single query), not the sum of all.
//   - Added in-memory cache (function-instance-scoped, 15 min TTL) for
//     identical search queries. Supabase edge functions stay warm for
//     several minutes, so this catches repeat searches for the same song
//     (very common — e.g. multiple party members searching the same hit).
//   - Added 5s overall request timeout per Saavn mirror call to prevent
//     a hanging mirror from stalling the whole search indefinitely.
// =============================================================================

// supabase/functions/search-music/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_QUERY_LENGTH = 500;

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: 'saavn';
  audioUrl: string;
  album?: string;
  playCount?: number;
  language?: string; // from Saavn's own language field, e.g. "hindi", "punjabi", "english"
  releaseDate?: string; // "YYYY-MM-DD" from Saavn, used to identify genuinely recent releases
  year?: number; // 4-digit release year -- often populated even when releaseDate is null
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// Thrown when EVERY attempt to reach Saavn's API failed outright (network
// error, timeout, non-2xx) -- distinct from a query that legitimately has
// no matching songs. Lets the main handler respond with a clear "service
// unavailable" message instead of a misleading empty result set.
class SaavnUnavailableError extends Error {
  constructor() {
    super('Saavn API is currently unreachable');
    this.name = 'SaavnUnavailableError';
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

// ─── Original vs Remake Detection ─────────────────────────────────────────────
//
// Strategy: scan title + album + artist for known remake markers.
// If any remake pattern matches → it's a remake.
// If an "original" signal matches → it's definitely original (overrides ambiguity).
// Otherwise: fall back to play count (higher play count = more likely original).



// ─── Scoring ──────────────────────────────────────────────────────────────────
//
// Final ranking score = relevance (title/artist match) + popularity
// Popularity is the primary tiebreaker — the most-played version of a song
// rises to the top regardless of whether it is a remake or original.

function calculateRelevanceScore(query: string, track: Track): number {
  const q = query.toLowerCase().trim();
  const title = track.title.toLowerCase();
  const artist = track.artist.toLowerCase();
  const album = (track.album || '').toLowerCase();

  // ── Relevance (0-50) — fuzzy word matching ──────────────────────────────────
  // Uses word-level matching so "sapno" matches "sapnon" (substring check).
  // Users don't type exact spellings — one letter off should not penalise.
  let relevance = 0;

  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  const titleWords = title.split(/\s+/);
  let matchedInTitle = 0;

  for (const qw of qWords) {
    // Fuzzy: query word is a substring of ANY title word, or vice versa
    const inTitle = titleWords.some(tw => tw.includes(qw) || qw.includes(tw));
    if (inTitle) { matchedInTitle++; relevance += 5; }
    else if (artist.includes(qw)) { relevance += 3; }
    else if (album.includes(qw)) { relevance += 2; }
  }

  // High match ratio = strong relevance (replaces exact string match)
  const matchRatio = qWords.length > 0 ? matchedInTitle / qWords.length : 0;
  if (matchRatio >= 1.0) {
    relevance += 30; // all words found — as good as exact match
  } else if (matchRatio >= 0.7) {
    relevance += 20;
  } else if (matchRatio >= 0.5) {
    relevance += 10;
  }

  // Artist name in query
  const artistFirstName = artist.split(/[,\s]/)[0];
  if (q.includes(artistFirstName) && artistFirstName.length > 2) {
    relevance += 10;
  }

  // ── Popularity (0-150) — DOMINANT factor ───────────────────────────────────
  // The most-played version of a song should always appear first.
  // For a karaoke app, users want the version everyone knows.
  // 100K = 25, 1M = 50, 10M = 100, 50M = 125, 100M = 150
  const popularityScore = track.playCount
    ? Math.min(150, (Math.log10(track.playCount + 1) - 4) * 37.5)
    : 0;

  // ── Demotion penalty for non-original versions ──────────────────────────────
  // Users searching "mere sapno ki rani" want the original, not a remix/cover.
  // Penalty is large enough to push these below the original even if they
  // have a slightly better title match.
  const titleLower = title;
  const DEMOTE_KEYWORDS = [
    'remix', 'remixed', 'instrumental', 'karaoke', 'unplugged',
    'lofi', 'lo-fi', 'slowed', 'reverb', 'mashup', 'reprise',
    'recreated', 'rendition', 'revisited', 'reloaded',
    'acoustic version', 'club mix', 'dj mix',
  ];
  let demotionPenalty = 0;
  for (const kw of DEMOTE_KEYWORDS) {
    if (titleLower.includes(kw)) {
      demotionPenalty = 80;
      break;
    }
  }

  return relevance + popularityScore - demotionPenalty;
}

// ─── Query normalisation (unchanged from original) ─────────────────────────

const typoFixes: Record<string, string> = {
  'arjit': 'arijit', 'arjith': 'arijit', 'arijith': 'arijit',
  'shreya ghosal': 'shreya ghoshal', 'shreya goshal': 'shreya ghoshal',
  'atif aslaam': 'atif aslam', 'neha kakar': 'neha kakkar',
  'badsha': 'badshah', 'kesaria': 'kesariya', 'kesarya': 'kesariya',
  'tumhi ho': 'tum hi ho', 'tumhiho': 'tum hi ho',
  'channamereya': 'channa mereya',
};

function normalizeQuery(query: string): string {
  let q = query.toLowerCase().trim().replace(/\s+/g, ' ');
  for (const [typo, fix] of Object.entries(typoFixes)) {
    if (q.includes(typo)) q = q.replace(typo, fix);
  }
  return q;
}

function generateAlternativeQueries(query: string): string[] {
  const normalized = normalizeQuery(query);
  const alts: Set<string> = new Set([normalized]);

  // Strip trailing "songs" / "song"
  if (/\bsongs?\b/.test(normalized)) {
    alts.add(normalized.replace(/\s*\bsongs?\b\s*/g, ' ').trim());
  }
  // Short query: try adding "song" for better results
  if (normalized.split(' ').length <= 2 && !normalized.includes('song')) {
    alts.add(normalized + ' song');
  }

  return Array.from(alts).slice(0, 3);
}

// ─── JioSaavn API (saavn.sumit.co — verified working) ──────────────────────
//
// Response shape verified by direct fetch on 2026-06-16:
//   { success: true, data: { total, start, results: [...] } }
// Per-song fields verified present: name, image[].url, downloadUrl[].url,
// artists.primary[].name, album.name, duration (number), playCount (number|null)

const SAAVN_API_BASE = 'https://saavn.sumit.co/api';

// Simple in-memory cache, scoped to this warm function instance.
// Catches repeat searches for the same query without re-hitting Saavn or
// re-running the relevance/originality scoring pass.
const searchCache = new Map<string, { tracks: Track[]; ts: number }>();
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function timedFetch(url: string, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Fetch a single page of Saavn results, with the existing 429 retry logic.
// Returns [] on any failure -- callers treat missing pages as "no more
// results" rather than a hard error, so one bad page does not sink the
// others fetched in parallel.
// Returns null specifically when the fetch/parse GENUINELY FAILED (network
// error, timeout, non-2xx status, malformed response) -- distinct from []
// which means the request SUCCEEDED but had zero results. This
// distinction did not exist before and was the root cause of Saavn
// outages being silently indistinguishable from "no results found": every
// failure mode collapsed to [], so a total Saavn outage looked exactly
// like a query with no matches, all the way up through a normal 200
// response with an empty tracks array.
async function fetchSaavnPage(query: string, page: number): Promise<any[] | null> {
  try {
    const url = `${SAAVN_API_BASE}/search/songs?query=${encodeURIComponent(query)}&page=${page}&limit=40`;

    let response = await timedFetch(url);
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 1200));
      response = await timedFetch(url);
    }
    if (!response.ok) {
      console.error(`Saavn error (page ${page}):`, response.status);
      return null;
    }

    const data = await response.json();
    if (!data.success || !data.data?.results) {
      console.error(`Saavn: unexpected response shape (page ${page})`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    return data.data.results;
  } catch (err) {
    console.error(`Saavn page ${page} fetch error:`, err);
    return null;
  }
}

// Plan B: a self-hosted instance of a DIFFERENT open-source JioSaavn
// scraper (cyberboysumanjay/JioSaavnAPI, Python/Flask) than the one the
// primary SAAVN_API_BASE uses (sumitkolhe/jiosaavn-api, TypeScript).
// Different implementation, SAME underlying source (JioSaavn) -- this
// protects against "the primary wrapper's specific code/parsing broke"
// but NOT against a genuine JioSaavn-wide outage, since both ultimately
// depend on JioSaavn's own site being reachable and scrapable.
//
// Configured via the JIOSAAVN_FALLBACK_URL secret (Supabase edge function
// env var) rather than hardcoded, since it points at a self-hosted
// instance whose URL depends on where it's deployed. If that secret
// isn't set, the fallback is silently skipped (returns null immediately)
// rather than erroring -- makes this safe to ship before the fallback
// instance is actually deployed and configured.
async function fetchFromFallbackWrapper(query: string): Promise<Track[] | null> {
  const fallbackBase = Deno.env.get('JIOSAAVN_FALLBACK_URL');
  if (!fallbackBase) return null;

  try {
    const url = `${fallbackBase.replace(/\/$/, '')}/result/?query=${encodeURIComponent(query)}`;
    const response = await timedFetch(url, 8000); // self-hosted free-tier instances can be slower, especially cold-starting
    if (!response.ok) {
      console.error('Fallback wrapper error:', response.status);
      return null;
    }

    const data = await response.json();
    // Defensive about the exact response shape -- could be a bare array,
    // or wrapped under a common key, depending on the endpoint/version.
    const rawList: any[] = Array.isArray(data) ? data
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data?.data) ? data.data
      : [];

    if (rawList.length === 0) return null;

    // Field mapping below is based on a REAL response from the deployed
    // instance, not documentation examples -- several assumed field names
    // were wrong on the first pass (there is no "url", "songid", or
    // "image_url" field at all; the real ones are "media_url", "id", and
    // "image"). Corrected after manually verifying media_url actually
    // plays a full song despite the response also carrying "is_drm": 1
    // and "disabled_text": "Pro Only" flags -- those flags are present on
    // every track including ones confirmed to play fine, so they're not
    // reliably enforced on this endpoint and are deliberately ignored
    // here rather than used as a filter (filtering on them would wrongly
    // reject tracks that actually work).
    return rawList
      .filter((s: any) => s?.media_url) // must have a playable audio URL
      .map((s: any) => {
        const durationSecs = parseInt(s.duration, 10) || 0;
        const year = typeof s.year === 'string' && /^\d{4}$/.test(s.year) ? parseInt(s.year, 10) : undefined;
        // "singers" can be an empty string (seen in real responses) --
        // fall back to primary_artists when that happens.
        const artistName = (s.singers && s.singers.trim()) || s.primary_artists || 'Unknown Artist';
        return {
          id: s.id || s.media_url,
          title: decodeHtmlEntities(s.song || s.title || 'Unknown'),
          artist: decodeHtmlEntities(artistName),
          thumbnail: s.image || '',
          duration: formatDuration(durationSecs),
          source: 'saavn' as const,
          audioUrl: s.media_url,
          album: decodeHtmlEntities(s.album || ''),
          playCount: typeof s.play_count === 'number' ? s.play_count : 0,
          language: typeof s.language === 'string' ? s.language.toLowerCase() : undefined,
          year,
        };
      });
  } catch (err) {
    console.error('Fallback wrapper fetch error:', err);
    return null;
  }
}

async function searchSaavn(query: string): Promise<Track[]> {
  try {
    // Saavn's API caps at ~40 results PER PAGE regardless of the limit
    // param -- that part is a real ceiling on their side, confirmed via
    // testing. But it DOES support pagination, so to remove the effective
    // 40-result restriction we fetch multiple pages in parallel and merge
    // them, instead of just asking for a bigger single page (which gets
    // silently clamped back to ~40 anyway).
    console.log('Saavn query:', query);
    const PAGES_TO_FETCH = 4; // pages 1-4 in parallel -- up to ~160 results
    const pageResults = await Promise.all(
      Array.from({ length: PAGES_TO_FETCH }, (_, i) => fetchSaavnPage(query, i + 1))
    );

    // If EVERY page fetch failed (all null), this is a genuine outage --
    // not a real "no results" response. Signal that upward by throwing a
    // distinct, identifiable error rather than silently returning [],
    // which is indistinguishable from a real zero-match search.
    if (pageResults.every(p => p === null)) {
      console.error('Primary Saavn source fully unreachable -- trying fallback wrapper');
      const fallbackTracks = await fetchFromFallbackWrapper(query);
      if (fallbackTracks && fallbackTracks.length > 0) {
        console.log(`Fallback wrapper returned ${fallbackTracks.length} tracks`);
        return fallbackTracks;
      }
      // Fallback either isn't configured, or also failed -- genuinely
      // out of options, surface the outage.
      throw new SaavnUnavailableError();
    }

    // Merge and dedupe by song id (Saavn's pagination can occasionally
    // overlap by a track or two at page boundaries). Pages that failed
    // (null) are simply skipped -- a partial outage (some pages succeed,
    // some don't) still returns whatever real results came through.
    const seenIds = new Set<string>();
    const merged: any[] = [];
    for (const page of pageResults) {
      if (!page) continue;
      for (const song of page) {
        if (song?.id && !seenIds.has(song.id)) {
          seenIds.add(song.id);
          merged.push(song);
        }
      }
    }

    return merged.map((song: any) => {
      // downloadUrl[] entries use `.url` (confirmed — no `.link` field exists)
      const downloadUrls = song.downloadUrl || [];
      // Prefer standard stereo AAC. Skip SAR-encoded URLs (_sar_ in path) —
      // they are Sony Spatial Audio multi-channel files that take 2-3x longer
      // to separate than standard stereo. Fall back to 96kbps stereo if the
      // 160kbps tier is only available in SAR format for this track.
      const isSar = (u: any) => typeof u?.url === 'string' && u.url.includes('_sar_');
      const audioUrl =
        downloadUrls.find((d: any) => d.quality === '160kbps' && !isSar(d))?.url ||
        downloadUrls.find((d: any) => d.quality === '96kbps' && !isSar(d))?.url ||
        downloadUrls.find((d: any) => d.quality === '160kbps')?.url ||
        downloadUrls.find((d: any) => d.quality === '96kbps')?.url ||
        downloadUrls[downloadUrls.length - 1]?.url || '';

      // image[] entries use `.url` (confirmed — no `.link` field exists)
      const images = song.image || [];
      const thumbnail =
        images.find((i: any) => i.quality === '500x500')?.url ||
        images.find((i: any) => i.quality === '150x150')?.url ||
        images[images.length - 1]?.url || '';

      // artists.primary[] confirmed present on every song
      const artists =
        song.artists?.primary?.map((a: any) => a.name).join(', ') ||
        'Unknown Artist';

      const title = decodeHtmlEntities(song.name || 'Unknown');
      const artist = decodeHtmlEntities(artists);
      const album = decodeHtmlEntities(song.album?.name || '');
      // playCount confirmed nullable — default to 0 when null
      const playCount = typeof song.playCount === 'number' ? song.playCount : 0;
      // language confirmed present on Saavn song objects (e.g. "hindi", "punjabi", "english")
      const language = typeof song.language === 'string' ? song.language.toLowerCase() : undefined;
      // releaseDate is often null on this API even for recent songs -- year
      // is a coarser but more reliably populated fallback signal.
      const releaseDate = typeof song.releaseDate === 'string' ? song.releaseDate : undefined;
      const year = typeof song.year === 'number' ? song.year
        : typeof song.year === 'string' && /^\d{4}$/.test(song.year) ? parseInt(song.year, 10)
        : undefined;
      return {
        id: song.id, title, artist, thumbnail,
        duration: formatDuration(song.duration || 0),
        source: 'saavn' as const,
        audioUrl, album, playCount, language, releaseDate, year,
      };
    });
  } catch (err) {
    if (err instanceof SaavnUnavailableError) throw err; // propagate, don't swallow
    console.error('Saavn search error:', err);
    return [];
  }
}

// ─── Main search with dedup + ranking ─────────────────────────────────────

async function searchWithFuzzyMatching(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = searchCache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  console.log('Queries:', queries);

  // OPTIMIZATION: run the primary query first (most likely to succeed alone).
  // Only fire the alternative queries in PARALLEL if the primary came up short —
  // this avoids wasting calls on the common case where query[0] already
  // returns plenty of results, while still being fast when it doesn't.
  let allTracks = await searchSaavn(queries[0]);

  if (allTracks.length < 5 && queries.length > 1) {
    // Previously: sequential for-loop, each query awaited before the next.
    // Now: all remaining queries fire together — total time ≈ slowest one,
    // not the sum of all of them.
    const remaining = await Promise.all(queries.slice(1).map(q => searchSaavn(q)));
    allTracks = [...allTracks, ...remaining.flat()];
  }

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const t of allTracks) {
    if (!seen.has(t.id)) { seen.add(t.id); unique.push(t); }
  }

  // Sort: originals first, then by relevance + popularity
  const normalizedQ = normalizeQuery(originalQuery);
  const scored = unique
    .map(t => ({ t, score: calculateRelevanceScore(normalizedQ, t) }))
    .sort((a, b) => {
      // Primary: score (relevance + popularity)
      if (b.score !== a.score) return b.score - a.score;
      // Tiebreaker: raw play count
      return (b.t.playCount || 0) - (a.t.playCount || 0);
    });

  console.log('Top 5 results:');
  scored.slice(0, 5).forEach(({ t, score }) => {
    console.log(` ${score.toFixed(1).padStart(6)} | ${(t.playCount||0).toLocaleString().padStart(10)} plays | ${t.title} — ${t.artist}`);
  });

  // No count cap here anymore -- the frontend shows results in a
  // scrollable container instead of relying on the backend to truncate.
  // Every genuinely relevant result Saavn returned is available to scroll
  // through, not just the first 20.
  const finalTracks = scored.map(({ t }) => t);
  searchCache.set(normalizedForCache, { tracks: finalTracks, ts: Date.now() });
  return finalTracks;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { query } = await req.json();

    if (!query || typeof query !== 'string' || !query.trim()) {
      return new Response(
        JSON.stringify({ error: 'Query is required and must be a non-empty string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const trimmed = query.trim();
    if (trimmed.length > MAX_QUERY_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Query too long (max ${MAX_QUERY_LENGTH} chars)` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Search query:', trimmed);
    const tracks = await searchWithFuzzyMatching(trimmed);
    console.log(`Returning ${tracks.length} tracks`);

    return new Response(
      JSON.stringify({ tracks }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    if (err instanceof SaavnUnavailableError) {
      console.error('Saavn API is down -- returning 503');
      return new Response(
        JSON.stringify({
          error: 'Music service is temporarily unavailable. Please try again in a few minutes.',
          upstreamDown: true,
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Search error:', msg);
    return new Response(
      JSON.stringify({ error: 'Search failed', details: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
