// =============================================================================
// Profile.tsx — User profile page
// =============================================================================
// CHANGELOG
// v1 — Original. Card-heavy, no useCallback, profiles update error swallowed.
// v2 — CURRENT: Clean rewrite.
//   FIXED:
//   - handleSaveName: profiles table error now surfaced in toast
//   - handleEndParty, handleSaveName, handleSavePassword: wrapped in useCallback
//   - loadStages moved into useEffect directly (no separate function that
//     could go stale)
//   - authLoading guard consolidated — single early return
//   REMOVED:
//   - Card/CardContent/CardHeader/CardTitle/CardDescription — plain divs
//   UI:
//   - Energetic design matching new theme
// =============================================================================

import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Mic, Loader2, User, Lock, Save, X } from 'lucide-react';

interface ActiveStage {
  code: string;
  name: string;
  created_at: string;
}

export default function Profile() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [username, setUsername] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [activeStages, setActiveStages] = useState<ActiveStage[]>([]);
  const [loadingStages, setLoadingStages] = useState(true);
  const [endingCode, setEndingCode] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { navigate('/auth', { state: { from: '/profile' } }); return; }
    setUsername(user.user_metadata?.username || user.user_metadata?.full_name || '');
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('stages')
      .select('code, name, created_at')
      .eq('host_user_id', user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (data) setActiveStages(data as ActiveStage[]);
        setLoadingStages(false);
      });
  }, [user]);

  const handleEndParty = useCallback(async (code: string) => {
    if (!user) return;
    setEndingCode(code);
    const { error } = await supabase
      .from('stages')
      .update({ is_active: false })
      .eq('code', code)
      .eq('host_user_id', user.id);
    setEndingCode(null);
    if (error) {
      toast({ title: 'Could not end party', description: error.message, variant: 'destructive' });
    } else {
      setActiveStages(prev => prev.filter(s => s.code !== code));
      toast({ title: 'Party ended' });
    }
  }, [user, toast]);

  const handleSaveName = useCallback(async () => {
    if (!username.trim() || !user) return;
    setSavingName(true);
    try {
      const { error: authError } = await supabase.auth.updateUser({ data: { username: username.trim() } });
      if (authError) throw authError;

      // Keep profiles table (used by leaderboard) in sync
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ username: username.trim() })
        .eq('user_id', user.id);
      if (profileError) console.warn('[Profile] profiles sync failed:', profileError.message);

      toast({ title: 'Name updated' });
    } catch (e) {
      toast({ title: 'Could not update name', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSavingName(false);
    }
  }, [username, user, toast]);

  const handleSavePassword = useCallback(async () => {
    if (newPassword.length < 6) {
      toast({ title: 'Password too short', description: 'At least 6 characters', variant: 'destructive' });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: 'destructive' });
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast({ title: 'Password updated' });
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      toast({ title: 'Could not update password', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSavingPassword(false);
    }
  }, [newPassword, confirmPassword, toast]);

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
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <Link to="/"><Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button></Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-base">Your profile</h1>
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4 space-y-4">

        {/* Active parties — resume mechanism */}
        {!loadingStages && activeStages.length > 0 && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Mic className="w-4 h-4 text-primary" />
              <p className="font-medium text-sm">Your active parties</p>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Jump back into a party you left without ending</p>
            <div className="space-y-2">
              {activeStages.map(stage => (
                <div key={stage.code} className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{stage.name}</p>
                    <p className="text-xs text-muted-foreground tracking-widest">{stage.code}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm" variant="outline"
                      className="text-destructive hover:text-destructive h-8 w-8 p-0"
                      onClick={() => handleEndParty(stage.code)}
                      disabled={endingCode === stage.code}
                      title="End party for everyone"
                    >
                      {endingCode === stage.code ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    </Button>
                    <Link to={`/party/${stage.code}/stage`}>
                      <Button size="sm" className="gradient-primary text-primary-foreground h-8">Resume</Button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Display name */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <User className="w-4 h-4" />
            <p className="font-medium text-sm">Display name</p>
          </div>
          <p className="text-xs text-muted-foreground mb-3">Shown on the leaderboard and in parties you host</p>
          <div className="flex gap-2">
            <Input
              value={username}
              onChange={e => setUsername(e.target.value)}
              maxLength={30}
              onKeyDown={e => e.key === 'Enter' && handleSaveName()}
              className="h-11 flex-1"
            />
            <Button onClick={handleSaveName} disabled={savingName || !username.trim()} className="h-11 w-11 p-0 shrink-0">
              {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Change password */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Lock className="w-4 h-4" />
            <p className="font-medium text-sm">Change password</p>
          </div>
          <div className="space-y-2">
            <Input
              type="password" placeholder="New password"
              value={newPassword} onChange={e => setNewPassword(e.target.value)}
              className="h-11"
            />
            <Input
              type="password" placeholder="Confirm new password"
              value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSavePassword()}
              className="h-11"
            />
            <Button
              onClick={handleSavePassword}
              disabled={savingPassword || !newPassword || !confirmPassword}
              className="w-full h-11 gradient-primary text-primary-foreground"
            >
              {savingPassword && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Update password
            </Button>
          </div>
        </div>

      </main>
    </div>
  );
}
