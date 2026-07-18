// src/lib/__tests__/partyLeaderboard.test.ts
// Unit tests for the PartyLeaderboard aggregation logic.
// Tests the pure functions that aggregate per-singer stats from
// raw score rows — no DOM, no Supabase, no React needed.

import { describe, it, expect } from "vitest";

// ─── Inline the aggregation logic ─────────────────────────────────────────────
// Duplicated here rather than imported from the component so tests don't
// need a DOM environment. If the aggregation logic ever moves to a lib
// file, import from there instead.

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

function aggregateScores(scores: PartyScore[]): SingerStats[] {
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScore(overrides: Partial<PartyScore> & { score: number; rating: string }): PartyScore {
  return {
    id: Math.random().toString(36).slice(2),
    display_name: "Singer",
    song_title: "Test Song",
    song_artist: "Test Artist",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PartyLeaderboard aggregation", () => {

  describe("empty input", () => {
    it("returns empty array for no scores", () => {
      expect(aggregateScores([])).toEqual([]);
    });
  });

  describe("single singer", () => {
    it("correctly maps a single score", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 750, rating: "A" }),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Raj");
      expect(result[0].totalScore).toBe(750);
      expect(result[0].songsSung).toBe(1);
      expect(result[0].bestScore).toBe(750);
      expect(result[0].bestRating).toBe("A");
    });

    it("accumulates multiple songs for the same singer", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 750, rating: "A" }),
        makeScore({ display_name: "Raj", score: 600, rating: "B" }),
        makeScore({ display_name: "Raj", score: 820, rating: "S" }),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].totalScore).toBe(2170);
      expect(result[0].songsSung).toBe(3);
      expect(result[0].bestScore).toBe(820);
      expect(result[0].bestRating).toBe("S");
    });

    it("keeps the best rating, not the latest", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 900, rating: "S" }),
        makeScore({ display_name: "Raj", score: 400, rating: "D" }),
        makeScore({ display_name: "Raj", score: 300, rating: "F" }),
      ]);
      expect(result[0].bestRating).toBe("S");
    });

    it("upgrades best rating when a better one arrives", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 400, rating: "D" }),
        makeScore({ display_name: "Raj", score: 950, rating: "L" }),
      ]);
      expect(result[0].bestRating).toBe("L");
    });
  });

  describe("multiple singers", () => {
    it("ranks singers by total score descending", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 500, rating: "C" }),
        makeScore({ display_name: "Priya", score: 800, rating: "S" }),
        makeScore({ display_name: "Amit", score: 650, rating: "B" }),
      ]);
      expect(result[0].name).toBe("Priya");
      expect(result[1].name).toBe("Amit");
      expect(result[2].name).toBe("Raj");
    });

    it("correctly separates scores between different singers", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 500, rating: "C" }),
        makeScore({ display_name: "Priya", score: 800, rating: "S" }),
        makeScore({ display_name: "Raj", score: 700, rating: "A" }),
        makeScore({ display_name: "Priya", score: 600, rating: "B" }),
      ]);
      const raj = result.find(s => s.name === "Raj")!;
      const priya = result.find(s => s.name === "Priya")!;

      expect(raj.totalScore).toBe(1200);
      expect(raj.songsSung).toBe(2);
      expect(priya.totalScore).toBe(1400);
      expect(priya.songsSung).toBe(2);
    });

    it("places singer with higher total above one with higher single song", () => {
      // Priya sang one brilliant song; Raj sang many decent ones
      const result = aggregateScores([
        makeScore({ display_name: "Priya", score: 950, rating: "L" }),
        makeScore({ display_name: "Raj", score: 600, rating: "B" }),
        makeScore({ display_name: "Raj", score: 580, rating: "B" }),
        makeScore({ display_name: "Raj", score: 560, rating: "C" }),
      ]);
      // Raj total = 1740, Priya total = 950 → Raj wins on cumulative
      expect(result[0].name).toBe("Raj");
      expect(result[1].name).toBe("Priya");
    });
  });

  describe("null display_name handling", () => {
    it("falls back to 'Guest' for null display_name", () => {
      const result = aggregateScores([
        makeScore({ display_name: null, score: 500, rating: "C" }),
      ]);
      expect(result[0].name).toBe("Guest");
    });

    it("groups all null display_names under 'Guest'", () => {
      const result = aggregateScores([
        makeScore({ display_name: null, score: 500, rating: "C" }),
        makeScore({ display_name: null, score: 600, rating: "B" }),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Guest");
      expect(result[0].totalScore).toBe(1100);
      expect(result[0].songsSung).toBe(2);
    });

    it("keeps named and Guest singers separate", () => {
      const result = aggregateScores([
        makeScore({ display_name: null, score: 500, rating: "C" }),
        makeScore({ display_name: "Raj", score: 600, rating: "B" }),
      ]);
      expect(result).toHaveLength(2);
    });
  });

  describe("rating ordering", () => {
    it("L is better than S", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 500, rating: "S" }),
        makeScore({ display_name: "Raj", score: 500, rating: "L" }),
      ]);
      expect(result[0].bestRating).toBe("L");
    });

    it("F is the worst rating", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 100, rating: "F" }),
        makeScore({ display_name: "Raj", score: 200, rating: "D" }),
      ]);
      expect(result[0].bestRating).toBe("D");
    });

    it("correct full order: L > S > A > B > C > D > F", () => {
      const ratings = ["F", "D", "C", "B", "A", "S", "L"];
      // Feed them in worst-first order; best should always win
      const scores = ratings.map((rating, i) =>
        makeScore({ display_name: "Raj", score: 100 * (i + 1), rating })
      );
      const result = aggregateScores(scores);
      expect(result[0].bestRating).toBe("L");
    });
  });

  describe("score edge cases", () => {
    it("handles score of 0", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 0, rating: "F" }),
      ]);
      expect(result[0].totalScore).toBe(0);
      expect(result[0].bestScore).toBe(0);
    });

    it("handles maximum score of 1000", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 1000, rating: "L" }),
      ]);
      expect(result[0].totalScore).toBe(1000);
      expect(result[0].bestScore).toBe(1000);
    });

    it("bestScore tracks max, not latest", () => {
      const result = aggregateScores([
        makeScore({ display_name: "Raj", score: 900, rating: "S" }),
        makeScore({ display_name: "Raj", score: 200, rating: "D" }),
        makeScore({ display_name: "Raj", score: 500, rating: "C" }),
      ]);
      expect(result[0].bestScore).toBe(900);
    });
  });
});
