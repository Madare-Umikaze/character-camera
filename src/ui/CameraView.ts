import { describeState, facingLabel, oppositeFacing } from '../camera/CameraSettings.ts'
import type { CameraState } from '../camera/CameraSettings.ts'

/**
 * UI が必要とするカメラ操作の最小インターフェース。
 * CameraManager の内部実装には依存せず、main.ts が実体を注入する。
 */
export interface CameraController {
  start(): Promise<void>
  stop(): Promise<void>
  switchCamera(): Promise<void>
  stopIfActive(): Promise<void>
  subscribe(listener: (state: CameraState) => void): () => void
}

/**
 * カメラ画面の UI。
 * DOM の構築、ボタン操作、状態表示、エラー表示のみを担当する。
 *
 * - video 要素は、映像の描画元としてだけ使う(画面には canvas が映す)。
 * - viewport は、プレビューの canvas を配置する要素。
 * - panelSlot は、キャラクター画像の操作パネルを差し込む場所。
 * - パネルとカメラ操作は aside.camera-side にまとめる。
 *   縦画面では下部に並び、横画面ではサイドバーになる(配置は CSS で切り替える)。
 */
export class CameraView {
  /** 映像の描画元の video 要素(CameraManager に渡す)。画面には表示されない。 */
  readonly video: HTMLVideoElement
  /** プレビューの canvas を配置する要素。 */
  readonly viewport: HTMLElement
  /** キャラクター画像の操作パネルを差し込む要素。 */
  readonly panelSlot: HTMLElement

  private readonly root: HTMLElement
  private readonly statusText: HTMLElement
  private readonly rendererText: HTMLElement
  private readonly sizeText: HTMLElement
  private readonly errorBox: HTMLElement
  private readonly placeholder: HTMLElement
  private readonly startButton: HTMLButtonElement
  private readonly stopButton: HTMLButtonElement
  private readonly switchButton: HTMLButtonElement

  private unsubscribe: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  private readonly cleanups: Array<() => void> = []

  constructor(root: HTMLElement) {
    this.root = root

    // --- ステータス表示 ---
    const header = document.createElement('header')
    header.className = 'camera-header'

    this.statusText = document.createElement('span')
    this.statusText.className = 'camera-status'
    this.statusText.setAttribute('role', 'status')
    this.statusText.setAttribute('aria-live', 'polite')

    this.rendererText = document.createElement('span')
    this.rendererText.className = 'camera-meta-item'

    this.sizeText = document.createElement('span')
    this.sizeText.className = 'camera-meta-item'

    const meta = document.createElement('div')
    meta.className = 'camera-meta'
    meta.append(this.rendererText, this.sizeText)

    header.append(this.statusText, meta)

    // --- プレビュー(canvas は PreviewPresenter が最背面に追加する) ---
    this.viewport = document.createElement('div')
    this.viewport.className = 'camera-viewport'

    // 映像の描画元。画面には表示しない(1px・透明)。hidden にはしない。
    this.video = document.createElement('video')
    this.video.className = 'camera-video'
    this.video.setAttribute('playsinline', '')
    this.video.muted = true
    this.video.setAttribute('aria-hidden', 'true')

    this.placeholder = document.createElement('div')
    this.placeholder.className = 'camera-placeholder'
    this.placeholder.textContent = 'カメラを起動してください'

    this.errorBox = document.createElement('div')
    this.errorBox.className = 'camera-error'
    this.errorBox.setAttribute('role', 'alert')
    this.errorBox.hidden = true

    this.viewport.append(this.video, this.placeholder, this.errorBox)

    // --- キャラクター画像の操作パネルの場所 ---
    this.panelSlot = document.createElement('div')
    this.panelSlot.className = 'camera-panel-slot'

    // --- カメラの操作ボタン ---
    const controls = document.createElement('footer')
    controls.className = 'camera-controls'

    this.startButton = this.createButton('起動', 'camera-button camera-button--primary')
    this.stopButton = this.createButton('停止', 'camera-button')
    this.switchButton = this.createButton('切り替え', 'camera-button')

    controls.append(this.startButton, this.stopButton, this.switchButton)

    // --- パネルとカメラ操作をまとめる(縦画面は下部、横画面はサイドバー) ---
    const side = document.createElement('aside')
    side.className = 'camera-side'
    side.append(this.panelSlot, controls)

    const container = document.createElement('main')
    container.className = 'camera-app'
    container.append(header, this.viewport, side)

    this.root.replaceChildren(container)

    this.render({
      status: 'stopped',
      facing: 'environment',
      info: null,
      error: null,
      canSwitch: false,
    })
  }

