// Shared golden-fixture base (SPEC §8): 4 projects, quiet baseline. Each
// fixture test overrides only what it names. These fixtures are the contract —
// editing them to make a test pass is the one unforgivable diff.
import type { Signals } from "@/lib/layout/signals";

// "Now" for the fixture world: 2026-08-07 → patent (2026-08-10) has days_left 3,
// album (2026-08-18) has 11, findit (2026-09-07) has 31.
export const FIXTURE_NOW = new Date("2026-08-07T09:00:00Z");

export function baseSignals(): Signals {
  return {
    projects: [
      {
        id: "patent",
        name: "patent",
        kind: "project",
        parent_id: null,
        deadline: "2026-08-10",
        deadline_type: "committed",
        days_left: 3,
        open_count: 4,
        done_count: 2,
        subprojects: [],
        people: ["Ash"],
      },
      {
        id: "album",
        name: "album",
        kind: "project",
        parent_id: null,
        deadline: "2026-08-18",
        deadline_type: "committed",
        days_left: 11,
        open_count: 6,
        done_count: 1,
        subprojects: [],
        people: ["Jazz"],
      },
      {
        id: "findit",
        name: "findit",
        kind: "project",
        parent_id: null,
        deadline: "2026-09-07",
        deadline_type: "inferred",
        days_left: 31,
        open_count: 3,
        done_count: 5,
        subprojects: [],
        people: [],
      },
      {
        id: "caltrans",
        name: "caltrans",
        kind: "project",
        parent_id: null,
        deadline: null,
        deadline_type: "none",
        days_left: null,
        open_count: 2,
        done_count: 0,
        subprojects: [],
        people: [],
      },
    ],
    tasks: [],
    engagement: {
      patent: { mentions_24h: 2, baseline_mentions: 2, last_touched: "2026-08-07T08:00:00Z" },
      album: { mentions_24h: 2, baseline_mentions: 2, last_touched: "2026-08-07T08:00:00Z" },
      findit: { mentions_24h: 1, baseline_mentions: 2, last_touched: "2026-08-06T18:00:00Z" },
      caltrans: { mentions_24h: 0, baseline_mentions: 2, last_touched: "2026-08-05T12:00:00Z" },
    },
    conversation: { today_topics: [], schedule_word_share: 0.05, questions_today: [] },
    pending: { items_missing_dates: ["ct-item-1", "ct-item-2"], unanswered_asks: [] },
    calendar: { next_hard_commitment: "evt-1", days_to_it: 2, density_14d: 0.3 },
    context: {
      date: "2026-08-07",
      weekday: "Friday",
      time_of_day: "morning",
      days_since_layout_change: 2,
      pinned_sections: [],
      calm_mode: false,
    },
  };
}
