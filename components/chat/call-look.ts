// The call's look, shared: the live voice call, the chat pill and the
// conversation card are one surface (Kiron, 2026-09-24: "they should both look
// the same; nothing should have that old flat look"). Black, re-tokened dark
// with data-theme="dark", and the accent's inset glow round the edge.
export const CALL_GLOW = "inset 0 0 90px 10px color-mix(in srgb, var(--accent) 38%, transparent)";
/** A softer glow for small surfaces (the pill): the same light, scaled down. */
export const CALL_GLOW_SMALL = "inset 0 0 28px 2px color-mix(in srgb, var(--accent) 45%, transparent)";
