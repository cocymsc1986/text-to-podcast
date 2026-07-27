# text-to-podcast

Turn web articles and RSS feeds into a **private podcast feed** you listen to in a
normal podcast app — on demand. Paste a URL (or subscribe to a source feed), the
article lands in a **reading queue**, and when *you* choose, it's rewritten by Claude
into a natural spoken script, synthesized by Amazon Polly, and added to your feed.

Built entirely on **AWS + the Claude API** — no third-party podcast host, no new
signups. Runs for roughly **$0.10–0.15 per converted article** with near-zero fixed cost.

## Why a private feed (and not "publish to Spotify")

Converting articles you don't own and publishing them **publicly** (e.g. a public
Spotify show) is a real copyright problem — it's reproduction + a derivative work +
public distribution. This project instead builds a **private, unguessable feed** for
your own listening (personal format-shifting of content you already have access to),
which is a far lower-risk model. *Not legal advice.*

Spotify does **not** let listeners add arbitrary private RSS feeds. Add your feed URL
in **Apple Podcasts, Pocket Casts, Overcast, or AntennaPod** instead.

## How it works

```
        ┌─────────────── Phase A: ingest (always, no audio) ───────────────┐
URL  ───▶│ create Item ▶ fetch page ▶ Readability extract ▶ "ready to read" │
RSS feed─▶│ poll (EventBridge cron) ▶ new items ▶ extract ─────────────────┘
        └──────────────────────────────────────────────────────────────────┘
                                     │  (you press "Convert", or feed.autoConvert)
        ┌─────────────── Phase B: convert (on demand) ────────────────────┐
        │ Claude → spoken script + title + notes ▶ Polly async → MP3 in S3 │
        │ ▶ S3 event ▶ finalize ▶ rebuild feed.xml ▶ your podcast app pulls │
        └──────────────────────────────────────────────────────────────────┘
```

**Conversion is opt-in.** Items sit in the queue until you convert them, so you only
spend Claude/Polly budget on things you actually want as audio. Any feed can be flagged
`auto-convert` to skip the manual step.

## Architecture

| Concern | Service |
|---|---|
| API + web UI backend | AWS Lambda + API Gateway (HTTP API) |
| Background extract/convert | worker Lambda (async invoke) — keeps the slow page-fetch, Claude, and Polly steps off the request path |
| Scheduled feed polling | EventBridge rule → poller Lambda |
| Audio, feed XML, web UI | Amazon S3 (public-read; content lives under unguessable paths) |
| Metadata | DynamoDB (single table + `byType` GSI) |
| Text-to-speech | Amazon Polly (`generative` engine by default), async `StartSpeechSynthesisTask` (MP3 straight to S3) |
| Article → spoken script | Claude API (`claude-sonnet-5` by default) |
| Article extraction | `@mozilla/readability` + `jsdom` |
| Infra as code | AWS CDK (TypeScript) |

### Code layout

```
src/handlers/   api.ts · poller.ts · worker.ts · synthCallback.ts   (Lambda entrypoints)
src/lib/        extract · script · tts · rssIn · rssOut · store · pipeline · types
infra/          CDK app + stack
web/            static single-page UI (index.html + app.js)
test/           vitest unit tests
scripts/        esbuild bundler for the Lambdas
```

## Deploy

Prereqs: an AWS account with credentials configured, Node 20+, and a Claude API key.

```bash
npm install

# One-time per account/region:
npx cdk bootstrap

# Configuration is read from the environment at deploy time:
export ANTHROPIC_API_KEY=sk-ant-...        # required
export APP_SECRET=$(openssl rand -hex 16)  # protects the API/UI (recommended)
export CLAUDE_MODEL=claude-sonnet-5        # or claude-haiku-4-5-20251001 (cheaper)
export DEFAULT_VOICE=Matthew               # any Polly voice for the chosen engine
export POLLY_ENGINE=generative             # generative | long-form | neural (see below)
export POLL_RATE_MINUTES=15
export MAX_ITEMS_PER_POLL=10                # newest items ingested per feed, per poll
export API_BASE_URL=                        # optional; blank = this stack's own API endpoint

npm run deploy   # bundles the Lambdas, then cdk deploy
```

