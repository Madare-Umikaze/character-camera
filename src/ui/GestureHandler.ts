import {
  applyPinch,
  panBy,
  wheelZoomFactor,
  zoomAt,
} from '../transform/characterTransform.ts'
import type { CharacterImageState } from '../types/character.ts'
import type { Point2D, PointerPair, Size2D } from '../types/geometry.ts'

/**
 * GestureHandler が必要とする操作対象の最小インターフェース。
 * image/ や rendering/ の内部実装には依存せず、main.ts が実体を注入する。
 */
export interface GestureHost {
  /** 操作を受け付けるか(画像がある場合に true)。 */
  isEnabled(): boolean
  /** プレビューの表示サイズ(CSS ピクセル)。 */
  getViewportSize(): Size2D
  /** 状態を、与えた関数で更新する。 */
  update(updater: (state: CharacterImageState) => CharacterImageState): void
}

/** 先頭 2 本のポインターの情報。 */
interface ActivePair {
  readonly idA: number
  readonly idB: number
  readonly a: Point2D
  readonly b: Point2D
}

/** ドラッグ中に対象要素へ付けるクラス名(カーソル表示用)。 */
const DRAGGING_CLASS = 'preview-canvas--dragging'

/** WheelEvent.deltaMode の値。 */
const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2

/**
 * Pointer Events によるキャラクター画像の操作。
 *
 * - 1 本指・マウスの左ドラッグ: 移動
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
  private disposed = false

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.host.isEnabled()) {
      return
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    this.pointers.set(event.pointerId, this.toLocal(event))
    try {
      this.target.setPointerCapture(event.pointerId)
    } catch {
      // キャプチャに失敗しても、操作自体は続けられる。
    }
    this.updateDraggingClass()
    event.preventDefault()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
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
    if (!this.pointers.has(event.pointerId)) {
      return
    }
    this.pointers.delete(event.pointerId)
    try {
      if (this.target.hasPointerCapture(event.pointerId)) {
        this.target.releasePointerCapture(event.pointerId)
      }
    } catch {
      // すでに解放されている場合などは無視する。
    }
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

  /** イベントリスナーを解除し、状態を元に戻す。以降は使用しない。 */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true

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
    this.target.classList.toggle(DRAGGING_CLASS, this.pointers.size > 0)
  }
}