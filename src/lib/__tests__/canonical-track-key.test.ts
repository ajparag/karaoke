// =============================================================================
// canonicalTrackKey — unit tests
// =============================================================================
// Tests the cross-source cache-sharing logic added to the separate-vocals
// edge function. The core promise being tested: the SAME song picked from
// different sources (different trackId, different album grouping, minor
// duration rounding) must produce the SAME canonical key — while a
// genuinely different recording (Unplugged, Remix, a differently-timed
// edit) must NOT.
//
// NOTE: same pattern as separate-vocals-helpers.test.ts — the function is
// inlined here rather than imported, since the edge function file isn't
// part of the Vite/Vitest build graph (Deno runtime, not Node).
// =============================================================================

import { describe, it, expect } from 'vitest';

// ─── Inlined copy of the function under test ───────────────────────────────

function canonicalTrackKey(title: string, artist: string, durationSeconds: number): string | null {
  const stripNoise = (s: string) => s
    .toLowerCase()
    .replace(/\(from\s+["'].*?["']\)/gi, '')
    .replace(/\s*-\s*from\s+["'].*?["']/gi, '')
    .replace(/\(original\s+motion\s+picture.*?\)/gi, '')
    .replace(/\s*-\s*single\s*$/gi, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normTitle = stripNoise(title);
  const normArtist = stripNoise(artist).split(/[,&]/)[0].trim();

  const slug = `${normTitle}__${normArtist}`
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const alnumCount = (slug.match(/[a-z0-9]/g) || []).length;
  if (alnumCount < 3) return null;

  const durationBucket = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.round(durationSeconds / 10) * 10
    : 0;

  return `${slug}__${durationBucket}s`;
}

// ─── The core promise: cross-source matches ────────────────────────────────

describe('canonicalTrackKey — cross-source matching (the whole point)', () => {
  it('matches the same song across different album groupings', () => {
    // JioSaavn might list this under "Aashiqui 2", another source under
    // "Aashiqui 2 (Original Motion Picture Soundtrack)" — album never
    // factors into the key at all, so this is trivially true, but worth
    // asserting explicitly since it's the headline promise.
    const key1 = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    const key2 = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    expect(key1).toBe(key2);
  });

  it('matches when duration differs by a few seconds (rounding across sources)', () => {
    const key1 = canonicalTrackKey('Kesariya', 'Arijit Singh', 268);
    const key2 = canonicalTrackKey('Kesariya', 'Arijit Singh', 271); // 3s off, same bucket
    expect(key1).toBe(key2);
  });

  it('matches when one source includes a movie-name annotation and another does not', () => {
    const key1 = canonicalTrackKey('Phir Mohabbat (From "Murder 2")', 'Mohit Chauhan', 320);
    const key2 = canonicalTrackKey('Phir Mohabbat', 'Mohit Chauhan', 320);
    expect(key1).toBe(key2);
  });

  it('matches when one source has "- Single" suffix and another does not', () => {
    const key1 = canonicalTrackKey('Kesariya - Single', 'Arijit Singh', 268);
    const key2 = canonicalTrackKey('Kesariya', 'Arijit Singh', 268);
    expect(key1).toBe(key2);
  });

  it('matches when featured/secondary artists are listed differently', () => {
    const key1 = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh, Mithoon', 267);
    const key2 = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    expect(key1).toBe(key2);
  });

  it('is case-insensitive', () => {
    const key1 = canonicalTrackKey('TUM HI HO', 'ARIJIT SINGH', 267);
    const key2 = canonicalTrackKey('tum hi ho', 'arijit singh', 267);
    expect(key1).toBe(key2);
  });
});

// ─── The safety boundary: genuinely different recordings must NOT merge ───

describe('canonicalTrackKey — must NOT merge genuinely different recordings', () => {
  it('does NOT match when duration differs by more than the bucket tolerance', () => {
    // A radio edit vs the full version — reusing stems here would
    // desync the guide vocals from audio that doesn't match its timing.
    const fullVersion = canonicalTrackKey('Kesariya', 'Arijit Singh', 268);
    const radioEdit = canonicalTrackKey('Kesariya', 'Arijit Singh', 180);
    expect(fullVersion).not.toBe(radioEdit);
  });

  it('does NOT strip "Unplugged" — different actual recording, different timing', () => {
    const studio = canonicalTrackKey('Kesariya', 'Arijit Singh', 268);
    const unplugged = canonicalTrackKey('Kesariya (Unplugged)', 'Arijit Singh', 268);
    expect(studio).not.toBe(unplugged);
  });

  it('does NOT strip "Remix" — different actual recording', () => {
    const original = canonicalTrackKey('Kala Chashma', 'Amar Arshi', 220);
    const remix = canonicalTrackKey('Kala Chashma (Remix)', 'Amar Arshi', 220);
    expect(original).not.toBe(remix);
  });

  it('does NOT match different songs with the same artist', () => {
    const key1 = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    const key2 = canonicalTrackKey('Kesariya', 'Arijit Singh', 267);
    expect(key1).not.toBe(key2);
  });

  it('does NOT match the same title by different artists', () => {
    const key1 = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    const key2 = canonicalTrackKey('Tum Hi Ho', 'Some Cover Artist', 267);
    expect(key1).not.toBe(key2);
  });
});

// ─── Duration bucketing boundary behaviour ─────────────────────────────────

describe('canonicalTrackKey — duration bucket boundaries', () => {
  it('rounds to the nearest 10-second bucket', () => {
    // 264 -> round(26.4) -> 26 -> 260s bucket; 268 -> round(26.8) -> 27 -> 270s bucket
    // Use values that unambiguously land in the SAME bucket for the positive case
    expect(canonicalTrackKey('Song', 'Artist', 261)).toBe(canonicalTrackKey('Song', 'Artist', 264));
    // 264 (bucket 260) vs 276 (bucket 280) — clearly different buckets
    expect(canonicalTrackKey('Song', 'Artist', 264)).not.toBe(canonicalTrackKey('Song', 'Artist', 276));
  });

  it('falls back to a shared 0s bucket when duration is missing/zero', () => {
    const key1 = canonicalTrackKey('Song', 'Artist', 0);
    const key2 = canonicalTrackKey('Song', 'Artist', NaN);
    expect(key1).toBe(key2);
    expect(key1).toContain('__0s');
  });

  it('falls back to a shared bucket for negative duration (defensive)', () => {
    const key = canonicalTrackKey('Song', 'Artist', -5);
    expect(key).toContain('__0s');
  });
});

// ─── Output format sanity ───────────────────────────────────────────────────

// ─── Degenerate input guard (found via manual audit, not the original test suite) ──

describe('canonicalTrackKey — degenerate/garbage input guard', () => {
  it('returns null for punctuation-only title and artist', () => {
    expect(canonicalTrackKey('!!!', '???', 200)).toBeNull();
  });

  it('THE BUG THAT WAS FOUND: two different garbage inputs no longer collide', () => {
    // Before the alnumCount guard was added, both of these produced the
    // identical key "____200s" — completely unrelated tracks would have
    // silently shared a Storage cache entry. Now both return null, forcing
    // the caller back to the (guaranteed-unique) raw trackId instead.
    const key1 = canonicalTrackKey('!!!', '???', 200);
    const key2 = canonicalTrackKey('###', '***', 203); // same duration bucket too
    expect(key1).toBeNull();
    expect(key2).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(canonicalTrackKey('', '', 200)).toBeNull();
  });

  it('returns null for whitespace-only strings', () => {
    expect(canonicalTrackKey('   ', '   ', 200)).toBeNull();
  });

  it('accepts a short but genuinely real title+artist (boundary case)', () => {
    // "aa" + "bb" = 4 alphanumeric chars, comfortably over the threshold —
    // short titles are real (e.g. some songs are literally one word),
    // this guard is only meant to catch punctuation-only garbage.
    const key = canonicalTrackKey('Aa', 'Bb', 200);
    expect(key).not.toBeNull();
    expect(key).toMatch(/^[a-z0-9_-]+$/);
  });

  it('accepts a single real word title with a longer artist name', () => {
    const key = canonicalTrackKey('Kesariya', 'Arijit Singh', 268);
    expect(key).not.toBeNull();
  });
});

describe('canonicalTrackKey — output format', () => {
  it('produces a Storage-path-safe string (matches the isValidTrackId regex)', () => {
    const key = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    expect(key).not.toBeNull();
    expect(key).toMatch(/^[a-z0-9_-]+$/);
  });

  it('never produces slashes even with unusual input', () => {
    const key = canonicalTrackKey('Song/Title', 'Artist/Name', 200);
    expect(key).not.toBeNull();
    expect(key).not.toContain('/');
  });

  it('never produces empty output for reasonable input', () => {
    const key = canonicalTrackKey('Tum Hi Ho', 'Arijit Singh', 267);
    expect(key).not.toBeNull();
    expect((key as string).length).toBeGreaterThan(0);
  });
});
