// Turn a raw extracted article into a natural, listenable spoken script plus
// episode metadata, using the Claude API.
import Anthropic from "@anthropic-ai/sdk";
import type { ConvertMode } from "./types.js";
import type { Extracted } from "./extract.js";

// Sonnet 5 is a good quality/cost balance for this rewrite; override with
// CLAUDE_MODEL (e.g. claude-haiku-4-5-20251001) to trade quality for cost.
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";

export interface Script {
  title: string;
  showNotes: string;
  /** Plain spoken text ready to hand to a TTS engine. */
  script: string;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = `You are an audio producer who adapts written web articles into a
script for a single narrator to read aloud on a personal podcast. You make the
text sound natural when spoken: expand abbreviations and symbols into words,
convert URLs/figures/tables into spoken descriptions, drop navigational cruft
("click here", "share on X", cookie notices), and add light connective phrasing
so it flows. You never invent facts that are not in the source article.

Respond with ONLY a JSON object (no markdown fences) of the shape:
{"title": string, "showNotes": string, "script": string}
- title: a concise episode title (<= 80 chars).
- showNotes: 1-3 sentence summary plus a source attribution line.
- script: the full spoken narration as plain text (no SSML, no markdown).`;

function instruction(mode: ConvertMode, a: Extracted): string {
  const goal =
    mode === "summary"
      ? "Produce a faithful spoken SUMMARY (~30% length) capturing the key points."
      : "Produce a faithful spoken FULL reading that preserves all the article's content.";
  const attribution = [
    a.siteName ? `Source: ${a.siteName}` : null,
    a.byline ? `By ${a.byline}` : null,
  ]
    .filter(Boolean)
    .join(". ");
  return [
    goal,
    "Open with a brief spoken intro naming the source, then the narration.",
    attribution ? `Attribution to weave in: ${attribution}.` : "",
    "",
    `ARTICLE TITLE: ${a.title}`,
    "ARTICLE TEXT:",
    a.text,
  ].join("\n");
}

export async function makeScript(article: Extracted, mode: ConvertMode): Promise<Script> {
  const msg = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: "user", content: instruction(mode, article) }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseScript(text, article);
}

/** Parse Claude's JSON reply, tolerating stray code fences, with sane fallbacks. */
export function parseScript(text: string, article: Extracted): Script {
  const json = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    try {
      const obj = JSON.parse(json.slice(start, end + 1));
      if (obj && typeof obj.script === "string" && obj.script.trim()) {
        return {
          title: (obj.title || article.title).toString().slice(0, 120),
          showNotes: (obj.showNotes || article.excerpt || "").toString(),
          script: obj.script.toString(),
        };
      }
    } catch {
      // fall through to raw fallback
    }
  }
  // Fallback: if the model returned prose, read the article text verbatim.
  return {
    title: article.title,
    showNotes: article.excerpt ?? "",
    script: text.trim() || article.text,
  };
}
