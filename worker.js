/**
 * IPTV Proxy + Admin UI (Cloudflare Worker) - HYBRID STABLE VERSION (Entry-aware Admin)
 *
 * Supports ANY playlist filename:
 * - .../index.m3u8
 * - .../stream.m3u8
 * - .../playlist.m3u8
 * - .../index-0.m3u8
 * - .../whatever.m3u8
 *
 * Admin UI:
 * - User can enter FULL .m3u8 URL (auto base/entry)
 * - OR enter base folder + optional entry field
 */

const KV_KEY = "channels_v2";

const SEED_CHANNELS = {
  "2342": { name: "IRANinter", input: "https://live.livetvstream.co.uk/LS-63503-4/index.m3u8" },
  "1001": { name: "Sample 2", input: "https://familyhls.avatv.live/hls/stream.m3u8" },
  "1234": { name: "voa", input: "https://voa-ingest.akamaized.net/hls/live/2033876/tvmc07/playlist.m3u8" },
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      const protectMode = (env.PROTECT_MODE || "all").toLowerCase(); // all | admin
      const needsAuth =
        protectMode === "all"
          ? true
          : (path.startsWith("/admin") || path.startsWith("/api") || path.startsWith("/channels") || path.startsWith("/watch"));

      if (needsAuth) {
        const ok = await checkBasicAuth(request, env);
        if (!ok) return unauthorized();
      }

      if (path === "/" || path === "") return Response.redirect(url.origin + "/watch", 302);

      if (path === "/watch") return watchPage(url.origin);
      if (path === "/channels") return channelsPage(url.origin);
      if (path === "/admin") return adminPage(url.origin);

      // ===== API =====
      if (path === "/api/channels" && request.method === "GET") {
        const channels = await loadChannels(env);
        const out = Object.entries(channels).map(([id, ch]) => ({
          id,
          name: ch.name,
          input: ch.input || "",
          base: ch.base || "",
          entry: ch.entry || "index.m3u8",
          url: ch.input || ((ch.base || "") + (ch.entry || "index.m3u8")),
        }));
        return json(out);
      }

      if (path === "/api/channels" && request.method === "POST") {
        const body = await safeJson(request);

        const name = (body.name || "").trim();
        const input = (body.url || "").trim();        // main URL field
        const entryOverride = (body.entry || "").trim(); // optional entry field

        if (!name || !input) return json({ error: "name & url required" }, 400);
        if (!looksLikeHttpUrl(input)) return json({ error: "invalid url" }, 400);

        const channels = await loadChannels(env);
        const id = await generateUniqueId(channels);

        channels[id] = normalizeChannel({ name, input, entryOverride });
        await saveChannels(env, channels);

        return json({ ok: true, id });
      }

      if (path.startsWith("/api/channels/")) {
        const id = decodeURIComponent(path.split("/").pop() || "");
        const channels = await loadChannels(env);
        if (!channels[id]) return json({ error: "not found" }, 404);

        if (request.method === "PUT") {
          const body = await safeJson(request);
          const name = (body.name ?? channels[id].name).toString().trim();
          const input = (body.url ?? channels[id].input ?? "").toString().trim();
          const entryOverride = (body.entry ?? channels[id].entry ?? "").toString().trim();

          if (!name || !input) return json({ error: "name & url required" }, 400);
          if (!looksLikeHttpUrl(input)) return json({ error: "invalid url" }, 400);

          channels[id] = normalizeChannel({ name, input, entryOverride });
          await saveChannels(env, channels);
          return json({ ok: true });
        }

        if (request.method === "DELETE") {
          delete channels[id];
          await saveChannels(env, channels);
          return json({ ok: true });
        }

        return json({ error: "method not allowed" }, 405);
      }

      // ===== Proxy =====
      const parts = path.split("/").filter(Boolean);
      const channelId = parts[0] || "";
      const restPath = parts.slice(1).join("/");
      const queryString = url.search || "";

      const channels = await loadChannels(env);
      const ch = channels[channelId];
      if (!ch) return new Response("Channel not found", { status: 404 });

      if (restPath.startsWith("__proxy__/")) {
        const encodedUrl = restPath.replace("__proxy__/", "");
        const decodedUrl = decodeURIComponent(encodedUrl);

        const upstreamResponse = await fetch(decodedUrl, {
          headers: buildUpstreamHeaders(request, decodedUrl)
        });

        return passthroughBinary(upstreamResponse);
      }

      const targetUrl = buildTargetUrlFromNormalized(ch, restPath, queryString);

      const upstreamResponse = await fetch(targetUrl, {
        headers: buildUpstreamHeaders(request, targetUrl)
      });

      if (!upstreamResponse.ok) {
        return new Response("Upstream Error: " + upstreamResponse.status, { status: upstreamResponse.status });
      }

      const contentType = upstreamResponse.headers.get("content-type") || "";
      const upstreamFinalUrl = upstreamResponse.url;

      if (isPlaylist(contentType, upstreamFinalUrl)) {
        let playlistText = await upstreamResponse.text();
        const proxyBase = `${url.origin}/${channelId}`;
        playlistText = rewritePlaylistHybrid(playlistText, upstreamFinalUrl, proxyBase, ch.base);
        return new Response(playlistText, {
          headers: {
            ...corsHeaders("application/vnd.apple.mpegurl"),
            "Cache-Control": "public, max-age=5"
          }
        });
      }

      return passthroughBinary(upstreamResponse);

    } catch (err) {
      return new Response("Proxy Error: " + (err?.message || String(err)), { status: 500 });
    }
  }
};

