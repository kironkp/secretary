// Persona settings plane (SPEC §11): the Settings UI's write path for persona
// fields. Same store the update_persona chat tool writes — one persona,
// however it's set.
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { EL_MOUTH_VOICE } from "@/lib/elevenlabs";
import { REALTIME_VOICES } from "@/lib/openai";
import { BRAIN_EFFORTS, BRAIN_MODELS, CHAT_MODELS, chatProvider, CHAT_EFFORTS } from "@/lib/anthropic";

const bodySchema = z.object({
  sass: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  name: z.string().max(60).optional(),
  voice: z
    .enum([...REALTIME_VOICES, EL_MOUTH_VOICE] as [string, ...string[]])
    .optional(),
  brainModel: z.enum(BRAIN_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
  brainEffort: z.enum(BRAIN_EFFORTS).optional(),
  chatModel: z.enum(CHAT_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
  chatEffort: z.string().optional(),
  voiceEffort: z.enum(["auto", "low", "medium", "high"]).optional(),
});

/**
 * The voice preferences only, for a surface that starts a call without the
 * chat dock's bootstrap (the interview orb): the same voice everywhere.
 */
export async function GET() {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const [row] = await db
    .select({ persona: user.persona })
    .from(user)
    .where(eq(user.id, session.id));
  return NextResponse.json({
    voice: row?.persona?.voice ?? "marin",
    voiceEffort: row?.persona?.voiceEffort ?? "auto",
  });
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (isErrorResponse(session)) return session;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const [row] = await db
    .select({ persona: user.persona })
    .from(user)
    .where(eq(user.id, session.id));
  const next = {
    ...(row?.persona ?? {}),
    ...(parsed.sass !== undefined ? { sass: parsed.sass } : {}),
    ...(parsed.name !== undefined ? { name: parsed.name.trim() } : {}),
    ...(parsed.voice !== undefined ? { voice: parsed.voice } : {}),
    ...(parsed.brainModel !== undefined ? { brainModel: parsed.brainModel } : {}),
    ...(parsed.brainEffort !== undefined ? { brainEffort: parsed.brainEffort } : {}),
    ...(parsed.chatModel !== undefined ? { chatModel: parsed.chatModel } : {}),
    ...(parsed.voiceEffort !== undefined ? { voiceEffort: parsed.voiceEffort } : {}),
  };
  // Effort is validated against the (possibly just-changed) model's ladder.
  if (parsed.chatEffort !== undefined) {
    const provider = chatProvider(next.chatModel ?? "");
    if (!CHAT_EFFORTS[provider].includes(parsed.chatEffort)) {
      return NextResponse.json({ error: "Invalid effort for model" }, { status: 400 });
    }
    next.chatEffort = parsed.chatEffort;
  }
  await db.update(user).set({ persona: next }).where(eq(user.id, session.id));
  return NextResponse.json({ ok: true, persona: next });
}
