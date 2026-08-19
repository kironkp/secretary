// Persona settings plane (SPEC §11): the Settings UI's write path for persona
// fields. Same store the update_persona chat tool writes — one persona,
// however it's set.
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";

const bodySchema = z.object({
  sass: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  name: z.string().max(60).optional(),
});

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
  };
  await db.update(user).set({ persona: next }).where(eq(user.id, session.id));
  return NextResponse.json({ ok: true, persona: next });
}
