// =============================================================================
// VOCAL ACTIVITY ANALYZER
//
// Runs a one-time offline RMS scan over the fully-decoded vocals stem to
// build a precise map of "singer is singing" vs "instrumental gap" windows.
// This map is then used by the lyrics highlight renderer to compute how
// long each lyric line actually takes to sing -- instead of the naive
// "time until the next LRC timestamp" which crawls in slow motion across
// long instrumental gaps.
//
// Uses a HIGHER RMS threshold (0.08) than useVocalsComparison's real-time
// referenceActive detection (0.04) -- deliberately different, not a typo.
// Real-time scoring needs sensitivity (better to catch a quiet vocal
// passage than miss it); this offline highlight-timing pass needs
// selectivity (filtering out MDX vocal-separation bleed -- residual
// instrumental energy leaking into the vocals stem -- so highlights don't
// stretch into instrumental sections). See the RMS_THRESHOLD constant
// below for the full rationale.
//
// This runs ONCE per song, in the background, after the vocals stem URL
// is available. It decodes the full audio buffer (~3-5MB for a typical
// song) and scans it in ~50-100ms -- fast enough to be invisible to the
// user even on low-end phones.
// =============================================================================

export interface VocalInterval {
  start: number; // seconds
  end: number;   // seconds
}

const RMS_THRESHOLD = 0.08;       // higher than real-time scoring threshold (0.04) to filter
                                  // out MDX vocal-separation bleed (residual instrumental
                                  // energy that leaks into the vocals stem). Scoring needs
                                  // sensitivity; highlight timing needs selectivity.
const WINDOW_MS = 50;             // 50ms windows -- ~20 windows/second, good resolution
const MIN_SILENCE_GAP_MS = 500;   // gaps shorter than this are merged (breathing pauses,
                                  // brief bleed spikes that survive the higher threshold)

/**
 * Fetches and decodes the vocals stem, then scans it for vocal activity.
 * Returns an array of time intervals where the singer is actually singing.
 *
 * @param vocalsUrl - URL of the separated vocals FLAC/audio file
 * @returns Array of { start, end } intervals in seconds, or null on failure
 */
// Core analysis — accepts a pre-fetched ArrayBuffer.
// Used directly by Sing.tsx when the vocals blob is already in memory
// (avoids re-downloading a file that was just fetched for caching).
export async function analyzeVocalActivityFromBuffer(arrayBuffer: ArrayBuffer): Promise<VocalInterval[] | null> {
  try {
    console.log('[VocalAnalysis] Decoding audio buffer...', Math.round(arrayBuffer.byteLength / 1024), 'KB');

    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) {
      console.warn('[VocalAnalysis] No AudioContext available');
      return null;
    }

    const offlineCtx = new Ctx();
    const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
    offlineCtx.close().catch(() => {});

    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.round(sampleRate * WINDOW_MS / 1000);
    const minSilenceSamples = Math.round(sampleRate * MIN_SILENCE_GAP_MS / 1000);

    console.log('[VocalAnalysis] Scanning', audioBuffer.duration.toFixed(1), 's of audio at', sampleRate, 'Hz...');

    const windowCount = Math.ceil(channelData.length / windowSize);
    const isActive = new Uint8Array(windowCount);

    for (let w = 0; w < windowCount; w++) {
      const start = w * windowSize;
      const end = Math.min(start + windowSize, channelData.length);
      let sumSq = 0;
      for (let j = start; j < end; j++) {
        sumSq += channelData[j] * channelData[j];
      }
      const rms = Math.sqrt(sumSq / (end - start));
      isActive[w] = rms > RMS_THRESHOLD ? 1 : 0;
    }

    // Pass 2: merge short silence gaps (< MIN_SILENCE_GAP_MS) into the
    // surrounding active regions -- these are breathing pauses within a
    // phrase, not genuine instrumental gaps.
    const minSilenceWindows = Math.ceil(minSilenceSamples / windowSize);
    for (let w = 0; w < windowCount; w++) {
      if (isActive[w] === 0) {
        // Count how long this silence run is
        let silenceLen = 0;
        while (w + silenceLen < windowCount && isActive[w + silenceLen] === 0) silenceLen++;
        if (silenceLen < minSilenceWindows) {
          // Too short to be a real gap -- fill it in
          for (let j = 0; j < silenceLen; j++) isActive[w + j] = 1;
        }
        w += Math.max(0, silenceLen - 1); // skip ahead
      }
    }

    // Pass 3: extract contiguous active intervals
    const intervals: VocalInterval[] = [];
    let inActive = false;
    let currentStart = 0;

    for (let w = 0; w < windowCount; w++) {
      const timeSec = (w * windowSize) / sampleRate;
      if (isActive[w] && !inActive) {
        currentStart = timeSec;
        inActive = true;
      } else if (!isActive[w] && inActive) {
        intervals.push({ start: currentStart, end: timeSec });
        inActive = false;
      }
    }
    if (inActive) {
      intervals.push({ start: currentStart, end: channelData.length / sampleRate });
    }

    console.log('[VocalAnalysis] Found', intervals.length, 'vocal activity intervals in',
      audioBuffer.duration.toFixed(1), 's of audio');

    return intervals;
  } catch (e) {
    console.warn('[VocalAnalysis] Analysis failed (non-fatal, highlight will use fallback):', e);
    return null;
  }
}

