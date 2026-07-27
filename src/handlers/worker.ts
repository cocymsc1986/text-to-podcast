// Background worker Lambda. Invoked asynchronously (InvocationType "Event") by
// the API and poller so the network-heavy pipeline steps — page fetch +
// Readability, Claude scripting, Polly synthesis — run off the request path.
// This keeps the API fast (no 503s from a request timing out) and lets many
// conversions run in parallel instead of one holding a request while the rest
// stay stuck "queued".
import type { WorkerEvent } from "../lib/pipeline.js";
import { runWork } from "../lib/pipeline.js";

export async function handler(event: WorkerEvent): Promise<void> {
  await runWork(event);
}
