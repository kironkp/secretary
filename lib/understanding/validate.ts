// Validation of a run's output — docs/understanding/SPEC.md §4 steps 1-5.
//
// Everything here is mechanical: no model, no database. The model's JSON is
// parsed by the schema and then checked against the bundle it was written
// from, because the schema can say "this is a Source" but only the bundle can
// say "this id is real". Every error is collected, not just the first, so a
// retry can quote all of them at once.
import { z } from "zod";
import { matchProjectName } from "@/lib/project-names";
import { STOPLIST, digitTokens, escapeRegExp } from "./terms";
import {
  runOutputSchema,
  type Bundle,
  type Claim,
  type RunOutput,
  type Source,
  type SourceType,
  type Write,
} from "./types";

export type ValidationResult = { ok: true; value: RunOutput } | { ok: false; errors: string[] };

/** SPEC §4 step 4, the list as written there. Matched on word boundaries, case-insensitively. */
export const BANNED_WORDS = [
  "slipped",
  "stale",
  "agenda",
  "leverage",
  "bandwidth",
  "circle back",
] as const;

const BANNED = new RegExp(
  `(?<![A-Za-z])(?:${BANNED_WORDS.map(escapeRegExp).join("|")})(?![A-Za-z])`,
  "i"
);

/**
 * A promise of future action by Secretary. The loop writes a record and
 * questions; it never touches the user's rows, and only an answer they give
 * does. So "I'll clear them rather than chase the dates" — a real lede on
 * 2026-09-23 — was a promise nothing could keep, and Kiron reasonably read
 * it as done. The committed future is refused, and so is the claim that it
 * already happened ("I have cleared them"), which reads the same way. The
 * conditional ("I would close that old copy") is a recommendation and
 * stays, because that is how an answer's why is supposed to read. What is
 * inside quotation marks is the user speaking and is never matched.
 */
