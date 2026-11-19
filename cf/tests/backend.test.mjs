import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(CF_ROOT, "src");

// Register synchronous TypeScript + cloudflare:workers loader hooks for Node 24
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "cf-mock:workers",
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      !specifier.endsWith(".mjs")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const tsPath = path.resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(tsPath)) {
        return { shortCircuit: true, url: pathToFileURL(tsPath).href };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "cf-mock:workers") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          export class DurableObject {
            constructor(ctx, env) {
              this.ctx = ctx;
              this.env = env;
            }
          }
        `,
      };
    }
    if (url.endsWith(".ts")) {
      const filePath = fileURLToPath(url);
      const raw = fs.readFileSync(filePath, "utf8");
      const out = ts.transpileModule(raw, {
        fileName: filePath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
      });
      return {
        shortCircuit: true,
        format: "module",
        source: out.outputText,
      };
    }
    return nextLoad(url, context);
  },
});

// ---- Mock Cloudflare Environment ----

class MockAssetsFetcher {
  constructor() {
    this.map = new Map();
    this.put("/", "<!doctype html><html>NFSU2</html>", "text/html; charset=utf-8");
    this.put("/index.html", "<!doctype html><html>NFSU2</html>", "text/html; charset=utf-8");
    this.put("/main.js", "console.log('nfsu2');", "text/javascript; charset=utf-8");
  }
  put(pathname, value, contentType = "application/octet-stream") {
    const buf =
      value instanceof Uint8Array
        ? new Uint8Array(value)
        : typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value);
    const etag = `"${buf.byteLength}-${Buffer.from(buf).subarray(0, 8).toString("hex")}"`;
    this.map.set(pathname, { buf, etag, contentType });
  }
  async fetch(input) {
    const req = input instanceof Request ? input : new Request(input);
    const u = new URL(req.url);
    const key = decodeURIComponent(u.pathname);
    const e = this.map.get(key) ?? this.map.get(u.pathname);
    if (!e) {
      return new Response("Not found", { status: 404 });
    }
    const rangeHdr = req.headers.get("range");
    if (rangeHdr) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(rangeHdr.trim());
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), e.buf.byteLength - 1);
        const slice = e.buf.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "content-type": e.contentType,
            "content-length": String(slice.byteLength),
            "content-range": `bytes ${start}-${end}/${e.buf.byteLength}`,
            etag: e.etag,
          },
        });
      }
    }
    return new Response(e.buf, {
      status: 200,
      headers: {
        "content-type": e.contentType,
        "content-length": String(e.buf.byteLength),
        etag: e.etag,
      },
    });
  }
}

class MockD1Database {
  constructor(schemaSql) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(schemaSql);
  }
  prepare(sql) {
    const db = this.db;
    return {
      bind(...args) {
        const cleanArgs = args.map((a) => (a === undefined ? null : a));
        return {
          async first() {
            const stmt = db.prepare(sql);
            return stmt.get(...cleanArgs) ?? null;
          },
          async all() {
            const stmt = db.prepare(sql);
            return { results: stmt.all(...cleanArgs), success: true };
          },
          async run() {
            const stmt = db.prepare(sql);
            const info = stmt.run(...cleanArgs);
            return { success: true, meta: { changes: info.changes } };
          },
        };
      },
    };
  }
}

class MockWebSocket {
  constructor() {
    this.peer = null;
    this.attachment = null;
    this.messages = [];
    this.closed = null;
    this.readyState = 1;
    this._onMessage = null;
    this._onClose = null;
  }
  serializeAttachment(v) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment ? structuredClone(this.attachment) : null;
  }
  send(data) {
    if (this.readyState !== 1) return;
    const payload =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
    if (this.peer._onMessage) {
      this.peer._onMessage(payload);
    } else {
      this.peer.messages.push(payload);
    }
  }
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    if (this.peer && this.peer.readyState === 1) {
      this.peer.readyState = 3;
      this.peer.closed = { code, reason };
      this.peer._onClose?.(code, reason);
    }
  }
}

function createMockWebSocketPair() {
  const client = new MockWebSocket();
  const server = new MockWebSocket();
  client.peer = server;
  server.peer = client;
  return { 0: client, 1: server };
}

class MockDurableObjectNamespace {
  constructor(DoClass, env) {
    this.DoClass = DoClass;
    this.env = env;
    this.instances = new Map();
  }
  idFromName(name) {
    return { name, toString: () => name };
  }
  get(id) {
    let inst = this.instances.get(id.name);
    if (!inst) {
      const sqlite = new DatabaseSync(":memory:");
      const accepted = new Set();
      const ctx = {
        storage: {
          sql: {
            exec(query, ...params) {
              if (params.length === 0) {
                if (query.trim().toUpperCase().startsWith("SELECT")) {
                  const rows = sqlite.prepare(query).all();
                  return { toArray: () => rows };
                }
                sqlite.exec(query);
                return { toArray: () => [] };
              }
              const stmt = sqlite.prepare(query);
              if (query.trim().toUpperCase().startsWith("SELECT")) {
                const rows = stmt.all(...params);
                return { toArray: () => rows };
              }
              stmt.run(...params);
              return { toArray: () => [] };
            },
          },
        },
        acceptWebSocket(ws) {
          accepted.add(ws);
          ws._onMessage = (msg) => inst.webSocketMessage(ws, msg);
          ws._onClose = (code, reason) => {
            accepted.delete(ws);
            inst.webSocketClose(ws, code, reason, true);
          };
          const origClose = ws.close.bind(ws);
          ws.close = (code = 1000, reason = "") => {
            accepted.delete(ws);
            origClose(code, reason);
          };
        },
        getWebSockets() {
          return Array.from(accepted);
        },
      };
      inst = new this.DoClass(ctx, this.env);
      this.instances.set(id.name, inst);
    }
    return {
      async fetch(input, init) {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const pair = createMockWebSocketPair();
          inst.ctx.acceptWebSocket(pair[1]);
          inst.saveAtt?.(pair[1], {
            vip: 0,
            vipStr: "",
            name: "player",
            tokenHash: "",
            hello: false,
            lan: false,
            udp: 0,
            bundle: true,
          });
          // Store client socket on a non-standard property since Node's Response rejects status 101
          const res = new Response(null, { status: 200 });
          res.webSocket = pair[0];
          res.upgraded101 = true;
          return res;
        }
        return inst.fetch(req);
      },
    };
  }
}

const schemaSql =
  fs.readFileSync(path.join(CF_ROOT, "migrations", "0001_init.sql"), "utf8") +
  "\n" +
  fs.readFileSync(path.join(CF_ROOT, "migrations", "0002_vault_blob.sql"), "utf8");
const workerMod = await import(pathToFileURL(path.join(SRC_DIR, "index.ts")).href);
const worker = workerMod.default;
const { RoomSwitchDO, crc32, ROAM_HUB_VIP, BROADCAST_VIP } = await import(
  pathToFileURL(path.join(SRC_DIR, "room-do.ts")).href
);

function makeEnv(overrides = {}) {
  const assets = new MockAssetsFetcher();
  const db = new MockD1Database(schemaSql);
  const env = {
    DB: db,
    MAX_PEERS: "32",
    ASSETS: assets,
    ...overrides,
  };
  env.ROOM_SWITCH = new MockDurableObjectNamespace(RoomSwitchDO, env);
  return env;
}

describe("Cloudflare Free-Tier Serverless Backend", () => {
  test("COOP/COEP/CORP isolation headers and dev-only guard on static assets", async () => {
    const env = makeEnv();

    const htmlRes = await worker.fetch(new Request("https://nfsu2.example/"), env);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(htmlRes.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(htmlRes.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(htmlRes.headers.get("x-robots-tag"), "index, follow");
    assert.match(htmlRes.headers.get("cache-control"), /no-store/);

    const jsRes = await worker.fetch(new Request("https://nfsu2.example/main.js"), env);
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(jsRes.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(jsRes.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(jsRes.headers.get("x-robots-tag"), "noindex, nofollow");

    const mapRes = await worker.fetch(new Request("https://nfsu2.example/main.js.map"), env);
    assert.equal(mapRes.status, 404);
    const testRes = await worker.fetch(new Request("https://nfsu2.example/test/play.html"), env);
    assert.equal(testRes.status, 404);
  });

  test("/game.json and /game.wasm (brotli via ASSETS, version check, 304, internal path hidden)", async () => {
    const env = makeEnv();
    const rawWasm = new TextEncoder().encode("0061736d-fake-wasm-payload-for-testing-brotli-assets");
    const brWasm = zlib.brotliCompressSync(rawWasm);
    env.ASSETS.put("/_wasm/nfsu2.wasm.bin", brWasm, "application/octet-stream");
    env.ASSETS.put(
      "/_wasm/nfsu2.json",
      JSON.stringify({ pages: 16384, maxPages: 65536, guestEnd: 671088640, rev: "abc", size: rawWasm.byteLength, opt: "-O3", module: "modHash123" }),
      "application/json"
    );

    // Internal /_wasm/* path must not be exposed directly
    const directWasm = await worker.fetch(new Request("https://nfsu2.example/_wasm/nfsu2.wasm.bin"), env);
    assert.equal(directWasm.status, 404);

    const jsonRes = await worker.fetch(new Request("https://nfsu2.example/game.json"), env);
    assert.equal(jsonRes.status, 200);
    const info = await jsonRes.json();
    assert.equal(info.module, "modHash123");

    const mismatch = await worker.fetch(new Request("https://nfsu2.example/game.wasm?v=oldHash"), env);
    assert.equal(mismatch.status, 409);

    const brRes = await worker.fetch(
      new Request("https://nfsu2.example/game.wasm?v=modHash123", {
        headers: { "accept-encoding": "gzip, br" },
      }),
      env
    );
    assert.equal(brRes.status, 200);
    assert.equal(brRes.headers.get("content-type"), "application/wasm");
    assert.equal(brRes.headers.get("content-encoding"), "br");
    assert.equal(brRes.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.match(brRes.headers.get("cache-control"), /immutable/);
    const etag = brRes.headers.get("etag");
    assert.ok(etag);
    const gotBr = new Uint8Array(await brRes.arrayBuffer());
    assert.deepEqual(zlib.brotliDecompressSync(gotBr), Buffer.from(rawWasm));

    const notMod = await worker.fetch(
      new Request("https://nfsu2.example/game.wasm?v=modHash123", {
        headers: { "if-none-match": etag },
      }),
      env
    );
    assert.equal(notMod.status, 304);
  });

  test("/data-manifest, /data-blocks/v2, /data range, chunked >16MiB stitching, and GAME_ENTRIES allowlist", async () => {
    const env = makeEnv();
    const gameTxt = new TextEncoder().encode("NFSU2_GAME_DATA_BYTES_0123456789");
    const introVp6 = new Uint8Array(24).map((_, i) => i + 10);
    // Simulate a large chunked file (40 bytes split into 3 chunks of 16, 16, 8 bytes)
    const bigTrack = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
    const manifestBody = JSON.stringify({
      v: 1,
      files: [
        { p: "GLOBAL", d: 1 },
        { p: "GLOBAL/Game.txt", s: gameTxt.byteLength, m: 1700000000 },
        { p: "MOVIES", d: 1 },
        { p: "MOVIES/INTRO.VP6", s: introVp6.byteLength, m: 1700000001 },
        { p: "TRACKS", d: 1 },
        { p: "TRACKS/STREAML4RA.BUN", s: bigTrack.byteLength, m: 1700000002 },
      ],
      blocks: { url: "/data-blocks/v2/", size: 1048576, max: 8 },
    });
    const pkgIndexBody = JSON.stringify({
      chunkSize: 16,
      files: {
        "global/game.txt": { p: "GLOBAL/Game.txt", s: gameTxt.byteLength },
        "movies/intro.vp6": { p: "MOVIES/INTRO.VP6", s: introVp6.byteLength },
        "tracks/streaml4ra.bun": { p: "TRACKS/STREAML4RA.BUN", s: bigTrack.byteLength, c: 3 },
      },
    });
    env.ASSETS.put("/_data_manifest.json", manifestBody, "application/json");
    env.ASSETS.put("/_pkg_index.json", pkgIndexBody, "application/json");
    env.ASSETS.put("/_data/GLOBAL/Game.txt", gameTxt);
    env.ASSETS.put("/_data/MOVIES/INTRO.VP6", introVp6);
    env.ASSETS.put("/_data/TRACKS/STREAML4RA.BUN.part000", bigTrack.slice(0, 16));
    env.ASSETS.put("/_data/TRACKS/STREAML4RA.BUN.part001", bigTrack.slice(16, 32));
    env.ASSETS.put("/_data/TRACKS/STREAML4RA.BUN.part002", bigTrack.slice(32, 40));
    // Rogue file outside GAME_ENTRIES must be blocked even if present in assets
    env.ASSETS.put("/_data/scripts/mod.ini", "SECRET");

    // Internal staging files must be 404 on direct public requests
    assert.equal((await worker.fetch(new Request("https://nfsu2.example/_pkg_index.json"), env)).status, 404);
    assert.equal((await worker.fetch(new Request("https://nfsu2.example/_data/GLOBAL/Game.txt"), env)).status, 404);

    const manRes = await worker.fetch(new Request("https://nfsu2.example/data-manifest"), env);
    assert.equal(manRes.status, 200);
    assert.equal(manRes.headers.get("content-type"), "application/json");
    const etag = manRes.headers.get("etag");
    assert.ok(etag);
    const manData = await manRes.json();
    assert.equal(manData.blocks.url, "/data-blocks/v2/");

    const man304 = await worker.fetch(
      new Request("https://nfsu2.example/data-manifest", { headers: { "if-none-match": etag } }),
      env
    );
    assert.equal(man304.status, 304);

    const blkV2 = await worker.fetch(
      new Request("https://nfsu2.example/data-blocks/v2/GLOBAL/Game.txt?b=0&n=1&m=1700000000&s=32"),
      env
    );
    assert.equal(blkV2.status, 200);
    assert.equal(blkV2.headers.get("cdn-cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(new Uint8Array(await blkV2.arrayBuffer()), gameTxt);

    const blkV1 = await worker.fetch(
      new Request("https://nfsu2.example/data-blocks/GLOBAL/Game.txt?b=0&n=1"),
      env
    );
    assert.equal(blkV1.status, 200);
    assert.equal(blkV1.headers.get("cdn-cache-control"), "no-store");

    const exactRes = await worker.fetch(
      new Request("https://nfsu2.example/data-blocks/v2/GLOBAL/Game.txt?o=6&l=9&m=1700000000&s=32"),
      env
    );
    assert.equal(exactRes.status, 200);
    assert.equal(await exactRes.text(), "GAME_DATA");

    // Cross-chunk stitching test: span across .part000 (bytes 10..15), .part001 (16..31), .part002 (32..35)
    const crossChunkBlock = await worker.fetch(
      new Request("https://nfsu2.example/data-blocks/v2/TRACKS/STREAML4RA.BUN?o=10&l=26&m=1700000002&s=40"),
      env
    );
    assert.equal(crossChunkBlock.status, 200);
    assert.deepEqual(new Uint8Array(await crossChunkBlock.arrayBuffer()), bigTrack.slice(10, 36));

    // Cross-chunk HTTP Range test on /data/
    const crossChunkRange = await worker.fetch(
      new Request("https://nfsu2.example/data/TRACKS/STREAML4RA.BUN", { headers: { range: "bytes=14-33" } }),
      env
    );
    assert.equal(crossChunkRange.status, 206);
    assert.equal(crossChunkRange.headers.get("content-range"), "bytes 14-33/40");
    assert.deepEqual(new Uint8Array(await crossChunkRange.arrayBuffer()), bigTrack.slice(14, 34));

    const blockedAllowlist = await worker.fetch(
      new Request("https://nfsu2.example/data-blocks/v2/scripts/mod.ini?b=0&n=1"),
      env
    );
    assert.equal(blockedAllowlist.status, 404);

    const blockedTraversal = await worker.fetch(
      new Request("https://nfsu2.example/data/GLOBAL/%2f../secret"),
      env
    );
    assert.equal(blockedTraversal.status, 400);

    const rangeRes = await worker.fetch(
      new Request("https://nfsu2.example/data/MOVIES/INTRO.VP6", { headers: { range: "bytes=4-9" } }),
      env
    );
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get("content-range"), "bytes 4-9/24");
    assert.deepEqual(new Uint8Array(await rangeRes.arrayBuffer()), introVp6.slice(4, 10));

    const badRange = await worker.fetch(
      new Request("https://nfsu2.example/data/MOVIES/INTRO.VP6", { headers: { range: "bytes=100-200" } }),
      env
    );
    assert.equal(badRange.status, 416);
  });

  test("/vault encrypted save CRUD, ETag concurrency, earlier-day copy, and /names claims", async () => {
    const env = makeEnv();
    const tokenA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars
    const tokenB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    // Probe without auth -> 401 (vaultAvailable)
    const probe = await worker.fetch(new Request("https://nfsu2.example/vault"), env);
    assert.equal(probe.status, 401);

    // Missing preconditions -> 428
    const noCond = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}` },
        body: new Uint8Array([1, 2, 3]),
      }),
      env
    );
    assert.equal(noCond.status, 428);

    // Oversize > 256 KiB -> 413
    const tooBig = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}`, "if-none-match": "*" },
        body: new Uint8Array((256 << 10) + 1),
      }),
      env
    );
    assert.equal(tooBig.status, 413);

    // Create save -> 201
    const box1 = new Uint8Array([1, 10, 20, 30, 40]);
    const put1 = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}`, "if-none-match": "*" },
        body: box1,
      }),
      env
    );
    assert.equal(put1.status, 201);
    const rev1 = put1.headers.get("etag");
    assert.match(rev1, /^"[0-9a-f]{16}"$/);
    assert.ok(Number(put1.headers.get("x-vault-saved")) > 0);

    // Duplicate create -> 412 with current ETag
    const putDup = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}`, "if-none-match": "*" },
        body: box1,
      }),
      env
    );
    assert.equal(putDup.status, 412);
    assert.equal(putDup.headers.get("etag"), rev1);

    // Conditional GET -> 304
    const get304 = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        headers: { authorization: `Bearer ${tokenA}`, "if-none-match": rev1 },
      }),
      env
    );
    assert.equal(get304.status, 304);

    // Simulate yesterday's save timestamp in D1 so next PUT rotates to earlier copy
    const yesterday = Date.now() - 2 * 86_400_000;
    env.DB.db.prepare("UPDATE vault_saves SET saved_at = ?").run(yesterday);

    const box2 = new Uint8Array([1, 99, 98, 97]);
    const put2 = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        method: "PUT",
        headers: { authorization: `Bearer ${tokenA}`, "if-match": rev1 },
        body: box2,
      }),
      env
    );
    assert.equal(put2.status, 200);
    const rev2 = put2.headers.get("etag");
    assert.notEqual(rev2, rev1);
    assert.equal(Number(put2.headers.get("x-vault-earlier")), yesterday);

    const getCur = await worker.fetch(
      new Request("https://nfsu2.example/vault", { headers: { authorization: `Bearer ${tokenA}` } }),
      env
    );
    assert.equal(getCur.status, 200);
    assert.deepEqual(new Uint8Array(await getCur.arrayBuffer()), box2);

    const getEarlier = await worker.fetch(
      new Request("https://nfsu2.example/vault?earlier", { headers: { authorization: `Bearer ${tokenA}` } }),
      env
    );
    assert.equal(getEarlier.status, 200);
    assert.deepEqual(new Uint8Array(await getEarlier.arrayBuffer()), box1);

    // /names claim linked to vault save
    const checkFree = await worker.fetch(new Request("https://nfsu2.example/names?name=Speed%20King"), env);
    assert.equal((await checkFree.json()).state, "free");

    const claimRes = await worker.fetch(
      new Request("https://nfsu2.example/names", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Speed King" }),
      }),
      env
    );
    assert.equal(claimRes.status, 200);
    const claimJson = await claimRes.json();
    assert.equal(claimJson.mine.name, "Speed_King");

    const checkTaken = await worker.fetch(
      new Request("https://nfsu2.example/names?name=speed_king", {
        headers: { authorization: `Bearer ${tokenB}` },
      }),
      env
    );
    assert.equal((await checkTaken.json()).state, "taken");

    // DELETE /vault removes saves + releases claim
    const delRes = await worker.fetch(
      new Request("https://nfsu2.example/vault", {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenA}` },
      }),
      env
    );
    assert.equal(delRes.status, 200);
    const afterDel = await worker.fetch(
      new Request("https://nfsu2.example/vault", { headers: { authorization: `Bearer ${tokenA}` } }),
      env
    );
    assert.equal(afterDel.status, 404);
  });

  test("/turn-credentials returns STUN fallback and Cloudflare Realtime TURN when configured", async () => {
    const env = makeEnv();
    const stunRes = await worker.fetch(new Request("https://nfsu2.example/turn-credentials"), env);
    assert.equal(stunRes.status, 200);
    const stunJson = await stunRes.json();
    assert.deepEqual(stunJson.iceServers, [{ urls: "stun:stun.cloudflare.com:3478" }]);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /rtc\.live\.cloudflare\.com/);
      assert.equal(init.method, "POST");
      return new Response(
        JSON.stringify({
          iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u", credential: "p" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    try {
      const turnEnv = makeEnv({ CF_TURN_TOKEN_ID: "tok-id", CF_TURN_API_TOKEN: "api-tok" });
      const turnRes = await worker.fetch(new Request("https://nfsu2.example/turn-credentials"), turnEnv);
      assert.equal(turnRes.status, 200);
      const turnJson = await turnRes.json();
      assert.equal(turnJson.iceServers.length, 2);
      assert.equal(turnJson.iceServers[0].urls, "stun:stun.cloudflare.com:3478");
      assert.equal(turnJson.iceServers[1].username, "u");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("/lan WebSocket switch, /players, WebRTC P2P signaling, binary routing, Free-Roam Hub, and resume", async () => {
    const env = makeEnv();

    const checkRes = await worker.fetch(new Request("https://nfsu2.example/lan?check"), env);
    assert.equal(checkRes.status, 200);
    assert.deepEqual(await checkRes.json(), { lan: "ok" });

    // Connect two clients to room shard "drift-night"
    const resA = await worker.fetch(
      new Request("https://nfsu2.example/lan?room=drift-night", { headers: { upgrade: "websocket" } }),
      env
    );
    assert.equal(resA.upgraded101, true);
    const wsA = resA.webSocket;

    const resB = await worker.fetch(
      new Request("https://nfsu2.example/lan?room=drift-night", { headers: { upgrade: "websocket" } }),
      env
    );
    const wsB = resB.webSocket;

    // A says hello (lan: 1)
    wsA.send(JSON.stringify({ t: "hello", name: "Alice", lan: 1, bundle: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    const msgA0 = JSON.parse(wsA.messages.shift());
    const msgA1 = JSON.parse(wsA.messages.shift());
    assert.equal(msgA0.t, "welcome");
    assert.equal(msgA0.vipStr, "10.77.0.2");
    assert.equal(msgA0.mask, "255.255.128.0");
    assert.equal(msgA0.bundle, 1);
    assert.equal(msgA1.t, "peers");
    assert.equal(msgA1.peers.length, 1);

    // B says hello (lan: 1)
    wsB.send(JSON.stringify({ t: "hello", name: "Bob", lan: 1, bundle: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    const msgB0 = JSON.parse(wsB.messages.shift());
    const msgB1 = JSON.parse(wsB.messages.shift());
    const deltaA = JSON.parse(wsA.messages.shift());
    assert.equal(msgB0.t, "welcome");
    assert.equal(msgB0.vipStr, "10.77.1.2");
    assert.equal(msgB1.t, "peers");
    assert.equal(msgB1.peers.length, 2);
    assert.equal(deltaA.t, "delta");
    assert.deepEqual(deltaA.peers, [{ vip: msgB0.vip, name: "Bob" }]);

    // Ping -> Pong
    wsA.send(JSON.stringify({ t: "ping", id: 42 }));
    assert.deepEqual(JSON.parse(wsA.messages.shift()), { t: "pong", id: 42 });

    // WebRTC P2P signaling relay
    wsA.send(JSON.stringify({ t: "rtc-offer", to: msgB0.vip, data: { sdp: "v=0 offer" } }));
    assert.deepEqual(JSON.parse(wsB.messages.shift()), {
      t: "rtc-offer",
      from: msgA0.vip,
      data: { sdp: "v=0 offer" },
    });
    wsB.send(JSON.stringify({ t: "rtc-answer", to: msgA0.vipStr, data: { sdp: "v=0 answer" } }));
    assert.deepEqual(JSON.parse(wsA.messages.shift()), {
      t: "rtc-answer",
      from: msgB0.vip,
      data: { sdp: "v=0 answer" },
    });
    wsA.send(JSON.stringify({ t: "rtc-ice", to: msgB0.vip, data: { candidate: "cand1" } }));
    assert.deepEqual(JSON.parse(wsB.messages.shift()), {
      t: "rtc-ice",
      from: msgA0.vip,
      data: { candidate: "cand1" },
    });

    // Binary frame routing with source VIP enforcement (even if A tries to spoof source VIP)
    const lanFrame = new Uint8Array(24);
    const dv = new DataView(lanFrame.buffer);
    lanFrame[0] = 3; // KIND_LAN_UDP
    dv.setUint32(4, 0xdeadbeef, false); // spoofed src
    dv.setUint32(8, msgB0.vip, false); // dst = B
    dv.setUint16(12, 9900, false);
    dv.setUint16(14, 9900, false);
    lanFrame.set([1, 2, 3, 4], 16);
    wsA.send(lanFrame);

    const rxB = new Uint8Array(wsB.messages.shift());
    const rxBdv = new DataView(rxB.buffer);
    assert.equal(rxB[0], 3);
    assert.equal(rxBdv.getUint32(4, false), msgA0.vip); // rewritten to A's true VIP!
    assert.equal(rxBdv.getUint32(8, false), msgB0.vip);
    assert.deepEqual(rxB.slice(16, 20), new Uint8Array([1, 2, 3, 4]));

    // Client C joins with lan: 0 (free roam only) and tests KIND_BUNDLE + LAN broadcast filtering
    const resC = await worker.fetch(
      new Request("https://nfsu2.example/lan?room=drift-night", { headers: { upgrade: "websocket" } }),
      env
    );
    const wsC = resC.webSocket;
    wsC.send(JSON.stringify({ t: "hello", name: "Carol", lan: 0, bundle: 1 }));
    await new Promise((r) => setTimeout(r, 10));
    const msgC0 = JSON.parse(wsC.messages.shift());
    const msgC1 = JSON.parse(wsC.messages.shift());
    assert.equal(msgC0.t, "welcome");
    assert.deepEqual(msgC1, { t: "peers", peers: [] });
    // Clear delta on A and B from C joining
    wsA.messages.length = 0;
    wsB.messages.length = 0;
    wsC.messages.length = 0;

    // LAN broadcast (kind 3) -> reaches B (lan=1), skipped for C (lan=0)
    const lanBcast = new Uint8Array(20);
    const lbDv = new DataView(lanBcast.buffer);
    lanBcast[0] = 3;
    lbDv.setUint32(8, BROADCAST_VIP, false);
    lbDv.setUint16(14, 9900, false);
    wsA.send(lanBcast);
    assert.equal(wsB.messages.length, 1);
    assert.equal(wsC.messages.length, 0);
    wsB.messages.length = 0;

    // KIND_BUNDLE (32) with k=2 destinations [B, C]
    const innerUdp = new Uint8Array(20);
    innerUdp[0] = 1; // KIND_UDP
    innerUdp.set([9, 8, 7, 6], 16);
    const bundle = new Uint8Array(4 + 4 + 8 + innerUdp.byteLength);
    const bdv = new DataView(bundle.buffer);
    bundle[0] = 32; // KIND_BUNDLE
    bundle[4] = 2; // k = 2
    bdv.setUint16(6, innerUdp.byteLength, false);
    bdv.setUint32(8, msgB0.vip, false);
    bdv.setUint32(12, msgC0.vip, false);
    bundle.set(innerUdp, 16);
    wsA.send(bundle);

    assert.equal(wsB.messages.length, 1);
    assert.equal(wsC.messages.length, 1);
    const gotBundleC = new Uint8Array(wsC.messages.shift());
    assert.equal(new DataView(gotBundleC.buffer).getUint32(4, false), msgA0.vip);
    assert.equal(new DataView(gotBundleC.buffer).getUint32(8, false), msgC0.vip);
    assert.deepEqual(gotBundleC.slice(16, 20), new Uint8Array([9, 8, 7, 6]));
    wsB.messages.length = 0;
    wsC.close(1000, "idle");
    await new Promise((r) => setTimeout(r, 10));
    wsA.messages.length = 0;
    wsB.messages.length = 0;

    // Embedded Free-Roam Hub (10.77.0.253) HELLO -> PEERS
    const makeHelloFrame = (senderId, status, room, name) => {
      const nameBytes = new TextEncoder().encode(name);
      const innerLen = 16 + 14 + nameBytes.length + 4;
      const f = new Uint8Array(16 + innerLen);
      const fdv = new DataView(f.buffer);
      f[0] = 1; // KIND_UDP
      fdv.setUint32(8, ROAM_HUB_VIP, false);
      fdv.setUint16(12, 47210, false);
      fdv.setUint16(14, 47210, false);

      const p = f.subarray(16);
      const pdv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      pdv.setUint32(0, 0x4e324652, false); // N2FR
      p[4] = 1; // version
      p[5] = 1; // MSG_HELLO
      pdv.setUint16(6, innerLen, true);
      pdv.setUint32(8, senderId, true);
      pdv.setUint16(16, 17, true); // core version
      p[19] = status; // 2 = driving in free roam
      pdv.setUint32(24, room, true);
      p[28] = nameBytes.length;
      p.set(nameBytes, 29);
      p[29 + nameBytes.length] = 0; // seen=0
      pdv.setUint32(innerLen - 4, crc32(p, innerLen - 4), true);
      return f;
    };

    wsA.send(makeHelloFrame(0x11112222, 2, 0, "Alice"));
    wsB.send(makeHelloFrame(0x33334444, 2, 0, "Bob"));
    await new Promise((r) => setTimeout(r, 10));

    // Both A and B should have received MSG_PEERS containing each other
    const lastPeersA = new Uint8Array(wsA.messages.at(-1));
    const innerA = lastPeersA.subarray(16);
    const idvA = new DataView(innerA.buffer, innerA.byteOffset, innerA.byteLength);
    assert.equal(lastPeersA[0], 1);
    assert.equal(new DataView(lastPeersA.buffer).getUint32(4, false), ROAM_HUB_VIP);
    assert.equal(innerA[5], 2); // MSG_PEERS
    assert.equal(innerA[16], 1); // 1 peer (Bob)
    assert.equal(idvA.getUint32(17, false), msgB0.vip);
    assert.equal(idvA.getUint16(21, true), 47210);
    assert.equal(idvA.getUint32(23, true), 0x33334444);
    assert.equal(crc32(innerA, innerA.byteLength - 4), idvA.getUint32(innerA.byteLength - 4, true));

    // /players reports live counts for the shard
    const playersRes = await worker.fetch(new Request("https://nfsu2.example/players?shard=drift-night"), env);
    assert.equal(playersRes.status, 200);
    const counts = await playersRes.json();
    assert.equal(counts.players, 2);
    assert.equal(counts.roam, 2);
    assert.equal(counts.online, null);
    assert.equal(counts.full, false);

    // Unexpected drop reserves A's VIP; reconnect with token gets same VIP back
    wsA.close(1006, "drop");
    await new Promise((r) => setTimeout(r, 10));
    const resA2 = await worker.fetch(
      new Request("https://nfsu2.example/lan?room=drift-night&resume", { headers: { upgrade: "websocket" } }),
      env
    );
    const wsA2 = resA2.webSocket;
    wsA2.send(
      JSON.stringify({
        t: "hello",
        name: "Alice",
        lan: 1,
        vip: msgA0.vipStr,
        token: msgA0.token,
      })
    );
    await new Promise((r) => setTimeout(r, 10));
    const welcomeA2 = JSON.parse(wsA2.messages.shift());
    assert.equal(welcomeA2.t, "welcome");
    assert.equal(welcomeA2.vipStr, msgA0.vipStr);

    // Clean idle disconnect releases VIP and notifies peers
    wsB.messages.length = 0;
    wsA2.close(1000, "idle");
    await new Promise((r) => setTimeout(r, 10));
    const goneMsg = JSON.parse(wsB.messages.find((m) => typeof m === "string" && m.includes('"delta"')));
    assert.deepEqual(goneMsg.gone, [msgA0.vip]);
  });
});
