#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "vsemu.h"
#include "web/glsl.h"

int main(void) {
    char buf[32768];
    int n1 = glsl_tvert_module(buf, sizeof buf);
    if (n1 <= 0 || !strstr(buf, "#version 300 es") || !strstr(buf, "texelFetch(u_vb")) {
        fprintf(stderr, "FAIL tvert\n");
        return 1;
    }
    int n2 = glsl_ff_module(0, buf, sizeof buf, 0u);
    if (n2 <= 0 || !strstr(buf, "sampler2D tex0")) {
        fprintf(stderr, "FAIL ff2d\n");
        return 1;
    }
    int n3 = glsl_ff_module(256, buf, sizeof buf, 1u);
    if (n3 <= 0 || !strstr(buf, "samplerCube tex0")) {
        fprintf(stderr, "FAIL ffcube\n");
        return 1;
    }

    /* Minimal vs_1_1: m4x4 oPos, v0, c0; mov oD0, v1; mov oT0, v2; end */
    uint32_t vs_tok[] = {
        0xFFFE0101u,
        0x00000014u, 0xC00F0000u, 0x90E40000u, 0xA0E40000u,
        0x00000001u, 0xD00F0000u, 0x90E40001u,
        0x00000001u, 0xE00F0000u, 0x90E40002u,
        0x0000FFFFu
    };
    VSProg *vp = vs_compile(vs_tok, sizeof(vs_tok) / 4);
    if (!vp) {
        fprintf(stderr, "FAIL vs_compile\n");
        return 1;
    }
    int decl[16][2];
    for (int i = 0; i < 16; i++) { decl[i][0] = -1; decl[i][1] = 0; }
    decl[0][0] = 0;  decl[0][1] = 2; /* FLOAT3 */
    decl[1][0] = 12; decl[1][1] = 4; /* D3DCOLOR */
    decl[2][0] = 16; decl[2][1] = 1; /* FLOAT2 */
    int nv = vs_to_glsl(vp, 1, decl, buf, sizeof buf);
    if (nv <= 0 || !strstr(buf, "ldcolor(B + 12u)") || !strstr(buf, "gl_Position = vec4")) {
        fprintf(stderr, "FAIL vs_to_glsl: %d\n%s\n", nv, buf);
        return 1;
    }
    printf("VS_OK (%d bytes)\n", nv);
    vs_free(vp);

    /* Minimal ps_1_1: tex t0; mul r0, t0, v0; end */
    uint32_t ps_tok[] = {
        0xFFFF0101u,
        0x00000042u, 0xB00F0000u,
        0x00000005u, 0x800F0000u, 0xB0E40000u, 0x90E40000u,
        0x0000FFFFu
    };
    VSProg *pp = vs_compile(ps_tok, sizeof(ps_tok) / 4);
    if (!pp) {
        fprintf(stderr, "FAIL ps_compile\n");
        return 1;
    }
    int np = ps_to_glsl(pp, 1, buf, sizeof buf);
    if (np <= 0 || !strstr(buf, "texture(tex0, tc0)") || !strstr(buf, "fragColor = ps_end")) {
        fprintf(stderr, "FAIL ps_to_glsl: %d\n%s\n", np, buf);
        return 1;
    }
    printf("PS_OK (%d bytes)\n", np);
    int npc = ps_to_glsl_ex(pp, 257, buf, sizeof buf, 1u);
    if (npc <= 0 || !strstr(buf, "samplerCube tex0") || !strstr(buf, "texture(tex0, v_uv0.xyz)")) {
        fprintf(stderr, "FAIL ps_to_glsl_ex cube: %d\n%s\n", npc, buf);
        return 1;
    }
    printf("PS_CUBE_OK (%d bytes)\n", npc);
    vs_free(pp);

    printf("ALL_GLSL_TRANSLATOR_TESTS_PASSED\n");
    return 0;
}
