#!/usr/bin/env node
/**
 * Package and upload NFSU2 game data + WASM build to Cloudflare R2 (Free Tier optimized).
 *
 * Strategy evaluation (Free Tier: 10 GB storage, 1M Class A PUTs/mo, 10M Class B GETs/mo):
 * - By default, each allowed game file is stored once as `data/<relpath>` (single R2 Range-readable object).
 *   Why: ~1,200 Class A PUTs instead of ~4,000+ pre-split blocks, ~50% less R2 storage (~1.5-2.0 GB vs ~3.5+ GB),
 *   1 single Class B GET per `/data-blocks/v2/` or `/data/` request, and <1ms Worker CPU (safe under 10ms Free Tier cap).
 *   Browser OPFS (`datacache.ts`) + Cloudflare immutable CDN caching (`?m=<mtime>&s=<size>`) ensure each block
 *   is downloaded once per client.
 * - Pass `--precompress-blocks` only if you explicitly want pre-compressed 1 MiB brotli blocks staged under `blocks/`.
 *
 * Usage:
 *   node scripts/upload-r2.mjs "<path-to-nfsu2-folder>" [--bucket nfsu2-game-data] [--out-dir <stage-dir>] [--dry-run] [--upload]
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BLOCK = 1 << 20; // 1 MiB
const BLOCKS_MAX = 8;

/** Exact top-level allowlist from web/server-rs/src/app/manifest.rs */
export const GAME_ENTRIES = new Set([
  "speed2.exe",
  "server.dll",
  "server.cfg",
  "cars",
  "credits",
  "frontend",
  "global",
  "hqvinyls",
  "langpacks",
  "languages",
  "memcard",
  "modpacks",
  "movies",
  "nis",
  "pfdata",
  "sdata",
  "sound",
  "speech",
  "subtitles",
  "texpacks",
  "tracks",
  "vinylpacks",
]);

function usage(exitCode = 1) {
  console.error(
    `Usage: node scripts/upload-r2.mjs "<path-to-nfsu2-folder>" [options]\n` +
      `\nOptions:\n` +
      `  --bucket <name>         R2 bucket name (default: nfsu2-game-data)\n` +
      `  --out-dir <dir>         Stage packaged R2 layout locally\n` +
      `  --wasm-dir <dir>        Directory containing nfsu2.wasm & nfsu2.json (default: out/web)\n` +
      `  --precompress-blocks    Also stage pre-compressed 1 MiB brotli blocks under blocks/\n` +
      `  --concurrency <n>       Parallel R2 uploads (default: 6)\n` +
      `  --dry-run               Scan and print summary without writing or uploading\n` +
      `  --upload                Upload packaged files to R2 using Wrangler (--remote)\n`
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    gameDir: "",
    bucket: "nfsu2-game-data",
    outDir: "",
    wasmDir: path.join(REPO_ROOT, "out", "web"),
    precompressBlocks: false,
    concurrency: 6,
    dryRun: false,
    upload: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--bucket") {
      opts.bucket = argv[++i] ?? "";
    } else if (arg === "--out-dir") {
      opts.outDir = argv[++i] ?? "";
    } else if (arg === "--wasm-dir") {
      opts.wasmDir = argv[++i] ?? "";
    } else if (arg === "--concurrency") {
      opts.concurrency = Math.max(1, Number(argv[++i] ?? "6") || 6);
    } else if (arg === "--precompress-blocks") {
      opts.precompressBlocks = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--upload") {
      opts.upload = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    } else if (!opts.gameDir) {
      opts.gameDir = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      usage(1);
    }
  }

  if (!opts.gameDir) {
    console.error("Missing <path-to-nfsu2-folder>.");
    usage(1);
  }
  return opts;
}

export function isGameEntry(name) {
  return GAME_ENTRIES.has(name.toLowerCase());
}

/**
 * Walk the NFSU2 folder following manifest.rs rules:
 * - Only top-level entries matching GAME_ENTRIES (case-insensitive)
 * - Skip dot-files and symlinks
 * - Sort entries at each level in UTF-8 byte order
 */
