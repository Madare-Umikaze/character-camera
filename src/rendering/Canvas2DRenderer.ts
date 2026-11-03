import type { Size2D } from '../types/geometry.ts'
import type { FrameInput, OverlayRenderer, RendererKind } from './OverlayRenderer.ts'

/**
 * Canvas 2D によるオーバーレイ描画(WebGL2 が使えない場合のフォールバック)。
 *
 * - 背景は rect に収めて描く。キャラクターの行列は背景には適用しない。
 * - キャラクターはアフィン変換のみ対応する(行列の射影成分 [2], [5] は無視する)。
 * - 座標系は CSS ピクセル。内部解像度との比を setTransform に掛けて描く。
 */

/** video に現在のフレームがあり、描画できるか。 */
function isVideoReady(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

export class Canvas2DRenderer implements OverlayRenderer {
  readonly kind: RendererKind = 'canvas2d'

  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private cssSize: Size2D = { width: 0, height: 0 }
  private pixelSize: Size2D = { width: 0, height: 0 }
  private disposed = false

  constructor(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
    this.canvas = canvas
    this.context = context
  }

  resize(cssSize: Size2D, pixelSize: Size2D): void {
    this.cssSize = cssSize
    this.pixelSize = pixelSize
    if (this.canvas.width !== pixelSize.width) {
      this.canvas.width = pixelSize.width
    }
    if (this.canvas.height !== pixelSize.height) {
      this.canvas.height = pixelSize.height
    }
  }

  render(frame: FrameInput): void {
    if (this.disposed) {
      return
    }
    if (
      !(this.cssSize.width > 0) ||
      !(this.cssSize.height > 0) ||
      this.pixelSize.width <= 0 ||
      this.pixelSize.height <= 0
    ) {
      return
    }

    const ctx = this.context
    const sx = this.pixelSize.width / this.cssSize.width
    const sy = this.pixelSize.height / this.cssSize.height

    // 背景を黒で塗りつぶす。
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // --- 背景レイヤー ---
    const background = frame.background
    if (
      background !== null &&
      background.rect.width > 0 &&
      background.rect.height > 0 &&
      isVideoReady(background.source)
    ) {
      ctx.setTransform(sx, 0, 0, sy, 0, 0)
      ctx.drawImage(
        background.source,
        background.rect.x,
        background.rect.y,
        background.rect.width,
        background.rect.height,
      )
    }

    // --- 前景レイヤー(キャラクター) ---
    const character = frame.character
    if (character !== null) {
      const m = character.matrix
      // 列優先の 3×3 行列から、アフィン成分(a, b, c, d, e, f)を取り出す。
      //   x' = m[0]·x + m[3]·y + m[6]
      //   y' = m[1]·x + m[4]·y + m[7]
      ctx.setTransform(sx * m[0], sy * m[1], sx * m[3], sy * m[4], sx * m[6], sy * m[7])
      ctx.globalAlpha = Math.min(Math.max(character.opacity, 0), 1)
      // 単位矩形(-0.5〜0.5)に画像全体を描く。
      ctx.drawImage(character.bitmap, -0.5, -0.5, 1, 1)
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
  }

  dispose(): void {
    this.disposed = true
  }
}

/**
 * canvas から 2D コンテキストを取得して、描画器を作る。
 * 取得できない場合は null を返す。
 */
export function createCanvas2DRenderer(
  canvas: HTMLCanvasElement,
): Canvas2DRenderer | null {
  const context = canvas.getContext('2d', { alpha: false })
  if (context === null) {
    return null
  }
  return new Canvas2DRenderer(canvas, context)
}