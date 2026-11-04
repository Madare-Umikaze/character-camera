import {
  degreesToRadians,
  radiansToDegrees,
} from '../transform/characterTransform.ts'
import { DEFAULT_CHARACTER_STATE } from '../types/character.ts'
import type { CharacterSnapshot } from '../types/character.ts'

/**
 * UI が必要とするキャラクター画像操作の最小インターフェース。
 * CharacterImage の内部実装には依存せず、main.ts が実体を注入する。
 */
export interface CharacterController {
  subscribe(listener: (snapshot: CharacterSnapshot) => void): () => void
  load(file: File): Promise<void>
  setOpacity(opacity: number): void
  setRotation(rotation: number): void
  toggleVisible(): void
  reset(): void
  remove(): void
  clearError(): void
}

/** スライダー 1 行分の要素。 */
interface SliderRow {
  readonly row: HTMLElement
  readonly input: HTMLInputElement
  readonly value: HTMLElement
}

/**
 * キャラクター画像の操作パネル。
 * DOM の構築、操作の受け取り、状態表示だけを担当する。
 * 配置は呼び出し側が行う(element を好きな場所に追加する)。
 */
export class CharacterPanel {
  /** パネル全体の要素。 */
  readonly element: HTMLElement

  private readonly fileInput: HTMLInputElement
  private readonly selectButton: HTMLButtonElement
  private readonly imageName: HTMLElement
  private readonly visibleButton: HTMLButtonElement
  private readonly resetButton: HTMLButtonElement
  private readonly removeButton: HTMLButtonElement
  private readonly opacity: SliderRow
  private readonly rotation: SliderRow
  private readonly errorBox: HTMLElement
  private readonly errorText: HTMLElement
  private readonly errorClose: HTMLButtonElement

  private unsubscribe: (() => void) | null = null
  private readonly cleanups: Array<() => void> = []
  /** ユーザーが操作中のスライダー。操作中は状態からの値の書き戻しをしない。 */
  private readonly editing = new Set<HTMLInputElement>()

  constructor() {
    // --- 画像の選択 ---
    this.fileInput = document.createElement('input')
    this.fileInput.type = 'file'
    this.fileInput.accept = 'image/*'
    this.fileInput.hidden = true

    this.selectButton = createButton('画像を選択', 'panel-button panel-button--primary')

    this.imageName = document.createElement('span')
    this.imageName.className = 'character-panel__name'

    const selectRow = document.createElement('div')
    selectRow.className = 'character-panel__row'
    selectRow.append(this.selectButton, this.imageName, this.fileInput)

    // --- エラー表示 ---
    this.errorBox = document.createElement('div')
    this.errorBox.className = 'character-panel__error'
    this.errorBox.setAttribute('role', 'alert')
    this.errorBox.hidden = true

    this.errorText = document.createElement('span')
    this.errorClose = createButton('閉じる', 'panel-button panel-button--small')
    this.errorBox.append(this.errorText, this.errorClose)

    // --- スライダー ---
    this.opacity = createSliderRow('character-opacity', '不透明度', 0, 100, 1)
    this.rotation = createSliderRow('character-rotation', '回転', -180, 180, 1)

    // --- ボタン ---
    this.visibleButton = createButton('非表示にする', 'panel-button')
    this.resetButton = createButton('リセット', 'panel-button')
    this.removeButton = createButton('削除', 'panel-button panel-button--danger')

    const actionRow = document.createElement('div')
    actionRow.className = 'character-panel__row character-panel__row--actions'
    actionRow.append(this.visibleButton, this.resetButton, this.removeButton)

    this.element = document.createElement('section')
    this.element.className = 'character-panel'
    this.element.setAttribute('aria-label', 'キャラクター画像の操作')
    this.element.append(
      selectRow,
      this.errorBox,
      this.opacity.row,
      this.rotation.row,
      actionRow,
    )

    this.render({
      image: null,
      state: DEFAULT_CHARACTER_STATE,
      loading: false,
      error: null,
    })
  }

