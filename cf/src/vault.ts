import { baseHeaders, etagMatches, isOwnPage, jsonResponse, plainResponse } from "./headers";
import type { Env } from "./types";

export const MAX_VAULT_BYTES = 256 << 10; // 256 KiB (vault.ts MAX_BOX)
const DAY_MS = 86_400_000;
const HOLD_DAYS = 730;
const CHANGE_DAYS = 7;
const GRACE_DAYS = 14;
const UNCLAIMABLE = new Set(["name", "player"]);

interface VaultRow {
  token_hash: string;
  rev: string;
  size: number;
  saved_at: number;
  r2_key: string;
  blob: Uint8Array | ArrayBuffer | number[] | null;
  earlier_rev: string | null;
  earlier_size: number | null;
  earlier_saved_at: number | null;
  earlier_r2_key: string | null;
  earlier_blob: Uint8Array | ArrayBuffer | number[] | null;
  updated_at: number;
}

function toBytes(v: Uint8Array | ArrayBuffer | number[] | null | undefined): Uint8Array | null {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v);
  return new Uint8Array(v);
}

interface ClaimRow {
  canon: string;
  name: string;
  owner: string;
  claimed_at: number;
  changed_at: number;
  used_at: number;
  old_name: string | null;
  old_canon: string | null;
  old_until: number | null;
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const tok = auth.slice(7);
  return /^[A-Za-z0-9_-]{43}$/.test(tok) ? tok : null;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(digest);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function tokenHashHex(token: string): Promise<string> {
  const h = await sha256Bytes(new TextEncoder().encode(token));
  return toHex(h);
}

export async function ownerOfToken(token: string): Promise<string> {
  const id = await sha256Bytes(new TextEncoder().encode(token));
  const owner = await sha256Bytes(id);
  return toBase64Url(owner).slice(0, 22);
}

function newRev(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return toHex(b);
}

function formatEtag(rev: string): string {
  return `"${rev}"`;
}

function parseIfMatchRev(header: string | null): string | null {
  if (!header) return null;
  const m = /^"([0-9a-fA-F]{16})"$/.exec(header.trim());
  return m ? m[1].toLowerCase() : null;
}

function applyVaultHeaders(
  headers: Headers,
  rev: string,
  savedAt: number,
  earlierSavedAt: number | null
): void {
  headers.set("etag", formatEtag(rev));
  headers.set("x-vault-saved", String(savedAt));
  if (earlierSavedAt !== null && earlierSavedAt !== undefined) {
    headers.set("x-vault-earlier", String(earlierSavedAt));
  }
}

export async function handleVault(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isOwnPage(request, url)) {
    return plainResponse(403, "Forbidden");
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "PUT" && method !== "DELETE") {
    return plainResponse(405, "Method not allowed", {
      extra: { allow: "GET, HEAD, PUT, DELETE" },
    });
  }

  const token = extractBearerToken(request);
  if (!token) {
    return plainResponse(401, "A keyphrase's token is needed");
  }

  const tHash = await tokenHashHex(token);
  const now = Date.now();

