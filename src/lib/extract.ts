// Fetch a web page and pull out the main article content with Mozilla Readability.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export interface Extracted {
  title: string;
  text: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
}

const UA =
  "Mozilla/5.0 (compatible; text-to-podcast/0.1; +https://github.com/cocymsc1986/text-to-podcast)";

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Parse HTML and return the readable article. Pure (no network) so it is easy to
 * unit-test against fixture HTML. `url` is used only to resolve relative links.
 */
export function extractFromHtml(html: string, url: string): Extracted {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article || !article.textContent?.trim()) {
    throw new Error("Could not extract readable content from page");
  }
  return {
    title: article.title?.trim() || url,
    text: normalizeText(article.textContent),
    excerpt: article.excerpt?.trim() || undefined,
    byline: article.byline?.trim() || undefined,
    siteName: article.siteName?.trim() || undefined,
  };
}

export async function extractFromUrl(url: string): Promise<Extracted> {
  return extractFromHtml(await fetchHtml(url), url);
}

/** Collapse the runs of whitespace Readability leaves behind into clean paragraphs. */
function normalizeText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}
