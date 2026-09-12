const API_BASE_URL = "https://go-music-api-production.luoxi.workers.dev";
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "expires"];
const UPSTREAM_TIMEOUT_MS = 12000;
const UPSTREAM_RETRIES = 2;
const AUDIO_TIMEOUT_MS = 40000;
const ALLOWED_TYPES = ["search", "url", "lyric", "pic", "audio", "playlist"];

const UA_COMMON =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1";
const REF_NETEASE = "https://music.163.com/";

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
    }
  }
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: createCorsHeaders(new Headers({ "Content-Type": "application/json; charset=utf-8" })),
  });
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function buildUpstreamUrl(url: URL): URL {
  const types = url.searchParams.get("types");
  const source = url.searchParams.get("source") || "netease";

  if (types === "pic") {
    const upstream = new URL(`${API_BASE_URL}/api/v1/music/pic`);
    upstream.searchParams.set("source", source);
    upstream.searchParams.set("id", url.searchParams.get("id") || "");
    return upstream;
  }

  if (types === "playlist") {
    const upstream = new URL(API_BASE_URL);
    upstream.searchParams.set("types", "playlist");
    upstream.searchParams.set("id", url.searchParams.get("id") || "");
    upstream.searchParams.set("limit", url.searchParams.get("limit") || "50");
    upstream.searchParams.set("offset", url.searchParams.get("offset") || "0");
    const s = url.searchParams.get("s");
    if (s) upstream.searchParams.set("s", s);
    return upstream;
  }

  if (types === "audio" || types === "url") {
    const upstream = new URL(`${API_BASE_URL}/api/v1/music/url`);
    upstream.searchParams.set("source", source);
    upstream.searchParams.set("id", url.searchParams.get("id") || "");
    upstream.searchParams.set("br", url.searchParams.get("br") || "320");
    const albumId = url.searchParams.get("album_id");
    if (albumId) upstream.searchParams.set("album_id", albumId);
    const name = url.searchParams.get("name");
    if (name) upstream.searchParams.set("name", name);
    const artist = url.searchParams.get("artist");
    if (artist) upstream.searchParams.set("artist", artist);
    return upstream;
  }

  const endpoint = types === "search" ? "search" : types === "lyric" ? "lyric" : "url";
  const upstream = new URL(`${API_BASE_URL}/api/v1/music/${endpoint}`);
  upstream.searchParams.set("source", source);
  upstream.searchParams.set("id", url.searchParams.get("id") || "");

  if (types === "search") {
    upstream.searchParams.delete("id");
    upstream.searchParams.set("q", url.searchParams.get("q") || url.searchParams.get("name") || "");
  }

  return upstream;
}

async function fetchUpstreamWithRetry(url: URL): Promise<Response> {
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { "Accept": "application/json", "User-Agent": UA_COMMON },
      });
      if (response.ok) break;
      lastError = new Error(`go-music-api returned ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < UPSTREAM_RETRIES) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (!response?.ok) {
    throw lastError || new Error("upstream request failed");
  }
  return response;
}

// 将网易云歌曲解析为可直接播放的 CDN 直链（绕过 outer/url 的地区风控）
async function resolveNeteaseCdnUrl(id: string, br: string): Promise<string | null> {
  if (!/^\d+$/.test(id.trim())) return null;
  const apiUrl = new URL("https://music.163.com/api/song/enhance/player/url");
  apiUrl.searchParams.set("ids", `[${id.trim()}]`);
  apiUrl.searchParams.set("br", `${(parseInt(br, 10) || 320) * 1000}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA_MOBILE,
        "Referer": REF_NETEASE,
        "Cookie": "os=pc; appver=8.9.70; osver=10.2.1; channel=netease_music",
      },
    });
    if (!resp.ok) return null;
    const payload = (await resp.json()) as { data?: { url?: string | null; code?: number }[] };
    const item = Array.isArray(payload.data) ? payload.data[0] : null;
    if (item && typeof item.url === "string" && item.url) return item.url;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// 酷我歌词解密常量
const KUWO_LRC_KEY = new TextEncoder().encode("yeelion");