const PROMISE =
  /\bI(?:'ll|\u2019ll| will| am going to|'m going to|\u2019m going to| plan to| intend to| am clearing| have cleared|'ve cleared|\u2019ve cleared)\b/i;

/**
 * Text with every quotation removed. The "I" inside quotation marks is the
 * USER speaking, not Secretary: the prompt actively rewards a why that
 * copies four or more words out of a message (referencesEvidence), and
 * `decisions` is where a commitment the user made in the first person
 * belongs. Refusing those failed the whole run — three attempts, then six
 * hours of backoff — for quoting the person correctly.
 */
function outsideQuotes(text: string): string {
  return text.replace(/["\u201c\u2018'\u2019][^"\u201c\u201d\u2018\u2019]*["\u201d\u2018\u2019']/g, " ");
}

export function promiseIn(text: string): string | null {
  const m = PROMISE.exec(outsideQuotes(text));
  return m ? m[0] : null;
}

export function bannedWordIn(text: string): string | null {
  const m = BANNED.exec(text);
  return m ? m[0] : null;
}

/**
 * "Days as digits" (SPEC §4 step 4, §7): "on the 22nd", never "on the
 * twenty-second". A spelled-out ordinal is a day when it is one only a
 * calendar uses (eleventh through thirty-first) or when a low ordinal sits in
 * a date construction: after "on the" / "by the" / "due the" / a month name,
 * or before "of <month>". A bare "first", "the second copy" or "after the
 * first payment" is ordinary English and stays — §7 itself says a lede tells
 * "which is oldest or first" — so the prepositions here are only the ones
 * that read as a date with a low ordinal after them.
 */
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const LOW_ORDINAL = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)";
const HIGH_ORDINAL =
  "(?:eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|" +
  `twentieth|thirtieth|(?:twenty|thirty)[- ]${LOW_ORDINAL})`;
const ANY_ORDINAL = `(?:${HIGH_ORDINAL}|${LOW_ORDINAL})`;
const SPELLED_DAY = new RegExp(
  "(?<![A-Za-z])(?:" +
    [
      HIGH_ORDINAL,
      `(?:on|by|until|till|due)\\s+the\\s+${ANY_ORDINAL}`,
      `${MONTH}\\.?\\s+(?:the\\s+)?${ANY_ORDINAL}`,
      `${ANY_ORDINAL}\\s+of\\s+${MONTH}`,
    ].join("|") +
    ")(?![A-Za-z])",
  "i"
);

export function spelledDayIn(text: string): string | null {
  const m = SPELLED_DAY.exec(text);
  return m ? m[0] : null;
}

/**
 * Sentences, counted mechanically. A terminator is . ! or ? followed by
 * whitespace or the end, unless it follows a single capital letter (an initial
 * like "U.S." or the end of "CPO."), which errs lenient rather than strict.
 * Text with no terminator at all is one sentence.
 */
export function countSentences(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const ends = (t.match(/(?<![A-Z])[.!?]+(?=\s|$)/g) ?? []).length;
  const unterminated = /[.!?]["')\]]*$/.test(t) ? 0 : 1;
  return Math.max(1, ends + unterminated);
}

/**
 * The names a lede uses: 3+-digit numbers and capitalized 3+-letter words,
 * minus the stoplist. A capitalized word that begins a sentence is ordinary
 * prose ("Three of these are past due") unless it is written in all caps
 * (CPO, TASCAM), so it is exempt from the row-title check; the cost is that a
 * proper noun in first position ("Antenna waits on the TASCAM item") is not
 * caught. Without the exemption every English lede would fail on its first
 * word and the run could never converge.
 */
export function ledeNames(lede: string): string[] {
  const out: string[] = [...digitTokens(lede)];
  const re = /(?<![A-Za-z0-9])[A-Z][A-Za-z]{2,}(?![A-Za-z0-9])/g;
  for (const m of lede.matchAll(re)) {
    const word = m[0];
    if (STOPLIST.has(word.toLowerCase())) continue;
    const before = lede.slice(0, m.index).replace(/["'(\[\s]+$/, "");
    const sentenceInitial = before.length === 0 || /[.!?]$/.test(before);
    const allCaps = word === word.toUpperCase();
    if (sentenceInitial && !allCaps) continue;
    out.push(word);
  }
  return out;
}

/**
 * Calendar words a lede may use without naming anything. "Blocked since
 * August 21" says when, not what; without this every dated lede would fail
 * the row-title check. Weekday and month names only — dates stay digits.
 */
const CALENDAR_WORDS: ReadonlySet<string> = new Set(
  [
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December",
    "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "Mon", "Tue", "Tues", "Wed", "Thu", "Thur", "Thurs", "Fri", "Sat", "Sun",
    "Today", "Tomorrow", "Yesterday",
  ].map((w) => w.toLowerCase())
);

const wordsOf = (s: string): string[] =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/**
 * A word with its plain English inflections, both ways: "CPOs" must find a
 * row titled "Process CPO 2073", and "copy" a row that says "copies". Without
 * this the row-title check rejects ordinary prose ("Both CPOs are the same
 * job") and, since a failed lede regenerates, the run can loop on grammar.
 */
export function inflections(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set([w, `${w}s`, `${w}es`]);
  if (w.endsWith("y")) out.add(`${w.slice(0, -1)}ies`);
  if (w.endsWith("ies") && w.length > 4) out.add(`${w.slice(0, -3)}y`);
  if (w.endsWith("es") && w.length > 3) out.add(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 2) out.add(w.slice(0, -1));
  return [...out];
}

/** Which bundle rows a Source of each type may point at. */
/** Every id in the bundle, by source type; exported for repair.ts. */
export function idIndex(bundle: Bundle): Record<SourceType, Set<string>> {
  return {
    task: new Set([...bundle.tasksOpen, ...bundle.tasksDone].map((t) => t.id)),
    memory: new Set(bundle.memories.map((m) => m.id)),
    message: new Set(bundle.messages.map((m) => m.id)),
    event: new Set(bundle.events.map((e) => e.id)),
    document: new Set(bundle.documents.map((d) => d.id)),
    expectation: new Set(bundle.expectations.map((e) => e.id)),
  };
}

/**
 * The text each bundle row is known by — what "its real title or quote" (SPEC
 * §7) can mean for a question's evidence: a task's, event's or document's
 * title, a memory's fact, a message's content, an expectation's commitment.
 */
function textIndex(bundle: Bundle): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of [...bundle.tasksOpen, ...bundle.tasksDone]) out.set(`task:${t.id}`, t.title);
  for (const m of bundle.memories) out.set(`memory:${m.id}`, m.fact);
  for (const m of bundle.messages) out.set(`message:${m.id}`, m.content);
  for (const e of bundle.events) out.set(`event:${e.id}`, e.title);
  for (const d of bundle.documents) out.set(`document:${d.id}`, d.title);
  for (const e of bundle.expectations) out.set(`expectation:${e.id}`, e.commitment);
  return out;
}

/** Case- and whitespace-blind, for "does this text contain that one". */
const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A quote shorter than this could be "the"; it names nothing on its own. */
const MIN_QUOTE_CHARS = 4;

/** A question is one breath (SPEC §7): the mockup's longest is ten words. */
const MAX_QUESTION_WORDS = 14;
/** An answer label is an action: "Close the old one" is four words, 17 characters. */
const MAX_LABEL_WORDS = 4;
const MAX_LABEL_CHARS = 28;

/** Four words in a row is a quotation; three is a phrase anyone could write. */
const MIN_RUN_WORDS = 4;

/** Two texts share a run of `n` consecutive words. */
function sharesRun(a: string[], b: string[], n: number): boolean {
  if (a.length < n || b.length < n) return false;
  const grams = new Set<string>();
  for (let i = 0; i + n <= a.length; i++) grams.add(a.slice(i, i + n).join(" "));
  for (let i = 0; i + n <= b.length; i++) {
    if (grams.has(b.slice(i, i + n).join(" "))) return true;
  }
  return false;
}

/** A number of three or more digits is an id (a CPO number, a form number). */
function sharesNumber(why: string, text: string): boolean {
  const own = new Set(text.match(/\b\d{3,}\b/g) ?? []);
  return (why.match(/\b\d{3,}\b/g) ?? []).some((n) => own.has(n));
}

/** Capitalized words that are prose, not names, when they appear mid-sentence. */
const NOT_NAMES = new Set([
  "the", "this", "that", "these", "those", "and", "for", "with", "from", "after", "before",
  "secretary", "suggested", "suggestion", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tomorrow", "yesterday",
]);

/**
 * A capitalized word inside the item's text (never its first word, which is
 * capitalized for being first) that the why also uses: a person, a place, a
 * product. "Marissa" in a why about a task that names Marissa is a reference.
 */
function sharesName(why: string, text: string): boolean {
  const names = new Set(
    (text.match(/(?<=\S\s+)[A-Z][a-z]{2,}/g) ?? [])
      .map((n) => n.toLowerCase())
      .filter((n) => !NOT_NAMES.has(n))
  );
  if (names.size === 0) return false;
  return wordsOf(why).some((w) => names.has(w));
}

/**
 * SPEC §7: a question's `why` must name at least one evidence item. It does
 * so with the item's full title, with a quote that is really in the source
 * it is attached to (so the model cannot satisfy the rule with a quote it
 * wrote itself), with four or more words in a row from the item, with a
 * number the item carries, or with a name the item carries. Anything looser
 * is a why about nothing in particular; anything stricter rejects "the open
 * 2073 copy", which is how a person refers to a task with a long title.
 * Evidence whose id is not in the bundle is skipped here — step 1 already
 * reported it.
 */
function referencesEvidence(why: string, evidence: Source[], texts: Map<string, string>): boolean {
  const w = fold(why);
  const whyWords = wordsOf(why);
  for (const s of evidence) {
    const text = texts.get(`${s.type}:${s.id}`);
    if (text === undefined) continue;
    const t = fold(text);
    if (t && w.includes(t)) return true;
    if (s.quote) {
      const q = fold(s.quote);
      if (q.length >= MIN_QUOTE_CHARS && t.includes(q) && w.includes(q)) return true;
    }
    if (sharesRun(whyWords, wordsOf(text), MIN_RUN_WORDS)) return true;
    if (sharesNumber(why, text)) return true;
    if (sharesName(why, text)) return true;
  }
  return false;
}

/** Every text the record itself carries: thing names, aliases and ids, and
 *  the text of every claim. All of it is sourced, so a lede may use it. */
function recordWords(record: RunOutput["record"]): string[] {
  const out: string[] = [];
  const claim = (c: { text: string } | undefined) => {
    if (c) out.push(c.text);
  };
  for (const t of record.things) {
    out.push(t.name, ...t.aliases, ...t.ids);
    claim(t.state);
    claim(t.waitingOn);
  }
  for (const c of [
    ...record.rules,
    ...record.decisions,
    ...record.currentWork,
    ...record.blockers,
    ...record.attempts,
  ]) {
    claim(c);
  }
  claim(record.objective);
  claim(record.nextAction);
  claim(record.resumePointer);
  for (const c of record.contradictions) out.push(c.text);
  for (const u of record.unknowns) out.push(u.text, u.why);
  return out;
}

/** What the retry is told when a why names nothing: the items it could name. */
function evidenceHint(evidence: Source[], texts: Map<string, string>): string {
  const shown = evidence
    .map((s) => ({ key: `${s.type}:${s.id}`, text: texts.get(`${s.type}:${s.id}`) }))
    .filter((e): e is { key: string; text: string } => typeof e.text === "string")
    .slice(0, 3)
    .map((e) => `[${e.key}] "${e.text.length > 90 ? `${e.text.slice(0, 90)}…` : e.text}"`);
  return shown.length ? ` Its evidence: ${shown.join("; ")}` : "";
}

/** The (op, id) identity of a write, for the one-write-per-pair rule. */
function writeKey(w: Write): string {
  switch (w.op) {
    case "complete_task":
    case "drop_task":
    case "set_due":
    case "set_recurrence":
    case "set_blocked_reason":
    case "set_project":
    case "rename_task":
    case "set_step":
      return `${w.op}:${w.taskId}`;
    case "save_process":
      return `${w.op}:${w.name.toLowerCase()}`;
    case "clear_expectation":
      return `${w.op}:${w.expectationId}`;
    case "remember_fact":
      return `${w.op}:${w.fact}`;
    case "resolve":
      return "resolve";
  }
}

export function validateRunOutput(output: unknown, bundle: Bundle): ValidationResult {
  const parsed = runOutputSchema.safeParse(output);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i: z.core.$ZodIssue) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`
      ),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];
  const ids = idIndex(bundle);
  const texts = textIndex(bundle);
  /** Open tasks Secretary suggested: the rows a question must let the user bin. */
  const openSuggestions = new Set(
    bundle.tasksOpen.filter((t) => t.source === "suggested").map((t) => t.id)
  );

  // --- step 1: every source points at a row in the bundle ------------------
  const checkSources = (sources: Source[], path: string) => {
    for (const [i, s] of sources.entries()) {
      if (!ids[s.type].has(s.id)) {
        errors.push(`${path}.sources[${i}]: unknown ${s.type} id "${s.id}"`);
      }
    }
  };

  // --- step 2: every claim has at least one source -------------------------
  // The schema already refuses an empty array; the explicit check is here so
  // the rule is visible where the claims are walked, and so contradictions,
  // which are not Claims, get the same treatment.
  const checkClaim = (claim: Claim | undefined, path: string) => {
    if (!claim) return;
    if (claim.sources.length === 0) errors.push(`${path}: claim has no sources`);
    checkSources(claim.sources, path);
    checkText(claim.text, `${path}.text`);
  };

  // --- step 4: plain language, on every text the output carries ------------
  const checkText = (text: string, path: string) => {
    const banned = bannedWordIn(text);
    if (banned) errors.push(`${path}: banned word "${banned}"`);
    const day = spelledDayIn(text);
    if (day) errors.push(`${path}: days as digits, not "${day}"`);
    const promise = promiseIn(text);
    if (promise) {
      errors.push(
        `${path}: "${promise}" promises something you cannot do. Nothing here changes the user's list; only an answer they give does. Say what is true now, or what you would do if they said so.`
      );
    }
  };

  const r = value.record;
  checkClaim(r.objective, "record.objective");
  checkClaim(r.nextAction, "record.nextAction");
  checkClaim(r.resumePointer, "record.resumePointer");
  for (const [k, list] of [
    ["rules", r.rules],
    ["decisions", r.decisions],
    ["currentWork", r.currentWork],
    ["blockers", r.blockers],
    ["attempts", r.attempts],
  ] as const) {
    list.forEach((c, i) => checkClaim(c, `record.${k}[${i}]`));
  }
  r.things.forEach((t, i) => {
    checkText(t.name, `record.things[${i}].name`);
    t.aliases.forEach((a, ai) => checkText(a, `record.things[${i}].aliases[${ai}]`));
    checkClaim(t.state, `record.things[${i}].state`);
    checkClaim(t.waitingOn, `record.things[${i}].waitingOn`);
  });
  r.contradictions.forEach((c, i) => {
    const path = `record.contradictions[${i}]`;
    if (c.sources.length === 0) errors.push(`${path}: contradiction has no sources`);
    checkSources(c.sources, path);
    checkText(c.text, `${path}.text`);
  });
  r.unknowns.forEach((u, i) => {
    const path = `record.unknowns[${i}]`;
    checkSources(u.sources, path);
    checkText(u.text, `${path}.text`);
    checkText(u.why, `${path}.why`);
  });

  // --- step 3: questions, evidence and the writes their answers carry ------
  value.questions.forEach((q, qi) => {
    const path = `questions[${qi}]`;
    // An answer may only write to what the question shows (SPEC §6: "ids come
    // from the evidence"), and answer.ts refuses anything else. The model
    // names a task in a write without listing it as evidence often enough
    // that two answers on production came back "bad-answer"; a write's
    // target is evidence by definition, so it is added here rather than
    // rejected. Step 1 below still checks the id is real.
    const listed = new Set(q.evidence.map((s) => `${s.type}:${s.id}`));
    for (const a of q.answers) {
      for (const w of a.writes) {
        const target: Source | null =
          "taskId" in w
            ? { type: "task", id: w.taskId }
            : "expectationId" in w
              ? { type: "expectation", id: w.expectationId }
              : null;
        // Only an id the bundle has: an invented one is the write's own
        // error (step 3), reported once, not twice.
        if (
          target &&
          ids[target.type].has(target.id) &&
          !listed.has(`${target.type}:${target.id}`)
        ) {
          q.evidence.push(target);
          listed.add(`${target.type}:${target.id}`);
        }
      }
    }
    // A question resting on the app's OWN open suggestions must offer a way
    // to bin them. They are Secretary's guesses, not the user's work, and
    // the honest choice about a guess nobody took up is to drop it. On
    // 2026-09-23 a question about four such rows offered only "did they
    // happen", "partly", "restart tomorrow" and a way out, so when Kiron
    // typed "old suggestions you can get rid of" there was nothing behind
    // the words and the four tasks stayed on his list.
    const suggested = q.evidence
      .filter((e) => e.type === "task" && openSuggestions.has(e.id))
      .map((e) => e.id);
    if (suggested.length > 0) {
      const drops = new Set(
        q.answers.flatMap((a) =>
          a.writes.flatMap((w) => (w.op === "drop_task" ? [w.taskId] : []))
        )
      );
      if (!suggested.some((id) => drops.has(id))) {
        errors.push(
          `${path}.answers: rests on ${suggested.length === 1 ? "a task" : `${suggested.length} tasks`} I suggested and the user never took up, so one answer must offer to drop ${suggested.length === 1 ? "it" : "them"} — a drop_task on at least one of ${suggested.join(", ")}, and on all of them when the question is about all of them`
        );
      }
    }
    checkSources(q.evidence, path);
    checkText(q.question, `${path}.question`);
    // A label is a button the user reads, and a thing's name is the word
    // every sentence about it uses; both were checked for nothing.
    q.answers.forEach((a, ai) => checkText(a.label, `${path}.answers[${ai}].label`));
    checkText(q.why, `${path}.why`);
    if (!/[?.]["')]*$/.test(q.question.trim())) {
      errors.push(`${path}.question: must end with ? or .`);
    }
    // Said out loud in one breath (SPEC §7; the user could not read
    // "Should I clean up the CPO 2073 / Production monitor tasks that still
    // say blocked even though the notes and finished task say the FY2027
    // work is done?"). Words, not characters: numbers and names are words.
    const questionWords = q.question.trim().split(/\s+/).length;
    if (questionWords > MAX_QUESTION_WORDS) {
      errors.push(
        `${path}.question: ${questionWords} words; say it in at most ${MAX_QUESTION_WORDS}, naming the thing by its nickname and number, not its title`
      );
    }
    if (q.question.includes("/")) {
      errors.push(`${path}.question: contains a slash; that is a pasted title, name the thing instead`);
    }
    for (const [ai, a] of q.answers.entries()) {
      const words = a.label.trim().split(/\s+/).length;
      if (words > MAX_LABEL_WORDS || a.label.length > MAX_LABEL_CHARS) {
        errors.push(
          `${path}.answers[${ai}].label: "${a.label}" is not an action in plain words; at most ${MAX_LABEL_WORDS} words and ${MAX_LABEL_CHARS} characters, like "Close the old one" or "Keep them"`
        );
      }
      if (/\/|\b[A-Z]{2,}\d{2,}\b|\b[A-Z]{3}-\d{3,}\b/.test(a.label)) {
        errors.push(`${path}.answers[${ai}].label: "${a.label}" carries a code or a slash; say the action in plain words`);
      }
    }
    if (countSentences(q.why) > 2) errors.push(`${path}.why: more than 2 sentences`);
    if (!referencesEvidence(q.why, q.evidence, texts)) {
      errors.push(
        `${path}.why: does not name any of its evidence items. Name one: its title, four or more of its words in a row, a number it carries, or a name it carries.${evidenceHint(q.evidence, texts)}`
      );
    }

    q.answers.forEach((a, ai) => {
      const apath = `${path}.answers[${ai}]`;
      const seen = new Set<string>();
      a.writes.forEach((w, wi) => {
        const wpath = `${apath}.writes[${wi}]`;
        if ("taskId" in w && !ids.task.has(w.taskId)) {
          errors.push(`${wpath}: unknown task id "${w.taskId}"`);
        }
        if ("expectationId" in w && !ids.expectation.has(w.expectationId)) {
          errors.push(`${wpath}: unknown expectation id "${w.expectationId}"`);
        }
        // A set_project names a project; the apply path resolves the name
        // with the same matcher and never creates one, so a name that lands
        // nowhere here would be a write guaranteed to fail when answered.
        if (w.op === "set_project" && !matchProjectName(w.project, bundle.projectNames)) {
          errors.push(
            `${wpath}: no project named "${w.project}"; use one listed under PROJECTS: ${bundle.projectNames.join(", ") || "(none)"}`
          );
        }
        // A set_step names a process; the apply path finds it by the same
        // name, so one that is not under PROCESSES would fail when answered.
        if (w.op === "set_step") {
          const names = (bundle.processes ?? []).map((p) => p.name);
          const proc = (bundle.processes ?? []).find(
            (p) => p.name.toLowerCase() === w.process.toLowerCase()
          );
          if (!proc) {
            errors.push(
              `${wpath}: no process named "${w.process}"; use one listed under PROCESSES: ${names.join(", ") || "(none)"}`
            );
          } else if (w.step > proc.steps.length) {
            errors.push(`${wpath}: "${proc.name}" has ${proc.steps.length} steps, not ${w.step}`);
          }
        }
        // A run never saves a process; only the user's own words do (SPEC §5).
        if (w.op === "save_process") errors.push(`${wpath}: save_process is not a run's to write`);
        const key = writeKey(w);
        if (seen.has(key)) errors.push(`${wpath}: duplicate write ${key}`);
        seen.add(key);
      });
    });
  });

  // --- step 4 continued: the words --------------------------------------
  // The Today line is one or two sentences (SPEC §7): what is due today, then
  // what lands tomorrow. A third sentence is a paragraph.
  if (value.words.todayLine !== undefined) {
    checkText(value.words.todayLine, "words.todayLine");
    if (countSentences(value.words.todayLine) > 2) {
      errors.push("words.todayLine: more than 2 sentences");
    }
  }

  // --- step 5: a lede may only name what is in its widget -----------------
  const projectWords = new Set(wordsOf(bundle.project.name));
  for (const [widgetId, lede] of Object.entries(value.words.ledes)) {
    const path = `words.ledes.${widgetId}`;
    const widget = bundle.widgets.find((w) => w.id === widgetId);
    if (!widget) {
      errors.push(`${path}: "${widgetId}" is not a widget in the bundle`);
      continue;
    }
    checkText(lede, path);
    if (countSentences(lede) > 3) errors.push(`${path}: more than 3 sentences`);

    const exempt = new Set([...CALENDAR_WORDS, ...projectWords, ...wordsOf(widget.title)]);
    // Every word of every row title and of the project name, so a name is
    // looked up as a token (the same boundary rule terms.ts uses) and its
    // plural or singular counts as the same name. The record's own words are
    // allowed too: its things, rules and claims all carry sources (steps 1
    // and 2), so a lede that says "which means you can reconcile the CPO"
    // above a statement task is context, not invention. What this still
    // rejects is a name that appears nowhere the model was given.
    const haystack = new Set(
      [...widget.rows.map((row) => row.title), bundle.project.name, ...recordWords(value.record)].flatMap(
        wordsOf
      )
    );
    const reported = new Set<string>();
    for (const name of ledeNames(lede)) {
      const lower = name.toLowerCase();
      if (exempt.has(lower) || reported.has(lower)) continue;
      if (!inflections(lower).some((form) => haystack.has(form))) {
        reported.add(lower);
        errors.push(`${path}: lede names something not in the widget: "${name}"`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}
