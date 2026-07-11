// =============================================================================
// CHANGELOG
// v1 -- Initial implementation.
//   Intercepts the hardware/browser/gesture back button (not just an in-app
//   back arrow) using the standard SPA "history guard" trick:
//     1. On mount, push one extra dummy history entry.
//     2. When popstate fires (back was pressed), immediately re-push the
//        dummy entry (cancelling the navigation from the browser's view)
//        and hand control to the caller via onBackAttempt(confirmLeave).
//     3. The caller decides: show a confirmation UI, or call confirmLeave()
//        immediately to actually exit (which unwinds all the dummy entries
//        pushed so far in one go).
//   Does NOT cover tab close / refresh -- pair with a separate
//   `beforeunload` listener for that (popstate never fires on those).
// =============================================================================

import { useEffect, useRef } from "react";

/**
 * onBackAttempt is called every time the user presses back (hardware,
 * gesture, or browser button) while this hook is mounted. It receives a
 * `confirmLeave` callback -- call it to actually let the user leave;
 * do nothing (or show a dialog) to keep them on the page.
 */
export function useBackGuard(onBackAttempt: (confirmLeave: () => void) => void) {
  const callbackRef = useRef(onBackAttempt);
  callbackRef.current = onBackAttempt; // always read the latest closure, no re-registration needed

  useEffect(() => {
    window.history.pushState(null, "", window.location.href);

    const confirmLeave = () => {
      window.removeEventListener("popstate", handler);
      // Real history depth from the previous page is ALWAYS exactly 2
      // (the original navigation entry to this page, plus the one dummy
      // sitting on top of it) -- no matter how many times the user has
      // pressed back. Each back-press's re-push below REPLACES the top
      // of the stack rather than growing it (pushState always truncates
      // anything after the current position and inserts fresh) -- so the
      // distance back to the previous page never actually changes.
      //
      // BUG FIXED: this used to be a counter that incremented on every
      // popstate, on the wrong assumption that each re-push added a new
      // layer to unwind. It didn't -- the stack depth stays constant,
      // but the counter kept growing, so go(-(count+1)) overshot further
      // with every back-press before the user finally confirmed leaving,
      // in the worst case landing out of range, past the previous page
      // entirely.
      window.history.go(-2);
    };

    const handler = () => {
      window.history.pushState(null, "", window.location.href);
      callbackRef.current(confirmLeave);
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once per page -- re-running this would push extra dummy entries
}

/**
 * Shows the browser's native "Leave site?" prompt on tab close / refresh /
 * external navigation. Browsers ignore any custom message text and show a
 * generic string regardless -- this only controls whether the prompt fires.
 */
export function useBeforeUnloadGuard(shouldWarn: () => boolean) {
  const shouldWarnRef = useRef(shouldWarn);
  shouldWarnRef.current = shouldWarn;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (shouldWarnRef.current()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
