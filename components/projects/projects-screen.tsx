"use client";

// The Projects tab as approved (docs/projects/SPEC.md §5): the title, the
// "New project" button, and each group in his order. The button opens a row
// at the top of Active with its name field focused; Enter, or leaving the
// field, makes the project through the path the chat's create_project takes,
// and it arrives unplaced, at its urgency place. An empty name makes nothing.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectList, type ProjectRowView } from "./project-list";

export type ProjectGroups = { active: ProjectRowView[]; lists: ProjectRowView[]; setAside: ProjectRowView[] };

function NewProjectRow({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [line, setLine] = useState<string | null>(null);
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    const trimmed = name.trim();
    if (!trimmed) {
      onDone();
      return;
    }
    const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmed }) }).catch(() => null);
    if (!res?.ok) {
      saving.current = false;
      setLine(`Couldn't make ${trimmed}.`);
      return;
    }
    router.refresh();
    onDone();
  };
  return (
    <li data-new-project-row="" className="flex min-h-14 items-center gap-3 pl-4 pr-1 first:rounded-t-[12px] last:rounded-b-[12px]">
      <span aria-hidden className="h-3 w-3 flex-none rounded-full border border-faint" />
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") onDone();
        }}
        onBlur={() => void save()}
        placeholder="New project"
        aria-label="New project name"
        enterKeyHint="done"
        className="min-h-11 min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-muted"
      />
      {line && <span className="flex-none pr-3 text-[15px] text-danger">{line}</span>}
    </li>
  );
}

export function ProjectsScreen({ groups }: { groups: ProjectGroups }) {
  const [adding, setAdding] = useState(false);
  const empty = !groups.active.length && !groups.lists.length && !groups.setAside.length;
  return (
    <>
      <div className="flex items-center justify-between pb-3 pt-5">
        <h1 className="text-[34px] font-bold leading-[40px]">Projects</h1>
        <button
          type="button"
          aria-label="New project"
          onClick={() => setAdding(true)}
          className="-mr-2 flex h-11 w-11 flex-none items-center justify-center text-accent-ink"
        >
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      {empty && !adding && <p className="text-[15px] text-muted">No projects yet. Make one with the plus, or mention one in a chat or a call.</p>}
      <div className="flex flex-col gap-[10px]">
        {(groups.active.length > 0 || adding) && (
          <section className="flex flex-col">
            <ProjectList group="active" rows={groups.active} leading={adding ? <NewProjectRow onDone={() => setAdding(false)} /> : null} />
          </section>
        )}
        {groups.lists.length > 0 && (
          <section className="flex flex-col">
            <h2 className="px-1 pb-2 pt-4 text-[20px] font-bold leading-[26px]">Lists</h2>
            <ProjectList group="lists" rows={groups.lists} />
          </section>
        )}
        {groups.setAside.length > 0 && (
          <section className="flex flex-col">
            <h2 className="px-1 pb-2 pt-4 text-[20px] font-bold leading-[26px]">Set aside</h2>
            <ProjectList group="set_aside" rows={groups.setAside} />
          </section>
        )}
      </div>
    </>
  );
}
