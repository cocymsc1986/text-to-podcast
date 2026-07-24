import { describe, it, expect } from "vitest";
import { buildFeedXml } from "../src/lib/rssOut.js";
import type { Config, Episode } from "../src/lib/types.js";

const config: Config = {
  feedToken: "tok",
  voiceId: "Matthew",
  mode: "full-read",
  podcastTitle: "My Queue",
  podcastDescription: "Private feed",
  podcastAuthor: "me",
};

const ctx = {
  config,
  mediaBaseUrl: "https://media.example.com",
  feedUrl: "https://media.example.com/feeds/tok/feed.xml",
};

const ready: Episode = {
  id: "ep1",
  itemId: "it1",
  title: "Episode One",
  showNotes: "Notes. Source: Blog.",
  sourceUrl: "https://ex.com/a",
  audioKey: "audio/ep1.task.mp3",
  bytes: 12345,
  durationSec: 300,
  pubDate: "2026-02-01T00:00:00.000Z",
};

describe("buildFeedXml", () => {
  it("emits an itunes podcast feed with an enclosure for ready episodes", () => {
    const xml = buildFeedXml([ready], ctx);
    expect(xml).toContain("My Queue");
    expect(xml).toContain("itunes");
    expect(xml).toContain("Episode One");
    expect(xml).toContain("https://media.example.com/audio/ep1.task.mp3");
    expect(xml).toContain('length="12345"');
    expect(xml).toContain('type="audio/mpeg"');
  });

  it("omits episodes that have no audio yet", () => {
    const pending: Episode = { ...ready, id: "ep2", title: "Pending", bytes: undefined };
    const xml = buildFeedXml([pending], ctx);
    expect(xml).not.toContain("Pending");
  });
});
