import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
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
  const thread = c
    ? await getConversationWithMessages(userId, c)
    : await getLatestConversation(userId);
  const briefing = await buildBriefing(userId, timezone);

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
        />
      }
      dashboard={<DashboardPanel userId={userId} timezone={timezone} compact />}
    />
  );
}