// ===================== Storage =====================
async function loadChannels(env) {
  let raw = await env.CHANNELS_KV.get(KV_KEY);

  if (!raw) {
    const seeded = {};
    for (const [id, ch] of Object.entries(SEED_CHANNELS)) {
      seeded[id] = normalizeChannel({ name: ch.name, input: ch.input, entryOverride: "" });
    }
    await env.CHANNELS_KV.put(KV_KEY, JSON.stringify(seeded));
    return seeded;
  }

  let obj;
  try { obj = JSON.parse(raw); } catch { obj = {}; }
  if (!obj || typeof obj !== "object") obj = {};

  // Migration: old {name,url} => normalize
  let changed = false;
  for (const [id, ch] of Object.entries(obj)) {
    if (!ch || typeof ch !== "object") continue;

    if (!ch.base || !ch.entry) {
      const input = ch.input || ch.url || "";
      if (input && looksLikeHttpUrl(input)) {
        obj[id] = normalizeChannel({ name: ch.name || "Untitled", input, entryOverride: ch.entry || "" });
        changed = true;
      }
    }
  }

  if (changed) await env.CHANNELS_KV.put(KV_KEY, JSON.stringify(obj));
  return obj;
}

async function saveChannels(env, channels) {
  await env.CHANNELS_KV.put(KV_KEY, JSON.stringify(channels));
}

async function generateUniqueId(channels) {
  for (let i = 0; i < 20; i++) {
    const id = randomId();
    if (!channels[id]) return id;
  }
  return String(Date.now());
}

function randomId() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return (buf[0].toString(36) + buf[1].toString(36)).slice(0, 10);
}

/**
 * Normalize channel:
 * - If input ends with .m3u8 => base/entry extracted (ANY filename works)
 * - Else => treat input as folder, base = folder/, entry = entryOverride || "index.m3u8"
 */
function normalizeChannel({ name, input, entryOverride }) {
  const u = new URL(input);
  const out = { name, input };

  if (u.pathname.toLowerCase().endsWith(".m3u8")) {
    const idx = u.pathname.lastIndexOf("/");
    const dir = u.pathname.slice(0, idx + 1);
    const file = u.pathname.slice(idx + 1);
    out.base = `${u.origin}${dir}`;
    out.entry = file; // ✅ any name
    return out;
  }

  // folder mode
  let basePath = u.pathname;
  if (!basePath.endsWith("/")) basePath += "/";

  out.base = `${u.origin}${basePath}`;

  // If user typed entry like "index-0.m3u8" or "playlist.m3u8" use it
  const e = (entryOverride || "").trim();
  out.entry = e && e.toLowerCase().endsWith(".m3u8") ? e : "index.m3u8";

  return out;
}

