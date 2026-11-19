# Deploying NFSU2 Web (WebGPU + WebGL2 + Cloudflare Free Tier, No Credit Card)

This fork extends [`th0mk/nfsu2-web`](https://github.com/th0mk/nfsu2-web) (MIT) with:
1. **Non-DX12 GPU Support (WebGL2 Backend):** Automatic fallback from Core WebGPU -> WebGPU Compatibility Mode -> **WebGL2** (`runtime/web/vsemu_glsl.inc` + `web/src/gpu/webgl2/`), supporting any DX10/DX11/OpenGL 3.3+ GPU (verified on NVIDIA GeForce GT 730 / D3D11 at 60 Hz). Force either backend anytime via `?renderer=webgl2` or `?renderer=webgpu`.
2. **100% Cloudflare Free-Tier Serverless Backend (`cf/`, Zero R2 / No Credit Card Required):**
   - **Workers Static Assets (`cf/public/`):** Stores the frontend UI, brotli-compressed `nfsu2.wasm` (~8.15 MiB), and all ~1.59 GB of clean game data split into `<= 16 MiB` chunks (well under Cloudflare's 25 MiB/file and 20,000 files limits — 1,325 total files, 16.00 MiB max). `cf/src/index.ts` transparently stitches chunk boundaries for `/data-blocks/v2/*` and `/data/*` HTTP Range requests.
   - **COOP/COEP/CORP Headers (`SharedArrayBuffer`):** Served via `cf/public/_headers` (zero Worker invocations on static UI assets) and `cf/src/headers.ts`.
   - **D1 (`nfsu2-db`, 5 GB free):** Stores encrypted save vaults (BLOBs up to 256 KiB + yesterday's backup copy), claimed online names, and room metadata.
   - **SQLite-backed Durable Object (`RoomSwitchDO`, 100k req/day + 13k GB-s/day free):** Virtual LAN switch (`10.77.x.y`) with WebSocket Hibernation + embedded Free-Roam Hub (`10.77.0.253`) + WebRTC signaling.
   - **WebRTC P2P DataChannels (`web/src/net/webrtc.ts`):** Direct unordered UDP-like car sync over free `stun.cloudflare.com` (+ optional 1 TB/month free Cloudflare Realtime TURN), keeping DO request usage near zero (disable with `?webrtc=0`).

---

## Step 1: Build `nfsu2.wasm` in WSL 2 (Requires v1.2 NA `SPEED2.EXE`)

You need the **v1.2 North America** `SPEED2.EXE` (`4,800,512` bytes, SHA-256 `f9dd86c054878ce6276beb07c1fd61874f7a1e4bf1f241b084c65b73e24168a7`) alongside `server.dll`.

```bash
wsl -- bash -lc "bash '/mnt/f/PROJECT/BROTATO WEB/nfsu2web/scripts/build-wasm.sh' '/mnt/f/Need for Speed Underground 2/SPEED2.EXE'"
```

This downloads `wasi-sdk 34` automatically if missing, lifts `SPEED2.EXE` + `server.dll`, compiles both WGSL and GLSL ES 3.00 shader translators into `out/web/nfsu2.wasm`, and copies `out/web/nfsu2.wasm` + `out/web/nfsu2.json` back to Windows.

---

## Step 2: Log In & Provision Free-Tier D1 Database (No Card Needed)

Run once in PowerShell from `F:\PROJECT\BROTATO WEB\nfsu2web\cf`:

```powershell
cd "F:\PROJECT\BROTATO WEB\nfsu2web\cf"
npx wrangler login

# Create D1 database (5 GB free) — copy the printed database_id into cf/wrangler.toml
npx wrangler d1 create nfsu2-db
npx wrangler d1 migrations apply nfsu2-db --remote
```

*(Optional, for friends behind strict corporate/mobile NATs — 1 TB/month free):* Create a Realtime TURN token in the Cloudflare Dashboard and set:
```powershell
npx wrangler secret put CF_TURN_TOKEN_ID
npx wrangler secret put CF_TURN_API_TOKEN
```

---

## Step 3: Build Frontend, Stage Chunked Static Assets & Deploy

```powershell
# 1. Build frontend bundle into web/dist
cd "F:\PROJECT\BROTATO WEB\nfsu2web\web"
node build.mjs

# 2. Stage UI + brotli nfsu2.wasm + <=16 MiB chunked game data into cf/public/ (gitignored)
cd "F:\PROJECT\BROTATO WEB\nfsu2web"
node scripts/stage-cf-assets.mjs "F:\Need for Speed Underground 2"

# 3. Deploy Worker + Static Assets + D1 + SQLite Durable Object to *.workers.dev
cd "F:\PROJECT\BROTATO WEB\nfsu2web\cf"
npx wrangler deploy
```

Share the printed `https://nfsu2web.<your-subdomain>.workers.dev` URL with your friends!
