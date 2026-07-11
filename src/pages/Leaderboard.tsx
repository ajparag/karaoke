import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useTheme } from '@/hooks/useTheme';
import { Trophy, Medal, Award, Music, ArrowLeft, MapPin, Sun, Moon } from 'lucide-react';

interface LeaderboardEntry {
  id: string;
  username: string;
  total_score: number;
  songs_performed: number;
  avatar_url: string | null;
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
        .select('id, username, total_score, songs_performed, avatar_url')
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

  const getRankIcon = (index: number) => {
    if (index === 0) return <Trophy className="h-6 w-6 text-score-perfect" />;
    if (index === 1) return <Medal className="h-6 w-6 text-muted-foreground" />;
    if (index === 2) return <Award className="h-6 w-6 text-score-ok" />;
    return <span className="text-lg font-bold text-muted-foreground">{index + 1}</span>;
  };

  const getRatingColor = (rating: string) => {
    const colors: Record<string, string> = {
      'S': 'text-score-perfect',
      'A': 'text-score-great',
      'B': 'text-score-good',
      'C': 'text-score-ok',
      'D': 'text-score-ok',
      'F': 'text-score-miss',
    };
    return colors[rating] || 'text-foreground';
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="glass border-b border-border py-4 px-4 md:px-8 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex items-center gap-4">
          <Link to="/" className="shrink-0">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold text-xl">Leaderboard</h1>
            <p className="text-sm text-muted-foreground">Top performers worldwide</p>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="rounded-full" aria-label="Toggle theme">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto py-4 px-4 md:py-8 md:px-8">
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Top Users */}
          <div className="bg-card border border-border rounded-xl p-4 md:p-6">
            <div className="flex items-center gap-2 mb-4 md:mb-6">
              <Trophy className="h-5 w-5 text-score-perfect shrink-0" />
              <h2 className="font-semibold text-lg">Top Performers</h2>
            </div>
            
            <div className="space-y-3">
              {loading ? (
                Array(5).fill(0).map((_, i) => (
                  <div key={i} className="animate-shimmer h-16 rounded-lg" />
                ))
              ) : topUsers.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Music className="h-12 w-12 mx-auto mb-4 opacity-30" />
                  <p>No scores yet. Be the first!</p>
                </div>
              ) : (
                topUsers.map((user, index) => (
                  <div
                    key={user.id}
                    className={`flex items-center gap-3 md:gap-4 p-2 md:p-3 rounded-xl transition-colors ${
                      index < 3 ? 'bg-muted/50' : 'hover:bg-muted/30'
                    }`}
                  >
                    <div className="w-8 flex justify-center shrink-0">{getRankIcon(index)}</div>
                    <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${
                      index === 0 ? 'gradient-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                    }`}>
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{user.username}</div>
                      <div className="text-sm text-muted-foreground">{user.songs_performed} songs</div>
                    </div>
                    <div className="text-lg font-bold shrink-0">{user.total_score.toLocaleString()}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Top Scores */}
          <div className="bg-card border border-border rounded-xl p-4 md:p-6">
            <div className="flex items-center gap-2 mb-4 md:mb-6">
              <Music className="h-5 w-5 text-primary shrink-0" />
              <h2 className="font-semibold text-lg">Top Scores</h2>
            </div>
            
            <div className="space-y-3">
              {loading ? (
                Array(5).fill(0).map((_, i) => (
                  <div key={i} className="animate-shimmer h-16 rounded-lg" />
                ))
              ) : topScores.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Music className="h-12 w-12 mx-auto mb-4 opacity-30" />
                  <p>No scores yet. Be the first!</p>
                </div>
              ) : (
                topScores.map((score, index) => (
                  <div
                    key={score.id}
                    className={`flex items-center gap-3 md:gap-4 p-2 md:p-3 rounded-xl transition-colors ${
                      index < 3 ? 'bg-muted/50' : 'hover:bg-muted/30'
                    }`}
                  >
                    <div className="w-8 flex justify-center shrink-0">{getRankIcon(index)}</div>
                    {score.thumbnail_url ? (
                      <img src={score.thumbnail_url} alt={score.song_title} className="h-12 w-12 rounded-lg object-cover shrink-0" />
                    ) : (
                      <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Music className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{score.song_title}</div>
                      <div className="text-sm text-muted-foreground flex items-center gap-1 min-w-0">
                        <span className="truncate">{score.display_name || 'Anonymous'}</span>
                        {score.city && (
                          <span className="flex items-center gap-0.5 text-xs shrink-0">
                            <MapPin className="h-3 w-3" />
                            <span className="truncate max-w-[80px]">{score.city}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className={`text-xl font-bold ${getRatingColor(score.rating)}`}>{score.rating}</span>
                      <div className="text-sm text-muted-foreground">{score.score}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
