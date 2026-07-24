import { describe, it, expect } from "vitest";
import { normalize } from "../src/lib/rssIn.js";

describe("rssIn.normalize", () => {
  it("maps items and prefers guid for dedupe", () => {
    const feed = {
      title: "Source Blog",
      items: [
        { title: "A", link: "https://ex.com/a", guid: "guid-a", isoDate: "2026-01-01" },
        { title: "B", link: "https://ex.com/b" }, // no guid -> falls back to link
      ],
    };
    const out = normalize(feed, "fallback");
    expect(out.title).toBe("Source Blog");
    expect(out.items).toHaveLength(2);
    expect(out.items[0].guid).toBe("guid-a");
    expect(out.items[1].guid).toBe("https://ex.com/b");
  });

  it("drops items without a usable link/guid", () => {
    const out = normalize({ items: [{ title: "no link" }] }, "fb");
    expect(out.items).toHaveLength(0);
  });
});