// ===================== Auth =====================
async function checkBasicAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Basic ")) return false;

  const decoded = atob(auth.slice(6));
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  const expectedUser = env.ADMIN_USER || "admin";
  const expectedPass = env.ADMIN_PASS || "changeme";

  return timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aLen = a.length, bLen = b.length;
  const len = Math.max(aLen, bLen);
  let out = aLen ^ bLen;
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    out |= (ca ^ cb);
  }
  return out === 0;
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="IPTV Panel"',
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

// ===================== Proxy =====================
function buildTargetUrlFromNormalized(ch, restPath, queryString) {
  const base = ch.base.endsWith("/") ? ch.base : (ch.base + "/");

  if (restPath) return base + restPath + queryString;

  const entry = ch.entry || "index.m3u8";
  return base + entry + queryString;
}

function buildUpstreamHeaders(request, upstreamUrl) {
  const u = new URL(upstreamUrl);
  const headers = {
    "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": u.origin + "/",
    "Accept": request.headers.get("Accept") || "*/*",
    "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.9",
  };
  const range = request.headers.get("Range");
  if (range) headers["Range"] = range;
  return headers;
}

function isPlaylist(contentType, finalUrl) {
  if (!finalUrl) return false;
  return (
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegURL") ||
    new URL(finalUrl).pathname.endsWith(".m3u8")
  );
}

function corsHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*"
  };
}

function rewritePlaylistHybrid(playlistText, upstreamFinalUrl, proxyBase, channelBase) {
  const finalBase = upstreamFinalUrl.substring(0, upstreamFinalUrl.lastIndexOf("/") + 1);

  const toProxy = (absUrl) => {
    if (channelBase && absUrl.startsWith(channelBase)) {
      const rel = absUrl.slice(channelBase.length);
      return `${proxyBase}/${rel}`;
    }
    return `${proxyBase}/__proxy__/${encodeURIComponent(absUrl)}`;
  };

  playlistText = playlistText.replace(/^([^#][^\r\n]*)/gm, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const abs = new URL(trimmed, finalBase).toString();
    return toProxy(abs);
  });

  playlistText = playlistText.replace(/(URI=")([^"]+)(")/g, (m, p1, uri, p3) => {
    const abs = new URL(uri, finalBase).toString();
    return `${p1}${toProxy(abs)}${p3}`;
  });

  playlistText = playlistText.replace(/(URI=')([^']+)(')/g, (m, p1, uri, p3) => {
    const abs = new URL(uri, finalBase).toString();
    return `${p1}${toProxy(abs)}${p3}`;
  });

  return playlistText;
}

function passthroughBinary(upstreamResponse) {
  const h = new Headers(upstreamResponse.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "*");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "public, max-age=5");
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: h });
}

