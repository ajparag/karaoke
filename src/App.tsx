import { Component, ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ThemeProvider } from "@/hooks/useTheme";
import { AuthCallbackGate } from "@/components/AuthCallbackGate";
import { useEffect } from "react";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Sing from "./pages/Sing";
import Leaderboard from "./pages/Leaderboard";
import History from "./pages/History";
import Profile from "./pages/Profile";
import CreateParty from "./pages/CreateParty";
import JoinParty from "./pages/JoinParty";
import PartyStage from "./pages/PartyStage";
import PartyQueue from "./pages/PartyQueue";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Error boundary catches render-time crashes and shows them on screen
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
        <div style={{ color: "red", padding: "2rem", fontFamily: "sans-serif", whiteSpace: "pre-wrap" }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <pre style={{ fontSize: "0.8rem" }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  // NOTE: warmUpHFSpace() is intentionally NOT called here. This effect
  // used to ping Modal on every single page load/visit -- homepage,
  // leaderboard, auth, everywhere -- burning GPU idle time for visitors
  // who never search or sing at all. Warmup now happens ONLY from
  // Index.tsx's handleSearch(), i.e. the moment someone actually clicks
  // search or presses Enter -- the earliest point we know they intend to
  // pick a song.
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <AuthCallbackGate>
            <HashRouter>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/auth" element={<Auth />} />
                <Route path="/sing/:trackId" element={<Sing />} />
                <Route path="/leaderboard" element={<Leaderboard />} />
                <Route path="/history" element={<History />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/party/host" element={<CreateParty />} />
                <Route path="/party/join" element={<JoinParty />} />
                <Route path="/party/:code/stage" element={<PartyStage />} />
                <Route path="/party/:code/queue" element={<PartyQueue />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </HashRouter>
            </AuthCallbackGate>
          </TooltipProvider>
        </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
