// =============================================================================
// CHANGELOG
// v1 -- NEW. Host control screen for a Party. Shows the live shared queue
//   (realtime), lets the host remove any song, and "Play Next" hands off to
//   the existing solo Sing.tsx flow (reused as-is via sessionStorage
//   'selectedTrack', same mechanism the homepage search already uses).
//
// Pre-separation: while the current song plays, the NEXT queued song is
// separated and fully cached to IndexedDB in the background (same technique
// Sing.tsx uses after buffering) so that when the host taps "Play Next" for
// it, playback starts instantly instead of waiting through another 20-30s
// separation. Fire-and-forget; failures are non-fatal since Sing.tsx will
// just separate normally (with the usual wait) if pre-caching didn't finish
// or failed.
// =============================================================================

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useVocalSeparation } from "@/hooks/useVocalSeparation";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";
import { saveCachedTracks, getCachedTracks } from "@/lib/audioCache";
import { ArrowLeft, Copy, Check, Play, X, Music, Loader2, PartyPopper, Share2, HelpCircle } from "lucide-react";

interface QueueItem {
  id: string;
  track_id: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  audio_url: string;
  duration_seconds: number | null;
  language: string | null;
  album: string | null;
  singer_name: string;
  device_id: string;
  position: number;
  status: "queued" | "ready" | "singing" | "completed" | "skipped";
  score: number | null;
  rating: string | null;
}