// ===================== UI Pages =====================
function baseLayout(title, bodyHtml) {
  const css = `
    :root{color-scheme:dark}
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto; background:#0b1220; color:#e7eefc;}
    header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #1b2a4a;background:#0c1630;position:sticky;top:0}
    a{color:#8ab4ff;text-decoration:none}
    .wrap{max-width:1100px;margin:0 auto;padding:18px}
    .card{background:#0f1b36;border:1px solid #1b2a4a;border-radius:14px;padding:14px 14px; box-shadow:0 8px 24px rgba(0,0,0,.25)}
    .grid{display:grid;gap:14px}
    .grid2{grid-template-columns:1fr 1fr}
    @media(max-width:900px){.grid2{grid-template-columns:1fr}}
    input,select,button,textarea{width:100%;padding:10px 12px;border-radius:12px;border:1px solid #2a3c68;background:#0b142b;color:#e7eefc;outline:none}
    button{cursor:pointer;background:#1f3b7a;border-color:#2a58c7}
    button.secondary{background:#14254d;border-color:#27407a}
    button.danger{background:#4a1420;border-color:#a8324a}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;border-bottom:1px solid #1b2a4a;text-align:left;vertical-align:top}
    .muted{color:#a8b7d9;font-size:12px}
    .row{display:flex;gap:10px;align-items:center}
    .row > * {flex:1}
    .pill{display:inline-block;padding:4px 10px;border:1px solid #2a3c68;border-radius:999px;background:#0b142b}
  `;
  return new Response(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<header>
  <div class="row" style="max-width:1100px;margin:0 auto;width:100%;gap:14px">
    <div style="flex:1">
      <div style="font-weight:700">IPTV Panel</div>
      <div class="muted">KV-backed • Auth protected • HLS proxy</div>
    </div>
    <div style="display:flex;gap:12px;flex:0">
      <a class="pill" href="/watch">Watch</a>
      <a class="pill" href="/channels">Channels</a>
      <a class="pill" href="/admin">Admin</a>
    </div>
  </div>
</header>
<div class="wrap">
${bodyHtml}
</div>
</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function watchPage(origin) {
  const html = `
  <div class="grid grid2">
    <div class="card">
      <h2 style="margin:0 0 8px 0">پخش آنلاین</h2>
      <div class="muted" style="margin-bottom:12px">انتخاب بر اساس نام یا ID — لینک پخش کوتاه ساخته می‌شود.</div>
      <select id="channelSelect"></select>
      <div class="row" style="margin-top:10px">
        <button id="playBtn">Play</button>
        <button class="secondary" id="copyBtn">Copy Link</button>
      </div>
      <div class="muted" style="margin-top:10px" id="currentLink"></div>
      <div class="muted" style="margin-top:10px" id="status"></div>
    </div>
    <div class="card">
      <video id="video" controls autoplay style="width:100%;border-radius:12px;background:#000"></video>
      <div class="muted" style="margin-top:10px">اگر مرورگر HLS native نداشت، HLS.js استفاده می‌شود.</div>
    </div>
  </div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
(async function(){
  const sel = document.getElementById('channelSelect');
  const playBtn = document.getElementById('playBtn');
  const copyBtn = document.getElementById('copyBtn');
  const linkEl = document.getElementById('currentLink');
  const statusEl = document.getElementById('status');
  const video = document.getElementById('video');

  const res = await fetch('/api/channels');
  const list = await res.json();

  list.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
  sel.innerHTML = list.map(ch => {
    const label = (ch.name || 'Untitled') + '  •  ' + ch.id;
    return '<option value="'+encodeURIComponent(ch.id)+'">'+escapeHtml(label)+'</option>';
  }).join('');

  function buildLink(idEnc){
    return location.origin + '/' + encodeURIComponent(decodeURIComponent(idEnc));
  }

  let hls;
  function setStatus(s){ statusEl.textContent = s || ''; }

  async function play(){
    const idEnc = sel.value;
    const link = buildLink(idEnc);
    linkEl.textContent = link;
    setStatus('');

    if (hls) { hls.destroy(); hls = null; }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = link;
      video.play().catch(()=>{});
      return;
    }

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(link);
      hls.attachMedia(video);

      hls.on(Hls.Events.ERROR, function (event, data) {
        setStatus('HLS error: ' + (data && data.details ? data.details : 'unknown'));
        console.log('HLS error', data);
      });
      return;
    }

    video.src = link;
    video.play().catch(()=>{});
  }

  playBtn.onclick = play;

  copyBtn.onclick = async () => {
    const link = linkEl.textContent || buildLink(sel.value);
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent='Copied!';
      setTimeout(()=>copyBtn.textContent='Copy Link',900);
    } catch(e){}
  };

  sel.onchange = play;

  if (list.length) play();
})();

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
`;
  return baseLayout("Watch", html);
}

function channelsPage(origin) {
  const html = `
  <div class="card">
    <h2 style="margin:0 0 8px 0">لیست کانال‌ها</h2>
    <div class="muted" style="margin-bottom:12px">روی لینک کلیک کن یا کپی کن.</div>
    <div id="tblWrap" class="muted">Loading...</div>
  </div>

<script>
(async function(){
  const wrap = document.getElementById('tblWrap');
  const res = await fetch('/api/channels');
  const list = await res.json();
  list.sort((a,b)=> (a.name||'').localeCompare(b.name||''));

  const rows = list.map(ch => {
    const link = location.origin + '/' + encodeURIComponent(ch.id);
    return \`
      <tr>
        <td><span class="pill">\${escapeHtml(ch.id)}</span></td>
        <td>\${escapeHtml(ch.name || '')}<div class="muted" style="margin-top:6px;word-break:break-all">\${escapeHtml(ch.url||'')}</div></td>
        <td style="white-space:nowrap">
          <a href="\${link}">Open</a>
          <span class="muted"> • </span>
          <a href="#" data-copy="\${link}">Copy</a>
        </td>
      </tr>\`;
  }).join('');

  wrap.className = '';
  wrap.innerHTML = \`
    <table>
      <thead><tr><th>ID</th><th>Name / Upstream</th><th>Play link</th></tr></thead>
      <tbody>\${rows || '<tr><td colspan="3" class="muted">No channels</td></tr>'}</tbody>
    </table>\`;

  wrap.querySelectorAll('[data-copy]').forEach(a=>{
    a.addEventListener('click', async (e)=>{
      e.preventDefault();
      const link = a.getAttribute('data-copy');
      try { await navigator.clipboard.writeText(link); a.textContent='Copied'; setTimeout(()=>a.textContent='Copy',900);} catch(e){}
    });
  });
})();

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
`;
  return baseLayout("Channels", html);
}

/**
 * Admin UI UPDATE:
 * - Added "Entry (optional)" input
 * - If URL not ending with .m3u8, entry is used (default index.m3u8)
 */
function adminPage(origin) {
  const html = `
  <div class="grid grid2">
    <div class="card">
      <h2 style="margin:0 0 8px 0">اضافه کردن کانال جدید</h2>
      <div class="muted" style="margin-bottom:12px">
        حالت ۱: URL کامل .m3u8 بده (هر اسمی داشته باشه) ✅<br/>
        حالت ۲: فقط پوشه بده + Entry رو وارد کن (مثلاً index-0.m3u8) ✅
      </div>
      <input id="newName" placeholder="Channel name" />
      <div style="height:10px"></div>
      <input id="newUrl" placeholder="Full upstream url OR folder (https://...)" />
      <div style="height:10px"></div>
      <input id="newEntry" placeholder="Entry (optional) e.g. index-0.m3u8" />
      <div class="muted" style="margin-top:6px">اگر URL با .m3u8 تموم بشه، این فیلد نادیده گرفته می‌شه.</div>
      <div style="height:10px"></div>
      <button id="addBtn">Add</button>
      <div class="muted" style="margin-top:10px" id="addStatus"></div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 8px 0">ویرایش / حذف</h2>
      <div class="muted" style="margin-bottom:12px">روی یک آیتم کلیک کن تا ویرایش شود.</div>
      <div id="listWrap" class="muted">Loading...</div>
    </div>
  </div>

  <div class="card" style="margin-top:14px; display:none" id="editCard">
    <h2 style="margin:0 0 8px 0">Edit Channel</h2>
    <div class="row">
      <div>
        <div class="muted">ID</div>
        <div class="pill" id="editId"></div>
      </div>
      <div style="flex:2">
        <div class="muted">Name</div>
        <input id="editName" />
      </div>
    </div>

    <div class="row" style="margin-top:10px">
      <div style="flex:3">
        <div class="muted">URL</div>
        <input id="editUrl" />
      </div>
      <div style="flex:1.5">
        <div class="muted">Entry (optional)</div>
        <input id="editEntry" placeholder="index-0.m3u8" />
      </div>
    </div>
    <div class="muted" style="margin-top:6px">اگر URL با .m3u8 تموم بشه، Entry نادیده گرفته می‌شه.</div>

    <div class="row" style="margin-top:10px">
      <button id="saveBtn">Save</button>
      <button class="danger" id="delBtn">Delete</button>
      <button class="secondary" id="cancelBtn">Cancel</button>
    </div>
    <div class="muted" style="margin-top:10px" id="editStatus"></div>
  </div>

<script>
(async function(){
  const addBtn = document.getElementById('addBtn');
  const addStatus = document.getElementById('addStatus');
  const newName = document.getElementById('newName');
  const newUrl = document.getElementById('newUrl');
  const newEntry = document.getElementById('newEntry');

  const listWrap = document.getElementById('listWrap');
  const editCard = document.getElementById('editCard');
  const editId = document.getElementById('editId');
  const editName = document.getElementById('editName');
  const editUrl = document.getElementById('editUrl');
  const editEntry = document.getElementById('editEntry');
  const editStatus = document.getElementById('editStatus');
  const saveBtn = document.getElementById('saveBtn');
  const delBtn = document.getElementById('delBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  let current = null;

  async function load(){
    const res = await fetch('/api/channels');
    const list = await res.json();
    list.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    listWrap.className = '';
    listWrap.innerHTML = \`
      <table>
        <thead><tr><th>ID</th><th>Name</th><th class="muted">Upstream</th></tr></thead>
        <tbody>
          \${list.map(ch => \`
            <tr data-id="\${escapeHtml(ch.id)}"
                data-name="\${escapeHtml(ch.name||'')}"
                data-url="\${escapeHtml(ch.input||ch.url||'')}"
                data-entry="\${escapeHtml(ch.entry||'')}">
              <td><span class="pill">\${escapeHtml(ch.id)}</span></td>
              <td>\${escapeHtml(ch.name||'')}</td>
              <td class="muted" style="word-break:break-all">\${escapeHtml(ch.url||'')}</td>
            </tr>\`).join('') || '<tr><td colspan="3" class="muted">No channels</td></tr>'}
        </tbody>
      </table>\`;

    listWrap.querySelectorAll('tr[data-id]').forEach(tr=>{
      tr.addEventListener('click', ()=>{
        current = tr.getAttribute('data-id');
        editId.textContent = current;
        editName.value = tr.getAttribute('data-name') || '';
        editUrl.value = tr.getAttribute('data-url') || '';
        editEntry.value = tr.getAttribute('data-entry') || '';
        editStatus.textContent = '';
        editCard.style.display = 'block';
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      });
    });
  }

  addBtn.onclick = async () => {
    addStatus.textContent = '';
    const name = (newName.value || '').trim();
    const url = (newUrl.value || '').trim();
    const entry = (newEntry.value || '').trim();
    if (!name || !url) { addStatus.textContent = 'name/url required'; return; }

    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ name, url, entry })
    });
    const data = await res.json();
    if (!res.ok) { addStatus.textContent = data.error || 'error'; return; }
    addStatus.textContent = 'Added with ID: ' + data.id;
    newName.value = ''; newUrl.value = ''; newEntry.value = '';
    await load();
  };

  saveBtn.onclick = async () => {
    if (!current) return;
    editStatus.textContent = '';
    const name = (editName.value || '').trim();
    const url = (editUrl.value || '').trim();
    const entry = (editEntry.value || '').trim();

    const res = await fetch('/api/channels/' + encodeURIComponent(current), {
      method: 'PUT',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ name, url, entry })
    });
    const data = await res.json();
    if (!res.ok) { editStatus.textContent = data.error || 'error'; return; }
    editStatus.textContent = 'Saved.';
    await load();
  };

  delBtn.onclick = async () => {
    if (!current) return;
    if (!confirm('Delete channel ' + current + '?')) return;
    editStatus.textContent = '';
    const res = await fetch('/api/channels/' + encodeURIComponent(current), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { editStatus.textContent = data.error || 'error'; return; }
    editStatus.textContent = 'Deleted.';
    editCard.style.display = 'none';
    current = null;
    await load();
  };

  cancelBtn.onclick = () => { editCard.style.display='none'; current=null; };

  await load();
})();

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
`;
  return baseLayout("Admin", html);
}

// ===================== Utils =====================
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}
function looksLikeHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}