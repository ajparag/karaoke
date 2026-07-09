// =============================================================================
// CHANGELOG
// v1 -- NEW. Host Party flow: signed-in user enters a party name, gets a
//   random 4-letter join code, and lands on the Party Stage control screen.
//   Requires sign-in (RLS enforces auth.uid() = host_user_id on insert) so
//   only the host device can control playback later -- this is the identity
//   check that makes "only host can play songs" enforceable.
// =============================================================================

import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, PartyPopper, Loader2 } from "lucide-react";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion with 1/0

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export default function CreateParty() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [partyName, setPartyName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    if (!user || !partyName.trim()) return;
    setIsCreating(true);

    // Retry a few times in case of a rare code collision (unique constraint)
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const { error } = await supabase
        .from("stages")
        .insert({ code, name: partyName.trim(), host_user_id: user.id });

      if (!error) {
        navigate(`/party/${code}/stage`);
        return;
      }
      // 23505 = unique_violation -- try again with a new code
      if (error.code !== "23505") {
        console.error("[CreateParty] Failed to create stage:", error);
        toast({ title: "Could not start party", description: "Please try again", variant: "destructive" });
        break;
      }
    }
    setIsCreating(false);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl gradient-primary shadow-glow">
              <PartyPopper className="h-7 w-7 text-primary-foreground" />
            </div>
            <CardTitle>Host a Party</CardTitle>
            <CardDescription>
              {user
                ? "Give your party a name. Friends will join with a code and add songs -- you control playback."
                : "Sign in to host a party. This lets you control playback and keeps your party secure."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-muted-foreground space-y-1.5 bg-muted/50 rounded-lg p-3">
              <p className="font-medium text-foreground">How hosting works:</p>
              <p>&bull; You get a 4-letter code to share with friends</p>
              <p>&bull; Friends add songs from their own phones -- with their name attached</p>
              <p>&bull; Only YOU play/sing each song, right here on this screen</p>
              <p>&bull; Everyone sees the queue and live scores update as you go</p>
            </div>
            {user ? (
              <>
                <Input
                  placeholder="e.g. Parag's Birthday Bash"
                  value={partyName}
                  onChange={(e) => setPartyName(e.target.value)}
                  maxLength={60}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
                <Button
                  className="w-full gradient-primary text-primary-foreground"
                  onClick={handleCreate}
                  disabled={isCreating || !partyName.trim()}
                >
                  {isCreating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Start Party
                </Button>
              </>
            ) : (
              <Link to="/auth" state={{ from: "/party/host" }}>
                <Button className="w-full gradient-primary text-primary-foreground">Sign In to Host</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
