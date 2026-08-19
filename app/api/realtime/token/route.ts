// Mints ephemeral Realtime client secrets. The real OPENAI_API_KEY never
// leaves this server; the briefing + persona + tools are baked into the
// session here, so the client can't tamper with instructions.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, usage, user as userTable } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { EL_MOUTH_VOICE, elevenLabsConfigured } from "@/lib/elevenlabs";
import { checkVoiceQuota } from "@/lib/rate-limit";
import { buildBriefing } from "@/lib/secretary/briefing";
import { buildLexicon, lexiconPrompt } from "@/lib/secretary/lexicon";
import { buildInstructions, VOICE_MODALITY_RULES } from "@/lib/secretary/persona";
import { openAIVoiceToolDefs } from "@/lib/secretary/tool-schemas";
import {
  REALTIME_MODEL_DEFAULT,
  REALTIME_MODEL_MINI,
  REALTIME_TRANSCRIBE_MODEL,
  REALTIME_VOICE,
  REALTIME_VOICES,
  TRANSCRIBE_LANGUAGE,
} from "@/lib/openai";

const bodySchema = z.object({
  model: z.string().optional(),
  voice: z.string().optional(),
  conversationId: z.string().nullish(),
  reconnect: z.boolean().optional(),
});

const ALLOWED_MODELS = new Set([REALTIME_MODEL_DEFAULT, REALTIME_MODEL_MINI]);
const ALLOWED_VOICES = new Set<string>(REALTIME_VOICES);

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const model = parsed.model ?? REALTIME_MODEL_DEFAULT;
  if (!ALLOWED_MODELS.has(model)) {
    return NextResponse.json({ error: "Unknown model" }, { status: 400 });
  }
  const voice = parsed.voice ?? REALTIME_VOICE;
  const elMouth = voice === EL_MOUTH_VOICE && elevenLabsConfigured();
  if (!ALLOWED_VOICES.has(voice) && !elMouth) {
    return NextResponse.json({ error: "Unknown voice" }, { status: 400 });
  }

  const quota = await checkVoiceQuota(user.id);
  if (!quota.ok) {
    return NextResponse.json({ error: quota.message }, { status: quota.status });
  }

  // Reuse the conversation on reconnect/model-switch; otherwise start one.
  let conversationId = parsed.conversationId ?? null;
  if (conversationId) {
    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1);
    if (!owned) conversationId = null;
  }
  if (!conversationId) {
    const [conv] = await db
      .insert(conversations)
      .values({ userId: user.id, mode: "voice" })
      .returning();
    conversationId = conv.id;
  } else {
    // Voice turns won't be in the text chain — force the next text message to
    // replay history instead of resuming a stale previous_response_id.
    await db
      .update(conversations)
      .set({ lastResponseId: null })
      .where(eq(conversations.id, conversationId));
  }

  const briefing = await buildBriefing(user.id, user.timezone, {
    consumeNudges: !parsed.reconnect,
  });
  const [[userRow], lexicon] = await Promise.all([
    db.select({ persona: userTable.persona }).from(userTable).where(eq(userTable.id, user.id)),
    buildLexicon(user.id),
  ]);
  const instructions = [
    buildInstructions(briefing.text, {
      reconnect: parsed.reconnect,
      persona: userRow?.persona,
    }),
    "",
    VOICE_MODALITY_RULES,
    ...(elMouth
      ? [
          "",
          "TTS OUTPUT MODE: your text output is SPOKEN verbatim by a TTS voice — write exactly what should be said, phone-call register, nothing that only works on a screen." +
            ((userRow?.persona?.sass ?? 4) >= 4
              ? ' You may use ElevenLabs audio tags VERY sparingly for delivery: [sighs], [pause] — at most one per reply, only when earned.'
              : ""),
        ]
      : []),
  ].join("\n");
  const transcriptionPrompt = lexiconPrompt(lexicon);

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions,
        // EL mouth (experimental): the session emits text; the browser speaks
        // it through the ElevenLabs voice. Otherwise: native audio out.
        output_modalities: elMouth ? ["text"] : ["audio"],
        // SPEC §11 fast/slow split: the mouth carries ONLY the thin tools.
        tools: openAIVoiceToolDefs(),
        tool_choice: "auto",
        audio: {
          input: {
            // SPEC §11 ASR lexicon: bias transcription toward the entity
            // store's exact spellings (CPO not CPU, CalCard not calc card).
            transcription: {
              model: REALTIME_TRANSCRIBE_MODEL,
              language: TRANSCRIBE_LANGUAGE,
              ...(transcriptionPrompt ? { prompt: transcriptionPrompt } : {}),
            },
            noise_reduction: { type: "near_field" },
            // Low eagerness: tolerate pauses — "one sec" and mid-thought
            // silence must not trigger a reply.
            turn_detection: { type: "semantic_vad", eagerness: "low" },
          },
          ...(elMouth ? {} : { output: { voice } }),
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("client_secrets failed:", res.status, detail.slice(0, 500));
    return NextResponse.json(
      { error: "Couldn't start a voice session. Try again in a moment." },
      { status: 502 }
    );
  }
  const secret = (await res.json()) as { value: string };

  const [usageRow] = await db
    .insert(usage)
    .values({ userId: user.id, kind: "voice", model, seconds: 0 })
    .returning();

  return NextResponse.json({
    clientSecret: secret.value,
    conversationId,
    usageId: usageRow.id,
    model,
  });
}
