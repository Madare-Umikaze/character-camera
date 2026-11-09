import { composeProjection } from '../transform/PerspectiveTransform.ts'
import { buildBaseMatrix } from '../transform/Transform2D.ts'
import type { CharacterImageState } from '../types/character.ts'
import type { Size2D } from '../types/geometry.ts'
import type { PerspectiveState } from '../types/perspective.ts'
import { createOverlayRenderer } from './createOverlayRenderer.ts'
import type {
  OverlayRendererHandle,
  RendererPreference,
} from './createOverlayRenderer.ts'
import { computeCanvasPixelSize, computeContainRect } from './layout.ts'
import type { CharacterLayer, FrameInput, RendererKind } from './OverlayRenderer.ts'

/**
 * 描画に必要なキャラクターの内容。
 * rendering/ が image/ に依存しないよう、必要な値だけをこの型で受け取る。
 */
export interface CharacterContent {
  /** 描画する画像。close() してはいけない(所有者は呼び出し側)。 */
  readonly bitmap: ImageBitmap
  /** 画像のサイズ(ピクセル)。 */
  readonly imageSize: Size2D
  /** 基本変形・表示状態。 */
  readonly state: CharacterImageState
  /** 射影変換(四隅・遠近感)の状態。 */
  readonly perspective: PerspectiveState
}

/** 描画する内容の提供元。毎フレーム呼ばれる。 */
export interface PreviewContentProvider {
  /** 表示するキャラクターがない場合は null。 */
  getCharacter(): CharacterContent | null
}

/**
 * プレビューの描画ループと、canvas の管理を担当する。
 *
 * - 背景(カメラ映像)は contain 配置。キャラクターの変形は背景に影響しない。
 * - キャラクターの行列は P = Base · H(基本変形と、四隅の射影変換)。背景には渡さない。
 * - カメラ稼働中は毎フレーム描画し、停止中は要求があったときだけ描画する。
 * - canvas の内部解像度は、CSS サイズ × devicePixelRatio(上限あり)。
 * - 映像の寸法は毎フレーム video 要素から読むため、映像の向きや大きさが変わっても追従する。
 * - カメラやキャラクター画像のモジュールには依存しない。
 */
export class PreviewPresenter {
  private readonly host: HTMLElement
  private readonly video: HTMLVideoElement
  private readonly provider: PreviewContentProvider
  private readonly preference: RendererPreference

  private handle: OverlayRendererHandle | null = null
  private cssSize: Size2D = { width: 0, height: 0 }
  private live = false
  private frameHandle: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private disposed = false
  private renderErrorLogged = false

  private readonly onFrame = (): void => {
    this.frameHandle = null
    this.renderNow()
    if (this.live) {
      this.schedule()
    }
  }

  private readonly onWindowResize = (): void => {
    this.measure()
  }

  /** 映像の寸法が変わったとき、停止中でも描き直す。 */
  private readonly onVideoResize = (): void => {
    this.requestRender()
  }

  /**
   * @param host canvas を配置する要素。CSS で大きさが決まっている前提(position: relative を推奨)。
   * @param video 背景の映像ソース。
   * @param provider 描画する内容の提供元。
   * @param preference 描画方式の希望。
   */
  constructor(
    host: HTMLElement,
    video: HTMLVideoElement,
    provider: PreviewContentProvider,
    preference: RendererPreference,
  ) {
    this.host = host
    this.video = video
    this.provider = provider
    this.preference = preference
  }

