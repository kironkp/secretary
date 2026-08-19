// ElevenLabs mouth: the pure sentence pipeline (playback needs a browser).
import { describe, expect, it } from "vitest";
import { cutSentences } from "@/lib/realtime/el-mouth";

describe("cutSentences", () => {
  it("cuts complete sentences and keeps the tail buffered", () => {
    const [sentences, rest] = cutSentences("Okay, hang on. CPO 2073 is due Friday. And the alb");
    expect(sentences).toEqual(["Okay, hang on.", "CPO 2073 is due Friday."]);
    expect(rest).toBe("And the alb");
  });

  it("handles streaming accumulation across deltas", () => {
    let buffer = "";
    let spoken: string[] = [];
    for (const delta of ["Take your ti", "me. I'm not going anyw", "here. Mm-hm. "]) {
      const [sentences, rest] = cutSentences(buffer + delta);
      spoken = spoken.concat(sentences);
      buffer = rest;
    }
    expect(spoken).toEqual(["Take your time.", "I'm not going anywhere.", "Mm-hm."]);
    expect(buffer).toBe("");
  });

  it("keeps question/exclamation cuts and quoted ends", () => {
    const [sentences, rest] = cutSentences('Is that 2073 or 2079? Pick one. "Fine." Then');
    expect(sentences).toEqual(["Is that 2073 or 2079?", "Pick one.", '"Fine."']);
    expect(rest).toBe("Then");
  });
});
