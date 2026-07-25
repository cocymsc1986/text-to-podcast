// Read a source RSS/Atom feed and surface its items for the reading queue.
import Parser from "rss-parser";
import { assertSafeUrl } from "./urlGuard.js";

const parser = new Parser({
  headers: {
    "user-agent": "text-to-podcast/0.1 (+https://github.com/cocymsc1986/text-to-podcast)",
  },
  timeout: 15_000,
});

export interface SourceItem {
  /** Stable per-item id for dedupe: prefer guid, else link. */
  guid: string;
  title: string;
  link: string;
  isoDate?: string;
}

export interface SourceFeed {
  title: string;
  items: SourceItem[];
}

export async function fetchSourceFeed(url: string): Promise<SourceFeed> {
  // Validate before handing the URL to rss-parser, which fetches it directly and
  // would otherwise be an SSRF path into internal/metadata addresses.
  await assertSafeUrl(url);
  const feed = await parser.parseURL(url);
  return normalize(feed, url);
}

/** Pure normalizer over a parsed feed object, for easy unit testing. */
export function normalize(
  feed: { title?: string; items?: any[] },
  fallbackTitle: string,
): SourceFeed {
  const items: SourceItem[] = (feed.items ?? [])
    .map((it): SourceItem | null => {
      const link = (it.link || it.guid || "").toString().trim();
      const guid = (it.guid || it.link || "").toString().trim();
      if (!guid || !link) return null;
      return {
        guid,
        title: (it.title || link).toString().trim(),
        link,
        isoDate: it.isoDate || it.pubDate || undefined,
      };
    })
    .filter((x): x is SourceItem => x !== null);
  return { title: (feed.title || fallbackTitle).toString().trim(), items };
}

/**
 * Newest-first, capped to `limit`. Bounds how many entries a single poll
 * ingests so subscribing to a busy feed can't dump its whole backlog into the
 * queue at once. Undated items sort last (treated as oldest).
 */
export function selectNewest(items: SourceItem[], limit: number): SourceItem[] {
  return [...items]
    .sort((a, b) => (b.isoDate ?? "").localeCompare(a.isoDate ?? ""))
    .slice(0, Math.max(0, limit));
}
