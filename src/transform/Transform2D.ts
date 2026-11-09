import type { CharacterImageState } from '../types/character.ts'
import type { Point2D, Size2D } from '../types/geometry.ts'
import type { Quad } from '../types/perspective.ts'
import { buildCharacterMatrix } from './characterTransform.ts'
import { invertHomography } from './Homography.ts'
import { IDENTITY_MAT3, multiplyMat3, transformPoint } from './matrix.ts'
import type { Mat3 } from './matrix.ts'

/**
 * 基本変形(移動・拡大縮小・回転・左右反転)の行列。
 * DOM・WebGL には依存しない純粋関数。
 *
 * 画面座標への変換の全体像(右の行列が先に適用される):
 *
 *   P = Place · F · H
 *
 *   H     : 単位矩形 → 変形後の四隅(PerspectiveTransform.ts)
 *   F     : 左右反転。flipX のとき diag(-1, 1, 1)、それ以外は単位行列
 *   Place : 拡大縮小 → 回転 → 平行移動(characterTransform.ts の buildCharacterMatrix)
 *
 * このファイルが扱うのは Base = Place · F。
 * 四隅は、Base を適用する前の「画像ローカル座標」(中心が原点、画像は -0.5〜0.5)で持つ。
 * 反転は Place の内側で適用するため、画面上の回転の向きや、
 * 2 本指操作の挙動は反転の有無に影響されない。
 */

/** 左右反転の行列(画像ローカル座標の x を反転する)。列優先。 */
export const FLIP_X_MATRIX: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1]

/** flipX に対応する反転行列を返す。反転しない場合は単位行列。 */
export function buildFlipMatrix(flipX: boolean): Mat3 {
  return flipX ? FLIP_X_MATRIX : IDENTITY_MAT3
}

/**
 * 基本変形の行列 Base = Place · F を返す。
 * 「画像ローカル座標 → プレビューの CSS ピクセル座標」を写すアフィン行列。
 *
 * @param imageSize 画像のサイズ(ピクセル)。縦横比と基準サイズの計算に使う。
 * @param viewport プレビューの表示サイズ(CSS ピクセル)。
 */
export function buildBaseMatrix(
  state: CharacterImageState,
  imageSize: Size2D,
  viewport: Size2D,
): Mat3 {
  const place = buildCharacterMatrix(state, imageSize, viewport)
  return multiplyMat3(place, buildFlipMatrix(state.flipX))
}

/** 画像ローカル座標の点を、画面座標へ変換する。変換できない場合は null。 */
export function localToScreen(base: Mat3, point: Point2D): Point2D | null {
  return transformPoint(base, point)
}

/**
 * 画面座標の点を、画像ローカル座標へ戻す。
 * 基本変形が特異(画像またはプレビューのサイズが 0 など)の場合は null。
 */
export function screenToLocal(base: Mat3, point: Point2D): Point2D | null {
  const inverse = invertHomography(base)
  if (inverse === null) {
    return null
  }
  return transformPoint(inverse, point)
}

/**
 * ローカル座標の四隅を、画面座標の四隅へ変換する(頂点の順序は保たれる)。
 * ハンドルの表示位置の計算に使う。1 点でも変換できなければ null。
 */
export function mapQuadToScreen(base: Mat3, quad: Quad): Quad | null {
  const a = transformPoint(base, quad[0])
  const b = transformPoint(base, quad[1])
  const c = transformPoint(base, quad[2])
  const d = transformPoint(base, quad[3])
  if (a === null || b === null || c === null || d === null) {
    return null
  }
  return [a, b, c, d]
}