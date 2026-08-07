// Adaptive-layout controls: revert to the previous arrangement, pin/unpin a
// section so regeneration can never move it.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutSpecs } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { getLayoutHead } from "@/lib/layout/generator";
import { COMPONENT_PALETTE } from "@/lib/layout/spec";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("revert") }),
  z.object({
    action: z.literal("pin"),
    component: z.enum(COMPONENT_PALETTE),
    pinned: z.boolean(),
  }),
]);

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const head = await getLayoutHead(user.id);
  if (!head) return NextResponse.json({ error: "No layout yet" }, { status: 404 });

  if (parsed.action === "revert") {
    if (head.version <= 1) {
      // deleting v1 falls back to the built-in default layout
      await db
        .delete(layoutSpecs)
        .where(and(eq(layoutSpecs.userId, user.id), eq(layoutSpecs.id, head.id)));
      return NextResponse.json({ ok: true, version: 0 });
    }
    await db
      .delete(layoutSpecs)
      .where(and(eq(layoutSpecs.userId, user.id), eq(layoutSpecs.id, head.id)));
    return NextResponse.json({ ok: true, version: head.version - 1 });
  }

  const pinned = new Set(head.pinned);
  if (parsed.pinned) pinned.add(parsed.component);
  else pinned.delete(parsed.component);
  await db
    .update(layoutSpecs)
    .set({ pinned: [...pinned] })
    .where(and(eq(layoutSpecs.userId, user.id), eq(layoutSpecs.id, head.id)));
  return NextResponse.json({ ok: true, pinned: [...pinned] });
}
