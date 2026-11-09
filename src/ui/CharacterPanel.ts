import {
  degreesToRadians,
  radiansToDegrees,
} from '../transform/characterTransform.ts'
import { DEFAULT_CHARACTER_STATE } from '../types/character.ts'
import type { CharacterSnapshot } from '../types/character.ts'
import { DEFAULT_PERSPECTIVE_STATE } from '../types/perspective.ts'

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
  toggleFlipX(): void
  /** 横方向・縦方向の遠近感を設定する(-1〜1)。両方の値から四隅を再計算する。 */
  setPerspectiveSliders(horizontal: number, vertical: number): void
  /** 四隅と遠近感スライダーだけを初期値に戻す。 */
  resetShape(): void
  /** すべての変形情報を初期値に戻す。 */
  reset(): void
  remove(): void
  clearError(): void
}

/** ハンドルの表示・非表示が変わったときの通知先。 */
export type HandlesVisibilityListener = (visible: boolean) => void

/** スライダー 1 行分の要素。 */
interface SliderRow {
  readonly row: HTMLElement
  readonly input: HTMLInputElement
  readonly value: HTMLElement
}

/** スライダーの値(-100〜100)の最大。 */
const PERSPECTIVE_SLIDER_RANGE = 100

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
  private readonly flipButton: HTMLButtonElement
  private readonly shapeResetButton: HTMLButtonElement
  private readonly handlesButton: HTMLButtonElement
  private readonly resetButton: HTMLButtonElement
  private readonly removeButton: HTMLButtonElement
  private readonly opacity: SliderRow
  private readonly rotation: SliderRow
  private readonly perspectiveHorizontal: SliderRow
  private readonly perspectiveVertical: SliderRow
  private readonly errorBox: HTMLElement
  private readonly errorText: HTMLElement
  private readonly errorClose: HTMLButtonElement

  private unsubscribe: (() => void) | null = null
  private readonly cleanups: Array<() => void> = []
  /** ユーザーが操作中のスライダー。操作中は状態からの値の書き戻しをしない。 */
  private readonly editing = new Set<HTMLInputElement>()
  /** 四隅ハンドルを表示するか。 */
  private handlesVisible = true

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
    this.perspectiveHorizontal = createSliderRow(
      'perspective-horizontal',
      '横の遠近',
      -PERSPECTIVE_SLIDER_RANGE,
      PERSPECTIVE_SLIDER_RANGE,
      1,
    )
    this.perspectiveVertical = createSliderRow(
      'perspective-vertical',
      '縦の遠近',
      -PERSPECTIVE_SLIDER_RANGE,
      PERSPECTIVE_SLIDER_RANGE,
      1,
    )

    // --- ボタン ---
    this.visibleButton = createButton('非表示にする', 'panel-button')
    this.flipButton = createButton('左右反転', 'panel-button')
    this.handlesButton = createButton('ハンドル', 'panel-button')
    this.shapeResetButton = createButton('形状リセット', 'panel-button')
    this.resetButton = createButton('すべてリセット', 'panel-button')
    this.removeButton = createButton('削除', 'panel-button panel-button--danger')

    const actionRow = document.createElement('div')
    actionRow.className = 'character-panel__row character-panel__row--actions'
    actionRow.append(
      this.visibleButton,
      this.flipButton,
      this.handlesButton,
      this.shapeResetButton,
      this.resetButton,
      this.removeButton,
    )

    this.element = document.createElement('section')
    this.element.className = 'character-panel'
    this.element.setAttribute('aria-label', 'キャラクター画像の操作')
    this.element.append(
      selectRow,
      this.errorBox,
      this.opacity.row,
      this.rotation.row,
      this.perspectiveHorizontal.row,
      this.perspectiveVertical.row,
      actionRow,
    )

    this.render({
      image: null,
      state: DEFAULT_CHARACTER_STATE,
      perspective: DEFAULT_PERSPECTIVE_STATE,
      loading: false,
      error: null,
    })
  }

  /**
   * コントローラを接続し、イベントと状態購読を開始する。
   * 二重に呼ばれた場合は、前の接続を解除する。
   *
   * @param onHandlesVisibilityChange 四隅ハンドルの表示・非表示が変わったときの通知先。
   *   接続した時点の状態(初期値は表示)も、1 回通知する。
   */
  bind(
    controller: CharacterController,
    onHandlesVisibilityChange: HandlesVisibilityListener,
  ): void {
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
    this.listen(this.flipButton, 'click', () => {
      controller.toggleFlipX()
    })
    this.listen(this.handlesButton, 'click', () => {
      this.handlesVisible = !this.handlesVisible
      this.updateHandlesButton()
      onHandlesVisibilityChange(this.handlesVisible)
    })
    this.listen(this.shapeResetButton, 'click', () => {
      controller.resetShape()
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

    // どちらのスライダーを動かしても、両方の現在値から四隅を再計算する。
    const applyPerspective = (): void => {
      const horizontal = Number(this.perspectiveHorizontal.input.value)
      const vertical = Number(this.perspectiveVertical.input.value)
      if (Number.isFinite(horizontal) && Number.isFinite(vertical)) {
        controller.setPerspectiveSliders(
          horizontal / PERSPECTIVE_SLIDER_RANGE,
          vertical / PERSPECTIVE_SLIDER_RANGE,
        )
      }
    }
    this.listen(this.perspectiveHorizontal.input, 'input', applyPerspective)
    this.listen(this.perspectiveVertical.input, 'input', applyPerspective)

    this.trackEditing(this.opacity.input)
    this.trackEditing(this.rotation.input)
    this.trackEditing(this.perspectiveHorizontal.input)
    this.trackEditing(this.perspectiveVertical.input)

    // 接続した時点の、ハンドルの表示状態を通知する。
    onHandlesVisibilityChange(this.handlesVisible)
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

  /** ハンドルのボタンの表示を、現在の状態に合わせる。 */
  private updateHandlesButton(): void {
    this.handlesButton.textContent = this.handlesVisible ? 'ハンドルを隠す' : 'ハンドルを表示'
    this.handlesButton.classList.toggle('panel-button--active', this.handlesVisible)
    this.handlesButton.setAttribute('aria-pressed', String(this.handlesVisible))
  }

  /** スライダーの表示を、状態の値で更新する(操作中のスライダーは書き戻さない)。 */
  private syncSlider(row: SliderRow, value: number, text: string): void {
    if (!this.editing.has(row.input)) {
      row.input.value = String(value)
    }
    row.value.textContent = text
  }

  /** 状態をもとに画面を更新する。 */
  private render(snapshot: CharacterSnapshot): void {
    const image = snapshot.image
    const state = snapshot.state
    const perspective = snapshot.perspective
    const hasImage = image !== null

    if (snapshot.loading) {
      this.imageName.textContent = '読み込み中…'
    } else {
      this.imageName.textContent = image === null ? '画像が選択されていません' : image.name
    }
    this.selectButton.textContent = hasImage ? '画像を変更' : '画像を選択'

    this.visibleButton.textContent = state.visible ? '非表示にする' : '表示する'
    this.visibleButton.disabled = !hasImage

    this.flipButton.disabled = !hasImage
    this.flipButton.classList.toggle('panel-button--active', state.flipX)
    this.flipButton.setAttribute('aria-pressed', String(state.flipX))

    this.handlesButton.disabled = !hasImage
    this.updateHandlesButton()

    this.shapeResetButton.disabled = !hasImage
    this.resetButton.disabled = !hasImage
    this.removeButton.disabled = !hasImage

    this.opacity.input.disabled = !hasImage
    this.rotation.input.disabled = !hasImage
    this.perspectiveHorizontal.input.disabled = !hasImage
    this.perspectiveVertical.input.disabled = !hasImage

    const opacityPercent = Math.round(state.opacity * 100)
    this.syncSlider(this.opacity, opacityPercent, `${opacityPercent}%`)

    const rotationDegrees = Math.round(radiansToDegrees(state.rotation))
    this.syncSlider(this.rotation, rotationDegrees, `${rotationDegrees}°`)

    const horizontal = Math.round(perspective.horizontal * PERSPECTIVE_SLIDER_RANGE)
    this.syncSlider(this.perspectiveHorizontal, horizontal, String(horizontal))

    const vertical = Math.round(perspective.vertical * PERSPECTIVE_SLIDER_RANGE)
    this.syncSlider(this.perspectiveVertical, vertical, String(vertical))

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