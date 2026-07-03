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
// Reuses the same RMS threshold (0.04) that useVocalsComparison uses for
// its real-time referenceActive detection, so the two are consistent.
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
export async function analyzeVocalActivity(vocalsUrl: string): Promise<VocalInterval[] | null> {
  try {
    console.log('[VocalAnalysis] Fetching vocals stem for offline analysis...');
    const resp = await fetch(vocalsUrl);
    if (!resp.ok) {
      console.warn('[VocalAnalysis] Fetch failed:', resp.status);
      return null;
    }

    const arrayBuffer = await resp.arrayBuffer();
    console.log('[VocalAnalysis] Decoding audio buffer...', Math.round(arrayBuffer.byteLength / 1024), 'KB');

    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) {
      console.warn('[VocalAnalysis] No AudioContext available');
      return null;
    }

    const offlineCtx = new Ctx();
    const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
    offlineCtx.close().catch(() => {});

    const channelData = audioBuffer.getChannelData(0); // mono or first channel
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.round(sampleRate * WINDOW_MS / 1000);
    const minSilenceSamples = Math.round(sampleRate * MIN_SILENCE_GAP_MS / 1000);

    console.log('[VocalAnalysis] Scanning', audioBuffer.duration.toFixed(1), 's of audio at', sampleRate, 'Hz...');

    // Pass 1: compute RMS for each window and mark as active/silent
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

/**
 * Given a lyric line's start time, finds the actual end of singing for that
 * line by looking at where the vocals go silent in the activity map.
 *
 * @param lineStart - LRC timestamp (seconds) where this line begins
 * @param nextLineStart - LRC timestamp of the next line (or null if last line)
 * @param intervals - vocal activity intervals from analyzeVocalActivity()
 * @param fallbackDuration - duration to use if no interval matches (current LRC gap-based estimate)
 * @returns effective singing duration in seconds for this line
 */
export function getLineSingingDuration(
  lineStart: number,
  nextLineStart: number | null,
  intervals: VocalInterval[],
  fallbackDuration: number,
): number {
  // Find all intervals that overlap with [lineStart, nextLineStart)
  const maxEnd = nextLineStart ?? lineStart + fallbackDuration;

  let lastVocalEnd = lineStart;
  for (const iv of intervals) {
    if (iv.end <= lineStart) continue;     // entirely before this line
    if (iv.start >= maxEnd) break;         // entirely after this line's window
    // This interval overlaps with the line's window
    lastVocalEnd = Math.min(iv.end, maxEnd);
  }

  // The effective duration is from lineStart to where vocals actually stop,
  // with a small buffer (0.3s) so the highlight doesn't cut off abruptly
  // at the exact last sample of audio energy.
  const duration = lastVocalEnd - lineStart + 0.3;

  // Clamp: at least 0.5s (even a very short phrase needs visible highlight
  // time), and never longer than the full gap to the next line.
  const maxDuration = (nextLineStart ?? lineStart + fallbackDuration) - lineStart;
  return Math.max(0.5, Math.min(duration, maxDuration));
}
