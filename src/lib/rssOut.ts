// Build the iTunes-namespaced podcast RSS feed served to the user's podcast app.
import { Podcast } from "podcast";
import type { Config, Episode } from "./types.js";

export interface FeedContext {
  config: Config;
  /** Public base URL where audio + feed are served, no trailing slash. */
  mediaBaseUrl: string;
  /** Full URL of the feed itself (token embedded). */
  feedUrl: string;
}

/** Only fully synthesized episodes (audio present) belong in the feed. */
export function buildFeedXml(episodes: Episode[], ctx: FeedContext): string {
  const { config, mediaBaseUrl, feedUrl } = ctx;
  const feed = new Podcast({
    title: config.podcastTitle,
    description: config.podcastDescription,
    feedUrl,
    siteUrl: mediaBaseUrl,
    author: config.podcastAuthor,
    language: "en",
    itunesAuthor: config.podcastAuthor,
    itunesExplicit: false,
    itunesOwner: { name: config.podcastAuthor, email: "" },
    itunesCategory: [{ text: "News" }],
  });

  const ready = episodes
    .filter((e) => e.audioKey && e.bytes)
    .sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate));

  for (const ep of ready) {
    feed.addItem({
      title: ep.title,
      description: ep.showNotes,
      guid: ep.id,
      date: new Date(ep.pubDate),
      url: ep.sourceUrl,
      enclosure: {
        url: `${mediaBaseUrl}/${ep.audioKey}`,
        size: ep.bytes ?? 0,
        type: "audio/mpeg",
      },
      itunesDuration: ep.durationSec ?? undefined,
    });
  }

  return feed.buildXml({ indent: "  " });
}
