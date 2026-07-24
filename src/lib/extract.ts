// Fetch a web page and pull out the main article content with Mozilla Readability.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { assertSafeUrl } from "./urlGuard.js";
import { FETCH_TIMEOUT_MS, MAX_HTML_BYTES, MAX_REDIRECTS } from "./limits.js";

export interface Extracted {
  title: string;
  text: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
}

const UA =
  "Mozilla/5.0 (compatible; text-to-podcast/0.1; +https://github.com/cocymsc1986/text-to-podcast)";

/**
 * Fetch a page's HTML with abuse guards: the URL (and every redirect hop) is
 * validated against the SSRF guard, the request times out, non-HTML responses
 * are refused, and the body is capped so a giant page can't exhaust memory.
 */
export async function fetchHtml(url: string): Promise<string> {
  let current = (await assertSafeUrl(url)).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects manually so each hop is re-validated — otherwise a public
    // URL could 302 to an internal address and defeat the SSRF guard.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current).toString();
        current = (await assertSafeUrl(next)).toString();
        continue;
      }
      if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
      assertHtmlResponse(res, current);
      return await readCapped(res, MAX_HTML_BYTES, current);
    }
    throw new Error(`Too many redirects fetching ${url}`);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Timed out fetching ${url} after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Refuse responses that aren't HTML (PDFs, images, binaries, downloads). */
function assertHtmlResponse(res: Response, url: string): void {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type && !/(text\/html|application\/xhtml\+xml|text\/plain)/.test(type)) {
    throw new Error(`Refusing to read non-HTML content (${type}) from ${url}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    throw new Error(`Page declares ${declared} bytes, over the ${MAX_HTML_BYTES}-byte limit`);
  }
}

/** Read a response body, aborting if it grows past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Page exceeds the ${maxBytes}-byte limit while reading ${url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
