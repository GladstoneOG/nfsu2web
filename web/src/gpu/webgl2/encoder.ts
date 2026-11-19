// WebGL2 encoder: drop-in non-DX12 fallback for web/src/gpu/encoder.ts.
//
// Consumes the exact same shared-memory GwCtl / GwFrame / GwDraw / GwCmd stream
// produced by runtime/web/gpu_web.c (when NFSU2_RENDERER=webgl2) and draws on
// any DX10 / DX11 / OpenGL 3.3+ GPU (e.g. Intel HD 4000/4400/4600, older GeForce
// & Radeon cards, and browsers without Core WebGPU).
//
// Core architectural choices:
//   - Vertex arenas (TVert, raw, persistent pool) are stored in 4096-wide R32UI
//     2D textures (u_vb at texture unit 4) for 100% bit-exact D3D9 vertex pulling
//     via texelFetch without SSBOs.
//   - The persistent pool also mirrors index data into a WebGL ELEMENT_ARRAY_BUFFER
//     for indexed draws (BaseVertexIndex is emulated via `uniform int u_vbase`).
//   - All game render targets (including the offscreen back buffer) render into
//     FBOs with u_yflip = -1.0 and frontFace = gl.CCW so D3D9 row 0 (top-left)
//     lands at GL texel row 0: viewports, scissors, post-processing UVs, and
//     reflections work 1:1 without per-pass Y flips. Only the final composite
//     blit to the default canvas framebuffer flips upright (u_flipY = +1.0).
//   - VS constants bind a 16 KB std140 UBO window (1024 vec4s, guaranteed by the
//     WebGL2 spec) with per-draw row index `uniform uint u_kb`.

import * as P from '../proto';
import { D, F, Kind, Op } from '../proto';
import { PSCUBE, VSPAR_SIZE, PSPAR_SIZE, HLPAR_SIZE } from '../shader-abi';
import { unpackDxt } from '../dxt';
import { drawViewport, drawScissor } from '../viewport';
import type { GameMemory } from '../../host/memory';
import type { EncodeStats } from '../encoder';
import { GL_COPY_FS, GL_COPY_VS, GL_FF_FS, GL_REGION_CLEAR_FS, GL_REGION_CLEAR_VS, GL_TONE_FS, GL_TVERT_VS } from './glsl';

const VB_WIDTH = 4096;
const GL_KWIN_SIZE = 16384; // 1024 vec4s — guaranteed MAX_UNIFORM_BLOCK_SIZE >= 16384 in WebGL2
const enum Src { TVert = 0, Raw = 1, Pool = 2 }

interface GLTex {
  serial: number;
  tex: WebGLTexture;
  fmt: number;
  w: number;
  h: number;
  levels: number;
  cube: boolean;
  rt: boolean;
  bc: boolean;
  unpack: boolean;
  expandA8: boolean;
  bytes: number;
}

interface CompiledProg {
  prog: WebGLProgram;
  uKb: WebGLUniformLocation | null;
  uVbase: WebGLUniformLocation | null;
  uYflip: WebGLUniformLocation | null;
  hasHL: boolean;
}

/** 4096-wide R32UI 2D texture backing a byte-addressed vertex arena. */
class VertexTex {
  tex: WebGLTexture;
  rows = 0;
  byteCap = 0;
  private cpu = new Uint32Array(0);

  constructor(private gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    this.ensureBytes(65536);
  }

  ensureBytes(needBytes: number): void {
    const words = Math.ceil(Math.max(needBytes, 16384) / 4);
    const needRows = Math.max(1, Math.ceil(words / VB_WIDTH));
    if (needRows <= this.rows) return;
    const newRows = Math.max(needRows, this.rows + (this.rows >> 1));
    const nextCpu = new Uint32Array(newRows * VB_WIDTH);
    if (this.cpu.length) nextCpu.set(this.cpu);
    this.cpu = nextCpu;
    this.rows = newRows;
    this.byteCap = newRows * VB_WIDTH * 4;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, VB_WIDTH, newRows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, this.cpu);
  }

  upload(byteOffset: number, src: Uint8Array, byteLen: number): void {
    if (byteLen <= 0) return;
    const alignedLen = (byteLen + 3) & ~3;
    this.ensureBytes(byteOffset + alignedLen);
    const dstBytes = new Uint8Array(this.cpu.buffer, byteOffset, byteLen);
    dstBytes.set(src.subarray(0, byteLen));
    if (alignedLen > byteLen) new Uint8Array(this.cpu.buffer, byteOffset + byteLen, alignedLen - byteLen).fill(0);
    const w0 = byteOffset >>> 2;
    const w1 = ((byteOffset + alignedLen) >>> 2) - 1;
    const r0 = w0 >>> 12;
    const r1 = w1 >>> 12;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, VB_WIDTH, r1 - r0 + 1, gl.RED_INTEGER, gl.UNSIGNED_INT, this.cpu, r0 * VB_WIDTH);
  }

  destroy(): void {
    this.gl.deleteTexture(this.tex);
  }
}

/** Swap B and R channels in-place or into dst (D3D9 BGRA -> WebGL2 RGBA). */
function bgraToRgba(src: Uint8Array, srcOff: number, pitch: number, w: number, h: number, dst: Uint8Array): Uint8Array {
  let di = 0;
  for (let y = 0; y < h; y++) {
    let si = srcOff + y * pitch;
    for (let x = 0; x < w; x++) {
      dst[di]     = src[si + 2];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si];
      dst[di + 3] = src[si + 3];
      si += 4;
      di += 4;
    }
  }
  return dst;
}

/** Prepend #define macros immediately after `#version 300 es\n`. */
function injectDefines(src: string, defines: string): string {
  const nl = src.indexOf('\n');
  if (nl < 0) return defines + src;
  return src.slice(0, nl + 1) + defines + src.slice(nl + 1);
}

const CUBE_FACES = [
  0x8515, // TEXTURE_CUBE_MAP_POSITIVE_X
  0x8516, // NEGATIVE_X
  0x8517, // POSITIVE_Y
  0x8518, // NEGATIVE_Y
  0x8519, // POSITIVE_Z
  0x851A, // NEGATIVE_Z
];

export class WebGL2Encoder {
  readonly gl: WebGL2RenderingContext;
  private memory: GameMemory;
  private sab!: SharedArrayBuffer;
  private u8!: Uint8Array;
  private u32!: Uint32Array;
  private i32!: Int32Array;
  private f32!: Float32Array;
  private ctlW: number;
  private log: (s: string) => void;

  // extensions & limits
  private s3tc: WEBGL_compressed_texture_s3tc | null;
  private anisoExt: EXT_texture_filter_anisotropic | null;
  private maxAniso = 1;
  private uboAlign: number;
  private pSlot: number;

