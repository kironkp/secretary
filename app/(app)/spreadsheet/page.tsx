// The "spreadsheet": full transparency into what the secretary has captured
// about the user's life — every task/event/fact with its source (spoken, typed,
// inferred by the extraction pass, or suggested), the accountability log, and
// raw conversation transcripts.
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Keyboard, Lightbulb, MessageSquare, Mic, Sparkles } from "lucide-react";
import { auth } from "@/lib/auth";
import {
  getCheckinsWithTask,
  getEvents,
  getMemories,
  getTasksWithContext,
  getTranscripts,
} from "@/lib/db/queries";
import { SearchBox } from "@/components/spreadsheet/search-box";

const SOURCE_STYLE: Record<string, { label: string; cls: string; Icon: typeof Mic }> = {
  spoken: { label: "spoken", cls: "border-accent/40 text-accent", Icon: Mic },
  typed: { label: "typed", cls: "border-edge text-muted", Icon: Keyboard },
  inferred: { label: "inferred", cls: "border-warn/40 text-warn", Icon: Sparkles },
  suggested: { label: "suggested", cls: "border-ok/40 text-ok", Icon: Lightbulb },
};

function SourceChip({ source }: { source: string }) {
  const s = SOURCE_STYLE[source] ?? SOURCE_STYLE.typed;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${s.cls}`}
    >
      <s.Icon size={10} strokeWidth={2} />
      {s.label}
    </span>
  );
}

export default async function SpreadsheetPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const userId = session.user.id;
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";

  const fmt = (d: Date, withTime = true) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    }).format(d);

  const [taskRows, eventRows, memoryRows, checkinRows, transcripts] = await Promise.all([
    getTasksWithContext(userId),
    getEvents(userId),
    getMemories(userId),
    getCheckinsWithTask(userId),
    getTranscripts(userId),
  ]);

  type Row = {
    key: string;
    when: Date;
    type: string;
    what: string;
    detail: string;
    source: string;
    conversationId: string | null;
    messageId: string | null;
  };

  const captured: Row[] = [
    ...taskRows.map(({ task, projectName }) => ({
      key: `t-${task.id}`,
      when: task.createdAt,
      type: "task",
      what: task.title,
      detail: [
        task.status.replace("_", " "),
        task.dueAt ? `due ${fmt(task.dueAt, false)}` : null,
        projectName,
        task.postponedCount ? `pushed ${task.postponedCount}×` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      source: task.source,
      conversationId: task.createdFromConversationId,
      messageId: task.createdFromMessageId,
    })),
    ...eventRows.map((e) => ({
      key: `e-${e.id}`,
      when: e.createdAt,
      type: "event",
      what: e.title,
      detail: [fmt(e.startsAt), e.location].filter(Boolean).join(" · "),
      source: e.source,
      conversationId: e.conversationId,
      messageId: e.messageId,
    })),
    ...memoryRows.map((m) => ({
      key: `m-${m.id}`,
      when: m.createdAt,
      type: "fact",
      what: m.fact,
      detail: (m.tags ?? []).join(", "),
      source: m.tags?.includes("inferred") ? "inferred" : "spoken",
      conversationId: null,
      messageId: null,
    })),
  ].sort((a, b) => b.when.getTime() - a.when.getTime());

  return (
    <div className="space-y-6 py-6">
      <div>
        <h1 className="text-lg font-bold">Spreadsheet</h1>
        <p className="text-sm text-muted">
          Everything the secretary has captured about your life, and exactly where it came from.
        </p>
      </div>

      <SearchBox />

      <section>
        <h2 className="mb-2 text-sm font-bold text-muted">
          Captured <span className="text-faint">({captured.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-edge text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Type</th>
                <th className="px-4 py-2.5 font-semibold">What</th>
                <th className="px-4 py-2.5 font-semibold">Detail</th>
                <th className="px-4 py-2.5 font-semibold">Source</th>
                <th className="w-8 px-2" />
              </tr>
            </thead>
            <tbody>
              {captured.map((r) => (
                <tr key={r.key} className="border-b border-edge/50 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 text-faint">{fmt(r.when, false)}</td>
                  <td className="px-4 py-2.5 text-muted">{r.type}</td>
                  <td className="px-4 py-2.5">{r.what}</td>
                  <td className="px-4 py-2.5 text-xs text-muted">{r.detail || "—"}</td>
                  <td className="px-4 py-2.5">
                    <SourceChip source={r.source} />
                  </td>
                  <td className="px-2 py-2.5">
                    {r.conversationId && (
                      <Link
                        href={`/chat?c=${r.conversationId}${r.messageId ? `&m=${r.messageId}` : ""}`}
                        title="Jump to the conversation this came from"
                        aria-label="Jump to the conversation this came from"
                        className="inline-block text-faint hover:text-accent"
                      >
                        <MessageSquare size={13} strokeWidth={1.75} />
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
              {captured.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted">
                    Nothing captured yet — talk to your secretary and watch this fill up.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {checkinRows.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold text-muted">Accountability log</h2>
          <div className="rounded-xl border border-edge bg-surface p-4 text-sm">
            {checkinRows.map(({ checkin, taskTitle }) => (
              <p key={checkin.id} className="mb-1.5 last:mb-0">
                <span className="text-faint">{fmt(checkin.at)}</span>{" "}
                <span className="font-semibold">{taskTitle}</span>{" "}
                <span className="text-muted">— {checkin.note ?? checkin.type}</span>
                {checkin.type === "auto_detected" && (
                  <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-warn">
                    <Sparkles size={10} strokeWidth={2} /> auto-detected
                  </span>
                )}
              </p>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-bold text-muted">
          Transcripts <span className="text-faint">({transcripts.length})</span>
        </h2>
        <div className="space-y-2">
          {transcripts.map(({ conversation, messages: msgs }) => (
            <details
              key={conversation.id}
              className="group rounded-xl border border-edge bg-surface"
            >
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-muted hover:text-ink">
                <span className="mr-1.5 inline-block translate-y-[2px]">
                  {conversation.mode === "voice" ? (
                    <Mic size={13} strokeWidth={1.75} />
                  ) : (
                    <Keyboard size={13} strokeWidth={1.75} />
                  )}
                </span>
                {new Intl.DateTimeFormat("en-US", {
                  timeZone: timezone,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                }).format(conversation.startedAt)}
                <span className="ml-2 text-xs font-normal text-faint">
                  {msgs.filter((m) => m.role !== "tool").length} messages
                  {conversation.extractedAt ? " · extracted" : ""}
                </span>
              </summary>
              <div className="space-y-2 border-t border-edge/50 px-4 py-3">
                {msgs
                  .filter((m) => m.role !== "tool")
                  .map((m) => (
                    <p key={m.id} className="text-sm">
                      <span className={m.role === "user" ? "text-accent" : "text-muted"}>
                        {m.role === "user" ? "You" : "Secretary"}:
                      </span>{" "}
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    </p>
                  ))}
                {msgs.filter((m) => m.role !== "tool").length === 0 && (
                  <p className="text-sm text-faint">No transcript recorded.</p>
                )}
              </div>
            </details>
          ))}
          {transcripts.length === 0 && (
            <p className="rounded-xl border border-edge bg-surface px-4 py-8 text-center text-sm text-muted">
              No conversations yet.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
