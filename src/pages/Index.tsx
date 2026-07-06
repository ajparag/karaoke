// =============================================================================
// CHANGELOG
// =============================================================================
// v1 (original) — Lyrics dialog popup on Index.tsx: selected track → popup →
//   fetch lyrics with searchMultiple:true → show results → user picks → navigate
//
// v2 — CURRENT: Removed lyrics popup entirely from Index.tsx
//
//   ROOT CAUSE of lyrics not working:
//   1. Index.tsx called fetchLyricsCached({ searchMultiple: true }) expecting
//      { results: [...] } from the edge function.
//   2. The edge function ONLY returns { lyrics: [...] } — no searchMultiple
//      code path exists. So data.results was always undefined.
//   3. fetchedLyrics stayed [] → sessionStorage stored [] → popup blocked user.
//   4. User couldn't click "Start Singing" because lyrics appeared empty.
//
//   FIX: Remove the popup. When user selects a track:
//   - Navigate directly to /sing/:id
//   - Sing.tsx fetches lyrics itself using { lyrics: [...] } shape (correct)
//   - Sing.tsx already handles loading state and lyricsNotFound gracefully
//   This is the "background fetch" architecture already implemented in Sing.tsx.
// =============================================================================

import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Music, Trophy, Loader2, Play, Search, LogOut, User, Sun, Moon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useVocalSeparation, prefetchAudio, warmUpHFSpace } from "@/hooks/useVocalSeparation";
import { fetchLyricsCached, parseDurationToSeconds } from "@/lib/lyricsClient";
import { useAuth } from "@/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: string;
  source: "saavn";
  audioUrl: string;
  album?: string;
  language?: string; // "hindi", "punjabi", "english", etc. from Saavn
  releaseDate?: string; // "YYYY-MM-DD" from Saavn
  year?: number; // 4-digit release year -- more reliably populated than releaseDate
}

const Index = () => {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, signOut } = useAuth();

  // AI vocal separation (starts in background when track is selected)
  const { isProcessing: isSeparating, progress: separationProgress, separatedAudio, separateVocals, reset: resetSeparation } = useVocalSeparation();
  const separationStartedRef = useRef(false);

  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [trendingSongs, setTrendingSongs] = useState<string[]>([]);

  // Theme toggle -- persisted in localStorage, defaults to light.
  // Sing page forces dark independently; this only affects browse pages.
  const [isDark, setIsDark] = useState(() => {
    return localStorage.getItem('theme') === 'dark';
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  // Clean up: remove dark class when navigating away (Sing page manages its own)
  useEffect(() => {
    return () => {
      if (!isDark) {
        document.documentElement.classList.remove('dark');
      }
    };
  }, [isDark]);

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      {/* Leave confirmation dialog (back pressed during separation) */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Your song is being prepared</AlertDialogTitle>
            <AlertDialogDescription>
              AI is separating the vocals right now. Leaving will cancel this. Are you sure you want to leave?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingConfirmLeaveRef.current?.()}>
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Header: logo + title + controls */}
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <img src="/karaoke-logo.png" alt="KaraokeParty" className="w-9 h-9" />
          <h1 className="text-xl font-bold">
            <span className="text-gradient">Karaoke</span>
            <span className="text-foreground">Party</span>
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsDark(d => !d)}
            className="rounded-full h-9 w-9"
            aria-label="Toggle theme"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="relative h-9 w-9 rounded-full">
                  <Avatar className="h-9 w-9">
                    <AvatarFallback className="gradient-primary text-primary-foreground text-sm">
                      {user.email?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem className="gap-2">
                  <User className="h-4 w-4" />
                  <span className="truncate">{user.email}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={signOut} className="gap-2 text-destructive">
                  <LogOut className="h-4 w-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link to="/auth">
              <Button size="sm" className="gradient-primary text-primary-foreground text-xs h-9">Sign In</Button>
            </Link>
          )}
        </div>
      </header>

      {/* Tagline */}
      <p className="text-center text-sm text-muted-foreground px-6 mb-3">
        Pick any song. AI removes the singer in seconds. Lyrics light up as you sing.
        <br className="hidden sm:block" />
        Get scored on pitch, rhythm and technique. Challenge your friends.
      </p>

      {/* Search bar */}
      <div className="px-4 mb-3">
        <div className="max-w-xl mx-auto flex gap-2">
          <Input
            type="text"
            placeholder="Search any song..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-1 bg-muted border-border h-11 text-sm rounded-full px-4"
          />
          <Button
            onClick={handleSearch}
            disabled={isLoading || !query.trim()}
            size="icon"
            className="gradient-primary text-primary-foreground h-11 w-11 rounded-full shrink-0"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Search className="w-5 h-5" />
            )}
          </Button>
        </div>
      </div>

      {/* Trending tags */}
      <div className="px-4 mb-3">
        <div className="max-w-xl mx-auto flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            {isLoadingTrending ? "Loading..." : "Trending:"}
          </span>
          {isLoadingTrending ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-7 w-20 rounded-full bg-muted animate-pulse" />
            ))
          ) : (
            trendingSongs.map((term) => (
              <Button
                key={term}
                variant="outline"
                size="sm"
                onClick={() => { setQuery(term); searchWithQuery(term); }}
                className="border-border hover:bg-muted text-xs h-7 rounded-full px-3"
              >
                {term}
              </Button>
            ))
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border mx-4" />

      {/* Results / empty state */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="max-w-xl mx-auto">
          {isLoading ? (
            <div className="py-8 text-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Searching...</p>
            </div>
          ) : hasSearched && tracks.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">No results found. Try different keywords.</p>
          ) : tracks.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                {tracks.length} result{tracks.length !== 1 ? "s" : ""}
              </p>
              <div className="space-y-1">
                {tracks.map((track) => (
                  <div
                    key={track.id}
                    className="group flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => handleSelectTrack(track)}
                    onMouseEnter={() => { if (track.audioUrl) prefetchAudio(track.audioUrl); }}
                  >
                    {/* Thumbnail */}
                    <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-muted shrink-0">
                      {track.thumbnail ? (
                        <img src={track.thumbnail} alt={track.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className="w-5 h-5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-background/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Play className="w-5 h-5 text-primary fill-primary" />
                      </div>
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                        {track.title}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {track.artist} {track.duration ? `\u00B7 ${track.duration}` : ''}
                        {track.playCount ? ` \u00B7 ${track.playCount >= 10000000 ? (track.playCount / 10000000).toFixed(1) + 'Cr' : track.playCount >= 100000 ? (track.playCount / 100000).toFixed(1) + 'L' : track.playCount >= 1000 ? (track.playCount / 1000).toFixed(0) + 'K' : track.playCount}` : ''}
                      </p>
                    </div>

                    {/* Sing button */}
                    <Button
                      size="sm"
                      className="gradient-primary text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-xs h-8 rounded-full px-4"
                    >
                      Sing
                    </Button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            /* Empty state - show nav links when no search */
            <div className="flex flex-col items-center gap-3 py-8">
              <Link to="/leaderboard">
                <Button variant="outline" size="sm" className="gap-2">
                  <Trophy className="w-4 h-4" /> Leaderboard
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Compact footer */}
      <footer className="py-2 px-4 border-t border-border text-center text-muted-foreground text-xs">
        made with love by parag.airun@gmail.com
      </footer>
    </div>
  );
};


export default Index;
