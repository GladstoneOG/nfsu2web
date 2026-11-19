import {
  applySecurityHeaders,
  baseHeaders,
  decodeSafePathname,
  etagMatches,
  isDevOnlyPath,
  isOwnPage,
  jsonResponse,
  parseByteRange,
  plainResponse,
  resolveGamePath,
} from "./headers";
import { RoomSwitchDO } from "./room-do";
import { BLOCK, BLOCKS_MAX, ROBOTS_TXT, type Env } from "./types";
import { handleNames, handleVault } from "./vault";

export { RoomSwitchDO };

interface PkgEntry {
  p: string;  // canonical relative path inside /_data/
  s: number;  // total uncompressed file size in bytes
  c?: number; // number of chunkSize parts (.part000 .. .partNNN) if chunked
}

interface PkgIndex {
  chunkSize: number;
  files: Record<string, PkgEntry>; // keyed by relPath.toLowerCase()
}

let cachedIndex: PkgIndex | null = null;
let cachedGameJson: { text: string; module?: string; etag: string } | null = null;

function encodePath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

async function fetchAsset(env: Env, origin: string, path: string, range?: string): Promise<Response> {
  const headers = new Headers();
  if (range) headers.set("range", range);
  return env.ASSETS.fetch(new Request(new URL(path, origin), { method: "GET", headers }));
}

async function getPkgIndex(env: Env, origin: string): Promise<PkgIndex | null> {
  if (cachedIndex) return cachedIndex;
  const res = await fetchAsset(env, origin, "/_pkg_index.json");
  if (!res.ok) return null;
  const parsed = (await res.json()) as PkgIndex;
  if (parsed && typeof parsed.chunkSize === "number" && parsed.files) {
    cachedIndex = parsed;
    return parsed;
  }
  return null;
}

async function lookupFile(env: Env, origin: string, relPath: string): Promise<{ idx: PkgIndex; entry: PkgEntry } | null> {
  const idx = await getPkgIndex(env, origin);
  if (!idx) return null;
  const entry = idx.files[relPath.toLowerCase()];
  if (!entry) return null;
  return { idx, entry };
}

/** Read exact inclusive byte range [start, end] of a single unchunked static asset. */
async function fetchSinglePartSlice(
  env: Env,
  origin: string,
  assetPath: string,
  start: number,
  end: number,
  partLen: number
): Promise<Response | null> {
  const isFull = start === 0 && end >= partLen - 1;
  const res = await fetchAsset(env, origin, assetPath, isFull ? undefined : `bytes=${start}-${end}`);
  if (!res.ok && res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (isFull || res.status === 206) {
    return res;
  }
  // Defensive fallback if an ASSETS mock ignores Range and returns 200 full body
  const full = new Uint8Array(await res.arrayBuffer());
  const slice = full.subarray(start, Math.min(full.byteLength, end + 1));
  return new Response(slice, { status: 206 });
}

/** Read inclusive byte range [start, end] across either an unchunked file or 16 MiB chunks. */
async function readEntryRange(
  env: Env,
  origin: string,
  entry: PkgEntry,
  chunkSize: number,
  start: number,
  end: number
): Promise<ReadableStream<Uint8Array> | Uint8Array | null> {
  if (!entry.c || entry.c <= 1) {
    const res = await fetchSinglePartSlice(env, origin, `/_data/${encodePath(entry.p)}`, start, end, entry.s);
    if (!res) return null;
    return res.body ?? new Uint8Array(await res.arrayBuffer());
  }

  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor(end / chunkSize);

  if (firstChunk === lastChunk) {
    const chunkStart = firstChunk * chunkSize;
    const chunkLen = Math.min(chunkSize, entry.s - chunkStart);
    const localStart = start - chunkStart;
    const localEnd = end - chunkStart;
    const res = await fetchSinglePartSlice(
      env,
      origin,
      `/_data/${encodePath(entry.p)}.part${pad3(firstChunk)}`,
      localStart,
      localEnd,
      chunkLen
    );
    if (!res) return null;
    return res.body ?? new Uint8Array(await res.arrayBuffer());
  }

  // Range spans multiple 16 MiB chunks -> stream parts sequentially to keep Worker memory low
  const totalLen = end - start + 1;
  if (totalLen <= 8 * BLOCK) {
    const out = new Uint8Array(totalLen);
    let writeAt = 0;
    for (let ci = firstChunk; ci <= lastChunk; ci++) {
      const chunkStart = ci * chunkSize;
      const chunkLen = Math.min(chunkSize, entry.s - chunkStart);
      const localStart = Math.max(0, start - chunkStart);
      const localEnd = Math.min(chunkLen - 1, end - chunkStart);
      const res = await fetchSinglePartSlice(
        env,
        origin,
        `/_data/${encodePath(entry.p)}.part${pad3(ci)}`,
        localStart,
        localEnd,
        chunkLen
      );
      if (!res) return null;
      const partBytes = new Uint8Array(await res.arrayBuffer());
      out.set(partBytes, writeAt);
      writeAt += partBytes.byteLength;
    }
    return out;
  }

  let ci = firstChunk;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ci > lastChunk) {
        controller.close();
        return;
      }
      const chunkStart = ci * chunkSize;
      const chunkLen = Math.min(chunkSize, entry.s - chunkStart);
      const localStart = Math.max(0, start - chunkStart);
      const localEnd = Math.min(chunkLen - 1, end - chunkStart);
      const partIndex = ci++;
      const res = await fetchSinglePartSlice(
        env,
        origin,
        `/_data/${encodePath(entry.p)}.part${pad3(partIndex)}`,
        localStart,
        localEnd,
        chunkLen
      );
      if (!res) {
        controller.error(new Error(`Missing chunk ${partIndex}`));
        return;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      controller.enqueue(bytes);
    },
  });
}