// URL-based wrapper — fetches the vocals stem then delegates to the buffer-based function.
// Used as a fallback when the vocals blob isn't already in memory
// (e.g. when playing from IndexedDB cache where we didn't re-fetch).
export async function analyzeVocalActivity(vocalsUrl: string): Promise<VocalInterval[] | null> {
  try {
    console.log('[VocalAnalysis] Fetching vocals stem for offline analysis...');
    const resp = await fetch(vocalsUrl);
    if (!resp.ok) { console.warn('[VocalAnalysis] Fetch failed:', resp.status); return null; }
    const arrayBuffer = await resp.arrayBuffer();
    return analyzeVocalActivityFromBuffer(arrayBuffer);
  } catch (e) {
    console.warn('[VocalAnalysis] Fetch failed (non-fatal):', e);
    return null;
  }
}

/**
 * Given a lyric line's start time, finds the actual end of singing for that
 * line by looking at where the vocals go silent in the activity map.
 *
 * KEY INSIGHT: we want the end of the FIRST contiguous vocal phrase that
 * starts at/near this line's timestamp -- NOT the end of ALL vocal activity
 * before the next LRC line. Within a single LRC line's time window there
 * may be MULTIPLE separate vocal phrases (the singer finishes this line,
 * there's an instrumental break, then starts the next phrase before the
 * next LRC timestamp arrives). The highlight should finish after the FIRST
 * phrase, not stretch across all of them.
 *
 * "Contiguous" means vocal intervals separated by less than PHRASE_GAP_MS
 * are treated as part of the same phrase (accounts for brief breathing
 * pauses mid-line that the RMS analysis kept as separate intervals).
 *
 * @param lineStart - LRC timestamp (seconds) where this line begins
 * @param nextLineStart - LRC timestamp of the next line (or null if last line)
 * @param intervals - vocal activity intervals from analyzeVocalActivity()
 * @param fallbackDuration - duration to use if no interval matches
 * @returns effective singing duration in seconds for this line
 */
const PHRASE_GAP_S = 1.5; // gaps > 1.5s between intervals = separate phrases

export function getLineSingingDuration(
  lineStart: number,
  nextLineStart: number | null,
  intervals: VocalInterval[],
  fallbackDuration: number,
): number {
  const maxEnd = nextLineStart ?? lineStart + fallbackDuration;

  // Find the first interval that overlaps with or starts near lineStart.
  // "Near" means within 0.5s after lineStart (LRC timestamps can be
  // slightly early relative to the actual vocal onset).
  let firstIdx = -1;
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i];
    if (iv.end <= lineStart) continue;      // entirely before this line
    if (iv.start >= maxEnd) break;          // entirely after this line's window
    firstIdx = i;
    break;
  }

  if (firstIdx === -1) {
    // No vocal activity found in this line's window at all.
    // Use a short fallback so the highlight doesn't crawl.
    const maxDuration = (nextLineStart ?? lineStart + fallbackDuration) - lineStart;
    return Math.min(Math.max(0.5, fallbackDuration * 0.3), maxDuration);
  }

  // Walk forward through consecutive intervals that are part of the SAME
  // phrase (separated by less than PHRASE_GAP_S). Stop at the first real
  // silence gap -- that's where a different phrase begins.
  let phraseEnd = intervals[firstIdx].end;
  for (let i = firstIdx + 1; i < intervals.length; i++) {
    const iv = intervals[i];
    if (iv.start >= maxEnd) break;          // past this line's window
    if (iv.start - phraseEnd > PHRASE_GAP_S) break; // real gap = new phrase
    phraseEnd = iv.end;
  }

  // Effective duration: from lineStart to where this phrase actually ends,
  // with a small buffer (0.3s) so the highlight doesn't cut off abruptly.
  const duration = Math.min(phraseEnd, maxEnd) - lineStart + 0.3;

  // Clamp: at least 0.5s, never longer than the full gap to the next line.
  const maxDuration = (nextLineStart ?? lineStart + fallbackDuration) - lineStart;
  return Math.max(0.5, Math.min(duration, maxDuration));
}