  /**
   * コントローラを接続し、イベントと状態購読を開始する。
   * 二重に呼ばれた場合は、前の接続を解除する。
   */
  bind(controller: CharacterController): void {
    this.unbind()

    this.unsubscribe = controller.subscribe((snapshot) => {
      this.render(snapshot)
    })

    this.listen(this.selectButton, 'click', () => {
      this.fileInput.click()
    })
    this.listen(this.fileInput, 'change', () => {
      const file = this.fileInput.files?.[0]
      // 同じファイルをもう一度選べるように、選択をクリアする。
      this.fileInput.value = ''
      if (file === undefined) {
        return
      }
      this.run(() => controller.load(file))
    })

    this.listen(this.visibleButton, 'click', () => {
      controller.toggleVisible()
    })
    this.listen(this.resetButton, 'click', () => {
      controller.reset()
    })
    this.listen(this.removeButton, 'click', () => {
      controller.remove()
    })
    this.listen(this.errorClose, 'click', () => {
      controller.clearError()
    })

    this.listen(this.opacity.input, 'input', () => {
      const value = Number(this.opacity.input.value)
      if (Number.isFinite(value)) {
        controller.setOpacity(value / 100)
      }
    })
    this.listen(this.rotation.input, 'input', () => {
      const value = Number(this.rotation.input.value)
      if (Number.isFinite(value)) {
        controller.setRotation(degreesToRadians(value))
      }
    })

    this.trackEditing(this.opacity.input)
    this.trackEditing(this.rotation.input)
  }

  /** イベントと購読をすべて解除する。 */
  unbind(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    for (const cleanup of this.cleanups) {
      cleanup()
    }
    this.cleanups.length = 0
    this.editing.clear()
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  /** イベントリスナーを登録し、解除関数を保持する。 */
  private listen(target: EventTarget, type: string, handler: () => void): void {
    target.addEventListener(type, handler)
    this.cleanups.push(() => {
      target.removeEventListener(type, handler)
    })
  }

  /** スライダーが操作中かどうかを追跡する。 */
  private trackEditing(input: HTMLInputElement): void {
    const start = (): void => {
      this.editing.add(input)
    }
    const end = (): void => {
      this.editing.delete(input)
    }
    this.listen(input, 'pointerdown', start)
    this.listen(input, 'pointerup', end)
    this.listen(input, 'pointercancel', end)
    this.listen(input, 'change', end)
    this.listen(input, 'blur', end)
  }

  /** 非同期操作を実行し、想定外の例外を握りつぶさずコンソールに出す。 */
  private run(task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      // CharacterImage は読み込みエラーを状態に反映する。ここに来るのは想定外の例外のみ。
      console.error('画像の操作中に予期しないエラーが発生しました:', error)
    })
  }

  /** 状態をもとに画面を更新する。 */
  private render(snapshot: CharacterSnapshot): void {
    const image = snapshot.image
    const state = snapshot.state
    const hasImage = image !== null

    if (snapshot.loading) {
      this.imageName.textContent = '読み込み中…'
    } else {
      this.imageName.textContent = image === null ? '画像が選択されていません' : image.name
    }
    this.selectButton.textContent = hasImage ? '画像を変更' : '画像を選択'

    this.visibleButton.textContent = state.visible ? '非表示にする' : '表示する'
    this.visibleButton.disabled = !hasImage
    this.resetButton.disabled = !hasImage
    this.removeButton.disabled = !hasImage
    this.opacity.input.disabled = !hasImage
    this.rotation.input.disabled = !hasImage

    const opacityPercent = Math.round(state.opacity * 100)
    if (!this.editing.has(this.opacity.input)) {
      this.opacity.input.value = String(opacityPercent)
    }
    this.opacity.value.textContent = `${opacityPercent}%`

    const rotationDegrees = Math.round(radiansToDegrees(state.rotation))
    if (!this.editing.has(this.rotation.input)) {
      this.rotation.input.value = String(rotationDegrees)
    }
    this.rotation.value.textContent = `${rotationDegrees}°`

    if (snapshot.error !== null) {
      this.errorBox.hidden = false
      this.errorText.textContent = snapshot.error.message
    } else {
      this.errorBox.hidden = true
      this.errorText.textContent = ''
    }
  }
}

function createButton(label: string, className: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  return button
}

function createSliderRow(
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
): SliderRow {
  const labelElement = document.createElement('label')
  labelElement.className = 'character-panel__label'
  labelElement.htmlFor = id
  labelElement.textContent = label

  const input = document.createElement('input')
  input.type = 'range'
  input.id = id
  input.className = 'character-panel__slider'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)

  const value = document.createElement('span')
  value.className = 'character-panel__value'

  const row = document.createElement('div')
  row.className = 'character-panel__row character-panel__row--slider'
  row.append(labelElement, input, value)

  return { row, input, value }
}