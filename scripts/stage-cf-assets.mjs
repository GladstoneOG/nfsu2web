#!/usr/bin/env node
/**
 * Stage all static assets for a ZERO-R2, ZERO-CARD Cloudflare Workers Free-Tier deployment:
 *   1. Copies web/dist/* into cf/public/
 *   2. Writes cf/public/_headers (COOP/COEP/CORP for SharedArrayBuffer with 0 Worker invocations)
 *   3. Brotli-compresses out/web/nfsu2.wasm (~8.15 MiB) -> cf/public/_wasm/nfsu2.wasm.bin
 *      and writes cf/public/_wasm/nfsu2.json (with content-hash `module` tag)
 *   4. Walks the NFSU2 install folder (strictly GAME_ENTRIES allowlist), copies files <= 16 MiB
 *      directly to cf/public/_data/<relpath>, and splits any file > 16 MiB into 16 MiB chunks
 *      (.part000, .part001, ...) so EVERY file stays well under Cloudflare's 25 MiB per-file limit!
 *   5. Writes cf/public/_data_manifest.json and cf/public/_pkg_index.json.
 *
 * Usage:
 *   node scripts/stage-cf-assets.mjs "F:\Need for Speed Underground 2"
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const WASM_DIR = path.join(ROOT, 'out', 'web');
const PUBLIC_DIR = path.join(ROOT, 'cf', 'public');

const DATA_DIR = process.argv[2] || 'F:\\Need for Speed Underground 2';
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB (< 25 MiB Cloudflare Workers Static Assets cap)
const BLOCK = 1 << 20;
const BLOCKS_MAX = 8;

const GAME_ENTRIES = new Set([
  'speed2.exe', 'server.dll', 'server.cfg', 'cars', 'credits', 'frontend', 'global',
  'hqvinyls', 'langpacks', 'languages', 'memcard', 'modpacks', 'movies', 'nis',
  'pfdata', 'sdata', 'sound', 'speech', 'subtitles', 'texpacks', 'tracks', 'vinylpacks',
]);

if (!fs.existsSync(WEB_DIST)) throw new Error(`Missing ${WEB_DIST}. Run node build.mjs in web/ first.`);
if (!fs.existsSync(path.join(WASM_DIR, 'nfsu2.wasm'))) throw new Error(`Missing ${WASM_DIR}/nfsu2.wasm.`);
if (!fs.existsSync(DATA_DIR)) throw new Error(`Missing NFSU2 folder: ${DATA_DIR}`);

console.log(`Staging Cloudflare Static Assets into ${PUBLIC_DIR}...`);
fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// 1. Copy web/dist -> cf/public
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}
copyDir(WEB_DIST, PUBLIC_DIR);

// 2. Write _headers for zero-Worker-invocation COOP/COEP on static assets
const HEADERS_TXT = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`;
fs.writeFileSync(path.join(PUBLIC_DIR, '_headers'), HEADERS_TXT);

// 3. Stage brotli-compressed nfsu2.wasm (< 25 MiB) + nfsu2.json
const wasmOutDir = path.join(PUBLIC_DIR, '_wasm');
fs.mkdirSync(wasmOutDir, { recursive: true });
const rawWasm = fs.readFileSync(path.join(WASM_DIR, 'nfsu2.wasm'));
const wasmHash = crypto.createHash('sha256').update(rawWasm).digest('hex').slice(0, 16);
console.log(`Compressing nfsu2.wasm (${(rawWasm.length / 1048576).toFixed(2)} MiB) with Brotli...`);
const brWasm = zlib.brotliCompressSync(rawWasm, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
});
if (brWasm.length > 24 * 1024 * 1024) {
  throw new Error(`nfsu2.wasm.br is ${(brWasm.length / 1048576).toFixed(2)} MiB (> 24 MiB limit)!`);
}
fs.writeFileSync(path.join(wasmOutDir, 'nfsu2.wasm.bin'), brWasm);
const meta = JSON.parse(fs.readFileSync(path.join(WASM_DIR, 'nfsu2.json'), 'utf8'));
meta.module = wasmHash;
meta.brSize = brWasm.length;
fs.writeFileSync(path.join(wasmOutDir, 'nfsu2.json'), JSON.stringify(meta));
console.log(`  nfsu2.wasm.bin: ${(brWasm.length / 1048576).toFixed(2)} MiB (module=${wasmHash})`);

// 4. Walk & stage NFSU2 game files (chunking any file > 16 MiB)
const dataOutDir = path.join(PUBLIC_DIR, '_data');
fs.mkdirSync(dataOutDir, { recursive: true });

const manifestEntries = [];
const pkgFiles = {};
let totalFiles = 0;
let totalBytes = 0;
let chunkedFiles = 0;
let totalChunks = 0;

function pad3(n) { return String(n).padStart(3, '0'); }

function walk(rel) {
  const abs = rel ? path.join(DATA_DIR, rel) : DATA_DIR;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    if (!rel && !GAME_ENTRIES.has(ent.name.toLowerCase())) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    const full = path.join(abs, ent.name);
    if (ent.isDirectory()) {
      manifestEntries.push({ p: r, d: 1 });
      walk(r);
    } else if (ent.isFile()) {
      const st = fs.statSync(full);
      const mtimeS = Math.floor(st.mtimeMs / 1000);
      manifestEntries.push({ p: r, s: st.size, m: mtimeS });
      totalFiles++;
      totalBytes += st.size;

      const dstBase = path.join(dataOutDir, ...r.split('/'));
      fs.mkdirSync(path.dirname(dstBase), { recursive: true });

      if (st.size <= CHUNK_SIZE) {
        fs.copyFileSync(full, dstBase);
        pkgFiles[r.toLowerCase()] = { p: r, s: st.size };
      } else {
        const parts = Math.ceil(st.size / CHUNK_SIZE);
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.allocUnsafe(CHUNK_SIZE);
        for (let ci = 0; ci < parts; ci++) {
          const want = Math.min(CHUNK_SIZE, st.size - ci * CHUNK_SIZE);
          const got = fs.readSync(fd, buf, 0, want, ci * CHUNK_SIZE);
          fs.writeFileSync(`${dstBase}.part${pad3(ci)}`, buf.subarray(0, got));
        }
        fs.closeSync(fd);
        pkgFiles[r.toLowerCase()] = { p: r, s: st.size, c: parts };
        chunkedFiles++;
        totalChunks += parts;
        console.log(`  Chunked ${r} (${(st.size / 1048576).toFixed(1)} MiB -> ${parts} parts)`);
      }
    }
  }
}

walk('');
manifestEntries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

fs.writeFileSync(
  path.join(PUBLIC_DIR, '_data_manifest.json'),
  JSON.stringify({
    files: manifestEntries,
    blocks: { url: '/data-blocks/v2/', size: BLOCK, max: BLOCKS_MAX },
  })
);
fs.writeFileSync(
  path.join(PUBLIC_DIR, '_pkg_index.json'),
  JSON.stringify({ chunkSize: CHUNK_SIZE, files: pkgFiles })
);

// 5. Final audit against Cloudflare Workers Free Plan asset limits (20,000 files, 25 MiB/file)
let assetCount = 0;
let maxFile = { name: '', size: 0 };
function audit(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) audit(full);
    else if (ent.isFile()) {
      assetCount++;
      const s = fs.statSync(full).size;
      if (s > maxFile.size) maxFile = { name: path.relative(PUBLIC_DIR, full), size: s };
      if (s > 25 * 1024 * 1024) throw new Error(`Asset exceeds 25 MiB limit: ${full} (${s} bytes)`);
    }
  }
}
audit(PUBLIC_DIR);
if (assetCount > 20000) throw new Error(`Asset count ${assetCount} exceeds 20,000 Free Plan limit!`);

console.log(`\nSTAGING COMPLETE!`);
console.log(`  Game files:    ${totalFiles} (${(totalBytes / 1e9).toFixed(2)} GB), ${chunkedFiles} chunked into ${totalChunks} x 16 MiB parts`);
console.log(`  Total assets:  ${assetCount} / 20,000 max`);
console.log(`  Largest asset: ${maxFile.name} (${(maxFile.size / 1048576).toFixed(2)} MiB / 25 MiB max)`);
