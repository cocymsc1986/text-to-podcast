// Read a source RSS/Atom feed and surface its items for the reading queue.
import Parser from "rss-parser";

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