  if (method === "GET" || method === "HEAD") {
    const earlier = url.searchParams.has("earlier");
    const row = await env.DB.prepare("SELECT * FROM vault_saves WHERE token_hash = ?")
      .bind(tHash)
      .first<VaultRow>();

    if (!row) {
      return plainResponse(404, "Not found");
    }

    const verRev = earlier ? row.earlier_rev : row.rev;
    const verSaved = earlier ? row.earlier_saved_at : row.saved_at;
    const verBlob = toBytes(earlier ? row.earlier_blob : row.blob);
    const verEarlier = earlier ? null : row.earlier_saved_at;

    if (!verRev || !verSaved || !verBlob) {
      return plainResponse(404, "Not found");
    }

    const etag = formatEtag(verRev);
    if (!earlier && etagMatches(request.headers.get("if-none-match"), etag)) {
      await env.DB.prepare("UPDATE vault_saves SET updated_at = ? WHERE token_hash = ?")
        .bind(now, tHash)
        .run();
      const h = baseHeaders({ cache: "store", noindex: true });
      applyVaultHeaders(h, verRev, verSaved, verEarlier);
      return new Response(null, { status: 304, headers: h });
    }

    await env.DB.prepare("UPDATE vault_saves SET updated_at = ? WHERE token_hash = ?")
      .bind(now, tHash)
      .run();

    const h = baseHeaders({ cache: "store", noindex: true });
    h.set("content-type", "application/octet-stream");
    h.set("content-length", String(verBlob.byteLength));
    applyVaultHeaders(h, verRev, verSaved, verEarlier);
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: h });
    }
    return new Response(verBlob as unknown as BodyInit, { status: 200, headers: h });
  }

  if (method === "PUT") {
    const ifMatch = request.headers.get("if-match");
    const ifNoneMatch = request.headers.get("if-none-match");

    let cond: { kind: "new" } | { kind: "rev"; rev: string };
    if (ifMatch !== null) {
      const parsed = parseIfMatchRev(ifMatch);
      if (!parsed) {
        return plainResponse(412, "Changed elsewhere");
      }
      cond = { kind: "rev", rev: parsed };
    } else if (ifNoneMatch !== null && ifNoneMatch.trim() === "*") {
      cond = { kind: "new" };
    } else {
      return plainResponse(428, "If-Match or If-None-Match: * is needed");
    }

    const contentLen = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLen) && contentLen > MAX_VAULT_BYTES) {
      return plainResponse(413, "Too large");
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_VAULT_BYTES) {
      return plainResponse(413, "Too large");
    }

    const existing = await env.DB.prepare("SELECT * FROM vault_saves WHERE token_hash = ?")
      .bind(tHash)
      .first<VaultRow>();

    if (cond.kind === "new" && existing) {
      const h = baseHeaders({ cache: "store", noindex: true });
      h.set("content-type", "text/plain; charset=utf-8");
      applyVaultHeaders(h, existing.rev, existing.saved_at, existing.earlier_saved_at);
      return new Response("Changed elsewhere\n", { status: 412, headers: h });
    }

    if (cond.kind === "rev" && (!existing || existing.rev !== cond.rev)) {
      const h = baseHeaders({ cache: "store", noindex: true });
      h.set("content-type", "text/plain; charset=utf-8");
      if (existing) {
        applyVaultHeaders(h, existing.rev, existing.saved_at, existing.earlier_saved_at);
      }
      return new Response("Changed elsewhere\n", { status: 412, headers: h });
    }

    const rev = newRev();
    const r2Key = `d1/${tHash}/${rev}`;

    let earlierRev: string | null = existing?.earlier_rev ?? null;
    let earlierSize: number | null = existing?.earlier_size ?? null;
    let earlierSavedAt: number | null = existing?.earlier_saved_at ?? null;
    let earlierR2Key: string | null = existing?.earlier_r2_key ?? null;
    let earlierBlob: Uint8Array | null = toBytes(existing?.earlier_blob);

    if (existing) {
      const prevDay = Math.floor(existing.saved_at / DAY_MS);
      const curDay = Math.floor(now / DAY_MS);
      if (curDay > prevDay) {
        earlierRev = existing.rev;
        earlierSize = existing.size;
        earlierSavedAt = existing.saved_at;
        earlierR2Key = existing.r2_key;
        earlierBlob = toBytes(existing.blob);
      }
    }

    await env.DB.prepare(
      `INSERT INTO vault_saves
        (token_hash, rev, size, saved_at, r2_key, blob, earlier_rev, earlier_size, earlier_saved_at, earlier_r2_key, earlier_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET
        rev = excluded.rev,
        size = excluded.size,
        saved_at = excluded.saved_at,
        r2_key = excluded.r2_key,
        blob = excluded.blob,
        earlier_rev = excluded.earlier_rev,
        earlier_size = excluded.earlier_size,
        earlier_saved_at = excluded.earlier_saved_at,
        earlier_r2_key = excluded.earlier_r2_key,
        earlier_blob = excluded.earlier_blob,
        updated_at = excluded.updated_at`
    )
      .bind(
        tHash,
        rev,
        body.byteLength,
        now,
        r2Key,
        body,
        earlierRev,
        earlierSize,
        earlierSavedAt,
        earlierR2Key,
        earlierBlob,
        now
      )
      .run();

    // Update name_claims activity timestamp if this owner holds a claim
    const owner = await ownerOfToken(token);
    await env.DB.prepare("UPDATE name_claims SET used_at = ? WHERE owner = ?")
      .bind(now, owner)
      .run();

    const h = baseHeaders({ cache: "store", noindex: true });
    h.set("content-type", "text/plain; charset=utf-8");
    applyVaultHeaders(h, rev, now, earlierSavedAt);
    return new Response("Saved\n", { status: existing ? 200 : 201, headers: h });
  }

  // DELETE
  const existing = await env.DB.prepare("SELECT * FROM vault_saves WHERE token_hash = ?")
    .bind(tHash)
    .first<VaultRow>();
  if (!existing) {
    return plainResponse(404, "Not found");
  }

  await env.DB.prepare("DELETE FROM vault_saves WHERE token_hash = ?").bind(tHash).run();

  const owner = await ownerOfToken(token);
  await env.DB.prepare("DELETE FROM name_claims WHERE owner = ?").bind(owner).run();

  return plainResponse(200, "Deleted");
}

