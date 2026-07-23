// EventBridge-scheduled poller: walk every active RSS subscription and ingest
// new items into the reading queue (auto-converting only feeds opted in).
import { listFeeds } from "../lib/store.js";
import { ingestFeed } from "../lib/pipeline.js";

export async function handler(): Promise<{ polled: number; added: number }> {
  const feeds = (await listFeeds()).filter((f) => f.active && f.type === "rss");
  let added = 0;
  for (const feed of feeds) {
    try {
      const items = await ingestFeed(feed);
      added += items.length;
      console.log(`polled ${feed.sourceUrl}: ${items.length} new`);
    } catch (err) {
      console.error(`poll failed for ${feed.sourceUrl}`, err);
    }
  }
  return { polled: feeds.length, added };
}