export async function scanGameFolder(rootDir) {
  const manifestEntries = [];
  const files = [];
  const includedTop = [];
  const skippedTop = [];

  async function walk(dir, rel) {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));

    for (const d of dirents) {
      if (d.name.startsWith(".") || d.isSymbolicLink()) {
        if (!rel) skippedTop.push(d.name);
        continue;
      }
      if (!rel && !isGameEntry(d.name)) {
        skippedTop.push(d.name);
        continue;
      }
      if (!rel) {
        includedTop.push(d.name);
      }

      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;

      if (d.isDirectory()) {
        manifestEntries.push({ p: r, d: 1 });
        await walk(abs, r);
      } else if (d.isFile()) {
        const st = await fsp.lstat(abs);
        if (!st.isFile()) continue;
        const mtimeS = Math.floor(st.mtimeMs / 1000);
        manifestEntries.push({ p: r, s: st.size, m: mtimeS });
        files.push({
          rel: r,
          abs,
          size: st.size,
          mtime: mtimeS,
          r2Key: `data/${r}`,
        });
      }
    }
  }

  await walk(rootDir, "");

  const manifestObj = {
    v: 1,
    files: manifestEntries,
    blocks: {
      url: "/data-blocks/v2/",
      size: BLOCK,
      max: BLOCKS_MAX,
    },
  };

  return {
    manifestObj,
    manifestJson: JSON.stringify(manifestObj),
    files,
    dirCount: manifestEntries.length - files.length,
    includedTop,
    skippedTop,
  };
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function base64Url22(buf) {
  return crypto
    .createHash("sha256")
    .update(buf)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 22);
}

async function prepareWasmArtifacts(wasmDir) {
  const wasmPath = path.join(wasmDir, "nfsu2.wasm");
  const jsonPath = path.join(wasmDir, "nfsu2.json");
  if (!fs.existsSync(wasmPath)) {
    return null;
  }

  const rawWasm = await fsp.readFile(wasmPath);
  const moduleHash = base64Url22(rawWasm);
  const brWasm = zlib.brotliCompressSync(rawWasm, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: rawWasm.byteLength,
    },
  });

  let info = {
    pages: 16384,
    maxPages: 65536,
    guestEnd: 671088640,
    rev: "cf-r2",
    size: rawWasm.byteLength,
    opt: "-O3",
    module: moduleHash,
  };
  if (fs.existsSync(jsonPath)) {
    try {
      const existing = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
      info = { ...existing, module: moduleHash };
    } catch {
      // keep fallback info
    }
  }

  return {
    wasmPath,
    rawSize: rawWasm.byteLength,
    brWasm,
    brSize: brWasm.byteLength,
    jsonString: JSON.stringify(info),
    moduleHash,
  };
}

async function stageFile(srcPath, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.copyFile(srcPath, destPath);
}

async function stageBuffer(buf, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, buf);
}

