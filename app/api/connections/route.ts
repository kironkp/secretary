// Connected accounts plane: the site login is better-auth; THIS is where a
// signed-in user connects their own model-provider account: Claude for the
// brain, the understanding loop and Claude chat; OpenAI for voice, GPT chat
// and the loop's second road (every route resolves the user's key before the
// house key: anthropicClientFor, openaiClientFor). Keys are validated with a
// live no-cost call, stored AES-GCM encrypted, and only ever surfaced as a
// 4-char tail.
import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { connectedAccounts } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { encryptSecret } from "@/lib/crypto";
import { forgetUserClient } from "@/lib/anthropic";
import { forgetOpenaiClient, TEXT_MODEL } from "@/lib/openai";

const providerSchema = z.enum(["anthropic", "openai"]);
type Provider = z.infer<typeof providerSchema>;

/** The per-user client cache that held this row's key, whichever provider it was for. */
function forgetClient(provider: Provider, rowId: string): void {
  if (provider === "anthropic") forgetUserClient(rowId);
  else forgetOpenaiClient(rowId);
}

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
    // Whether the house keys exist (the fallback for users without a connection).
    houseKeys: {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
    },
  });
}

const postSchema = z.object({
  provider: providerSchema,
  apiKey: z.string().min(20).max(300),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(postSchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // Validate before storing: a models lookup costs nothing and proves the key.
  try {
    if (parsed.provider === "anthropic") {
      await new Anthropic({ apiKey: parsed.apiKey }).models.retrieve("claude-opus-5");
    } else {
      await new OpenAI({ apiKey: parsed.apiKey }).models.retrieve(TEXT_MODEL);
    }
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
    forgetClient(parsed.provider, existing.id);
  } else {
    await db
      .insert(connectedAccounts)
      .values({ userId: user.id, provider: parsed.provider, ...values });
  }
  return NextResponse.json({ ok: true, keyTail: values.keyTail });
}

const deleteSchema = z.object({ provider: providerSchema });

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
  for (const r of rows) forgetClient(parsed.provider, r.id);
  return NextResponse.json({ ok: true });
}
