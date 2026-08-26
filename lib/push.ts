// Web Push, first-party (FindIt pattern): the server signs each push with its
// VAPID key and talks straight to the browser vendor's push service — no relay
// in the middle. Dead subscriptions (404/410) are pruned on the spot.
//
// This is what upgrades reminders from "shows on the dashboard" to "rings the
// phone": the minute-scanner turns due task/event reminders into pushes, and
// the shop pushes its plan-ready/shipped/failed moments.
import webpush from "web-push";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, pushLog, pushSubscriptions, tasks, user } from "@/lib/db/schema";

export function pushEnabled(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@secretary.local",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  configured = true;
}

export type PushPayload = { title: string; body: string; url?: string };

/** Notify every device this user enabled. Returns how many took it. */
export async function sendPush(userId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled()) return 0;
  ensureConfigured();
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  let delivered = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ url: "/chat", ...payload }),
        { TTL: 12 * 3600 }
      );
      delivered++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // the push service says this device is gone for good
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      } else {
        console.error("push failed:", sub.endpoint.slice(0, 40), status);
      }
    }
  }
  return delivered;
}

/** Claim a once-only key. True = ours to send; false = already sent. */
export async function claimPush(userId: string, key: string): Promise<boolean> {
  try {
    await db.insert(pushLog).values({ userId, key });
    return true;
  } catch {
    return false; // unique violation — another pass claimed it
  }
}

// How far back a just-became-due reminder still fires. Anything older (server
// was down, phone offline for a day) is stale — silence beats a 3 AM backlog.
const CATCHUP_MS = 15 * 60 * 1000;
const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

/**
 * The minute-scanner: task/event reminders whose time just arrived become
 * pushes, exactly once each (pushLog-claimed). Runs from instrumentation.ts.
 */
export async function scanDueReminders(now = new Date()): Promise<number> {
  if (!pushEnabled()) return 0;
  const windowStart = new Date(now.getTime() - CATCHUP_MS);
  let sent = 0;

  const openTasks = await db
    .select({ id: tasks.id, userId: tasks.userId, title: tasks.title, reminders: tasks.reminders })
    .from(tasks)
    .where(inArray(tasks.status, [...OPEN_STATUSES]));
  for (const t of openTasks) {
    for (const iso of t.reminders ?? []) {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime()) || at > now || at < windowStart) continue;
      if (!(await claimPush(t.userId, `task:${t.id}:${iso}`))) continue;
      sent += await sendPush(t.userId, {
        title: "Reminder",
        body: t.title,
        url: "/dashboard",
      });
    }
  }

  const upcoming = await db
    .select({ id: events.id, userId: events.userId, title: events.title, startsAt: events.startsAt, reminders: events.reminders })
    .from(events)
    .where(and(gte(events.startsAt, windowStart), lte(events.startsAt, new Date(now.getTime() + 7 * 86400000))));
  // Event times render in each owner's timezone, not the server's.
  const tzByUser = new Map<string, string>();
  for (const e of upcoming) {
    for (const iso of e.reminders ?? []) {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime()) || at > now || at < windowStart) continue;
      if (!(await claimPush(e.userId, `event:${e.id}:${iso}`))) continue;
      if (!tzByUser.has(e.userId)) {
        const [u] = await db
          .select({ tz: user.timezone })
          .from(user)
          .where(eq(user.id, e.userId))
          .limit(1);
        tzByUser.set(e.userId, u?.tz ?? "UTC");
      }
      const time = new Intl.DateTimeFormat("en-US", {
        timeZone: tzByUser.get(e.userId),
        hour: "numeric",
        minute: "2-digit",
      }).format(e.startsAt);
      sent += await sendPush(e.userId, {
        title: "Coming up",
        body: `${e.title} — ${time}`,
        url: "/dashboard",
      });
    }
  }
  return sent;
}
