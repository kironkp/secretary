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
import { getBoard } from "@/lib/workspace/store";
import { WorkspaceBoard } from "@/components/workspace/workspace-board";

export default async function WorkspacePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const stored = await getBoard(session.user.id);
  const widgets = stored.board.widgets.map((w) => ({
    ...w,
    body: sanitizeCanvasMarkup(w.body),
  }));

  return (
    <div className="py-2">
      <h1 className="mb-3 text-lg font-bold">Workspace</h1>
      <WorkspaceBoard
        initial={{
          version: stored.version,
          widgets,
          focusId: stored.board.focusId,
          canUndo: stored.board.undo.length > 0,
          canRedo: stored.board.redo.length > 0,
        }}
      />
    </div>
  );
}