// ---- /names (claimed names backed by D1) ----

export function cleanOnlineName(s: string): string | null {
  let out = "";
  let gap = false;
  for (const ch of s) {
    if (out.length >= 15) break;
    if (!/^[A-Za-z0-9_-]$/.test(ch)) {
      gap = true;
      continue;
    }
    if (gap && out.length > 0 && out.length < 14) {
      out += "_";
    }
    gap = false;
    out += ch;
  }
  if (!out) return null;
  while (out.length < 3) out += "_";
  return out;
}

async function nameStatus(
  db: D1Database,
  rawName: string,
  owner: string | null,
  now: number
): Promise<{ name: string | null; state: string; until?: number }> {
  const cleaned = cleanOnlineName(rawName);
  if (!cleaned) return { name: null, state: "invalid" };
  const canon = cleaned.toLowerCase();
  if (UNCLAIMABLE.has(canon)) return { name: cleaned, state: "default" };

  const active = await db
    .prepare("SELECT * FROM name_claims WHERE canon = ?")
    .bind(canon)
    .first<ClaimRow>();
  const holdMs = HOLD_DAYS * DAY_MS;

  if (active && now - active.used_at <= holdMs) {
    const until = active.used_at + holdMs;
    if (owner && active.owner === owner) {
      return { name: cleaned, state: "yours", until };
    }
    return { name: cleaned, state: "taken" };
  }

  const grace = await db
    .prepare("SELECT * FROM name_claims WHERE old_canon = ? AND old_until > ?")
    .bind(canon, now)
    .first<ClaimRow>();
  if (grace && grace.old_until) {
    if (owner && grace.owner === owner) {
      return { name: cleaned, state: "old", until: grace.old_until };
    }
    return { name: cleaned, state: "taken" };
  }

  return { name: cleaned, state: "free" };
}

