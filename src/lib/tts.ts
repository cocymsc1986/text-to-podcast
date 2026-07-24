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
// generative for the most lifelike delivery. Override with POLLY_ENGINE.
// See supported voices: https://docs.aws.amazon.com/polly/latest/dg/voicelist.html
const ENGINE = (process.env.POLLY_ENGINE ?? "generative") as Engine;

// Not every voice/region supports every engine (e.g. a voice may offer neural
// but not generative). Try the configured engine first, then step down through
// progressively more widely supported engines so synthesis still succeeds with
// the best available quality instead of failing outright.
const ENGINE_FALLBACKS: Engine[] = ["generative", "long-form", "neural", "standard"];
const enginePreference = (): Engine[] =>
  [ENGINE, ...ENGINE_FALLBACKS].filter((e, i, a) => a.indexOf(e) === i);

/** Polly rejects an unsupported voice/engine pair with this class of message. */
const isEngineUnsupported = (err: unknown): boolean =>
  /does not support the selected engine|not supported.*engine|engine.*not supported/i.test(
    String((err as any)?.message ?? err),
  );

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
  const engines = enginePreference();

  let lastErr: unknown;
  for (const engine of engines) {
    try {
      const res = await polly.send(
        new StartSpeechSynthesisTaskCommand({
          Text: text,
          TextType: "text",
          OutputFormat: "mp3",
          VoiceId: voiceId as any,
          Engine: engine,
          OutputS3BucketName: BUCKET,
          OutputS3KeyPrefix: outputPrefix,
        }),
      );
      const taskId = res.SynthesisTask?.TaskId;
      if (!taskId) throw new Error("Polly did not return a task id");
      if (engine !== ENGINE) {
        console.warn(`Voice ${voiceId} does not support ${ENGINE}; used ${engine} instead`);
      }
      return { taskId, outputPrefix };
    } catch (err) {
      lastErr = err;
      // Only step down to the next engine when this voice simply doesn't offer
      // the current one; any other failure (throttling, bad input) should bubble
      // up so the caller's retry/error handling sees it.
      if (!isEngineUnsupported(err)) throw err;
    }
  }
  throw lastErr;
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
