// Adaptive-layout controls: revert to the previous arrangement, pin/unpin a
// section so the planner can never move it, and the calm-mode switch.
// Serves both pipelines: v0 LayoutSpec rows and v2 LayoutPlan rows (ADAPTIVE_V2).
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, user as userTable } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { getLayoutHead } from "@/lib/layout/generator";
import { getPlanHead, revertPlan, setPinned } from "@/lib/layout/plan-store";

const PLAN_MODE = process.env.ADAPTIVE_V2 === "true";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("revert") }),
  z.object({
    action: z.literal("pin"),
    // v0 pins palette names; v2 pins section keys ("project_card:<id>").
    // Both are validated against the actual head before storage.
    component: z.string().min(1).max(120),
    pinned: z.boolean(),
  }),
  z.object({ action: z.literal("calm_mode"), enabled: z.boolean() }),
  z.object({ action: z.literal("remove_preference"), id: z.string().min(1) }),
]);

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  if (parsed.action === "calm_mode") {
    await db
      .update(userTable)
      .set({ calmMode: parsed.enabled })
      .where(eq(userTable.id, user.id));
    return NextResponse.json({ ok: true, calm_mode: parsed.enabled });
  }

  if (parsed.action === "remove_preference") {
    await db
      .delete(layoutPreferences)
      .where(and(eq(layoutPreferences.userId, user.id), eq(layoutPreferences.id, parsed.id)));
    return NextResponse.json({ ok: true });
  }

  if (PLAN_MODE) {
    if (parsed.action === "revert") {
      const ok = await revertPlan(user.id);
      if (!ok) return NextResponse.json({ error: "Nothing to revert to" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    const head = await getPlanHead(user.id);
    if (!head) return NextResponse.json({ error: "No layout yet" }, { status: 404 });
    const ok = await setPinned(user.id, parsed.component, parsed.pinned);
    if (!ok) return NextResponse.json({ error: "Unknown section" }, { status: 400 });
    const fresh = await getPlanHead(user.id);
    return NextResponse.json({ ok: true, pinned: fresh?.pinned ?? [] });
  }

  const head = await getLayoutHead(user.id);
  if (!head) return NextResponse.json({ error: "No layout yet" }, { status: 404 });

  if (parsed.action === "revert") {
    // v0 revert: drop the head; v1 falls back to the built-in default layout.
    await db
      .delete(layoutSpecs)
      .where(and(eq(layoutSpecs.userId, user.id), eq(layoutSpecs.id, head.id)));
    return NextResponse.json({ ok: true, version: Math.max(0, head.version - 1) });
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
