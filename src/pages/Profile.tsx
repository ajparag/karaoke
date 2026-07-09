// =============================================================================
// CHANGELOG
// v1 -- NEW. Profile page: change display name, change password, and --
//   critically -- resume any hosted party the user has left mid-session
//   (previously there was NO way back into an active party once you
//   navigated away except re-typing the join code, since only "Leave
//   Party"/"Home" existed with no bookmark/resume mechanism).
// =============================================================================

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, PartyPopper, Loader2, User, Lock, Save } from "lucide-react";

interface ActiveStage {
  code: string;
  name: string;
  created_at: string;
}

export default function Profile() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [username, setUsername] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [activeStages, setActiveStages] = useState<ActiveStage[]>([]);
  const [loadingStages, setLoadingStages] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate("/auth", { state: { from: "/profile" } });
      return;
    }
    setUsername(user.user_metadata?.username || user.user_metadata?.full_name || "");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user) return;
    const loadStages = async () => {
      const { data } = await supabase
        .from("stages")
        .select("code, name, created_at")
        .eq("host_user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (data) setActiveStages(data as ActiveStage[]);
      setLoadingStages(false);
    };
    loadStages();
  }, [user]);

  const handleSaveName = async () => {
    if (!username.trim()) return;
    setSavingName(true);
    try {
      const { error: authError } = await supabase.auth.updateUser({
        data: { username: username.trim() },
      });
      if (authError) throw authError;

      // Keep the profiles table (used by the leaderboard) in sync too
      await supabase.from("profiles").update({ username: username.trim() }).eq("user_id", user!.id);

      toast({ title: "Name updated" });
    } catch (e) {
      toast({ title: "Could not update name", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingName(false);
    }
  };

  const handleSavePassword = async () => {
    if (newPassword.length < 6) {
      toast({ title: "Password too short", description: "At least 6 characters", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast({ title: "Password updated" });
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      toast({ title: "Could not update password", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingPassword(false);
    }
  };

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-xl mx-auto flex items-center gap-4">
          <Link to="/"><Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button></Link>
          <div>
            <h1 className="font-semibold text-xl">Your Profile</h1>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4 space-y-6">
        {/* Active hosted parties -- the resume mechanism */}
        {!loadingStages && activeStages.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <PartyPopper className="w-4 h-4 text-primary" /> Your Active Parties
              </CardTitle>
              <CardDescription>Jump back into a party you left without ending</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeStages.map((stage) => (
                <div key={stage.code} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{stage.name}</p>
                    <p className="text-xs text-muted-foreground tracking-widest">{stage.code}</p>
                  </div>
                  <Link to={`/party/${stage.code}/stage`}>
                    <Button size="sm" className="gradient-primary text-primary-foreground shrink-0">Resume</Button>
                  </Link>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Change display name */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <User className="w-4 h-4" /> Display Name
            </CardTitle>
            <CardDescription>Shown on the leaderboard and in parties you host</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={30} />
            <Button onClick={handleSaveName} disabled={savingName || !username.trim()} className="shrink-0">
              {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            </Button>
          </CardContent>
        </Card>

        {/* Change password */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="w-4 h-4" /> Change Password
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <Input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <Button
              onClick={handleSavePassword}
              disabled={savingPassword || !newPassword || !confirmPassword}
              className="w-full"
            >
              {savingPassword ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Update Password
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