// 酷我取链：与 worker 同款三级降级（antiserver -> mobi 签名 -> www playUrl），
// 对限流/版权提示做多轮重试并透传酷我原始文案
async function resolveKuwoStreamUrl(rid: string): Promise<string | null> {
  const cleanRid = rid.replace(/^MUSIC_/, "");
  const toHttps = (u: string) => (u ? u.replace(/^http:/, "https:") : "");
  const xff = () =>
    `${Math.floor(Math.random() * 255) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  // 透传酷我侧的错误提示（如"当前音乐只在酷我最新版播放"），供前端定向提示
  let lastMsg = "";

  // 1. antiserver 直解（多轮重试）
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(`http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_${cleanRid}&format=mp3&response=url`, {
        headers: { "User-Agent": UA_COMMON, "Accept": "text/plain, */*", "X-Forwarded-For": xff() },
      });
      if (resp.ok) {
        const text = (await resp.text()).trim();
        if (text && !text.startsWith("<") && /^https?:\/\//i.test(text)) return toHttps(text);
        if (text && !lastMsg) lastMsg = text.slice(0, 120);
      }
    } catch { /* continue */ }
  }

  // 2. mobi.kuwo.cn 签名取链（与 music-lib 同款，抗限流更稳），br 与整组均多轮重试
  const randomID = `C_APK_guanwang_${Date.now()}${Math.floor(Math.random() * 1000000)}`;
  const brs = ["320kmp3", "128kmp3", "flac"];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const user = attempt === 0 ? randomID : `C_APK_guanwang_${Date.now() + attempt}${Math.floor(Math.random() * 1000000)}`;
    for (const br of brs) {
      try {
        const params = new URLSearchParams({
          f: "web",
          source: "kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk",
          from: "PC",
          type: "convert_url_with_sign",
          br,
          rid: cleanRid,
          user,
        });
        const params2 = new URLSearchParams(params);
        params2.set("format", "mp3");
        const resp = await fetch(`https://mobi.kuwo.cn/mobi.s?${params2.toString()}`, {
          headers: { "User-Agent": UA_COMMON, "Accept": "application/json", "X-Forwarded-For": xff() },
        });
        if (!resp.ok) continue;
        const data = (await resp.json()) as { data?: { url?: string; msg?: string } };
        const u = data?.data?.url || "";
        if (u) return toHttps(u);
        const msg = data?.data?.msg || "";
        if (msg && !lastMsg) lastMsg = msg.slice(0, 120);
      } catch { /* continue */ }
    }
  }

  // 3. www.kuwo.cn Web 接口（伪造签名头）
  try {
    const resp = await fetch(`https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${cleanRid}&type=music&httpsStatus=1`, {
      headers: {
        "User-Agent": UA_COMMON,
        "Accept": "application/json",
        "Secret": "kuwo_web_secret",
        "Cookie": "kw_token=secret_token",
        "csrf": "secret_token",
      },
    });
    if (resp.ok) {
      const data = (await resp.json()) as { data?: { url?: string; msg?: string } };
      const u = data?.data?.url || "";
      if (u) return toHttps(u);
      const msg = data?.data?.msg || "";
      if (msg && !lastMsg) lastMsg = msg.slice(0, 120);
    }
  } catch { /* continue */ }

  if (lastMsg) throw new Error(`kuwo: ${lastMsg}`);
  return null;
}

// ==================== 内联搜索（消除 workers.dev 依赖） ====================

