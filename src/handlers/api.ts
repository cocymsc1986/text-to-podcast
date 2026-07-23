// HTTP API for the web UI: manage the reading queue, subscriptions, conversion,
// and podcast config. Deployed as a single Lambda behind API Gateway (HTTP API).
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Feed } from "../lib/types.js";
import {
  ensureConfig,
  feedKeyFor,
  getConfig,
  getFeed,
  getItem,
  listEpisodes,
  listFeeds,
  listItems,
  newId,
  putConfig,
  putFeed,
  putItem,
} from "../lib/store.js";
import { ingestFeed, ingestUrl, regenerateFeed, startConvert } from "../lib/pipeline.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-api-key",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS };

  // Simple shared-secret auth so only the owner can spend Claude/Polly budget.
  const secret = process.env.APP_SECRET;
  if (secret && event.headers?.["x-api-key"] !== secret) {
    return json(401, { error: "unauthorized" });
  }

  const path = event.rawPath.replace(/\/$/, "") || "/";
  const parts = path.split("/").filter(Boolean); // e.g. ["items", "<id>", "convert"]
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // --- Reading queue ---
    if (parts[0] === "items") {
      if (parts.length === 1 && method === "GET") return json(200, { items: await listItems() });
      if (parts.length === 1 && method === "POST") {
        if (!body.url) return json(400, { error: "url required" });
        return json(201, { item: await ingestUrl(String(body.url)) });
      }
      if (parts.length === 3 && method === "POST" && parts[2] === "convert") {
        return json(202, { item: await startConvert(parts[1]) });
      }
      if (parts.length === 2 && method === "PATCH") {
        const item = await getItem(parts[1]);
        if (!item) return json(404, { error: "not found" });
        if (body.readState) item.readState = body.readState;
        return json(200, { item: await putItem(item) });
      }
    }

    // --- Subscriptions ---
    if (parts[0] === "feeds") {
      if (parts.length === 1 && method === "GET") return json(200, { feeds: await listFeeds() });
      if (parts.length === 1 && method === "POST") {
        if (!body.sourceUrl) return json(400, { error: "sourceUrl required" });
        const feed: Feed = {
          id: newId(),
          type: "rss",
          sourceUrl: String(body.sourceUrl),
          title: String(body.title ?? body.sourceUrl),
          active: true,
          autoConvert: Boolean(body.autoConvert),
          createdAt: new Date().toISOString(),
        };
        return json(201, { feed: await putFeed(feed) });
      }
      if (parts.length === 2 && method === "PATCH") {
        const feed = await getFeed(parts[1]);
        if (!feed) return json(404, { error: "not found" });
        if (typeof body.autoConvert === "boolean") feed.autoConvert = body.autoConvert;
        if (typeof body.active === "boolean") feed.active = body.active;
        return json(200, { feed: await putFeed(feed) });
      }
      if (parts.length === 3 && method === "POST" && parts[2] === "poll") {
        const feed = await getFeed(parts[1]);
        if (!feed) return json(404, { error: "not found" });
        return json(200, { added: await ingestFeed(feed) });
      }
    }

    // --- Episodes ---
    if (parts[0] === "episodes" && method === "GET") {
      return json(200, { episodes: await listEpisodes() });
    }

    // --- Config (includes the private feed URL) ---
    if (parts[0] === "config") {
      const config = await ensureConfig();
      if (method === "GET") {
        return json(200, { config, feedUrl: feedUrlFor(config.feedToken) });
      }
      if (method === "POST") {
        const current = (await getConfig())!;
        const next = {
          ...current,
          voiceId: body.voiceId ?? current.voiceId,
          mode: body.mode ?? current.mode,
          podcastTitle: body.podcastTitle ?? current.podcastTitle,
          podcastDescription: body.podcastDescription ?? current.podcastDescription,
          podcastAuthor: body.podcastAuthor ?? current.podcastAuthor,
        };
        await putConfig(next);
        await regenerateFeed(); // metadata changes should show in the feed
        return json(200, { config: next, feedUrl: feedUrlFor(next.feedToken) });
      }
    }

    return json(404, { error: "no such route", path, method });
  } catch (err: any) {
    console.error("api error", err);
    return json(500, { error: String(err?.message ?? err) });
  }
}

const feedUrlFor = (token: string) =>
  `${(process.env.MEDIA_BASE_URL ?? "").replace(/\/$/, "")}/${feedKeyFor(token)}`;