export async function handleNames(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isOwnPage(request, url)) {
    return plainResponse(403, "Forbidden");
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return plainResponse(405, "Method not allowed", { extra: { allow: "GET, HEAD, POST" } });
  }

  const token = extractBearerToken(request);
  const owner = token ? await ownerOfToken(token) : null;
  const now = Date.now();
  const holdMs = HOLD_DAYS * DAY_MS;

  if (method === "GET" || method === "HEAD") {
    const rawName = url.searchParams.get("name") ?? "";
    const status = await nameStatus(env.DB, rawName, owner, now);
    const body: Record<string, unknown> = { ...status };
    const alt = url.searchParams.get("alt");
    if (alt !== null) {
      body.alt = await nameStatus(env.DB, alt, owner, now);
    }
    if (owner) {
      const mineRow = await env.DB.prepare("SELECT * FROM name_claims WHERE owner = ?")
        .bind(owner)
        .first<ClaimRow>();
      if (mineRow && now - mineRow.used_at <= holdMs) {
        const nextChange =
          mineRow.changed_at > 0 && now < mineRow.changed_at + CHANGE_DAYS * DAY_MS
            ? mineRow.changed_at + CHANGE_DAYS * DAY_MS
            : 0;
        body.mine = {
          name: mineRow.name,
          until: mineRow.used_at + holdMs,
          next: nextChange,
        };
      }
    }
    if (method === "HEAD") {
      const h = baseHeaders({ cache: "store", noindex: true });
      h.set("content-type", "application/json");
      return new Response(null, { status: 200, headers: h });
    }
    return jsonResponse(200, body);
  }

  // POST /names
  if (!token || !owner) {
    return jsonResponse(401, { error: "keyphrase" });
  }

  let parsed: { name?: unknown };
  try {
    parsed = (await request.json()) as { name?: unknown };
  } catch {
    return jsonResponse(400, { error: "invalid" });
  }
  const rawName = typeof parsed?.name === "string" ? parsed.name : "";
  const st = await nameStatus(env.DB, rawName, owner, now);
  if (st.state === "invalid" || st.state === "default" || st.state === "blocked") {
    return jsonResponse(400, { error: st.state });
  }
  if (st.state === "taken") {
    return jsonResponse(409, { error: "taken" });
  }
  const cleaned = st.name!;
  const canon = cleaned.toLowerCase();

  const existingMine = await env.DB.prepare("SELECT * FROM name_claims WHERE owner = ?")
    .bind(owner)
    .first<ClaimRow>();

  if (existingMine && existingMine.canon === canon) {
    await env.DB.prepare("UPDATE name_claims SET name = ?, used_at = ? WHERE canon = ?")
      .bind(cleaned, now, canon)
      .run();
    const nextChange =
      existingMine.changed_at > 0 && now < existingMine.changed_at + CHANGE_DAYS * DAY_MS
        ? existingMine.changed_at + CHANGE_DAYS * DAY_MS
        : 0;
    return jsonResponse(200, {
      state: "yours",
      mine: { name: cleaned, until: now + holdMs, next: nextChange },
    });
  }

  if (existingMine && existingMine.changed_at > 0 && now < existingMine.changed_at + CHANGE_DAYS * DAY_MS) {
    return jsonResponse(429, { error: "soon", next: existingMine.changed_at + CHANGE_DAYS * DAY_MS });
  }

  const tHash = await tokenHashHex(token);
  const vaultRow = await env.DB.prepare("SELECT token_hash FROM vault_saves WHERE token_hash = ?")
    .bind(tHash)
    .first<{ token_hash: string }>();
  if (!vaultRow) {
    return jsonResponse(404, { error: "keyphrase" });
  }

  const isChange = Boolean(existingMine);
  const changedAt = isChange ? now : 0;
  const oldName = isChange ? existingMine!.name : null;
  const oldCanon = isChange ? existingMine!.canon : null;
  const oldUntil = isChange ? now + GRACE_DAYS * DAY_MS : null;

  if (existingMine) {
    await env.DB.prepare("DELETE FROM name_claims WHERE owner = ?").bind(owner).run();
  }

  await env.DB.prepare(
    `INSERT INTO name_claims (canon, name, owner, claimed_at, changed_at, used_at, old_name, old_canon, old_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(canon) DO UPDATE SET
       name = excluded.name,
       owner = excluded.owner,
       claimed_at = excluded.claimed_at,
       changed_at = excluded.changed_at,
       used_at = excluded.used_at,
       old_name = excluded.old_name,
       old_canon = excluded.old_canon,
       old_until = excluded.old_until`
  )
    .bind(canon, cleaned, owner, now, changedAt, now, oldName, oldCanon, oldUntil)
    .run();

  return jsonResponse(200, {
    state: "yours",
    mine: {
      name: cleaned,
      until: now + holdMs,
      next: isChange ? now + CHANGE_DAYS * DAY_MS : 0,
    },
  });
}
