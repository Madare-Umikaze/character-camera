import { orientationOf } from '../camera/CameraSettings.ts'
import type { LayoutOrientation } from '../camera/CameraSettings.ts'
import type { Size2D } from '../types/geometry.ts'

/**
 * 画面(ビューポート)の寸法と向きの変化を監視する。
 *
 * - 向きは、ウィンドウの寸法(幅と高さ)から判定する。API の有無に依存しない。
 * - resize / orientationchange / screen.orientation の change / visualViewport の resize を
 *   購読する(存在する API だけ)。
 * - 回転の直後は寸法が古いことがあるため、イベントが止まって一定時間後の値を採用する。
 * - screen.orientation.lock() やセンサー権限は使わない。
 * - 画面の向きの検知だけを担当する。カメラの調整や描画の更新は、通知を受けた側が行う。
 */

/** 監視の結果(安定した時点のビューポート)。 */
export interface ViewportSnapshot {
  readonly size: Size2D
  readonly orientation: LayoutOrientation
}

/** 安定したビューポートの変化。 */
export interface ViewportChange {
  readonly snapshot: ViewportSnapshot
  /** 直前に通知した向きから変わったか。 */
  readonly orientationChanged: boolean
}

/** 通知先。 */
export interface ViewportHandlers {
  /** 寸法が変わり、イベントが落ち着いた時点で呼ばれる。 */
  readonly onSettled: (change: ViewportChange) => void
  /**
   * 向きが変わり始めたと分かった時点で呼ばれる(落ち着くのを待たない)。
   * 進行中の操作を、早めに安全に終わらせる用途。1 回の変化につき 1 回だけ呼ばれる。
   */
  readonly onOrientationChangeStart?: () => void
}

/** ブラウザ API の窓口(テストで差し替えられる)。 */
export interface ViewportEnvironment {
  /** 現在のビューポートの寸法(CSS ピクセル)。 */
  getSize(): Size2D
  /** 変化の候補になるイベントを購読する。戻り値は解除関数。 */
  subscribe(onEvent: () => void): () => void
}

/** イベントが止まってから、値を採用するまでの待ち時間(ミリ秒)。 */
export const VIEWPORT_SETTLE_MS = 250

function isValidSize(size: Size2D): boolean {
  return size.width > 0 && size.height > 0
}

/** ブラウザの window / screen / visualViewport を使う実装。存在しない API はスキップする。 */
export function createBrowserViewportEnvironment(): ViewportEnvironment {
  return {
    getSize(): Size2D {
      return { width: window.innerWidth, height: window.innerHeight }
    },
    subscribe(onEvent: () => void): () => void {
      const cleanups: Array<() => void> = []
      const add = (target: EventTarget, type: string): void => {
        target.addEventListener(type, onEvent)
        cleanups.push(() => {
          target.removeEventListener(type, onEvent)
        })
      }

      add(window, 'resize')
      add(window, 'orientationchange')

      // Screen Orientation API(iOS 16.4 以降・Android Chrome)。無い環境ではスキップする。
      if (typeof screen !== 'undefined') {
        const orientation: ScreenOrientation | undefined = screen.orientation
        if (orientation !== undefined) {
          add(orientation, 'change')
        }
      }

      const visualViewport: VisualViewport | null = window.visualViewport
      if (visualViewport !== null) {
        add(visualViewport, 'resize')
      }

      return () => {
        for (const cleanup of cleanups) {
          cleanup()
        }
      }
    },
  }
}

export class ViewportWatcher {
  private readonly handlers: ViewportHandlers
  private readonly env: ViewportEnvironment
  private readonly settleMs: number

  private last: ViewportSnapshot | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private startNotified = false
  private disposed = false

  private readonly onEvent = (): void => {
    if (this.disposed) {
      return
    }

    // 向きが変わり始めたことが分かった時点で、1 回だけ通知する。
    if (!this.startNotified && this.last !== null) {
      const size = this.env.getSize()
      if (isValidSize(size) && orientationOf(size) !== this.last.orientation) {
        this.startNotified = true
        this.handlers.onOrientationChangeStart?.()
      }
    }

    // 連続するイベントは、最後のものから settleMs 後に 1 回だけ処理する。
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(this.onSettle, this.settleMs)
  }

  private readonly onSettle = (): void => {
    this.timer = null
    this.startNotified = false
    if (this.disposed) {
      return
    }

    const size = this.env.getSize()
    if (!isValidSize(size)) {
      return
    }

    const previous = this.last
    const unchanged =
      previous !== null &&
      previous.size.width === size.width &&
      previous.size.height === size.height
    if (unchanged) {
      return
    }

    const snapshot: ViewportSnapshot = { size, orientation: orientationOf(size) }
    this.last = snapshot
    this.handlers.onSettled({
      snapshot,
      orientationChanged: previous !== null && previous.orientation !== snapshot.orientation,
    })
  }

  /**
   * @param handlers 通知先。
   * @param env ブラウザ API の窓口。省略時はブラウザの実装を使う。
   * @param settleMs イベントが止まってから値を採用するまでの待ち時間。
   */
  constructor(
    handlers: ViewportHandlers,
    env: ViewportEnvironment = createBrowserViewportEnvironment(),
    settleMs: number = VIEWPORT_SETTLE_MS,
  ) {
    this.handlers = handlers
    this.env = env
    this.settleMs = settleMs
  }

  /**
   * 監視を開始し、現在の寸法を基準として記録する(この時点では通知しない)。
   * 二重に呼ばれた場合は何もしない。
   */
  start(): void {
    if (this.disposed || this.unsubscribe !== null) {
      return
    }
    const size = this.env.getSize()
    if (isValidSize(size)) {
      this.last = { size, orientation: orientationOf(size) }
    }
    this.unsubscribe = this.env.subscribe(this.onEvent)
  }

  /** 最後に通知した(または開始時に記録した)ビューポート。まだなければ null。 */
  getCurrent(): ViewportSnapshot | null {
    return this.last
  }

  /** 購読とタイマーを解除する。以降は使用しない。 */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.unsubscribe !== null) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }
}