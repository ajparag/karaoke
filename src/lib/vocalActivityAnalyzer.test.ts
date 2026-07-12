// =============================================================================
// CHANGELOG
// v1 -- NEW. getLineSingingDuration is the fix for the real "Phir Mohabbat"
//   bug diagnosed earlier this session: a lyric line's highlight was
//   crawling in slow motion across an instrumental break because the OLD
//   logic used the end of the LAST vocal activity before the next LRC
//   line, instead of the end of the FIRST phrase. These tests lock in
//   that fixed behavior permanently.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { getLineSingingDuration, type VocalInterval } from './vocalActivityAnalyzer';

describe('getLineSingingDuration', () => {
  it('"Phir Mohabbat" case: uses the FIRST phrase, not the last vocal activity before the next line', () => {
    // Line starts at 100s. Singer sings 100-104s, goes silent for an
    // instrumental break, then a DIFFERENT phrase (still technically
    // within this line's window) starts at 108s. Next LRC line at 115s.
    // Old buggy behavior: used the end of the LAST interval (112) as the
    // duration end, producing a ~12s crawl. Correct: should end shortly
    // after 104s (the actual end of THIS line's phrase).
    const intervals: VocalInterval[] = [
      { start: 100, end: 104 },
      { start: 108, end: 112 },
    ];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    // Should land near (104 - 100 + 0.3) = 4.3s, NOT anywhere near 12s.
    expect(duration).toBeCloseTo(4.3, 1);
    expect(duration).toBeLessThan(6);
  });

  it('merges intervals within the phrase gap (breathing pauses) into one phrase', () => {
    // Two intervals close together (1s gap, under the 1.5s phrase-gap
    // threshold) should be treated as ONE continuous phrase.
    const intervals: VocalInterval[] = [
      { start: 100, end: 102 },
      { start: 103, end: 105 }, // only 1s gap -- same phrase
    ];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    // Should extend through the second interval's end (105), not stop at 102.
    expect(duration).toBeCloseTo(5.3, 1);
  });

  it('splits into separate phrases when the gap exceeds 1.5s', () => {
    const intervals: VocalInterval[] = [
      { start: 100, end: 102 },
      { start: 104, end: 106 }, // 2s gap -- exceeds the 1.5s threshold
    ];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    // Should stop at the end of the FIRST phrase only (102), not extend
    // into the second one.
    expect(duration).toBeCloseTo(2.3, 1);
  });

  it('falls back to a short duration when no vocal activity is found at all', () => {
    const intervals: VocalInterval[] = [];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    // fallbackDuration * 0.3 = 4.5s, clamped within [0.5, maxDuration]
    expect(duration).toBeCloseTo(4.5, 1);
  });

  it('never returns less than 0.5s even for a very short phrase', () => {
    const intervals: VocalInterval[] = [{ start: 100, end: 100.05 }];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    expect(duration).toBeGreaterThanOrEqual(0.5);
  });

  it('never exceeds the gap to the next line', () => {
    // Phrase runs long, right up against (and past) the next line's start.
    const intervals: VocalInterval[] = [{ start: 100, end: 130 }];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    expect(duration).toBeLessThanOrEqual(15); // 115 - 100
  });

  it('handles the last line (no next line) using fallbackDuration as the window', () => {
    const intervals: VocalInterval[] = [{ start: 100, end: 104 }];
    const duration = getLineSingingDuration(100, null, intervals, 10);
    expect(duration).toBeCloseTo(4.3, 1);
  });

  it('ignores vocal activity entirely before this line starts', () => {
    const intervals: VocalInterval[] = [
      { start: 90, end: 95 },   // before this line -- irrelevant
      { start: 101, end: 103 }, // this line's actual phrase
    ];
    const duration = getLineSingingDuration(100, 115, intervals, 15);
    expect(duration).toBeCloseTo(3.3, 1);
  });
});
