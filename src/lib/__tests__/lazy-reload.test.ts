// =============================================================================
// lazyWithReload — unit tests
// =============================================================================
// Tests the core decision logic: on a chunk-load failure, reload exactly
// ONCE per session, never loop forever if the failure is something else
// (e.g. genuinely offline). The actual dynamic import() and
// window.location.reload() side effects can't be meaningfully unit tested
// without a real browser — this isolates the pure decision state machine
// that drives them.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Inlined, side-effect-free version of the state machine under test ────
// Mirrors lazyWithReload's try/catch logic in App.tsx, with the real
// dynamic import() and window.location.reload() replaced by injected
// functions so the whole thing is pure and testable.

interface LazyReloadDeps {
  loadModule: () => Promise<{ ok: true }>;
  getFlag: () => string | null;
  setFlag: () => void;
  clearFlag: () => void;
  triggerReload: () => void;
}

async function simulateLazyWithReload(deps: LazyReloadDeps): Promise<'loaded' | 'reloaded' | 'threw'> {
  try {
    await deps.loadModule();
    deps.clearFlag();
    return 'loaded';
  } catch {
    const alreadyReloaded = deps.getFlag();
    if (!alreadyReloaded) {
      deps.setFlag();
      deps.triggerReload();
      return 'reloaded';
    }
    return 'threw';
  }
}

// ─── Test harness ───────────────────────────────────────────────────────────

function makeMockStorage() {
  let value: string | null = null;
  return {
    getFlag: () => value,
    setFlag: () => { value = '1'; },
    clearFlag: () => { value = null; },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('lazyWithReload — chunk failure recovery', () => {
  it('reloads exactly once on the first chunk-load failure', async () => {
    const storage = makeMockStorage();
    const reloadFn = vi.fn();

    const result = await simulateLazyWithReload({
      loadModule: () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
      ...storage,
      triggerReload: reloadFn,
    });

    expect(result).toBe('reloaded');
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(storage.getFlag()).toBe('1');
  });

  it('does NOT reload a second time if the flag is already set (prevents infinite loop)', async () => {
    const storage = makeMockStorage();
    storage.setFlag(); // simulate: a reload was already attempted this session
    const reloadFn = vi.fn();

    const result = await simulateLazyWithReload({
      loadModule: () => Promise.reject(new Error('still failing — e.g. genuinely offline')),
      ...storage,
      triggerReload: reloadFn,
    });

    expect(result).toBe('threw');
    expect(reloadFn).not.toHaveBeenCalled();
  });

  it('clears the flag on a successful load (so a FUTURE deploy still gets one reload attempt)', async () => {
    const storage = makeMockStorage();
    storage.setFlag(); // left over from a previous successful reload-and-retry
    const reloadFn = vi.fn();

    const result = await simulateLazyWithReload({
      loadModule: () => Promise.resolve({ ok: true }),
      ...storage,
      triggerReload: reloadFn,
    });

    expect(result).toBe('loaded');
    expect(storage.getFlag()).toBeNull();
    expect(reloadFn).not.toHaveBeenCalled();
  });

  it('never calls reload on a successful load', async () => {
    const storage = makeMockStorage();
    const reloadFn = vi.fn();

    await simulateLazyWithReload({
      loadModule: () => Promise.resolve({ ok: true }),
      ...storage,
      triggerReload: reloadFn,
    });

    expect(reloadFn).not.toHaveBeenCalled();
  });

  it('the full realistic sequence: fail -> reload -> succeed -> flag cleared -> a later fail gets one more reload', async () => {
    const storage = makeMockStorage();
    const reloadFn = vi.fn();

    // 1. First page load after a deploy — stale chunk, fails
    const first = await simulateLazyWithReload({
      loadModule: () => Promise.reject(new Error('stale chunk')),
      ...storage,
      triggerReload: reloadFn,
    });
    expect(first).toBe('reloaded');

    // 2. Page reloads (simulated), now fetches the correct chunk — succeeds
    const second = await simulateLazyWithReload({
      loadModule: () => Promise.resolve({ ok: true }),
      ...storage,
      triggerReload: reloadFn,
    });
    expect(second).toBe('loaded');
    expect(storage.getFlag()).toBeNull(); // flag cleared after success

    // 3. Weeks later, ANOTHER deploy happens — should get its own fresh
    // reload attempt, not be blocked by the flag from step 1.
    const third = await simulateLazyWithReload({
      loadModule: () => Promise.reject(new Error('stale chunk again, new deploy')),
      ...storage,
      triggerReload: reloadFn,
    });
    expect(third).toBe('reloaded');
    expect(reloadFn).toHaveBeenCalledTimes(2); // once in step 1, once in step 3
  });
});