async function getGameJsonMeta(env: Env, origin: string) {
  if (cachedGameJson) return cachedGameJson;
  const res = await fetchAsset(env, origin, "/_wasm/nfsu2.json");
  if (!res.ok) return null;
  const text = await res.text();
  let mod: string | undefined;
  try {
    const parsed = JSON.parse(text) as { module?: unknown; rev?: unknown };
    if (typeof parsed.module === "string" && parsed.module) mod = parsed.module;
    else if (typeof parsed.rev === "string" && parsed.rev) mod = parsed.rev;
  } catch {
    // ignore
  }
  cachedGameJson = { text, module: mod, etag: res.headers.get("etag") || `"${mod ?? text.length}"` };
  return cachedGameJson;
}

async function handleGameJson(request: Request, url: URL, env: Env): Promise<Response> {
  const info = await getGameJsonMeta(env, url.origin);
  if (!info) {
    return plainResponse(404, "Not found");
  }
  const bytes = new TextEncoder().encode(info.text);
  const h = baseHeaders({ cache: "store", noindex: true });
  h.set("content-type", "application/json");
  h.set("content-length", String(bytes.byteLength));
  h.set("etag", info.etag);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: h });
  }
  return new Response(bytes, { status: 200, headers: h });
}

async function handleGameWasm(request: Request, url: URL, env: Env): Promise<Response> {
  const v = url.searchParams.get("v");
  const info = await getGameJsonMeta(env, url.origin);
  const expectedModule = info?.module ?? null;
  if (v !== null && expectedModule && v !== expectedModule) {
    return plainResponse(409, "The game module changed: ask /game.json again");
  }

  // nfsu2.wasm is staged brotli-compressed (~8.15 MiB) under /_wasm/nfsu2.wasm.bin
  const brRes = await fetchAsset(env, url.origin, "/_wasm/nfsu2.wasm.bin");
  if (!brRes.ok) {
    await brRes.body?.cancel().catch(() => {});
    return plainResponse(404, "Not found");
  }

  const etag = brRes.headers.get("etag") || `"br-${expectedModule ?? "v1"}"`;
  const cacheKind = v !== null && (!expectedModule || v === expectedModule) ? "immutable" : "revalidate";
  const h = baseHeaders({ cache: cacheKind, noindex: true });
  h.set("content-type", "application/wasm");
  h.set("etag", etag);
  h.set("vary", "accept-encoding");
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    await brRes.body?.cancel().catch(() => {});
    return new Response(null, { status: 304, headers: h });
  }

  h.set("content-encoding", "br");
  const cl = brRes.headers.get("content-length");
  if (cl) h.set("content-length", cl);

  if (request.method === "HEAD") {
    await brRes.body?.cancel().catch(() => {});
    return new Response(null, { status: 200, headers: h });
  }
  return new Response(brRes.body, {
    status: 200,
    headers: h,
    encodeBody: "manual",
  } as ResponseInit);
}

async function handleManifest(request: Request, url: URL, env: Env): Promise<Response> {
  const res = await fetchAsset(env, url.origin, "/_data_manifest.json");
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return plainResponse(404, "Not found");
  }
  const etag = res.headers.get("etag") || `"manifest-v1"`;
  const h = baseHeaders({ cache: "revalidate", noindex: true });
  h.set("content-type", "application/json");
  h.set("etag", etag);
  h.set("vary", "accept-encoding");
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: 304, headers: h });
  }
  const cl = res.headers.get("content-length");
  if (cl) h.set("content-length", cl);
  if (request.method === "HEAD") {
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: 200, headers: h });
  }
  return new Response(res.body, { status: 200, headers: h });
}

