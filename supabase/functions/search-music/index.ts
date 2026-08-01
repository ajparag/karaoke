// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Single hardcoded mirror: jiosaavn.rajputhemant.dev
//   Started returning 404 on every request. No SLA on free hobby mirrors.
//
// v2 — Attempted multi-mirror fallback with saavn.dev, jiosaavn-api.vercel.app
//   Both unverified guesses. Confirmed via Supabase logs that all 3 failed.
//
// v3 — Switched to saavn.sumit.co, VERIFIED working via direct fetch.
//
// v4 — Optimized for speed — parallel queries + in-memory cache.
//
// v5 — Three-tier CASCADE — JioSaavn → self-hosted wrapper → YouTube.
//   Root cause of v4 failure: JioSaavn blocks cloud IPs silently — returns
//   { total: 0, results: [] } with a 200 OK, indistinguishable from a real
//   zero-match search. All cloud providers affected: GCP, AWS, Render, Railway.
//   Cascade logic: only tried Plan B if Plan A was empty, only tried Plan C
//   if Plan B was also empty. Good for resilience, bad for breadth — users
//   only ever saw ONE source's results, even when the others had different
//   or better versions of the same song.
//
// v6 — CURRENT: Three sources queried in PARALLEL, results MERGED.
//   All three (JioSaavn, Gaana, YouTube) are called simultaneously on every
//   search. Whatever comes back gets pooled together, deduplicated by ID,
//   and ranked by the same relevance+popularity scoring — so the best
//   result rises to the top regardless of which source it came from,
//   and users can see multiple versions of a song side by side.
//   YouTube's timeout tightened 30s -> 15s since it's now always in the
//   critical path (not just an emergency fallback) — a slow/cold yt-dlp
//   response can no longer hold up the whole search indefinitely. YouTube's
//   own server-side 15-min cache means this only bites on genuinely novel
//   queries nobody has searched yet.
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
  source: 'saavn' | 'youtube';
  audioUrl: string;
  album?: string;
  playCount?: number;
  language?: string;
  releaseDate?: string;
  year?: number;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function timedFetch(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
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

// ─── Scoring ──────────────────────────────────────────────────────────────────

function calculateRelevanceScore(query: string, track: Track): number {
  const q = query.toLowerCase().trim();
  const title = track.title.toLowerCase();
  const artist = track.artist.toLowerCase();
  const album = (track.album || '').toLowerCase();

  let relevance = 0;
  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  const titleWords = title.split(/\s+/);
  let matchedInTitle = 0;

  for (const qw of qWords) {
    const inTitle = titleWords.some(tw => tw.includes(qw) || qw.includes(tw));
    if (inTitle) { matchedInTitle++; relevance += 5; }
    else if (artist.includes(qw)) { relevance += 3; }
    else if (album.includes(qw)) { relevance += 2; }
  }

  const matchRatio = qWords.length > 0 ? matchedInTitle / qWords.length : 0;
  if (matchRatio >= 1.0) relevance += 30;
  else if (matchRatio >= 0.7) relevance += 20;
  else if (matchRatio >= 0.5) relevance += 10;

  const artistFirstName = artist.split(/[,\s]/)[0];
  if (q.includes(artistFirstName) && artistFirstName.length > 2) relevance += 10;

  const popularityScore = track.playCount
    ? Math.min(150, (Math.log10(track.playCount + 1) - 4) * 37.5)
    : 0;

  const DEMOTE_KEYWORDS = [
    'remix', 'remixed', 'instrumental', 'karaoke', 'unplugged',
    'lofi', 'lo-fi', 'slowed', 'reverb', 'mashup', 'reprise',
    'recreated', 'rendition', 'revisited', 'reloaded',
    'acoustic version', 'club mix', 'dj mix',
  ];
  let demotionPenalty = 0;
  for (const kw of DEMOTE_KEYWORDS) {
    if (title.includes(kw)) { demotionPenalty = 80; break; }
  }

  return relevance + popularityScore - demotionPenalty;
}

// ─── Query normalisation ───────────────────────────────────────────────────

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
  if (/\bsongs?\b/.test(normalized)) {
    alts.add(normalized.replace(/\s*\bsongs?\b\s*/g, ' ').trim());
  }
  if (normalized.split(' ').length <= 2 && !normalized.includes('song')) {
    alts.add(normalized + ' song');
  }
  return Array.from(alts).slice(0, 3);
}

// ─── Plan A: saavn.sumit.co ────────────────────────────────────────────────

const SAAVN_API_BASE = 'https://saavn.sumit.co/api';

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
    // Return null specifically when total === 0 — signals IP block, not a
    // genuine empty query. Just means Plan A contributes nothing to the
    // merged pool this time; Plan B and C run independently regardless.
    if (data.data.total === 0) return null;
    return data.data.results;
  } catch (err) {
    console.error(`Saavn page ${page} fetch error:`, err);
    return null;
  }
}

