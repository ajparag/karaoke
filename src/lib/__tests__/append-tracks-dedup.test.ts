// =============================================================================
// appendTracks dedup logic — unit tests
// =============================================================================
// Tests the merge logic used when JioSaavn/Gaana/YouTube results arrive
// independently and get appended to a growing list. The two things that
// must hold: (1) duplicate IDs across separate append calls never produce
// duplicate rows on screen, (2) earlier-arriving results are never
// reordered or replaced by later ones — they only ever get appended after.
// =============================================================================

import { describe, it, expect } from 'vitest';

interface Track {
  id: string;
  title: string;
  source: 'saavn' | 'youtube';
}

// ─── Inlined copy of the append logic under test ───────────────────────────
// Mirrors appendTracks() in Index.tsx's searchWithQuery, minus the React
// state plumbing (setTracks/setIsLoading) which isn't unit-testable without
// a full component render.

function createTrackAccumulator() {
  const seenIds = new Set<string>();
  let allTracks: Track[] = [];

  const append = (newTracks: Track[]): Track[] => {
    const filtered = newTracks.filter(t => !seenIds.has(t.id));
    filtered.forEach(t => seenIds.add(t.id));
    if (filtered.length > 0) {
      allTracks = [...allTracks, ...filtered];
    }
    return allTracks;
  };

  return { append, getTracks: () => allTracks };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function t(id: string, source: Track['source'] = 'saavn'): Track {
  return { id, title: `Song ${id}`, source };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('progressive append accumulator', () => {
  it('appends results from a single source', () => {
    const acc = createTrackAccumulator();
    acc.append([t('a'), t('b')]);
    expect(acc.getTracks().map(x => x.id)).toEqual(['a', 'b']);
  });

  it('appends results from multiple sources in arrival order', () => {
    const acc = createTrackAccumulator();
    acc.append([t('a'), t('b')]);          // JioSaavn arrives first
    acc.append([t('c'), t('d')], );        // Gaana arrives second
    expect(acc.getTracks().map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does NOT reorder already-shown results when a later batch arrives', () => {
    const acc = createTrackAccumulator();
    acc.append([t('a'), t('b')]);
    const before = acc.getTracks().map(x => x.id);
    acc.append([t('c')]);
    // The first two positions must be exactly what they were before —
    // never re-sorted or replaced by the later batch.
    expect(acc.getTracks().slice(0, 2).map(x => x.id)).toEqual(before);
  });

  it('drops IDs that already appeared in an earlier batch (cross-source dedup)', () => {
    const acc = createTrackAccumulator();
    acc.append([t('shared-id', 'saavn'), t('unique-a')]);
    acc.append([t('shared-id', 'youtube'), t('unique-b')]); // same id, different source
    const ids = acc.getTracks().map(x => x.id);
    expect(ids).toEqual(['shared-id', 'unique-a', 'unique-b']);
    expect(ids.filter(id => id === 'shared-id')).toHaveLength(1);
  });

  it('keeps the FIRST version of a duplicate ID, not the later one', () => {
    const acc = createTrackAccumulator();
    acc.append([{ id: 'x', title: 'First arrival', source: 'saavn' }]);
    acc.append([{ id: 'x', title: 'Second arrival', source: 'youtube' }]);
    expect(acc.getTracks()[0].title).toBe('First arrival');
  });

  it('handles an empty batch without changing the list', () => {
    const acc = createTrackAccumulator();
    acc.append([t('a')]);
    acc.append([]);
    expect(acc.getTracks().map(x => x.id)).toEqual(['a']);
  });

  it('handles three sequential batches (JioSaavn, Gaana, YouTube fallback)', () => {
    const acc = createTrackAccumulator();
    acc.append([t('js1'), t('js2')]);   // JioSaavn
    acc.append([t('ga1')]);              // Gaana
    acc.append([t('yt1'), t('yt2')]);    // YouTube fallback
    expect(acc.getTracks().map(x => x.id)).toEqual(['js1', 'js2', 'ga1', 'yt1', 'yt2']);
  });

  it('handles the case where a source returns zero results', () => {
    const acc = createTrackAccumulator();
    acc.append([]); // JioSaavn found nothing
    acc.append([t('ga1'), t('ga2')]); // Gaana found some
    expect(acc.getTracks().map(x => x.id)).toEqual(['ga1', 'ga2']);
  });
});
