const API_BASE_URL = "https://go-music-api.luoxi.workers.dev";
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "expires"];
const UPSTREAM_TIMEOUT_MS = 12000;
const UPSTREAM_RETRIES = 2;
const AUDIO_TIMEOUT_MS = 30000;
const ALLOWED_TYPES = ["search", "url", "lyric", "pic", "audio", "playlist"];

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
        headers: { "Accept": "application/json", "User-Agent": "Solara-Music-Player/1.0" },
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
    const payload = await upstreamResponse.json() as { code?: number; data?: unknown; playlist?: unknown; msg?: string };
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

async function proxyAudioStream(url: URL): Promise<Response> {
  try {
    const upstreamUrl = buildUpstreamUrl(url);
    const apiResponse = await fetchUpstreamWithRetry(upstreamUrl);
    const payload = await apiResponse.json() as { code?: number; data?: { url?: string }; msg?: string };

    if (payload.code !== undefined && payload.code !== 200) {
      return jsonResponse({ error: payload.msg || "获取音频地址失败" }, 502);
    }

    const audioUrl = payload.data?.url;
    if (!audioUrl) {
      return jsonResponse({ error: "无法获取音频播放地址" }, 404);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUDIO_TIMEOUT_MS);
    try {
      const audioResponse = await fetch(audioUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "Solara-Music-Player/1.0" },
        redirect: "follow",
      });

      if (!audioResponse.ok) {
        return jsonResponse({ error: "音频资源获取失败" }, 502);
      }

      const contentType = audioResponse.headers.get("content-type") || "audio/mpeg";
      const contentLength = audioResponse.headers.get("content-length");

      const responseHeaders = new Headers();
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Content-Type", contentType);
      responseHeaders.set("Cache-Control", "public, max-age=3600");
      if (contentLength) responseHeaders.set("Content-Length", contentLength);

      return new Response(audioResponse.body, {
        status: 200,
        headers: responseHeaders,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn("Audio proxy failed", error);
    return jsonResponse({ error: "音频代理请求失败" }, 502);
  }
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions();
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  return proxyApiRequest(new URL(request.url));
}
