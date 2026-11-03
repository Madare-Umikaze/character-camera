/**
 * 幾何に関する共通の型。
 * 座標の単位(CSS ピクセル、正規化座標など)は、使う側の関数のドキュメントで明示する。
 */

/** 2 次元の点。 */
export interface Point2D {
  readonly x: number
  readonly y: number
}

/** 2 次元のサイズ。 */
export interface Size2D {
  readonly width: number
  readonly height: number
}

/** 矩形(左上が原点)。 */
export interface Rect2D {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 2 本の指(ポインター)の位置の組。 */
export interface PointerPair {
  readonly a: Point2D
  readonly b: Point2D
}