// =============================================================================
// CHANGELOG
// =============================================================================
// v1 -- Browser downloaded audio from Saavn then uploaded to Modal.
// v2 -- Parallel warmup + download.
// v3 -- URL-direct: Modal fetches from Saavn CDN server-side (<1s).
//
// v4 -- CURRENT: Optimized streaming-only mode.
//   REMOVED: prefetchAudio (browser was downloading 4-5MB from Saavn for
//     no reason -- Modal downloads from CDN at datacenter speed).
//   REMOVED: getAudioBlob, downloadTrack, parseHFResult, normalizeGradioFileUrl,
//     audioPrefetchCache -- all dead code from the old blob-upload path.
//   REMOVED: IndexedDB cache references (streaming mode has no blobs to cache).
//   FIXED: warmup staleness -- re-pings Modal if >3 min since last warmup.
//     Previously hfSpaceWarmedUp=true was permanent, so if the container
//     went cold after idle timeout, warmup was silently skipped.
//   GPU: batch_size 32->64, overlap 0.1->0.025 (in modal_app.py).
//
// v5 -- CURRENT: Re-introduced IndexedDB caching, but as a pure fast-path
//   lookup only -- streaming mode is untouched and remains the default for
//   every first play. Before calling Modal, we check IndexedDB for a
//   previously-cached instrumental/vocals blob for this exact audioUrl.
//   Cache HIT -> instant playback via object URLs, zero Modal calls, zero
//   GPU cost. Cache MISS -> falls through to the normal streaming pipeline
//   exactly as before. The actual save-to-cache happens elsewhere (Sing.tsx,
//   only after the song has fully buffered) -- this file only ever reads
//   the cache, it does not write to it.
// =============================================================================

import { useState, useCallback, useRef } from 'react';
import { clearOldCache, getCachedTracks } from '@/lib/audioCache';
import { supabase } from '@/integrations/supabase/client';

interface SeparationResult {
  instrumentalUrl: string;
  vocalsUrl?: string;
  fromCache?: boolean;
}

// =============================================================================
// DIAGNOSTIC SYSTEM
// Run window.dumpSeparationDiagnostics() in browser console at any time.
// =============================================================================

type SepStageStatus = 'pending' | 'ok' | 'failed' | 'warning';
interface SepStageRecord { status: SepStageStatus; detail: string; ts: number; }

const SEP_STAGES = [
  'warmup',
  'separation',
  'result',
] as const;
type SepStage = typeof SEP_STAGES[number];

const sepStageTracker = new Map<SepStage, SepStageRecord>();
const sepEventLog: Array<{ ts: number; tag: string; msg: string }> = [];
const SEP_LOG_MAX = 100;

function sepStage(stage: SepStage, status: SepStageStatus, detail: string) {
  sepStageTracker.set(stage, { status, detail, ts: Date.now() });
}

function sepLog(tag: string, msg: string) {
  const entry = { ts: Date.now(), tag, msg };
  sepEventLog.push(entry);
  if (sepEventLog.length > SEP_LOG_MAX) sepEventLog.shift();
  console.log(`[${tag}] ${msg}`);
}

function sepWarn(tag: string, msg: string) {
  const entry = { ts: Date.now(), tag: `${tag}-WARN`, msg };
  sepEventLog.push(entry);
  if (sepEventLog.length > SEP_LOG_MAX) sepEventLog.shift();
  console.warn(`[${tag}] ${msg}`);
}

let _currentSepUrl: string | null = null;
let _currentSepStartTs: number | null = null;

function dumpSeparationDiagnostics() {
  const lines: string[] = [];
  lines.push('===========================================================');
  lines.push('VOCAL SEPARATION DIAGNOSTICS -- ' + new Date().toISOString());
  lines.push('===========================================================');

  lines.push('-- PIPELINE STAGES --');
  for (const stage of SEP_STAGES) {
    const rec = sepStageTracker.get(stage);
    if (!rec) {
      lines.push(`  [?] ${stage}: never reached`);
    } else {
      const icon = rec.status === 'ok' ? '[ok]' : rec.status === 'failed' ? '[x]'
        : rec.status === 'warning' ? '[!] ' : '[~]';
      const age = ((Date.now() - rec.ts) / 1000).toFixed(1);
      lines.push(`  ${icon} ${stage}: ${rec.detail} (${age}s ago)`);
    }
  }

  lines.push('-- CURRENT SESSION --');
  lines.push(`  audioUrl: ${_currentSepUrl ? _currentSepUrl.slice(0, 70) : 'none'}`);
  lines.push(`  elapsed: ${_currentSepStartTs ? ((Date.now() - _currentSepStartTs) / 1000).toFixed(1) + 's' : 'not running'}`);

  lines.push(`-- LAST ${Math.min(sepEventLog.length, 30)} EVENTS --`);
  for (const e of sepEventLog.slice(-30)) {
    const t = new Date(e.ts).toISOString().split('T')[1].replace('Z', '');
    lines.push(`  ${t} [${e.tag}] ${e.msg}`);
  }

  lines.push('===========================================================');
  const report = lines.join('');
  console.log(report);
  return report;
}

