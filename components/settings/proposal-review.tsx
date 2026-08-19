"use client";

// Proposal review card (SPEC §7): preview in the same sandboxed lockdown as
// the canvas, approve = hot-register (no restart), reject = tombstone.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CANVAS_SANDBOX } from "@/lib/canvas/sanitize";

type Proposal = { name: string; need: string; description: string; preview_srcdoc: string };

export function ProposalReview() {
  const router = useRouter();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await fetch("/api/proposals");
      if (res.ok) setProposals(((await res.json()) as { proposals: Proposal[] }).proposals);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const decide = async (name: string, decision: "approve" | "reject") => {
    setProposals((p) => p?.filter((x) => x.name !== name) ?? null);
    const res = await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, decision }),
    });
    if (res.ok) router.refresh();
  };

  if (!proposals?.length) {
    return (
      <p className="text-xs text-muted">
        None waiting. Ask the secretary for a view that doesn&rsquo;t exist yet and
        the build lands here for review.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {proposals.map((p) => (
        <div key={p.name} className="rounded-xl border border-edge bg-card p-3">
          <p className="text-sm font-semibold">{p.name}</p>
          <p className="mb-2 text-xs text-muted">
            {p.description} · from your ask: &ldquo;{p.need}&rdquo;
          </p>
          <iframe
            title={`Preview: ${p.name}`}
            sandbox={CANVAS_SANDBOX}
            srcDoc={p.preview_srcdoc}
            className="h-64 w-full rounded-lg border border-edge bg-surface"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => decide(p.name, "approve")}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white"
            >
              Approve — add to dashboard
            </button>
            <button
              onClick={() => decide(p.name, "reject")}
              className="rounded-md border border-edge px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
