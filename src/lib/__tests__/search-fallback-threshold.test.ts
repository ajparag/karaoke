// =============================================================================
// Two-tier search fallback — unit tests
// =============================================================================
// Tests the new decision logic added to search-music/index.ts: JioSaavn +
// Gaana always run in parallel (Tier 1); YouTube only runs as a fallback
// (Tier 2) when Tier 1's combined result count is thin. This is the exact
// threshold check that determines whether a search pays YouTube's extra
// latency or not.
// =============================================================================

import { describe, it, expect } from 'vitest';

// ─── Inlined copy of the decision logic under test ─────────────────────────

function shouldFallbackToYouTube(tier1CombinedCount: number, threshold = 5): boolean {
  return tier1CombinedCount < threshold;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('shouldFallbackToYouTube', () => {
  it('falls back when Tier 1 returns zero results', () => {
    expect(shouldFallbackToYouTube(0)).toBe(true);
  });

  it('falls back when Tier 1 returns fewer than the threshold', () => {
    expect(shouldFallbackToYouTube(1)).toBe(true);
    expect(shouldFallbackToYouTube(4)).toBe(true);
  });

  it('does NOT fall back when Tier 1 exactly meets the threshold', () => {
    expect(shouldFallbackToYouTube(5)).toBe(false);
  });

  it('does NOT fall back when Tier 1 comfortably exceeds the threshold', () => {
    expect(shouldFallbackToYouTube(20)).toBe(false);
    expect(shouldFallbackToYouTube(100)).toBe(false);
  });

  it('respects a custom threshold if one is passed', () => {
    expect(shouldFallbackToYouTube(8, 10)).toBe(true);
    expect(shouldFallbackToYouTube(10, 10)).toBe(false);
  });

  it('treats a negative count as falling back (defensive — should never occur in practice)', () => {
    expect(shouldFallbackToYouTube(-1)).toBe(true);
  });
});
