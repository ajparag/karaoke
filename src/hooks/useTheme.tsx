// =============================================================================
// CHANGELOG
// v1 -- NEW. Global theme provider so light/dark preference is applied
//   consistently on EVERY page (previously the toggle logic and localStorage
//   read only existed inside Index.tsx, meaning direct navigation to
//   Leaderboard/History/Auth never applied the saved preference and had no
//   way to switch themes at all).
//
// Applies/removes the 'dark' class on document.documentElement at APP LOAD
// time (in App.tsx, not a specific page), so it's consistent regardless of
// which route the user lands on first. Sing.tsx now reads isDark from this
// SAME provider (via useTheme()) rather than forcing its own local dark
// mode -- it used to hardcode dark unconditionally, but that was changed
// so the whole app respects one consistent theme choice everywhere.
// =============================================================================

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";

interface ThemeContextValue {
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getSystemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true; // matchMedia unavailable — default to dark
  }
}

// =============================================================================
// v2 -- Added system theme (prefers-color-scheme) support.
//
// Priority order:
//   1. An explicit choice the user made by tapping the toggle (saved in
//      localStorage) always wins — the app never overrides a deliberate pick.
//   2. If the user has never toggled it, the app follows the OS-level dark/
//      light setting, and keeps following it live if the user changes their
//      OS theme while the app is open (e.g. switches at sunset via their
//      phone's auto dark mode).
//   3. If matchMedia is unavailable (very old browser), falls back to dark
//      by default rather than light.
// =============================================================================

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(() => {
    try {
      const stored = localStorage.getItem('theme');
      if (stored === 'dark') return true;
      if (stored === 'light') return false;
      // No explicit choice yet — follow the OS setting.
      return getSystemPrefersDark();
    } catch {
      return true; // localStorage unavailable — default to dark
    }
  });

  // Tracks whether the CURRENT value came from an explicit user choice.
  // A ref (not state) so the live system-theme listener below can check
  // it synchronously without needing to re-subscribe — the moment
  // toggleTheme fires, this flips to true and the listener becomes a
  // permanent no-op for the rest of the session, even though it's still
  // technically attached.
  const explicitRef = useRef<boolean>((() => {
    try {
      const stored = localStorage.getItem('theme');
      return stored === 'dark' || stored === 'light';
    } catch {
      return false;
    }
  })());

  // Live-follow the OS theme setting for as long as explicitRef is false.
  // Runs once on mount; the explicitRef check inside the handler (not the
  // effect setup) is what actually gates whether a system change applies —
  // this way a mid-session toggle correctly stops future system changes
  // from taking over, without needing to tear down and rebuild the listener.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      if (explicitRef.current) return; // user has made their own choice — ignore OS changes
      setIsDark(e.matches);
    };

    mql.addEventListener?.('change', handleChange);
    return () => mql.removeEventListener?.('change', handleChange);
  }, []);

  // Apply to the DOM on every change, regardless of source (explicit toggle
  // or system-follow). This does NOT persist to localStorage — persistence
  // only happens in toggleTheme, so a system-driven change is never
  // mistaken for a deliberate user choice on the next visit.
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // toggleTheme is the ONLY place that writes to localStorage — this is
  // what marks the choice as explicit and makes it stick on future visits,
  // overriding the system-follow behaviour from here on.
  const toggleTheme = () => {
    explicitRef.current = true; // from now on, ignore live OS theme changes
    setIsDark((d) => {
      const next = !d;
      try {
        localStorage.setItem('theme', next ? 'dark' : 'light');
      } catch {
        // localStorage unavailable (private browsing etc.) -- non-fatal,
        // the toggle still works for this session, just won't persist.
      }
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