The stack outputs:

- **ApiUrl** — the HTTP API base URL.
- **WebAppUrl** — the hosted UI (`…/app/index.html`).
- **MediaBaseUrl** — base URL for audio + the feed.

The deploy bakes the API base URL into the UI (a generated `config.js`), so the
hosted app is preconfigured — there's nothing to paste into **Settings**. By
default it uses this stack's own **ApiUrl**; set `API_BASE_URL` only to point the
UI at a custom domain.

## Deploy via GitHub Actions (CI + auto-deploy on `main`)

Two workflows are included:

- **`.github/workflows/ci.yml`** — runs `typecheck` + `test` on every push/PR. No AWS access.
- **`.github/workflows/deploy.yml`** — on push to `main`, runs the checks then `cdk deploy`,
  authenticating to AWS with **GitHub OIDC** (assuming an IAM role — no long-lived keys stored).

### One-time AWS setup (the workflow can't do these for you)

1. **Create a GitHub OIDC provider** in IAM for `token.actions.githubusercontent.com`
   (audience `sts.amazonaws.com`).
2. **Create an IAM role** the workflow assumes, whose trust policy allows this repo's
   `main` branch, e.g. condition
   `token.actions.githubusercontent.com:sub = repo:cocymsc1986/text-to-podcast:ref:refs/heads/main`.
   Give it permissions to deploy the stack (CloudFormation + Lambda, S3, DynamoDB, API
   Gateway, EventBridge, IAM, and the CDK bootstrap resources).
3. **Bootstrap once:** run `npx cdk bootstrap` locally for the target account+region. This
   is a one-time, elevated-permission step and is intentionally **not** done by the workflow.

### GitHub configuration

- **Secrets:** `AWS_DEPLOY_ROLE_ARN`, `ANTHROPIC_API_KEY`, `APP_SECRET`.
- **Variables:** `AWS_REGION` (required), plus optional `CLAUDE_MODEL`, `DEFAULT_VOICE`,
  `POLLY_ENGINE`, `POLL_RATE_MINUTES`, `MAX_ITEMS_PER_POLL`, `API_BASE_URL`.

The deploy job runs in a `production` GitHub Environment, so you can add a required-reviewer
protection rule there if you want a manual approval before each deploy.

## Use it

1. Open **WebAppUrl**. The **ApiUrl** is already configured; if you set an
   **APP_SECRET**, go to **Settings**, enter it as the API key, and Save.
2. **Queue** tab: paste an article URL → it's fetched and shows as *ready to read*.
   Press **Convert to audio** when you want an episode.
3. **Subscriptions** tab: add an RSS feed. New items flow into the queue automatically
   (every `POLL_RATE_MINUTES`); tick **auto-convert** to also make episodes automatically.
   Each poll ingests only the **newest `MAX_ITEMS_PER_POLL` items** per feed (default 10),
   so subscribing to a busy feed doesn't flood the queue with its whole backlog. Override
   this per feed with the **Limit** field (a number, or `all` to backfill everything; blank
   uses the default) — settable when subscribing and editable later in the list. Back in
   the **Queue** tab, each article is tagged with the source it came from — use the
   **Source** dropdown to filter to one feed, and **Archive** to prune ones you don't want.
4. **Episodes** tab: copy your **private feed URL** and add it to Apple Podcasts /
   Pocket Casts / Overcast / AntennaPod.

## Develop / test

```bash
npm run typecheck
npm test          # vitest unit tests (extract, rssIn, rssOut)
npm run bundle    # build the Lambda artifacts into dist/
npm run synth     # cdk synth (needs ANTHROPIC_API_KEY set)
```

## API (all JSON; send `x-api-key: <APP_SECRET>` if set)

| Method & path | Purpose |
|---|---|
| `GET /items` | List the reading queue |
| `POST /items` `{ url }` | Add a URL to the queue (extract only) |
| `POST /items/{id}/convert` | Convert a queued item to audio (also retries a failed conversion) |
| `POST /items/{id}/reextract` | Re-run article extraction for a failed item |
| `PATCH /items/{id}` `{ readState }` | Mark read / archived |
| `GET /feeds` · `POST /feeds` `{ sourceUrl, autoConvert }` | List / add subscriptions |
| `PATCH /feeds/{id}` `{ autoConvert, active }` | Update a subscription |
| `POST /feeds/{id}/poll` | Poll a feed immediately |
| `GET /episodes` | List produced episodes |
| `GET /config` · `POST /config` | Read / update voice, mode, podcast metadata; returns the feed URL |

