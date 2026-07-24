import { describe, it, expect } from "vitest";
import { withRetry, isRetryable } from "../src/lib/retry.js";

describe("retry.isRetryable", () => {
  it("retries 5xx and 429 but not other 4xx", () => {
    expect(isRetryable({ statusCode: 503 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(isRetryable({ statusCode: 404 })).toBe(false);
    expect(isRetryable({ status: 400 })).toBe(false);
  });

  it("retries transient network/throttle errors", () => {
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
    expect(isRetryable({ name: "ThrottlingException" })).toBe(true);
    expect(isRetryable({ $retryable: {} })).toBe(true);
  });
});

describe("retry.withRetry", () => {
  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("timeout");
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a permanent (4xx) failure", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { statusCode: 404, message: "not found" };
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toBe(1);
  });

  it("gives up after the configured number of attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("timeout");
        },
        { attempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("timeout");
    expect(calls).toBe(2);
  });
});
