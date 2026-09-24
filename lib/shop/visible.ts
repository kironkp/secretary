// The Shop is parked (2026-09-24): its requests were not getting built, and
// "I'll send that to the shop" had become Secretary's answer to anything it
// could not do. Nothing is deleted — the tools, the worker and the table all
// stay — but unless SHOP_VISIBLE=true the model is not handed the shop tools,
// its persona does not mention the shop, the briefing leaves the shop out,
// and Settings hides the section.
export const SHOP_TOOL_NAMES = ["request_capability", "review_capability"] as const;

export function shopVisible(): boolean {
  return process.env.SHOP_VISIBLE === "true";
}

/** Tool names with the shop's taken out while it is parked. */
export function withoutHiddenShop<T extends string>(names: readonly T[]): T[] {
  if (shopVisible()) return [...names];
  return names.filter((n) => !(SHOP_TOOL_NAMES as readonly string[]).includes(n));
}
