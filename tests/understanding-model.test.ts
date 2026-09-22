// The model resolver in lib/understanding/run.ts: under vitest no provider is
// ever reachable, whatever UNDERSTANDING_PROVIDER says, and the auto wrapper
// answers a throwing primary with the secondary on the same input. The
// wrapper is tested through its seam, withFallback, with two fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCallFor, withFallback, type ModelCall } from "@/lib/understanding/run";
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
});
