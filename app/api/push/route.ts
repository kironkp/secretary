// Push subscription plane: the Settings "Enable notifications" flow.
// GET → VAPID public key + this user's device count. POST → save/refresh a
// subscription (or action:"test" → ring the device now). DELETE → this
// device's subscription.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pushSubscriptions } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { pushEnabled, sendPush } from "@/lib/push";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, user.id));
  return NextResponse.json({
    enabled: pushEnabled(),
    publicKey: process.env.VAPID_PUBLIC_KEY ?? null,
    devices: rows.length,
  });
}

const bodySchema = z.union([
  z.object({
    action: z.literal("subscribe"),
    subscription: z.object({
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
    }),
  }),
  z.object({ action: z.literal("test") }),
]);

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  if (parsed.action === "test") {
    const delivered = await sendPush(user.id, {
      title: "Secretary",
      body: "Notifications are on. You'll hear from me when it matters.",
      url: "/chat",
    });
    return NextResponse.json({ delivered });
  }

  const { endpoint, keys } = parsed.subscription;
  // Upsert by endpoint: iOS rotates endpoints; the old row dies via 410-prune.
  const [existing] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .limit(1);
  if (existing) {
    await db
      .update(pushSubscriptions)
      .set({ userId: user.id, p256dh: keys.p256dh, auth: keys.auth })
      .where(eq(pushSubscriptions.id, existing.id));
  } else {
    await db.insert(pushSubscriptions).values({
      userId: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
  }
  return NextResponse.json({ ok: true });
}

const deleteSchema = z.object({ endpoint: z.string().url() });

export async function DELETE(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(deleteSchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  await db
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, parsed.endpoint))
    );
  return NextResponse.json({ ok: true });
}
