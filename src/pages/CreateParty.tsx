// =============================================================================
// CreateParty.tsx — Host Party creation
// =============================================================================
// CHANGELOG
// v1 — Original. Card-heavy layout, no stageId in context.
// v2 — CURRENT: Clean rewrite.
//   FIXED:
//   - stageId now stored in activePartyContext — was missing, causing party
//     scores to never link to the party leaderboard
//   - handleCreate wrapped in useCallback
//   - setIsCreating(false) in finally block — was missing on non-collision errors
//   UI:
//   - Card/CardHeader/CardContent replaced with plain divs — simpler, same look
//   - Energetic design matching new theme
// =============================================================================

import { useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Mic, Loader2 } from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O — avoids confusion with 1/0

function generateCode(): string {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreateParty() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [partyName, setPartyName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!user || !partyName.trim()) return;
    setIsCreating(true);
    try {
      // Retry up to 5 times on code collision (unique constraint violation)
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const { data, error } = await supabase
          .from('stages')
          .insert({ code, name: partyName.trim(), host_user_id: user.id })
          .select('id')
          .single();

        if (!error && data) {
          // Store stageId so Sing.tsx can link scores to this party
          // (was missing in v1 — party scores were never linked to the leaderboard)
          sessionStorage.setItem('pendingPartyStageId', data.id);
          navigate(`/party/${code}/stage`);
          return;
        }
        if (error?.code !== '23505') {
          // Not a collision — real error, stop retrying
          console.error('[CreateParty] Failed:', error);
          toast({ title: 'Could not start party', description: 'Please try again', variant: 'destructive' });
          return;
        }
      }
      toast({ title: 'Could not start party', description: 'Please try again', variant: 'destructive' });
    } finally {
      setIsCreating(false);
    }
  }, [user, partyName, navigate, toast]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">

        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        <div className="rounded-2xl border border-border bg-card p-6">

          {/* Icon + title */}
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-2xl gradient-primary flex items-center justify-center mb-3">
              <Mic className="w-7 h-7 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-semibold">Host a party</h1>
            <p className="text-sm text-muted-foreground text-center mt-1">
              {user
                ? 'Give your party a name. Friends join with a code and add songs — you control playback.'
                : 'Sign in to host. This lets you control playback and keeps your party secure.'}
            </p>
          </div>

          {/* How it works */}
          <div className="bg-muted/50 rounded-xl p-3 mb-5 space-y-1.5">
            <p className="text-xs font-medium">How hosting works</p>
            {[
              'You get a 4-letter code to share with friends',
              'Friends add songs from their own phones with their name',
              'Only you play each song right here on this screen',
              'Everyone sees the queue and live scores update as you go',
            ].map(line => (
              <p key={line} className="text-xs text-muted-foreground">· {line}</p>
            ))}
          </div>

          {/* Form or sign-in prompt */}
          {user ? (
            <div className="space-y-3">
              <Input
                placeholder="e.g. Parag's Birthday Bash"
                value={partyName}
                onChange={e => setPartyName(e.target.value)}
                maxLength={60}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="h-11"
              />
              <Button
                className="w-full gradient-primary text-primary-foreground h-11"
                onClick={handleCreate}
                disabled={isCreating || !partyName.trim()}
              >
                {isCreating && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                Start party
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-center text-muted-foreground bg-muted/50 rounded-xl p-3">
                You'll be brought right back here after signing in — your party setup won't be lost.
              </p>
              <Link
                to="/auth"
                state={{ from: '/party/host' }}
                onClick={() => sessionStorage.setItem('authRedirectTo', '/party/host')}
              >
                <Button className="w-full gradient-primary text-primary-foreground h-11">
                  Sign in to host
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
