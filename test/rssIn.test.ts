import { describe, it, expect } from "vitest";
import { normalize, selectNewest } from "../src/lib/rssIn.js";

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

describe("rssIn.selectNewest", () => {
  const mk = (guid: string, isoDate?: string) => ({ guid, title: guid, link: `https://ex.com/${guid}`, isoDate });

  it("caps to the newest N and drops the older backlog", () => {
    const items = [
      mk("old", "2026-01-01"),
      mk("mid", "2026-02-01"),
      mk("new", "2026-03-01"),
    ];
    const out = selectNewest(items, 2);
    expect(out.map((i) => i.guid)).toEqual(["new", "mid"]);
  });

  it("returns everything when under the limit", () => {
    const items = [mk("a", "2026-01-01"), mk("b", "2026-02-01")];
    expect(selectNewest(items, 10)).toHaveLength(2);
  });

  it("sinks undated items below dated ones", () => {
    const items = [mk("undated"), mk("dated", "2026-01-01")];
    expect(selectNewest(items, 1).map((i) => i.guid)).toEqual(["dated"]);
  });
});
