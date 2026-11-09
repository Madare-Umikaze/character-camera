import type { Point2D } from './geometry.ts'

/**
 * 射影変換(四隅の自由変形・遠近補正)に関する型。
 *
 * 座標系(画像ローカル座標):
 * - 画像の中心が原点、x が右、y が下。
 * - 画像全体は (-0.5, -0.5) 〜 (0.5, 0.5) の単位矩形。UV は (x + 0.5, y + 0.5)。
 * - 基本変形(移動・拡大縮小・回転・左右反転)は、この座標の「外側」で適用する。
 *   四隅は、基本変形を適用する前の座標で持つ。
 */

/**
 * 四隅の座標。頂点の順序は、常に次のとおり。
 *   0: 左上(Top Left)
 *   1: 右上(Top Right)
 *   2: 右下(Bottom Right)
 *   3: 左下(Bottom Left)
 */
export type Quad = readonly [Point2D, Point2D, Point2D, Point2D]

/** 四隅の番号。 */
export type CornerIndex = 0 | 1 | 2 | 3

/** すべての四隅の番号(順序は Quad と同じ)。 */
export const CORNER_INDICES: readonly CornerIndex[] = [0, 1, 2, 3]

/** 四隅の日本語名(順序は Quad と同じ)。 */
export const CORNER_LABELS: readonly [string, string, string, string] = [
  '左上',
  '右上',
  '右下',
  '左下',
]

/** 変形していない状態の四隅(単位矩形)。 */
export const UNIT_QUAD: Quad = [
  { x: -0.5, y: -0.5 },
  { x: 0.5, y: -0.5 },
  { x: 0.5, y: 0.5 },
  { x: -0.5, y: 0.5 },
]

/** 数値が四隅の番号として有効か。 */
export function isCornerIndex(value: number): value is CornerIndex {
  return value === 0 || value === 1 || value === 2 || value === 3
}

/**
 * 射影変換の状態。基本変形(CharacterImageState)とは別の型として管理する。
 */
export interface PerspectiveState {
  /** 変形後の四隅(画像ローカル座標)。初期値は単位矩形。常に有効な凸四角形。 */
  readonly corners: Quad
  /**
   * 横方向の遠近感スライダーの値(-1〜1)。
   * 正で左辺が大きく(手前に)、負で右辺が大きくなる。
   */
  readonly horizontal: number
  /**
   * 縦方向の遠近感スライダーの値(-1〜1)。
   * 正で上辺が広く、負で下辺が広くなる。
   */
  readonly vertical: number
}

/** 初期状態(変形なし)。 */
export const DEFAULT_PERSPECTIVE_STATE: PerspectiveState = {
  corners: UNIT_QUAD,
  horizontal: 0,
  vertical: 0,
}