// v1.10 (docs/tasks/SPEC.md §2.3): a suggested task's note is its reason alone now; notes stored before with the
// "Suggested: " prefix stay as they are and are shown without it. One helper for every place that shows one.

/** A note as shown: without the "Suggested: " prefix older suggestions were stored with. */
export const withoutSuggested = (note: string): string => note.replace(/^Suggested: /, "");
