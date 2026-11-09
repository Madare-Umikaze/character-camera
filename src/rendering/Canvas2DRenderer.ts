import { transformPoint } from '../transform/matrix.ts'
import type { Mat3 } from '../transform/matrix.ts'
import type { Point2D, Size2D } from '../types/geometry.ts'
import type {
  CharacterLayer,
  FrameInput,
  OverlayRenderer,
  RendererKind,
} from './OverlayRenderer.ts'

/**
 * Canvas 2D によるオーバーレイ描画(WebGL2 が使えない場合のフォールバック)。
 *
 * - 背景は rect に収めて描く。キャラクターの行列は背景には適用しない。
 * - キャラクターの行列がアフィンなら、Phase 2 と同じく 1 回の drawImage で描く。
 * - 射影成分を含む場合は、画像をメッシュに分割し、三角形ごとのアフィン変換で近似する。
 *   Canvas 2D は射影変換を直接表現できないため、WebGL2 とは見た目が少し異なる場合がある。
 * - 座標系は CSS ピクセル。内部解像度との比を setTransform に掛けて描く。
 */

/** メッシュの分割数(縦・横それぞれ)。 */
const MESH_DIVISIONS = 10

/** 三角形のクリップを外側へ広げる量(デバイスピクセル)。継ぎ目の隙間を防ぐ。 */
const CLIP_EXPANSION_DEVICE_PX = 1

/** 射影成分がこの値未満なら、アフィンとして扱う。 */
const AFFINE_EPSILON = 1e-9

/** 三角形の頂点(3 点)。 */
type Triangle = readonly [Point2D, Point2D, Point2D]

/** 3 点対応から求めたアフィン変換(setTransform の a, b, c, d, e, f)。 */
interface AffineParams {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly f: number
}

/** 不透明度 1 未満のメッシュを、いったん描いておくための canvas。 */
interface LayerSurface {
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
}

/** video に現在のフレームがあり、描画できるか。 */
function isVideoReady(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

/** 行列がアフィン変換(射影成分なし)か。 */
function isAffineMatrix(m: Mat3): boolean {
  return (
    Math.abs(m[2]) < AFFINE_EPSILON &&
    Math.abs(m[5]) < AFFINE_EPSILON &&
    Math.abs(m[8] - 1) < AFFINE_EPSILON
  )
}

/**
 * 元の三角形 src を、画面上の三角形 dst に写すアフィン変換を求める。
 * 元の三角形が潰れている、または結果が有限でない場合は null。
 */
function computeTriangleAffine(src: Triangle, dst: Triangle): AffineParams | null {
  const [s0, s1, s2] = src
  const [d0, d1, d2] = dst

  const a1 = s1.x - s0.x
  const b1 = s1.y - s0.y
  const a2 = s2.x - s0.x
  const b2 = s2.y - s0.y
  const det = a1 * b2 - a2 * b1
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    return null
  }

  const dx1 = d1.x - d0.x
  const dx2 = d2.x - d0.x
  const dy1 = d1.y - d0.y
  const dy2 = d2.y - d0.y

  const a = (dx1 * b2 - dx2 * b1) / det
  const c = (a1 * dx2 - a2 * dx1) / det
  const b = (dy1 * b2 - dy2 * b1) / det
  const d = (a1 * dy2 - a2 * dy1) / det
  const e = d0.x - a * s0.x - c * s0.y
  const f = d0.y - b * s0.x - d * s0.y

  if (![a, b, c, d, e, f].every((value) => Number.isFinite(value))) {
    return null
  }
  return { a, b, c, d, e, f }
}

