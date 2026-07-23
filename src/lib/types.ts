// Shared domain types for the URL/RSS -> private podcast pipeline.

/** A subscribed source: either a standing RSS feed or a one-off URL drop. */
export interface Feed {
  id: string;
  type: "rss" | "url";
  sourceUrl: string;
  title: string;
  /** Poll and ingest new items while true. */
  active: boolean;
  /**
   * When true, newly ingested items from this feed are converted to audio
   * automatically. When false (the default), items just land in the reading
   * queue and wait for the user to press "Convert".
   */
  autoConvert: boolean;
  lastPolledAt?: string;
  createdAt: string;
}

export type ReadState = "unread" | "read" | "archived";

/** Ingest lifecycle: fetched -> main content extracted (or failed). */
export type QueueStatus = "new" | "extracted" | "extract_failed";

/**
 * Conversion lifecycle. `none` until the user (or auto-convert) requests audio;
 * then it walks queued -> scripted -> synthesizing -> ready (or failed).
 */
export type ConvertState =
  | "none"
  | "queued"
  | "scripted"
  | "synthesizing"
  | "ready"
  | "failed";

/** A reading-queue entry. Extracted on ingest, but NOT synthesized until asked. */
export interface Item {
  id: string;
  feedId: string;
  /** Stable per-source id used to dedupe (RSS guid, or the URL for one-offs). */
  sourceGuid: string;
  sourceUrl: string;
  title: string;
  /** Clean main-content text from Readability; empty until extracted. */
  articleText: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
  readState: ReadState;
  queueStatus: QueueStatus;
  convertState: ConvertState;
  /** Set once conversion produces an Episode. */
  episodeId?: string;
  error?: string;
  addedAt: string;
}

/** A produced audio episode. Created only when an Item is converted. */
export interface Episode {
  id: string;
  itemId: string;
  title: string;
  showNotes: string;
  sourceUrl: string;
  /** S3 key of the MP3, e.g. audio/<id>.mp3. */
  audioKey: string;
  durationSec?: number;
  bytes?: number;
  pubDate: string;
}

export type ConvertMode = "full-read" | "summary";

/** Single-row app configuration. */
export interface Config {
  /** Unguessable token embedded in the private feed URL. */
  feedToken: string;
  /** Polly voice id, e.g. "Matthew", "Joanna", "Amy". */
  voiceId: string;
  mode: ConvertMode;
  podcastTitle: string;
  podcastDescription: string;
  podcastAuthor: string;
}
