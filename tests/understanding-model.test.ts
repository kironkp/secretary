// The model resolver in lib/understanding/run.ts: under vitest no provider is
// ever reachable, whatever UNDERSTANDING_PROVIDER says, and the auto wrapper
// answers a throwing primary with the secondary on the same input. The
// wrapper is tested through its seam, withFallback, with two fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callByProvider,
  modelCallFor,
  ModelOutputError,
  withFallback,
  type ModelCall,
} from "@/lib/understanding/run";
import type { Bundle } from "@/lib/understanding/types";

const savedProvider = process.env.UNDERSTANDING_PROVIDER;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.UNDERSTANDING_PROVIDER;
  else process.env.UNDERSTANDING_PROVIDER = savedProvider;
});

describe("modelCallFor under vitest", () => {
  it("returns null for every provider setting without throwing", async () => {
    for (const provider of ["anthropic", "openai", "auto", "nonsense", undefined]) {
      if (provider === undefined) delete process.env.UNDERSTANDING_PROVIDER;
      else process.env.UNDERSTANDING_PROVIDER = provider;
      await expect(modelCallFor("no-such-user")).resolves.toBeNull();
    }
  });
});

const input: Parameters<ModelCall>[0] = {
  system: "system",
  user: "user",
  bundle: {} as Bundle,
  attempt: 0,
  previousErrors: [],
};

const result = (model: string) => ({ output: { model }, model, inputTokens: 1, outputTokens: 1 });