  // resources
  private tex: (GLTex | undefined)[] = [];
  private serial = 1;
  private white!: GLTex;
  private whiteCube!: GLTex;
  private zRb: (WebGLRenderbuffer | undefined)[] = [];
  private zSize: ([number, number] | undefined)[] = [];
  private zpend = new Uint8Array(64);
  private zpendV = new Float32Array(64);
  private fbos = new Map<string, WebGLFramebuffer>();
  private samplers = new Map<number, WebGLSampler>();

  // vertex arenas & UBOs
  private vao: WebGLVertexArrayObject;
  private tvTex: VertexTex;
  private rawTex: VertexTex;
  private poolTex: VertexTex;
  private poolIdxBuf: WebGLBuffer;
  private poolIdxCap = 0;
  private poolIdxCpu = new Uint8Array(0);
  private kBuf: WebGLBuffer;
  private kCap = 0;
  private pBuf: WebGLBuffer;
  private pCap = 0;
  private pStage = new Float32Array(192 * 1024);

  // shaders & programs
  private vsSrc = new Map<number, string>();
  private psSrc = new Map<number, string>();
  private vsCompiled = new Map<number, WebGLShader | null>();
  private psCompiled = new Map<string, WebGLShader | null>();
  private progs = new Map<string, CompiledProg | null>();
  private copyProg!: { prog: WebGLProgram; uRect: WebGLUniformLocation | null; uFlipY: WebGLUniformLocation | null };
  private copyOpaqueProg!: { prog: WebGLProgram; uRect: WebGLUniformLocation | null; uFlipY: WebGLUniformLocation | null };
  private toneProg!: { prog: WebGLProgram; uRect: WebGLUniformLocation | null; uFlipY: WebGLUniformLocation | null; uTone: WebGLUniformLocation | null };
  private regionClearProg!: { prog: WebGLProgram; uZ: WebGLUniformLocation | null; uCol: WebGLUniformLocation | null };
  private linearSmp!: WebGLSampler;
  private nearestSmp!: WebGLSampler;

  // back buffer
  bbTex: WebGLTexture | null = null;
  bbW = 0;
  bbH = 0;
  private unpackBuf = new Uint8Array(0);
  private swizzleBuf = new Uint8Array(0);

  // options & stats
  logShaders = false;
  pointTex = false;
  aniso = false;
  watchTex = new Set<number>();
  totalDraws = 0;
  totalPasses = 0;
  pipelinesMade = 0;
  missingTarget = 0;
  noVs = 0;
  zMismatch = 0;
  conflicts = 0;
  errors = 0;
  texBytes = 0;
  unpackBytes = 0;
  texMade = 0;
  texMadeBytes = 0;
  texFreed = 0;
  texFreedBytes = 0;

  constructor(gl: WebGL2RenderingContext, memory: GameMemory, ctlPtr: number, log: (s: string) => void) {
    this.gl = gl;
    this.memory = memory;
    this.ctlW = ctlPtr >>> 2;
    this.log = log;
    this.views();

    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
      ?? gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
      ?? gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (this.anisoExt) this.maxAniso = gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;

    this.uboAlign = Math.max(256, gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) || 256);
    this.pSlot = Math.ceil(PSPAR_SIZE / this.uboAlign) * this.uboAlign;

    // Empty VAO (all vertex data is pulled in the vertex shader via gl_VertexID + texelFetch)
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.tvTex = new VertexTex(gl);
    this.rawTex = new VertexTex(gl);
    this.poolTex = new VertexTex(gl);

    this.poolIdxBuf = gl.createBuffer()!;
    this.growPoolIdx(65536);

    this.kBuf = gl.createBuffer()!;
    this.growUbo('k', 1 << 20);
    this.pBuf = gl.createBuffer()!;
    this.growUbo('p', 1 << 20);

    this.white = this.makeWhite(false);
    this.whiteCube = this.makeWhite(true);

