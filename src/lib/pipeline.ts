// Orchestration shared by the API, poller, worker, and finalize handlers. Two
// phases: (A) ingest -> reading queue (always, no audio), (B) convert -> audio.
//
// The network-heavy steps (page fetch + Readability, Claude scripting, Polly
// synthesis) are NOT run inside the synchronous API request. Instead the API
// enqueues background work on the worker Lambda and returns immediately, so a
// slow page or a slow Claude call can never time out the request (which surfaced
// to users as sporadic 503s) and multiple conversions all start in parallel
// instead of one holding the request while the rest stay stuck "queued".
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import type { Episode, Feed, Item } from "./types.js";
import { extractFromUrl } from "./extract.js";
import { MAX_ARTICLE_CHARS, MAX_ITEMS_PER_POLL } from "./limits.js";
import { fetchSourceFeed, selectNewest } from "./rssIn.js";
import { makeScript } from "./script.js";
import { startSynthesis } from "./tts.js";
import { buildFeedXml } from "./rssOut.js";
import { withRetry } from "./retry.js";
import {
  audioKeyFor,
  createItemIfNew,
  ensureConfig,
  feedKeyFor,
  getFeed,
  getItem,
  headAudio,
  itemId,
  listEpisodes,
  newId,
  putEpisode,
  putFeedXml,
  putItem,
  updateFeedPolled,
} from "./store.js";

const MEDIA_BASE_URL = () => (process.env.MEDIA_BASE_URL ?? "").replace(/\/$/, "");

// --- Background work dispatch --------------------------------------------------
// A conversion (or extraction) that entered a working state longer ago than this
// is treated as stranded — a worker that died or a Polly/S3 finalize that never
// arrived — and is allowed to be restarted instead of blocking forever.
export const STALE_CONVERT_MS = 10 * 60 * 1000;

/** Background job handed to the worker Lambda. */
export type WorkerEvent =
  | { kind: "extract"; itemId: string; autoConvert?: boolean }
  | { kind: "convert"; itemId: string };

const lambda = new LambdaClient({});

/**
 * Hand a job to the worker Lambda (async "Event" invocation → returns at once).
 * When WORKER_FUNCTION_NAME is unset (local dev / tests) the work runs inline so
 * behaviour is unchanged; in AWS it always runs out-of-band.
 */
