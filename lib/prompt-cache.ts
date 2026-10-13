// The one place that says how long the app asks Anthropic to keep a cached
// prompt prefix (docs/spend/SPEC.md §1.1). Every request that marks a prefix
// cacheable takes its marker from here, and the price of the write is read
// from the same constant (lib/usage.ts), so the two cannot drift apart: a
// 1-hour cache costs 2 times the input rate to write, a 5-minute one 1.25.
//
// Pure: no I/O.

/** A cache lifetime Anthropic sells. */
export type CacheLifetime = "5m" | "1h";

/** What the app asks for. 5 minutes is the provider's default (no `ttl` sent). */
export const PROMPT_CACHE_LIFETIME: CacheLifetime = "5m";

/** The `cache_control` marker for a block that ends a cacheable prefix. */
export function cacheControl(lifetime: CacheLifetime = PROMPT_CACHE_LIFETIME): { type: "ephemeral"; ttl?: "1h" } {
  return lifetime === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
