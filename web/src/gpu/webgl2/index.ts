// WebGL2 renderer host adapter: implements the exact Renderer interface from
// web/src/gpu/index.ts so non-DX12 GPUs (DX10 / DX11 / OpenGL 3.3+) run the
// full game seamlessly without Core WebGPU.

import type { GameProcess } from '../../host/process';
import { HostKind } from '../../host/abi';
import * as P from '../proto';
import { C, F } from '../proto';
import type { FromPng, ToPng } from '../png-worker';
import { OtherBuild, type Renderer, type RendererOptions, type RendererStats, type RendererWindow } from '../index';
import { WebGL2Encoder } from './encoder';

/** Probe whether hardware-accelerated WebGL2 is available on this device. */
export function probeWebGL2(): { ok: boolean; renderer: string; software: boolean } {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (!gl) return { ok: false, renderer: '', software: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || 'WebGL2');
    const software = /SwiftShader|llvmpipe|softpipe|Basic Render/i.test(renderer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, renderer, software };
  } catch {
    return { ok: false, renderer: '', software: false };
  }
}

export async function attachWebGL2Renderer(proc: GameProcess, canvas: HTMLCanvasElement, opts: RendererOptions = {}): Promise<Renderer> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('WebGL2 context is not available');

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || 'WebGL2');

  let alive = true;
  let lostSaid = false;
  const onCtxLost = (e: Event) => {
    e.preventDefault();
    if (lostSaid) return;
    lostSaid = true;
    const why = 'WebGL2 context lost';
    log(`[webgl2] ${why}`);
    opts.onLost?.(why);
  };
  canvas.addEventListener('webglcontextlost', onCtxLost);

  const giveUp = (e: unknown): never => {
    canvas.removeEventListener('webglcontextlost', onCtxLost);
    throw e;
  };

  const untilExit = <T>(p: Promise<T>) => Promise.race([
    p,
    proc.exited.then((code): never => { throw new Error(`the game ended (code ${code}) before it registered its graphics`); }),
  ]);
  const [reg, vreg] = await Promise.all([untilExit(proc.registered(HostKind.Gpu)), untilExit(proc.registered(HostKind.Vsync))]).catch(giveUp);
  const mem = proc.memory;
  const i32 = () => new Int32Array(mem.buffer);
  const u32 = () => new Uint32Array(mem.buffer);
  const cw = reg.ptr >>> 2;
  const vw = vreg.ptr >>> 2, vf = vreg.ptr >>> 3;

  {
    const u = u32();
    if (u[cw + C.magic] !== P.GW_MAGIC || u[cw + C.layout] !== P.LAYOUT) {
      const what = `GPU control block mismatch: magic ${u[cw + C.magic].toString(16)} layout ${u[cw + C.layout].toString(16)} (page ${P.LAYOUT.toString(16)})`;
      giveUp(u[cw + C.magic] === P.GW_MAGIC ? new OtherBuild(what) : new Error(what));
    }
    const was = Atomics.load(i32(), cw + C.attached);
    if (was !== 0) giveUp(new Error('game process already has or detached a renderer'));
  }

  const enc = new WebGL2Encoder(gl, mem, reg.ptr, log);
  enc.logShaders = !!opts.logShaders;
  enc.pointTex = !!opts.pixelated;
  enc.aniso = !!opts.aniso;
  for (const id of opts.watchTex ?? []) enc.watchTex.add(id);

  let viewW = canvas.width, viewH = canvas.height;
  const publishView = () => {
    const u = u32();
    u[cw + C.viewW] = viewW;
    u[cw + C.viewH] = viewH;
    u[cw + C.dpr1000] = Math.round(devicePixelRatio * 1000);
    // Tell runtime BC compression availability (S3TC in WebGL2)
    u[cw + C.features] = enc.hasS3TC ? P.FEAT_BC : 0;
  };
  publishView();

  const won = Atomics.compareExchange(i32(), cw + C.attached, 0, P.ATTACHED);
  if (won !== 0) {
    enc.destroy();
    giveUp(new Error('renderer attach race lost'));
  }
  Atomics.notify(i32(), cw + C.attached);

  log(`[webgl2] renderer attached: ${gpuName}, canvas ${canvas.width}x${canvas.height}, s3tc=${enc.hasS3TC}`);

  let pumping = false;
  let frames = 0, encMsTotal = 0, encMsLast = 0, drawsLast = 0, passesLast = 0;
  let imgRect: { x: number; y: number; w: number; h: number } | null = null;
  let winEnc: number[] = [], winDraws = 0, winPasses = 0;
  const markF = new Float32Array(4 * P.MARKS_MAX), markI = new Uint32Array(markF.buffer);
  const dumpWaiters: { name: string; mark?: boolean; resolve: (b: Blob) => void }[] = [];
  const pending = new Set<Promise<unknown>>();

  let pngWorker: Worker | null = null, pngNext = 0;
  const pngWaiting = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();
  const pngWorkerOf = (): Worker => {
    if (!pngWorker) {
      const w = pngWorker = new Worker(new URL('/gpu/png-worker.js', import.meta.url), { type: 'module', name: 'png' });
      w.onmessage = (e: MessageEvent<FromPng>) => {
        const p = pngWaiting.get(e.data.id);
        pngWaiting.delete(e.data.id);
        if ('png' in e.data) p?.resolve(e.data.png); else p?.reject(new Error(e.data.error));
      };
      w.onerror = e => { for (const p of pngWaiting.values()) p.reject(new Error(e.message || 'PNG worker failed')); pngWaiting.clear(); };
    }
    return pngWorker;
  };

  const encodePng = (bgra: Uint8Array, w: number, h: number, mark?: boolean): Promise<Blob> => {
    const px = bgra.buffer.slice(bgra.byteOffset, bgra.byteOffset + bgra.byteLength) as ArrayBuffer;
    const id = pngNext++;
    const msg: ToPng = { id, px, w, h, bpr: w * 4, scale: opts.dumpScale ?? 1, mark };
    return new Promise((resolve, reject) => {
      pngWaiting.set(id, { resolve, reject });
      pngWorkerOf().postMessage(msg, [px]);
    });
  };

  const toneOf = (b: number): Float32Array | null => {
    const U = u32(), fw = cw + C.frame + b * (P.FRAME_BYTES >> 2), at = U[fw + F.k] + P.K_TONE;
    const t = U[at >>> 2] === P.TONE_MAGIC ? new Float32Array(mem.buffer, at + 4, 3) : null;
    const on = !!t && t[0] > 0 && t[1] > 0 && t[2] >= 0 && t[2] < 1 && (Math.abs(t[0] - 1) > 1e-4 || t[1] < 0.9999);
    return on ? t : null;
  };

  const encodeAndPresent = (b: number) => {
    const fw = cw + C.frame + b * (P.FRAME_BYTES >> 2);
    const U = u32();
    const tone = toneOf(b);
    const st = enc.encodeFrame(b);
    imgRect = enc.compositeToCanvas(canvas.width, canvas.height, tone);
    gl.flush();

    frames++;
    encMsTotal += st.encodeMs;
    encMsLast = st.encodeMs;
    drawsLast = st.draws;
    passesLast = st.passes;
    if (winEnc.length < (1 << 17)) winEnc.push(st.encodeMs);
    winDraws += st.draws;
    winPasses += st.passes;

    // Publish stats back to GwCtl
    U[cw + C.framesDone] = frames;
    U[cw + C.stDraws] = enc.totalDraws;
    U[cw + C.stPasses] = enc.totalPasses;
    U[cw + C.stEncUs] = Math.round(encMsTotal * 1000);
    U[cw + C.stErrors] = enc.errors;
    U[cw + C.stPipelines] = enc.pipelinesMade;

    // Quick-chat marks callback
    if (opts.onMarks) {
      const mkAt = (U[fw + F.k] + P.K_MARKS) >>> 2;
      if (U[mkAt] === P.MARKS_MAGIC) {
        const n = Math.min(U[mkAt + 1], P.MARKS_MAX);
        if (n > 0) {
          markF.set(new Float32Array(mem.buffer, (mkAt + 4) * 4, n * 4));
          opts.onMarks(n, markF, markI);
        } else opts.onMarks(0, markF, markI);
      }
    }

    // Texture readback for game LockRect (DVD/magazine covers)
    const rbId = U[fw + F.rbId];
    if (rbId) {
      const I = i32();
      const texId = U[fw + F.rbTex], dst = U[fw + F.rbDst], pitch = U[fw + F.rbPitch], rows = U[fw + F.rbRows];
      if (Atomics.compareExchange(I, cw + C.rbWant, rbId, rbId | P.RB_FLAG) === rbId) {
        const rb = enc.readbackBgra(texId);
        let ok = false;
        if (rb && dst + pitch * Math.min(rows, rb.h) <= mem.buffer.byteLength) {
          const m = new Uint8Array(mem.buffer), n = Math.min(pitch, rb.w * 4);
          for (let y = 0; y < Math.min(rows, rb.h); y++) m.set(rb.data.subarray(y * rb.w * 4, y * rb.w * 4 + n), dst + y * pitch);
          ok = true;
        }
        Atomics.store(I, cw + C.rbDone, ok ? rbId : rbId | P.RB_FLAG);
        Atomics.notify(I, cw + C.rbDone);
      }
    }

    // Screenshot / dump requests
    if (dumpWaiters.length) {
      const waiters = dumpWaiters.splice(0);
      const rb = enc.readbackBgra(0);
      if (rb) {
        for (const wt of waiters) {
          const job = encodePng(rb.data, rb.w, rb.h, wt.mark)
            .then(png => { wt.resolve(png); })
            .catch(() => wt.resolve(new Blob([], { type: 'image/png' })));
          pending.add(job);
          job.finally(() => pending.delete(job));
        }
      } else {
        for (const wt of waiters) wt.resolve(new Blob([], { type: 'image/png' }));
      }
    }
  };

  const pump = () => {
    if (!alive || pumping) return;
    pumping = true;
    try {
      for (;;) {
        enc.views();
        const I = i32(), U = u32();
        const head = Atomics.load(I, cw + C.rqHead) >>> 0;
        const s = Atomics.load(I, cw + C.state), r = s & 3, e = (s >> 2) & 3;
        const take = !!r && !e;
        if (take) {
          if (Atomics.compareExchange(I, cw + C.state, s, s | (r << 2)) !== s) continue;
          Atomics.notify(I, cw + C.state);
        }
        const limit = r && !e ? U[cw + C.frame + (r - 1) * (P.FRAME_BYTES >> 2) + F.rqEnd] : head;
        try { enc.drain(limit); } catch (x) {
          enc.errors++;
          log(`[webgl2] resource drain error: ${x}`);
          if (take) { Atomics.store(I, cw + C.state, s); Atomics.notify(I, cw + C.state); }
          break;
        }
        if (!take) break;
        try { encodeAndPresent(r - 1); } catch (x) {
          enc.errors++;
          log(`[webgl2] frame encode error: ${x}`);
        }
        Atomics.store(I, cw + C.state, 0);
        Atomics.notify(I, cw + C.state);
      }
    } finally { pumping = false; }
  };

  // Display clock (rAF)
  const RATES = [24, 30, 48, 50, 60, 72, 75, 90, 96, 100, 120, 144, 165, 180, 240, 360];
  const snap = (hzRaw: number) => { for (const r of RATES) if (Math.abs(hzRaw / r - 1) < 0.025) return r; return Math.round(hzRaw); };
  const iv: number[] = [];
  let lastT = 0, hz = 0, cand = 0, candSince = 0, rafHz = 0, rafId = 0;
  const raf = (t: number) => {
    if (!alive) return;
    if (lastT) {
      const d = t - lastT;
      if (d > 2 && d < 100) { iv.push(d); if (iv.length > 120) iv.shift(); }
    }
    lastT = t;
    if (iv.length >= 30) {
      const sp: number[] = [];
      for (let i = 3; i < iv.length; i++) sp.push((iv[i] + iv[i - 1] + iv[i - 2] + iv[i - 3]) / 4);
      sp.sort((a, b) => a - b);
      const med = sp[sp.length >> 1];
      rafHz = 1000 / med;
      const h = snap(rafHz);
      if (h !== cand) { cand = h; candSince = t; }
      if (cand !== hz && (hz === 0 || t - candSince >= 500)) {
        log(`[webgl2] display ${cand} Hz (rAF median ${med.toFixed(3)} ms)`);
        hz = cand;
        Atomics.store(i32(), vw + P.V.hz, hz);
      }
      const per = RATES.includes(hz) ? 1000 / hz : med;
      const I = i32(), Fv = new Float64Array(mem.buffer);
      Atomics.add(I, vw + P.V.seq, 1);
      Fv[vf + P.V.tsF64] = performance.timeOrigin + t;
      Fv[vf + P.V.periodF64] = per;
      Atomics.add(I, vw + P.V.seq, 1);
      Atomics.store(I, vw + P.V.visible, document.visibilityState === 'visible' ? 1 : 0);
      Atomics.add(I, vw + P.V.tick, 1);
      Atomics.notify(I, vw + P.V.tick);
    }
    pump();
    rafId = requestAnimationFrame(raf);
  };
  rafId = requestAnimationFrame(raf);

  // Doorbell wakeup
  (async () => {
    while (alive) {
      const I = i32(), b = Atomics.load(I, cw + C.bell);
      pump();
      const w = Atomics.waitAsync(I, cw + C.bell, b, 500);
      if (w.async) await w.value;
    }
  })();

  // Resize observer
  const ro = new ResizeObserver(entries => {
    for (const e of entries) {
      const d = e.devicePixelContentBoxSize?.[0];
      const w = d ? d.inlineSize : Math.round(e.contentRect.width * devicePixelRatio);
      const h = d ? d.blockSize : Math.round(e.contentRect.height * devicePixelRatio);
      if (!(w > 0 && h > 0)) continue;
      viewW = w; viewH = h;
      if (opts.autoSize && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
    }
    publishView();
  });
  try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.observe(canvas); }

  return {
    backend: 'webgl2',
    stats: (): RendererStats => ({
      frames, draws: enc.totalDraws, passes: enc.totalPasses, pipelines: enc.pipelinesMade, pipelinesWarm: 0, errors: enc.errors,
      pipelineMs: 0, pipelineMsMax: 0, gpuMsAvg: 0, gpuMsMax: 0,
      encodeMsAvg: frames ? encMsTotal / frames : 0, encodeMsLast: encMsLast, drawsLast, passesLast, rafHz, inFlight: 0,
      dumps: u32()[cw + C.dumpsDone], missingTarget: enc.missingTarget, conflicts: enc.conflicts, zMismatch: enc.zMismatch, noVs: enc.noVs,
      direct: 0, screenReadFirst: 0, slotWaits: 0, slotWaitMsMax: 0, pokes: 0, unshown: 0,
      texBytes: enc.texBytes, unpackBytes: enc.unpackBytes, astcBytes: 0,
    }),
    window: (reset = false): RendererWindow => {
      const pct = (a: number[]) => {
        if (!a.length) return [];
        const s = a.slice().sort((x, y) => x - y), q = (p: number) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
        return [q(0.5), q(0.95), q(0.99), s[s.length - 1]];
      };
      const n = winEnc.length;
      const w: RendererWindow = { frames: n, encodeMs: pct(winEnc), gpuMs: [], drawsAvg: n ? winDraws / n : 0, passesAvg: n ? winPasses / n : 0, callsAvg: {} };
      if (reset) { winEnc = []; winDraws = 0; winPasses = 0; }
      return w;
    },
    doneMs: () => [],
    dump: (name: string, mark?: boolean) => new Promise<Blob>(resolve => dumpWaiters.push({ name, mark, resolve })),
    photo: (name: string, mark?: boolean) => new Promise<Blob>(resolve => dumpWaiters.push({ name, mark, resolve })),
    photoLook: () => {},
    photoProgress: () => ({ n: 0, target: 0 }),
    imageRect: () => imgRect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height },
    flush: async () => { while (pending.size) await Promise.allSettled([...pending]); },
    detach: () => {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onCtxLost);
      const I = i32();
      Atomics.store(I, cw + C.attached, P.DETACHED);
      for (const w of [C.attached, C.state, C.rqTail, C.bell]) Atomics.notify(I, cw + w);
      for (const d of dumpWaiters.splice(0)) d.resolve(new Blob([], { type: 'image/png' }));
      void Promise.allSettled([...pending]).then(() => pngWorker?.terminate());
      enc.destroy();
      log(`[webgl2] renderer detached after ${frames} frames`);
    },
  };
}
