// Pure DSP + scoring helpers extracted from useVocalsComparison.
// These are deterministic and unit-testable (no Web Audio dependencies).
//
// SCORING PHILOSOPHY (v2):
// Purely additive — no penalties anywhere. Silence earns 0, not negative.
// Scores reflect what the singer DID, not what they failed to do.
// Three pillars:
//   Accuracy   — pitch match on voiced frames (0-100 per frame)
//   Flow       — onset timing match, no extra-onset penalty
//   Expression — pitch stability on sustained notes (replaces energy smoothness)

export const SILENCE_RMS = 0.015;
export const PITCH_TOLERANCE_CENTS = 100; // 1 semitone
export const ONSET_WINDOW_MS = 400; // piecewise credit: 100% at 0ms, 50% at 200ms, 10% at 400ms

/** RMS from Float32 time-domain samples. */
export function rmsFloat(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / data.length);
}

/** Average linear energy from a dB-scale float array (0..1). */
export function dbEnergy(data: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    s += Math.pow(10, v / 20);
    n++;
  }
  return n > 0 ? Math.min(1, s / n) : 0;
}

/**
 * Autocorrelation pitch detection — proper YIN algorithm (de Cheveigné & Kawahara 2002).
 * Returns Hz or 0 if silent / unpitched.
 */
export function detectPitchAC(samples: Float32Array, sampleRate: number): number {
  const len = samples.length;

  let sumSq = 0;
  for (let i = 0; i < len; i++) sumSq += samples[i] * samples[i];
  if (Math.sqrt(sumSq / len) < SILENCE_RMS) return 0;

  const minLag = Math.floor(sampleRate / 1050);
  const maxLag = Math.floor(sampleRate / 60);

  const sdf = new Float32Array(maxLag + 1);
  sdf[0] = 0;

  let runningSum = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let diff = 0;
    for (let i = 0; i < len - lag; i++) {
      const d = samples[i] - samples[i + lag];
      diff += d * d;
    }
    runningSum += diff;
    sdf[lag] = runningSum > 0 ? (diff * lag) / runningSum : 1;
  }

  const THRESHOLD = 0.10;
  let pickedLag = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    if (sdf[lag] < THRESHOLD) {
      while (lag + 1 <= maxLag && sdf[lag + 1] < sdf[lag]) lag++;
      pickedLag = lag;
      break;
    }
  }

  if (pickedLag < 0) {
    let best = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (sdf[lag] < best) { best = sdf[lag]; pickedLag = lag; }
    }
    if (best > 0.5) return 0;
  }

  if (pickedLag < 0) return 0;

  let refined = pickedLag;
  if (pickedLag > minLag && pickedLag < maxLag) {
    const alpha = sdf[pickedLag - 1];
    const beta  = sdf[pickedLag];
    const gamma = sdf[pickedLag + 1];
    const denom = alpha - 2 * beta + gamma;
    if (denom !== 0) refined += 0.5 * (alpha - gamma) / denom;
  }

  return sampleRate / refined;
}

/**
 * Cents difference with octave folding.
 * Singing the correct note in any octave scores 0 cents — essential for
 * karaoke where casual singers naturally sing an octave above/below.
 */
export function centsDiff(hz1: number, hz2: number): number {
  if (hz1 <= 0 || hz2 <= 0) return Infinity;
  const raw = Math.abs(1200 * Math.log2(hz1 / hz2));
  const folded = raw % 1200;
  return folded > 600 ? 1200 - folded : folded;
}

export function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/**
 * PILLAR 1 — ACCURACY
 * Pitch score for a single voiced frame where the reference is singing.
 * Only called when userVoiceDetected=true AND userPitch > 0.
 * Silence and undetected pitch are handled by the caller (scored as 0, not negative).
 * Returns 0..100.
 */
export function scorePitchFrame(
  userPitchHz: number,
  refPitchHz: number,
  tolerance = PITCH_TOLERANCE_CENTS,
): number {
  const cents = centsDiff(userPitchHz, refPitchHz);
  if (cents <= tolerance) {
    return 85 + (1 - cents / tolerance) * 15;      // 85..100 — within 1 semitone
  }
  if (cents <= tolerance * 2) {
    return 45 + (1 - (cents - tolerance) / tolerance) * 40; // 45..85 — 1-2 semitones
  }
  if (cents <= tolerance * 4) {
    return 10 + (1 - (cents - tolerance * 2) / (tolerance * 2)) * 35; // 10..45 — 2-4 semitones
  }
  return 5; // beyond 4 semitones — wrong note, minimal credit
}

