// =============================================================================
// PartyLeaderboard.tsx
// CHANGELOG
// v1 -- NEW. Real-time leaderboard for Party mode.
//   Reads from the `scores` table filtered by stage_id (set when a song is
//   sung inside a party session). Aggregates per-singer: cumulative score,
//   songs sung, best single-song score, best rating.
//   Ranked by cumulative score descending.
//   Updates live via Supabase Realtime on the scores table.
//   Used in both PartyStage.tsx (host) and PartyQueue.tsx (participants).
//   Also handles the party-ended winner reveal overlay, triggered when
//   stages.is_active goes false via Realtime.
// =============================================================================

import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Trophy, Medal, Award, Mic2, Music } from "lucide-react";

interface PartyScore {
  id: string;
  display_name: string | null;
  score: number;
  rating: string;
  song_title: string;
  song_artist: string | null;
  created_at: string;
}

interface SingerStats {
  name: string;
  totalScore: number;
  songsSung: number;
  bestScore: number;
  bestRating: string;
}

const RATING_ORDER = ["L", "S", "A", "B", "C", "D", "F"];

const RATING_COLOR: Record<string, string> = {
  L: "text-yellow-400",
  S: "text-score-perfect",
  A: "text-score-great",
  B: "text-score-good",
  C: "text-score-ok",
  D: "text-score-ok",
  F: "text-score-miss",
};

function RankIcon({ index }: { index: number }) {
  if (index === 0) return <Trophy className="h-5 w-5 text-yellow-400" />;
  if (index === 1) return <Medal className="h-5 w-5 text-slate-400" />;
  if (index === 2) return <Award className="h-5 w-5 text-amber-600" />;
  return (
    <span className="text-sm font-bold text-muted-foreground w-5 text-center">
      {index + 1}
    </span>
  );
}

function Avatar({ name, index }: { name: string; index: number }) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <div
      className={`h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
        index === 0
          ? "bg-yellow-400/20 text-yellow-400 ring-2 ring-yellow-400/50"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {letter}
    </div>
  );
}

interface Props {
  stageId: string;
  currentSingerName?: string | null; // name of whoever is currently singing
  isPartyActive?: boolean; // false = party has ended
}

export function PartyLeaderboard({ stageId, currentSingerName, isPartyActive = true }: Props) {
  const [scores, setScores] = useState<PartyScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWinner, setShowWinner] = useState(false);

  // Fetch all scores for this party
  const fetchScores = async () => {
    const { data } = await supabase
      .from("scores")
      .select("id, display_name, score, rating, song_title, song_artist, created_at")
      .eq("stage_id", stageId)
      .order("created_at", { ascending: true });

    if (data) setScores(data as PartyScore[]);
    setLoading(false);
  };

  useEffect(() => {
    if (!stageId) return;
    fetchScores();

    // Live updates as singers finish songs
    const scoresChannel = supabase
      .channel(`party-leaderboard-${stageId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "scores", filter: `stage_id=eq.${stageId}` },
        fetchScores
      )
      .subscribe();

    return () => { supabase.removeChannel(scoresChannel); };
  }, [stageId]);

  // Show winner reveal when party ends
  useEffect(() => {
    if (isPartyActive === false && scores.length > 0) {
      setShowWinner(true);
    }
  }, [isPartyActive, scores.length]);

  // Aggregate scores per singer
  const leaderboard = useMemo((): SingerStats[] => {
    const map = new Map<string, SingerStats>();

    for (const s of scores) {
      const name = s.display_name || "Guest";
      const existing = map.get(name);
      const betterRating =
        !existing ||
        RATING_ORDER.indexOf(s.rating) < RATING_ORDER.indexOf(existing.bestRating);

      if (!existing) {
        map.set(name, {
          name,
          totalScore: s.score,
          songsSung: 1,
          bestScore: s.score,
          bestRating: s.rating,
        });
      } else {
        map.set(name, {
          ...existing,
          totalScore: existing.totalScore + s.score,
          songsSung: existing.songsSung + 1,
          bestScore: Math.max(existing.bestScore, s.score),
          bestRating: betterRating ? s.rating : existing.bestRating,
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => b.totalScore - a.totalScore);
  }, [scores]);

  const winner = leaderboard[0];

  return (
    <>
      {/* Winner reveal overlay */}
      {showWinner && winner && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur flex flex-col items-center justify-center p-6 animate-fade-in">
          <div className="text-center max-w-sm">
            <div className="text-6xl mb-4">🏆</div>
            <p className="text-muted-foreground text-sm mb-1">Tonight's Winner</p>
            <h2 className="text-4xl font-bold text-gradient mb-1">{winner.name}</h2>
            <p className="text-2xl font-semibold text-primary mb-1">
              {winner.totalScore.toLocaleString()} pts
            </p>
            <p className="text-sm text-muted-foreground mb-6">
              {winner.songsSung} song{winner.songsSung !== 1 ? "s" : ""} · Best:{" "}
              <span className={RATING_COLOR[winner.bestRating]}>{winner.bestRating}</span>
            </p>

            {/* Runner-up and third if present */}
            {leaderboard.length > 1 && (
              <div className="space-y-2 mb-6">
                {leaderboard.slice(1, 3).map((s, i) => (
                  <div key={s.name} className="flex items-center gap-3 bg-muted/50 rounded-xl px-4 py-2">
                    <RankIcon index={i + 1} />
                    <span className="flex-1 text-left font-medium text-sm">{s.name}</span>
                    <span className="text-sm text-muted-foreground">{s.totalScore.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setShowWinner(false)}
              className="text-sm text-muted-foreground underline"
            >
              See full leaderboard
            </button>
          </div>
        </div>
      )}

      {/* Leaderboard card */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Trophy className="h-4 w-4 text-yellow-400 shrink-0" />
          <h2 className="font-semibold text-sm">Party Leaderboard</h2>
          {currentSingerName && (
            <span className="ml-auto flex items-center gap-1 text-xs text-primary animate-pulse">
              <Mic2 className="h-3 w-3" />
              {currentSingerName} singing…
            </span>
          )}
        </div>

        <div className="px-2 py-2">
          {loading ? (
            <div className="space-y-2 p-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : leaderboard.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <Music className="h-8 w-8 opacity-30" />
              <p className="text-sm">No scores yet — start singing!</p>
            </div>
          ) : (
            leaderboard.map((singer, i) => (
              <div
                key={singer.name}
                className={`flex items-center gap-3 px-2 py-3 rounded-lg transition-colors ${
                  i === 0 ? "bg-yellow-400/5" : "hover:bg-muted/40"
                }`}
              >
                <div className="w-6 flex justify-center shrink-0">
                  <RankIcon index={i} />
                </div>
                <Avatar name={singer.name} index={i} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{singer.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {singer.songsSung} song{singer.songsSung !== 1 ? "s" : ""} · Best{" "}
                    <span className={RATING_COLOR[singer.bestRating]}>{singer.bestRating}</span>
                  </p>
                </div>
                <p className="font-bold text-sm shrink-0">
                  {singer.totalScore.toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>

        {/* Song-by-song breakdown */}
        {scores.length > 0 && (
          <details className="border-t border-border/60">
            <summary className="px-4 py-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none">
              Song by song ({scores.length})
            </summary>
            <div className="px-2 pb-2">
              {[...scores].reverse().map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-muted/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.song_title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {s.display_name || "Guest"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`font-bold text-sm leading-tight ${RATING_COLOR[s.rating] || ""}`}>
                      {s.rating}
                    </p>
                    <p className="text-xs text-muted-foreground leading-tight">{s.score}</p>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </>
  );
}
