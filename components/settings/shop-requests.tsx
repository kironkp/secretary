"use client";

// The Shop's Settings surface: every capability request with its status, the
// drafted plan (expandable), and Approve/Reject for planned ones. The same
// approve the review_capability chat tool performs — one store, two doors.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Hammer } from "lucide-react";

type ShopRequest = {
  id: string;
  need: string;
  status: string;
  plan: string | null;
  feedback: string | null;
  branch: string | null;
  buildLog: string | null;
  updatedAt: string;
};

const STATUS_TONE: Record<string, string> = {
  filed: "text-muted",
  planning: "text-accent",
  planned: "text-warn",
  approved: "text-accent",
  building: "text-accent",
  shipped: "text-ok",
  failed: "text-danger",
  rejected: "text-faint",
};

export function ShopRequests() {
  const [rows, setRows] = useState<ShopRequest[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // NEVER swallow a failed action — the 10:17 bug: approve bounced off the
  // busy lane and the button just did visibly nothing.
  const [notice, setNotice] = useState<{ id: string; text: string; tone: "ok" | "err" } | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");

  const load = async () => {
    const res = await fetch("/api/shop");
    if (res.ok) setRows(((await res.json()) as { requests: ShopRequest[] }).requests);
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    // planning/building states resolve on their own — keep the list fresh
    const iv = setInterval(() => void load(), 20000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, []);

  const act = async (id: string, action: "approve" | "reject" | "feedback", feedback?: string) => {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/shop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, feedback }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; queued?: boolean };
    setBusy(false);
    if (!res.ok) {
      setNotice({ id, text: body.error ?? "That didn't go through — try again.", tone: "err" });
      return;
    }
    if (action === "approve") {
      setNotice({
        id,
        text: body.queued
          ? "Approved — queued behind the current shop job; the build starts the moment it finishes."
          : "Approved — building now. You'll get a push when it ships.",
        tone: "ok",
      });
    } else if (action === "feedback") {
      setNotice({ id, text: "Sent — the shop is revising the plan.", tone: "ok" });
      setFeedbackFor(null);
      setFeedbackText("");
    }
    void load();
  };

  if (!rows) return <p className="text-xs text-faint">Loading…</p>;
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted">
        Nothing yet. When the secretary can&rsquo;t do something, it files the ability here —
        you approve the plan, the shop builds it into the app.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="rounded-xl border border-edge bg-card p-3">
          <button
            onClick={() => setOpenId(openId === r.id ? null : r.id)}
            className="flex w-full items-start gap-2 text-left"
          >
            {openId === r.id ? (
              <ChevronDown size={14} className="mt-0.5 flex-none text-muted" />
            ) : (
              <ChevronRight size={14} className="mt-0.5 flex-none text-muted" />
            )}
            <span className="min-w-0 flex-1 text-sm">{r.need}</span>
            <span
              className={`flex-none text-[10px] font-bold uppercase tracking-wide ${STATUS_TONE[r.status] ?? "text-muted"}`}
            >
              {r.status === "building" && (
                <Hammer size={10} className="mr-1 inline animate-pulse" aria-hidden />
              )}
              {r.status}
            </span>
          </button>
          {openId === r.id && (
            <div className="mt-2 space-y-2 border-t border-edge/60 pt-2">
              {r.plan ? (
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface p-2.5 text-xs text-muted">
                  {r.plan}
                </pre>
              ) : (
                r.status === "planned" && (
                  <p className="animate-pulse text-xs text-faint">
                    Plan text is still being written — it&rsquo;ll appear here shortly.
                  </p>
                )
              )}
              {r.buildLog && (
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface p-2.5 text-[10px] text-danger">
                  {r.buildLog}
                </pre>
              )}
              {r.branch && r.status === "failed" && (
                <p className="text-[10px] text-faint">Branch kept for autopsy: {r.branch}</p>
              )}
              {r.status === "planned" && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void act(r.id, "approve")}
                    disabled={busy}
                    className="rounded-full bg-accent px-4 py-1.5 text-xs font-bold text-bg disabled:opacity-50"
                  >
                    Approve &amp; build
                  </button>
                  <button
                    onClick={() => {
                      setFeedbackFor(feedbackFor === r.id ? null : r.id);
                      setNotice(null);
                    }}
                    disabled={busy}
                    className="rounded-full border border-edge px-4 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
                  >
                    Give feedback
                  </button>
                  <button
                    onClick={() => void act(r.id, "reject")}
                    disabled={busy}
                    className="rounded-full border border-edge px-4 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
              {feedbackFor === r.id && r.status === "planned" && (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    rows={3}
                    placeholder="What should change? e.g. 'Also cover voice calls' or 'Skip the schema change, keep it simpler'"
                    className="w-full resize-none rounded-lg border border-edge bg-surface px-2.5 py-2 text-xs outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => void act(r.id, "feedback", feedbackText)}
                    disabled={busy || !feedbackText.trim()}
                    className="self-start rounded-full bg-accent px-4 py-1.5 text-xs font-bold text-bg disabled:opacity-50"
                  >
                    Send — revise the plan
                  </button>
                </div>
              )}
              {notice?.id === r.id && (
                <p className={`text-xs ${notice.tone === "ok" ? "text-ok" : "text-danger"}`}>
                  {notice.text}
                </p>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
