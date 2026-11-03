/**
 * WebGL2 用の GLSL ソース。
 * 実行時の fetch を避け、GitHub Pages のサブパスやオフライン対応での失敗要因を減らすため、
 * 文字列定数として持つ。
 *
 * `#version` 行は、ソースの先頭(空白・改行の前)になければならない。
 */

/**
 * 頂点シェーダー。
 * a_position は、中心が原点の 1×1 の単位矩形の頂点(-0.5〜0.5)。
 * u_matrix で、単位矩形をクリップ座標へ写す。
 * テクスチャ座標は、単位矩形の左上が (0, 0)(画像の左上)になる。
 */
export const QUAD_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform mat3 u_matrix;
out vec2 v_uv;

void main() {
  vec3 p = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = a_position + vec2(0.5);
}
`

/**
 * フラグメントシェーダー。
 * テクスチャはプリマルチプライドアルファで保持している前提で、不透明度を全チャンネルに掛ける。
 */
export const QUAD_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
out vec4 outColor;

void main() {
  vec4 color = texture(u_texture, v_uv);
  outColor = color * u_opacity;
}
`