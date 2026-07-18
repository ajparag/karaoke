// =============================================================================
// Leaderboard.tsx
// CHANGELOG
// v-clean — Lovable original: two sections, basic Supabase fetch, no stats.
// v2 — CURRENT: Full rewrite.
//   - Stats banner (top score / songs sung / singers) added
//   - Both sections kept: Top Performers (cumulative) + Top Scores (single song)
//   - Loading skeleton rows instead of blank screen
//   - City shown on top scores
//   - Rating letter colour-coded by grade
//   - Realtime subscription on both tables
//   - Dead imports removed (MapPin was only used in one spot, inlined)
//   - Theme toggle kept
//   - No Lovable spacing anti-patterns (compounding padding layers removed)
// =============================================================================

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, Sun, Moon, Trophy, Medal, Award, Music, MapPin } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TopPerformer {
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

// ─── Constants ────────────────────────────────────────────────────────────────

const RATING_COLOR: Record<string, string> = {
  L: 'text-yellow-500',
  S: 'text-score-perfect',
  A: 'text-score-great',
  B: 'text-score-good',
  C: 'text-score-ok',
  D: 'text-score-ok',
  F: 'text-score-miss',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function RankIcon({ index }: { index: number }) {
  if (index === 0) return <Trophy className="h-4 w-4 text-yellow-500 shrink-0" />;
  if (index === 1) return <Medal className="h-4 w-4 text-muted-foreground shrink-0" />;
  if (index === 2) return <Award className="h-4 w-4 text-amber-700 shrink-0" />;
  return <span className="text-xs font-semibold text-muted-foreground w-4 text-center shrink-0">{index + 1}</span>;
}

function RowSkeleton() {
  return <div className="h-14 rounded-xl bg-muted/40 animate-pulse mx-2 mb-1" />;
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
      <Music className="h-8 w-8 opacity-30" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Leaderboard() {
  const { isDark, toggleTheme } = useTheme();
  const [performers, setPerformers] = useState<TopPerformer[]>([]);
  const [scores, setScores] = useState<TopScore[]>([]);
  const [loading, setLoading] = useState(true);

  // Aggregate stats derived from fetched data
  const topScore = scores[0]?.score ?? 0;
  const totalSongs = performers.reduce((s, p) => s + p.songs_performed, 0);
  const totalSingers = performers.length;

  const fetchAll = async () => {
    const [{ data: p }, { data: s }] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, total_score, songs_performed')
        .order('total_score', { ascending: false })
        .limit(10),
      supabase
        .from('scores')
        .select('id, score, rating, song_title, song_artist, thumbnail_url, display_name, city')
        .is('stage_id', null)           // solo scores only — party scores excluded
        .order('score', { ascending: false })
        .limit(10),
    ]);
    if (p) setPerformers(p);
    if (s) setScores(s as TopScore[]);
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();

    const channel = supabase
      .channel('leaderboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, fetchAll)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <div className="min-h-screen bg-background">

      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex items-center gap-2 px-4 py-3 max-w-2xl mx-auto">
          <Link to="/" className="-ml-1 p-2 rounded-full hover:bg-muted transition-colors shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-base leading-tight">Leaderboard</h1>
            <p className="text-xs text-muted-foreground leading-tight">Top singers worldwide</p>
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="p-2 rounded-full hover:bg-muted transition-colors shrink-0"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="px-4 py-4 max-w-2xl mx-auto space-y-4">

        {/* ── Stats banner ── */}
        <div className="grid grid-cols-3 gap-px bg-border rounded-2xl overflow-hidden">
          <div className="bg-card px-3 py-4 text-center">
            <p className="text-xl font-bold text-primary">
              {loading ? '—' : topScore.toLocaleString()}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">top score</p>
          </div>
          <div className="bg-card px-3 py-4 text-center">
            <p className="text-xl font-bold">
              {loading ? '—' : totalSongs >= 1000 ? (totalSongs / 1000).toFixed(1) + 'K' : totalSongs}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">songs sung</p>
          </div>
          <div className="bg-card px-3 py-4 text-center">
            <p className="text-xl font-bold text-purple-500">
              {loading ? '—' : totalSingers}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">singers</p>
          </div>
        </div>

        {/* ── Top Performers ── */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
            <Trophy className="h-4 w-4 text-yellow-500 shrink-0" />
            <h2 className="font-semibold text-sm flex-1">Top performers</h2>
            <span className="text-[10px] text-muted-foreground">cumulative score</span>
          </div>
          <div className="py-1">
            {loading
              ? <><RowSkeleton /><RowSkeleton /><RowSkeleton /></>
              : performers.length === 0
                ? <EmptyState label="No performers yet. Be the first!" />
                : performers.map((p, i) => (
                    <div key={p.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors rounded-xl mx-1">
                      <RankIcon index={i} />
                      <div className={`h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                        i === 0 ? 'gradient-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}>
                        {p.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.username}</p>
                        <p className="text-xs text-muted-foreground">{p.songs_performed} song{p.songs_performed !== 1 ? 's' : ''}</p>
                      </div>
                      <p className="font-bold text-sm shrink-0">{p.total_score.toLocaleString()}</p>
                    </div>
                  ))}
          </div>
        </section>

        {/* ── Top Scores ── */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
            <Music className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-semibold text-sm flex-1">Top scores</h2>
            <span className="text-[10px] text-muted-foreground">single song best</span>
          </div>
          <div className="py-1">
            {loading
              ? <><RowSkeleton /><RowSkeleton /><RowSkeleton /></>
              : scores.length === 0
                ? <EmptyState label="No scores yet. Start singing!" />
                : scores.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors rounded-xl mx-1">
                      <RankIcon index={i} />
                      {s.thumbnail_url
                        ? <img src={s.thumbnail_url} alt="" className="h-11 w-11 rounded-lg object-cover shrink-0" loading="lazy" />
                        : <div className="h-11 w-11 rounded-lg bg-muted flex items-center justify-center shrink-0">
                            <Music className="h-4 w-4 text-muted-foreground" />
                          </div>}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{s.song_title}</p>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                          <span className="truncate">{s.display_name || 'Anonymous'}</span>
                          {s.city && (
                            <span className="flex items-center gap-0.5 shrink-0">
                              <MapPin className="h-3 w-3" />
                              <span className="truncate max-w-[60px]">{s.city}</span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`font-bold text-sm leading-tight ${RATING_COLOR[s.rating] || 'text-foreground'}`}>
                          {s.rating}
                        </p>
                        <p className="text-xs text-muted-foreground leading-tight">{s.score}</p>
                      </div>
                    </div>
                  ))}
          </div>
        </section>

      </main>
    </div>
  );
}