describe("withFallback", () => {
  it("returns the primary's result and never calls the secondary when the primary resolves", async () => {
    const primary = vi.fn<ModelCall>(async () => result("primary"));
    const secondary = vi.fn<ModelCall>(async () => result("secondary"));
    const onFallback = vi.fn();
    const call = withFallback(primary, secondary, onFallback);

    await expect(call(input)).resolves.toEqual(result("primary"));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("calls the secondary with the same input when the primary throws, reporting the error once", async () => {
    const error = new Error("400 usage limit reached");
    const primary = vi.fn<ModelCall>(async () => {
      throw error;
    });
    const secondary = vi.fn<ModelCall>(async () => result("secondary"));
    const onFallback = vi.fn();
    const call = withFallback(primary, secondary, onFallback);

    await expect(call(input)).resolves.toEqual(result("secondary"));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledWith(input);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(error);
  });

  it("lets the secondary's own error through, so the run's retry sees it", async () => {
    const primary = vi.fn<ModelCall>(async () => {
      throw new Error("primary down");
    });
    const secondary = vi.fn<ModelCall>(async () => {
      throw new Error("secondary down");
    });
    const call = withFallback(primary, secondary);
    await expect(call(input)).rejects.toThrow("secondary down");
  });

  it("works without an onFallback", async () => {
    const primary: ModelCall = async () => {
      throw new Error("no");
    };
    const secondary: ModelCall = async () => result("secondary");
    await expect(withFallback(primary, secondary)(input)).resolves.toEqual(result("secondary"));
  });

  it("with the secondary preferred and closed, the primary answers and the preference is reported wrong", async () => {
    const primary = vi.fn<ModelCall>(async () => result("primary"));
    const secondary = vi.fn<ModelCall>(async () => {
      throw new Error("429 no credits");
    });
    const onFallback = vi.fn();
    const onRecovered = vi.fn();
    const call = withFallback(primary, secondary, onFallback, () => true, onRecovered);

    await expect(call(input)).resolves.toEqual(result("primary"));
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect((onRecovered.mock.calls[0][0] as Error).message).toBe("429 no credits");
  });

  it("with the secondary preferred and both closed, the primary's error is the one thrown, and both are reported", async () => {
    const primary: ModelCall = async () => {
      throw new Error("claude down");
    };
    const secondary: ModelCall = async () => {
      throw new Error("openai down");
    };
    const onBothClosed = vi.fn();
    await expect(
      withFallback(primary, secondary, undefined, () => true, undefined, onBothClosed)(input)
    ).rejects.toThrow("claude down");
    expect(onBothClosed).toHaveBeenCalledTimes(1);
    expect((onBothClosed.mock.calls[0][0] as Error).message).toBe("claude down");
    expect((onBothClosed.mock.calls[0][1] as Error).message).toBe("openai down");
  });

  it("with both closed the other way round, the secondary's error is thrown with the primary's beside it", async () => {
    const primary: ModelCall = async () => {
      throw new Error("claude down");
    };
    const secondary: ModelCall = async () => {
      throw new Error("openai down");
    };
    const onBothClosed = vi.fn();
    await expect(
      withFallback(primary, secondary, undefined, undefined, undefined, onBothClosed)(input)
    ).rejects.toThrow("openai down");
    expect((onBothClosed.mock.calls[0][0] as Error).message).toBe("openai down");
    expect((onBothClosed.mock.calls[0][1] as Error).message).toBe("claude down");
  });

  it("a bad answer (ModelOutputError) never falls back: it goes back to the same model", async () => {
    const primary = vi.fn<ModelCall>(async () => {
      throw new ModelOutputError("claude output is not JSON (stop_reason end_turn)");
    });
    const secondary = vi.fn<ModelCall>(async () => result("secondary"));
    const onFallback = vi.fn();
    await expect(withFallback(primary, secondary, onFallback)(input)).rejects.toBeInstanceOf(ModelOutputError);
    expect(secondary).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    // And the preferred road's bad answer does not send the call to the other road either.
    const badSecondary = vi.fn<ModelCall>(async () => {
      throw new ModelOutputError("openai output is not JSON");
    });
    const goodPrimary = vi.fn<ModelCall>(async () => result("primary"));
    await expect(withFallback(goodPrimary, badSecondary, undefined, () => true)(input)).rejects.toBeInstanceOf(
      ModelOutputError
    );
    expect(goodPrimary).not.toHaveBeenCalled();
  });
});

// The choice interpret.ts shares with the run, on a call shape of its own:
// which thunk is built, and which call answers, per provider setting.
describe("callByProvider", () => {
  type Read = (input: { user: string }) => Promise<string>;
  const claude = vi.fn<Read>(async ({ user }) => `claude read ${user}`);
  const gpt = vi.fn<Read>(async ({ user }) => `gpt read ${user}`);
  const build = () => {
    const built = { claude: 0, gpt: 0 };
    return {
      built,
      claude: async () => (built.claude++, claude as Read),
      gpt: async () => (built.gpt++, gpt as Read),
    };
  };

  afterEach(() => {
    claude.mockClear();
    gpt.mockClear();
  });

  it("builds and uses only the named provider", async () => {
    process.env.UNDERSTANDING_PROVIDER = "anthropic";
    let b = build();
    await expect((await callByProvider(b.claude, b.gpt, "read"))!({ user: "x" })).resolves.toBe("claude read x");
    expect(b.built).toEqual({ claude: 1, gpt: 0 });

    process.env.UNDERSTANDING_PROVIDER = "openai";
    b = build();
    await expect((await callByProvider(b.claude, b.gpt, "read"))!({ user: "x" })).resolves.toBe("gpt read x");
    expect(b.built).toEqual({ claude: 0, gpt: 1 });
  });

  it("with neither named, uses whichever provider exists, and null with none", async () => {
    delete process.env.UNDERSTANDING_PROVIDER;
    const b = build();
    await expect((await callByProvider(async () => null, b.gpt, "read"))!({ user: "x" })).resolves.toBe("gpt read x");
    await expect((await callByProvider(b.claude, async () => null, "read"))!({ user: "x" })).resolves.toBe(
      "claude read x"
    );
    await expect(callByProvider<{ user: string }, string>(async () => null, async () => null, "read")).resolves.toBeNull();
  });

  it("with both, Claude answers first and a throw is answered by OpenAI on the same input, with one warning naming the call", async () => {
    delete process.env.UNDERSTANDING_PROVIDER;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const b = build();
      const call = (await callByProvider(b.claude, b.gpt, "interpret call"))!;
      await expect(call({ user: "one" })).resolves.toBe("claude read one");
      expect(gpt).not.toHaveBeenCalled();

      claude.mockImplementationOnce(async () => {
        throw new Error("400 usage limit");
      });
      await expect(call({ user: "two" })).resolves.toBe("gpt read two");
      expect(gpt).toHaveBeenCalledWith({ user: "two" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("claude interpret call failed (400 usage limit)");
    } finally {
      warn.mockRestore();
    }
  });
});
