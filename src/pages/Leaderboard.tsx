// =============================================================================
// CHANGELOG
// v-clean -- Full rewrite for mobile-first consistency. Single source of
//   truth for horizontal spacing: ONE gutter value (px-4 mobile, px-6
//   desktop) applied once at the page level. Cards are edge-to-edge within
//   that gutter (no separate card-level horizontal padding to compound
//   with it) with a single consistent internal inset (16px) for their own
//   heading + rows, so a card's heading and its rows always line up with
//   each other. No nested/compounding padding layers anywhere.
// =============================================================================

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import { supabase } from '@/integrations/supabase/client';
import { Trophy, Medal, Award, Music, ArrowLeft, MapPin, Sun, Moon } from 'lucide-react';

interface LeaderboardEntry {
  id: string;
  username: string;
  total_score: number;
  songs_performed: number;
}

interface TopScore {
  id: string;
  score: number;
  rating: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  display_name: string | null;
  city: string | null;
}

const RATING_COLOR: Record<string, string> = {
  S: 'text-score-perfect',
  A: 'text-score-great',
  B: 'text-score-good',
  C: 'text-score-ok',
  D: 'text-score-ok',
  F: 'text-score-miss',
};

function RankIcon({ index }: { index: number }) {
  if (index === 0) return <Trophy className="h-5 w-5 text-score-perfect" />;
  if (index === 1) return <Medal className="h-5 w-5 text-muted-foreground" />;
  if (index === 2) return <Award className="h-5 w-5 text-score-ok" />;
  return <span className="text-sm font-bold text-muted-foreground">{index + 1}</span>;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
      <Music className="h-10 w-10 opacity-30" />
      <p className="text-sm">No scores yet. Be the first!</p>
    </div>
  );
}

function RowSkeleton() {
  return <div className="h-14 rounded-lg bg-muted/40 animate-pulse" />;
}

export default function Leaderboard() {
  const { isDark, toggleTheme } = useTheme();
  const [topUsers, setTopUsers] = useState<LeaderboardEntry[]>([]);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);

      const { data: users } = await supabase
        .from('profiles')
        .select('id, username, total_score, songs_performed')
        .order('total_score', { ascending: false })
        .limit(10);
      if (users) setTopUsers(users);

      const { data: scores } = await supabase
        .from('scores')
        .select('id, score, rating, song_title, song_artist, thumbnail_url, display_name, city')
        .order('score', { ascending: false })
        .limit(10);
      if (scores) setTopScores(scores as TopScore[]);

      setLoading(false);
    };

    fetchLeaderboard();

    const channel = supabase
      .channel('leaderboard-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, fetchLeaderboard)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, fetchLeaderboard)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Header -- the ONE gutter value (px-4 / md:px-6) is defined here
          and reused verbatim by <main> below. Nothing else on the page
          adds its own separate horizontal page-level padding. */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex items-center gap-3 px-4 md:px-6 py-3">
          <Link to="/" className="shrink-0 -ml-2 p-2 rounded-full hover:bg-muted transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-lg leading-tight">Leaderboard</h1>
            <p className="text-xs text-muted-foreground leading-tight">Top performers worldwide</p>
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="shrink-0 p-2 rounded-full hover:bg-muted transition-colors"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main -- SAME px-4 / md:px-6 gutter as the header above, applied
          exactly once here. Everything below is full-width within it. */}
      <main className="px-4 md:px-6 py-5 md:py-8 max-w-3xl md:max-w-5xl mx-auto space-y-6">

        {/* Top Performers */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-4 border-b border-border/60">
            <Trophy className="h-4 w-4 text-score-perfect shrink-0" />
            <h2 className="font-semibold text-base">Top Performers</h2>
          </div>
          <div className="px-2 py-2">
            {loading ? (
              <div className="space-y-2 p-2">
                <RowSkeleton /><RowSkeleton /><RowSkeleton />
              </div>
            ) : topUsers.length === 0 ? (
              <EmptyState />
            ) : (
              topUsers.map((u, i) => (
                <div key={u.id} className="flex items-center gap-3 px-2 py-3 rounded-lg hover:bg-muted/40 transition-colors">
                  <div className="w-6 flex justify-center shrink-0"><RankIcon index={i} /></div>
                  <div className={`h-9 w-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0 ${
                    i === 0 ? 'gradient-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {u.username.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{u.username}</p>
                    <p className="text-xs text-muted-foreground">{u.songs_performed} songs</p>
                  </div>
                  <p className="font-bold shrink-0">{u.total_score.toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Top Scores */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-4 border-b border-border/60">
            <Music className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-semibold text-base">Top Scores</h2>
          </div>
          <div className="px-2 py-2">
            {loading ? (
              <div className="space-y-2 p-2">
                <RowSkeleton /><RowSkeleton /><RowSkeleton />
              </div>
            ) : topScores.length === 0 ? (
              <EmptyState />
            ) : (
              topScores.map((s, i) => (
                <div key={s.id} className="flex items-center gap-3 px-2 py-3 rounded-lg hover:bg-muted/40 transition-colors">
                  <div className="w-6 flex justify-center shrink-0"><RankIcon index={i} /></div>
                  {s.thumbnail_url ? (
                    <img src={s.thumbnail_url} alt="" className="h-11 w-11 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className="h-11 w-11 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <Music className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{s.song_title}</p>
                    <div className="flex items-center gap-1 min-w-0 text-xs text-muted-foreground">
                      <span className="truncate">{s.display_name || 'Anonymous'}</span>
                      {s.city && (
                        <span className="flex items-center gap-0.5 shrink-0">
                          <MapPin className="h-3 w-3" />
                          <span className="truncate max-w-[70px]">{s.city}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`font-bold leading-tight ${RATING_COLOR[s.rating] || 'text-foreground'}`}>{s.rating}</p>
                    <p className="text-xs text-muted-foreground leading-tight">{s.score}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