if (typeof window !== 'undefined') {
  (window as any).dumpSeparationDiagnostics = dumpSeparationDiagnostics;
}

// =============================================================================
// WARMUP
// =============================================================================

// Two-tier GPU deployment: FAST (A10G) for anything a live user is
// waiting on, BACKGROUND (T4, cheaper/slower) for silent pre-separation
// of queued party songs with minutes of buffer before they're needed.
const MODAL_URL_FAST = 'https://ajparag--vocal-separator-v3-vocalseparatorfast-ui.modal.run';
const MODAL_URL_BACKGROUND = 'https://ajparag--vocal-separator-v3-vocalseparatorbackground-ui.modal.run';
const MODAL_API_KEY = 'pa_audio_vWyst7iiPDutgJL5n2zksWxWhZNJRY32';

export type SeparationTier = 'fast' | 'background';
const WARMUP_STALE_MS = 1 * 60 * 1000; // re-ping if >1 min since last warmup

let lastWarmupTs = 0;
let warmUpPromise: Promise<void> | null = null;

interface InFlightSeparation {
  promise: Promise<SeparationResult | null>;
  tier: SeparationTier;
}
const separationPromiseCache = new Map<string, InFlightSeparation>();

export async function warmUpHFSpace(): Promise<void> {
  // Re-ping if warmup is stale (container may have gone cold after idle timeout)
  if (lastWarmupTs > 0 && Date.now() - lastWarmupTs < WARMUP_STALE_MS) return;
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    try {
      sepLog('WARMUP', 'Pinging Modal container via edge function');
      sepStage('warmup', 'pending', 'in progress');
      const start = Date.now();
      const { data } = await supabase.functions.invoke('separate-vocals', {
        body: { action: 'warmup' },
      });
      const ms = Date.now() - start;
      if (data?.ready) {
        lastWarmupTs = Date.now();
        sepLog('WARMUP', `Modal awake in ${ms}ms`);
        sepStage('warmup', 'ok', `awake in ${ms}ms`);
      } else {
        // Container is booting but model not loaded yet.
        // Still set timestamp so we don't spam warmup calls.
        lastWarmupTs = Date.now();
        sepStage('warmup', 'warning', `ready=false (${ms}ms) -- container may still be loading`);
      }
    } catch (err) {
      sepWarn('WARMUP', `failed: ${err}`);
      sepStage('warmup', 'warning', String(err));
    } finally {
      warmUpPromise = null;
    }
  })();

  return warmUpPromise;
}

// warmUpModal is the canonical name going forward.
// warmUpHFSpace kept as an alias for backward compatibility — both point to
// the same function. Rename callers to warmUpModal at your convenience;
// warmUpHFSpace will be removed in a future cleanup pass.
export const warmUpModal = warmUpHFSpace;

// =============================================================================
// SEPARATION HOOK
// =============================================================================

