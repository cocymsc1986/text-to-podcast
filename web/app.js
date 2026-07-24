// Tiny vanilla SPA for the reading queue -> podcast platform.
const store = {
  get base() { return localStorage.getItem("apiBase") || ""; },
  set base(v) { localStorage.setItem("apiBase", v); },
  get key() { return localStorage.getItem("apiKey") || ""; },
  set key(v) { localStorage.setItem("apiKey", v); },
};

async function api(path, method = "GET", body) {
  if (!store.base) throw new Error("Set the API base URL in Settings first.");
  const res = await fetch(store.base.replace(/\/$/, "") + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(store.key ? { "x-api-key": store.key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const $ = (id) => document.getElementById(id);
const esc = (s) => (s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- Auto-refresh polling ---
// While anything is still fetching/converting/synthesizing, re-load the active
// tab every few seconds so it reports "ready"/"failed" on its own — no manual
// refresh needed. Only one timer runs at a time; switching tabs cancels it.
const POLL_MS = 4000;
let pollTimer = null;
let activeTab = "queue";
function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
function schedulePoll(tab, reload) {
  clearPoll();
  pollTimer = setTimeout(() => { if (activeTab === tab) reload(); }, POLL_MS);
}

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
function convertBadge(item) {
  const s = item.convertState;
  if (s === "ready") return `<span class="badge ready">audio ready</span>`;
  if (s === "failed") return `<span class="badge failed">convert failed</span>`;
  if (["queued", "scripted", "synthesizing"].includes(s))
    return `<span class="badge working">converting…</span>`;
  if (item.queueStatus === "extract_failed")
    return `<span class="badge failed">extract failed</span>`;
  if (item.queueStatus === "extracted")
    return `<span class="badge">ready to read</span>`;
  return `<span class="badge working">fetching…</span>`;
}

/** True while an item is still doing work the UI should watch until it settles. */
function itemPending(it) {
  return it.queueStatus === "new" ||
    ["queued", "scripted", "synthesizing"].includes(it.convertState);
}

async function loadQueue() {
  const list = $("queueList");
  if (!list.dataset.loaded) list.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const { items } = await api("/items");
    list.dataset.loaded = "1";
    if (!items.length) { list.innerHTML = `<div class="muted">Queue is empty.</div>`; return; }
    list.innerHTML = "";
    for (const it of items) {
      const canConvert = it.queueStatus === "extracted" &&
        ["none", "failed"].includes(it.convertState);
      const convertLabel = it.convertState === "failed" ? "Retry conversion" : "Convert to audio";
      const canReextract = it.queueStatus === "extract_failed";
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <div class="row">
          <div class="grow">
            <div class="title">${esc(it.title)}</div>
            <div class="muted">${esc(it.siteName || new URL(it.sourceUrl).hostname)} ·
              <a href="${esc(it.sourceUrl)}" target="_blank">open article</a></div>
          </div>
          ${convertBadge(it)}
        </div>
        <div class="row" style="margin-top:10px">
          ${canConvert ? `<button class="act" data-convert="${it.id}">${convertLabel}</button>` : ""}
          ${canReextract ? `<button class="ghost" data-reextract="${it.id}">Retry</button>` : ""}
          ${it.error ? `<span class="muted">${esc(it.error)}</span>` : ""}
        </div>`;
      list.appendChild(el);
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

    // Keep polling while anything is still fetching or converting.
    if (items.some(itemPending)) schedulePoll("queue", loadQueue);
  } catch (e) {
    if (!list.dataset.loaded) list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

$("addUrlBtn").addEventListener("click", async () => {
  const url = $("addUrl").value.trim();
  if (!url) return;
  $("addUrlBtn").disabled = true;
  try { await api("/items", "POST", { url }); $("addUrl").value = ""; await loadQueue(); }
  catch (e) { alert(e.message); }
  finally { $("addUrlBtn").disabled = false; }
});

// --- Feeds ---
async function loadFeeds() {
  const list = $("feedList");
  list.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const { feeds } = await api("/feeds");
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
          <label><input type="checkbox" data-auto="${f.id}" ${f.autoConvert ? "checked" : ""}/> auto-convert</label>
          <button class="ghost" data-poll="${f.id}">Poll now</button>
        </div>`;
      list.appendChild(el);
    }
    list.querySelectorAll("[data-auto]").forEach((c) =>
      c.addEventListener("change", () =>
        api(`/feeds/${c.dataset.auto}`, "PATCH", { autoConvert: c.checked }).catch((e) => alert(e.message))));
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
    await api("/feeds", "POST", { sourceUrl, autoConvert: $("feedAuto").checked });
    $("feedUrl").value = ""; $("feedAuto").checked = false; await loadFeeds();
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
  $("apiKey").value = store.key;
  api("/config").then((c) => {
    $("voiceId").value = c.config.voiceId;
    $("mode").value = c.config.mode;
    $("podTitle").value = c.config.podcastTitle;
  }).catch(() => {});
}

$("saveConn").addEventListener("click", () => {
  store.base = $("apiBase").value.trim();
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

showTab("queue");
