// =============================================================================
// CHANGELOG
// v1 -- NEW. Participant view for a Party: search and add songs to the
//   shared queue, see what's playing/up next, remove songs THEY added
//   (tracked via a per-browser device ID, not a real auth check -- see the
//   schema migration's CHANGELOG for the trust-model rationale). No
//   playback happens here; only the host's PartyStage.tsx plays songs.
// =============================================================================

import { useEffect, useState, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { getDeviceId, getGuestName } from "@/hooks/usePartyDevice";
import { ArrowLeft, Search, Music, Plus, X, Loader2, PartyPopper, Check } from "lucide-react";

interface SearchTrack {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  audioUrl: string;
  album?: string;
  language?: string;
}

interface QueueItem {
  id: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  singer_name: string;
  device_id: string;
  status: "queued" | "ready" | "singing" | "completed" | "skipped";
  score: number | null;
  rating: string | null;
}

export default function PartyQueue() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [stageId, setStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [myName, setMyName] = useState("");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addedId, setAddedId] = useState<string | null>(null);

  const [queue, setQueue] = useState<QueueItem[]>([]);

  const deviceId = getDeviceId();

  useEffect(() => {
    if (authLoading || !code) return;

    const displayName = user
      ? (user.user_metadata?.username || user.user_metadata?.full_name || "Singer")
      : getGuestName(code.toUpperCase());

    if (!displayName) {
      // No name on file (e.g. deep-linked without going through Join) --
      // send them through the join flow to collect one first.
      navigate("/party/join");
      return;
    }
    setMyName(displayName);

    const load = async () => {
      const { data } = await supabase
        .from("stages")
        .select("id, name, is_active")
        .eq("code", code.toUpperCase())
        .maybeSingle();

      if (!data || !data.is_active) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setStageId(data.id);
      setStageName(data.name);
      setLoading(false);
    };
    load();
  }, [code, user, authLoading]);

  useEffect(() => {
    if (!stageId) return;
    const fetchQueue = async () => {
      const { data } = await supabase
        .from("stage_queue")
        .select("id, song_title, song_artist, thumbnail_url, singer_name, device_id, status, score, rating")
        .eq("stage_id", stageId)
        .order("position", { ascending: true });
      if (data) setQueue(data as QueueItem[]);
    };
    fetchQueue();
    const channel = supabase
      .channel(`stage-queue-participant-${stageId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stage_queue", filter: `stage_id=eq.${stageId}` }, fetchQueue)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [stageId]);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setIsSearching(true);
    try {
      const { data, error } = await supabase.functions.invoke("search-music", { body: { query: query.trim(), limit: 15 } });
      if (error) throw error;
      setResults(data?.tracks || []);
    } catch {
      toast({ title: "Search failed", description: "Please try again", variant: "destructive" });
    } finally {
      setIsSearching(false);
    }
  }, [query, toast]);

  const handleAdd = async (track: SearchTrack) => {
    if (!stageId) return;
    setAddedId(track.id);
    const { error } = await supabase.from("stage_queue").insert({
      stage_id: stageId,
      track_id: track.id,
      song_title: track.title,
      song_artist: track.artist,
      thumbnail_url: track.thumbnail,
      audio_url: track.audioUrl,
      duration_seconds: track.duration ? parseInt(track.duration, 10) || null : null,
      language: track.language || null,
      album: track.album || null,
      singer_name: myName,
      device_id: deviceId,
      status: "queued",
    });
    if (error) {
      toast({ title: "Could not add song", variant: "destructive" });
      setAddedId(null);
    } else {
      toast({ title: "Added to queue!" });
      setTimeout(() => setAddedId(null), 1500);
    }
  };

  const handleRemove = async (id: string) => {
    await supabase.from("stage_queue").delete().eq("id", id);
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4 p-4">
        <p className="text-muted-foreground">This party doesn't exist or has ended.</p>
        <Link to="/"><Button variant="outline">Back to Home</Button></Link>
      </div>
    );
  }

  const singingSong = queue.find((q) => q.status === "singing");
  const queuedSongs = queue.filter((q) => q.status === "queued");
  const completedSongs = queue.filter((q) => q.status === "completed").sort((a, b) => (b.score || 0) - (a.score || 0));

  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <Link to="/"><Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button></Link>
          <div>
            <h1 className="font-semibold text-lg flex items-center gap-2">
              <PartyPopper className="w-4 h-4 text-primary" /> {stageName}
            </h1>
            <p className="text-xs text-muted-foreground">Singing as {myName}</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4 space-y-5">
        {/* Search + add */}
        <div className="flex gap-2">
          <Input
            placeholder="Search a song to add..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="rounded-full"
          />
          <Button onClick={handleSearch} disabled={isSearching || !query.trim()} size="icon" className="gradient-primary text-primary-foreground rounded-full shrink-0">
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>

        {results.length > 0 && (
          <div className="space-y-1">
            {results.map((track) => (
              <div key={track.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                <div className="w-10 h-10 rounded-lg bg-muted shrink-0 overflow-hidden">
                  {track.thumbnail ? <img src={track.thumbnail} alt="" className="w-full h-full object-cover" /> : <Music className="w-4 h-4 m-3 text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{track.artist}</p>
                </div>
                <Button size="sm" variant="outline" className="shrink-0 h-8" onClick={() => handleAdd(track)} disabled={addedId === track.id}>
                  {addedId === track.id ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Now playing */}
        {singingSong && (
          <Card className="border-primary">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground mb-1">On stage now</p>
              <p className="font-medium text-sm">{singingSong.song_title} -- {singingSong.singer_name}</p>
            </CardContent>
          </Card>
        )}

        {/* Queue */}
        {queuedSongs.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2 px-1">Up next ({queuedSongs.length})</p>
            <div className="space-y-1">
              {queuedSongs.map((item) => (
                <div key={item.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                  <div className="w-9 h-9 rounded-lg bg-muted shrink-0 overflow-hidden">
                    {item.thumbnail_url ? <img src={item.thumbnail_url} alt="" className="w-full h-full object-cover" /> : <Music className="w-3 h-3 m-3 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.song_title}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.singer_name}</p>
                  </div>
                  {item.device_id === deviceId && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleRemove(item.id)}>
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {completedSongs.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2 px-1">Tonight's Scores</p>
            <div className="space-y-1">
              {completedSongs.map((item, i) => (
                <div key={item.id} className="flex items-center gap-3 p-2 rounded-lg">
                  <span className="text-sm font-bold text-muted-foreground w-5">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.singer_name}</p>
                  </div>
                  <span className="text-sm font-semibold text-primary shrink-0">{item.rating} · {item.score}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
