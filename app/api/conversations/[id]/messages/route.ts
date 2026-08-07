import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { getMessages } from "@/lib/db/queries";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";

const bodySchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(32000),
  mode: z.enum(["voice", "text"]),
});

async function ownedConversation(userId: string, id: string) {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  if (!(await ownedConversation(user.id, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ messages: await getMessages(user.id, id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  if (!(await ownedConversation(user.id, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const [message] = await db
    .insert(messages)
    .values({ userId: user.id, conversationId: id, ...parsed })
    .returning();
  return NextResponse.json({ id: message.id });
}
