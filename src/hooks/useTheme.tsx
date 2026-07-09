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
// which route the user lands on first. Sing.tsx continues to force its own
// local 'dark' class on its container independently of this -- that's
// intentional and unaffected by this provider.
// =============================================================================

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

interface ThemeContextValue {
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(() => {
    try {
      return localStorage.getItem('theme') === 'dark';
    } catch {
      return false;
    }
  });

  // Apply immediately on mount (app load) and whenever it changes --
  // this runs at the App root, so it's consistent no matter which page
  // the user lands on first.
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    try {
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    } catch {
      // localStorage unavailable (private browsing etc.) -- non-fatal,
      // theme just won't persist across sessions.
    }
  }, [isDark]);

  const toggleTheme = () => setIsDark((d) => !d);

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
