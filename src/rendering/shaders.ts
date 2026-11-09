/**
 * WebGL2 用の GLSL ソース。
 * 実行時の fetch を避け、GitHub Pages のサブパスやオフライン対応での失敗要因を減らすため、
 * 文字列定数として持つ。
 *
 * `#version` 行は、ソースの先頭(空白・改行の前)になければならない。
 *
 * 2 組のシェーダーがある。
 * - QUAD_*:背景(カメラ映像)用。アフィンの矩形を描くだけ。キャラクターの変形は関与しない。
 * - PROJECTIVE_*:キャラクター用。四隅の射影変換を、画素ごとの逆変換で描く。
 */

/**
 * 背景用の頂点シェーダー。
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
 * 背景用のフラグメントシェーダー。
 * 不透明度を全チャンネルに掛ける。
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

/**
 * キャラクター用の頂点シェーダー。
 * u_matrix は「画像ローカル座標(単位矩形)→ クリップ座標」の射影行列(Mat3、列優先)。
 * 単位矩形の 4 頂点に適用し、w で割って、変形後の四隅のクリップ座標にする。
 * 割った後の位置を v_clip としてフラグメントシェーダーへ渡す。
 * gl_Position.w は 1 なので、v_clip は画面空間で線形に補間される。
 */
export const PROJECTIVE_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform mat3 u_matrix;
out vec2 v_clip;

void main() {
  vec3 p = u_matrix * vec3(a_position, 1.0);
  vec2 clip = p.xy / p.z;
  v_clip = clip;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`

/**
 * キャラクター用のフラグメントシェーダー。
 * u_inverse は「クリップ座標 → 画像ローカル座標」の逆行列。
 * 画素ごとに逆変換を適用し、w で割って、元画像の UV を求める(画像全体が射影変換される)。
 * テクスチャはプリマルチプライドアルファで保持している前提で、不透明度を全チャンネルに掛ける。
 * 透過 PNG の透明部分は、そのまま保たれる。
 */
export const PROJECTIVE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_clip;
uniform sampler2D u_texture;
uniform mat3 u_inverse;
uniform float u_opacity;
out vec4 outColor;

void main() {
  vec3 q = u_inverse * vec3(v_clip, 1.0);
  vec2 uv = q.xy / q.z + vec2(0.5);
  vec4 color = texture(u_texture, uv);
  outColor = color * u_opacity;
}
`