import {
  applyPinch,
  panBy,
  wheelZoomFactor,
  zoomAt,
} from '../transform/characterTransform.ts'
import { findNearestCornerIndex } from '../transform/PerspectiveTransform.ts'
import type { CharacterImageState } from '../types/character.ts'
import type { Point2D, PointerPair, Size2D } from '../types/geometry.ts'
import type { CornerIndex, Quad } from '../types/perspective.ts'

/**
 * GestureHandler が必要とする操作対象の最小インターフェース。
 * image/ や rendering/ の内部実装には依存せず、main.ts が実体を注入する。
 */
export interface GestureHost {
  /** 操作を受け付けるか(画像がある場合に true)。 */
  isEnabled(): boolean
  /** プレビューの表示サイズ(CSS ピクセル)。 */
  getViewportSize(): Size2D
  /** 基本変形の状態を、与えた関数で更新する。 */
  update(updater: (state: CharacterImageState) => CharacterImageState): void
  /**
   * 四隅ハンドルの画面上の位置(対象要素の左上を原点とした CSS ピクセル)。
   * 頂点の順序は、左上・右上・右下・左下。
   * ハンドルが非表示のとき、または画像がないときは null(ハンドル操作は無効)。
   */
  getHandlePositions(): Quad | null
  /**
   * 頂点を、画面上の目標位置(対象要素の左上を原点とした CSS ピクセル)へ動かす。
   * 不正な変形になる場合に、どこで止めるかは、呼び出し先が決める。
   */
  moveHandle(index: CornerIndex, screenPoint: Point2D): void
  /** 操作中のハンドルを通知する(強調表示用)。操作が終わると null。 */
  setActiveHandle(index: CornerIndex | null): void
}

/** 先頭 2 本のポインターの情報。 */
interface ActivePair {
  readonly idA: number
  readonly idB: number
  readonly a: Point2D
  readonly b: Point2D
}

/** ハンドルを掴んでいる間の状態。 */
interface HandleDrag {
  readonly pointerId: number
  readonly index: CornerIndex
  /** 掴んだ時点の、ハンドルの位置と指の位置のずれ(ハンドルが指に飛ばないようにする)。 */
  readonly offset: Point2D
}

/** ドラッグ中に対象要素へ付けるクラス名(カーソル表示用)。 */
const DRAGGING_CLASS = 'preview-canvas--dragging'

/** ハンドルを掴める距離(CSS ピクセル)。タッチ・ペンは指の誤差を考えて広めにする。 */
export const HANDLE_GRAB_RADIUS_TOUCH = 28
export const HANDLE_GRAB_RADIUS_MOUSE = 16

/** WheelEvent.deltaMode の値。 */
const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2

function grabRadiusFor(pointerType: string): number {
  return pointerType === 'mouse' ? HANDLE_GRAB_RADIUS_MOUSE : HANDLE_GRAB_RADIUS_TOUCH
}

/**
 * Pointer Events によるキャラクター画像の操作。
 *
 * - ハンドルの近くを 1 本目の指・マウスで触る: 最も近い四隅のハンドルを動かす(射影変換)
 * - それ以外の 1 本指・マウスの左ドラッグ: 移動
 * - 2 本指: 拡大縮小・回転・移動(指の中点を基準にする)
 * - マウスホイール: カーソル位置を基準に拡大縮小
 *
 * カメラ映像には何も操作しない。変形はキャラクターの状態にだけ反映される。
 */