async function handleDataBlocks(
  request: Request,
  url: URL,
  rest: string,
  env: Env
): Promise<Response> {
  const sub = rest.startsWith("/v2/") ? rest.slice(4) : rest.slice(1);
  const relPath = resolveGamePath(sub);
  if (!relPath) {
    return plainResponse(404, "Not found");
  }

  const oParam = url.searchParams.get("o");
  const lParam = url.searchParams.get("l");
  let offset = 0;
  let wantLen = 0;

  if (oParam !== null) {
    if (!/^\d{1,12}$/.test(oParam) || !lParam || !/^\d{1,8}$/.test(lParam)) {
      return plainResponse(400, "Bad request");
    }
    offset = Number(oParam);
    wantLen = Number(lParam);
    if (wantLen < 1 || wantLen > BLOCK * BLOCKS_MAX) {
      return plainResponse(400, "Bad request");
    }
  } else {
    const bParam = url.searchParams.get("b");
    const nParam = url.searchParams.get("n");
    if (!bParam || !nParam || !/^\d{1,7}$/.test(bParam) || !/^\d{1,2}$/.test(nParam)) {
      return plainResponse(400, "Bad request");
    }
    const b = Number(bParam);
    const n = Number(nParam);
    if (n < 1 || n > BLOCKS_MAX) {
      return plainResponse(400, "Bad request");
    }
    offset = b * BLOCK;
    wantLen = n * BLOCK;
  }

  const found = await lookupFile(env, url.origin, relPath);
  if (!found) {
    return plainResponse(404, "Not found");
  }
  const { idx, entry } = found;
  if (offset >= entry.s) {
    return plainResponse(416, "Range not satisfiable");
  }

  const actualLen = Math.min(wantLen, entry.s - offset);
  const versioned = url.searchParams.has("m") && url.searchParams.has("s");
  const h = baseHeaders({ cache: versioned ? "immutable" : "store", edgeKeep: versioned, noindex: true });
  h.set("content-type", "application/octet-stream");
  h.set("vary", "accept-encoding");
  h.set("content-length", String(actualLen));

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: h });
  }

  const body = await readEntryRange(env, url.origin, entry, idx.chunkSize, offset, offset + actualLen - 1);
  if (!body) {
    return plainResponse(404, "Not found");
  }
  return new Response(body as BodyInit, { status: 200, headers: h });
}

async function handleDataFile(request: Request, url: URL, rest: string, env: Env): Promise<Response> {
  const relPath = resolveGamePath(rest.slice(1));
  if (!relPath) {
    return plainResponse(404, "Not found");
  }

  const found = await lookupFile(env, url.origin, relPath);
  if (!found) {
    return plainResponse(404, "Not found");
  }
  const { idx, entry } = found;
  const etag = `"${entry.p.length}-${entry.s}"`;
  const h = baseHeaders({ cache: "store", noindex: true });
  h.set("content-type", "application/octet-stream");
  h.set("accept-ranges", "bytes");
  h.set("etag", etag);

  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: h });
  }

  const parsedRange = parseByteRange(request.headers.get("range"), entry.s);
  if (parsedRange === "invalid") {
    h.set("content-range", `bytes */${entry.s}`);
    h.set("content-length", "0");
    return new Response(null, { status: 416, headers: h });
  }

  if (parsedRange) {
    const len = parsedRange.end - parsedRange.start + 1;
    h.set("content-range", `bytes ${parsedRange.start}-${parsedRange.end}/${entry.s}`);
    h.set("content-length", String(len));
    if (request.method === "HEAD") {
      return new Response(null, { status: 206, headers: h });
    }
    const body = await readEntryRange(env, url.origin, entry, idx.chunkSize, parsedRange.start, parsedRange.end);
    if (!body) return plainResponse(404, "Not found");
    return new Response(body as BodyInit, { status: 206, headers: h });
  }

  h.set("content-length", String(entry.s));
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: h });
  }
  const body = await readEntryRange(env, url.origin, entry, idx.chunkSize, 0, Math.max(0, entry.s - 1));
  if (!body) return plainResponse(404, "Not found");
  return new Response(body as BodyInit, { status: 200, headers: h });
}