async function searchNeteaseInline(keyword: string, limit = 20): Promise<unknown[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // POST method returns Chinese-localized results; GET returns irrelevant global results
    // X-Forwarded-For with CN IP bypasses geo-based result filtering
    const body = new URLSearchParams({
      s: keyword, type: "1", limit: String(limit), offset: "0",
    });
    const resp = await fetch("https://music.163.com/api/search/get", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "User-Agent": UA_COMMON,
        "Referer": REF_NETEASE,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": "os=pc; appver=2.9.7;",
        "X-Forwarded-For": "116.25.146.177",
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      console.warn(`netease search HTTP ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as { result?: { songs?: { id: number; name: string; artists?: { name: string }[]; album?: { name: string; picUrl?: string }; dt?: number }[] } };
    const songs = data.result?.songs || [];
    console.log(`netease search "${keyword}" => ${songs.length} results`);
    return songs.map((s) => ({
      id: String(s.id),
      name: s.name,
      artist: s.artists?.map((a) => a.name).join(" / ") || "",
      album: s.album?.name || "",
      cover: s.album?.picUrl || "",
      duration: Math.round((s.dt || 0) / 1000),
      source: "netease",
    }));
  } catch (e) {
    console.warn("netease search failed", e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchKuwoInline(keyword: string): Promise<unknown[]> {
  const params = new URLSearchParams({
    all: keyword, ft: "music", rn: "10", pn: "0",
    rformat: "json", encoding: "utf8",
  });
  const url = `https://search.kuwo.cn/r.s?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA_COMMON, "Accept": "application/json, text/plain, */*" },
    });
    if (!resp.ok) {
      console.warn(`kuwo search HTTP ${resp.status}`);
      return [];
    }
    const text = await resp.text();
    // search.kuwo.cn returns Python-style dict; split by MUSICRID to get song blocks
    const songBlocks = text.split("'MUSICRID':'");
    const songs: unknown[] = [];
    const decodeHtml = (s: string) => s
      .replace(/&nbsp;/g, " ")
      .replace(/&#?\w+;/g, "")
      .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    for (let i = 1; i < songBlocks.length; i++) {
      const block = songBlocks[i];
      const endIdx = block.indexOf("'MUSICRID':'");
      const songStr = endIdx > 0 ? block.substring(0, endIdx) : block;
      const ridMatch = songStr.match(/^MUSIC_(\d+)/);
      const nameMatch = songStr.match(/'SONGNAME':'([^']*)'/);
      const artistMatch = songStr.match(/'ARTIST':'([^']*)'/);
      const albumMatch = songStr.match(/'ALBUM':'([^']*)'/);
      const durationMatch = songStr.match(/'DURATION':'(\d+)'/);
      const picMatch = songStr.match(/'hts_MVPIC':'([^']*)'/);
      const onlineMatch = songStr.match(/'ONLINE':'(\d+)'/);
      if (!ridMatch || !nameMatch || onlineMatch?.[1] === "0") continue;
      songs.push({
        id: ridMatch[1],
        name: decodeHtml(nameMatch[1]),
        artist: decodeHtml(artistMatch?.[1] || ""),
        album: decodeHtml(albumMatch?.[1] || ""),
        cover: picMatch?.[1] || "",
        duration: Number(durationMatch?.[1]) || 0,
        source: "kuwo",
      });
    }
    console.log(`kuwo search "${keyword}" => ${songs.length} results`);
    return songs;
  } catch (e) {
    console.warn("kuwo search failed", e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== 搜索分发 ====================

async function searchQQInline(keyword: string, limit = 20): Promise<unknown[]> {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&p=1&n=${limit}&format=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA_COMMON,
        "Referer": "https://y.qq.com/",
        "Accept": "application/json, text/plain, */*",
      },
    });
    if (!resp.ok) {
      console.warn(`qq search HTTP ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as { data?: { song?: { list?: {
      songid: number; songmid: string; songname: string;
      singer: { id: number; mid: string; name: string }[];
      albumid: number; albummid: string; albumname: string;
      interval: number; strMediaMid: string;
    }[] } } };
    const list = data.data?.song?.list || [];
    console.log(`qq search "${keyword}" => ${list.length} results`);
    return list.map((s) => ({
      id: s.songmid,
      name: s.songname,
      artist: s.singer?.map((a) => a.name).join(" / ") || "",
      album: s.albumname || "",
      cover: s.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg` : "",
      duration: s.interval || 0,
      source: "qq",
      _mediaMid: s.strMediaMid,
    }));
  } catch (e) {
    console.warn("qq search failed", e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchInline(keyword: string, source: string): Promise<unknown[]> {
  if (source === "netease") return searchNeteaseInline(keyword);
  if (source === "kuwo") return searchKuwoInline(keyword);
  if (source === "qq") return searchQQInline(keyword);
  // 其他源仍走 worker（目前不可用时返回空）
  return [];
}

// ==================== 音频流解析 ====================
async function resolveStreamUrl(url: URL): Promise<string | null> {
  const source = url.searchParams.get("source") || "netease";
  const id = url.searchParams.get("id") || "";
  const br = url.searchParams.get("br") || "320";

  if (source === "netease") {
    const resolved = await resolveNeteaseCdnUrl(id, br);
    return resolved;
  }

  if (source === "kuwo") {
    return resolveKuwoStreamUrl(id);
  }

  const upstreamUrl = buildUpstreamUrl(url);
  const upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl);
  const payload = (await upstreamResponse.json()) as { code?: number; data?: { url?: string }; msg?: string };
  const audioUrl = payload.data?.url;
  if (!audioUrl) return null;
  // 网易云 outer/url 从 Cloudflare 拉取必被 -462 风控拦截，无法代理
  if (audioUrl.includes("/song/media/outer/url")) return null;
  return audioUrl;
}

async function proxyApiRequest(url: URL): Promise<Response> {
  const types = url.searchParams.get("types");
  if (!types) return new Response("Missing types", { status: 400 });
  if (!ALLOWED_TYPES.includes(types)) {
    return jsonResponse({ error: `暂不支持 ${types} 接口` }, 501);
  }

  if (types === "audio") {
    return proxyAudioStream(url);
  }

  // 内联搜索（消除 workers.dev 依赖）
  if (types === "search") {
    const keyword = url.searchParams.get("q") || url.searchParams.get("name") || "";
    const source = url.searchParams.get("source") || "netease";
    if (!keyword) return jsonResponse({ error: "Missing search keyword" }, 400);
    const songs = await searchInline(keyword, source);
    return jsonResponse(songs);
  }

  // 其他类型仍走 worker
  const upstreamUrl = buildUpstreamUrl(url);
  try {
    const upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl);
    const payload = (await upstreamResponse.json()) as { code?: number; data?: unknown; playlist?: unknown; msg?: string };
    if (payload.code !== undefined && payload.code !== 200) {
      return jsonResponse({ error: payload.msg || "音乐接口返回错误" }, 502);
    }
    if (types === "playlist") return jsonResponse({ playlist: payload.playlist || payload.data || {} });
    return jsonResponse(payload.data || {});
  } catch (error) {
    console.warn("go-music-api request failed", error);
    return jsonResponse({ error: "音乐服务暂时无法访问，请稍后重试" }, 503);
  }
}

