// Tiny vanilla SPA for the reading queue -> podcast platform.

// The API base URL is injected at deploy time via config.js (from the
// API_BASE_URL env var, or the stack's own endpoint). When present it's the
// source of truth, so the URL never has to be entered by hand. A saved value
// in Settings is only a fallback for local development where config.js is empty.
const injectedBase = ((window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl) || "").trim();

const store = {
  get base() { return injectedBase || localStorage.getItem("apiBase") || ""; },
  set base(v) { localStorage.setItem("apiBase", v); },
  get baseFromConfig() { return injectedBase !== ""; },
  get key() { return localStorage.getItem("apiKey") || ""; },
  set key(v) { localStorage.setItem("apiKey", v); },
};

// Transient failures worth retrying transparently before bothering the user:
// gateway/throttle statuses plus any network-level fetch rejection. A cold Lambda
// or a brief upstream blip often surfaces as a 503 that a retry clears — so we
// retry with backoff and only surface an error AFTER exhausting the attempts,
// instead of throwing an obtrusive alert on the first blip.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const API_ATTEMPTS = 4;
const API_RETRY_BASE_MS = 600;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = "GET", body) {
  if (!store.base) throw new Error("Set the API base URL in Settings first.");
  const url = store.base.replace(/\/$/, "") + path;
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      ...(store.key ? { "x-api-key": store.key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  let lastErr;
  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    let transient = false;
    try {
      const res = await fetch(url, init);
      if (res.ok) return res.status === 204 ? null : res.json();
      lastErr = new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      lastErr.status = res.status;
      transient = RETRY_STATUS.has(res.status);
    } catch (e) {
      // fetch() rejects on network/DNS/CORS failure — treat as transient.
      lastErr = e instanceof Error ? e : new Error(String(e));
      transient = true;
    }
    if (!transient || attempt === API_ATTEMPTS) throw lastErr;
    await wait(API_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  throw lastErr;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => (s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- Auto-refresh polling ---
// While anything is still fetching/converting/synthesizing, re-load the active
// tab every few seconds so it reports "ready"/"failed" on its own — no manual
// refresh needed. Only one timer runs at a time; switching tabs cancels it.
//
// Polling only runs when there is active work AND the tab is visible: an idle
// queue never polls, and a backgrounded tab left open all day stops hitting the
// API (it resumes the moment you look at it) so it can't quietly run up cost.
const POLL_MS = 4000;
let pollTimer = null;
let activeTab = "queue";
function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
function schedulePoll(tab, reload) {
  clearPoll();
  if (document.hidden) return; // resumed by the visibilitychange handler
  pollTimer = setTimeout(() => {
    if (activeTab === tab && !document.hidden) reload();
  }, POLL_MS);
}

// Reload the current tab (which reschedules polling if work is still pending).
function reloadActiveTab() {
  if (activeTab === "queue") loadQueue();
  else if (activeTab === "episodes") loadEpisodes();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearPoll();
  else reloadActiveTab(); // catch up on anything that settled while hidden
});

// --- Tabs ---
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

function showTab(tab) {
  activeTab = tab;
  clearPoll();
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  ["queue", "feeds", "episodes", "settings"].forEach((t) =>
    $(t).classList.toggle("hide", t !== tab));
  if (tab === "queue") loadQueue();
  if (tab === "feeds") loadFeeds();
  if (tab === "episodes") loadEpisodes();
  if (tab === "settings") loadSettings();
}

// --- Queue ---
// Human label for where an item came from, used for the per-card source line
// and the source filter. Manual URL drops share the synthetic "manual" feedId.
function sourceLabel(item, feedMap) {
  if (item.feedId === "manual") return "Pasted URL";
  return feedMap.get(item.feedId) ||
    item.siteName ||
    (item.sourceUrl ? new URL(item.sourceUrl).hostname : "Unknown source");
}

// Rebuild the source <select> from the feeds present in the current items,
// preserving the user's current selection if it still exists.
function populateSourceFilter(items, feedMap) {
  const sel = $("queueFilter");
  const current = sel.value;
  // Distinct feedIds present, each with its display label.
  const seen = new Map();
  for (const it of items) {
    if (!seen.has(it.feedId)) seen.set(it.feedId, sourceLabel(it, feedMap));
  }
  const opts = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  sel.innerHTML = `<option value="">All sources</option>` +
    opts.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join("");
  // Restore the previous choice, or fall back to "All" if that source is gone.
  sel.value = opts.some(([id]) => id === current) ? current : "";
}

// A conversion that entered a working state this long ago (and still hasn't
// finished) is treated as stranded — a background worker that died or a Polly
// finalize that never arrived — so the UI stops showing "converting…" forever
// and offers a retry instead. Mirrors STALE_CONVERT_MS on the backend.
const CONVERT_STALE_MS = 10 * 60 * 1000;
const CONVERTING = ["queued", "scripted", "synthesizing"];
function convertStalled(it) {
  return CONVERTING.includes(it.convertState) &&
    (!it.convertStartedAt ||
      Date.now() - new Date(it.convertStartedAt).getTime() > CONVERT_STALE_MS);
}

function convertBadge(item) {
  const s = item.convertState;
  if (s === "ready") return `<span class="badge ready">audio ready</span>`;
  if (s === "failed") return `<span class="badge failed">convert failed</span>`;
  if (CONVERTING.includes(s)) {
    return convertStalled(item)
      ? `<span class="badge failed">conversion stalled</span>`
      : `<span class="badge working">converting…</span>`;
  }
  if (item.queueStatus === "extract_failed")
    return `<span class="badge failed">extract failed</span>`;
  if (item.queueStatus === "extracted")
    return `<span class="badge">ready to read</span>`;
  return `<span class="badge working">fetching…</span>`;
}

/** True while an item is still doing work the UI should watch until it settles. */
function itemPending(it) {
  if (it.queueStatus === "new") return true;
  // A stalled conversion is no longer "pending" — stop polling it and let the
  // user retry, otherwise the queue would poll a stuck item indefinitely.
  return CONVERTING.includes(it.convertState) && !convertStalled(it);
}

async function loadQueue() {
  const list = $("queueList");
  if (!list.dataset.loaded) list.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    // Fetch items and feeds together so each card can show its source feed and
    // the filter can list every subscription by name.
    const [{ items }, feedsRes] = await Promise.all([
      api("/items"),
      api("/feeds").catch(() => ({ feeds: [] })),
    ]);
    const feedMap = new Map((feedsRes.feeds || []).map((f) => [f.id, f.title]));
    list.dataset.loaded = "1";

    populateSourceFilter(items, feedMap);
    const source = $("queueFilter").value;
    const showArchived = $("showArchived").checked;
    const shown = items.filter((it) =>
      (showArchived || it.readState !== "archived") &&
      (!source || it.feedId === source));

    if (!items.length) { list.innerHTML = `<div class="muted">Queue is empty.</div>`; }
    else if (!shown.length) {
      list.innerHTML = `<div class="muted">No articles match this filter.</div>`;
    } else {
      list.innerHTML = "";
      for (const it of shown) {
        const stalled = convertStalled(it);
        const canConvert = it.queueStatus === "extracted" &&
          (["none", "failed"].includes(it.convertState) || stalled);
        const convertLabel =
          it.convertState === "failed" || stalled ? "Retry conversion" : "Convert to audio";
        const canReextract = it.queueStatus === "extract_failed";
        const archived = it.readState === "archived";
        const el = document.createElement("div");
        el.className = "card";
        el.innerHTML = `
          <div class="row">
            <div class="grow">
              <div class="title">${esc(it.title)}</div>
              <div class="muted"><span class="badge">${esc(sourceLabel(it, feedMap))}</span>
                ${esc(it.siteName || new URL(it.sourceUrl).hostname)} ·
                <a href="${esc(it.sourceUrl)}" target="_blank">open article</a></div>
            </div>
            ${convertBadge(it)}
          </div>
          <div class="row" style="margin-top:10px">
            ${canConvert ? `<button class="act" data-convert="${it.id}">${convertLabel}</button>` : ""}
            ${canReextract ? `<button class="ghost" data-reextract="${it.id}">Retry</button>` : ""}
            ${archived
              ? `<button class="ghost" data-restore="${it.id}">Unarchive</button>`
              : `<button class="ghost" data-archive="${it.id}">Archive</button>`}
            ${it.error ? `<span class="muted">${esc(it.error)}</span>` : ""}
          </div>`;
        list.appendChild(el);
      }
    }
    list.querySelectorAll("[data-convert]").forEach((b) =>
      b.addEventListener("click", async () => {
        const label = b.textContent;
        b.disabled = true; b.textContent = "Starting…";
        try { await api(`/items/${b.dataset.convert}/convert`, "POST"); await loadQueue(); }
        catch (e) { alert(e.message); b.disabled = false; b.textContent = label; }
      }));
    list.querySelectorAll("[data-reextract]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "Retrying…";
        try { await api(`/items/${b.dataset.reextract}/reextract`, "POST"); await loadQueue(); }
        catch (e) { alert(e.message); b.disabled = false; b.textContent = "Retry"; }
      }));
    // Archive/unarchive just flip readState; hidden or shown by the filter above.
    const setRead = (id, readState, b, busy) => async () => {
      b.disabled = true; b.textContent = busy;
      try { await api(`/items/${id}`, "PATCH", { readState }); await loadQueue(); }
      catch (e) { alert(e.message); b.disabled = false; }
    };
    list.querySelectorAll("[data-archive]").forEach((b) =>
      b.addEventListener("click", setRead(b.dataset.archive, "archived", b, "Archiving…")));
    list.querySelectorAll("[data-restore]").forEach((b) =>
      b.addEventListener("click", setRead(b.dataset.restore, "unread", b, "Restoring…")));

    // Keep polling while anything is still fetching or converting.
    if (items.some(itemPending)) schedulePoll("queue", loadQueue);
  } catch (e) {
    if (!list.dataset.loaded) list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    // Don't let a transient error kill the auto-refresh loop: once the queue has
    // loaded once, keep retrying so live status updates resume on their own when
    // the API recovers (previously a single blip froze the list until a click).
    else schedulePoll("queue", loadQueue);
  }
}

// Re-render the queue when the source filter or archived toggle changes.
$("queueFilter").addEventListener("change", loadQueue);
$("showArchived").addEventListener("change", loadQueue);

$("addUrlBtn").addEventListener("click", async () => {
  const url = $("addUrl").value.trim();
  if (!url) return;
  $("addUrlBtn").disabled = true;
  try { await api("/items", "POST", { url }); $("addUrl").value = ""; await loadQueue(); }
  catch (e) { alert(e.message); }
  finally { $("addUrlBtn").disabled = false; }
});

// --- Feeds ---
// Display value for a feed's per-poll ingest limit: blank = global default,
// "all" = no cap, otherwise the number.
const limitValue = (f) =>
  f.ingestLimit === undefined ? "" : f.ingestLimit === 0 ? "all" : String(f.ingestLimit);

async function loadFeeds() {
  const list = $("feedList");
  list.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    // Fetch config alongside feeds so the limit inputs can show the real
    // global default (blank means "this many").
    const [{ feeds }, cfg] = await Promise.all([
      api("/feeds"),
      api("/config").catch(() => null),
    ]);
    const limitPlaceholder = cfg && cfg.maxItemsPerPoll ? `default (${cfg.maxItemsPerPoll})` : "default";
    $("feedLimit").placeholder = limitPlaceholder;
    if (!feeds.length) { list.innerHTML = `<div class="muted">No subscriptions yet.</div>`; return; }
    list.innerHTML = "";
    for (const f of feeds) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <div class="row">
          <div class="grow">
            <div class="title">${esc(f.title)}</div>
            <div class="muted">${esc(f.sourceUrl)}</div>
          </div>
          <label>limit <input data-limit="${f.id}" value="${esc(limitValue(f))}"
            placeholder="${esc(limitPlaceholder)}" title="Newest items per poll — number, 'all', or blank for default"
            style="width:96px" /></label>
          <label><input type="checkbox" data-auto="${f.id}" ${f.autoConvert ? "checked" : ""}/> auto-convert</label>
          <button class="ghost" data-poll="${f.id}">Poll now</button>
        </div>`;
      list.appendChild(el);
    }
    list.querySelectorAll("[data-auto]").forEach((c) =>
      c.addEventListener("change", () =>
        api(`/feeds/${c.dataset.auto}`, "PATCH", { autoConvert: c.checked }).catch((e) => alert(e.message))));
    list.querySelectorAll("[data-limit]").forEach((i) =>
      i.addEventListener("change", async () => {
        try { await api(`/feeds/${i.dataset.limit}`, "PATCH", { ingestLimit: i.value.trim() }); await loadFeeds(); }
        catch (e) { alert(e.message); }
      }));
    list.querySelectorAll("[data-poll]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "Polling…";
        try { const r = await api(`/feeds/${b.dataset.poll}/poll`, "POST"); alert(`Added ${r.added.length} new item(s).`); }
        catch (e) { alert(e.message); }
        finally { b.disabled = false; b.textContent = "Poll now"; }
      }));
  } catch (e) { list.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}

$("addFeedBtn").addEventListener("click", async () => {
  const sourceUrl = $("feedUrl").value.trim();
  if (!sourceUrl) return;
  try {
    await api("/feeds", "POST", {
      sourceUrl,
      autoConvert: $("feedAuto").checked,
      ingestLimit: $("feedLimit").value.trim(), // blank = default; number or "all"
    });
    $("feedUrl").value = ""; $("feedLimit").value = ""; $("feedAuto").checked = false;
    await loadFeeds();
  } catch (e) { alert(e.message); }
});

// --- Episodes ---
async function loadEpisodes() {
  try {
    const cfg = await api("/config");
    $("feedLink").value = cfg.feedUrl || "";
  } catch { /* ignore until connected */ }
  const list = $("episodeList");
  if (!list.dataset.loaded) list.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const { episodes } = await api("/episodes");
    list.dataset.loaded = "1";
    const ready = episodes.filter((e) => e.bytes);
    if (!ready.length) {
      list.innerHTML = `<div class="muted">No episodes yet.</div>`;
    } else {
      list.innerHTML = "";
      for (const e of ready) {
        const el = document.createElement("div");
        el.className = "card";
        el.innerHTML = `
          <div class="title">${esc(e.title)}</div>
          <div class="muted">${esc(e.showNotes)}</div>
          <div style="margin-top:6px"><a href="${esc(e.sourceUrl)}" target="_blank">source</a></div>`;
        list.appendChild(el);
      }
    }
    // Keep polling while any episode is still being synthesized.
    if (episodes.some((e) => !e.bytes)) schedulePoll("episodes", loadEpisodes);
  } catch (e) {
    if (!list.dataset.loaded) list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    else schedulePoll("episodes", loadEpisodes); // survive transient errors (see loadQueue)
  }
}

$("copyFeed").addEventListener("click", () => {
  navigator.clipboard.writeText($("feedLink").value);
  $("copyFeed").textContent = "Copied!";
  setTimeout(() => ($("copyFeed").textContent = "Copy"), 1200);
});

// --- Settings ---
function loadSettings() {
  $("apiBase").value = store.base;
  // When the URL is injected by the deployment, it's read-only here.
  if (store.baseFromConfig) {
    $("apiBase").disabled = true;
    $("apiBaseNote").classList.remove("hide");
  }
  $("apiKey").value = store.key;
  api("/config").then((c) => {
    $("voiceId").value = c.config.voiceId;
    $("mode").value = c.config.mode;
    $("podTitle").value = c.config.podcastTitle;
  }).catch(() => {});
}

$("saveConn").addEventListener("click", () => {
  // The base URL comes from the deployment when injected; only persist a
  // manually entered one (local dev).
  if (!store.baseFromConfig) store.base = $("apiBase").value.trim();
  store.key = $("apiKey").value.trim();
  $("connMsg").textContent = "Saved.";
  setTimeout(() => ($("connMsg").textContent = ""), 1500);
});

$("saveConfig").addEventListener("click", async () => {
  try {
    await api("/config", "POST", {
      voiceId: $("voiceId").value, mode: $("mode").value, podcastTitle: $("podTitle").value,
    });
    $("configMsg").textContent = "Saved.";
    setTimeout(() => ($("configMsg").textContent = ""), 1500);
  } catch (e) { alert(e.message); }
});

// --- Theme ---
// The <head> script already applied the saved theme (default light) before
// paint; here we keep the toggle button's label in sync and flip on click.
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch (e) { /* ignore */ }
  $("themeToggle").textContent = t === "dark" ? "☀ Light" : "🌙 Dark";
}
$("themeToggle").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
applyTheme(document.documentElement.dataset.theme || "light");

showTab("queue");