async function handleTurnCredentials(request: Request, env: Env): Promise<Response> {
  const stunOnly = [{ urls: "stun:stun.cloudflare.com:3478" }];
  let iceServers: unknown[] = stunOnly;

  if (env.CF_TURN_TOKEN_ID && env.CF_TURN_API_TOKEN) {
    try {
      const apiUrl = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
        env.CF_TURN_TOKEN_ID
      )}/credentials/generate-ice-servers`;
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (res.ok) {
        const data = (await res.json()) as { iceServers?: unknown };
        if (Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
          iceServers = [...stunOnly, ...data.iceServers];
        } else if (data?.iceServers && typeof data.iceServers === "object") {
          iceServers = [...stunOnly, data.iceServers];
        }
      }
    } catch {
      // Fall back gracefully to STUN-only
    }
  }

  if (request.method === "HEAD") {
    const h = baseHeaders({ cache: "store", noindex: true });
    h.set("content-type", "application/json");
    return new Response(null, { status: 200, headers: h });
  }
  return jsonResponse(200, { iceServers });
}

function shardStub(env: Env, shardName: string | null): DurableObjectStub {
  const clean = shardName && shardName.trim() ? shardName.trim().slice(0, 64) : "main";
  return env.ROOM_SWITCH.get(env.ROOM_SWITCH.idFromName(clean));
}

async function handlePlayers(request: Request, url: URL, env: Env): Promise<Response> {
  const stub = shardStub(env, url.searchParams.get("shard"));
  const res = await stub.fetch(`https://do.internal/internal/players${url.search}`, {
    method: "GET",
  });
  const body = await res.text();
  const h = baseHeaders({ cache: "store", noindex: true });
  h.set("content-type", "application/json");
  h.set("content-length", String(new TextEncoder().encode(body).byteLength));
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: h });
  }
  return new Response(body, { status: 200, headers: h });
}

async function handleLan(request: Request, url: URL, env: Env): Promise<Response> {
  const own = isOwnPage(request, url);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (!own) {
      return plainResponse(403, "Forbidden");
    }
    const stub = shardStub(env, url.searchParams.get("room"));
    return stub.fetch(request);
  }

  const body = JSON.stringify({ lan: own ? "ok" : "page" });
  const h = baseHeaders({ cache: "store", noindex: true });
  h.set("content-type", "application/json");
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: h });
  }
  return new Response(body, { status: 200, headers: h });
}

async function handleAssets(request: Request, pathname: string, env: Env): Promise<Response> {
  if (
    isDevOnlyPath(pathname) ||
    pathname === "/_pkg_index.json" ||
    pathname === "/_data_manifest.json" ||
    pathname.startsWith("/_data/") ||
    pathname.startsWith("/_wasm/")
  ) {
    return plainResponse(404, "Not found");
  }
  if (!env.ASSETS) {
    return plainResponse(404, "Not found");
  }
  const assetRes = await env.ASSETS.fetch(request);
  if (assetRes.status === 404) {
    return plainResponse(404, "Not found");
  }
  const headers = new Headers(assetRes.headers);
  const isIndex = pathname === "/" || pathname === "/index.html";
  applySecurityHeaders(headers, { noindex: !isIndex });
  if (pathname === "/" || pathname.endsWith(".html")) {
    headers.set("cache-control", "private, no-store, no-transform");
  } else if (!headers.has("cache-control")) {
    headers.set("cache-control", "private, no-cache, no-transform");
  }
  return new Response(assetRes.body, {
    status: assetRes.status,
    statusText: assetRes.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = decodeSafePathname(url.pathname);
    if (!pathname) {
      return plainResponse(400, "Bad request");
    }

    if (pathname === "/vault" || pathname.startsWith("/vault/")) {
      return handleVault(request, url, env);
    }

    if (pathname === "/names") {
      return handleNames(request, url, env);
    }

    if (pathname === "/lan") {
      return handleLan(request, url, env);
    }

    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return plainResponse(405, "Method not allowed", {
        extra: { allow: "GET, HEAD" },
      });
    }

    if (pathname === "/data-manifest") {
      return handleManifest(request, url, env);
    }

    if (pathname.startsWith("/data-blocks/")) {
      return handleDataBlocks(request, url, pathname.slice("/data-blocks".length), env);
    }

    if (pathname.startsWith("/data/")) {
      return handleDataFile(request, url, pathname.slice("/data".length), env);
    }

    if (pathname === "/game.wasm") {
      return handleGameWasm(request, url, env);
    }

    if (pathname === "/game.json") {
      return handleGameJson(request, url, env);
    }

    if (pathname === "/players") {
      return handlePlayers(request, url, env);
    }

    if (pathname === "/turn-credentials") {
      return handleTurnCredentials(request, env);
    }

    if (pathname === "/country") {
      const cfCountry = (request as Request & { cf?: { country?: string } }).cf?.country;
      const raw = cfCountry ?? request.headers.get("cf-ipcountry");
      const country = raw && /^[A-Za-z]{2}$/.test(raw) ? raw.toLowerCase() : null;
      return jsonResponse(200, { country });
    }

    if (pathname === "/seen") {
      return new Response(null, {
        status: 204,
        headers: baseHeaders({ cache: "store", noindex: true }),
      });
    }

    if (pathname === "/robots.txt") {
      return plainResponse(200, ROBOTS_TXT.trimEnd(), {
        cache: "revalidate",
        noindex: false,
      });
    }

    return handleAssets(request, pathname, env);
  },
};
