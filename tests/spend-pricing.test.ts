// SEC-A004: every paid call is priced, so Settings, the spend alert and the
// caps see it. Voice calls, read-aloud, ElevenLabs sentences and dictation
// were all stored with cost_usd null, which every reader counts as $0. The
// providers are faked here; nothing leaves the machine.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const env = vi.hoisted(() => {
  process.env.ELEVENLABS_API_KEY = "el-test-not-sent";
  process.env.ELEVENLABS_VOICE_ID = "voice-test";
  return {};
});
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "no" }, { status: 401 }) };
});
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  return {
    ...real,
    openai: {
      audio: {
        speech: { create: async () => ({ body: null }) },
        transcriptions: { create: async () => ({ text: "hello" }) },
      },
    },
  };
});

import { db } from "@/lib/db";
import { usage, user } from "@/lib/db/schema";
import { priceRealtime } from "@/lib/pricing";
import { POST as endCall } from "@/app/api/realtime/end/route";
import { POST as speak } from "@/app/api/speak/route";
import { POST as elevenlabs } from "@/app/api/elevenlabs/tts/route";
import { POST as transcribe } from "@/app/api/transcribe/route";

void env;
const U = { id: `test-pricing-${crypto.randomUUID()}`, email: `pricing-${Date.now()}@sec-a004.test`, name: "Pricing", timezone: "America/Los_Angeles" };
const json = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rowsOf = (kind: "voice" | "speech" | "transcribe") =>
  db.select().from(usage).where(and(eq(usage.userId, U.id), eq(usage.kind, kind)));

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: U.name, email: U.email, timezone: U.timezone });
  session.user = U;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("a voice call is priced when it ends", () => {
  it("cached input is priced as cached: a re-sent conversation is not billed as fresh audio", () => {
    const split = { textIn: 100_000, audioIn: 400_000, cachedTextIn: 90_000, cachedAudioIn: 380_000, textOut: 2_000, audioOut: 20_000 };
    const priced = priceRealtime("gpt-realtime-2.1", split);
    // fresh text 10k × $4 + cached text 90k × $0.40 + fresh audio 20k × $32
    // + cached audio 380k × $0.40 + text out 2k × $24 + audio out 20k × $64, per million
    expect(priced.usd).toBeCloseTo((10_000 * 4 + 90_000 * 0.4 + 20_000 * 32 + 380_000 * 0.4 + 2_000 * 24 + 20_000 * 64) / 1e6, 6);
    expect(priced.known).toBe(true);
    // As all-fresh audio it would have been about ten times that.
    const naive = (500_000 * 32 + 22_000 * 64) / 1e6;
    expect(naive / priced.usd).toBeGreaterThan(5);
  });

  it("the end of a call stores its price, its split and its listening minutes", async () => {
    const [row] = await db.insert(usage).values({ userId: U.id, kind: "voice", model: "gpt-realtime-2.1", seconds: 0 }).returning();
    const split = { textIn: 20_000, audioIn: 60_000, cachedTextIn: 15_000, cachedAudioIn: 50_000, textOut: 500, audioOut: 4_000 };
    const res = await endCall(json("http://localhost/api/realtime/end", { usageId: row.id, seconds: 300, inputTokens: 80_000, outputTokens: 4_500, split }));
    expect(res.status).toBe(200);
    const [after] = await db.select().from(usage).where(eq(usage.id, row.id));
    const expected = priceRealtime("gpt-realtime-2.1", split).usd + (300 / 60) * 0.017;
    expect(Number(after.costUsd)).toBeCloseTo(expected, 5);
    expect(after).toMatchObject({ audioInputTokens: 60_000, audioOutputTokens: 4_000, cachedInputTokens: 65_000, costEstimated: false });
    // No separate transcription row: the dictation quota counts those.
    expect(await rowsOf("transcribe")).toEqual([]);
  });
});

describe("speech and dictation are priced, and kept out of the voice-call quota", () => {
  it("read-aloud is 'speech', priced per minute", async () => {
    await speak(json("http://localhost/api/speak", { text: "Here is your day: two meetings and a dentist appointment." }));
    const [row] = await rowsOf("speech");
    expect(row.model).toBe("gpt-4o-mini-tts");
    expect(Number(row.costUsd)).toBeGreaterThan(0);
    expect((await rowsOf("voice")).some((r) => r.model === "gpt-4o-mini-tts")).toBe(false);
  });

  it("an ElevenLabs sentence is 'speech', priced per character", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("mp3", { status: 200 }));
    try {
      const text = "Your dentist is at two thirty.";
      await elevenlabs(json("http://localhost/api/elevenlabs/tts", { text }));
      const row = (await rowsOf("speech")).find((r) => r.model?.startsWith("elevenlabs/"))!;
      expect(row.inputTokens).toBe(text.length);
      expect(Number(row.costUsd)).toBeCloseTo((text.length / 1000) * 0.1, 6);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("dictation is priced per minute", async () => {
    const form = new FormData();
    form.append("audio", new File([new Uint8Array(32_000)], "clip.webm", { type: "audio/webm" }));
    await transcribe(new Request("http://localhost/api/transcribe", { method: "POST", body: form }));
    const [row] = await rowsOf("transcribe");
    expect(row.seconds).toBe(2);
    expect(Number(row.costUsd)).toBeCloseTo((2 / 60) * 0.0045, 6);
  });
});
