// Phase 9 search: one query across tasks, events, memories, and transcripts.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { searchAll } from "@/lib/db/queries";

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ tasks: [], events: [], memories: [], messages: [] });

  const results = await searchAll(user.id, q.slice(0, 200));
  return NextResponse.json({
    tasks: results.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt,
      source: t.source,
    })),
    events: results.events.map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      location: e.location,
    })),
    memories: results.memories.map((m) => ({ id: m.id, fact: m.fact })),
    messages: results.messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      snippet: m.content.slice(0, 160),
      createdAt: m.createdAt,
    })),
  });
}
