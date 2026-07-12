// =============================================================================
// CHANGELOG
// v1 -- Cached all results including failures.
// v2 -- Never cache failures.
// v3 -- Direct LRCLIB fallback + plain lyrics.
// v4 -- Skip edge function, in-flight dedup, batched queries.
// v5 -- CURRENT: Three-step LRCLIB pipeline:
//   Step 1: Structured /api/search?track_name=X (+album, +duration combos)
//     -- No artist needed; handles Bollywood multi-artist inconsistencies.
//     -- 4 parallel requests, returns arrays, ranked by title/duration/script.
//   Step 2: /api/get with ALL artist name permutations (parallel).
//     -- Full unsplit string + all orderings of up to 3 individual artists.
//     -- Handles LRCLIB's exact-match requirement by brute-forcing every
//        plausible artist_name string (~16 combinations for 3 artists).
//   Step 3: Free-text /api/search?q= (batched, 2 at a time, last resort).
//   IndexedDB + in-memory caching, in-flight deduplication preserved.
// =============================================================================

import { supabase } from "@/integrations/supabase/client";
import { getCachedLyrics, cacheLyrics } from "@/lib/lyricsCache";

export interface LyricLine {
  time: number;
  text: string;
  duration?: number;
}

interface FetchArgs {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  language?: string;
}

const cache = new Map<string, any>();
const inFlight = new Map<string, Promise<{ lyrics: LyricLine[] }>>();

function cacheKey(args: FetchArgs): string {
  return `lyrics:${(args.artist || "").toLowerCase().trim()}-${(args.title || "").toLowerCase().trim()}`;
}

export function parseDurationToSeconds(value?: string | number): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== "string") return undefined;
  const parts = value.split(":").map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return undefined;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs > 0 ? secs : undefined;
}

// --- LRC parsing ---

function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const line of lrc.split('\n')) {
    const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
    if (match) {
      const time = parseInt(match[1]) * 60 + parseInt(match[2])
        + (match[3] ? parseInt(match[3].padEnd(3, '0')) : 0) / 1000;
      const text = match[4].trim();
      if (text) lines.push({ time, text });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    lines[i].duration = i < lines.length - 1 ? lines[i+1].time - lines[i].time : 5;
  }
  return lines.sort((a, b) => a.time - b.time);
}

function plainToLyricLines(plain: string): LyricLine[] {
  return plain
    .split('\n')
    .filter(l => l.trim())
    .map((text, i) => ({ time: i * 4, text: text.trim(), duration: 4 }));
}

// --- Script detection ---

export type Script = 'devanagari' | 'latin' | 'gurmukhi' | 'dual' | 'unknown';

export function detectScript(text: string): Script {
  let deva = 0, latin = 0, gurmukhi = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0900 && code <= 0x097F) deva++;
    else if (code >= 0x0A00 && code <= 0x0A7F) gurmukhi++;
    else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latin++;
  }
  const total = deva + latin + gurmukhi;
  if (total === 0) return 'unknown';
  const devaPct = deva / total;
  const latinPct = latin / total;
  const guruPct = gurmukhi / total;
  const significant = [devaPct, latinPct, guruPct].filter(p => p > 0.15).length;
  if (significant >= 2) return 'dual';
  if (devaPct > latinPct && devaPct > guruPct) return 'devanagari';
  if (guruPct > latinPct && guruPct > devaPct) return 'gurmukhi';
  if (latinPct > 0) return 'latin';
  return 'unknown';
}

export function scriptPenalty(script: Script, language?: string): number {
  const isHindi = (language || '').toLowerCase() === 'hindi';
  if (!isHindi) return 0;
  switch (script) {
    case 'devanagari': return 0;
    case 'latin': return 0;
    case 'unknown': return 3;
    case 'gurmukhi': return 5;
    case 'dual': return 5;
  }
}

// --- Shared helpers ---

const LRCLIB_HEADERS = { 'Lrclib-Client': 'KaraokeParty (https://karaokeparty.in)' };

