// Recurring events (SEC-A002): the RRULE a tool is given, checked and
// normalized into Google Calendar's recurrence line, and said back in plain
// words. Only the parts a spoken request needs are accepted (FREQ, INTERVAL,
// BYDAY, BYMONTHDAY, BYMONTH, COUNT, UNTIL); anything else is refused with
// the reason, so the model fixes it rather than Google rejecting the event.

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
type Day = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
const DAY_NAMES: Record<Day, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
const WEEKDAYS = "MO,TU,WE,TH,FR";

/**
 * "FREQ=DAILY" or "RRULE:FREQ=WEEKLY;BYDAY=MO,WE" → ["RRULE:FREQ=…"]. Throws
 * with what is wrong. Empty input is a one-off: [].
 */
export function normalizeRecurrence(input: string | undefined): string[] {
  const raw = input?.trim();
  if (!raw) return [];
  const body = raw.toUpperCase().replace(/^RRULE:/, "");
  const parts = new Map<string, string>();
  for (const piece of body.split(";").filter(Boolean)) {
    const [key, value] = piece.split("=");
    if (!key || value === undefined) throw new Error(`recurrence: "${piece}" is not KEY=VALUE`);
    parts.set(key, value);
  }
  const freq = parts.get("FREQ");
  if (!freq || !(FREQS as readonly string[]).includes(freq)) {
    throw new Error(`recurrence: FREQ must be one of ${FREQS.join(", ")}`);
  }
  for (const [key, value] of parts) {
    const ok =
      key === "FREQ" ||
      (key === "INTERVAL" && /^[1-9]\d?$/.test(value)) ||
      (key === "COUNT" && /^[1-9]\d{0,2}$/.test(value)) ||
      (key === "UNTIL" && /^\d{8}(T\d{6}Z)?$/.test(value)) ||
      (key === "BYDAY" && value.split(",").every((d) => /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.test(d))) ||
      (key === "BYMONTHDAY" && value.split(",").every((d) => /^-?([1-9]|[12]\d|3[01])$/.test(d))) ||
      (key === "BYMONTH" && value.split(",").every((d) => /^([1-9]|1[0-2])$/.test(d)));
    if (!ok) throw new Error(`recurrence: ${key}=${value} is not supported`);
  }
  if (parts.has("COUNT") && parts.has("UNTIL")) throw new Error("recurrence: COUNT and UNTIL together");
  return [`RRULE:${[...parts].map(([k, v]) => `${k}=${v}`).join(";")}`];
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function listNames(days: string[]): string {
  const names = days.map((d) => {
    const m = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d);
    if (!m) return d;
    const name = DAY_NAMES[m[2] as Day];
    if (!m[1]) return name;
    const n = Number(m[1]);
    return n === -1 ? `the last ${name}` : `the ${ordinal(n)} ${name}`;
  });
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "every day", "every weekday", "every 2 weeks on Monday and Wednesday, 10 times". */
export function describeRecurrence(lines: string[]): string | null {
  const line = lines.find((l) => l.startsWith("RRULE:"));
  if (!line) return null;
  const parts = new Map(
    line
      .slice("RRULE:".length)
      .split(";")
      .map((p) => p.split("=") as [string, string])
  );
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[parts.get("FREQ") ?? ""] ?? "time";
  const byDay = parts.get("BYDAY")?.split(",");
  let text =
    interval === 1 && unit === "day"
      ? "every day"
      : interval === 1 && unit === "week" && parts.get("BYDAY") === WEEKDAYS
        ? "every weekday"
        : interval === 1
          ? `every ${unit}`
          : `every ${interval} ${unit}s`;
  if (byDay && parts.get("BYDAY") !== WEEKDAYS) text += ` on ${listNames(byDay)}`;
  const byMonthDay = parts.get("BYMONTHDAY");
  if (byMonthDay) text += ` on the ${byMonthDay.split(",").map((d) => (d === "-1" ? "last day" : ordinal(Number(d)))).join(" and ")}`;
  const count = parts.get("COUNT");
  if (count) text += `, ${count} times`;
  const until = parts.get("UNTIL");
  if (until) text += `, until ${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  return text;
}
