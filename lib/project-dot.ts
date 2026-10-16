// v1.10 r2: a project's dot, the same everywhere it is drawn (the Projects list, the task screen): its own colour,
// or the accent when it has none.
export const projectDotColor = (color: string | null | undefined): string => color ?? "var(--color-accent)";