async function searchPlanA(query: string): Promise<Track[]> {
  console.log('[Plan A] saavn.sumit.co query:', query);
  const PAGES_TO_FETCH = 4;
  const pageResults = await Promise.all(
    Array.from({ length: PAGES_TO_FETCH }, (_, i) => fetchSaavnPage(query, i + 1))
  );

  if (pageResults.every(p => p === null)) {
    console.log('[Plan A] all pages null/empty — contributing 0 results to merged pool');
    return [];
  }

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

  return merged.map((song: any): Track => {
    const downloadUrls = song.downloadUrl || [];
    const isSar = (u: any) => typeof u?.url === 'string' && u.url.includes('_sar_');
    const audioUrl =
      downloadUrls.find((d: any) => d.quality === '160kbps' && !isSar(d))?.url ||
      downloadUrls.find((d: any) => d.quality === '96kbps' && !isSar(d))?.url ||
      downloadUrls.find((d: any) => d.quality === '160kbps')?.url ||
      downloadUrls.find((d: any) => d.quality === '96kbps')?.url ||
      downloadUrls[downloadUrls.length - 1]?.url || '';

    const images = song.image || [];
    const thumbnail =
      images.find((i: any) => i.quality === '500x500')?.url ||
      images.find((i: any) => i.quality === '150x150')?.url ||
      images[images.length - 1]?.url || '';

    const artists = song.artists?.primary?.map((a: any) => a.name).join(', ') || 'Unknown Artist';
    const playCount = typeof song.playCount === 'number' ? song.playCount : 0;
    const language = typeof song.language === 'string' ? song.language.toLowerCase() : undefined;
    const releaseDate = typeof song.releaseDate === 'string' ? song.releaseDate : undefined;
    const year = typeof song.year === 'number' ? song.year
      : typeof song.year === 'string' && /^\d{4}$/.test(song.year) ? parseInt(song.year, 10)
      : undefined;

    return {
      id: song.id,
      title: decodeHtmlEntities(song.name || 'Unknown'),
      artist: decodeHtmlEntities(artists),
      thumbnail,
      duration: formatDuration(song.duration || 0),
      source: 'saavn',
      audioUrl,
      album: decodeHtmlEntities(song.album?.name || ''),
      playCount, language, releaseDate, year,
    };
  });
}

// ─── Plan B: GaanaPy (gaanapy-2ta9.onrender.com) ─────────────────────────
//
// Self-hosted fork of ZingyTomato/GaanaPy deployed on Render.
// Returns HLS stream URLs (signed, expire in ~4hrs) — acceptable since
// users won't wait that long between search and singing.
// play_count field is a string like "180M+" — not useful for ranking.
// popularity field has the raw number "180431071~180431071" — we parse
// the first part for ranking.
// Configured via GAANA_API_URL secret.

async function searchPlanB(query: string): Promise<Track[]> {
  const gaanaBase = Deno.env.get('GAANA_API_URL');
  if (!gaanaBase) {
    console.log('[Plan B] GAANA_API_URL not set — skipping');
    return [];
  }

  console.log('[Plan B] Gaana query:', query);
  try {
    const url = `${gaanaBase.replace(/\/$/, '')}/songs/search?query=${encodeURIComponent(query)}&limit=20`;
    const response = await timedFetch(url, 10000);
    if (!response.ok) {
      console.error('[Plan B] Gaana error:', response.status);
      return [];
    }

    const data = await response.json();
    const rawList: any[] = Array.isArray(data) ? data : [];

    if (rawList.length === 0) {
      console.log('[Plan B] Gaana returned empty — contributing 0 results to merged pool');
      return [];
    }

    console.log(`[Plan B] Gaana returned ${rawList.length} results`);
    return rawList
      .filter((s: any) => s?.stream_urls?.urls?.very_high_quality || s?.stream_urls?.urls?.high_quality)
      .map((s: any): Track => {
        const durationSecs = parseInt(s.duration, 10) || 0;
        // popularity is "180431071~180431071" — parse first number
        const popularityRaw = typeof s.popularity === 'string' ? s.popularity.split('~')[0] : '0';
        const playCount = parseInt(popularityRaw, 10) || 0;
        // prefer highest quality HLS stream
        const audioUrl =
          s.stream_urls?.urls?.very_high_quality ||
          s.stream_urls?.urls?.high_quality ||
          s.stream_urls?.urls?.medium_quality || '';
        const thumbnail =
          s.images?.urls?.large_artwork ||
          s.images?.urls?.medium_artwork ||
          s.images?.urls?.small_artwork || '';
        const releaseDate = typeof s.release_date === 'string' ? s.release_date : undefined;
        const year = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : undefined;

        return {
          id: s.track_id || s.seokey,
          title: decodeHtmlEntities(s.title || 'Unknown'),
          artist: decodeHtmlEntities(s.artists || 'Unknown Artist'),
          thumbnail,
          duration: formatDuration(durationSecs),
          source: 'saavn', // Gaana is still an Indian music source
          audioUrl,
          album: decodeHtmlEntities(s.album || ''),
          playCount,
          language: typeof s.language === 'string' ? s.language.toLowerCase() : undefined,
          releaseDate,
          year,
        };
      });
  } catch (err) {
    console.error('[Plan B] Gaana fetch error:', err);
    return [];
  }
}