export class GestureHandler {
  private readonly target: HTMLElement
  private readonly host: GestureHost
  private readonly pointers = new Map<number, Point2D>()
  private readonly previousTouchAction: string
  private handleDrag: HandleDrag | null = null
  private disposed = false

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.host.isEnabled()) {
      return
    }
    // ハンドルを掴んでいる間は、ほかの指を無視する。
    if (this.handleDrag !== null) {
      return
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }

    const local = this.toLocal(event)

    // 1 本目の指だけが、ハンドルを掴める。
    if (this.pointers.size === 0 && this.tryGrabHandle(event, local)) {
      event.preventDefault()
      return
    }

    this.pointers.set(event.pointerId, local)
    this.capture(event.pointerId)
    this.updateDraggingClass()
    event.preventDefault()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.handleDrag
    if (drag !== null) {
      if (event.pointerId !== drag.pointerId) {
        return
      }
      event.preventDefault()
      const local = this.toLocal(event)
      this.host.moveHandle(drag.index, {
        x: local.x + drag.offset.x,
        y: local.y + drag.offset.y,
      })
      return
    }

    const previousPosition = this.pointers.get(event.pointerId)
    if (previousPosition === undefined) {
      return
    }
    event.preventDefault()

    const position = this.toLocal(event)
    this.pointers.set(event.pointerId, position)
    const viewport = this.host.getViewportSize()

    const pair = this.firstTwo()
    if (pair !== null) {
      // 3 本目以降の指の動きは無視する。
      if (event.pointerId !== pair.idA && event.pointerId !== pair.idB) {
        return
      }
      const previous: PointerPair = {
        a: event.pointerId === pair.idA ? previousPosition : pair.a,
        b: event.pointerId === pair.idB ? previousPosition : pair.b,
      }
      const next: PointerPair = { a: pair.a, b: pair.b }
      this.host.update((state) => applyPinch(state, previous, next, viewport))
      return
    }

    if (this.pointers.size === 1) {
      const dx = position.x - previousPosition.x
      const dy = position.y - previousPosition.y
      if (dx === 0 && dy === 0) {
        return
      }
      this.host.update((state) => panBy(state, dx, dy, viewport))
    }
  }

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const drag = this.handleDrag
    if (drag !== null) {
      if (event.pointerId === drag.pointerId) {
        this.endHandleDrag()
      }
      return
    }

    if (!this.pointers.has(event.pointerId)) {
      return
    }
    this.pointers.delete(event.pointerId)
    this.releaseCapture(event.pointerId)
    this.updateDraggingClass()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.host.isEnabled()) {
      return
    }
    // ページのスクロールやブラウザのズームを防ぐ。
    event.preventDefault()

    let unit = 1
    if (event.deltaMode === WHEEL_DELTA_LINE) {
      unit = 16
    } else if (event.deltaMode === WHEEL_DELTA_PAGE) {
      unit = 100
    }
    const factor = wheelZoomFactor(event.deltaY * unit)
    const anchor = this.toLocal(event)
    const viewport = this.host.getViewportSize()
    this.host.update((state) => zoomAt(state, factor, anchor, viewport))
  }

  private readonly onContextMenu = (event: Event): void => {
    // 長押しなどでメニューが出て、操作が中断されるのを防ぐ。
    event.preventDefault()
  }

  /**
   * @param target 操作を受け付ける要素(プレビューの canvas)。
   * @param host 操作対象。
   */
  constructor(target: HTMLElement, host: GestureHost) {
    this.target = target
    this.host = host
    this.previousTouchAction = target.style.touchAction

    // CSS の設定漏れがあっても、タッチ操作でページがスクロール・ズームしないようにする。
    target.style.touchAction = 'none'

    target.addEventListener('pointerdown', this.onPointerDown)
    target.addEventListener('pointermove', this.onPointerMove)
    target.addEventListener('pointerup', this.onPointerEnd)
    target.addEventListener('pointercancel', this.onPointerEnd)
    target.addEventListener('lostpointercapture', this.onPointerEnd)
    target.addEventListener('wheel', this.onWheel, { passive: false })
    target.addEventListener('contextmenu', this.onContextMenu)
  }

  /**
   * 進行中の操作(ハンドルのドラッグ・画像のドラッグ・ピンチ)を、すべて安全に終了する。
   * 画面の向きが変わり始めたときなど、操作の途中で座標系が変わる場合に呼ぶ。
   *
   * 指が画面に残っていても、その指の以後の動きは無視される。
   * 指を離して触り直すと、新しい操作として始まる。画像の状態は変更しない。
   */
  cancel(): void {
    this.endHandleDrag()
    if (this.pointers.size === 0) {
      return
    }
    const ids = Array.from(this.pointers.keys())
    // 先に追跡を止める。キャプチャ解放で lostpointercapture が発生しても、無視される。
    this.pointers.clear()
    for (const id of ids) {
      this.releaseCapture(id)
    }
    this.updateDraggingClass()
  }

  /** イベントリスナーを解除し、状態を元に戻す。以降は使用しない。 */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true

    this.endHandleDrag()

    this.target.removeEventListener('pointerdown', this.onPointerDown)
    this.target.removeEventListener('pointermove', this.onPointerMove)
    this.target.removeEventListener('pointerup', this.onPointerEnd)
    this.target.removeEventListener('pointercancel', this.onPointerEnd)
    this.target.removeEventListener('lostpointercapture', this.onPointerEnd)
    this.target.removeEventListener('wheel', this.onWheel)
    this.target.removeEventListener('contextmenu', this.onContextMenu)

    this.pointers.clear()
    this.target.classList.remove(DRAGGING_CLASS)
    this.target.style.touchAction = this.previousTouchAction
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  /**
   * ハンドルの近くなら、最も近いハンドルを掴む。掴んだ場合は true。
   * 掴んだ位置のずれを記録するため、ハンドルが指の位置へ飛ばない。
   */
  private tryGrabHandle(event: PointerEvent, local: Point2D): boolean {
    const positions = this.host.getHandlePositions()
    if (positions === null) {
      return false
    }
    const index = findNearestCornerIndex(positions, local, grabRadiusFor(event.pointerType))
    if (index === null) {
      return false
    }
    const corner = positions[index]
    this.handleDrag = {
      pointerId: event.pointerId,
      index,
      offset: { x: corner.x - local.x, y: corner.y - local.y },
    }
    this.capture(event.pointerId)
    this.host.setActiveHandle(index)
    this.updateDraggingClass()
    return true
  }

  /** ハンドルのドラッグを終了する。ドラッグ中でなければ何もしない。 */
  private endHandleDrag(): void {
    const drag = this.handleDrag
    if (drag === null) {
      return
    }
    // 先に状態を消す。キャプチャ解放で lostpointercapture が発生しても、無視される。
    this.handleDrag = null
    this.releaseCapture(drag.pointerId)
    this.host.setActiveHandle(null)
    this.updateDraggingClass()
  }

  /** ポインターをキャプチャする。失敗しても、操作自体は続けられる。 */
  private capture(pointerId: number): void {
    try {
      this.target.setPointerCapture(pointerId)
    } catch {
      // キャプチャに失敗しても、操作自体は続けられる。
    }
  }

  /** ポインターキャプチャを解放する。すでに解放済みの場合などは無視する。 */
  private releaseCapture(pointerId: number): void {
    try {
      if (this.target.hasPointerCapture(pointerId)) {
        this.target.releasePointerCapture(pointerId)
      }
    } catch {
      // すでに解放されている場合などは無視する。
    }
  }

  /** イベントの位置を、対象要素の左上を原点とした CSS ピクセルへ変換する。 */
  private toLocal(event: MouseEvent): Point2D {
    const rect = this.target.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** 先頭 2 本のポインターを返す。2 本未満の場合は null。 */
  private firstTwo(): ActivePair | null {
    if (this.pointers.size < 2) {
      return null
    }
    const ids = Array.from(this.pointers.keys())
    const idA = ids[0]
    const idB = ids[1]
    if (idA === undefined || idB === undefined) {
      return null
    }
    const a = this.pointers.get(idA)
    const b = this.pointers.get(idB)
    if (a === undefined || b === undefined) {
      return null
    }
    return { idA, idB, a, b }
  }

  private updateDraggingClass(): void {
    this.target.classList.toggle(
      DRAGGING_CLASS,
      this.pointers.size > 0 || this.handleDrag !== null,
    )
  }
}