"use client";

// The two main work surfaces — List ("spreadsheet" feel) and Board (kanban) —
// extracted so both the classic dashboard and the adaptive layout can render them.
import { useMemo, useState } from "react";
import {
  CheckButton,
  ProvenanceLink,
  STATUS_LABEL,
  fmtDue,
  isOverdue,
  type TaskRow,
} from "./shared";

type SortKey = "title" | "projectName" | "dueAt" | "status" | "updatedAt" | "postponedCount";

const BOARD_COLUMNS: { key: TaskRow["status"][]; title: string }[] = [
  { key: ["inbox", "todo"], title: "To do" },
  { key: ["in_progress"], title: "In progress" },
  { key: ["blocked"], title: "Blocked" },
  { key: ["done"], title: "Done" },
];

export function ListTable({
  tasks,
  crossing,
  onDone,
}: {
  tasks: TaskRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("dueAt");
  const [sortAsc, setSortAsc] = useState(true);

  const sorted = useMemo(() => {
    const rows = [...tasks];
    rows.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [tasks, sortKey, sortAsc]);

  const clickSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-edge text-left text-xs text-muted">
            {(
              [
                ["title", "Task"],
                ["projectName", "Project"],
                ["dueAt", "Due"],
                ["status", "Status"],
                ["updatedAt", "Last activity"],
                ["postponedCount", "Pushed"],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <th
                key={key}
                onClick={() => clickSort(key)}
                className="cursor-pointer select-none px-4 py-2.5 font-semibold hover:text-ink"
              >
                {label}
                {sortKey === key && <span className="ml-1">{sortAsc ? "▲" : "▼"}</span>}
              </th>
            ))}
            <th className="w-8 px-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const done = t.status === "done";
            const crossingNow = crossing.has(t.id);
            return (
              <tr
                key={t.id}
                className={`border-b border-edge/50 last:border-0 ${
                  isOverdue(t) ? "bg-danger/5" : ""
                }`}
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <CheckButton t={t} onDone={onDone} />
                    <span className={`cross-off ${done || crossingNow ? "crossed text-faint" : ""}`}>
                      {t.title}
                    </span>
                    <ProvenanceLink t={t} />
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {t.projectName ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: t.projectColor ?? "#7aa2ff" }}
                      />
                      {t.projectName}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td
                  className={`px-4 py-2.5 ${isOverdue(t) ? "font-semibold text-danger" : "text-muted"}`}
                >
                  {done ? "✓" : fmtDue(t.dueAt)}
                </td>
                <td className="px-4 py-2.5 text-muted">{STATUS_LABEL[t.status]}</td>
                <td className="px-4 py-2.5 text-faint">
                  {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
                    new Date(t.updatedAt)
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {t.postponedCount > 0 ? (
                    <span className={t.postponedCount > 2 ? "text-warn" : ""}>
                      {t.postponedCount}×
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td />
              </tr>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                Nothing yet — mention a task in chat or voice and it lands here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function BoardView({
  tasks,
  crossing,
  onDone,
}: {
  tasks: TaskRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {BOARD_COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => col.key.includes(t.status));
        return (
          <div
            key={col.title}
            className="min-w-[240px] flex-1 rounded-xl border border-edge bg-surface p-3"
          >
            <p className="mb-2.5 flex items-center justify-between text-xs font-bold uppercase tracking-wide text-muted">
              {col.title}
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-faint">
                {colTasks.length}
              </span>
            </p>
            <div className="space-y-2">
              {colTasks.map((t) => {
                const done = t.status === "done";
                const crossingNow = crossing.has(t.id);
                return (
                  <div
                    key={t.id}
                    className={`rounded-lg border bg-card px-3 py-2.5 text-sm ${
                      isOverdue(t) ? "border-danger/50" : "border-edge"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <CheckButton t={t} onDone={onDone} />
                      <div className="min-w-0">
                        <p className={`cross-off ${done || crossingNow ? "crossed text-faint" : ""}`}>
                          {t.title}
                        </p>
                        <p className="mt-1 flex items-center gap-2 text-xs text-faint">
                          {t.projectName && (
                            <span className="inline-flex items-center gap-1">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ background: t.projectColor ?? "#7aa2ff" }}
                              />
                              {t.projectName}
                            </span>
                          )}
                          {t.dueAt && !done && (
                            <span className={isOverdue(t) ? "text-danger" : ""}>
                              {fmtDue(t.dueAt)}
                            </span>
                          )}
                          {t.postponedCount > 1 && (
                            <span className="text-warn">pushed {t.postponedCount}×</span>
                          )}
                          <ProvenanceLink t={t} />
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
