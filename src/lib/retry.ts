// Small retry helper for the flaky, network-bound steps of the pipeline
// (page fetch, Claude, Polly). Retries a handful of times with exponential
// backoff so a transient blip doesn't drop an item into a failed state.

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff in ms; doubles each retry (base, 2×base, 4×base, …). */
  baseDelayMs?: number;
  /** Label used in log lines so it's clear which step is retrying. */
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff. Non-retryable
 * failures (see `isRetryable`) throw immediately; the last error is rethrown
 * once attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const label = opts.label ?? "operation";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `${label} attempt ${attempt}/${attempts} failed, retrying in ${delay}ms:`,
        String((err as any)?.message ?? err),
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Best-effort classification of transient failures worth retrying: network
 * errors, timeouts, throttling, and 5xx / 429 responses. A definite 4xx (other
 * than 429) is treated as permanent so we fail fast on genuinely bad input.
 */
export function isRetryable(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;

  // AWS SDK / fetch surface transient conditions on these fields.
  if (e.$retryable) return true;
  const status: number | undefined =
    e.status ?? e.statusCode ?? e.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false; // permanent client error
  }

  const name = String(e.name ?? "");
  const code = String(e.code ?? "");
  const msg = String(e.message ?? e).toLowerCase();
  const transient = [
    "throttl",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "eai_again",
    "socket hang up",
    "network",
    "fetch failed",
    "service unavailable",
    "too many requests",
  ];
  if (transient.some((t) => msg.includes(t))) return true;
  if (/Throttl|Timeout|ServiceUnavailable|Unavailable/i.test(name + code)) return true;

  // Unknown/opaque errors: retry once rather than give up on a possible blip.
  return status === undefined && name === "" && code === "";
}
