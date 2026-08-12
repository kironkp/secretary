// OpenAI client for the harness's own actors (simulator, judge, generator) —
// separate from the app's client so harness model choices never leak into the
// system under test.
import { readFileSync } from "node:fs";
import OpenAI from "openai";

function apiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const m = readFileSync(".env.local", "utf8").match(/^OPENAI_API_KEY=(.+)$/m);
    if (m) return m[1].replace(/^"|"$/g, "");
  } catch {
    /* fallthrough */
  }
  throw new Error("OPENAI_API_KEY not found for sim harness");
}

export const simOpenai = new OpenAI({ apiKey: apiKey() });

/** Structured-output helper: instructions + input → validated JSON. */
export async function jsonCall<T>(opts: {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  parse: (raw: unknown) => T;
}): Promise<T> {
  const response = await simOpenai.responses.create({
    model: opts.model,
    instructions: opts.instructions,
    input: opts.input,
    text: {
      format: {
        type: "json_schema",
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  });
  return opts.parse(JSON.parse(response.output_text || "{}"));
}

/** Plain text call (user simulator turns). */
export async function textCall(opts: {
  model: string;
  instructions: string;
  input: string;
}): Promise<string> {
  const response = await simOpenai.responses.create({
    model: opts.model,
    instructions: opts.instructions,
    input: opts.input,
  });
  return response.output_text ?? "";
}

/** mulberry32 — tiny seeded PRNG for stable persona quirk selection. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
