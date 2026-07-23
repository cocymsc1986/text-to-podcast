// Triggered by S3 ObjectCreated under audio/ when Polly finishes writing an MP3.
// Records the audio size, marks the item ready, and rebuilds the RSS feed.
import type { S3Event } from "aws-lambda";
import { episodeIdFromKey } from "../lib/tts.js";
import { finalizeAudio } from "../lib/pipeline.js";

export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    if (!key.endsWith(".mp3")) continue;
    const episodeId = episodeIdFromKey(key);
    if (!episodeId) {
      console.warn("could not derive episode id from key", key);
      continue;
    }
    console.log("finalizing", episodeId, key);
    await finalizeAudio(episodeId, key);
  }
}