/** 三角形を、重心から各頂点の方向へ、少しだけ広げる。 */
function expandTriangle(triangle: Triangle, amount: number): Triangle {
  const [p0, p1, p2] = triangle
  const cx = (p0.x + p1.x + p2.x) / 3
  const cy = (p0.y + p1.y + p2.y) / 3
  const push = (p: Point2D): Point2D => {
    const dx = p.x - cx
    const dy = p.y - cy
    const length = Math.hypot(dx, dy)
    if (!(length > 0)) {
      return p
    }
    return { x: p.x + (dx / length) * amount, y: p.y + (dy / length) * amount }
  }
    return [push(p0), push(p1), push(p2)]
}

/**
 * 三角形 1 枚を描く。
 * 画面上の三角形でクリップし、元画像の対応範囲だけを、アフィン変換つきで描く。
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  src: Triangle,
  dst: Triangle,
  scaleX: number,
  scaleY: number,
  padX: number,
  padY: number,
): void {
  const affine = computeTriangleAffine(src, dst)
  if (affine === null) {
    return
  }

  const expanded = expandTriangle(dst, CLIP_EXPANSION_DEVICE_PX / Math.min(scaleX, scaleY))

  // 元画像の、この三角形の周辺だけを描く(余白つき)。
  const xs = [src[0].x, src[1].x, src[2].x]
  const ys = [src[0].y, src[1].y, src[2].y]
  const minX = Math.max(0, Math.min(...xs) - padX)
  const maxX = Math.min(bitmap.width, Math.max(...xs) + padX)
  const minY = Math.max(0, Math.min(...ys) - padY)
  const maxY = Math.min(bitmap.height, Math.max(...ys) + padY)
  const sw = maxX - minX
  const sh = maxY - minY
  if (!(sw > 0) || !(sh > 0)) {
    return
  }

  ctx.save()
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
  ctx.beginPath()
  ctx.moveTo(expanded[0].x, expanded[0].y)
  ctx.lineTo(expanded[1].x, expanded[1].y)
  ctx.lineTo(expanded[2].x, expanded[2].y)
  ctx.closePath()
  ctx.clip()

  ctx.setTransform(
    scaleX * affine.a,
    scaleY * affine.b,
    scaleX * affine.c,
    scaleY * affine.d,
    scaleX * affine.e,
    scaleY * affine.f,
  )
  ctx.drawImage(bitmap, minX, minY, sw, sh, minX, minY, sw, sh)
  ctx.restore()
}

/**
 * 射影行列で変形した画像を、メッシュ分割(三角形ごとのアフィン変換)で近似して描く。
 * 格子点のどれかが変換できない(w が 0 など)場合は、何も描かない。
 *
 * @param scaleX CSS ピクセルからデバイスピクセルへの倍率(横)
 * @param scaleY 同(縦)
 */
function drawProjectiveMesh(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  matrix: Mat3,
  scaleX: number,
  scaleY: number,
): void {
  const width = bitmap.width
  const height = bitmap.height
  if (width <= 0 || height <= 0) {
    return
  }

  const n = MESH_DIVISIONS
  const stride = n + 1
  const screen: Point2D[] = []
  const source: Point2D[] = []
  for (let j = 0; j <= n; j += 1) {
    for (let i = 0; i <= n; i += 1) {
      const u = i / n
      const v = j / n
      const p = transformPoint(matrix, { x: u - 0.5, y: v - 0.5 })
      if (p === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return
      }
      screen.push(p)
      source.push({ x: u * width, y: v * height })
    }
  }

  // 元画像の 1 マスの大きさの 25% を、描く範囲の余白にする。
  const padX = (width / n) * 0.25
  const padY = (height / n) * 0.25

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const index = j * stride + i
      const d00 = screen[index]
      const d10 = screen[index + 1]
      const d01 = screen[index + stride]
      const d11 = screen[index + stride + 1]
      const s00 = source[index]
      const s10 = source[index + 1]
      const s01 = source[index + stride]
      const s11 = source[index + stride + 1]
      if (
        d00 === undefined ||
        d10 === undefined ||
        d01 === undefined ||
        d11 === undefined ||
        s00 === undefined ||
        s10 === undefined ||
        s01 === undefined ||
        s11 === undefined
      ) {
        continue
      }
      drawTriangle(ctx, bitmap, [s00, s10, s11], [d00, d10, d11], scaleX, scaleY, padX, padY)
      drawTriangle(ctx, bitmap, [s00, s11, s01], [d00, d11, d01], scaleX, scaleY, padX, padY)
    }
  }
}

