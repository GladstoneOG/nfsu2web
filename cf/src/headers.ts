import { GAME_ENTRIES } from "./types";

export type CacheKind = "store" | "revalidate" | "immutable";

export const EDGE_KEEP = "public, max-age=31536000, immutable";

export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; " +
  "img-src 'self' data: blob:; style-src 'self'; font-src 'self'; media-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'";

export const PERMISSIONS_POLICY =
  "gamepad=(self), fullscreen=(self), keyboard-map=(self), autoplay=(self), cross-origin-isolated=(self), " +
  "screen-wake-lock=(self), accelerometer=(self), gyroscope=(self), hid=(self), " +
  "bluetooth=(), browsing-topics=(), camera=(), clipboard-read=(), display-capture=(), " +
  "encrypted-media=(), geolocation=(), idle-detection=(), local-fonts=(), " +
  "magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), " +
  "serial=(), usb=(), window-management=(), xr-spatial-tracking=()";

export function applySecurityHeaders(headers: Headers, opts: { noindex?: boolean; hsts?: boolean } = {}): void {
  const noindex = opts.noindex ?? true;
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("content-security-policy", CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", PERMISSIONS_POLICY);
  headers.set("x-robots-tag", noindex ? "noindex, nofollow" : "index, follow");
  if (opts.hsts) {
    headers.set("strict-transport-security", "max-age=31536000");
  }
}

export function applyCacheHeaders(headers: Headers, kind: CacheKind, edgeKeep = false): void {
  if (kind === "immutable") {
    headers.set("cache-control", `${EDGE_KEEP}, no-transform`);
    headers.set("cdn-cache-control", EDGE_KEEP);
    headers.set("cloudflare-cdn-cache-control", EDGE_KEEP);
    return;
  }
  headers.set(
    "cache-control",
    kind === "revalidate" ? "private, no-cache, no-transform" : "private, no-store, no-transform"
  );
  const cdn = edgeKeep ? EDGE_KEEP : "no-store";
  headers.set("cdn-cache-control", cdn);
  headers.set("cloudflare-cdn-cache-control", cdn);
}

export function baseHeaders(
  opts: { cache?: CacheKind; edgeKeep?: boolean; noindex?: boolean; hsts?: boolean } = {}
): Headers {
  const h = new Headers();
  applySecurityHeaders(h, { noindex: opts.noindex, hsts: opts.hsts });
  applyCacheHeaders(h, opts.cache ?? "store", opts.edgeKeep ?? false);
  return h;
}

export function plainResponse(
  status: number,
  text: string,
  opts: { cache?: CacheKind; extra?: Record<string, string>; noindex?: boolean } = {}
): Response {
  const h = baseHeaders({ cache: opts.cache ?? "store", noindex: opts.noindex ?? true });
  h.set("content-type", "text/plain; charset=utf-8");
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      h.set(k, v);
    }
  }
  return new Response(`${text}\n`, { status, headers: h });
}

export function jsonResponse(
  status: number,
  data: unknown,
  opts: { cache?: CacheKind; extra?: Record<string, string> } = {}
): Response {
  const body = JSON.stringify(data);
  const h = baseHeaders({ cache: opts.cache ?? "store", noindex: true });
  h.set("content-type", "application/json");
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      h.set(k, v);
    }
  }
  return new Response(body, { status, headers: h });
}

/** `/\bword\b/.test(s)` matching server-rs has_word */
export function hasWord(headerValue: string | null, word: string): boolean {
  if (!headerValue) return false;
  return new RegExp(`\\b${word}\\b`).test(headerValue);
}

/** Match strong/weak ETag list in If-None-Match against server ETag */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const norm = (t: string) => t.trim().replace(/^W\//, "");
  const target = norm(etag);
  return trimmed.split(",").some((part) => norm(part) === target);
}

/** Validate and decode a request pathname safely (matching server-rs mod.rs). */
export function decodeSafePathname(rawPathname: string): string | null {
  const lower = rawPathname.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c")) {
    return null;
  }
  let p: string;
  try {
    p = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (p.includes("//") || p.includes("\\")) {
    return null;
  }
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      return null;
    }
  }
  return p;
}

/** Resolve a relative game path against GAME_ENTRIES and dot-segment rules. */
export function resolveGamePath(subPath: string): string | null {
  const clean = subPath.replace(/^\/+/, "");
  if (!clean) return null;
  const segs = clean.split("/");
  if (segs.some((s) => !s || s.startsWith("."))) {
    return null;
  }
  if (!GAME_ENTRIES.has(segs[0].toLowerCase())) {
    return null;
  }
  return segs.join("/");
}

/** Check if a static asset path is dev-only (/test, /tests, *.map). */
export function isDevOnlyPath(pathname: string): boolean {
  const n = pathname.normalize("NFKC").toLowerCase();
  return (
    n === "/test" ||
    n.startsWith("/test/") ||
    n === "/tests" ||
    n.startsWith("/tests/") ||
    n.endsWith(".map")
  );
}

/** Check same-origin guard for mutating/private APIs like /vault and /names. */
export function isOwnPage(request: Request, url: URL): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === url.host.toLowerCase();
  } catch {
    return false;
  }
}

/** Parse HTTP Range: bytes=a-b | bytes=a- | bytes=-n */
export function parseByteRange(
  rangeHeader: string | null,
  size: number
): { start: number; end: number } | "invalid" | null {
  if (!rangeHeader) return null;
  const trimmed = rangeHeader.trim();
  if (!trimmed) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!m) return null; // non-standard/multi-range falls back to 200 full body like files.rs
  const [, r1, r2] = m;
  if (!r1 && !r2) return null;
  if (size === 0) return "invalid";
  let start: number;
  let end: number;
  if (!r1) {
    const suffix = Number(r2);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(r1);
    end = r2 ? Math.min(Number(r2), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end };
}
