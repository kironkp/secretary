// Connected accounts plane: the site login is better-auth; THIS is where a
// signed-in user connects their own model-provider account (Claude first).
// Keys are validated with a live no-cost call, stored AES-GCM encrypted, and
// only ever surfaced as a 4-char tail.
import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { connectedAccounts } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { encryptSecret } from "@/lib/crypto";
import { forgetUserClient } from "@/lib/anthropic";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const rows = await db
    .select({
      provider: connectedAccounts.provider,
      keyTail: connectedAccounts.keyTail,
      createdAt: connectedAccounts.createdAt,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, user.id));
  return NextResponse.json({
    connections: rows,
    // Whether the house key exists (fallback for users without a connection).
    houseKey: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

const postSchema = z.object({
  provider: z.literal("anthropic"),
  apiKey: z.string().min(20).max(300),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(postSchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // Validate before storing: a models lookup costs nothing and proves the key.
  try {
    const probe = new Anthropic({ apiKey: parsed.apiKey });
    await probe.models.retrieve("claude-opus-5");
  } catch {
    return NextResponse.json(
      { error: "That key didn't work — check it and try again." },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, parsed.provider))
    )
    .limit(1);
  const values = {
    encryptedKey: encryptSecret(parsed.apiKey),
    keyTail: parsed.apiKey.slice(-4),
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(connectedAccounts).set(values).where(eq(connectedAccounts.id, existing.id));
    forgetUserClient(existing.id);
  } else {
    await db
      .insert(connectedAccounts)
      .values({ userId: user.id, provider: parsed.provider, ...values });
  }
  return NextResponse.json({ ok: true, keyTail: values.keyTail });
}

const deleteSchema = z.object({ provider: z.literal("anthropic") });

export async function DELETE(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(deleteSchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  const rows = await db
    .delete(connectedAccounts)
    .where(
      and(eq(connectedAccounts.userId, user.id), eq(connectedAccounts.provider, parsed.provider))
    )
    .returning({ id: connectedAccounts.id });
  for (const r of rows) forgetUserClient(r.id);
  return NextResponse.json({ ok: true });
}
