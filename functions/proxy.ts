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

// 解析音频真实可播地址（区分处理：网易云直接解析 CDN，其他源走 go-music-api）
async function resolveStreamUrl(url: URL): Promise<string | null> {
  const source = url.searchParams.get("source") || "netease";
  const id = url.searchParams.get("id") || "";
  const br = url.searchParams.get("br") || "320";

  if (source === "netease") {
    const resolved = await resolveNeteaseCdnUrl(id, br);
    return resolved;
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

  const upstreamUrl = buildUpstreamUrl(url);
  if (types === "search" && !upstreamUrl.searchParams.get("q")) {
    return jsonResponse({ error: "Missing search keyword" }, 400);
  }

  try {
    const upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl);
    const payload = (await upstreamResponse.json()) as { code?: number; data?: unknown; playlist?: unknown; msg?: string };
    if (payload.code !== undefined && payload.code !== 200) {
      return jsonResponse({ error: payload.msg || "音乐接口返回错误" }, 502);
    }
    if (types === "search") return jsonResponse((payload.data as { songs?: unknown[] })?.songs || []);
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