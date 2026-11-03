import type { Rect2D, Size2D } from '../types/geometry.ts'

/**
 * 描画のレイアウトに関する純粋な計算。
 * DOM・WebGL には依存しない。単位は、特記がなければ CSS ピクセル。
 */

/** canvas の内部解像度の、1 辺あたりの上限(ピクセル)。 */
export const MAX_CANVAS_DIMENSION = 4096

/** devicePixelRatio の下限・上限。 */
const MIN_DEVICE_PIXEL_RATIO = 0.5
const MAX_DEVICE_PIXEL_RATIO = 4

/**
 * コンテンツ(映像など)を、縦横比を保ったまま、表示領域に全体が収まるように配置した矩形を返す。
 * 領域の中央に置き、拡大縮小のみで、切り取りや引き伸ばしはしない。
 * どちらかのサイズが 0 以下のときは、すべて 0 の矩形を返す。
 */
export function computeContainRect(content: Size2D, viewport: Size2D): Rect2D {
  if (
    !(content.width > 0) ||
    !(content.height > 0) ||
    !(viewport.width > 0) ||
    !(viewport.height > 0)
  ) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const fit = Math.min(viewport.width / content.width, viewport.height / content.height)
  const width = content.width * fit
  const height = content.height * fit
  return {
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
    width,
    height,
  }
}

/** devicePixelRatio を有効な範囲に収める。有効でない値は 1 にする。 */
export function sanitizeDevicePixelRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 1
  }
  return Math.min(Math.max(ratio, MIN_DEVICE_PIXEL_RATIO), MAX_DEVICE_PIXEL_RATIO)
}

/**
 * CSS 表示サイズと devicePixelRatio から、canvas の内部解像度(整数ピクセル)を返す。
 * 長辺が maxDimension を超える場合は、縦横比を保って縮める。
 * 表示サイズが 0 以下のときは、幅・高さとも 0 を返す。
 */
export function computeCanvasPixelSize(
  cssSize: Size2D,
  devicePixelRatio: number,
  maxDimension: number = MAX_CANVAS_DIMENSION,
): Size2D {
  if (!(cssSize.width > 0) || !(cssSize.height > 0)) {
    return { width: 0, height: 0 }
  }
  const ratio = sanitizeDevicePixelRatio(devicePixelRatio)
  const rawWidth = cssSize.width * ratio
  const rawHeight = cssSize.height * ratio

  const longSide = Math.max(rawWidth, rawHeight)
  const shrink = longSide > maxDimension ? maxDimension / longSide : 1

  return {
    width: Math.max(1, Math.round(rawWidth * shrink)),
    height: Math.max(1, Math.round(rawHeight * shrink)),
  }
}