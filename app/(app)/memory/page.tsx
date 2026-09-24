// Memory: what Secretary keeps between conversations, where the user can see
// it and forget any of it. Server component: both lists are read once for the
// first paint; the client only removes rows after that.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { memories, pipelineTemplates, standingCheckins } from "@/lib/db/schema";
import { daysInWords } from "@/lib/secretary/checkins";
import { MemoryView } from "@/components/memory/memory-view";

export default async function MemoryPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const userId = session.user.id;
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";

  const [processRows, factRows, checkinRows] = await Promise.all([
    db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, userId))
      .orderBy(desc(pipelineTemplates.createdAt)),
    db
      .select({ id: memories.id, fact: memories.fact, tags: memories.tags, createdAt: memories.createdAt })
      .from(memories)
      .where(eq(memories.userId, userId))
      .orderBy(desc(memories.createdAt)),
    db
      .select()
      .from(standingCheckins)
      .where(eq(standingCheckins.userId, userId))
      .orderBy(desc(standingCheckins.createdAt)),
  ]);

  // Dates are written here, in the user's timezone, so the client never
  // formats its own and disagrees with this render on hydration.
  const now = new Date();
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(d);
  const thisYear = year(now);
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      ...(year(d) === thisYear ? {} : { year: "numeric" }),
    }).format(d);

  return (
    <MemoryView
      processes={processRows.map((p) => ({
        id: p.id,
        name: p.name,
        recurrence: p.recurrence,
        steps: Array.isArray(p.steps) ? p.steps : [],
      }))}
      checkins={checkinRows.map((c) => ({ id: c.id, question: c.question, days: daysInWords(c.days) }))}
      facts={factRows.map((f) => ({
        id: f.id,
        fact: f.fact,
        tags: Array.isArray(f.tags) ? f.tags : [],
        date: fmt(f.createdAt),
      }))}
    />
  );
}