## Cost

- Lambda / API Gateway / DynamoDB / EventBridge: effectively AWS free tier for personal use.
- S3: cents/month (only you download the audio).
- Polly neural: ~$0.08 per ~5k-char article. Claude (Sonnet): a few cents per article.

## Making the audio sound more human

Two levers, both on by default:

- **Voice engine.** `POLLY_ENGINE=generative` (the default) uses Polly's most
  lifelike engine — noticeably warmer and less robotic than the older `neural`
  engine. `long-form` is another natural option tuned for longer content. Not
  every voice supports every engine, so synthesis **falls back automatically**:
  it tries your configured engine first, then steps down (generative →
  long-form → neural → standard) to the best one the chosen voice supports — no
  error, no manual matching. See the
  [Polly voice list](https://docs.aws.amazon.com/polly/latest/dg/voicelist.html).
  Generative/long-form cost a bit more per character than neural.
- **Script style.** Claude is prompted to write a conversational, contraction-heavy
  narration with varied sentence length and natural pacing, so the text itself
  reads like a person talking rather than a document being recited.

## Reliability

- **Async pipeline.** Extraction and conversion run on a background **worker
  Lambda**, not inside the API request. The API just enqueues the job and returns
  immediately, so a slow page or a slow Claude call can't time the request out
  (the sporadic **503s** that used to appear), and queuing several conversions
  starts them all in parallel instead of the first one blocking the rest.
- **Auto-refresh.** The queue and episodes tabs poll *only while* something is
  fetching, converting, or synthesizing **and** the tab is visible, so an idle or
  backgrounded tab doesn't keep hitting the API. The list payload omits article
  bodies, so each poll is small. Items flip to *ready* / *failed* on their own.
- **Retries.** The network-bound steps (page fetch, Claude, Polly) retry transient
  failures with exponential backoff, and the web UI itself retries transient API
  errors before surfacing anything — you only see an error *after* retries are
  exhausted. If a step still fails, the queue shows a **Retry** button
  (re-extract) or **Retry conversion**. A conversion that gets stranded (a worker
  that died, or a lost finalize event) is detected as stalled and becomes
  retryable rather than showing *converting…* forever.

## Abuse guards

Because the API reads arbitrary, caller-supplied URLs (and anyone with the URL could
point it at a hostile page), the pipeline is hardened:

- **SSRF protection.** Every fetched URL — and every redirect hop, plus RSS source
  feeds — is validated (`src/lib/urlGuard.ts`): only `http`/`https`, no embedded
  credentials, and never a private, loopback, link-local, or cloud-metadata address
  (`169.254.169.254`). This stops the Lambda being tricked into fetching internal
  services on a caller's behalf.
- **Fetch limits.** Page downloads time out, must be HTML, and are capped at 5 MB, so a
  giant or streaming response can't exhaust memory (`src/lib/limits.ts`).
- **Size cap on conversion.** Articles over ~80k characters (roughly 13k words, several
  times a normal dev article) are refused *before* they reach the Claude prompt or Polly,
  so a book-length or padded page can't run up cost. Oversized items surface as *failed*
  with the reason.
- **Prompt-injection hardening.** Extracted article text is untrusted. It's wrapped in a
  marked block, breakout attempts are defanged, and the system prompt instructs the model
  to narrate the content and never obey instructions embedded in it (`src/lib/script.ts`).

## Notes / limits

- Polly async caps a single task at 100k billed characters — comfortably more than a
  typical article; longer pieces would need splitting.
- The media bucket is public-read; privacy comes from unguessable object paths (the feed
  lives at `feeds/<token>/feed.xml`). For stronger isolation, front it with CloudFront +
  signed URLs.
- Paywalled or JS-rendered pages may not extract cleanly (Readability works on static HTML).