// ─── Plan C: self-hosted yt-dlp Flask server ──────────────────────────────

async function searchPlanC(query: string): Promise<Track[]> {
  const ytBase = Deno.env.get('YOUTUBE_SEARCH_URL');
  if (!ytBase) {
    console.log('[Plan C] YOUTUBE_SEARCH_URL not set — skipping');
    return [];
  }

  console.log('[Plan C] YouTube/yt-dlp query:', query);
  try {
    const url = `${ytBase.replace(/\/$/, '')}/search?query=${encodeURIComponent(query)}`;
    const response = await timedFetch(url, 15000); // tightened from 30s — always in
    // the critical path now (parallel, not last-resort fallback); yt-dlp's own
    // 15-min server-side cache means only genuinely novel queries hit this ceiling
    if (!response.ok) {
      console.error('[Plan C] error:', response.status);
      return [];
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      console.error('[Plan C] unexpected response shape');
      return [];
    }

    console.log(`[Plan C] returned ${data.length} results`);
    return data
      .filter((t: any) => t?.id && t?.audioUrl && t?.title)
      .map((t: any): Track => ({
        id: t.id,
        title: decodeHtmlEntities(t.title || 'Unknown'),
        artist: decodeHtmlEntities(t.artist || 'Unknown Artist'),
        thumbnail: t.thumbnail || '',
        duration: t.duration || '0:00',
        source: 'youtube',
        audioUrl: t.audioUrl,
        album: decodeHtmlEntities(t.album || ''),
        playCount: typeof t.playCount === 'number' ? t.playCount : 0,
      }));
  } catch (err) {
    console.error('[Plan C] fetch error:', err);
    return [];
  }
}

// ─── Cache + ranking ──────────────────────────────────────────────────────

const searchCache = new Map<string, { tracks: Track[]; ts: number }>();
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;

async function searchWithFuzzyMatching(originalQuery: string): Promise<Track[]> {
  const normalizedForCache = normalizeQuery(originalQuery);
  const cached = searchCache.get(normalizedForCache);
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS) {
    console.log('Search cache HIT:', normalizedForCache);
    return cached.tracks;
  }

  const queries = generateAlternativeQueries(originalQuery);
  console.log('Queries:', queries);

  // Query all three sources IN PARALLEL and merge whatever comes back.
  // Each source has its own internal timeout (Plan A ~8s default, Plan B
  // 10s, Plan C 15s) so one slow source can't indefinitely block the
  // others — the whole call resolves as soon as the slowest one finishes
  // or times out, whichever comes first.
  const [planAResults, planBResults, planCResults] = await Promise.all([
    (async () => {
      let results = await searchPlanA(queries[0]);
      if (results.length < 5 && queries.length > 1) {
        const remaining = await Promise.all(queries.slice(1).map(q => searchPlanA(q)));
        results = [...results, ...remaining.flat()];
      }
      return results;
    })(),
    searchPlanB(queries[0]),
    searchPlanC(queries[0]),
  ]);

  console.log(`Sources returned — JioSaavn: ${planAResults.length}, Gaana: ${planBResults.length}, YouTube: ${planCResults.length}`);

  const allTracks = [...planAResults, ...planBResults, ...planCResults];

  // Deduplicate by ID
  const seen = new Set<string>();
  const unique: Track[] = [];
  for (const t of allTracks) {
    if (!seen.has(t.id)) { seen.add(t.id); unique.push(t); }
  }

  // Sort by relevance + popularity
  const scored = unique
    .map(t => ({ t, score: calculateRelevanceScore(normalizedForCache, t) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.t.playCount || 0) - (a.t.playCount || 0);
    });

  console.log('Top 5 results:');
  scored.slice(0, 5).forEach(({ t, score }) => {
    console.log(` ${score.toFixed(1).padStart(6)} | ${(t.playCount||0).toLocaleString().padStart(12)} | ${t.source} | ${t.title} — ${t.artist}`);
  });

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

    const tracks = await searchWithFuzzyMatching(trimmed);
    console.log(`Returning ${tracks.length} tracks`);

    return new Response(
      JSON.stringify({ tracks }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Search error:', msg);
    return new Response(
      JSON.stringify({ error: 'Search failed', details: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
