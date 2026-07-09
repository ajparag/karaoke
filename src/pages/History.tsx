import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Music, Calendar, Clock, Trash2, TrendingUp, ArrowLeft, Mic, Sun, Moon } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/hooks/useTheme';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { format } from 'date-fns';

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

export default function History() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { isDark, toggleTheme } = useTheme();
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalSongs: 0,
    averageScore: 0,
    bestScore: 0,
    totalTime: 0,
  });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
      return;
    }

    if (user) fetchScores();
  }, [user, authLoading, navigate]);

  const fetchScores = async () => {
    if (!user) return;

    setLoading(true);
    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setScores(data);
      
      if (data.length > 0) {
        const totalScore = data.reduce((sum, s) => sum + s.score, 0);
        const totalTime = data.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
        setStats({
          totalSongs: data.length,
          averageScore: Math.round(totalScore / data.length),
          bestScore: Math.max(...data.map(s => s.score)),
          totalTime,
        });
      }
    }
    setLoading(false);
  };

  const deleteScore = async (id: string) => {
    const { error } = await supabase.from('scores').delete().eq('id', id);
    
    if (error) {
      toast({ title: 'Failed to delete score', variant: 'destructive' });
    } else {
      setScores(scores.filter(s => s.id !== id));
      toast({ title: 'Score deleted' });
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getRatingColor = (rating: string) => {
    const colors: Record<string, string> = {
      'S': 'text-score-perfect bg-score-perfect/20',
      'A': 'text-score-great bg-score-great/20',
      'B': 'text-score-good bg-score-good/20',
      'C': 'text-score-ok bg-score-ok/20',
      'D': 'text-score-ok bg-score-ok/20',
      'F': 'text-score-miss bg-score-miss/20',
    };
    return colors[rating] || 'text-foreground bg-muted';
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="font-semibold text-xl">Your History</h1>
            <p className="text-sm text-muted-foreground">Track your singing journey</p>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="rounded-full" aria-label="Toggle theme">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={<Music className="h-5 w-5 text-primary" />} value={stats.totalSongs} label="Songs" />
          <StatCard icon={<TrendingUp className="h-5 w-5 text-accent" />} value={stats.averageScore} label="Avg Score" />
          <StatCard icon={<TrendingUp className="h-5 w-5 text-score-perfect" />} value={stats.bestScore} label="Best Score" />
          <StatCard icon={<Clock className="h-5 w-5 text-muted-foreground" />} value={formatDuration(stats.totalTime)} label="Total Time" />
        </div>

        {/* Score List */}
        <div className="bg-card border border-border rounded-xl p-4 md:p-6">
          <h2 className="font-semibold text-lg mb-4">Performance History</h2>
          
          {loading ? (
            <div className="space-y-3">
              {Array(3).fill(0).map((_, i) => (
                <div key={i} className="animate-shimmer h-20 rounded-lg" />
              ))}
            </div>
          ) : scores.length === 0 ? (
            <div className="text-center py-12">
              <Mic className="h-16 w-16 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No performances yet</h3>
              <p className="text-muted-foreground mb-4">Start singing to build your history!</p>
              <Link to="/">
                <Button className="gradient-primary text-primary-foreground">
                  <Music className="w-4 h-4 mr-2" />
                  Start Singing
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {scores.map((score) => (
                <div
                  key={score.id}
                  className="flex items-center gap-4 p-4 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  {score.thumbnail_url ? (
                    <img src={score.thumbnail_url} alt={score.song_title} className="h-14 w-14 rounded-lg object-cover" />
                  ) : (
                    <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center">
                      <Music className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{score.song_title}</h3>
                    {score.song_artist && (
                      <p className="text-sm text-muted-foreground truncate">{score.song_artist}</p>
                    )}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(score.created_at), 'MMM d, yyyy')}
                      </span>
                      {score.duration_seconds && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(score.duration_seconds)}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="text-right shrink-0">
                    <span className={`inline-block px-3 py-1 rounded-full text-sm font-bold ${getRatingColor(score.rating)}`}>
                      {score.rating}
                    </span>
                    <div className="text-sm text-muted-foreground mt-1">{score.score}</div>
                  </div>
                  
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive shrink-0">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this score?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete this performance from your history.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteScore(score.id)} className="bg-destructive text-destructive-foreground">
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  value: string | number;
  label: string;
}

const StatCard = ({ icon, value, label }: StatCardProps) => (
  <div className="bg-card border border-border rounded-xl p-4">
    <div className="flex items-center gap-3">
      <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold truncate">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  </div>
);
