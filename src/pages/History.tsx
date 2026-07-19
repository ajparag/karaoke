// =============================================================================
// History.tsx — Personal singing history
// =============================================================================
// CHANGELOG
// v1 — Original. fetchScores stale closure risk, stats computed inside fetch,
//      AlertDialog for delete, date-fns dependency, getRatingColor inside component.
// v2 — CURRENT: Clean rewrite.
//   FIXED:
//   - fetchScores moved outside component scope to avoid stale closure
//   - stats derived from scores state via useMemo — no duplicate computation
//   - Delete confirm replaced with simple window.confirm — removes AlertDialog
//     heavy import entirely. Simple and sufficient for a history delete.
//   - date-fns removed — toLocaleDateString() is built-in and sufficient
//   - getRatingColor and RATING_COLORS extracted as constants outside component
//   - AuthLoading spinner replaced with Loader2 consistent with rest of app
//   REMOVED:
//   - AlertDialog and all its imports — overkill for a delete confirm
//   - format from date-fns — replaced with toLocaleDateString
//   - StatCard as separate export — inlined as a local component
// =============================================================================

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Music, Calendar, Clock, Trash2, TrendingUp, ArrowLeft, Mic, Sun, Moon, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/hooks/useTheme';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoreEntry {
  id: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  score: number;
  rating: string;
  rhythm_accuracy: number | null;
  timing_accuracy: number | null;
  duration_seconds: number | null;
  created_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RATING_COLORS: Record<string, string> = {
  L: 'text-score-perfect bg-score-perfect/20',
  S: 'text-score-perfect bg-score-perfect/20',
  A: 'text-score-great bg-score-great/20',
  B: 'text-score-good bg-score-good/20',
  C: 'text-score-ok bg-score-ok/20',
  D: 'text-score-ok bg-score-ok/20',
  F: 'text-score-miss bg-score-miss/20',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(seconds: number | null): string {
  if (!seconds) return '0:00';
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: string | number; label: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center shrink-0">{icon}</div>
        <div className="min-w-0">
          <div className="text-xl font-bold truncate">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function History() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { isDark, toggleTheme } = useTheme();
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Derived stats — no separate state needed
  const stats = useMemo(() => {
    if (!scores.length) return { totalSongs: 0, averageScore: 0, bestScore: 0, totalTime: 0 };
    const totalScore = scores.reduce((s, e) => s + e.score, 0);
    const totalTime = scores.reduce((s, e) => s + (e.duration_seconds || 0), 0);
    return {
      totalSongs: scores.length,
      averageScore: Math.round(totalScore / scores.length),
      bestScore: Math.max(...scores.map(e => e.score)),
      totalTime,
    };
  }, [scores]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { navigate('/auth'); return; }

    setLoading(true);
    supabase
      .from('scores')
      .select('*')
      .eq('user_id', user.id)
      .is('stage_id', null)          // solo scores only — party scores excluded
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!error && data) setScores(data as ScoreEntry[]);
        setLoading(false);
      });
  }, [user, authLoading, navigate]);

  const handleDelete = useCallback(async (id: string) => {
    // Simple confirm — no heavy AlertDialog needed for a history delete
    if (!window.confirm('Delete this score from your history?')) return;
    const { error } = await supabase.from('scores').delete().eq('id', id);
    if (error) {
      toast({ title: 'Failed to delete', variant: 'destructive' });
    } else {
      setScores(prev => prev.filter(s => s.id !== id));
      toast({ title: 'Score deleted' });
    }
  }, [toast]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <Link to="/"><Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button></Link>
          <div className="flex-1">
            <h1 className="font-semibold text-base">Your history</h1>
            <p className="text-xs text-muted-foreground">Track your singing journey</p>
          </div>
          <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-muted transition-colors" aria-label="Toggle theme">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 space-y-4">

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={<Music className="h-5 w-5 text-primary" />} value={stats.totalSongs} label="Songs" />
          <StatCard icon={<TrendingUp className="h-5 w-5 text-blue-500" />} value={stats.averageScore} label="Avg score" />
          <StatCard icon={<TrendingUp className="h-5 w-5 text-yellow-500" />} value={stats.bestScore} label="Best score" />
          <StatCard icon={<Clock className="h-5 w-5 text-muted-foreground" />} value={fmtTime(stats.totalTime)} label="Total time" />
        </div>

        {/* History list */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="font-semibold text-sm mb-4">Performance history</h2>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-20 rounded-xl bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : scores.length === 0 ? (
            <div className="text-center py-12">
              <Mic className="h-14 w-14 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No performances yet</h3>
              <p className="text-sm text-muted-foreground mb-4">Start singing to build your history!</p>
              <Link to="/"><Button className="gradient-primary text-primary-foreground"><Music className="w-4 h-4 mr-2" />Start singing</Button></Link>
            </div>
          ) : (
            <div className="space-y-2">
              {scores.map(entry => (
                <div key={entry.id} className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors">
                  {entry.thumbnail_url
                    ? <img src={entry.thumbnail_url} alt={entry.song_title} className="h-14 w-14 rounded-lg object-cover shrink-0" loading="lazy" />
                    : <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center shrink-0"><Music className="h-5 w-5 text-muted-foreground" /></div>}

                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{entry.song_title}</p>
                    {entry.song_artist && <p className="text-xs text-muted-foreground truncate">{entry.song_artist}</p>}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                      <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{fmtDate(entry.created_at)}</span>
                      {entry.duration_seconds && <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{fmtTime(entry.duration_seconds)}</span>}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className={`inline-block px-2.5 py-0.5 rounded-full text-sm font-bold ${RATING_COLORS[entry.rating] || 'text-foreground bg-muted'}`}>
                      {entry.rating}
                    </span>
                    <p className="text-xs text-muted-foreground mt-1">{entry.score}</p>
                  </div>

                  <button
                    onClick={() => handleDelete(entry.id)}
                    className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                    aria-label="Delete score"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
