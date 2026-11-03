import type { Mat3 } from '../transform/matrix.ts'
import type { Rect2D, Size2D } from '../types/geometry.ts'

/**
 * WebGL2 と Canvas 2D が共通で実装する、オーバーレイ描画のインターフェース。
 *
 * - 背景(カメラ映像)とキャラクターは、別々のフィールドで渡す。
 * - 背景の配置(rect)とキャラクターの行列(matrix)は、呼び出し側が計算して渡す。
 *   描画側は、計算済みの値を描くだけにする。
 * - キャラクターの変形は、キャラクターの行列にのみ含まれる。背景には適用されない。
 * - 座標はすべて、プレビューの CSS ピクセル(左上が原点、Y が下向き)。
 */

/** 使用中の描画方式。 */
export type RendererKind = 'webgl2' | 'canvas2d'

/** 背景レイヤー(カメラ映像)。 */
export interface BackgroundLayer {
  /** 映像の取得元。現在のフレームを描く。 */
  readonly source: HTMLVideoElement
  /** 映像を表示する矩形(contain 配置の結果)。 */
  readonly rect: Rect2D
}

/** 前景レイヤー(キャラクター画像)。 */
export interface CharacterLayer {
  /** 描画する画像。close() してはいけない(所有者は CharacterImage)。 */
  readonly bitmap: ImageBitmap
  /**
   * 「中心が原点の 1×1 の単位矩形」を CSS ピクセル座標へ写す行列。
   * Phase 3 では、四隅から求める射影変換の行列に置き換わる。
   */
  readonly matrix: Mat3
  /** 不透明度(0〜1)。 */
  readonly opacity: number
}

/** 1 フレームに描くもの。null のレイヤーは描かない。 */
export interface FrameInput {
  readonly background: BackgroundLayer | null
  readonly character: CharacterLayer | null
}

/** オーバーレイ描画のインターフェース。 */
export interface OverlayRenderer {
  /** 使用中の描画方式。 */
  readonly kind: RendererKind

  /**
   * 描画面のサイズを設定する。
   * @param cssSize 表示サイズ(CSS ピクセル)。座標系の基準。
   * @param pixelSize canvas の内部解像度(ピクセル)。
   */
  resize(cssSize: Size2D, pixelSize: Size2D): void

  /** 1 フレームを描画する。 */
  render(frame: FrameInput): void

  /** リソースを解放する。以降は使用しない。 */
  dispose(): void
}