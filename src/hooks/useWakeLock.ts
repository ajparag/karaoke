// =============================================================================
// CHANGELOG
// v1 -- NEW. Prevents the screen from dimming/locking while singing, using
//   the standard Screen Wake Lock API (supported on Chrome/Edge/Safari on
//   Android and iOS 16.4+; gracefully no-ops on unsupported browsers).
//
// The wake lock is automatically released by the browser when the tab loses
// visibility (backgrounded, screen manually locked, etc.). This hook
// re-acquires it on 'visibilitychange' when the tab becomes visible again
// AND the caller still wants it held (e.g. song is still playing) -- this
// is the standard pattern recommended by the spec, since there's no way to
// prevent the OS-level auto-release while backgrounded.
// =============================================================================

import { useEffect, useRef } from "react";

export function useWakeLock(shouldHold: boolean) {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      return; // unsupported browser -- silent no-op
    }

    let cancelled = false;

    const acquire = async () => {
      if (!shouldHold || cancelled) return;
      try {
        // Release any stale lock before requesting a new one
        if (wakeLockRef.current) {
          try { await wakeLockRef.current.release(); } catch { /* ignore */ }
        }
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        console.log("[WakeLock] Acquired -- screen will stay on");
      } catch (e) {
        // Common causes: page not visible, battery saver mode, permissions
        // policy. Non-fatal -- singing still works, screen just may dim.
        console.warn("[WakeLock] Could not acquire:", (e as Error)?.message || e);
      }
    };

    const release = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
          console.log("[WakeLock] Released");
        } catch { /* ignore */ }
        wakeLockRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && shouldHold) {
        acquire();
      }
    };

    if (shouldHold) {
      acquire();
    } else {
      release();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      release();
    };
  }, [shouldHold]);
}