async function proxyAudioStream(url: URL, rangeHeader?: string | null): Promise<Response> {
  let streamUrl: string;
  try {
    const resolved = await resolveStreamUrl(url);
    if (!resolved) {
      return jsonResponse({ error: "该歌曲需会员或暂无免费播放音源，请更换歌曲" }, 404);
    }
    streamUrl = resolved;
  } catch (error) {
    console.warn("resolve stream url failed", error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith("kuwo:")) {
      return jsonResponse({ error: msg.slice(5) }, 502);
    }
    return jsonResponse({ error: "获取音频播放地址失败，请稍后重试" }, 502);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);
  try {
    const fetchHeaders = new Headers({
      "User-Agent": UA_COMMON,
      "Referer": REF_NETEASE,
    });
    if (rangeHeader) fetchHeaders.set("Range", rangeHeader);

    const audioResponse = await fetch(streamUrl, {
      signal: controller.signal,
      headers: fetchHeaders,
      redirect: "follow",
    });

    if (!audioResponse.ok) {
      return jsonResponse({ error: "音频资源获取失败" }, 502);
    }

    const contentType = audioResponse.headers.get("content-type") || "audio/mpeg";

    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Content-Type", contentType);
    responseHeaders.set("Cache-Control", "public, max-age=3600");
    responseHeaders.set("Accept-Ranges", audioResponse.headers.get("accept-ranges") || "bytes");
    responseHeaders.set("Content-Length", audioResponse.headers.get("content-length") || "");
    if (audioResponse.headers.get("content-range")) {
      responseHeaders.set("Content-Range", audioResponse.headers.get("content-range")!);
    }

    return new Response(audioResponse.body, {
      status: audioResponse.status === 206 ? 206 : 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.warn("Audio proxy failed", error);
    return jsonResponse({ error: "音频代理请求失败，请稍后重试" }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions();
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);

  if (url.searchParams.get("types") === "audio") {
    return proxyAudioStream(url, request.headers.get("range"));
  }
  return proxyApiRequest(url);
}