export default function PartyStage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { separateVocals } = useVocalSeparation();

  const [stageId, setStageId] = useState<string | null>(null);
  const [stageName, setStageName] = useState("");
  const [isHost, setIsHost] = useState<boolean | null>(null); // null = checking
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const preSeparateTriggeredRef = useRef<Set<string>>(new Set());

  // Load stage + verify host identity
  useEffect(() => {
    if (authLoading || !code) return;

    const load = async () => {
      const { data, error } = await supabase
        .from("stages")
        .select("id, name, host_user_id, is_active")
        .eq("code", code.toUpperCase())
        .maybeSingle();

      if (error || !data || !data.is_active) {
        toast({ title: "Party not found", description: "This party may have ended", variant: "destructive" });
        navigate("/");
        return;
      }

      if (!user || user.id !== data.host_user_id) {
        toast({ title: "Not your party", description: "Only the host can control this party", variant: "destructive" });
        navigate("/");
        return;
      }

      setStageId(data.id);
      setStageName(data.name);
      setIsHost(true);
      setLoading(false);
    };

    load();
  }, [code, user, authLoading, navigate, toast]);

  // Realtime queue subscription
  useEffect(() => {
    if (!stageId) return;

    const fetchQueue = async () => {
      const { data } = await supabase
        .from("stage_queue")
        .select("*")
        .eq("stage_id", stageId)
        .order("position", { ascending: true });
      if (data) setQueue(data as QueueItem[]);
    };

    fetchQueue();

    const channel = supabase
      .channel(`stage-queue-${stageId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "stage_queue", filter: `stage_id=eq.${stageId}` }, fetchQueue)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [stageId]);

  // Pre-separation: whenever the queue changes, find the next 'queued' song
  // that comes right after whatever is currently 'singing' (or the first
  // queued song if nothing is playing yet) and warm its cache in the
  // background. Runs at most once per track (tracked via a ref set).
  useEffect(() => {
    const nextQueued = queue.find((q) => q.status === "queued");
    if (!nextQueued) return;
    if (preSeparateTriggeredRef.current.has(nextQueued.id)) return;

    preSeparateTriggeredRef.current.add(nextQueued.id);

    (async () => {
      try {
        const alreadyCached = await getCachedTracks(nextQueued.audio_url);
        if (alreadyCached) return; // already warm, nothing to do

        const result = await separateVocals(nextQueued.audio_url);
        if (!result || result.fromCache) return;

        const instResp = await fetch(result.instrumentalUrl);
        const instBlob = await instResp.blob();
        let vocBlob: Blob | undefined;
        if (result.vocalsUrl) {
          const vocResp = await fetch(result.vocalsUrl);
          vocBlob = await vocResp.blob();
        }
        await saveCachedTracks(nextQueued.audio_url, instBlob, vocBlob);
        console.log("[Party] Pre-separated and cached:", nextQueued.song_title);
      } catch (e) {
        console.warn("[Party] Pre-separation failed (non-fatal):", e);
      }
    })();
  }, [queue, separateVocals]);

  const handleCopyCode = () => {
    if (!code) return;
    navigator.clipboard.writeText(code.toUpperCase());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareCode = async () => {
    if (!code) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}#/party/${code.toUpperCase()}/queue`;
    const shareText = `Join my KaraokeParty! Code: ${code.toUpperCase()}\n${shareUrl}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: `${stageName} -- KaraokeParty`, text: shareText, url: shareUrl });
      } catch {
        // User cancelled the share sheet -- not an error, do nothing
      }
    } else {
      // No native share support (desktop browsers) -- fall back to copy
      navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Link copied", description: "Paste it to share with friends" });
    }
  };

  const handleRemove = async (id: string) => {
    await supabase.from("stage_queue").delete().eq("id", id);
  };

  const handlePlayNext = useCallback(async (item: QueueItem) => {
    setStartingId(item.id);

    await supabase.from("stage_queue").update({ status: "singing" }).eq("id", item.id);

    // Build the same Track shape the homepage search produces, so Sing.tsx
    // can consume it via the exact same sessionStorage mechanism.
    const track = {
      id: item.track_id,
      title: item.song_title,
      artist: item.song_artist || "",
      thumbnail: item.thumbnail_url || "",
      duration: item.duration_seconds ? String(item.duration_seconds) : "",
      source: "saavn" as const,
      audioUrl: item.audio_url,
      album: item.album || undefined,
      language: item.language || undefined,
    };

    sessionStorage.setItem("selectedTrack", JSON.stringify(track));
    sessionStorage.setItem("activePartyContext", JSON.stringify({ code: code?.toUpperCase(), queueId: item.id, singerName: item.singer_name }));

    sessionStorage.removeItem("prefetchedLyrics");
    fetchLyricsCached({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: parseDurationToSeconds(track.duration),
      language: track.language,
    }).then((result) => {
      if (result?.lyrics?.length > 0) {
        sessionStorage.setItem("prefetchedLyrics", JSON.stringify(result.lyrics));
      }
    }).catch(() => {});

    navigate(`/sing/${track.id}`);
  }, [code, navigate]);

  const handleEndParty = async () => {
    if (!stageId) return;
    await supabase.from("stages").update({ is_active: false }).eq("id", stageId);
    navigate("/");
  };

  if (loading || isHost === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  const queuedSongs = queue.filter((q) => q.status === "queued");
  const singingSong = queue.find((q) => q.status === "singing");
  const completedSongs = queue.filter((q) => q.status === "completed").sort((a, b) => (b.score || 0) - (a.score || 0));

  return (
    <div className="min-h-screen bg-background">
      <header className="glass border-b border-border p-4 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto flex items-center gap-4">
          <Link to="/">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button>
          </Link>
          <div className="flex-1">
            <h1 className="font-semibold text-xl flex items-center gap-2">
              <PartyPopper className="w-5 h-5 text-primary" /> {stageName}
            </h1>
            <p className="text-sm text-muted-foreground">You're hosting -- only you can play songs</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleEndParty}>End Party</Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-6">
        {/* Join code */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Share this code with friends</p>
                <p className="text-3xl font-bold tracking-[0.3em] text-gradient">{code?.toUpperCase()}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleCopyCode}>
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
                <Button size="sm" className="gradient-primary text-primary-foreground" onClick={handleShareCode}>
                  <Share2 className="w-4 h-4 mr-2" /> Share
                </Button>
              </div>
            </div>
            <button
              onClick={() => setShowHelp((s) => !s)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <HelpCircle className="w-3.5 h-3.5" /> How does this work?
            </button>
            {showHelp && (
              <div className="mt-2 text-xs text-muted-foreground space-y-1 bg-muted/50 rounded-lg p-3">
                <p>1. Share the code or link above with your friends.</p>
                <p>2. They tap "Join Party" and enter the code (or open your link) on their own phone.</p>
                <p>3. They search and add songs to the queue -- with their name attached.</p>
                <p>4. Only you play each song here on this screen. Hand the mic around as songs play!</p>
                <p>5. Everyone sees live scores as each song finishes.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Now playing / next up */}
        {singingSong ? (
          <Card className="border-primary">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">Currently on stage</p>
              <p className="font-semibold">{singingSong.song_title}</p>
              <p className="text-sm text-muted-foreground">{singingSong.singer_name} is singing</p>
            </CardContent>
          </Card>
        ) : queuedSongs.length > 0 ? (
          <Card className="border-primary">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground mb-1">Up next</p>
                <p className="font-semibold truncate">{queuedSongs[0].song_title}</p>
                <p className="text-sm text-muted-foreground truncate">{queuedSongs[0].singer_name}</p>
              </div>
              <Button
                className="gradient-primary text-primary-foreground shrink-0"
                onClick={() => handlePlayNext(queuedSongs[0])}
                disabled={startingId === queuedSongs[0].id}
              >
                {startingId === queuedSongs[0].id ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                Play
              </Button>
            </CardContent>
          </Card>
        ) : (
          <p className="text-center text-sm text-muted-foreground py-6">
            No songs queued yet. Share the code above so friends can add some!
          </p>
        )}

        {/* Rest of queue */}
        {queuedSongs.length > 1 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2 px-1">Queue ({queuedSongs.length - 1} more)</p>
            <div className="space-y-1">
              {queuedSongs.slice(1).map((item) => (
                <div key={item.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                  <div className="w-10 h-10 rounded-lg bg-muted shrink-0 flex items-center justify-center overflow-hidden">
                    {item.thumbnail_url ? (
                      <img src={item.thumbnail_url} alt="" className="w-full h-full object-cover" />
                    ) : <Music className="w-4 h-4 text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.song_title}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.singer_name}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => handleRemove(item.id)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed / scores tonight */}
        {completedSongs.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2 px-1">Tonight's Scores</p>
            <div className="space-y-1">
              {completedSongs.map((item, i) => (
                <div key={item.id} className="flex items-center gap-3 p-2 rounded-lg">
                  <span className="text-sm font-bold text-muted-foreground w-5">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.singer_name}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.song_title}</p>
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
