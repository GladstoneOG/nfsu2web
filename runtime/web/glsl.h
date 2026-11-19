/* GLSL ES 3.00 backend of the D3D9 shader translator (runtime/web/vsemu_glsl.inc,
 * compiled as part of vsemu.c) for the WebGL2 non-DX12 fallback renderer. */
#ifndef NFSU2_GLSL_H
#define NFSU2_GLSL_H
#include <stddef.h>
#include <stdint.h>
#include "vsemu.h"

/* Same signatures and return convention as the WGSL/MSL emitters (length of
 * the emitted GLSL ES 3.00 source, 0 = cannot translate). */
int vs_to_glsl(const VSProg *p, int id, const int decl[16][2], char *out, size_t cap);
int ps_to_glsl(const VSProg *p, int id, char *out, size_t cap);
int ps_to_glsl_ex(const VSProg *p, int id, char *out, size_t cap, unsigned cubemask);
int ps_to_glsl_ex2(const VSProg *p, int id, char *out, size_t cap, unsigned cubemask, int reflk);

/* Built-in modules for draws without a game shader: vs_0 (TVert pass-through)
 * and ps_<id> = col0 * tex0 (id 0, cube twin 256 with cubemask 1). */
int glsl_tvert_module(char *out, size_t cap);
int glsl_ff_module(int id, char *out, size_t cap, unsigned cubemask);

/* Non-zero when NFSU2_RENDERER=webgl2 is active (gpu_web.c). */
int gw_use_glsl(void);
#endif
