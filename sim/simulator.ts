// The fake human: a cheap model plays the persona, one user message per turn.
// Seeded PRNG keeps quirk selection stable per (persona, scenario) so replays
// with --live stay close to the original.
import { cfg } from "./config";
import type { Persona, Scenario } from "./fixtures/types";
import { hashString, seededRandom, textCall } from "./llm";

const DONE = "<<DONE>>";

export function makeSimulator(persona: Persona, scenario: Scenario) {
  const rand = seededRandom(persona.seed ^ hashString(scenario.id));

  const styleRules = [
    persona.style.verbosity === "terse"
      ? "Keep messages under 15 words."
      : persona.style.verbosity === "rambly"
        ? "Ramble — 30-50 words, tangents allowed."
        : "Normal length messages, 15-30 words.",
    persona.style.typos ? "Include occasional realistic typos (don't overdo it)." : "",
    persona.style.selfCorrections !== "never"
      ? `Correct yourself mid-message ${persona.style.selfCorrections === "often" ? "frequently" : "occasionally"} ("...no wait, actually...").`
      : "",
  ].filter(Boolean);

  return async function nextMessage(
    transcript: { user: string; assistant: string }[],
    turnNumber: number
  ): Promise<string | null> {
    const quirk =
      persona.quirks.length > 0 && rand() < 0.5
        ? `This turn, lean into this quirk: ${persona.quirks[Math.floor(rand() * persona.quirks.length)]}`
        : "";
    const hint = scenario.scriptHints.find((h) => h.toLowerCase().startsWith(`turn ${turnNumber}`));

    const instructions = [
      `You are ${persona.name}, a real person talking to their AI secretary app. ${persona.background}`,
      `YOUR GOAL for this conversation: ${scenario.goal}`,
      "Rules:",
      "- Stay in character. Output ONLY your next message to the secretary — plain text, no quotes, no narration.",
      ...styleRules.map((r) => `- ${r}`),
      quirk ? `- ${quirk}` : "",
      hint ? `- IMPORTANT for this turn: ${hint.replace(/^turn \d+:\s*/i, "")}` : "",
      `- When your goal is fully satisfied by the secretary's responses, output exactly ${DONE} and nothing else.`,
      `- If the secretary asks a clarifying question, answer it plausibly in character.`,
    ]
      .filter(Boolean)
      .join("\n");

    const input =
      transcript.length === 0
        ? "(Start the conversation — say your opening message.)"
        : transcript.flatMap((t) => [`You said: ${t.user}`, `Secretary: ${t.assistant}`]).join("\n");

    const out = (await textCall({ model: cfg.simModel, instructions, input })).trim();
    if (!out || out.includes(DONE)) return null;
    return out.slice(0, 800);
  };
}