// Normalizes an album name for comparison -- strips common noise like
// "(Original Motion Picture Soundtrack)", "- Single", punctuation and
// casing differences, so "Swades" and "Swades (Original Motion Picture
// Soundtrack)" are recognized as the same album.
export function normalizeAlbum(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\(.*?(soundtrack|motion picture|original|ost).*?\)/gi, '')
    .replace(/-\s*single\s*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// --- Title/album cleanup for Saavn conventions ----------------------------
// Saavn appends "(From "MovieName")" to virtually every Bollywood movie
// soundtrack title. LRCLIB never stores titles this way -- it just has
// "Phir Mohabbat", not "Phir Mohabbat (From "Murder 2")". Worse, the
// URL-encoded quotes in the suffix can cause LRCLIB's server to return
// 500/504 (which Chrome surfaces as a CORS error since error responses
// often lack CORS headers).
//
// Additionally, Saavn's album field often points to a compilation album
// (e.g. "Timeless Love Tunes") rather than the original movie album
// ("Murder 2"). The movie name inside the (From "...") suffix is almost
// always more accurate for LRCLIB matching than Saavn's own album field.

export interface CleanedTrackInfo {
  cleanTitle: string;
  betterAlbum: string | undefined; // extracted from (From "..."), or original album
}

export function cleanSaavnTitle(rawTitle: string, saavnAlbum?: string): CleanedTrackInfo {
  // Match patterns like:
  //   (From "Murder 2")  (From 'Murder 2')  (From Murder 2)
  //   [From "Murder 2"]  - From "Murder 2"
  // Case-insensitive, handles both quote styles and no quotes
  const fromMatch = rawTitle.match(
    /\s*[\(\[\-]+\s*from\s+["']?([^"'\)\]]+?)["']?\s*[\)\]]?\s*$/i
  );

  let cleanTitle = rawTitle;
  let betterAlbum = saavnAlbum;

  if (fromMatch) {
    // Strip the entire "(From ...)" suffix from the title
    cleanTitle = rawTitle.slice(0, fromMatch.index!).trim();
    // Use the extracted movie name as the album (more accurate than Saavn's)
    const extractedAlbum = fromMatch[1].trim();
    if (extractedAlbum.length > 0) {
      betterAlbum = extractedAlbum;
    }
  }

  // Also strip other common Saavn suffixes that LRCLIB won't have
  cleanTitle = cleanTitle
    .replace(/\s*\(.*?(Remix|Unplugged|Reprise|Remaster|Version|Lo-?fi|Slowed|Reverb).*?\)\s*$/i, '')
    .trim();

  // If stripping left us with nothing (shouldn't happen, but safety), use original
  if (cleanTitle.length === 0) cleanTitle = rawTitle;

  return { cleanTitle, betterAlbum };
}

interface RankedResult {
  lyrics: LyricLine[];
  script: Script;
  trackName: string;
  artistName: string;
}

// Rank and pick the best result from an array of LRCLIB search results.
//
// HARD FILTERS applied in tiers (strictest first, relax on fallback):
//   Tier 1: Exact title + not a cover/remix/karaoke
//   Tier 2: Exact title + covers allowed (original might not be on LRCLIB)
//   Tier 3: Partial title + not a cover
//   Tier 4: Partial title + covers allowed (last resort)
//
// Within each tier, synced results always beat plain. Within synced (or
// within plain), rank by duration proximity + script preference.

const COVER_KEYWORDS = /\b(cover|remix|karaoke|instrumental|live|acoustic|unplugged|slowed|reverb|lofi|lo-fi|mashup|reprise|recreated)\b/i;
const FEAT_PATTERN = /\(feat\..*?\)/i;

export function pickBestResult(
  pool: any[],
  title: string,
  duration: number | undefined,
  language: string | undefined,
  album?: string,
): RankedResult | null {
  const titleLower = title.toLowerCase().trim();
  const titleWords = titleLower.split(/\s+/);
  const albumNorm = normalizeAlbum(album);

  // Classify each item once
  interface Classified {
    item: any;
    isExactTitle: boolean;
    isCoverVariant: boolean;
    isAlbumDurationMatch: boolean; // partial title, but album + duration confirm it's the right recording
    durScore: number;
    scriptScore: number;
    script: Script;
  }

  const classified: Classified[] = pool.slice(0, 40).map(item => {
    const rawName = (item.trackName || '');
    const nameLower = rawName.toLowerCase().trim();
    // Strip parenthetical suffixes for title comparison
    const nameCore = nameLower.replace(/\s*[\(\[].*$/, '').trim();
    const titleCore = titleLower.replace(/\s*[\(\[].*$/, '').trim();

    // Exact: core title matches exactly (ignoring parenthetical tags)
    const isExactTitle = nameCore === titleCore;

    // Cover/variant: contains cover/remix/karaoke keywords or (feat.)
    const isCoverVariant = COVER_KEYWORDS.test(rawName) || FEAT_PATTERN.test(rawName);

    // Duration proximity (0 = perfect match, higher = worse)
    const durScore = duration && item.duration
      ? Math.abs(item.duration - duration)
      : 0;

    // Album+duration confirmation: song text is hard to pin down exactly
    // (transliteration drift, "Rahi" suffixes, spacing), but album name
    // and exact duration are much more reliable signals that this is the
    // SAME RECORDING even when the title text itself doesn't match
    // closely. Duration tolerance is deliberately tight (+/-1s) since
    // this is being used to OVERRIDE a weak title match -- a loose
    // duration window here would risk matching a different song from the
    // same soundtrack with a similar runtime.
    const albumMatches = albumNorm.length > 0 && normalizeAlbum(item.albumName) === albumNorm;
    const durationMatches = duration != null && item.duration != null
      && Math.abs(item.duration - duration) <= 1;
    const isAlbumDurationMatch = !isExactTitle && !isCoverVariant && albumMatches && durationMatches;

    const lyricsText = item.syncedLyrics || item.plainLyrics || '';
    const script = detectScript(lyricsText);
    const scriptScore = scriptPenalty(script, language);

    return { item, isExactTitle, isCoverVariant, isAlbumDurationMatch, durScore, scriptScore, script };
  });

  // Split synced vs plain -- synced ALWAYS preferred
  const synced = classified.filter(c => c.item.syncedLyrics);
  const plain = classified.filter(c => !c.item.syncedLyrics && c.item.plainLyrics);
  const candidates = synced.length > 0 ? synced : plain;

  if (candidates.length === 0) return null;

  // Apply tiers: strictest filter first, relax if no results.
  // The new album+duration tier sits ABOVE "exact title, covers OK" --
  // a confirmed album+duration match on a different-but-similar title is
  // stronger evidence of being the right recording than an exact title
  // that might turn out to be a cover/remix version.
  const tiers: ((c: Classified) => boolean)[] = [
    c => c.isExactTitle && !c.isCoverVariant,   // Tier 1: exact + original
    c => c.isAlbumDurationMatch,                 // Tier 2: partial title, confirmed by album+duration
    c => c.isExactTitle,                         // Tier 3: exact + covers OK
    c => !c.isCoverVariant,                      // Tier 4: partial + original (unconfirmed)
    () => true,                                  // Tier 5: anything
  ];

  let survivors: Classified[] = [];
  for (const filter of tiers) {
    survivors = candidates.filter(filter);
    if (survivors.length > 0) break;
  }

  if (survivors.length === 0) return null;

  // Rank survivors by duration proximity + script preference
  survivors.sort((a, b) => {
    const scoreA = a.durScore + a.scriptScore * 10;
    const scoreB = b.durScore + b.scriptScore * 10;
    return scoreA - scoreB;
  });

  const best = survivors[0];
  const bestItem = best.item;

  if (bestItem.syncedLyrics) {
    return { lyrics: parseLRC(bestItem.syncedLyrics), script: best.script, trackName: bestItem.trackName, artistName: bestItem.artistName };
  }
  if (bestItem.plainLyrics) {
    return { lyrics: plainToLyricLines(bestItem.plainLyrics), script: best.script, trackName: bestItem.trackName, artistName: bestItem.artistName };
  }
  return null;
}

// Generate all permutations of an array
export function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

// =============================================================================
// STEP 1: Structured /api/search?track_name=X (no artist needed)
// =============================================================================

async function step1StructuredSearch(
  title: string, album?: string, duration?: number, language?: string,
): Promise<RankedResult | null> {
  const params: URLSearchParams[] = [];

  // Most specific to broadest
  if (album && duration) {
    const p = new URLSearchParams();
    p.set('track_name', title); p.set('album_name', album); p.set('duration', String(duration));
    params.push(p);
  }
  if (duration) {
    const p = new URLSearchParams();
    p.set('track_name', title); p.set('duration', String(duration));
    params.push(p);
  }
  if (album) {
    const p = new URLSearchParams();
    p.set('track_name', title); p.set('album_name', album);
    params.push(p);
  }
  // Always: track_name only
  const pBroad = new URLSearchParams();
  pBroad.set('track_name', title);
  params.push(pBroad);

  console.log('[Lyrics] Step 1: Structured search with', params.length, 'param sets (parallel)');

  const results = await Promise.allSettled(
    params.map(async (p) => {
      const url = `https://lrclib.net/api/search?${p.toString()}`;
      const resp = await fetch(url, { headers: LRCLIB_HEADERS });
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    })
  );

  // Collect and deduplicate
  const seenIds = new Set<number>();
  const pool: any[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (item.id && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        pool.push(item);
      }
    }
  }

  console.log('[Lyrics] Step 1: Got', pool.length, 'unique results,',
    pool.filter((p: any) => p.syncedLyrics).length, 'synced');

  if (pool.length === 0) return null;
  return pickBestResult(pool, title, duration, language, album);
}

// =============================================================================
// STEP 2: /api/get with artist permutations (parallel)
// =============================================================================

async function step2GetWithArtistPermutations(
  title: string, artist?: string, language?: string,
): Promise<RankedResult | null> {
  if (!artist) return null;

  const fullArtist = artist.trim();
  const individuals = fullArtist
    .split(/[,&]/)
    .map(a => a.trim())
    .filter(a => a.length > 0)
    .slice(0, 3);

  // Build all artist_name strings to try:
  // 1. Full original unsplit string
  // 2. All permutations of all 3 (joined by ", ")
  // 3. All permutations of all pairs (joined by ", ")
  // 4. All singles
  const artistStrings = new Set<string>();
  artistStrings.add(fullArtist);

  if (individuals.length >= 2) {
    // All permutations of the full set
    for (const perm of permutations(individuals)) {
      artistStrings.add(perm.join(', '));
    }
    // All pairs
    for (let i = 0; i < individuals.length; i++) {
      for (let j = 0; j < individuals.length; j++) {
        if (i !== j) artistStrings.add(`${individuals[i]}, ${individuals[j]}`);
      }
    }
  }
  // All singles
  for (const a of individuals) {
    artistStrings.add(a);
  }

  const attempts = Array.from(artistStrings);
  console.log('[Lyrics] Step 2: /api/get with', attempts.length, 'artist permutations (parallel)');

  const results = await Promise.allSettled(
    attempts.map(async (art): Promise<RankedResult | null> => {
      try {
        const p = new URLSearchParams();
        p.set('track_name', title);
        p.set('artist_name', art);
        const resp = await fetch(`https://lrclib.net/api/get?${p.toString()}`, { headers: LRCLIB_HEADERS });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data?.syncedLyrics) {
          const script = detectScript(data.syncedLyrics);
          return { lyrics: parseLRC(data.syncedLyrics), script, trackName: data.trackName, artistName: data.artistName };
        }
        if (data?.plainLyrics) {
          const script = detectScript(data.plainLyrics);
          return { lyrics: plainToLyricLines(data.plainLyrics), script, trackName: data.trackName, artistName: data.artistName };
        }
        return null;
      } catch { return null; }
    })
  );

  const hits = results
    .filter((r): r is PromiseFulfilledResult<RankedResult> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value!);

  if (hits.length === 0) {
    console.log('[Lyrics] Step 2: All', attempts.length, 'permutations returned 404');
    return null;
  }

  // Pick best by script preference
  hits.sort((a, b) => scriptPenalty(a.script, language) - scriptPenalty(b.script, language));
  const best = hits[0];
  console.log('[Lyrics] Step 2: HIT (' + best.script + '):', best.trackName, 'by', best.artistName, '-', best.lyrics.length, 'lines');
  return best;
}

// =============================================================================
// STEP 3: Free-text /api/search?q= (batched, last resort)
// =============================================================================

async function step3FreeTextSearch(
  title: string, artist?: string, duration?: number, language?: string, album?: string,
): Promise<RankedResult | null> {
  const words = title.split(/\s+/);
  const trimmedWords = words.map(w => w.length > 4 ? w.slice(0, -1) : w);
  const trimmedTitle = trimmedWords.join(' ');

  const queries: string[] = [];
  if (artist) queries.push(`${title} ${artist}`);
  queries.push(title);
  if (trimmedTitle !== title) queries.push(trimmedTitle);
  if (words.length > 3) queries.push(words.slice(0, 3).join(' '));
  if (words.length > 2) queries.push(words.slice(0, 2).join(' '));

  console.log('[Lyrics] Step 3: Free-text search with', queries.length, 'queries (batched)');

  const seenIds = new Set<number>();
  const synced: any[] = [];
  const plain: any[] = [];

  for (let i = 0; i < queries.length; i += 2) {
    const batch = queries.slice(i, i + 2);
    const settled = await Promise.allSettled(
      batch.map(async (q) => {
        const resp = await fetch(
          `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`,
          { headers: LRCLIB_HEADERS },
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        return Array.isArray(data) ? data : [];
      })
    );

    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      for (const item of r.value) {
        if (!item.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        if (item.syncedLyrics) synced.push(item);
        else if (item.plainLyrics) plain.push(item);
      }
    }

    if (synced.length > 0) {
      console.log('[Lyrics] Step 3: Found', synced.length, 'synced in batch', Math.floor(i/2)+1, '-- skipping remaining');
      break;
    }
  }

  console.log('[Lyrics] Step 3: Results:', synced.length, 'synced,', plain.length, 'plain-only');

  const pool = synced.length > 0 ? synced : plain;
  if (pool.length === 0) return null;
  return pickBestResult(pool, title, duration, language, album);
}

// =============================================================================
// MAIN PIPELINE
// =============================================================================

async function searchLRCLIB(
  rawTitle: string, artist?: string, rawAlbum?: string, duration?: number, language?: string,
): Promise<LyricLine[]> {
  // Clean up Saavn-specific title conventions before any API calls.
  // "(From "Murder 2")" is stripped from the title and used as a better
  // album name than Saavn's own album field (which often points to a
  // compilation rather than the original soundtrack).
  const { cleanTitle: title, betterAlbum: album } = cleanSaavnTitle(rawTitle, rawAlbum);
  if (title !== rawTitle || album !== rawAlbum) {
    console.log('[Lyrics] Title cleanup:', rawTitle, '->', title, '| Album:', rawAlbum, '->', album);
  }

  // Step 1: Structured search (no artist, most reliable for Bollywood)
  const step1 = await step1StructuredSearch(title, album, duration, language);
  if (step1 && step1.lyrics.length > 0) {
    console.log('[Lyrics] Step 1 SUCCESS (' + step1.script + '):', step1.trackName, '-', step1.lyrics.length, 'lines');
    return step1.lyrics;
  }

  // Step 2: /api/get with all artist permutations
  const step2 = await step2GetWithArtistPermutations(title, artist, language);
  if (step2 && step2.lyrics.length > 0) {
    console.log('[Lyrics] Step 2 SUCCESS (' + step2.script + '):', step2.trackName, '-', step2.lyrics.length, 'lines');
    return step2.lyrics;
  }

  // Step 3: Free-text search (last resort)
  const step3 = await step3FreeTextSearch(title, artist, duration, language, album);
  if (step3 && step3.lyrics.length > 0) {
    console.log('[Lyrics] Step 3 SUCCESS (' + step3.script + '):', step3.trackName, '-', step3.lyrics.length, 'lines');
    return step3.lyrics;
  }

  return [];
}

// --- Main export ---

export async function fetchLyricsCached(args: FetchArgs): Promise<{ lyrics: LyricLine[] }> {
  const key = cacheKey(args);

  // 1. In-memory cache
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached?.lyrics?.length > 0) {
      console.log('[Lyrics] In-memory cache HIT:', cached.lyrics.length, 'lines');
      return cached;
    }
    cache.delete(key);
  }

  // 2. IndexedDB cache
  try {
    const idbLyrics = await getCachedLyrics(key);
    if (idbLyrics && idbLyrics.length > 0) {
      console.log('[Lyrics] IndexedDB cache HIT:', idbLyrics.length, 'lines');
      const result = { lyrics: idbLyrics };
      cache.set(key, result);
      return result;
    }
  } catch (e) {
    console.warn('[Lyrics] IndexedDB read failed (non-fatal):', e);
  }

  // 3. Deduplicate in-flight requests
  if (inFlight.has(key)) {
    console.log('[Lyrics] Joining in-flight request for:', args.title);
    return inFlight.get(key)!;
  }

  const promise = (async (): Promise<{ lyrics: LyricLine[] }> => {
    let lyrics: LyricLine[] = [];

    try {
      lyrics = await searchLRCLIB(args.title, args.artist, args.album, args.duration, args.language);
    } catch (e) {
      console.warn('[Lyrics] Pipeline failed:', (e as Error).message);
    }

    const result = { lyrics };
    if (lyrics.length > 0) {
      cache.set(key, result);
      cacheLyrics(key, lyrics).catch(() => {});
      console.log('[Lyrics] SUCCESS:', lyrics.length, 'lines for', args.title);
    } else {
      console.log('[Lyrics] FAILED: No lyrics found for', args.title, args.artist || '');
    }
    return result;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
