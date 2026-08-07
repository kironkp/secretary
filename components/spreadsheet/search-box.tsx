"use client";

// Debounced cross-entity search over everything the secretary knows.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bookmark, Calendar, Check, MessageSquare } from "lucide-react";

type Results = {
  tasks: { id: string; title: string; status: string; dueAt: string | null; source: string }[];
  events: { id: string; title: string; startsAt: string; location: string | null }[];
  memories: { id: string; fact: string }[];
  messages: {
    id: string;
    conversationId: string;
    role: string;
    snippet: string;
    createdAt: string;
  }[];
};

const EMPTY: Results = { tasks: [], events: [], memories: [], messages: [] };

export function SearchBox() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>(EMPTY);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // clear any pending debounce on unmount
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onChange = (value: string) => {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    const query = value.trim();
    if (query.length < 2) {
      setResults(EMPTY);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (res.ok) setResults(await res.json());
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const total =
    results.tasks.length + results.events.length + results.memories.length + results.messages.length;
  const active = q.trim().length >= 2;

  return (
    <div className="space-y-3">
      <input
        value={q}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search everything — tasks, events, facts, conversations…"
        className="w-full rounded-xl border border-edge bg-surface-2 px-4 py-2.5 text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
      />
      {active && (
        <div className="rounded-xl border border-edge bg-surface p-4 text-sm">
          {searching && total === 0 ? (
            <p className="text-faint">Searching…</p>
          ) : total === 0 ? (
            <p className="text-faint">Nothing matches “{q.trim()}”.</p>
          ) : (
            <div className="space-y-3">
              {results.tasks.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Tasks</p>
                  {results.tasks.map((t) => (
                    <p key={t.id} className="mb-0.5 flex items-baseline gap-1.5">
                      <Check size={12} strokeWidth={2.5} className="flex-none translate-y-[1px] text-ok" />
                      {t.title}{" "}
                      <span className="text-xs text-faint">
                        · {t.status}
                        {t.dueAt &&
                          ` · due ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(t.dueAt))}`}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              {results.events.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Events</p>
                  {results.events.map((e) => (
                    <p key={e.id} className="mb-0.5 flex items-baseline gap-1.5">
                      <Calendar size={12} strokeWidth={1.75} className="flex-none translate-y-[1px] text-accent" />
                      {e.title}{" "}
                      <span className="text-xs text-faint">
                        {new Intl.DateTimeFormat("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(e.startsAt))}
                        {e.location ? ` · ${e.location}` : ""}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              {results.memories.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">
                    Known facts
                  </p>
                  {results.memories.map((m) => (
                    <p key={m.id} className="mb-0.5 flex items-baseline gap-1.5">
                      <Bookmark size={12} strokeWidth={2} className="flex-none translate-y-[1px] text-grape" />
                      {m.fact}
                    </p>
                  ))}
                </div>
              )}
              {results.messages.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">
                    From conversations
                  </p>
                  {results.messages.map((m) => (
                    <p key={m.id} className="mb-0.5">
                      <Link
                        href={`/chat?c=${m.conversationId}&m=${m.id}`}
                        className="flex items-baseline gap-1.5 hover:text-accent"
                      >
                        <MessageSquare size={12} strokeWidth={1.75} className="flex-none translate-y-[1px] text-faint" />
                        <span className="text-muted">“{m.snippet}”</span>{" "}
                        <span className="text-xs text-faint">
                          {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
                            new Date(m.createdAt)
                          )}
                        </span>
                      </Link>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
