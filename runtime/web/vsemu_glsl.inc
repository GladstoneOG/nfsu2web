/* D3D9 shader bytecode -> GLSL ES 3.00: the WebGL2 twin of vsemu_wgsl.inc.
 *
 * Included at the end of vsemu.c (wasm builds, or native with -DVSEMU_GLSL for
 * offline tests) so it shares the parser's private VSProg/VSIns and token
 * macros alongside vsemu_wgsl.inc.
 *
 * Key differences from WGSL for WebGL2 (DX10/DX11/OpenGL 3.3+ compatibility):
 *   - Programmable vertex pulling reads from a 4096-wide R32UI 2D texture
 *     (uniform highp usampler2D u_vb) via texelFetch instead of a vertex-stage
 *     storage buffer (WebGL2 has no SSBOs).
 *   - VS constants use a 16 KB UBO window (1024 vec4s, guaranteed by WebGL2's
 *     MAX_UNIFORM_BLOCK_SIZE >= 16384) indexed by `uniform uint u_kb`.
 *   - `uniform int u_vbase` provides BaseVertexIndex / firstVertex support for
 *     WebGL2's gl.drawElements (which lacks drawElementsBaseVertex).
 *   - Clip-space Z is remapped from D3D9 [0, 1] to OpenGL [-1, 1] and Y is
 *     scaled by `uniform float u_yflip` (-1.0 for FBOs so D3D9 top-left maps
 *     directly to texel row 0 without flipping UVs or viewports).
 *   - Fragment alpha-test specialization uses `#ifndef ALPHA_FUNC` /
 *     `#ifndef PS20_TEXCOORD` macros so the WebGL2 encoder can prepend
 *     `#define ALPHA_FUNC 8u` for no-discard variants.
 */
#include <stdarg.h>
#include "glsl.h"
#include "gpu_proto.h"

#ifndef GW_GL_KWIN_ROWS
#define GW_GL_KWIN_ROWS 1024
#endif
#define GSTR_(x) #x
#define GSTR(x) GSTR_(x)