    this.linearSmp = gl.createSampler()!;
    gl.samplerParameteri(this.linearSmp, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.linearSmp, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.linearSmp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.linearSmp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.nearestSmp = gl.createSampler()!;
    gl.samplerParameteri(this.nearestSmp, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.nearestSmp, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.nearestSmp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.nearestSmp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.vsSrc.set(0, GL_TVERT_VS);
    this.psSrc.set(0, GL_FF_FS(false));
    this.psSrc.set(PSCUBE, GL_FF_FS(true));

    this.initBuiltins();
  }

  get hasS3TC(): boolean { return !!this.s3tc; }

  private initBuiltins(): void {
    const gl = this.gl;
    const mk = (vs: string, fs: string, label: string) => {
      const p = this.linkSimple(vs, fs, label);
      gl.useProgram(p);
      const uSrc = gl.getUniformLocation(p, 'u_src');
      if (uSrc) gl.uniform1i(uSrc, 0);
      return p;
    };
    const cp = mk(GL_COPY_VS, GL_COPY_FS(false), 'gl-copy');
    this.copyProg = { prog: cp, uRect: gl.getUniformLocation(cp, 'u_rect'), uFlipY: gl.getUniformLocation(cp, 'u_flipY') };
    const co = mk(GL_COPY_VS, GL_COPY_FS(true), 'gl-copy-opaque');
    this.copyOpaqueProg = { prog: co, uRect: gl.getUniformLocation(co, 'u_rect'), uFlipY: gl.getUniformLocation(co, 'u_flipY') };
    const tn = mk(GL_COPY_VS, GL_TONE_FS, 'gl-tone');
    this.toneProg = {
      prog: tn,
      uRect: gl.getUniformLocation(tn, 'u_rect'),
      uFlipY: gl.getUniformLocation(tn, 'u_flipY'),
      uTone: gl.getUniformLocation(tn, 'u_tone'),
    };
    const rc = this.linkSimple(GL_REGION_CLEAR_VS, GL_REGION_CLEAR_FS, 'gl-region-clear');
    this.regionClearProg = { prog: rc, uZ: gl.getUniformLocation(rc, 'u_z'), uCol: gl.getUniformLocation(rc, 'u_col') };
  }

  private compileShader(type: number, src: string, label: string): WebGLShader | null {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh) || 'unknown compile error';
      this.errors++;
      if (this.errors <= 25) this.log(`[webgl2] shader ${label} compile error: ${info}`);
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  private linkSimple(vsSrc: string, fsSrc: string, label: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc, `${label}.vs`);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc, `${label}.fs`);
    const p = gl.createProgram()!;
    if (vs) gl.attachShader(p, vs);
    if (fs) gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(p) || 'unknown link error';
      this.errors++;
      this.log(`[webgl2] program ${label} link error: ${info}`);
    }
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return p;
  }

  views(): void {
    const b = this.memory.buffer as unknown as SharedArrayBuffer;
    if (b === this.sab) return;
    this.sab = b;
    this.u8 = new Uint8Array(b);
    this.u32 = new Uint32Array(b);
    this.i32 = new Int32Array(b);
    this.f32 = new Float32Array(b);
  }

  private makeWhite(cube: boolean): GLTex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(target, tex);
    const px = new Uint8Array([255, 255, 255, 255]);
    if (cube) {
      for (let f = 0; f < 6; f++) gl.texImage2D(CUBE_FACES[f], 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { serial: 0, tex, fmt: P.Fmt.A8R8G8B8, w: 1, h: 1, levels: 1, cube, rt: false, bc: false, unpack: false, expandA8: false, bytes: 0 };
  }

  private growPoolIdx(need: number): void {
    const size = Math.ceil(Math.max(need, 65536) / 65536) * 65536;
    if (size <= this.poolIdxCap) return;
    const nextCpu = new Uint8Array(size);
    if (this.poolIdxCpu.length) nextCpu.set(this.poolIdxCpu);
    this.poolIdxCpu = nextCpu;
    this.poolIdxCap = size;
    const gl = this.gl;
    // IMPORTANT: Never bind an ELEMENT_ARRAY_BUFFER to COPY_READ/COPY_WRITE in WebGL2!
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.poolIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.poolIdxCpu, gl.DYNAMIC_DRAW);
  }

  private growUbo(which: 'k' | 'p', need: number): void {
    const cur = which === 'k' ? this.kCap : this.pCap;
    if (need <= cur) return;
    const size = Math.ceil((need * 1.25) / 262144) * 262144;
    const gl = this.gl;
    const buf = which === 'k' ? this.kBuf : this.pBuf;
    gl.bindBuffer(gl.UNIFORM_BUFFER, buf);
    gl.bufferData(gl.UNIFORM_BUFFER, size, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    if (which === 'k') this.kCap = size;
    else this.pCap = size;
  }

  // ------------------------------------------------------------ resource queue
  drain(limit: number): number {
    const c = this.ctlW, u32 = this.u32;
    const cap = u32[c + P.C.rqCap], base = u32[c + P.C.rqPtr];
    let tail = u32[c + P.C.rqTail];
    if (!(base + cap <= this.u8.length)) return tail;
    let n = 0;
    while (((limit - tail) | 0) > 0) {
      const p = base + (tail & (cap - 1)), w = p >>> 2;
      const op = u32[w], len = u32[w + 1];
      if (len < 16 || len > cap) { this.log(`[webgl2] corrupt resource queue record op=${op} len=${len} at ${tail}`); tail = limit; break; }
      const a0 = u32[w + 2], a1 = u32[w + 3], a2 = u32[w + 4], a3 = u32[w + 5], a4 = u32[w + 6], a5 = u32[w + 7];
      const data = p + P.CMD_HDR;
      switch (op) {
        case Op.Pad: break;
        case Op.TexCreate: this.texCreate(a0, a1, a2, a3, a4, a5); break;
        case Op.TexUpload: this.texUpload(a0, a1 & 0xFFFF, a1 >>> 16, a2, a3, a4, a5, data); break;
        case Op.TexFree: this.texFree(a0); break;
        case Op.PoolGrow:
          this.poolTex.ensureBytes(a0);
          this.growPoolIdx(a0);
          break;
        case Op.PoolWrite: {
          const slice = this.u8.subarray(data, data + a1);
          this.poolTex.upload(a0, slice, a1);
          if (a0 + a1 > this.poolIdxCap) this.growPoolIdx(a0 + a1);
          this.poolIdxCpu.set(slice, a0);
          const gl = this.gl;
          gl.bindVertexArray(this.vao);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.poolIdxBuf);
          gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, a0, slice);
          break;
        }
        case Op.ShaderVs:
        case Op.ShaderPs: {
          const text = new TextDecoder().decode(this.u8.slice(data, data + Math.max(0, a1 - 1)));
          if (op === Op.ShaderVs) {
            this.vsSrc.set(a0, text);
            this.vsCompiled.delete(a0);
          } else {
            this.psSrc.set(a0, text);
            this.psCompiled.delete(`${a0}:0`);
            this.psCompiled.delete(`${a0}:1`);
          }
          if (this.logShaders) this.log(`[webgl2 shader ${op === Op.ShaderVs ? 'vs' : 'ps'}_${a0}]\n${text}\n[/shader]`);
          break;
        }
        case Op.ZForget:
          if (a0 < 64 && this.zRb[a0]) {
            this.gl.deleteRenderbuffer(this.zRb[a0]!);
            this.zRb[a0] = undefined;
            this.zSize[a0] = undefined;
            this.dropFbosForZ(a0);
          }
          break;
        case Op.BbSamples: break; // MSAA skipped in WebGL2 for fast DX10/11 compatibility
        case Op.SkinHq: break;    // HQ vinyl AVIF compute path disabled in WebGL2
        default: break;
      }
      tail = (tail + len) >>> 0;
      if (++n % 64 === 0) {
        Atomics.store(this.i32, c + P.C.rqTail, tail | 0);
        Atomics.notify(this.i32, c + P.C.rqTail);
      }
    }
    Atomics.store(this.i32, c + P.C.rqTail, tail | 0);
    Atomics.notify(this.i32, c + P.C.rqTail);
    return tail;
  }

  private dropFbosForTex(id: number): void {
    const prefix = `${id}:`;
    for (const [k, fb] of this.fbos) {
      if (k.startsWith(prefix)) { this.gl.deleteFramebuffer(fb); this.fbos.delete(k); }
    }
  }

  private dropFbosForZ(zid: number): void {
    const suffix = `:${zid}`;
    for (const [k, fb] of this.fbos) {
      if (k.endsWith(suffix)) { this.gl.deleteFramebuffer(fb); this.fbos.delete(k); }
    }
  }

  private texCreate(id: number, w: number, h: number, levels: number, fmt: number, flags: number): void {
    this.texFree(id);
    const gl = this.gl;
    const isDxt = fmt === P.Fmt.DXT1 || fmt === P.Fmt.DXT3 || fmt === P.Fmt.DXT5;
    const bc = isDxt && !!this.s3tc && (w & 3) === 0 && (h & 3) === 0;
    const unpack = isDxt && !bc;
    const expandA8 = fmt === P.Fmt.A8;
    const cube = (flags & P.TF_CUBE) !== 0;
    const rt = (flags & P.TF_RT) !== 0 && !isDxt && fmt !== P.Fmt.A8 && fmt !== P.Fmt.P8;
    const maxLv = Math.floor(Math.log2(Math.max(w, h))) + 1;
    levels = Math.max(1, Math.min(levels, maxLv));

    const tex = gl.createTexture()!;
    const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(target, tex);
    gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, levels - 1);

    if (rt) {
      for (let l = 0; l < levels; l++) {
        const lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
        if (cube) {
          for (let f = 0; f < 6; f++) gl.texImage2D(CUBE_FACES[f], l, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
      }
    }

    const bpp = bc ? (fmt === P.Fmt.DXT1 ? 0.5 : 1) : fmt === P.Fmt.P8 ? 1 : 4;
    let bytes = 0;
    for (let l = 0; l < levels; l++) {
      let lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
      if (bc) { lw = (lw + 3) & ~3; lh = (lh + 3) & ~3; }
      bytes += lw * lh * bpp;
    }
    bytes *= cube ? 6 : 1;
    this.texBytes += bytes;
    if (unpack) this.unpackBytes += bytes;
    this.texMade++;
    this.texMadeBytes += bytes;

    this.tex[id] = { serial: this.serial++, tex, fmt, w, h, levels, cube, rt, bc, unpack, expandA8, bytes };
  }

  private texFree(id: number): void {
    const t = this.tex[id];
    if (!t) return;
    this.dropFbosForTex(id);
    this.gl.deleteTexture(t.tex);
    this.texBytes -= t.bytes;
    if (t.unpack) this.unpackBytes -= t.bytes;
    this.texFreed++;
    this.texFreedBytes += t.bytes;
    this.tex[id] = undefined;
  }

  private texUpload(id: number, level: number, face: number, lw: number, lh: number, pitch: number, rows: number, data: number): void {
    const t = this.tex[id];
    if (!t || level >= t.levels) return;
    const gl = this.gl;
    const bindTarget = t.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    const upTarget = t.cube ? CUBE_FACES[Math.min(face, 5)] : gl.TEXTURE_2D;
    gl.bindTexture(bindTarget, t.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    if (t.bc && this.s3tc) {
      const bpb = t.fmt === P.Fmt.DXT1 ? 8 : 16;
      const bw = Math.max(1, (lw + 3) >> 2), bh = Math.max(1, (lh + 3) >> 2);
      const tightPitch = bw * bpb;
      let src: Uint8Array;
      if (pitch === tightPitch) {
        src = this.u8.subarray(data, data + tightPitch * bh);
      } else {
        if (this.unpackBuf.length < tightPitch * bh) this.unpackBuf = new Uint8Array(tightPitch * bh);
        for (let y = 0; y < bh; y++) this.unpackBuf.set(this.u8.subarray(data + y * pitch, data + y * pitch + tightPitch), y * tightPitch);
        src = this.unpackBuf.subarray(0, tightPitch * bh);
      }
      const cf = t.fmt === P.Fmt.DXT1 ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
        : t.fmt === P.Fmt.DXT3 ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT
        : this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT;
      gl.compressedTexImage2D(upTarget, level, cf, lw, lh, 0, src);
      return;
    }

    if (t.unpack) {
      const need = lw * lh * 4;
      if (this.unpackBuf.length < need) this.unpackBuf = new Uint8Array(need);
      if (this.swizzleBuf.length < need) this.swizzleBuf = new Uint8Array(need);
      // dxt.ts unpacks to BGRA; swap to RGBA for WebGL2
      const bgra = unpackDxt(t.fmt, this.u8, data, pitch, lw, lh, this.unpackBuf);
      bgraToRgba(bgra, 0, lw * 4, lw, lh, this.swizzleBuf);
      gl.texImage2D(upTarget, level, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.swizzleBuf.subarray(0, need));
      return;
    }

    if (t.expandA8) {
      const need = lw * lh * 4;
      if (this.swizzleBuf.length < need) this.swizzleBuf = new Uint8Array(need);
      const out = this.swizzleBuf;
      out.fill(0, 0, need);
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) out[(y * lw + x) * 4 + 3] = this.u8[data + y * pitch + x];
      gl.texImage2D(upTarget, level, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, out.subarray(0, need));
      return;
    }

    if (t.fmt === P.Fmt.P8) {
      const need = lw * lh;
      let src: Uint8Array;
      if (pitch === lw) src = this.u8.subarray(data, data + need);
      else {
        if (this.swizzleBuf.length < need) this.swizzleBuf = new Uint8Array(need);
        for (let y = 0; y < lh; y++) this.swizzleBuf.set(this.u8.subarray(data + y * pitch, data + y * pitch + lw), y * lw);
        src = this.swizzleBuf.subarray(0, need);
      }
      gl.texImage2D(upTarget, level, gl.R8, lw, lh, 0, gl.RED, gl.UNSIGNED_BYTE, src);
      return;
    }

    // A8R8G8B8 / X8R8G8B8 -> BGRA in memory -> RGBA8 in WebGL2
    const need = lw * lh * 4;
    if (this.swizzleBuf.length < need) this.swizzleBuf = new Uint8Array(need);
    bgraToRgba(this.u8, data, pitch, lw, lh, this.swizzleBuf);
    gl.texImage2D(upTarget, level, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.swizzleBuf.subarray(0, need));
  }

  private sampler(k: number): WebGLSampler {
    let s = this.samplers.get(k);
    if (s) return s;
    const gl = this.gl;
    s = gl.createSampler()!;
    const mn = k & 3, mg = (k >> 2) & 3, mp = (k >> 4) & 3, au = (k >> 6) & 7, av = (k >> 9) & 7, al = (k >> 12) & 7;
    const aniso = (mn === 3 || mg === 3) ? Math.min(this.maxAniso, 1 << al) : 1;
    const addr = (a: number) => a === 2 ? gl.MIRRORED_REPEAT : (a === 3 || a === 4) ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    const minF = mp === 0
      ? (mn === 1 ? gl.NEAREST : gl.LINEAR)
      : mp === 1
        ? (mn === 1 ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_NEAREST)
        : (mn === 1 ? gl.NEAREST_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_LINEAR);
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, aniso > 1 ? gl.LINEAR_MIPMAP_LINEAR : minF);
    gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, aniso > 1 ? gl.LINEAR : (mg === 1 ? gl.NEAREST : gl.LINEAR));
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, addr(au));
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, addr(av));
    if (mp === 0) gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, 0);
    if (aniso > 1 && this.anisoExt) gl.samplerParameterf(s, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
    this.samplers.set(k, s);
    return s;
  }

  private getProgram(vsid: number, psid: number, nd: boolean): CompiledProg | null {
    const pk = `${vsid}:${psid}:${nd ? 1 : 0}`;
    const hit = this.progs.get(pk);
    if (hit !== undefined) return hit;

    const gl = this.gl;
    let vs = this.vsCompiled.get(vsid);
    if (vs === undefined) {
      const src = this.vsSrc.get(vsid);
      vs = src ? this.compileShader(gl.VERTEX_SHADER, src, `vs_${vsid}`) : null;
      this.vsCompiled.set(vsid, vs);
    }
    const psk = `${psid}:${nd ? 1 : 0}`;
    let fs = this.psCompiled.get(psk);
    if (fs === undefined) {
      const src = this.psSrc.get(psid);
      if (src) {
        const patched = injectDefines(src, `#define ALPHA_FUNC ${nd ? '8u' : '7u'}\n#define PS20_TEXCOORD true\n`);
        fs = this.compileShader(gl.FRAGMENT_SHADER, patched, `ps_${psid}_${nd ? 'nd' : 'at'}`);
      } else fs = null;
      this.psCompiled.set(psk, fs);
    }
    if (!vs || !fs) { this.progs.set(pk, null); return null; }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog) || 'link failed';
      this.errors++;
      if (this.errors <= 25) this.log(`[webgl2] program ${pk} link error: ${info}`);
      gl.deleteProgram(prog);
      this.progs.set(pk, null);
      return null;
    }

    gl.useProgram(prog);
    const vsWinIdx = gl.getUniformBlockIndex(prog, 'VSWin');
    if (vsWinIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, vsWinIdx, 0);
    const psParIdx = gl.getUniformBlockIndex(prog, 'PSPar');
    if (psParIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, psParIdx, 1);
    const hlParIdx = gl.getUniformBlockIndex(prog, 'HLPar');
    const hasHL = hlParIdx !== gl.INVALID_INDEX;
    if (hasHL) gl.uniformBlockBinding(prog, hlParIdx, 2);

    for (let k = 0; k < 4; k++) {
      const loc = gl.getUniformLocation(prog, `tex${k}`);
      if (loc) gl.uniform1i(loc, k);
    }
    const vbLoc = gl.getUniformLocation(prog, 'u_vb');
    if (vbLoc) gl.uniform1i(vbLoc, 4);

    const cp: CompiledProg = {
      prog,
      uKb: gl.getUniformLocation(prog, 'u_kb'),
      uVbase: gl.getUniformLocation(prog, 'u_vbase'),
      uYflip: gl.getUniformLocation(prog, 'u_yflip'),
      hasHL,
    };
    this.progs.set(pk, cp);
    this.pipelinesMade++;
    return cp;
  }

  private ensureBackBuffer(w: number, h: number): void {
    if (this.bbTex && this.bbW === w && this.bbH === h) return;
    const gl = this.gl;
    this.dropFbosForTex(0);
    if (this.bbTex) gl.deleteTexture(this.bbTex);
    this.bbTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.bbTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.bbW = w;
    this.bbH = h;
  }

  private getDepthRb(zid: number, w: number, h: number): { rb: WebGLRenderbuffer | null; fresh: boolean } {
    if (!zid || zid >= 64) return { rb: null, fresh: false };
    const gl = this.gl;
    const cur = this.zRb[zid], sz = this.zSize[zid];
    if (cur && sz && sz[0] === w && sz[1] === h) return { rb: cur, fresh: false };
    if (!cur || zid === 1) {
      if (cur) { gl.deleteRenderbuffer(cur); this.dropFbosForZ(zid); }
      const rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
      this.zRb[zid] = rb;
      this.zSize[zid] = [w, h];
      return { rb, fresh: true };
    }
    this.zMismatch++;
    return { rb: null, fresh: false };
  }

  private getFbo(texId: number, face: number, tex: WebGLTexture, cube: boolean, zid: number, zrb: WebGLRenderbuffer | null): WebGLFramebuffer {
    const k = `${texId}:${face}:${zrb ? zid : 0}`;
    let fb = this.fbos.get(k);
    if (fb) return fb;
    const gl = this.gl;
    fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (cube) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, CUBE_FACES[Math.min(face, 5)], tex, 0);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (zrb) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, zrb);
    this.fbos.set(k, fb);
    return fb;
  }

  private texFor(id: number, cube: boolean, passTex: number): GLTex {
    const t = id ? this.tex[id] : undefined;
    if (!t || t.cube !== cube) return cube ? this.whiteCube : this.white;
    if (id === passTex) { this.conflicts++; return cube ? this.whiteCube : this.white; }
    return t;
  }

  private applyBlend(blend: number, bcol: number): void {
    const gl = this.gl;
    const en = (blend & 1) !== 0;
    const sf = (blend >> 1) & 31, df = (blend >> 6) & 31, op = (blend >> 11) & 7, mask = (blend >> 14) & 15;
    gl.colorMask((mask & 1) !== 0, (mask & 2) !== 0, (mask & 4) !== 0, (mask & 8) !== 0);
    if (!en) { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    const BF = [
      gl.ONE, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE,
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.CONSTANT_COLOR, gl.ONE_MINUS_CONSTANT_COLOR,
    ];
    const BO = [gl.FUNC_ADD, gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX];
    let s = BF[sf] ?? gl.ONE, d = BF[df] ?? gl.ONE;
    if (sf === 12) d = gl.ONE_MINUS_SRC_ALPHA;
    if (sf === 13) { s = gl.ONE_MINUS_SRC_ALPHA; d = gl.SRC_ALPHA; }
    const o = BO[op] ?? gl.FUNC_ADD;
    if (o === gl.MIN || o === gl.MAX) { s = gl.ONE; d = gl.ONE; }
    gl.blendEquation(o);
    gl.blendFunc(s, d);
    gl.blendColor(((bcol >>> 16) & 255) / 255, ((bcol >>> 8) & 255) / 255, (bcol & 255) / 255, (bcol >>> 24) / 255);
  }

  private applyDepth(dm: number): void {
    const gl = this.gl;
    const test = (dm & 1) !== 0, write = (dm & 2) !== 0;
    const CMP = [gl.ALWAYS, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS];
    if (!test && !write) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(write);
      gl.depthFunc(test ? (CMP[(dm >> 2) & 7] ?? gl.LESS) : gl.ALWAYS);
    }
  }

  private applyCull(cull: number): void {
    const gl = this.gl;
    if (cull === 1) { gl.disable(gl.CULL_FACE); return; }
    gl.enable(gl.CULL_FACE);
    // u_yflip = -1.0 in FBOs inverts triangle winding vs WebGPU's frontFace='cw'
    gl.frontFace(gl.CCW);
    gl.cullFace(cull === 2 ? gl.FRONT : gl.BACK);
  }

  private blitQuad(
    srcTex: WebGLTexture,
    dstFbo: WebGLFramebuffer | null,
    dstW: number,
    dstH: number,
    opaque: boolean,
    linear: boolean,
    u0 = 0, v0 = 0, du = 1, dv = 1,
    vp?: [number, number, number, number],
    flipY = -1.0,
    tone?: Float32Array | null,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    if (vp) {
      gl.viewport(0, 0, dstW, dstH);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    } else {
      gl.viewport(0, 0, dstW, dstH);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.bindSampler(0, linear ? this.linearSmp : this.nearestSmp);

    if (tone) {
      gl.useProgram(this.toneProg.prog);
      gl.uniform4f(this.toneProg.uRect, u0, v0, du, dv);
      gl.uniform1f(this.toneProg.uFlipY, flipY);
      gl.uniform4f(this.toneProg.uTone, tone[0], tone[1], tone[2], 0);
    } else {
      const p = opaque ? this.copyOpaqueProg : this.copyProg;
      gl.useProgram(p.prog);
      gl.uniform4f(p.uRect, u0, v0, du, dv);
      gl.uniform1f(p.uFlipY, flipY);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Encode and execute one handed-off frame from record buffer `b` into the offscreen backbuffer. */
  encodeFrame(b: number): EncodeStats {
    const t0 = performance.now();
    this.views();
    const gl = this.gl;
    const u32 = this.u32, i32 = this.i32, f32 = this.f32;
    const fw = this.ctlW + P.C.frame + b * (P.FRAME_BYTES >> 2);
    const dn = u32[fw + F.dn], vn = u32[fw + F.vn], rvn = u32[fw + F.rvn], kn = u32[fw + F.kn];
    const drawsW = u32[fw + F.draws] >>> 2, pscW = u32[fw + F.psc] >>> 2;
    const bbW = u32[fw + F.bbW] || 1280, bbH = u32[fw + F.bbH] || 720;
    this.ensureBackBuffer(bbW, bbH);

    // Upload per-frame arenas
    if (vn) {
      const len = vn * P.TVERT_BYTES;
      this.tvTex.upload(0, this.u8.subarray(u32[fw + F.tv], u32[fw + F.tv] + len), len);
    }
    if (rvn) {
      const len = (rvn + 3) & ~3;
      this.rawTex.upload(0, this.u8.subarray(u32[fw + F.raw], u32[fw + F.raw] + len), len);
    }
    if (kn) {
      const len = (kn + 3) & ~3;
      this.growUbo('k', len + GL_KWIN_SIZE);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.kBuf);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.u8.subarray(u32[fw + F.k], u32[fw + F.k] + len));
    }

    // Build PSPar UBO staging buffer upfront for every draw in the frame
    const pSlotF32 = this.pSlot >>> 2;
    if (this.pStage.length < (dn + 1) * pSlotF32) this.pStage = new Float32Array((dn + 64) * pSlotF32);
    const drawPoff = new Int32Array(dn);
    let pslots = 0, lastPsci = -1, lastAref = NaN;
    const lastPF = new Float32Array(8);
    const ps = this.pStage;
    for (let i = 0; i < dn; i++) {
      const w = drawsW + i * P.DRAW_WORDS;
      if (u32[w + D.kind] !== Kind.Draw) continue;
      const psci = u32[w + D.psci], aref = f32[w + D.aref];
      let same = psci === lastPsci && aref === lastAref;
      if (same) {
        for (let q = 0; q < 4; q++) {
          if (lastPF[q] !== f32[w + D.proj + q] || lastPF[4 + q] !== f32[w + D.fogv + q]) { same = false; break; }
        }
      }
      if (!same) {
        const o = pslots * pSlotF32;
        ps[o] = aref; ps[o + 1] = 0; ps[o + 2] = 0; ps[o + 3] = 0;
        for (let q = 0; q < 4; q++) {
          ps[o + 4 + q] = lastPF[q] = f32[w + D.proj + q];
          ps[o + 136 + q] = lastPF[4 + q] = f32[w + D.fogv + q];
        }
        ps.set(f32.subarray(pscW + psci * 128, pscW + psci * 128 + 128), o + 8);
        lastPsci = psci; lastAref = aref; pslots++;
      }
      drawPoff[i] = (pslots - 1) * this.pSlot;
    }
    if (pslots) {
      this.growUbo('p', pslots * this.pSlot);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.pBuf);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, ps.subarray(0, pslots * pSlotF32));
    }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.poolIdxBuf);

    let curT = -1, curZ = -1, realZ = false, passCube = -1, passW = 0, passH = 0, passOpen = false;
    let screenTouched = false;
    const touched = new Set<number>();
    let clearArgb = u32[fw + F.clearArgb];
    let cProg: CompiledProg | null = null, cSrc = -1, cK = -1, cP = -1, cH = -1;
    let cBlend = -1, cBcol = -1, cDepth = -1, cCull = -1, cClip = -1, passCells = false;
    const vpNow = [0, 0, 0, 0, 0, 1], vpDraw = [0, 0, 0, 0, 0, 1], scDraw = [0, 0, 0, 0];
    let draws = 0, passes = 0, skipped = 0;

    const resetPassState = () => {
      cProg = null; cSrc = -1; cK = -1; cP = -1; cH = -1;
      cBlend = -1; cBcol = -1; cDepth = -1; cCull = -1; cClip = -1;
      passCells = false;
    };

    const openPass = (target: number, zid: number): boolean => {
      let tex: WebGLTexture, texId = 0, face = 0, cube = false, w: number, h: number, key: number;
      if (!target) {
        tex = this.bbTex!; w = bbW; h = bbH; key = -1; passCube = -1;
      } else {
        texId = target & 0xFFFF;
        const t = this.tex[texId];
        if (!t || !t.rt) { this.missingTarget++; return false; }
        const rawFace = (target >>> 16) & 7;
        face = rawFace ? Math.min(rawFace - 1, 5) : 0;
        tex = t.tex; cube = t.cube; w = t.w; h = t.h;
        key = texId * 8 + rawFace;
        passCube = texId;
      }
      const first = key === -1 ? !screenTouched : !touched.has(key);
      const { rb, fresh } = this.getDepthRb(zid, w, h);
      let zclear = fresh, zval = 1.0;
      if (rb && this.zpend[zid]) { zclear = true; zval = this.zpendV[zid]; this.zpend[zid] = 0; }
      realZ = !!rb;

      const fb = this.getFbo(texId, face, tex, cube, zid, rb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      passW = w; passH = h;
      vpNow[0] = 0; vpNow[1] = 0; vpNow[2] = w; vpNow[3] = h; vpNow[4] = 0; vpNow[5] = 1;
      gl.viewport(0, 0, w, h);
      gl.depthRange(0, 1);
      gl.disable(gl.SCISSOR_TEST);

      let clearMask = 0;
      if (first) {
        gl.colorMask(true, true, true, true);
        gl.clearColor(((clearArgb >>> 16) & 255) / 255, ((clearArgb >>> 8) & 255) / 255, (clearArgb & 255) / 255, 1);
        clearMask |= gl.COLOR_BUFFER_BIT;
      }
      if (rb && zclear) {
        gl.depthMask(true);
        gl.clearDepth(zval);
        clearMask |= gl.DEPTH_BUFFER_BIT;
      }
      if (clearMask) gl.clear(clearMask);

      if (key === -1) screenTouched = true;
      else touched.add(key);
      passes++;
      resetPassState();
      passOpen = true;
      return true;
    };

    for (let i = 0; i < dn; i++) {
      const w = drawsW + i * P.DRAW_WORDS;
      const kind = u32[w + D.kind];

      if (kind === Kind.Blit) {
        const sid = u32[w + D.blitSrc], tgt = u32[w + D.target];
        const st = sid ? this.tex[sid & 0xFFFF] : null, dt = tgt ? this.tex[tgt & 0xFFFF] : null;
        const sTex = sid ? st?.tex : this.bbTex;
        const dTex = tgt ? dt?.tex : this.bbTex;
        const sW = sid ? (st?.w ?? 0) : bbW, sH = sid ? (st?.h ?? 0) : bbH;
        const dW = tgt ? (dt?.w ?? 0) : bbW, dH = tgt ? (dt?.h ?? 0) : bbH;
        if (!sTex || !dTex || sTex === dTex || (tgt && !dt!.rt) || (sid && st!.cube)) { skipped++; continue; }
        const df = Math.max(0, ((tgt >>> 16) & 7) - 1);
        const dstFbo = this.getFbo(tgt ? (tgt & 0xFFFF) : 0, df, dTex, !!(tgt && dt!.cube), 0, null);
        const r0 = u32[w + D.first], r1 = u32[w + D.count];
        let u0 = 0, v0 = 0, du = 1, dv = 1;
        if (r1 && sW > 0 && sH > 0) {
          const x0 = Math.min(r0 & 0xFFFF, sW), y0 = Math.min(r0 >>> 16, sH);
          const x1 = Math.min(r1 & 0xFFFF, sW), y1 = Math.min(r1 >>> 16, sH);
          if (x1 <= x0 || y1 <= y0) { skipped++; continue; }
          u0 = x0 / sW; v0 = y0 / sH; du = (x1 - x0) / sW; dv = (y1 - y0) / sH;
        }
        this.blitQuad(sTex, dstFbo, dW, dH, !sid && !!r1, true, u0, v0, du, dv, undefined, -1.0, null);
        if (tgt) touched.add((tgt & 0xFFFF) * 8 + ((tgt >>> 16) & 7));
        else screenTouched = true;
        passes++;
        passOpen = false; curT = -1; curZ = -1;
        continue;
      }

      const depth = u32[w + D.depth], zid = depth >>> 8, target = u32[w + D.target];

      // Split-screen region clear
      if (kind === Kind.Clear && f32[w + D.viewport + 2] > 0) {
        curT = target; curZ = zid;
        if (openPass(target, zid)) {
          const vp = drawViewport(f32, w + D.viewport, passW, passH, vpDraw);
          const z = f32[w + D.clrZ], flags = u32[w + D.clrFlags];
          if (vp && Number.isFinite(z) && (flags & 3)) {
            const argb = u32[w + D.clrArgb];
            gl.viewport(vp[0], vp[1], vp[2], vp[3]);
            gl.disable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            gl.colorMask((flags & 1) !== 0, (flags & 1) !== 0, (flags & 1) !== 0, (flags & 1) !== 0);
            if (flags & 2) { gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.ALWAYS); }
            else { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); }
            gl.useProgram(this.regionClearProg.prog);
            gl.uniform1f(this.regionClearProg.uZ, Math.max(0, Math.min(1, z)));
            gl.uniform4f(this.regionClearProg.uCol, ((argb >>> 16) & 255) / 255, ((argb >>> 8) & 255) / 255, (argb & 255) / 255, (argb >>> 24) / 255);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          }
        }
        passOpen = false; curT = -1;
        continue;
      }

      if (kind === Kind.Clear) {
        const fl = u32[w + D.clrFlags];
        if (fl & 1) clearArgb = u32[w + D.clrArgb];
        if ((fl & 2) && zid && zid < 64) {
          const z = f32[w + D.clrZ];
          this.zpend[zid] = 1;
          this.zpendV[zid] = z < 0 ? 0 : z > 1 ? 1 : z;
          if (passOpen && curZ === zid) { passOpen = false; curT = -1; }
        }
      }

      const zsplit = zid !== curZ && !(passOpen && kind !== Kind.Clear && (depth & 3) === 0);
      if (!passOpen || target !== curT || zsplit) {
        curT = target; curZ = zid;
        passOpen = openPass(target, zid);
      }
      if (kind === Kind.Clear) continue;

      const count = u32[w + D.count];
      if (!passOpen || !count) { skipped++; continue; }

      const cell = f32[w + D.viewport + 2] !== 0 || u32[w + D.clrFlags] !== 0;
      if (cell) passCells = true;
      if (passCells) {
        if (!drawViewport(f32, w + D.viewport, passW, passH, vpDraw)) { skipped++; continue; }
        if (vpDraw[0] !== vpNow[0] || vpDraw[1] !== vpNow[1] || vpDraw[2] !== vpNow[2] || vpDraw[3] !== vpNow[3]
            || vpDraw[4] !== vpNow[4] || vpDraw[5] !== vpNow[5]) {
          gl.viewport(vpDraw[0], vpDraw[1], vpDraw[2], vpDraw[3]);
          gl.depthRange(vpDraw[4], vpDraw[5]);
          for (let q = 0; q < 6; q++) vpNow[q] = vpDraw[q];
        }
      }

      const psid = i32[w + D.ps], vsid = i32[w + D.vsid];
      if (vsid > 0 && !this.vsSrc.has(vsid)) { this.noVs++; skipped++; continue; }
      const aref = f32[w + D.aref];
      const blend = u32[w + D.blend] & 0x3FFFF, cull = u32[w + D.cull] & 3, dm = realZ ? (depth & 63) : 0;
      const t0 = u32[w + D.tex];
      let psEff = psid > 0 && this.psSrc.has(psid) ? psid : psid >= PSCUBE ? PSCUBE : 0;
      if (psEff === 0 && t0 && this.tex[t0]?.cube) psEff = PSCUBE;
      const nd = !(aref > 0);

      const cp = this.getProgram(vsid, psEff, nd);
      if (!cp) { skipped++; continue; }
      if (cp !== cProg) {
        gl.useProgram(cp.prog);
        if (cp.uYflip) gl.uniform1f(cp.uYflip, -1.0);
        cProg = cp;
      }

      const bcol = u32[w + D.bcol];
      if (blend !== cBlend || bcol !== cBcol) { this.applyBlend(blend, bcol); cBlend = blend; cBcol = bcol; }
      if (dm !== cDepth) { this.applyDepth(dm); cDepth = dm; }
      if (cull !== cCull) { this.applyCull(cull); cCull = cull; }

      const clip = passW === bbW && passH === bbH ? u32[w + D.clip] : 0;
      if (passCells) {
        drawScissor(vpDraw, passW, passH, clip, u32[w + D.clrArgb], u32[w + D.clrFlags], scDraw);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(scDraw[0], scDraw[1], scDraw[2], scDraw[3]);
      } else if (clip !== cClip) {
        if (clip) {
          const y0 = Math.min(clip & 0xFFFF, passH), y1 = Math.min(clip >>> 16, passH);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, y0, passW, Math.max(0, y1 - y0));
        } else gl.disable(gl.SCISSOR_TEST);
        cClip = clip;
      }

      // Bind vertex source R32UI texture (unit 4) & UBOs (VSWin=0, PSPar=1, HLPar=2)
      const isz = u32[w + D.ixIsz];
      const src = isz ? Src.Pool : vsid > 0 ? Src.Raw : Src.TVert;
      if (src !== cSrc) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, src === Src.Pool ? this.poolTex.tex : src === Src.Raw ? this.rawTex.tex : this.tvTex.tex);
        gl.bindSampler(4, null);
        cSrc = src;
      }

      const koff = vsid > 0 ? u32[w + D.koff] : -1;
      if (koff >= 0) {
        if (cK < 0 || koff < cK || koff - cK > GL_KWIN_SIZE - VSPAR_SIZE) {
          cK = koff - (koff % this.uboAlign);
          gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, this.kBuf, cK, GL_KWIN_SIZE);
        }
        if (cp.uKb) gl.uniform1ui(cp.uKb, (koff - cK) >>> 4);
      }

      const poff = drawPoff[i];
      if (poff !== cP) {
        gl.bindBufferRange(gl.UNIFORM_BUFFER, 1, this.pBuf, poff, PSPAR_SIZE);
        cP = poff;
      }
      const hoff = u32[w + D.blitSrc];
      if (cp.hasHL && hoff !== cH) {
        gl.bindBufferRange(gl.UNIFORM_BUFFER, 2, this.kBuf, hoff - (hoff % this.uboAlign), HLPAR_SIZE);
        cH = hoff;
      }

      // Bind textures 0..3 & samplers
      const cube = psEff >= PSCUBE;
      const tIds = [t0, u32[w + D.tex1], u32[w + D.tex2], u32[w + D.tex3]];
      for (let k = 0; k < 4; k++) {
        const isCube = cube && k === 0;
        const tv = this.texFor(tIds[k], isCube, passCube);
        let sk = u32[w + D.smp + k];
        if (this.pointTex && !tv.rt) sk = (sk & ~0x3f) | 1 | (1 << 2) | ((sk >> 4) & 3 ? (1 << 4) : 0);
        else if (this.aniso && !tv.rt && (sk & 3) === 2 && ((sk >> 2) & 3) === 2 && (sk >> 4) & 3 && (sk >> 12) & 7) sk = (sk & ~3) | 3;
        gl.activeTexture(gl.TEXTURE0 + k);
        gl.bindTexture(isCube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, tv.tex);
        gl.bindSampler(k, this.sampler(sk));
      }

      if (isz) {
        if (cp.uVbase) gl.uniform1i(cp.uVbase, i32[w + D.ixBase]);
        gl.drawElements(gl.TRIANGLES, count, isz === 4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, u32[w + D.ixIb]);
      } else if (vsid > 0) {
        if (cp.uVbase) gl.uniform1i(cp.uVbase, 0);
        gl.drawArrays(gl.TRIANGLES, 0, count);
      } else {
        if (cp.uVbase) gl.uniform1i(cp.uVbase, u32[w + D.first]);
        gl.drawArrays(gl.TRIANGLES, 0, count);
      }
      draws++;
    }

    if (!screenTouched) {
      const fb = this.getFbo(0, 0, this.bbTex!, false, 0, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(((clearArgb >>> 16) & 255) / 255, ((clearArgb >>> 8) & 255) / 255, (clearArgb & 255) / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      passes++;
    }

    this.totalDraws += draws;
    this.totalPasses += passes;
    return { draws, passes, skipped, encodeMs: performance.now() - t0, direct: false };
  }

  /** Composite the offscreen backbuffer aspect-fit onto the default canvas framebuffer. */
  compositeToCanvas(canvasW: number, canvasH: number, tone: Float32Array | null): { x: number; y: number; w: number; h: number } {
    const sw = this.bbW || canvasW, sh = this.bbH || canvasH;
    const sc = Math.min(canvasW / sw, canvasH / sh);
    const w = Math.round(sw * sc), h = Math.round(sh * sc);
    const x = Math.floor((canvasW - w) / 2), y = Math.floor((canvasH - h) / 2);
    const linear = !(w === sw && h === sh);
    if (this.bbTex) {
      // u_flipY = +1.0 draws top-left uv (0,0) to GL screen top (+1.0)
      this.blitQuad(this.bbTex, null, canvasW, canvasH, true, linear, 0, 0, 1, 1, [x, y, w, h], 1.0, tone);
    }
    return { x, y, w, h };
  }

  /** Synchronous RGBA readback of backbuffer (or texture `id` level 0) in D3D9 top-down BGRA layout. */
  readbackBgra(id: number): { data: Uint8Array; w: number; h: number } | null {
    const gl = this.gl;
    let tex: WebGLTexture | null, w: number, h: number;
    if (!id) { tex = this.bbTex; w = this.bbW; h = this.bbH; }
    else { const t = this.tex[id]; if (!t || t.cube) return null; tex = t.tex; w = t.w; h = t.h; }
    if (!tex || !w || !h) return null;
    const fb = this.getFbo(id, 0, tex, false, 0, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    // Swap RGBA -> BGRA (row 0 is already D3D9 top-left thanks to u_yflip = -1.0!)
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r;
    }
    return { data: rgba, w, h };
  }

  destroy(): void {
    const gl = this.gl;
    this.tvTex.destroy();
    this.rawTex.destroy();
    this.poolTex.destroy();
    gl.deleteBuffer(this.poolIdxBuf);
    gl.deleteBuffer(this.kBuf);
    gl.deleteBuffer(this.pBuf);
    gl.deleteVertexArray(this.vao);
    if (this.bbTex) gl.deleteTexture(this.bbTex);
    for (let i = 0; i < this.tex.length; i++) if (this.tex[i]) gl.deleteTexture(this.tex[i]!.tex);
    gl.deleteTexture(this.white.tex);
    gl.deleteTexture(this.whiteCube.tex);
    for (const rb of this.zRb) if (rb) gl.deleteRenderbuffer(rb);
    for (const fb of this.fbos.values()) gl.deleteFramebuffer(fb);
    for (const s of this.samplers.values()) gl.deleteSampler(s);
    gl.deleteSampler(this.linearSmp);
    gl.deleteSampler(this.nearestSmp);
    for (const sh of this.vsCompiled.values()) if (sh) gl.deleteShader(sh);
    for (const sh of this.psCompiled.values()) if (sh) gl.deleteShader(sh);
    for (const cp of this.progs.values()) if (cp) gl.deleteProgram(cp.prog);
    gl.deleteProgram(this.copyProg.prog);
    gl.deleteProgram(this.copyOpaqueProg.prog);
    gl.deleteProgram(this.toneProg.prog);
    gl.deleteProgram(this.regionClearProg.prog);
  }
}
