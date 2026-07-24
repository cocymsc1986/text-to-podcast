// Amazon Polly async synthesis. StartSpeechSynthesisTask handles up to 100k
// billed characters in a single call and writes the finished MP3 straight to
// S3 -- so no text chunking and no audio stitching.
import {
  PollyClient,
  StartSpeechSynthesisTaskCommand,
  type Engine,
} from "@aws-sdk/client-polly";
import { BUCKET, AUDIO_PREFIX } from "./store.js";

const polly = new PollyClient({});

// Polly async caps a task at 100,000 billed characters. Guard so we fail loudly
// rather than truncating silently on an unusually long piece.
const MAX_CHARS = 100_000;

// Voice engine. `generative` and `long-form` sound markedly more human than
// `neural` (more natural intonation, pacing, and emphasis) — default to
// generative for the most lifelike delivery. Override with POLLY_ENGINE if the
// chosen voice/region doesn't support it (falls back well to `neural`).
// See supported voices: https://docs.aws.amazon.com/polly/latest/dg/voicelist.html
const ENGINE = (process.env.POLLY_ENGINE ?? "generative") as Engine;

export interface SynthesisStarted {
  taskId: string;
  /** Prefix we asked Polly to write under; the final key adds ".<taskId>.mp3". */
  outputPrefix: string;
}

export async function startSynthesis(
  episodeId: string,
  text: string,
  voiceId: string,
): Promise<SynthesisStarted> {
  if (text.length > MAX_CHARS) {
    throw new Error(
      `Script is ${text.length} chars, over Polly's ${MAX_CHARS} limit for one task`,
    );
  }
  // Polly writes to `<prefix>.<taskId>.mp3`; encode the episode id in the prefix
  // so the S3-event finalize handler can recover it from the object key.
  const outputPrefix = `${AUDIO_PREFIX}/${episodeId}`;
  const res = await polly.send(
    new StartSpeechSynthesisTaskCommand({
      Text: text,
      TextType: "text",
      OutputFormat: "mp3",
      VoiceId: voiceId as any,
      Engine: ENGINE,
      OutputS3BucketName: BUCKET,
      OutputS3KeyPrefix: outputPrefix,
    }),
  );
  const taskId = res.SynthesisTask?.TaskId;
  if (!taskId) throw new Error("Polly did not return a task id");
  return { taskId, outputPrefix };
}

/**
 * Recover the episode id from the key Polly wrote, i.e.
 * `audio/<episodeId>.<taskId>.mp3` -> `<episodeId>`.
 */
export function episodeIdFromKey(key: string): string | undefined {
  const base = key.startsWith(`${AUDIO_PREFIX}/`)
    ? key.slice(AUDIO_PREFIX.length + 1)
    : key;
  const id = base.split(".")[0];
  return id || undefined;
}
