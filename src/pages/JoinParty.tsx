// =============================================================================
// CHANGELOG
// v1 -- NEW. Join Party flow: enter a 4-letter code, verify the party is
//   active, and (if not signed in) enter a display name before landing on
//   the participant Queue view. Signed-in users skip the name step and use
//   their account's display name automatically.
// =============================================================================

import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { setGuestName } from "@/hooks/usePartyDevice";
import { ArrowLeft, Users, Loader2 } from "lucide-react";

export default function JoinParty() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isJoining, setIsJoining] = useState(false);

  const handleJoin = async () => {
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) return;
    if (!user && !name.trim()) {
      toast({ title: "Enter your name", description: "Friends need to know who added each song", variant: "destructive" });
      return;
    }

    setIsJoining(true);
    const { data, error } = await supabase
      .from("stages")
      .select("code, is_active")
      .eq("code", trimmedCode)
      .eq("is_active", true)
      .maybeSingle();

    setIsJoining(false);

    if (error || !data) {
      toast({ title: "Party not found", description: "Check the code and try again", variant: "destructive" });
      return;
    }

    if (!user) {
      setGuestName(trimmedCode, name.trim());
    }
    navigate(`/party/${trimmedCode}/queue`);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl gradient-primary shadow-glow">
              <Users className="h-7 w-7 text-primary-foreground" />
            </div>
            <CardTitle>Join a Party</CardTitle>
            <CardDescription>Enter the code your host shared with you</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-muted-foreground space-y-1.5 bg-muted/50 rounded-lg p-3">
              <p className="font-medium text-foreground">How joining works:</p>
              <p>&bull; Enter the 4-letter code your host shared with you</p>
              <p>&bull; Search and add songs to the shared queue with your name</p>
              <p>&bull; Your host plays each song -- when it's your turn, take the mic!</p>
            </div>
            <Input
              placeholder="e.g. WFWD"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={4}
              className="text-center text-2xl tracking-[0.3em] font-semibold h-14"
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              // Was: only submitted on Enter if signed in -- anonymous users
              // pressing Enter here got silent, confusing nothing. handleJoin()
              // already validates and shows a toast if the name is missing, so
              // just always attempting it is simpler and gives real feedback.
            />
            {!user && (
              <Input
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={30}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              />
            )}
            <Button
              className="w-full gradient-primary text-primary-foreground"
              onClick={handleJoin}
              disabled={isJoining || !code.trim() || (!user && !name.trim())}
            >
              {isJoining ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Join Party
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
