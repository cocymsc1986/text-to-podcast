// Central abuse-prevention limits for the pipeline. These are sized around
// "standard developer articles": a long technical post runs maybe 2,000-4,000
// words (~15,000-25,000 characters). We allow roughly 3-4x that headroom before
// refusing, which keeps every normal article working while blocking book-length
// dumps and pathological/hostile pages from burning Claude + Polly budget.

/** Hard cap on the raw HTML we will download for a single page. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Max characters of extracted article text we will send to the LLM or convert
 * to audio. ~80k chars is roughly 13,000 words — well beyond any normal article,
 * but a firm ceiling on cost per item. (Polly itself caps a task at 100k chars.)
 */
export const MAX_ARTICLE_CHARS = 80_000;

/** Below this an "article" is almost certainly an error page or nav shell. */
export const MIN_ARTICLE_CHARS = 200;

/** Network timeout for fetching a page's HTML. */
export const FETCH_TIMEOUT_MS = 20_000;

/** Max redirect hops we will follow (each re-validated for SSRF). */
export const MAX_REDIRECTS = 5;

/** Reject absurdly long input URLs before we even try to fetch them. */
export const MAX_URL_LENGTH = 2_048;
