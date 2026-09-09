// ASR lexicon export (SPEC §11): the entity store continuously feeds the
// realtime session's transcription biasing so "CPO" stops arriving as "CPU"
// and "CalCard" as "calc card". Sources: entities (people, orgs, terms,
// acronyms — aliases included, unconfirmed included since they're still
// likely real words the ASR will meet again) + project names. Every new
// session gets the current store; that IS the update-on-every-entity loop,
// since sessions are where ASR happens.
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entities, projects } from "@/lib/db/schema";

const MAX_TERMS = 120; // transcription prompt budget — most recent wins

export async function buildLexicon(userId: string): Promise<string[]> {
  const [entityRows, projectRows] = await Promise.all([
    db
      .select()
      .from(entities)
      .where(eq(entities.userId, userId))
      .orderBy(desc(entities.lastMentionedAt)),
    db.select({ name: projects.name }).from(projects).where(eq(projects.userId, userId)),
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (t: string) => {
    const trimmed = t.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    terms.push(trimmed);
  };
  for (const e of entityRows) {
    add(e.name);
    for (const alias of e.aliases) add(alias);
  }
  for (const p of projectRows) add(p.name);
  return terms.slice(0, MAX_TERMS);
}

/** The transcription-biasing prompt for the realtime session. */
/** The Realtime API caps this prompt at 1024 characters and rejects the whole
 *  session request if it is longer — which means an ordinary "the entity store
 *  grew" day silently becomes "Couldn't start the call", with nothing in the
 *  UI to explain it. The lexicon is a recognition HINT, so dropping the tail is
 *  a small loss; failing the call is not. Terms arrive most-useful-first, so we
 *  keep the head and cut at a whole term. */
const TRANSCRIPTION_PROMPT_MAX = 1024;

export function lexiconPrompt(terms: string[]): string | undefined {
  if (!terms.length) return undefined;
  const head = "Vocabulary likely to appear (bias recognition toward these exact spellings): ";
  const budget = TRANSCRIPTION_PROMPT_MAX - head.length - 1; // trailing "."

  const kept: string[] = [];
  let used = 0;
  for (const term of terms) {
    const cost = (kept.length ? 2 : 0) + term.length; // ", " + term
    if (used + cost > budget) break;
    kept.push(term);
    used += cost;
  }
  if (!kept.length) return undefined;
  return `${head}${kept.join(", ")}.`;
}
