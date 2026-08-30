// Bootstrap for the chat dock (SPEC §7.7): thread + briefing + persona,
// fetched once after paint so no page load waits on it. ?c= loads a specific
// conversation (push-receipt deep links). Nudges aren't consumed here — a
// passive dock mount isn't a session start; the budget stays with voice.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as userTable } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { getActiveConversation, getConversationWithMessages } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const c = new URL(req.url).searchParams.get("c");
  // getActiveConversation (not Latest): a thread idle >6h rolls over — the
  // panel opens fresh and the old thread becomes a quotable prior session.
  const [thread, briefing, [userRow]] = await Promise.all([
    c ? getConversationWithMessages(user.id, c) : getActiveConversation(user.id),
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
      attachments: m.attachments,
    })),
    briefing: briefing.card,
    secretaryName: userRow?.persona?.name ?? "Secretary",
    defaultVoice: userRow?.persona?.voice ?? "marin",
    voiceEffort: userRow?.persona?.voiceEffort ?? "auto",
    chatModel: userRow?.persona?.chatModel ?? "gpt-5.5",
    chatEffort: userRow?.persona?.chatEffort ?? "medium",
  });
}
