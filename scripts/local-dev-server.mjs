#!/usr/bin/env node
// Lightweight local dev server for testing web/dist + out/web/nfsu2.wasm + local NFSU2 data folder
// without building the Rust server. Supports both WebGPU and ?renderer=webgl2!
//
// Usage:
//   node scripts/local-dev-server.mjs "F:\Need for Speed Underground 2" [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'web', 'dist');
const OUT = path.join(ROOT, 'out', 'web');
const DATA_DIR = process.argv[2] || 'F:\\Need for Speed Underground 2';
const PORT = Number(process.argv[3] || 8080);

const GAME_ENTRIES = new Set([
  'CARS', 'CREDITS', 'FRONTEND', 'GLOBAL', 'LANGUAGES', 'MOVIES', 'NIS', 'SDATA',
  'SOUND', 'SUBTITLES', 'TRACKS', 'memcard', 'SPEED2.EXE', 'server.dll', 'server.cfg',
  'LanguagePacks', 'TexturePacks', 'ModPacks', 'MusicPacks', 'VinylPacks', 'DataPacks',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

// Build /data-manifest matching web/src/host/datacache.ts & web/server-rs/src/app/manifest.rs
function buildManifest(dir) {
  const entries = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!rel && !GAME_ENTRIES.has(ent.name)) continue;
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        entries.push({ p: child, d: 1 });
        walk(child);
      } else if (ent.isFile()) {
        const st = fs.statSync(full);
        entries.push({ p: child, s: st.size, m: Math.floor(st.mtimeMs) });
      }
    }
  };
  walk('');
  entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return JSON.stringify({ files: entries, blocks: { url: '/data-blocks/v2/', size: 1 << 20, max: 16 } });
}

const manifestJson = buildManifest(DATA_DIR);
const BLOCK = 1 << 20;

const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(u.pathname);

  if (p === '/players') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ players: 0, online: 0, roam: 0, full: false, queue: 0, roamBusy: false }));
    return;
  }
  if (p === '/turn-credentials') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }));
    return;
  }
  if (p === '/game.json') {
    const fp = path.join(OUT, 'nfsu2.json');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.readFileSync(fp));
    return;
  }
  if (p === '/game.wasm') {
    const fp = path.join(OUT, 'nfsu2.wasm');
    const st = fs.statSync(fp);
    res.writeHead(200, { 'Content-Type': 'application/wasm', 'Content-Length': st.size });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  if (p === '/data-manifest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(manifestJson);
    return;
  }
  if (p.startsWith('/data-blocks/')) {
    const sub = p.startsWith('/data-blocks/v2/') ? p.slice('/data-blocks/v2/'.length) : p.slice('/data-blocks/'.length);
    const full = path.resolve(DATA_DIR, sub);
    if (!full.startsWith(path.resolve(DATA_DIR)) || !fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
    const st = fs.statSync(full);
    let start = 0, end = st.size;
    if (u.searchParams.has('o') && u.searchParams.has('l')) {
      start = Number(u.searchParams.get('o'));
      end = Math.min(st.size, start + Number(u.searchParams.get('l')));
    } else if (u.searchParams.has('b')) {
      const b = Number(u.searchParams.get('b'));
      const n = Number(u.searchParams.get('n') || 1);
      start = b * BLOCK;
      end = Math.min(st.size, start + n * BLOCK);
    }
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(full, 'r');
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const ae = String(req.headers['accept-encoding'] || '');
    if (ae.includes('gzip') && len > 1024) {
      const gz = zlib.gzipSync(buf, { level: 1 });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
      res.end(buf);
    }
    return;
  }
  if (p.startsWith('/data/')) {
    const sub = p.slice('/data/'.length);
    const full = path.resolve(DATA_DIR, sub);
    if (!full.startsWith(path.resolve(DATA_DIR)) || !fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
    const st = fs.statSync(full);
    const rng = req.headers.range;
    if (rng && rng.startsWith('bytes=')) {
      const [a, b] = rng.slice(6).split('-');
      const start = Number(a || 0);
      const end = b ? Math.min(st.size - 1, Number(b)) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(full).pipe(res);
    }
    return;
  }

  // Static files from web/dist
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const full = path.resolve(DIST, rel);
  if (!full.startsWith(DIST) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NFSU2 local dev server listening on http://127.0.0.1:${PORT}/`);
  console.log(`  WebGPU: http://127.0.0.1:${PORT}/`);
  console.log(`  WebGL2: http://127.0.0.1:${PORT}/?renderer=webgl2`);
});
