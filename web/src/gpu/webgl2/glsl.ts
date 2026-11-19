// Built-in GLSL ES 3.00 shaders for the WebGL2 non-DX12 fallback renderer:
//   - fallback TVert vertex shader (vs_0) and fixed-function fragment stage (ps_0 / ps_256)
//     until the game's translator emits its own modules;
//   - full-screen copy/StretchRect/composite pass (supports source sub-rects and Y flip);
//   - Exposure & White Level tone-mapping composite;
//   - split-screen region clear.

export const GL_TVERT_VS = /* glsl */`#version 300 es
precision highp float;
precision highp int;
out vec4 v_col0; out vec4 v_col1;
out vec4 v_uv0; out vec4 v_uv1; out vec4 v_uv2; out vec4 v_uv3;
out float v_fog;
uniform highp usampler2D u_vb;
uniform int u_vbase;
uniform float u_yflip;
uint vb_word(uint w) { return texelFetch(u_vb, ivec2(int(w & 4095u), int(w >> 12u)), 0).r; }
vec4 ld4(uint w) { return uintBitsToFloat(uvec4(vb_word(w), vb_word(w + 1u), vb_word(w + 2u), vb_word(w + 3u))); }
void main() {
  uint w = uint(gl_VertexID + u_vbase) * 28u;
  vec4 p = ld4(w);
  gl_Position = vec4(p.x, p.y * u_yflip, p.z * 2.0 - p.w, p.w);
  v_col0 = ld4(w + 4u); v_col1 = ld4(w + 8u);
  v_uv0 = ld4(w + 12u); v_uv1 = ld4(w + 16u); v_uv2 = ld4(w + 20u); v_uv3 = ld4(w + 24u);
  v_fog = 1.0;
}
`;

export const GL_FF_FS = (cube: boolean) => /* glsl */`#version 300 es
precision highp float;
precision highp int;
#ifndef ALPHA_FUNC
#define ALPHA_FUNC 7u
#endif
in vec4 v_col0; in vec4 v_col1;
in vec4 v_uv0; in vec4 v_uv1; in vec4 v_uv2; in vec4 v_uv3;
in float v_fog;
out vec4 fragColor;
layout(std140) uniform PSPar {
  float aref; float usec; float pad0; float pad1;
  vec4 proj;
  vec4 c[32];
  vec4 fog;
} P;
uniform ${cube ? 'samplerCube' : 'sampler2D'} tex0;
void main() {
  vec4 c = v_col0 * texture(tex0, ${cube ? 'v_uv0.xyz' : 'v_uv0.xy'});
  if (ALPHA_FUNC == 7u && c.a < P.aref) discard;
  fragColor = vec4(mix(P.fog.rgb, c.rgb, mix(1.0, clamp(v_fog, 0.0, 1.0), P.fog.a)), c.a);
}
`;

// Full-screen triangle.
// u_flipY = -1.0 when drawing to an FBO (D3D9 top-left -> GL row 0),
// u_flipY = +1.0 when compositing to the default canvas framebuffer (GL top = +1).
// u_rect = (u0, v0, du, dv) source UV sub-rectangle (default 0, 0, 1, 1).
export const GL_COPY_VS = /* glsl */`#version 300 es
precision highp float;
uniform vec4 u_rect;
uniform float u_flipY;
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p.x * 2.0 - 1.0, (1.0 - p.y * 2.0) * u_flipY, 0.0, 1.0);
  v_uv = u_rect.xy + p * u_rect.zw;
}
`;

export const GL_COPY_FS = (opaque: boolean) => /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
void main() {
  vec4 c = texture(u_src, v_uv);
  fragColor = ${opaque ? 'vec4(c.rgb, 1.0)' : 'c'};
}
`;

export const GL_TONE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform vec4 u_tone;
void main() {
  vec3 y = min(texture(u_src, v_uv).rgb * u_tone.x, vec3(1.0));
  float s = u_tone.z * u_tone.y;
  float m = (1.0 - s) / (u_tone.y - s);
  vec3 t = max(y - s, vec3(0.0)) / (1.0 - s);
  vec3 b = s + (u_tone.y - s) * (m * t) / (1.0 + (m - 1.0) * t);
  fragColor = vec4(mix(y, b, greaterThan(y, vec3(s))), 1.0);
}
`;

export const GL_REGION_CLEAR_VS = /* glsl */`#version 300 es
precision highp float;
uniform float u_z;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p.x * 2.0 - 1.0, p.y * 2.0 - 1.0, u_z * 2.0 - 1.0, 1.0);
}
`;

export const GL_REGION_CLEAR_FS = /* glsl */`#version 300 es
precision highp float;
uniform vec4 u_col;
out vec4 fragColor;
void main() {
  fragColor = u_col;
}
`;