typedef struct { char *p; size_t cap, n; int ok; } GBuf;
static void gb_init(GBuf *b, char *p, size_t cap){
    b->p = p; b->cap = cap; b->n = 0; b->ok = (p && cap > 0);
    if (b->ok) p[0] = 0;
}
static void gb_put(GBuf *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void gb_put(GBuf *b, const char *fmt, ...){
    if (!b->ok) return;
    va_list ap; va_start(ap, fmt);
    int w = vsnprintf(b->p + b->n, b->cap - b->n, fmt, ap);
    va_end(ap);
    if (w < 0 || (size_t)w >= b->cap - b->n){ b->ok = 0; b->p[b->n] = 0; return; }
    b->n += (size_t)w;
}

/* ---- shared GLSL ES 3.00 module text ---- */
static const char G_HEAD[] =
    "#version 300 es\n"
    "precision highp float;\n"
    "precision highp int;\n"
    "vec4 sat(vec4 x) { return clamp(x, 0.0, 1.0); }\n"
    "float satf(float x) { return clamp(x, 0.0, 1.0); }\n";

static const char G_VOUT_VS[] =
    "out vec4 v_col0; out vec4 v_col1;\n"
    "out vec4 v_uv0; out vec4 v_uv1; out vec4 v_uv2; out vec4 v_uv3;\n"
    "out float v_fog;\n";

static const char G_VOUT_FS[] =
    "in vec4 v_col0; in vec4 v_col1;\n"
    "in vec4 v_uv0; in vec4 v_uv1; in vec4 v_uv2; in vec4 v_uv3;\n"
    "in float v_fog;\n"
    "out vec4 fragColor;\n";

static const char G_VSPAR[] =
    "layout(std140) uniform VSWin { vec4 c[" GSTR(GW_GL_KWIN_ROWS) "]; } K;\n"
    "uniform highp usampler2D u_vb;\n"
    "uniform uint u_kb;\n"
    "uniform int u_vbase;\n"
    "uniform float u_yflip;\n";

/* Byte-addressed little-endian loads from the 4096-wide R32UI vertex pool
 * texture at any byte alignment. */
static const char G_PULL[] =
    "uint vb_word(uint w) {\n"
    "  return texelFetch(u_vb, ivec2(int(w & 4095u), int(w >> 12u)), 0).r;\n"
    "}\n"
    "uint ld32(uint a) {\n"
    "  uint w = a >> 2u;\n"
    "  uint s = (a & 3u) << 3u;\n"
    "  if (s == 0u) return vb_word(w);\n"
    "  return (vb_word(w) >> s) | (vb_word(w + 1u) << (32u - s));\n"
    "}\n"
    "uint ld16(uint a) {\n"
    "  uint s = (a & 3u) << 3u;\n"
    "  if (s <= 16u) return (vb_word(a >> 2u) >> s) & 0xFFFFu;\n"
    "  return ld32(a) & 0xFFFFu;\n"
    "}\n"
    "float ldf(uint a) { return uintBitsToFloat(ld32(a)); }\n"
    "float lds(uint a) { return float(int(ld16(a) << 16u) >> 16); }\n"
    "float ldu(uint a) { return float(ld16(a)); }\n"
    "vec4 ldub4(uint a) {\n"
    "  uint u = ld32(a);\n"
    "  return vec4(float(u & 0xFFu), float((u >> 8u) & 0xFFu), float((u >> 16u) & 0xFFu), float(u >> 24u));\n"
    "}\n"
    "vec4 n8(vec4 x) { return x * (1.0 / 255.0); }\n"
    "vec4 s16n(vec4 x) { return x * (1.0 / 32767.0); }\n"
    "vec4 u16n(vec4 x) { return x * (1.0 / 65535.0); }\n"
    "vec4 ldcolor(uint a) { return n8(ldub4(a).zyxw); }\n";

static const char G_TPICK[] =
    "vec4 tpick(uint s, vec4 a, vec4 b, vec4 c, vec4 d) {\n"
    "  return (s >= 2u) ? ((s == 3u) ? d : c) : ((s == 1u) ? b : a);\n"
    "}\n";

static const char G_PSPAR[] =
    "#ifndef ALPHA_FUNC\n"
    "#define ALPHA_FUNC 7u\n"
    "#endif\n"
    "#ifndef PS20_TEXCOORD\n"
    "#define PS20_TEXCOORD true\n"
    "#endif\n"
    "layout(std140) uniform PSPar {\n"
    "  float aref; float usec; float pad0; float pad1;\n"
    "  vec4 proj;\n"
    "  vec4 c[32];\n"
    "  vec4 fog;\n"
    "} P;\n"
    "bool alpha_pass(float a, float r) {\n"
    "  if (ALPHA_FUNC == 7u) return !(a < r);\n"
    "  if (ALPHA_FUNC == 1u) return false;\n"
    "  if (ALPHA_FUNC == 2u) return a < r;\n"
    "  if (ALPHA_FUNC == 3u) return a == r;\n"
    "  if (ALPHA_FUNC == 4u) return a <= r;\n"
    "  if (ALPHA_FUNC == 5u) return a > r;\n"
    "  if (ALPHA_FUNC == 6u) return a != r;\n"
    "  return true;\n"
    "}\n"
    "vec4 ps_end(vec4 col, float fog) {\n"
    "  if (ALPHA_FUNC != 8u) { if (!alpha_pass(col.a, P.aref)) discard; }\n"
    "  return vec4(mix(P.fog.rgb, col.rgb, mix(1.0, satf(fog), P.fog.a)), col.a);\n"
    "}\n"
    "vec2 tcoord(vec4 q, float sel) {\n"
    "  int m = int(sel) >> 4;\n"
    "  float d = (m == 2) ? q.w : ((m == 1) ? q.z : 1.0);\n"
    "  return q.xy / d;\n"
    "}\n";

static void g_textures(GBuf *b, unsigned cubemask){
    for (int k = 0; k < 4; k++)
        gb_put(b, "uniform %s tex%d;\n",
               ((cubemask >> k) & 1u) ? "samplerCube" : "sampler2D", k);
}

static int g_float(char *o, size_t cap, float f){
    if (!isfinite(f)) return 0;
    char t[48]; snprintf(t, sizeof t, "%.9g", (double)f);
    if (!strpbrk(t, ".eE")) snprintf(o, cap, "%s.0", t);
    else snprintf(o, cap, "%s", t);
    return 1;
}

/* ---- register naming ---- */
typedef struct {
    const VSProg *p;
    int      vs;
    uint32_t r, v, t, ci;
    uint32_t cdef[8];
    int      a0, aL, oC, Z, dummy;
    int      bad;
} GCtx;

static void g_reg(GCtx *x, char *o, size_t cap, unsigned tok, unsigned rel){
    const VSProg *p = x->p;
    int ty = RT(tok), n = RN(tok), vs = x->vs;
    switch (ty){
    case R_TEMP:  n &= vs ? 31 : 15; x->r |= 1u << n; snprintf(o, cap, "r%d", n); return;
    case R_INPUT: n &= vs ? 15 : 1;  x->v |= 1u << n; snprintf(o, cap, "v%d", n); return;
    case R_ADDR:
        if (vs){ x->a0 = 1; snprintf(o, cap, "vec4(a0)"); }
        else   { n &= 3; x->t |= 1u << n; snprintf(o, cap, "t%d", n); }
        return;
    case R_LOOP:     x->aL = 1; snprintf(o, cap, "vec4(float(aL))"); return;
    case R_COLOROUT: x->oC = 1; snprintf(o, cap, "oC"); return;
    case R_CONSTINT:
        if (n >= 0 && n < 16){ x->ci |= 1u << n; snprintf(o, cap, "i%d", n); }
        else { x->Z = 1; snprintf(o, cap, "Z"); }
        return;
    case R_CONST: case R_CONST2: case R_CONST3: case R_CONST4: {
        int idx = n;
        if (ty == R_CONST2) idx += 2048; else if (ty == R_CONST3) idx += 4096;
        else if (ty == R_CONST4) idx += 6144;
        if (RELADDR(tok) && vs){
            char comp = 'x';
            if (rel){
                if (RT(rel) == R_LOOP) comp = 0;
                else comp = SWCH[SWIZ(rel) & 3u];
            }
            if (comp){ x->a0 = 1; snprintf(o, cap, "K.c[u_kb + 1u + uint(clamp(a0.%c + %d, 0, 255))]", comp, idx); }
            else     { x->aL = 1; snprintf(o, cap, "K.c[u_kb + 1u + uint(clamp(aL + %d, 0, 255))]", idx); }
            return;
        }
        if (idx >= 0 && idx < 256 && (p->defmask[idx >> 5] & (1u << (idx & 31)))){
            x->cdef[idx >> 5] |= 1u << (idx & 31);
            snprintf(o, cap, "c%d", idx);
        } else if (vs) snprintf(o, cap, "K.c[u_kb + %du]", (idx & 255) + 1);
        else snprintf(o, cap, "P.c[%d]", idx & 31);
        return; }
    default: x->Z = 1; snprintf(o, cap, "Z"); return;
    }
}

static void g_src(GCtx *x, char *o, size_t cap, unsigned tok, unsigned rel){
    char reg[96]; g_reg(x, reg, sizeof reg, tok, rel);
    unsigned sw = SWIZ(tok);
    char sws[8];
    if (sw == 0xE4u) sws[0] = 0;
    else { sws[0] = '.'; for (int i = 0; i < 4; i++) sws[1+i] = SWCH[(sw >> (2*i)) & 3u]; sws[5] = 0; }
    char body[128];
    snprintf(body, sizeof body, "%s%s", reg, sws);
    int w;
    switch (SMOD(tok)){
    case 1:  w = snprintf(o, cap, "(-%s)", body); break;
    case 2:  w = snprintf(o, cap, "(%s - 0.5)", body); break;
    case 3:  w = snprintf(o, cap, "(-(%s - 0.5))", body); break;
    case 4:  w = snprintf(o, cap, "(2.0 * %s - 1.0)", body); break;
    case 5:  w = snprintf(o, cap, "(-(2.0 * %s - 1.0))", body); break;
    case 6:  w = snprintf(o, cap, "(1.0 - %s)", body); break;
    case 7:  w = snprintf(o, cap, "(2.0 * %s)", body); break;
    case 8:  w = snprintf(o, cap, "(-2.0 * %s)", body); break;
    case 11: w = snprintf(o, cap, "abs(%s)", body); break;
    case 12: w = snprintf(o, cap, "(-abs(%s))", body); break;
    default: w = snprintf(o, cap, "%s", body); break;
    }
    if (w < 0 || (size_t)w >= cap) x->bad = 1;
}

static void g_store(GBuf *b, const char *name, unsigned mask, const char *val, int toint){
    if (mask == 0u || mask == 0xFu){
        if (toint) gb_put(b, "  %s = ivec4(%s);\n", name, val);
        else       gb_put(b, "  %s = %s;\n", name, val);
        return;
    }
    gb_put(b, "  { vec4 _e = %s;", val);
    for (int c = 0; c < 4; c++)
        if (mask & (1u << c)){
            if (toint) gb_put(b, " %s.%c = int(_e.%c);", name, SWCH[c], SWCH[c]);
            else       gb_put(b, " %s.%c = _e.%c;", name, SWCH[c], SWCH[c]);
        }
    gb_put(b, " }\n");
}

static void g_decls(GBuf *b, const GCtx *x, int nr){
    if (x->Z) gb_put(b, "  vec4 Z = vec4(0.0);\n");
    for (int i = 0; i < nr; i++) if (x->r & (1u << i)) gb_put(b, "  vec4 r%d = vec4(0.0);\n", i);
    for (int i = 0; i < 256; i++){
        if (!(x->cdef[i >> 5] & (1u << (i & 31)))) continue;
        char f[4][48];
        for (int c = 0; c < 4; c++) g_float(f[c], sizeof f[c], x->p->def[i][c]);
        gb_put(b, "  vec4 c%d = vec4(%s, %s, %s, %s);\n", i, f[0], f[1], f[2], f[3]);
    }
    for (int i = 0; i < 16; i++) if (x->ci & (1u << i))
        gb_put(b, "  vec4 i%d = vec4(%d.0, %d.0, %d.0, %d.0);\n", i, x->p->defi[i][0],
               x->p->defi[i][1], x->p->defi[i][2], x->p->defi[i][3]);
    if (x->a0) gb_put(b, "  ivec4 a0 = ivec4(0);\n");
    if (x->aL) gb_put(b, "  int aL = 0;\n");
    if (x->dummy) gb_put(b, "  vec4 dummy = vec4(0.0);\n");
}

static int g_defs_finite(const VSProg *p){
    for (int i = 0; i < 256; i++)
        if (p->defmask[i >> 5] & (1u << (i & 31)))
            for (int c = 0; c < 4; c++) if (!isfinite(p->def[i][c])) return 0;
    return 1;
}

static const char G_HL[] =
    "struct HLight { mat4 t; vec4 col; };\n"
    "layout(std140) uniform HLPar { uint n; float s; float o; float pad; HLight l[" GSTR(GW_HL_MAX) "]; } H;\n"
    "vec3 hl_more(vec4 q, float v) {\n"
    "  vec3 a = vec3(0.0);\n"
    "  uint lim = min(H.n, " GSTR(GW_HL_MAX) "u);\n"
    "  for (uint k = 0u; k < " GSTR(GW_HL_MAX) "u; k++) {\n"
    "    if (k >= lim) break;\n"
    "    vec4 p = q * H.l[k].t;\n"
    "    vec3 l1 = texture(tex1, p.xy / p.w).rgb;\n"
    "    vec3 l2 = texture(tex2, vec2(H.s * p.w + H.o, v)).rgb;\n"
    "    float road = satf((p.z + 3.5 + 0.06 * p.w) / 1.5);\n"
    "    if (p.w > 0.0) a += l1 * l2 * H.l[k].col.rgb * road;\n"
    "  }\n"
    "  return a;\n"
    "}\n";

static int g_plain(unsigned tok, int ty, int n){
    return RT(tok) == ty && RN(tok) == n && SWIZ(tok) == 0xE4u && SMOD(tok) == 0;
}

/* ====================================================================
 * Pixel shader (GLSL ES 3.00)
 * ==================================================================== */
#define GEX 4096
int ps_to_glsl_ex2(const VSProg *p, int id, char *out, size_t cap, unsigned cubemask, int reflk){
    if (!p || !out || cap < 512) return 0;
    if (reflk >= 0) return 0;
    if (!g_defs_finite(p)) return 0;
    GCtx x; memset(&x, 0, sizeof x); x.p = p; x.vs = 0;
    char *bodybuf = malloc(cap);
    if (!bodybuf) return 0;
    GBuf bb; gb_init(&bb, bodybuf, cap);
    char *ex = malloc(GEX), *s0 = malloc(GEX), *s1 = malloc(GEX), *s2 = malloc(GEX), *val = malloc(GEX);
    int rc = 0;
    if (!ex || !s0 || !s1 || !s2 || !val) goto done;

    if (p->version >= 0x0200){
        for (unsigned q = 0; q < p->n; q++){
            const VSIns *y = &p->ins[q];
            if (y->op != O_DCL || RT(y->dst) != R_ADDR) continue;
            int k = RN(y->dst) & 3;
            x.t |= 1u << k;
            gb_put(&bb, "  t%d = PS20_TEXCOORD ? v_uv%d : vec4(0.0);\n", k, k);
        }
    }
    unsigned tcuse = 0;
    for (unsigned q = 0; q < p->n; q++){
        const VSIns *y = &p->ins[q];
        if (y->op != O_TEX && y->op != O_TEXLDD && y->op != O_TEXLDL) continue;
        if (y->nsrc == 1 && RT(y->src[0]) == R_ADDR) tcuse |= 1u << (RN(y->src[0]) & 3);
        else if (y->nsrc == 0)                       tcuse |= 1u << (RN(y->dst) & 3);
    }
    for (int k = 0; k < 4; k++)
        if (tcuse & (1u << k)) gb_put(&bb, "  vec2 tc%d = tcoord(v_uv%d, P.proj[%d]);\n", k, k, k);

    int hl_mul = -1, hl_used = 0;
    for (unsigned q = 0; q < p->n && bb.ok && !x.bad; q++){
        const VSIns *y = &p->ins[q];
        if (y->nsrc > 0) g_src(&x, s0, GEX, y->src[0], y->rel[0]);
        if (y->nsrc > 1) g_src(&x, s1, GEX, y->src[1], y->rel[1]);
        if (y->nsrc > 2) g_src(&x, s2, GEX, y->src[2], y->rel[2]);
        int w = 0;
        ex[0] = 0;
        switch (y->op){
        case O_NOP: case O_DCL: case O_DEF: case O_DEFI: case O_DEFB:
        case O_LABEL: case O_END:
            continue;
        case O_TEX: case O_TEXLDD: case O_TEXLDL: {
            int dn = RN(y->dst) & 3, smp, crd = -1;
            const char *cs = 0;
            if (y->nsrc >= 2){ smp = RN(y->src[1]) & 3; cs = s0; }
            else if (y->nsrc == 1 && RT(y->src[0]) == R_ADDR){ smp = dn; crd = RN(y->src[0]) & 3; }
            else if (y->nsrc == 1){ smp = dn; cs = s0; }
            else { smp = dn; crd = dn; }
            int cube = (cubemask >> smp) & 1u;
            if (crd >= 0){
                if (cube) w = snprintf(ex, GEX, "texture(tex%d, v_uv%d.xyz)", smp, crd);
                else      w = snprintf(ex, GEX, "texture(tex%d, tc%d)", smp, crd);
            } else {
                w = snprintf(ex, GEX, "texture(tex%d, (%s).%s)", smp, cs, cube ? "xyz" : "xy");
            }
            break; }
        case O_TEXCOORD: {
            int dn = RN(y->dst) & 3;
            x.t |= 1u << dn;
            gb_put(&bb, "  t%d = v_uv%d;\n", dn, dn);
            continue; }
        case O_TEXKILL: {
            int kty = RT(y->dst);
            char kr[64];
            if (kty == R_ADDR && p->version < 0x0200) snprintf(kr, sizeof kr, "v_uv%d", RN(y->dst) & 3);
            else if (kty == R_TEMP || kty == R_ADDR) g_reg(&x, kr, sizeof kr, y->dst, 0);
            else { x.bad = 1; continue; }
            if (p->version >= 0x0200) gb_put(&bb, "  if (any(lessThan(%s, vec4(0.0)))) discard;\n", kr);
            else                      gb_put(&bb, "  if (any(lessThan(%s.xyz, vec3(0.0)))) discard;\n", kr);
            continue; }
        case O_MOV:    w = snprintf(ex, GEX, "%s", s0); break;
        case O_ADD:    w = snprintf(ex, GEX, "(%s) + (%s)", s0, s1); break;
        case O_SUB:    w = snprintf(ex, GEX, "(%s) - (%s)", s0, s1); break;
        case O_MUL:    w = snprintf(ex, GEX, "(%s) * (%s)", s0, s1); break;
        case O_MAD:    w = snprintf(ex, GEX, "(%s) * (%s) + (%s)", s0, s1, s2); break;
        case O_LRP:    w = snprintf(ex, GEX, "mix((%s), (%s), (%s))", s2, s1, s0); break;
        case O_MIN:    w = snprintf(ex, GEX, "min((%s), (%s))", s0, s1); break;
        case O_MAX:    w = snprintf(ex, GEX, "max((%s), (%s))", s0, s1); break;
        case O_DP3:    w = snprintf(ex, GEX, "vec4(dot((%s).xyz, (%s).xyz))", s0, s1); break;
        case O_DP4:    w = snprintf(ex, GEX, "vec4(dot((%s), (%s)))", s0, s1); break;
        case O_DP2ADD: w = snprintf(ex, GEX, "vec4(dot((%s).xy, (%s).xy) + (%s).x)", s0, s1, s2); break;
        case O_RCP:    w = snprintf(ex, GEX, "vec4(((%s).x == 0.0) ? 3.402823466e+38 : (1.0 / (%s).x))", s0, s0); break;
        case O_RSQ:    w = snprintf(ex, GEX, "vec4((abs((%s).x) == 0.0) ? 3.402823466e+38 : inversesqrt(abs((%s).x)))", s0, s0); break;
        case O_FRC:    w = snprintf(ex, GEX, "fract(%s)", s0); break;
        case O_ABS:    w = snprintf(ex, GEX, "abs(%s)", s0); break;
        case O_CMP:    w = snprintf(ex, GEX, "mix((%s), (%s), greaterThanEqual((%s), vec4(0.0)))", s2, s1, s0); break;
        case O_CND:    w = snprintf(ex, GEX, "mix((%s), (%s), greaterThan((%s), vec4(0.5)))", s2, s1, s0); break;
        case O_POW:    w = snprintf(ex, GEX, "vec4((abs((%s).x) > 0.0) ? pow(abs((%s).x), (%s).x) : 0.0)", s0, s0, s1); break;
        case O_NRM:    w = snprintf(ex, GEX, "vec4((length((%s).xyz) == 0.0) ? vec3(0.0) : normalize((%s).xyz), 1.0)", s0, s0); break;
        case O_EXP:    w = snprintf(ex, GEX, "vec4(exp2((%s).x))", s0); break;
        case O_EXPP:   w = snprintf(ex, GEX, "vec4(exp2(floor((%s).x)), fract((%s).x), exp2((%s).x), 1.0)", s0, s0, s0); break;
        case O_LOGP:   w = snprintf(ex, GEX,
                           "vec4(floor(log2(max(abs((%s).x), 1e-38))),"
                           " abs((%s).x) * exp2(-floor(log2(max(abs((%s).x), 1e-38)))),"
                           " log2(max(abs((%s).x), 1e-38)), 1.0)", s0, s0, s0, s0); break;
        case O_LOG:    w = snprintf(ex, GEX, "vec4(((%s).x == 0.0) ? -3.4e+38 : log2(abs((%s).x)))", s0, s0); break;
        default:
            continue;
        }
        if (w < 0 || w >= GEX){ x.bad = 1; break; }
        if (!y->has_dst) continue;
        int dty = RT(y->dst);
        if (dty != R_TEMP && dty != R_INPUT && dty != R_ADDR && dty != R_COLOROUT){ x.bad = 1; break; }
        char d[64]; g_reg(&x, d, sizeof d, y->dst, 0);
        int sh = DSHIFT(y->dst);
        char k[48] = "";
        if (sh) g_float(k, sizeof k, ldexpf(1.f, sh));
        if (sh && SATUR(y->dst)) w = snprintf(val, GEX, "sat((%s) * %s)", ex, k);
        else if (sh)             w = snprintf(val, GEX, "((%s) * %s)", ex, k);
        else if (SATUR(y->dst))  w = snprintf(val, GEX, "sat(%s)", ex);
        else                     w = snprintf(val, GEX, "%s", ex);
        if (w < 0 || w >= GEX){ x.bad = 1; break; }
        g_store(&bb, d, WMASK(y->dst), val, 0);
        int dn = RN(y->dst);
        if (p->version < 0x0200 && dty == R_TEMP && (WMASK(y->dst) & 7u) == 7u && !sh && !SATUR(y->dst)){
            if (y->op == O_MUL && ((g_plain(y->src[0], R_ADDR, 1) && g_plain(y->src[1], R_ADDR, 2)) ||
                                   (g_plain(y->src[0], R_ADDR, 2) && g_plain(y->src[1], R_ADDR, 1)))){
                hl_mul = dn; continue; }
            if (y->op == O_MAD && dn == hl_mul && g_plain(y->src[0], R_TEMP, dn) && g_plain(y->src[1], R_CONST, 0)
                && (tcuse & 6u) == 6u){
                gb_put(&bb, "  r%d = vec4(r%d.xyz + hl_more(v_uv1, tc2.y), r%d.w);\n", dn, dn, dn);
                hl_used = 1; hl_mul = -1; continue; }
        }
        if (dty == R_TEMP && dn == hl_mul) hl_mul = -1;
    }
    if (x.bad || !bb.ok) goto done;

    int usec = ps_uses_colorout(p);
    if (usec) x.oC = 1; else x.r |= 1u;
    GBuf ob; gb_init(&ob, out, cap);
    gb_put(&ob, "%s// ps_%d: ps_%u_%u, %u instructions%s%s\n", G_HEAD, id, p->version >> 8, p->version & 0xFF,
           p->n, (cubemask & 1u) ? ", stage 0 cube" : "", hl_used ? ", other cars' headlights" : "");
    gb_put(&ob, "%s%s", G_VOUT_FS, G_PSPAR);
    g_textures(&ob, cubemask);
    if (hl_used) gb_put(&ob, "%s", G_HL);
    gb_put(&ob, "void main() {\n");
    g_decls(&ob, &x, 16);
    if (x.v & 1u) gb_put(&ob, "  vec4 v0 = v_col0;\n");
    if (x.v & 2u) gb_put(&ob, "  vec4 v1 = v_col1;\n");
    for (int t = 0; t < 4; t++) if (x.t & (1u << t)) gb_put(&ob, "  vec4 t%d = vec4(0.0);\n", t);
    if (x.oC) gb_put(&ob, "  vec4 oC = vec4(0.0);\n");
    gb_put(&ob, "%s", bodybuf);
    gb_put(&ob, "  fragColor = ps_end(%s, v_fog);\n}\n", usec ? "oC" : "r0");
    if (ob.ok) rc = (int)ob.n;
done:
    free(bodybuf); free(ex); free(s0); free(s1); free(s2); free(val);
    return rc;
}
int ps_to_glsl_ex(const VSProg *p, int id, char *out, size_t cap, unsigned cubemask){
    return ps_to_glsl_ex2(p, id, out, cap, cubemask, -1);
}
int ps_to_glsl(const VSProg *p, int id, char *out, size_t cap){
    return ps_to_glsl_ex(p, id, out, cap, 0u);
}

/* ====================================================================
 * Vertex shader (GLSL ES 3.00)
 * ==================================================================== */
static int decl_read_glsl(char *o, size_t cap, unsigned type, unsigned off){
    switch (type){
    case 0: snprintf(o,cap,"vec4(ldf(B + %uu), 0.0, 0.0, 1.0)",off); break;
    case 1: snprintf(o,cap,"vec4(ldf(B + %uu), ldf(B + %uu), 0.0, 1.0)",off,off+4); break;
    case 2: snprintf(o,cap,"vec4(ldf(B + %uu), ldf(B + %uu), ldf(B + %uu), 1.0)",off,off+4,off+8); break;
    case 3: snprintf(o,cap,"vec4(ldf(B + %uu), ldf(B + %uu), ldf(B + %uu), ldf(B + %uu))",off,off+4,off+8,off+12); break;
    case 4: snprintf(o,cap,"ldcolor(B + %uu)",off); break;
    case 5: snprintf(o,cap,"ldub4(B + %uu)",off); break;
    case 8: snprintf(o,cap,"n8(ldub4(B + %uu))",off); break;
    case 6: snprintf(o,cap,"vec4(lds(B + %uu), lds(B + %uu), 0.0, 1.0)",off,off+2); break;
    case 7: snprintf(o,cap,"vec4(lds(B + %uu), lds(B + %uu), lds(B + %uu), lds(B + %uu))",off,off+2,off+4,off+6); break;
    case 9: snprintf(o,cap,"vec4(s16n(vec4(lds(B + %uu), lds(B + %uu), 0.0, 0.0)).xy, 0.0, 1.0)",off,off+2); break;
    case 10:snprintf(o,cap,"s16n(vec4(lds(B + %uu), lds(B + %uu), lds(B + %uu), lds(B + %uu)))",off,off+2,off+4,off+6); break;
    case 11:snprintf(o,cap,"vec4(u16n(vec4(ldu(B + %uu), ldu(B + %uu), 0.0, 0.0)).xy, 0.0, 1.0)",off,off+2); break;
    case 12:snprintf(o,cap,"u16n(vec4(ldu(B + %uu), ldu(B + %uu), ldu(B + %uu), ldu(B + %uu)))",off,off+2,off+4,off+6); break;
    default: return 0;
    }
    return 1;
}

static int g_vsdst(GCtx *x, char *o, size_t cap, unsigned tok){
    int ty = RT(tok), n = RN(tok);
    switch (ty){
    case R_TEMP:    n &= 31; x->r |= 1u << n; snprintf(o, cap, "r%d", n); return 0;
    case R_ADDR:    x->a0 = 1; snprintf(o, cap, "a0"); return 1;
    case R_RASTOUT: if (n == 0){ snprintf(o, cap, "oPos"); return 0; }
                    if (n == 1){ snprintf(o, cap, "oFog"); return 0; }
                    x->dummy = 1; snprintf(o, cap, "dummy"); return 0;
    case R_ATTROUT: snprintf(o, cap, "oD%d", n & 1); return 0;
    case R_OUTPUT:  snprintf(o, cap, "oT%d", n & 3); return 0;
    default:        x->dummy = 1; snprintf(o, cap, "dummy"); return 0;
    }
}

int vs_to_glsl(const VSProg *p, int id, const int decl[16][2], char *out, size_t cap){
    if (!p || !out || cap < 1024) return 0;
    if (!g_defs_finite(p)) return 0;
    GCtx x; memset(&x, 0, sizeof x); x.p = p; x.vs = 1;
    char *bodybuf = malloc(cap);
    if (!bodybuf) return 0;
    GBuf bb; gb_init(&bb, bodybuf, cap);
    char *ex = malloc(GEX), *s0 = malloc(GEX), *s1 = malloc(GEX), *s2 = malloc(GEX), *val = malloc(GEX);
    int rc = 0;
    if (!ex || !s0 || !s1 || !s2 || !val) goto done;

    unsigned vdecl = 0;
    for (int i = 0; i < 16; i++){
        if (decl[i][0] < 0) continue;
        char e[256];
        if (!decl_read_glsl(e, sizeof e, (unsigned)decl[i][1], (unsigned)decl[i][0])) goto done;
        gb_put(&bb, "  vec4 v%d = %s;\n", i, e);
        vdecl |= 1u << i;
    }

    for (unsigned q = 0; q < p->n && bb.ok && !x.bad; q++){
        const VSIns *y = &p->ins[q];
        if (y->nsrc > 0) g_src(&x, s0, GEX, y->src[0], y->rel[0]);
        if (y->nsrc > 1) g_src(&x, s1, GEX, y->src[1], y->rel[1]);
        if (y->nsrc > 2) g_src(&x, s2, GEX, y->src[2], y->rel[2]);
        int w = 0;
        ex[0] = 0;
        switch (y->op){
        case O_NOP: case O_DCL: case O_DEF: case O_DEFI: case O_DEFB:
        case O_LABEL: case O_END: continue;
        case O_MOV:  w = snprintf(ex, GEX, "%s", s0); break;
        case O_ADD:  w = snprintf(ex, GEX, "(%s) + (%s)", s0, s1); break;
        case O_SUB:  w = snprintf(ex, GEX, "(%s) - (%s)", s0, s1); break;
        case O_MUL:  w = snprintf(ex, GEX, "(%s) * (%s)", s0, s1); break;
        case O_MAD:  w = snprintf(ex, GEX, "(%s) * (%s) + (%s)", s0, s1, s2); break;
        case O_MIN:  w = snprintf(ex, GEX, "min((%s), (%s))", s0, s1); break;
        case O_MAX:  w = snprintf(ex, GEX, "max((%s), (%s))", s0, s1); break;
        case O_SLT:  w = snprintf(ex, GEX, "mix(vec4(0.0), vec4(1.0), lessThan((%s), (%s)))", s0, s1); break;
        case O_SGE:  w = snprintf(ex, GEX, "mix(vec4(0.0), vec4(1.0), greaterThanEqual((%s), (%s)))", s0, s1); break;
        case O_DP3:  w = snprintf(ex, GEX, "vec4(dot((%s).xyz, (%s).xyz))", s0, s1); break;
        case O_DP4:  w = snprintf(ex, GEX, "vec4(dot((%s), (%s)))", s0, s1); break;
        case O_LRP:  w = snprintf(ex, GEX, "mix((%s), (%s), (%s))", s2, s1, s0); break;
        case O_FRC:  w = snprintf(ex, GEX, "fract(%s)", s0); break;
        case O_ABS:  w = snprintf(ex, GEX, "abs(%s)", s0); break;
        case O_RCP:  w = snprintf(ex, GEX, "vec4(((%s).x == 0.0) ? 3.402823466e+38 : (1.0 / (%s).x))", s0, s0); break;
        case O_RSQ:  w = snprintf(ex, GEX, "vec4((abs((%s).x) == 0.0) ? 3.402823466e+38 : inversesqrt(abs((%s).x)))", s0, s0); break;
        case O_EXP:  w = snprintf(ex, GEX, "vec4(exp2((%s).x))", s0); break;
        case O_EXPP: w = snprintf(ex, GEX, "vec4(exp2(floor((%s).x)), fract((%s).x), exp2((%s).x), 1.0)", s0, s0, s0); break;
        case O_LOG: case O_LOGP:
                     w = snprintf(ex, GEX, "vec4(((%s).x == 0.0) ? -3.4e+38 : log2(abs((%s).x)))", s0, s0); break;
        case O_POW:  w = snprintf(ex, GEX, "vec4((abs((%s).x) > 0.0) ? pow(abs((%s).x), (%s).x) : 0.0)", s0, s0, s1); break;
        case O_CRS:  w = snprintf(ex, GEX, "vec4(cross((%s).xyz, (%s).xyz), 1.0)", s0, s1); break;
        case O_NRM:  w = snprintf(ex, GEX, "vec4((length((%s).xyz) == 0.0) ? vec3(0.0) : normalize((%s).xyz), 1.0)", s0, s0); break;
        case O_SGN:  w = snprintf(ex, GEX, "sign(%s)", s0); break;
        case O_M4x4: case O_M4x3: case O_M3x3: case O_M3x4: case O_M3x2: {
            int rows = (y->op==O_M4x4) ? 4 : (y->op==O_M4x3 ? 3 :
                       (y->op==O_M3x3 ? 3 : (y->op==O_M3x4 ? 4 : 2)));
            int vec3 = (y->op==O_M3x3 || y->op==O_M3x4 || y->op==O_M3x2);
            const char *sw2 = vec3 ? ".xyz" : "";
            GBuf eb; gb_init(&eb, ex, GEX);
            gb_put(&eb, "vec4(");
            for (int rr = 0; rr < rows; rr++){
                unsigned tok2 = y->src[1];
                int ty2 = RT(tok2), nn2 = RN(tok2) + rr;
                if (ty2 == R_CONST2) nn2 += 2048; else if (ty2 == R_CONST3) nn2 += 4096;
                else if (ty2 == R_CONST4) nn2 += 6144;
                char row[48];
                if (ty2 == R_TEMP){ x.r |= 1u << (nn2 & 31); snprintf(row, sizeof row, "r%d", nn2 & 31); }
                else if (ty2 == R_INPUT){ x.v |= 1u << (nn2 & 15); snprintf(row, sizeof row, "v%d", nn2 & 15); }
                else snprintf(row, sizeof row, "K.c[u_kb + %du]", (nn2 & 255) + 1);
                gb_put(&eb, "%sdot((%s)%s, (%s)%s)", rr ? ", " : "", s0, sw2, row, sw2);
            }
            for (int rr = rows; rr < 4; rr++) gb_put(&eb, ", %s", rr == 3 ? "1.0" : "0.0");
            gb_put(&eb, ")");
            w = eb.ok ? (int)eb.n : -1;
            break; }
        case O_SINCOS: w = snprintf(ex, GEX, "vec4(cos((%s).x), sin((%s).x), 0.0, 0.0)", s0, s0); break;
        case O_MOVA:   w = snprintf(ex, GEX, "%s", s0); break;
        case O_LIT:    w = snprintf(ex, GEX,
                           "vec4(1.0, max((%s).x, 0.0), (((%s).x > 0.0 && (%s).y > 0.0) ? pow((%s).y,"
                           " clamp((%s).w, -127.9, 127.9)) : 0.0), 1.0)", s0, s0, s0, s0, s0); break;
        case O_DST:    w = snprintf(ex, GEX, "vec4(1.0, (%s).y * (%s).y, (%s).z, (%s).w)", s0, s1, s0, s1); break;
        default:
            goto done;
        }
        if (w < 0 || w >= GEX){ x.bad = 1; break; }
        if (!y->has_dst) continue;
        if (y->op == O_MOVA){
            x.a0 = 1;
            gb_put(&bb, "  { vec4 _e = %s; a0 = ivec4(sign(_e) * floor(abs(_e) + 0.5)); }\n", ex);
            continue;
        }
        char d[64]; int toint = g_vsdst(&x, d, sizeof d, y->dst);
        if (SATUR(y->dst)) w = snprintf(val, GEX, "sat(%s)", ex);
        else               w = snprintf(val, GEX, "%s", ex);
        if (w < 0 || w >= GEX){ x.bad = 1; break; }
        g_store(&bb, d, WMASK(y->dst), val, toint);
    }
    if (x.bad || !bb.ok) goto done;

    GBuf ob; gb_init(&ob, out, cap);
    gb_put(&ob, "%s// vs_%d: vs_%u_%u, %u instructions, vs_kmax %d\n", G_HEAD, id, p->version >> 8, p->version & 0xFF,
           p->n, vs_kmax(p));
    gb_put(&ob, "%s%s%s%s", G_VOUT_VS, G_VSPAR, G_PULL, G_TPICK);
    gb_put(&ob, "void main() {\n"
                "  uint vid = uint(gl_VertexID + u_vbase);\n"
                "  uvec4 KH = floatBitsToUint(K.c[u_kb]);\n"
                "  uint B = KH.z + vid * KH.x;\n");
    g_decls(&ob, &x, 32);
    for (int i = 0; i < 16; i++)
        if ((x.v & (1u << i)) && !(vdecl & (1u << i)))
            gb_put(&ob, "  vec4 v%d = vec4(0.0, 0.0, 0.0, 1.0);\n", i);
    gb_put(&ob, "  vec4 oPos = vec4(0.0, 0.0, 0.0, 1.0);\n"
                "  vec4 oD0 = vec4(1.0); vec4 oD1 = vec4(0.0);\n"
                "  vec4 oT0 = vec4(0.0); vec4 oT1 = vec4(0.0); vec4 oT2 = vec4(0.0); vec4 oT3 = vec4(0.0);\n"
                "  vec4 oFog = vec4(1.0);\n");
    gb_put(&ob, "%s", bodybuf);
    gb_put(&ob, "  vec2 ts = max(vec2(float(KH.w & 0xFFFFu), float(KH.w >> 16u)), vec2(1.0));\n"
                "  vec2 pxy = oPos.xy + ((KH.w != 0u) ? (vec2(1.0, -1.0) / ts) : vec2(0.0)) * oPos.w;\n"
                "  gl_Position = vec4(pxy.x, pxy.y * u_yflip, oPos.z * 2.0 - oPos.w, oPos.w);\n"
                "  v_col0 = oD0; v_col1 = oD1;\n"
                "  v_uv0 = tpick(KH.y & 3u, oT0, oT1, oT2, oT3);\n"
                "  v_uv1 = tpick((KH.y >> 8u) & 3u, oT0, oT1, oT2, oT3);\n"
                "  v_uv2 = tpick((KH.y >> 16u) & 3u, oT0, oT1, oT2, oT3);\n"
                "  v_uv3 = tpick((KH.y >> 24u) & 3u, oT0, oT1, oT2, oT3);\n"
                "  v_fog = oFog.x;\n}\n");
    if (ob.ok) rc = (int)ob.n;
done:
    free(bodybuf); free(ex); free(s0); free(s1); free(s2); free(val);
    return rc;
}

/* ====================================================================
 * Built-in TVert vertex stage and fixed-function pixel stage (GLSL ES 3.00)
 * ==================================================================== */
int glsl_tvert_module(char *out, size_t cap){
    GBuf ob; gb_init(&ob, out, cap);
    gb_put(&ob, "%s// vs_0: TVert pass-through (GLSL ES 3.00)\n", G_HEAD);
    gb_put(&ob, "%s%s", G_VOUT_VS, G_VSPAR);
    gb_put(&ob, "uint vb_word(uint w) { return texelFetch(u_vb, ivec2(int(w & 4095u), int(w >> 12u)), 0).r; }\n"
                "vec4 ld4(uint w) { return uintBitsToFloat(uvec4(vb_word(w), vb_word(w + 1u), vb_word(w + 2u), vb_word(w + 3u))); }\n"
                "void main() {\n"
                "  uint w = uint(gl_VertexID + u_vbase) * 28u;\n"
                "  vec4 p = ld4(w);\n"
                "  gl_Position = vec4(p.x, p.y * u_yflip, p.z * 2.0 - p.w, p.w);\n"
                "  v_col0 = ld4(w + 4u); v_col1 = ld4(w + 8u);\n"
                "  v_uv0 = ld4(w + 12u); v_uv1 = ld4(w + 16u); v_uv2 = ld4(w + 20u); v_uv3 = ld4(w + 24u);\n"
                "  v_fog = 1.0;\n}\n");
    return ob.ok ? (int)ob.n : 0;
}

int glsl_ff_module(int id, char *out, size_t cap, unsigned cubemask){
    GBuf ob; gb_init(&ob, out, cap);
    int cube = cubemask & 1u;
    gb_put(&ob, "%s// ps_%d: fixed-function fragment col0 * tex0 (GLSL ES 3.00)%s\n",
           G_HEAD, id, cube ? ", stage 0 cube" : "");
    gb_put(&ob, "%s%s", G_VOUT_FS, G_PSPAR);
    g_textures(&ob, cubemask);
    gb_put(&ob, "void main() {\n"
                "  fragColor = ps_end(v_col0 * texture(tex0, v_uv0.%s), v_fog);\n}\n",
           cube ? "xyz" : "xy");
    return ob.ok ? (int)ob.n : 0;
}