  /**
   * canvas を配置して、描画を開始できる状態にする。
   * 使用する描画方式を返す。描画器を作れなかった場合は null。
   * 二重に呼ばれた場合は、現在の描画方式を返す。
   */
  start(): RendererKind | null {
    if (this.disposed) {
      return null
    }
    if (this.handle !== null) {
      return this.handle.renderer.kind
    }

    const handle = createOverlayRenderer(createPreviewCanvas, this.preference)
    if (handle === null) {
      return null
    }
    this.handle = handle

    // プレースホルダーやエラー表示より背面に置く。
    this.host.prepend(handle.canvas)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.measure()
      })
      this.resizeObserver.observe(this.host)
    } else {
      window.addEventListener('resize', this.onWindowResize)
    }
    this.video.addEventListener('resize', this.onVideoResize)

    this.measure()
    this.requestRender()
    return handle.renderer.kind
  }

  /** 使用中の描画方式。開始前や失敗時は null。 */
  getKind(): RendererKind | null {
    return this.handle === null ? null : this.handle.renderer.kind
  }

  /** プレビューの表示サイズ(CSS ピクセル)。タッチ操作の座標計算に使う。 */
  getViewportSize(): Size2D {
    return { width: this.cssSize.width, height: this.cssSize.height }
  }

  /** プレビューの canvas。開始前や失敗時は null。 */
  getCanvas(): HTMLCanvasElement | null {
    return this.handle === null ? null : this.handle.canvas
  }

  /**
   * カメラ映像が流れているかを設定する。
   * true の間は毎フレーム描画する。false にすると、最後に 1 回描画して止まる。
   */
  setLive(live: boolean): void {
    this.live = live
    if (live) {
      this.schedule()
    } else {
      this.requestRender()
    }
  }

  /** 次のフレームで 1 回描画するよう要求する。状態が変わったときに呼ぶ。 */
  requestRender(): void {
    this.schedule()
  }

  /**
   * 表示領域の寸法を測り直し、canvas の内部解像度を更新して、その場で描き直す。
   * 画面の向きが変わった後など、レイアウトが変わった可能性があるときに呼ぶ。
   * 結果が同じなら何も変わらないため、重複して呼んでも問題ない。
   */
  refreshLayout(): void {
    this.measure()
  }

  /** すべてのリソースを解放する。以降は使用しない。 */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true

    if (this.frameHandle !== null) {
      window.cancelAnimationFrame(this.frameHandle)
      this.frameHandle = null
    }
    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    window.removeEventListener('resize', this.onWindowResize)
    this.video.removeEventListener('resize', this.onVideoResize)

    if (this.handle !== null) {
      this.handle.renderer.dispose()
      this.handle.canvas.remove()
      this.handle = null
    }
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  private schedule(): void {
    if (this.disposed || this.handle === null || this.frameHandle !== null) {
      return
    }
    this.frameHandle = window.requestAnimationFrame(this.onFrame)
  }

  /** host の現在のサイズを読み取り、canvas の内部解像度を更新する。 */
  private measure(): void {
    const handle = this.handle
    if (this.disposed || handle === null) {
      return
    }
    const width = this.host.clientWidth
    const height = this.host.clientHeight
    this.cssSize = { width, height }

    const pixelSize = computeCanvasPixelSize(this.cssSize, window.devicePixelRatio)
    handle.renderer.resize(this.cssSize, pixelSize)

    // canvas のサイズを変えると内容が消えるため、その場で描き直す。
    this.renderNow()
  }

  /** 現在の内容を 1 フレーム描画する。 */
  private renderNow(): void {
    const handle = this.handle
    if (this.disposed || handle === null) {
      return
    }

    if (!(this.cssSize.width > 0) || !(this.cssSize.height > 0)) {
      return
    }

    try {
      handle.renderer.render(this.buildFrame())
    } catch (error: unknown) {
      // 描画の失敗でループを止めない。ログは 1 回だけ出す。
      if (!this.renderErrorLogged) {
        this.renderErrorLogged = true
        console.error('描画中にエラーが発生しました:', error)
      }
    }
  }

  /** 現在の内容から、1 フレーム分の描画入力を組み立てる。 */
  private buildFrame(): FrameInput {
    // 背景。映像が準備できていない場合、rect の幅・高さは 0 になり、描画器は描かない。
    // 映像の寸法は毎フレーム video 要素から読むため、向きや大きさの変化に追従する。
    // キャラクターの状態は、ここには一切入らない。
    const background = {
      source: this.video,
      rect: computeContainRect(
        { width: this.video.videoWidth, height: this.video.videoHeight },
        this.cssSize,
      ),
    }

    // 前景。背景の rect とは独立に、キャラクター自身の状態だけから行列を作る。
    //   P = Base · H(H が先に適用される)
    let character: CharacterLayer | null = null
    const content = this.provider.getCharacter()
    if (
      content !== null &&
      content.state.visible &&
      content.imageSize.width > 0 &&
      content.imageSize.height > 0
    ) {
      const base = buildBaseMatrix(content.state, content.imageSize, this.cssSize)
      // 四隅は検証済みの状態だけを持つため、通常は null にならない。
      // 万一ホモグラフィを求められない場合は、四隅を無視して基本変形だけで描く。
      const matrix = composeProjection(base, content.perspective.corners) ?? base
      character = {
        bitmap: content.bitmap,
        matrix,
        opacity: content.state.opacity,
      }
    }

    return { background, character }
  }
}

/** プレビュー用の canvas を作る。見た目のサイズは CSS(.preview-canvas)で決める。 */
function createPreviewCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'preview-canvas'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'カメラ映像とキャラクター画像の合成プレビュー')
  return canvas
}