  /** 使用中の描画方式の表示を設定する(例: "WebGL2")。 */
  setRendererLabel(label: string): void {
    this.rendererText.textContent = label
  }

  /**
   * コントローラを接続し、イベントと状態購読を開始する。
   * 二重に呼ばれた場合は、前の接続を解除する。
   */
  bind(controller: CameraController): void {
    this.unbind()

    this.unsubscribe = controller.subscribe((state) => {
      this.render(state)
    })

    this.listen(this.startButton, 'click', () => {
      this.run(() => controller.start())
    })
    this.listen(this.stopButton, 'click', () => {
      this.run(() => controller.stop())
    })
    this.listen(this.switchButton, 'click', () => {
      this.run(() => controller.switchCamera())
    })

    // ページが非表示になったら、カメラを停止する(復帰時の自動再起動はしない)。
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.run(() => controller.stopIfActive())
      }
    })
    this.listen(window, 'pagehide', () => {
      this.run(() => controller.stopIfActive())
    })

    this.observeSize()
  }

  /** イベント・購読・監視をすべて解除する。 */
  unbind(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    for (const cleanup of this.cleanups) {
      cleanup()
    }
    this.cleanups.length = 0

    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  private createButton(label: string, className: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = label
    return button
  }

  /** イベントリスナーを登録し、解除関数を保持する。 */
  private listen(
    target: EventTarget,
    type: string,
    handler: () => void,
  ): void {
    target.addEventListener(type, handler)
    this.cleanups.push(() => {
      target.removeEventListener(type, handler)
    })
  }

  /** 非同期操作を実行し、想定外の例外を握りつぶさずコンソールに出す。 */
  private run(task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      // CameraManager は内部でエラーを状態に反映する。ここに来るのは想定外の例外のみ。
      console.error('カメラ操作中に予期しないエラーが発生しました:', error)
    })
  }

  /** プレビューの表示サイズ変化を監視する。 */
  private observeSize(): void {
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.updateSizeText()
    })
    this.resizeObserver.observe(this.viewport)
    this.updateSizeText()
  }

  private updateSizeText(): void {
    const rect = this.viewport.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    this.sizeText.textContent = width > 0 && height > 0 ? `表示 ${width}×${height}` : ''
  }

  /** 状態をもとに画面を更新する。 */
  private render(state: CameraState): void {
    const status = state.status

    this.statusText.textContent = describeState(state)
    this.root.dataset['cameraStatus'] = status

    this.placeholder.hidden = status === 'running' || status === 'error'
    this.placeholder.textContent =
      status === 'starting' ? 'カメラを起動しています…' : 'カメラを起動してください'

    if (status === 'error' && state.error !== null) {
      this.errorBox.hidden = false
      this.errorBox.textContent = state.error.message
    } else {
      this.errorBox.hidden = true
      this.errorBox.textContent = ''
    }

    this.startButton.disabled = !(status === 'stopped' || status === 'error')
    this.stopButton.disabled = !(status === 'running' || status === 'starting')
    this.switchButton.disabled = !(status === 'running' && state.canSwitch)

    this.startButton.textContent = status === 'error' ? '再試行' : '起動'
    this.switchButton.textContent = `${facingLabel(oppositeFacing(state.facing))}へ`
    this.switchButton.setAttribute(
      'aria-label',
      `${facingLabel(oppositeFacing(state.facing))}に切り替え`,
    )
  }
}