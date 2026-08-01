// =============================================================================
// CHANGELOG
// =============================================================================
// v1-v5 -- Streaming mode: browser called Modal's /separate-by-url directly.
//   MODAL_API_KEY was hardcoded in this client-side file -- visible to
//   anyone via dev tools or view-source. Each browser also cached results
//   locally in IndexedDB, so the same song got separated by Modal's GPU
//   once per unique device, even for songs thousands of people had already
//   sung.
//
// v6 -- CURRENT: All separation now goes through the `separate-vocals`
//   Supabase Edge Function. This file no longer talks to Modal at all, and
//   no longer touches IndexedDB.
//   - Modal's API key lives only in the edge function now.
//   - The edge function checks Supabase Storage (a GLOBAL cache shared by
//     every user, not per-browser) before calling Modal. First person to
//     sing a song pays the GPU cost; everyone after gets an instant public
//     Storage URL back.
//   - REMOVED: getCachedTracks/clearOldCache imports (audioCache.ts is no
//     longer used by this file -- caching is now server-side).
//   - REMOVED: MODAL_URL_FAST/MODAL_URL_BACKGROUND/MODAL_API_KEY constants.
//   - The in-flight promise dedup cache (separationPromiseCache) is KEPT --
//     it still matters for preventing duplicate simultaneous edge function
//     calls from the same browser tab (e.g. a party host singing while
//     background pre-separation races for the same track).
// =============================================================================

import { useState, useCallback, useRef } from 'react';
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
// Still goes through the edge function's "warmup" action -- unchanged from
// before, this never exposed the API key client-side to begin with.

export type SeparationTier = 'fast' | 'background';
const WARMUP_STALE_MS = 1 * 60 * 1000; // re-ping if >1 min since last warmup

let lastWarmupTs = 0;
let warmUpPromise: Promise<void> | null = null;

interface InFlightSeparation {
  promise: Promise<SeparationResult | null>;
  tier: SeparationTier;
}
const separationPromiseCache = new Map<string, InFlightSeparation>();

export async function warmUpModal(): Promise<void> {
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
    // trackId is required now -- it's the Storage cache key server-side.
    // Falls back to a hash-free slice of audioUrl only in the unlikely case
    // a caller doesn't have one yet, but every real call site passes it.
    const cacheKey = trackId ?? audioUrl;
    setIsProcessing(true);
    setProgress('Starting AI separation...');
    setError(null);

    // Deduplicate FIRST, before any await. Same rationale as before: two
    // callers for the same track (e.g. party pre-separation + the singer's
    // own Play tap) must share one in-flight edge function call, not fire
    // two separate ones.
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
      const t0 = Date.now();
      _currentSepUrl = audioUrl;
      _currentSepStartTs = t0;
      const elapsed = () => `+${Date.now() - t0}ms`;

      sepLog('SEP', `Separation requested for: ${audioUrl.slice(0, 60)}`);
      sepStage('separation', 'pending', 'edge function checking Storage cache / calling Modal');
      sepLog('SEP', `Using ${tier.toUpperCase()} tier`);

      // Single call to the edge function. It internally checks the global
      // Storage cache first, and only calls Modal on a genuine miss --
      // this hook has no visibility into (or need to know) which happened.
      const { data, error: fnError } = await supabase.functions.invoke('separate-vocals', {
        body: { action: 'separate', audioUrl, trackId: cacheKey, tier },
      });

      if (fnError) throw new Error(fnError.message || 'Separation request failed');
      if (data?.error) throw new Error(data.error);
      if (!data?.instrumentalUrl) throw new Error('No instrumental URL returned');

      const secs = Math.round((Date.now() - t0) / 1000);
      sepLog('SEP', `${elapsed()} Done in ${secs}s (fromCache: ${!!data.fromCache})`);
      sepStage('separation', 'ok', `done in ${secs}s${data.fromCache ? ' (Storage cache hit)' : ' (fresh Modal separation)'}`);
      sepStage('result', 'ok', 'Storage URLs ready');
      console.log('[VocalSeparation] Total time:', secs, 's', data.fromCache ? '(cached)' : '(fresh)');

      const result: SeparationResult = {
        instrumentalUrl: data.instrumentalUrl,
        vocalsUrl: data.vocalsUrl ?? undefined,
        fromCache: !!data.fromCache,
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
