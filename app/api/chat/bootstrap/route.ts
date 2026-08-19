// Bootstrap for the floating chat panel: the same thread state the /chat page
// assembles server-side, fetched lazily when the panel first opens so every
// page doesn't pay for it. Nudges aren't consumed here — a passive panel-open
// isn't a session start; the budget stays with /chat and voice.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as userTable } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { getLatestConversation } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const [thread, briefing, [userRow]] = await Promise.all([
    getLatestConversation(user.id),
    buildBriefing(user.id, user.timezone),
    db.select({ persona: userTable.persona }).from(userTable).where(eq(userTable.id, user.id)),
  ]);
  return NextResponse.json({
    conversationId: thread?.conversation.id ?? null,
    messages: (thread?.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      mode: m.mode,
    })),
    briefing: briefing.card,
    secretaryName: userRow?.persona?.name ?? "Secretary",
    defaultVoice: userRow?.persona?.voice ?? "marin",
  });
}