export function useVocalSeparation() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [separatedAudio, setSeparatedAudio] = useState<SeparationResult | null>(null);
  const [activeTier, setActiveTier] = useState<SeparationTier>('fast');
  const abortControllerRef = useRef<AbortController | null>(null);

  const separateVocals = useCallback(async (audioUrl: string, tier: SeparationTier = 'fast', trackId?: string): Promise<SeparationResult | null> => {
    // Cache key: use stable trackId if provided (survives URL expiry on refresh).
    // Falls back to audioUrl only when trackId is not available (e.g. Party Mode
    // background pre-separation where we may not have the track object).
    const cacheKey = trackId ?? audioUrl;
    setIsProcessing(true);
    setProgress('Checking cache...');
    setError(null);

    // Deduplicate FIRST, before any await (including the cache check).
    // This must happen synchronously relative to any other caller for the
    // SAME audioUrl -- e.g. Party Mode's background (T4) pre-separation of
    // the next queued song, and Sing.tsx's normal fast (A10G) call for
    // that same song once the host taps Play. If the dedup check ran
    // AFTER an awaited cache lookup (as it used to), both callers could
    // pass the empty check before either claimed the slot -- because the
    // await yields control back to the browser, letting a second call's
    // own cache-check run in the gap. Claiming the slot with zero awaits
    // in between closes that race: whichever call reaches this line first
    // wins and does the real work (cache check, then Modal if needed);
    // every other caller for the same URL just attaches to that one
    // shared result, regardless of which tier or page triggered it.
    const existing = separationPromiseCache.get(cacheKey);
    if (existing) {
      setActiveTier(existing.tier);
      setProgress('AI vocal separation in progress...');
      const result = await existing.promise;
      if (result) setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);
      return result;
    }

    setActiveTier(tier);
    let resolveShared!: (value: SeparationResult | null) => void;
    const shared = new Promise<SeparationResult | null>((resolve) => {
      resolveShared = resolve;
    });
    separationPromiseCache.set(cacheKey, { promise: shared, tier });
    abortControllerRef.current = new AbortController();

    try {
      // Cache check now happens INSIDE the claimed slot -- no one else can
      // Race past this, since they'd already have attached to `shared` above.
      try {
        // Try stable trackId key first (new format), then fall back to audioUrl
        // (old format — songs cached before the key migration). This ensures
        // songs cached under the old audioUrl key still hit the cache.
        let cached = await getCachedTracks(cacheKey);
        if (!cached && cacheKey !== audioUrl) {
          cached = await getCachedTracks(audioUrl);
          if (cached) {
            sepLog('CACHE', `IndexedDB HIT on legacy audioUrl key — will re-cache under trackId`);
          }
        }

        if (cached) {
          // Validate blob is non-empty before using it. A 0-byte or tiny blob
          // means the fetch was interrupted during caching — treat as a miss
          // and fall through to Modal to get fresh stems.
          const MIN_BLOB_SIZE = 10 * 1024; // 10KB minimum — any real audio file is larger
          if (cached.instrumentalBlob.size < MIN_BLOB_SIZE) {
            sepLog('CACHE', `IndexedDB entry corrupted (${cached.instrumentalBlob.size} bytes) — falling through to Modal`);
            // Non-fatal — just fall through to Modal, it will re-cache correctly after separation
          } else {
            sepLog('CACHE', `IndexedDB HIT (key: ${cacheKey.slice(0, 30)}, ${Math.round(cached.instrumentalBlob.size / 1024)}KB) -- skipping Modal`);
            const instrumentalUrl = URL.createObjectURL(cached.instrumentalBlob);
            const vocalsUrl = cached.vocalsBlob ? URL.createObjectURL(cached.vocalsBlob) : undefined;
            const result: SeparationResult = { instrumentalUrl, vocalsUrl, fromCache: true };
            setSeparatedAudio(result);
            setProgress('');
            setIsProcessing(false);
            resolveShared(result);
            return result;
          }
        }
      } catch (e) {
        console.warn('[VocalSeparation] Cache check failed (non-fatal, falling through to Modal):', e);
      }

      setProgress('Starting AI separation...');
      clearOldCache(7).catch(() => {});

      const t0 = Date.now();
      _currentSepUrl = audioUrl;
      _currentSepStartTs = t0;
      const elapsed = () => `+${Date.now() - t0}ms`;

      sepLog('SEP', `Separation started for: ${audioUrl.slice(0, 60)}`);
      sepStage('separation', 'pending', 'Modal downloading + GPU separating');

      // Call Modal /separate-by-url directly (browser -> Modal, CORS allowed
      // for karaokeparty.in). Modal downloads from Saavn CDN at datacenter
      // speed (~300ms) then runs GPU separation.
      setProgress('AI is separating vocals...');
      sepLog('SEP', `${elapsed()} Calling /separate-by-url...`);

      const modalUrl = tier === 'background' ? MODAL_URL_BACKGROUND : MODAL_URL_FAST;
      sepLog('SEP', `Using ${tier.toUpperCase()} tier (${tier === 'background' ? 'T4' : 'A10G'})`);

      const resp = await fetch(`${modalUrl}/separate-by-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': MODAL_API_KEY },
        body: JSON.stringify({ audio_url: audioUrl }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Separation failed: ${resp.status} ${errText.slice(0, 100)}`);
      }

      const json = await resp.json();
      const instUrl = json?.instrumental_url ? `${modalUrl}${json.instrumental_url}` : null;
      const vocUrl = json?.vocal_url ? `${modalUrl}${json.vocal_url}` : null;

      if (!instUrl) throw new Error('No instrumental URL returned');

      const secs = Math.round((Date.now() - t0) / 1000);
      sepLog('SEP', `${elapsed()} Done in ${secs}s (CDN download + GPU + streaming URLs)`);
      sepLog('SEP', `${elapsed()} Streaming mode -- returning Modal URLs`);
      sepStage('separation', 'ok', `done in ${secs}s`);
      sepStage('result', 'ok', 'streaming URLs ready');
      console.log('[VocalSeparation] Total time:', secs, 's');

      const result: SeparationResult = {
        instrumentalUrl: instUrl,
        vocalsUrl: vocUrl ?? undefined,
        fromCache: false,
      };

      setSeparatedAudio(result);
      setProgress('');
      setIsProcessing(false);
      _currentSepStartTs = null;

      resolveShared(result);
      return result;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[VocalSeparation] Error:', message, err);
      setError(message);
      setProgress('');
      setIsProcessing(false);
      resolveShared(null);
      return null;
    } finally {
      if (separationPromiseCache.get(cacheKey)?.promise === shared) {
        separationPromiseCache.delete(cacheKey);
      }
      abortControllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    setIsProcessing(false);
    setProgress('');
    setError(null);
    setSeparatedAudio(null);
  }, []);

  return { isProcessing, progress, error, separatedAudio, separateVocals, reset, activeTier };
}
