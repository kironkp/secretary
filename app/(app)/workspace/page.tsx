// The Workspace (docs/workspace/SPEC.md). A board of independent widgets the
// shell positions; the Canvas keeps its own tab, untouched, until this is
// better.
//
// Server component: it reads the board, sanitizes every widget body BEFORE the
// markup reaches the client, and hands plain serializable props down. Bodies
// render inline in the app document, so the sanitizer is the whole security
// boundary here — it is applied on write and again on read, and never skipped.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";
import { ledesFor } from "@/lib/understanding/words";
import { resolveBinding } from "@/lib/workspace/bindings";
import { getBoard } from "@/lib/workspace/store";
import type { BoundRow } from "@/lib/workspace/types";
import { WorkspaceBoard } from "@/components/workspace/workspace-board";

export default async function WorkspacePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const stored = await getBoard(session.user.id);
  // The Workspace surface (docs/understanding/SPEC.md §9): the same allowlist
  // as the Canvas, minus the inline styles that would cut a row off.
  const widgets = stored.board.widgets.map((w) => ({
    ...w,
    body: sanitizeCanvasMarkup(w.body, { surface: "workspace" }),
  }));

  // Resolve on the server so the first paint already carries real data. The
  // client keeps it fresh from here; it never has to fetch to show something.
  const tz = (session.user as { timezone?: string }).timezone ?? "UTC";
  // The ledes (docs/understanding/SPEC.md §9) ride along with the first paint
  // for the same reason the rows do: the board renders the last record and
  // never waits for a run.
  const [resolved, ledes] = await Promise.all([
    Promise.all(
      widgets
        .filter((w) => w.query)
        .map(async (w) => {
          try {
            return [w.id, await resolveBinding(session.user.id, w.query!, tz)] as const;
          } catch {
            return [w.id, [] as BoundRow[]] as const;
          }
        })
    ),
    ledesFor(session.user.id),
  ]);

  return (
    <div className="py-2">
      <h1 className="mb-3 text-lg font-bold">Workspace</h1>
      <WorkspaceBoard
        initial={{
          version: stored.version,
          widgets,
          rows: Object.fromEntries(resolved),
          ledes,
          focusId: stored.board.focusId,
          canUndo: stored.board.undo.length > 0,
          canRedo: stored.board.redo.length > 0,
        }}
      />
    </div>
  );
}