/**
 * PILLAR 2 — FLOW
 * Onset timing match between user and reference syllables.
 * No penalty for extra onsets — karaoke users naturally add ornaments.
 * Returns 0..100.
 */
export function scoreRhythm(
  userOnsets: number[],
  refOnsets: number[],
  tolerance = ONSET_WINDOW_MS,
): number {
  // No reference onsets = nothing to match = perfect flow by default
  if (refOnsets.length === 0) return 100;
  // User sang nothing = zero flow
  if (userOnsets.length === 0) return 0;

  let matched = 0;
  const used = new Set<number>();

  for (const ro of refOnsets) {
    let best = Infinity;
    let bestI = -1;
    for (let i = 0; i < userOnsets.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(userOnsets[i] - ro);
      if (d < best) { best = d; bestI = i; }
    }
    if (best <= tolerance && bestI >= 0) {
      // Piecewise credit: 100% at 0ms, 50% at 200ms, 10% at 400ms
      let credit: number;
      if (best <= 200) {
        credit = 1 - (best / 200) * 0.5;
      } else {
        credit = 0.5 - ((best - 200) / 200) * 0.4;
      }
      matched += credit;
      used.add(bestI);
    }
  }

  // No extra onset penalty — user ornaments and filler syllables are fine
  return clamp100((matched / refOnsets.length) * 100);
}

/**
 * PILLAR 3 — EXPRESSION
 * Pitch stability on sustained voiced notes.
 * Measures: how steady is the user's pitch when they're singing?
 * Low variance = confident, controlled delivery = high expression.
 * High variance = shaky, nervous singing = low expression.
 *
 * Also includes sustain ratio — did the user sing when the reference was singing?
 * sustainRatio 60% + pitchStability 40%.
 *
 * pitchHistory: rolling buffer of recent userPitch values (Hz), 0 = unvoiced frame
 * refEnergy: rolling buffer of reference RMS energy values
 * Returns 0..100.
 */
export function scoreExpression(
  pitchHistory: number[],
  refEnergy: number[],
  silenceRms = SILENCE_RMS,
): number {
  if (pitchHistory.length < 5 || refEnergy.length < 5) return 0;

  // Sustain ratio: how many frames did user sing vs reference singing
  const refActive = refEnergy.filter(v => v > silenceRms).length;
  const userVoiced = pitchHistory.filter(p => p > 0).length;
  const sustainRatio = refActive > 0 ? Math.min(1, userVoiced / refActive) : 0;

  // Pitch stability: standard deviation of pitch on voiced frames
  // Convert Hz to cents relative to median to make it scale-invariant
  // (wobble of 20 cents around 200Hz is the same severity as around 400Hz)
  const voicedPitches = pitchHistory.filter(p => p > 0);
  if (voicedPitches.length < 3) {
    // Not enough voiced frames to measure stability — score on sustain only
    return clamp100(sustainRatio * 60);
  }

  // Median pitch (robust to outliers)
  const sorted = [...voicedPitches].sort((a, b) => a - b);
  const medianHz = sorted[Math.floor(sorted.length / 2)];

  // Convert each voiced pitch to cents relative to median
  const centsFromMedian = voicedPitches.map(p => {
    if (medianHz <= 0) return 0;
    return Math.abs(1200 * Math.log2(p / medianHz));
  });

  // Mean absolute deviation in cents
  const mad = centsFromMedian.reduce((s, c) => s + c, 0) / centsFromMedian.length;

  // Stability score: 0 cents deviation = 100, 200 cents deviation = 0
  // 200 cents = 2 semitones of average wobble — clearly unstable
  const pitchStability = clamp100(100 - (mad / 200) * 100);

  return clamp100(sustainRatio * 60 + pitchStability * 0.4);
}

/** Generate a sine wave Float32 buffer — handy for tests. */
export function sineBuffer(hz: number, sampleRate: number, length: number, amp = 0.5): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < length; i++) out[i] = amp * Math.sin(w * i);
  return out;
}
