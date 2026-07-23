import { describe, it, expect } from "vitest";
import { extractFromHtml } from "../src/lib/extract.js";

const html = `<!doctype html>
<html><head><title>Test Article</title>
<meta name="author" content="Jane Doe"/></head>
<body>
  <nav>Home About <a href="/x">Click here</a></nav>
  <article>
    <h1>The Big Story</h1>
    <p>First paragraph with real content that is reasonably long so Readability keeps it.</p>
    <p>Second paragraph, also with a good amount of meaningful text to survive parsing.</p>
  </article>
  <footer>Share on X</footer>
</body></html>`;

describe("extractFromHtml", () => {
  it("pulls the main article text and drops chrome", () => {
    const out = extractFromHtml(html, "https://example.com/story");
    expect(out.title).toContain("Test Article");
    expect(out.text).toContain("First paragraph");
    expect(out.text).toContain("Second paragraph");
    expect(out.text).not.toContain("Share on X");
  });

  it("throws on unreadable content", () => {
    expect(() => extractFromHtml("<html><body></body></html>", "https://e.com")).toThrow();
  });
});
