import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getConversationWithMessages, getLatestConversation } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";
import { ChatThread } from "@/components/chat/chat-thread";
import { ChatWorkspace } from "@/components/chat/chat-workspace";
import { DashboardPanel } from "@/components/dashboard/dashboard-panel";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; m?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const userId = session.user.id;
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";

  const { c, m } = await searchParams;
  const [thread, briefing, [userRow]] = await Promise.all([
    c ? getConversationWithMessages(userId, c) : getLatestConversation(userId),
    buildBriefing(userId, timezone),
    db.select({ persona: user.persona }).from(user).where(eq(user.id, userId)),
  ]);
  const secretaryName = userRow?.persona?.name ?? "Secretary";
  const defaultVoice = userRow?.persona?.voice ?? "marin";

  return (
    <ChatWorkspace
      chat={
        <ChatThread
          initialConversationId={thread?.conversation.id ?? null}
          initialMessages={(thread?.messages ?? []).map((msg) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            mode: msg.mode,
          }))}
          briefing={briefing.card}
          anchorMessageId={m}
          secretaryName={secretaryName}
          defaultVoice={defaultVoice}
        />
      }
      dashboard={<DashboardPanel userId={userId} timezone={timezone} compact />}
    />
  );
}