export async function enqueueWork(event: WorkerEvent): Promise<void> {
  const fnName = process.env.WORKER_FUNCTION_NAME;
  if (!fnName) {
    await runWork(event);
    return;
  }
  await lambda.send(
    new InvokeCommand({
      FunctionName: fnName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
}

/** Worker entrypoint: run one enqueued job to completion (never throws). */
export async function runWork(event: WorkerEvent): Promise<void> {
  if (event.kind === "extract") return runExtract(event.itemId, event.autoConvert);
  if (event.kind === "convert") return runConvert(event.itemId);
}

// --- Phase A: ingest ----------------------------------------------------------

/** Add a one-off URL to the reading queue; extraction runs in the background. */
export async function ingestUrl(url: string): Promise<Item> {
  const id = itemId("manual", url);
  const base: Item = {
    id,
    feedId: "manual",
    sourceGuid: url,
    sourceUrl: url,
    title: url,
    articleText: "",
    readState: "unread",
    queueStatus: "new",
    convertState: "none",
    addedAt: new Date().toISOString(),
  };
  const { item, created } = await createItemIfNew(base);
  if (!created) return item;
  // Extract off the request path so a slow page fetch can't 503 the API; the
  // item shows "fetching…" and the UI polls until it flips to extracted/failed.
  await enqueueWork({ kind: "extract", itemId: item.id });
  return item;
}

/** Poll one source feed, queue any new items, and (optionally) auto-convert. */
export async function ingestFeed(feed: Feed): Promise<Item[]> {
  const source = await fetchSourceFeed(feed.sourceUrl);
  // Only ingest the newest N entries so a subscribe never floods the queue with
  // a busy feed's whole backlog. Per-feed `ingestLimit` overrides the global
  // default; 0 means "no cap" (ingest all items).
  const limit =
    feed.ingestLimit === undefined ? MAX_ITEMS_PER_POLL
    : feed.ingestLimit === 0 ? Infinity
    : feed.ingestLimit;
  const newest = selectNewest(source.items, limit);
  const results: Item[] = [];
  for (const si of newest) {
    const id = itemId(feed.id, si.guid);
    const { item, created } = await createItemIfNew({
      id,
      feedId: feed.id,
      sourceGuid: si.guid,
      sourceUrl: si.link,
      title: si.title,
      articleText: "",
      readState: "unread",
      queueStatus: "new",
      convertState: "none",
      addedAt: si.isoDate ?? new Date().toISOString(),
    });
    if (!created) continue;
    // Extract (and, for auto-convert feeds, convert) each item in its own worker
    // invocation. Doing it inline here would run N page-fetch + Claude + Polly
    // chains sequentially in one poll and time the poller out, stranding the
    // later items — the "first converts, the rest never start" bug.
    await enqueueWork({ kind: "extract", itemId: item.id, autoConvert: feed.autoConvert });
    results.push(item);
  }
  await updateFeedPolled(feed.id, new Date().toISOString());
  return results;
}

/** Worker job: extract an item, then convert it too if the feed auto-converts. */
export async function runExtract(id: string, autoConvert = false): Promise<void> {
  const item = await getItem(id);
  if (!item) return;
  const extracted = await extractItem(item);
  if (autoConvert && extracted.queueStatus === "extracted") {
    await startConvert(extracted.id);
  }
}

/** Fetch + Readability. Updates and returns the item; never throws on bad pages. */
export async function extractItem(item: Item): Promise<Item> {
  try {
    // Retry transient fetch failures (timeouts, 5xx, network blips) before
    // giving up and flagging the item as failed.
    const a = await withRetry(() => extractFromUrl(item.sourceUrl), {
      label: `extract ${item.sourceUrl}`,
    });
    const updated: Item = {
      ...item,
      title: a.title || item.title,
      articleText: a.text,
      excerpt: a.excerpt,
      byline: a.byline,
      siteName: a.siteName,
      queueStatus: "extracted",
      error: undefined,
    };
    return putItem(updated);
  } catch (err: any) {
    return putItem({ ...item, queueStatus: "extract_failed", error: String(err?.message ?? err) });
  }
}

/** Re-run extraction for an item (e.g. one that previously failed). */
export async function reextractItem(id: string): Promise<Item> {
  const item = await getItem(id);
  if (!item) throw new Error(`Item ${id} not found`);
  // Flip it back to "fetching…" now and do the fetch in the background.
  const reset = await putItem({ ...item, queueStatus: "new", error: undefined });
  await enqueueWork({ kind: "extract", itemId: id });
  return reset;
}

// --- Phase B: convert (spends Claude + Polly budget) --------------------------

/** True while an item is mid-conversion (before it settles ready/failed). */
export function isConverting(item: Item): boolean {
  return (
    item.convertState === "queued" ||
    item.convertState === "scripted" ||
    item.convertState === "synthesizing"
  );
}

/**
 * A conversion is "stranded" if it's been in a working state longer than
 * STALE_CONVERT_MS (worker crashed, or the Polly/S3 finalize never fired). Such
 * an item is safe to restart rather than block on forever. Items with no
 * timestamp (from before this field existed) are also treated as restartable.
 */
export function isConvertStale(item: Item): boolean {
  if (!isConverting(item)) return false;
  if (!item.convertStartedAt) return true;
  return Date.now() - new Date(item.convertStartedAt).getTime() > STALE_CONVERT_MS;
}

/**
 * Mark a queued item for conversion and hand the heavy work (Claude + Polly) to
 * the worker Lambda. Returns immediately so the API request can't time out.
 * Idempotent: a conversion already in flight (and not stranded) is left alone.
 */
export async function startConvert(id: string): Promise<Item> {
  const item = await getItem(id);
  if (!item) throw new Error(`Item ${id} not found`);
  if (item.queueStatus !== "extracted" || !item.articleText) {
    throw new Error(`Item ${id} is not extracted yet`);
  }
  // Don't double-start a conversion that's genuinely still running. A stranded
  // one (stale timestamp) falls through and is restarted below.
  if (isConverting(item) && !isConvertStale(item)) return item;

  // Abuse guard: keep oversized articles out of the LLM prompt and Polly
  // entirely. Flag the item so the UI shows why instead of silently spending
  // budget on a book-length or hostile page.
  if (item.articleText.length > MAX_ARTICLE_CHARS) {
    return putItem({
      ...item,
      convertState: "failed",
      convertStartedAt: undefined,
      error:
        `Article is ${item.articleText.length.toLocaleString()} characters, over the ` +
        `${MAX_ARTICLE_CHARS.toLocaleString()}-character limit for conversion.`,
    });
  }

  const queued = await putItem({
    ...item,
    convertState: "queued",
    convertStartedAt: new Date().toISOString(),
    error: undefined,
  });
  await enqueueWork({ kind: "convert", itemId: id });
  return queued;
}

/** Worker job: script the article with Claude and kick off Polly synthesis. */
export async function runConvert(id: string): Promise<void> {
  const item = await getItem(id);
  if (!item) return;
  if (item.queueStatus !== "extracted" || !item.articleText) return;

  const config = await ensureConfig();
  try {
    // Both Claude and Polly are network calls that can blip transiently; retry
    // each so a single hiccup doesn't strand the item in a failed state.
    const script = await withRetry(
      () =>
        makeScript(
          {
            title: item.title,
            text: item.articleText,
            excerpt: item.excerpt,
            byline: item.byline,
            siteName: item.siteName,
          },
          config.mode,
        ),
      { label: `script ${item.id}` },
    );

    const episodeId = newId();
    const episode: Episode = {
      id: episodeId,
      itemId: item.id,
      title: script.title,
      showNotes: script.showNotes,
      sourceUrl: item.sourceUrl,
      audioKey: audioKeyFor(episodeId), // provisional; finalize sets the real key
      pubDate: new Date().toISOString(),
    };
    await putEpisode(episode);
    await putItem({ ...item, convertState: "scripted", episodeId });

    await withRetry(() => startSynthesis(episodeId, script.script, config.voiceId), {
      label: `synthesize ${episodeId}`,
    });
    await putItem({ ...item, convertState: "synthesizing", episodeId });
  } catch (err: any) {
    await putItem({
      ...item,
      convertState: "failed",
      convertStartedAt: undefined,
      error: String(err?.message ?? err),
    });
  }
}

// --- Finalize (S3 event when Polly finishes writing the MP3) ------------------

/** Given the key Polly wrote, record audio size, mark ready, and rebuild the feed. */
export async function finalizeAudio(episodeId: string, actualKey: string): Promise<void> {
  const episodes = await listEpisodes();
  const episode = episodes.find((e) => e.id === episodeId);
  if (!episode) return;

  const head = await headAudio(actualKey);
  const updated: Episode = { ...episode, audioKey: actualKey, bytes: head?.bytes ?? 0 };
  await putEpisode(updated);

  // Flip the owning item to ready (and clear the in-flight timestamp).
  const item = await getItem(episode.itemId);
  if (item) await putItem({ ...item, convertState: "ready", convertStartedAt: undefined });

  await regenerateFeed();
}

/** Rebuild feed.xml from all ready episodes and write it to the token path. */
export async function regenerateFeed(): Promise<void> {
  const config = await ensureConfig();
  const episodes = await listEpisodes();
  const mediaBaseUrl = MEDIA_BASE_URL();
  const feedUrl = `${mediaBaseUrl}/${feedKeyFor(config.feedToken)}`;
  const xml = buildFeedXml(episodes, { config, mediaBaseUrl, feedUrl });
  await putFeedXml(config.feedToken, xml);
}

export { getFeed };