export class Canvas2DRenderer implements OverlayRenderer {
  readonly kind: RendererKind = 'canvas2d'

  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private cssSize: Size2D = { width: 0, height: 0 }
  private pixelSize: Size2D = { width: 0, height: 0 }
  /** 不透明度 1 未満の射影描画に使う canvas。必要になったときに作る。 */
  private layerSurface: LayerSurface | null = null
  private layerSurfaceFailed = false
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

    // --- 背景レイヤー(キャラクターの変形とは無関係) ---
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
      this.drawCharacter(character, sx, sy)
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
  }

  dispose(): void {
    this.disposed = true
    if (this.layerSurface !== null) {
      // メモリを早めに解放する。
      this.layerSurface.canvas.width = 0
      this.layerSurface.canvas.height = 0
      this.layerSurface = null
    }
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  private drawCharacter(layer: CharacterLayer, sx: number, sy: number): void {
    const ctx = this.context
    const m = layer.matrix
    const opacity = Math.min(Math.max(layer.opacity, 0), 1)

    // アフィン(射影成分なし):1 回の drawImage で描く。
    if (isAffineMatrix(m)) {
      // 列優先の 3×3 行列から、アフィン成分(a, b, c, d, e, f)を取り出す。
      //   x' = m[0]·x + m[3]·y + m[6]
      //   y' = m[1]·x + m[4]·y + m[7]
      ctx.setTransform(sx * m[0], sy * m[1], sx * m[3], sy * m[4], sx * m[6], sy * m[7])
      ctx.globalAlpha = opacity
      // 単位矩形(-0.5〜0.5)に画像全体を描く。
      ctx.drawImage(layer.bitmap, -0.5, -0.5, 1, 1)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      return
    }

    // 射影成分あり、不透明:メッシュを直接描く。
    if (opacity >= 1) {
      drawProjectiveMesh(ctx, layer.bitmap, m, sx, sy)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      return
    }

    // 射影成分あり、半透明:継ぎ目が濃く見えないよう、いったん不透明で別の canvas に描く。
    const surface = this.ensureLayerSurface()
    if (surface === null) {
      // 別の canvas を作れない場合は、直接描く(継ぎ目が見える可能性がある)。
      ctx.globalAlpha = opacity
      drawProjectiveMesh(ctx, layer.bitmap, m, sx, sy)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      return
    }
    const layerCtx = surface.context
    layerCtx.setTransform(1, 0, 0, 1, 0, 0)
    layerCtx.globalAlpha = 1
    layerCtx.clearRect(0, 0, surface.canvas.width, surface.canvas.height)
    drawProjectiveMesh(layerCtx, layer.bitmap, m, sx, sy)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = opacity
    ctx.drawImage(surface.canvas, 0, 0)
    ctx.globalAlpha = 1
  }

  /** 半透明の射影描画に使う canvas を、メインの canvas と同じ大きさで用意する。 */
  private ensureLayerSurface(): LayerSurface | null {
    if (this.layerSurfaceFailed) {
      return null
    }
    if (this.layerSurface === null) {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (context === null) {
        this.layerSurfaceFailed = true
        return null
      }
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      this.layerSurface = { canvas, context }
    }
    const { canvas, context } = this.layerSurface
    if (canvas.width !== this.canvas.width) {
      canvas.width = this.canvas.width
      // サイズの変更でコンテキストの設定が戻る場合があるため、設定し直す。
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
    }
    if (canvas.height !== this.canvas.height) {
      canvas.height = this.canvas.height
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
    }
    return this.layerSurface
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