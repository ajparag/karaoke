// =============================================================================
// CHANGELOG
// v1 -- NEW. Fixes the "briefly flashes 404 then redirects home" bug seen
//   after Google OAuth sign-in.
//
// Root cause: this app uses HashRouter (routes live after '#'), but
// Supabase's OAuth redirect ALSO appends the session token after '#'
// (e.g. "https://karaokeparty.in/#access_token=..."). React Router tries
// to match "access_token=..." as a route path, finds nothing, and renders
// the catch-all 404 page for a moment -- then Supabase's own async
// hash-parsing finishes, fires SIGNED_IN, and the app navigates to '/',
// clearing the URL. Both systems are fighting over the same '#'.
//
// Fix: detect an in-flight OAuth callback (hash contains 'access_token=')
// BEFORE mounting HashRouter at all. Show a lightweight "Signing you
// in..." screen instead, and only mount the real router once Supabase
// has confirmed the session (or a short safety timeout elapses). This
// means React Router never sees the malformed hash as a route to match,
// so there's nothing to 404 on.
// =============================================================================

import { useEffect, useState, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";

function looksLikeOAuthCallback(): boolean {
  return window.location.hash.includes("access_token=");
}

export function AuthCallbackGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => !looksLikeOAuthCallback());

  useEffect(() => {
    if (ready) return; // no callback in progress, nothing to wait for

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      setReady(true);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        finish();
      }
    });

    // Safety net: if Supabase doesn't fire an event quickly (e.g. the
    // token was invalid/expired), don't leave the user stuck forever --
    // reveal the app after 3s regardless. HashRouter will then just show
    // whatever the leftover hash resolves to (worst case: a normal 404,
    // not a confusing flash).
    const timeout = setTimeout(finish, 3000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [ready]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Signing you in...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