function runWranglerPut(bucket, key, filePath, contentType) {
  return new Promise((resolve, reject) => {
    const cfDir = path.join(REPO_ROOT, "cf");
    const localWrangler = path.join(
      cfDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler"
    );
    const cmd = fs.existsSync(localWrangler) ? localWrangler : process.platform === "win32" ? "npx.cmd" : "npx";
    const baseArgs = fs.existsSync(localWrangler) ? [] : ["wrangler"];
    const args = [
      ...baseArgs,
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--file",
      filePath,
      "--remote",
    ];
    if (contentType) {
      args.push("--content-type", contentType);
    }

    const child = spawn(cmd, args, {
      cwd: cfDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler put ${key} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function runPool(items, concurrency, workerFn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      await workerFn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gameDir = path.resolve(opts.gameDir);
  if (!fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
    console.error(`Game directory not found: ${gameDir}`);
    process.exit(1);
  }

  console.log(`Scanning game folder: ${gameDir}`);
  const scan = await scanGameFolder(gameDir);
  const totalBytes = scan.files.reduce((acc, f) => acc + f.size, 0);
  const wasm = await prepareWasmArtifacts(path.resolve(opts.wasmDir));

  console.log(`\n=== Allowlist Filter Summary ===`);
  console.log(`Included top-level entries (${scan.includedTop.length}): ${scan.includedTop.join(", ")}`);
  console.log(`Skipped top-level entries  (${scan.skippedTop.length}): ${scan.skippedTop.join(", ") || "(none)"}`);
  console.log(`Directories: ${scan.dirCount}`);
  console.log(`Files:       ${scan.files.length}`);
  console.log(`Total size:  ${totalBytes} bytes (${formatBytes(totalBytes)})`);
  console.log(`Manifest:    ${Buffer.byteLength(scan.manifestJson)} bytes`);
  if (wasm) {
    console.log(
      `WASM build:  nfsu2.wasm (${formatBytes(wasm.rawSize)}), brotli (${formatBytes(wasm.brSize)}), module=${wasm.moduleHash}`
    );
  } else {
    console.log(`WASM build:  not found in ${path.resolve(opts.wasmDir)} (skipping wasm/ upload)`);
  }

  const classAOps = scan.files.length + 1 + (wasm ? 3 : 0);
  console.log(`\n=== R2 Free Tier Estimate ===`);
  console.log(`Layout:      Single Range-readable objects (data/<relpath>) + manifest/data-manifest.json`);
  console.log(`Class A ops: ${classAOps} PUTs (Free Tier: 1,000,000/month)`);
  console.log(`Storage:     ${formatBytes(totalBytes + (wasm ? wasm.rawSize + wasm.brSize : 0))} (Free Tier: 10 GB)`);

  if (opts.dryRun) {
    console.log(`\n[dry-run] No files written or uploaded.`);
    return;
  }

  const stageDir = opts.outDir ? path.resolve(opts.outDir) : "";
  const uploadQueue = [];

  if (stageDir) {
    console.log(`\nStaging R2 tree into: ${stageDir}`);
    const manifestDest = path.join(stageDir, "manifest", "data-manifest.json");
    await stageBuffer(Buffer.from(scan.manifestJson), manifestDest);
    uploadQueue.push({ key: "manifest/data-manifest.json", file: manifestDest, contentType: "application/json" });

    for (const f of scan.files) {
      const dest = path.join(stageDir, "data", ...f.rel.split("/"));
      await stageFile(f.abs, dest);
      uploadQueue.push({ key: f.r2Key, file: dest, contentType: "application/octet-stream" });

      if (opts.precompressBlocks && f.size > 0) {
        const fh = await fsp.open(f.abs, "r");
        try {
          const buf = Buffer.allocUnsafe(Math.min(BLOCK, f.size));
          const nb = Math.ceil(f.size / BLOCK);
          for (let bi = 0; bi < nb; bi++) {
            const off = bi * BLOCK;
            const len = Math.min(BLOCK, f.size - off);
            const { bytesRead } = await fh.read(buf, 0, len, off);
            const slice = buf.subarray(0, bytesRead);
            const br = zlib.brotliCompressSync(slice, {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
            });
            if (br.byteLength < slice.byteLength * 0.97) {
              const blockDest = path.join(stageDir, "blocks", ...f.rel.split("/"), `${bi}.br`);
              await stageBuffer(br, blockDest);
              uploadQueue.push({
                key: `blocks/${f.rel}/${bi}.br`,
                file: blockDest,
                contentType: "application/octet-stream",
              });
            }
          }
        } finally {
          await fh.close();
        }
      }
    }

    if (wasm) {
      const rawDest = path.join(stageDir, "wasm", "nfsu2.wasm");
      const brDest = path.join(stageDir, "wasm", "nfsu2.wasm.br");
      const jsonDest = path.join(stageDir, "wasm", "nfsu2.json");
      await stageFile(wasm.wasmPath, rawDest);
      await stageBuffer(wasm.brWasm, brDest);
      await stageBuffer(Buffer.from(wasm.jsonString), jsonDest);
      uploadQueue.push({ key: "wasm/nfsu2.wasm", file: rawDest, contentType: "application/wasm" });
      uploadQueue.push({ key: "wasm/nfsu2.wasm.br", file: brDest, contentType: "application/wasm" });
      uploadQueue.push({ key: "wasm/nfsu2.json", file: jsonDest, contentType: "application/json" });
    }
    console.log(`Staged ${uploadQueue.length} objects.`);
  } else if (opts.upload) {
    const tmpStage = path.join(REPO_ROOT, ".tmp-r2-stage");
    await fsp.mkdir(tmpStage, { recursive: true });
    const manifestTmp = path.join(tmpStage, "data-manifest.json");
    await fsp.writeFile(manifestTmp, scan.manifestJson);
    uploadQueue.push({ key: "manifest/data-manifest.json", file: manifestTmp, contentType: "application/json" });
    for (const f of scan.files) {
      uploadQueue.push({ key: f.r2Key, file: f.abs, contentType: "application/octet-stream" });
    }
    if (wasm) {
      const brTmp = path.join(tmpStage, "nfsu2.wasm.br");
      const jsonTmp = path.join(tmpStage, "nfsu2.json");
      await fsp.writeFile(brTmp, wasm.brWasm);
      await fsp.writeFile(jsonTmp, wasm.jsonString);
      uploadQueue.push({ key: "wasm/nfsu2.wasm", file: wasm.wasmPath, contentType: "application/wasm" });
      uploadQueue.push({ key: "wasm/nfsu2.wasm.br", file: brTmp, contentType: "application/wasm" });
      uploadQueue.push({ key: "wasm/nfsu2.json", file: jsonTmp, contentType: "application/json" });
    }
  }

  if (opts.upload) {
    console.log(`\nUploading ${uploadQueue.length} objects to R2 bucket "${opts.bucket}" (concurrency=${opts.concurrency})...`);
    let done = 0;
    await runPool(uploadQueue, opts.concurrency, async (item) => {
      await runWranglerPut(opts.bucket, item.key, item.file, item.contentType);
      done++;
      if (done % 50 === 0 || done === uploadQueue.length) {
        console.log(`  uploaded ${done}/${uploadQueue.length}`);
      }
    });
    console.log(`Upload complete.`);
  } else if (!stageDir) {
    console.log(`\nTip: Pass --out-dir <dir> to stage locally or --upload to upload directly to R2.`);
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
