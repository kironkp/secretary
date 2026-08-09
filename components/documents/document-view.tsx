"use client";

// The living document: sections rendered in full, version history with
// restore, one obvious export button. Live — re-fetches on focus and every
// 8s while open, so voice edits appear as they happen ("watch the document
// update while we keep talking").
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, FileText, History, Undo2 } from "lucide-react";

type Section = { heading: string; content: string };
type Version = { id: string; title: string; note: string | null; savedAt: string };

export function DocumentView({
  id,
  initialTitle,
  initialProject,
  initialSections,
  initialVersions,
  initialUpdatedAt,
}: {
  id: string;
  initialTitle: string;
  initialProject: string | null;
  initialSections: Section[];
  initialVersions: Version[];
  initialUpdatedAt: string;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState({
    title: initialTitle,
    project: initialProject,
    sections: initialSections,
    versions: initialVersions,
    updatedAt: initialUpdatedAt,
  });
  const [showHistory, setShowHistory] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/documents/${id}`);
      if (!res.ok) return;
      const body = await res.json();
      setDoc((prev) => {
        const next = {
          title: body.doc.title,
          project: body.projectName,
          sections: body.doc.sections,
          versions: body.versions.map((v: Version & { savedAt: string }) => v),
          updatedAt: body.doc.updatedAt,
        };
        if (prev.updatedAt !== next.updatedAt) setFlash(true);
        return next;
      });
    } catch {
      /* transient */
    }
  }, [id]);

  useEffect(() => {
    const iv = setInterval(() => void refetch(), 8000);
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [refetch]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  const restore = async (versionId: string) => {
    setRestoring(versionId);
    const res = await fetch(`/api/documents/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", versionId }),
    });
    setRestoring(null);
    if (res.ok) {
      await refetch();
      router.refresh();
    }
  };

  const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Link
          href="/dashboard"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </Link>
        <FileText size={18} strokeWidth={1.75} className="text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold leading-tight tracking-tight">{doc.title}</h1>
          <p className="text-xs text-faint">
            {doc.project ?? "unfiled"} · edited {fmtWhen(doc.updatedAt)}
          </p>
        </div>
        <button
          onClick={() => setShowHistory((s) => !s)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
            showHistory
              ? "border-accent bg-accent/10 text-accent"
              : "border-edge text-muted hover:text-ink"
          }`}
        >
          <History size={13} strokeWidth={1.75} />
          History ({doc.versions.length})
        </button>
        <a
          href={`/api/documents/${id}/export`}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-bg transition-opacity hover:opacity-90"
        >
          <Download size={13} strokeWidth={2} />
          Export for Word
        </a>
      </div>

      {showHistory && (
        <div className="animate-rise-in mb-5 rounded-2xl border border-edge bg-surface p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-faint">
            Version history — restoring is itself revertible
          </p>
          {doc.versions.length === 0 && (
            <p className="text-sm text-faint">No earlier versions yet.</p>
          )}
          {doc.versions.map((v) => (
            <div key={v.id} className="flex items-center gap-2 border-t border-edge/50 py-2 text-sm first:border-0">
              <span className="text-xs tabular-nums text-faint">{fmtWhen(v.savedAt)}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{v.note ?? "snapshot"}</span>
              <button
                onClick={() => restore(v.id)}
                disabled={restoring !== null}
                className="inline-flex items-center gap-1 rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-50"
              >
                <Undo2 size={11} strokeWidth={2} />
                {restoring === v.id ? "restoring…" : "restore"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={`space-y-6 rounded-2xl border bg-surface p-6 transition-shadow sm:p-8 ${
          flash ? "border-accent ring-2 ring-accent/30" : "border-edge"
        }`}
      >
        {doc.sections.length === 0 && (
          <p className="py-8 text-center text-sm text-faint">
            Empty document — ask your secretary to outline it.
          </p>
        )}
        {doc.sections.map((s, i) => (
          <section key={`${s.heading}-${i}`}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-[0.06em] text-muted">
              {s.heading}
            </h2>
            {s.content.trim() ? (
              <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{s.content}</div>
            ) : (
              <p className="text-sm italic text-faint">Nothing written yet.</p>
            )}
          </section>
        ))}
      </div>

      <p className="mt-3 text-center text-[11px] text-faint">
        Edits by voice or chat appear here live · every change is snapshotted
      </p>
    </div>
  );
}
