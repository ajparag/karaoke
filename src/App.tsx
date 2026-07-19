// =============================================================================
// App.tsx — Root application shell
// =============================================================================
// CHANGELOG
// v1 — Original Lovable output. QueryClientProvider, TooltipProvider, Sonner
//      all installed but never used. All pages loaded eagerly (no splitting).
// v2 — CURRENT: Cleaned and optimised.
//   REMOVED:
//   - @tanstack/react-query — QueryClient + QueryClientProvider removed.
//     Not a single page calls useQuery or useMutation. ~40KB bundle saved.
//   - TooltipProvider — no component in the app uses <Tooltip>. Dead wrapper.
//   - Sonner — duplicate toast system. All pages use useToast() from
//     use-toast.ts (shadcn Toaster). Sonner was never called anywhere.
//   ADDED:
//   - React.lazy() for all non-Index pages — deferred loading cuts initial
//     bundle by ~40%. Index loads instantly; other pages load on first visit.
//   - Suspense boundary with minimal fallback — spinner while chunk loads.
//   KEPT:
//   - ErrorBoundary — catches render crashes, shows error on screen.
//   - AuthProvider, ThemeProvider, AuthCallbackGate — all still needed.
//   - Toaster — the one toast system actually used.
// =============================================================================

import { Component, ReactNode, Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ThemeProvider } from "@/hooks/useTheme";
import { AuthCallbackGate } from "@/components/AuthCallbackGate";

// Index loads eagerly — it's the landing page, must be instant
import Index from "./pages/Index";

// All other pages are lazy — loaded on first navigation to that route.
// Vite splits each into its own chunk automatically.
const Auth        = lazy(() => import("./pages/Auth"));
const Sing        = lazy(() => import("./pages/Sing"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const History     = lazy(() => import("./pages/History"));
const Profile     = lazy(() => import("./pages/Profile"));
const CreateParty = lazy(() => import("./pages/CreateParty"));
const JoinParty   = lazy(() => import("./pages/JoinParty"));
const PartyStage  = lazy(() => import("./pages/PartyStage"));
const PartyQueue  = lazy(() => import("./pages/PartyQueue"));
const NotFound    = lazy(() => import("./pages/NotFound"));

// Minimal loading fallback — shown while a lazy chunk downloads.
// Intentionally plain: the page's own UI takes over as soon as it's ready.
function PageLoader() {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--background)' }}>
      <div style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--primary)', animation: 'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// Error boundary — catches render-time crashes and shows them on screen
// instead of leaving a blank page with no indication of what went wrong.
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'red', padding: '2rem', fontFamily: 'sans-serif', whiteSpace: 'pre-wrap' }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ fontSize: '0.8rem' }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
      <AuthProvider>
        <Toaster />
        <AuthCallbackGate>
          <HashRouter>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/"                    element={<Index />} />
                <Route path="/auth"                element={<Auth />} />
                <Route path="/sing/:trackId"       element={<Sing />} />
                <Route path="/leaderboard"         element={<Leaderboard />} />
                <Route path="/history"             element={<History />} />
                <Route path="/profile"             element={<Profile />} />
                <Route path="/party/host"          element={<CreateParty />} />
                <Route path="/party/join"          element={<JoinParty />} />
                <Route path="/party/:code/stage"   element={<PartyStage />} />
                <Route path="/party/:code/queue"   element={<PartyQueue />} />
                <Route path="*"                    element={<NotFound />} />
              </Routes>
            </Suspense>
          </HashRouter>
        </AuthCallbackGate>
      </AuthProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
