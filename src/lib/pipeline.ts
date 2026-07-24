// Orchestration shared by the API, poller, and finalize handlers. Two phases:
// (A) ingest -> reading queue (always, no audio), (B) convert -> audio (on demand).
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

// --- Phase A: ingest ----------------------------------------------------------

/** Add a one-off URL to the reading queue (extracted, not converted). */
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
  return extractItem(item);
}

/** Poll one source feed, queue any new items, and (optionally) auto-convert. */
export async function ingestFeed(feed: Feed): Promise<Item[]> {
  const source = await fetchSourceFeed(feed.sourceUrl);
  // Only ingest the newest MAX_ITEMS_PER_POLL entries so a subscribe never
  // floods the queue with a busy feed's whole backlog.
  const newest = selectNewest(source.items, MAX_ITEMS_PER_POLL);
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
    const extracted = await extractItem(item);
    results.push(extracted);
    if (feed.autoConvert && extracted.queueStatus === "extracted") {
      await startConvert(extracted.id);
    }
  }
  await updateFeedPolled(feed.id, new Date().toISOString());
  return results;
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
  return extractItem({ ...item, queueStatus: "new", error: undefined });
}

// --- Phase B: convert (spends Claude + Polly budget) --------------------------

/** Kick off conversion of a queued item: script with Claude, synthesize with Polly. */
export async function startConvert(id: string): Promise<Item> {
  const item = await getItem(id);
  if (!item) throw new Error(`Item ${id} not found`);
  if (item.queueStatus !== "extracted" || !item.articleText) {
    throw new Error(`Item ${id} is not extracted yet`);
  }
  if (item.convertState === "queued" || item.convertState === "synthesizing") return item;

  // Abuse guard: keep oversized articles out of the LLM prompt and Polly
  // entirely. Flag the item so the UI shows why instead of silently spending
  // budget on a book-length or hostile page.
  if (item.articleText.length > MAX_ARTICLE_CHARS) {
    return putItem({
      ...item,
      convertState: "failed",
      error:
        `Article is ${item.articleText.length.toLocaleString()} characters, over the ` +
        `${MAX_ARTICLE_CHARS.toLocaleString()}-character limit for conversion.`,
    });
  }

  const config = await ensureConfig();
  await putItem({ ...item, convertState: "queued", error: undefined });

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
    return putItem({ ...item, convertState: "synthesizing", episodeId });
  } catch (err: any) {
    return putItem({ ...item, convertState: "failed", error: String(err?.message ?? err) });
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

  // Flip the owning item to ready.
  const item = await getItem(episode.itemId);
  if (item) await putItem({ ...item, convertState: "ready" });

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
