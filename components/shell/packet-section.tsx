"use client";

// A task's packet in its detail (docs/understanding/SPEC.md §6, documents per
// step): for each step, the documents it needs — filed or missing, with an
// upload for each — then other files, and Compile PDF. Kiron, 2026-09-25:
// "compile it in here instead of doing it in Adobe, which I hate so much."
import { useEffect, useRef, useState } from "react";
import { Check, FileText, Loader2, Plus, X } from "lucide-react";
import type { Packet, PacketFile } from "@/lib/secretary/packets";

export function PacketSection({ taskId }: { taskId: string }) {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [otherName, setOtherName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingDoc = useRef<string>("");

  useEffect(() => {
    let live = true;
    void fetch(`/api/tasks/${taskId}/packet`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => live && setPacket(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [taskId]);

  const pick = (docType: string) => {
    pendingDoc.current = docType;
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    const docType = pendingDoc.current;
    setBusy(docType);
    setError("");
    const form = new FormData();
    form.append("file", file);
    form.append("docType", docType);
    try {
      const res = await fetch(`/api/tasks/${taskId}/packet`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Upload failed.");
      setPacket(body);
      setOtherName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (f: PacketFile) => {
    setBusy(f.id);
    const res = await fetch(`/api/tasks/${taskId}/packet/${f.id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setPacket(await res.json());
    setBusy(null);
  };

  if (!packet) return null;
  const withDocs = packet.steps.filter((s) => s.docs.length);
  const required = withDocs.reduce((n, s) => n + s.docs.length, 0);
  const have = required - packet.missing.length;
  const anyFiles = withDocs.some((s) => s.docs.some((d) => d.files.length)) || packet.other.length > 0;
  // A plain errand has no packet: show it for work with steps or with files.
  if (!packet.steps.length && !anyFiles) return null;

  const fileRow = (f: PacketFile) => (
    <span key={f.id} className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <FileText size={12} strokeWidth={1.75} className="flex-none" />
      <a href={`/api/attachments/${f.attachmentId}`} target="_blank" rel="noreferrer" className="truncate hover:text-ink">
        {f.name}
      </a>
      <button
        onClick={() => void remove(f)}
        disabled={busy !== null}
        aria-label={`Remove ${f.name}`}
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-faint hover:text-danger disabled:opacity-40"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  );

  return (
    <div className="py-1.5" data-testid="packet">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-xs text-faint">
          Documents{required > 0 && ` (${have}/${required})`}
          {packet.process && ` · ${packet.process}`}
        </p>
        {anyFiles && (
          <a
            href={`/api/tasks/${taskId}/packet/pdf`}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white"
          >
            Compile PDF
          </a>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        {withDocs.map((s) => (
          <div key={s.name}>
            <p className={`text-xs font-semibold ${s.done ? "text-faint" : "text-ink"}`}>{s.name}</p>
            <div className="mt-1 flex flex-col gap-1">
              {s.docs.map((d) => (
                <div key={d.name} className="flex flex-col gap-0.5 pl-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md border ${
                        d.files.length ? "border-ok bg-ok text-bg" : "border-danger/60 text-transparent"
                      }`}
                    >
                      <Check size={11} strokeWidth={3} />
                    </span>
                    <span className="min-w-0 flex-1">{d.name}</span>
                    {d.files.length === 0 && <span className="text-xs text-danger">missing</span>}
                    <button
                      onClick={() => pick(d.name)}
                      disabled={busy !== null}
                      aria-label={`Upload ${d.name}`}
                      className="flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs text-ink disabled:opacity-50"
                    >
                      {busy === d.name ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} strokeWidth={2.25} />}
                      {d.files.length ? "Add" : "Upload"}
                    </button>
                  </div>
                  {d.files.map(fileRow)}
                </div>
              ))}
            </div>
          </div>
        ))}

        {packet.other.length > 0 && (
          <div>
            <p className="text-xs font-semibold">Other files</p>
            <div className="mt-1 flex flex-col gap-0.5 pl-1">
              {packet.other.map((f) => (
                <div key={f.id} className="flex flex-col">
                  <span className="text-xs text-faint">{f.docType}</span>
                  {fileRow(f)}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            value={otherName}
            onChange={(e) => setOtherName(e.target.value)}
            placeholder={withDocs.length ? "Another document (name)" : "Document name, e.g. STD 65"}
            aria-label="Name of the document to add"
            className="h-8 min-w-0 flex-1 rounded-lg bg-surface-2 px-2.5 text-sm outline-none placeholder:text-faint"
          />
          <button
            onClick={() => pick(otherName.trim() || "Other")}
            disabled={busy !== null}
            className="flex h-8 flex-none items-center gap-1 rounded-full bg-surface-2 px-3 text-xs text-ink disabled:opacity-50"
          >
            <Plus size={12} strokeWidth={2.25} /> Add file
          </button>
        </div>
        {!withDocs.length && (
          <p className="text-xs text-faint">
            Tell me which documents each step needs (&ldquo;step 8 needs the ADM 2029&rdquo;) and they show up here as a
            checklist.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
