// An app event's copy on the user's primary Google Calendar (SEC-A002). One
// way, app → Google: create, change and delete here reach Google; an edit
// made in Google stays in Google. Times go as wall-clock dateTime plus the
// event's IANA zone, never a fixed offset, so a daily 8:00 stays 8:00 local
// across a DST change.
import type { events } from "@/lib/db/schema";
import { wallTimeInTz } from "@/lib/time";
import { CALENDAR_SCOPE, withGoogle, type CalendarEventBody } from "./connection";

type EventRow = typeof events.$inferSelect;

/** An event with no end gets this much on Google, which needs one. */
const DEFAULT_MINUTES = 30;
/** Google keeps at most five reminder overrides, none past four weeks. */
const MAX_REMINDERS = 5;
const MAX_REMINDER_MINUTES = 40_320;

/** The Google event resource for an app event. */
export function googleEventBody(event: EventRow): CalendarEventBody {
  const tz = event.timeZone ?? "UTC";
  const end = event.endsAt ?? new Date(event.startsAt.getTime() + DEFAULT_MINUTES * 60_000);
  // The app keeps reminders as instants; Google wants minutes before each
  // occurrence, which for a recurring event is the same lead every time.
  const minutes = [
    ...new Set(
      event.reminders
        .map((iso) => Math.round((event.startsAt.getTime() - new Date(iso).getTime()) / 60_000))
        .filter((m) => m >= 0 && m <= MAX_REMINDER_MINUTES)
    ),
  ].slice(0, MAX_REMINDERS);
  return {
    summary: event.title,
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { description: event.notes } : {}),
    start: { dateTime: wallTimeInTz(event.startsAt, tz), timeZone: tz },
    end: { dateTime: wallTimeInTz(end, tz), timeZone: tz },
    recurrence: event.recurrence,
    reminders: minutes.length
      ? { useDefault: false, overrides: minutes.map((m) => ({ method: "popup", minutes: m })) }
      : { useDefault: true },
  };
}

/** Create the Google copy; its id. */
export async function insertGoogleEvent(userId: string, event: EventRow): Promise<string> {
  const { id } = await withGoogle(userId, CALENDAR_SCOPE, (http, token) =>
    http.insertEvent(token, googleEventBody(event))
  );
  return id;
}

/** Bring the Google copy in line with the app event as it is now. */
export async function patchGoogleEvent(userId: string, googleEventId: string, event: EventRow): Promise<void> {
  await withGoogle(userId, CALENDAR_SCOPE, (http, token) =>
    http.patchEvent(token, googleEventId, googleEventBody(event))
  );
}

/** Remove the Google copy; one already gone counts as removed. */
export async function deleteGoogleEvent(userId: string, googleEventId: string): Promise<void> {
  await withGoogle(userId, CALENDAR_SCOPE, (http, token) => http.deleteEvent(token, googleEventId));
}
