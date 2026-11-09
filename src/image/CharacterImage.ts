import { DEFAULT_CHARACTER_STATE } from '../types/character.ts'
import type {
  CharacterImageState,
  CharacterSnapshot,
  ImageLoadError,
} from '../types/character.ts'
import type { Point2D, Size2D } from '../types/geometry.ts'
import { DEFAULT_PERSPECTIVE_STATE } from '../types/perspective.ts'
import type { CornerIndex, PerspectiveState } from '../types/perspective.ts'
import {
  normalizeCharacterState,
  withFlipX,
  withOpacity,
  withRotation,
  withVisible,
} from '../transform/characterTransform.ts'
import {
  createPerspectiveFromSliders,
  moveCornerInState,
  normalizePerspectiveState,
} from '../transform/PerspectiveTransform.ts'
import { createImageLoadError, loadImageFile } from './ImageLoader.ts'
import type { ImageLoadResult } from './ImageLoader.ts'

/** スナップショットの変更を受け取るリスナー。 */
export type CharacterImageListener = (snapshot: CharacterSnapshot) => void

/** 画像ファイルの読み込み関数。テスト時に差し替えられる。 */
export type ImageFileLoader = (file: File) => Promise<ImageLoadResult>

/** 解除関数。 */
export type Unsubscribe = () => void

/** 画像がない状態のスナップショット。 */
const EMPTY_SNAPSHOT: CharacterSnapshot = {
  image: null,
  state: DEFAULT_CHARACTER_STATE,
  perspective: DEFAULT_PERSPECTIVE_STATE,
  loading: false,
  error: null,
}

/**
 * キャラクター画像と、その変形・表示状態を保持する。
 *
 * - カメラの状態(CameraState)とは別のオブジェクト。両者を混ぜない。
 * - 基本変形(state)と射影変換(perspective)は、別の値として保持する。
 * - ImageBitmap の close() の責任はこのクラスが持つ。
 * - 読み込みに失敗しても、表示中の画像と状態は維持する。
 * - 連続した読み込みでは、最後の要求の結果だけを採用する。
 * - 新しい画像の読み込み・削除・リセットで、以前の変形は残らない。
 * - 外部への送信処理は行わない。
 */
export class CharacterImage {
  private readonly loader: ImageFileLoader
  private readonly listeners = new Set<CharacterImageListener>()

  private bitmap: ImageBitmap | null = null
  private snapshot: CharacterSnapshot = EMPTY_SNAPSHOT
  /** 読み込み要求の世代番号。新しい要求・削除のたびに増やし、古い結果を破棄する。 */
  private loadToken = 0

  constructor(loader: ImageFileLoader = loadImageFile) {
    this.loader = loader
  }

  /** 現在のスナップショットを返す。 */
  getSnapshot(): CharacterSnapshot {
    return this.snapshot
  }

  /** 描画に使う ImageBitmap を返す。画像がない場合は null。close() してはいけない。 */
  getBitmap(): ImageBitmap | null {
    return this.bitmap
  }

  /** 画像のサイズ(ピクセル)を返す。画像がない場合は null。 */
  getImageSize(): Size2D | null {
    const image = this.snapshot.image
    if (image === null) {
      return null
    }
    return { width: image.width, height: image.height }
  }

  /** 変更を購読する。登録時に現在のスナップショットを一度通知する。 */
  subscribe(listener: CharacterImageListener): Unsubscribe {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 画像ファイルを読み込む。
   * 成功すると、前の画像を解放して差し替え、基本変形と四隅を初期値に戻す。
   * 失敗すると、前の画像と状態は維持し、エラーだけを設定する。
   */
  async load(file: File): Promise<void> {
    this.loadToken += 1
    const token = this.loadToken
    this.update({ loading: true, error: null })

    let result: ImageLoadResult
    try {
      result = await this.loader(file)
    } catch {
      result = { ok: false, error: createImageLoadError('decode-failed') }
    }

    // 待っている間に、別の読み込みや削除が行われた場合は、この結果を破棄する。
    if (token !== this.loadToken) {
      if (result.ok) {
        result.bitmap.close()
      }
      return
    }

    if (!result.ok) {
      this.update({ loading: false, error: result.error })
      return
    }

    this.closeBitmap()
    this.bitmap = result.bitmap
    this.update({
      image: result.info,
      state: DEFAULT_CHARACTER_STATE,
      perspective: DEFAULT_PERSPECTIVE_STATE,
      loading: false,
      error: null,
    })
  }

  // ---------------------------------------------------------------
  // 基本変形(移動・拡大縮小・回転・不透明度・表示・左右反転)
  // ---------------------------------------------------------------

  /** 基本変形・表示状態を、与えた関数で更新する。画像がない場合は何もしない。 */
  updateState(updater: (state: CharacterImageState) => CharacterImageState): void {
    if (this.snapshot.image === null) {
      return
    }
    const next = normalizeCharacterState(updater(this.snapshot.state))
    this.update({ state: next })
  }

  /** 基本変形・表示状態をまとめて設定する(正規化される)。画像がない場合は何もしない。 */
  setState(state: CharacterImageState): void {
    this.updateState(() => state)
  }

  /** 不透明度を設定する(0〜1)。 */
  setOpacity(opacity: number): void {
    this.updateState((state) => withOpacity(state, opacity))
  }

  /** 回転角を設定する(ラジアン)。 */
  setRotation(rotation: number): void {
    this.updateState((state) => withRotation(state, rotation))
  }

  /** 表示・非表示を設定する。 */
  setVisible(visible: boolean): void {
    this.updateState((state) => withVisible(state, visible))
  }

  /** 表示・非表示を切り替える。 */
  toggleVisible(): void {
    this.updateState((state) => withVisible(state, !state.visible))
  }

  /** 左右反転を設定する。 */
  setFlipX(flipX: boolean): void {
    this.updateState((state) => withFlipX(state, flipX))
  }

  /** 左右反転を切り替える。 */
  toggleFlipX(): void {
    this.updateState((state) => withFlipX(state, !state.flipX))
  }

  // ---------------------------------------------------------------
  // 射影変換(四隅・遠近感)
  // ---------------------------------------------------------------

  /**
   * 射影変換の状態を、与えた関数で更新する。画像がない場合は何もしない。
   * 関数が同じオブジェクトを返した場合は、変化なしとして通知しない。
   * 結果は正規化され、四隅が無効なら初期状態に戻る。
   */
  updatePerspective(updater: (state: PerspectiveState) => PerspectiveState): void {
    if (this.snapshot.image === null) {
      return
    }
    const current = this.snapshot.perspective
    const result = updater(current)
    if (result === current) {
      return
    }
    this.update({ perspective: normalizePerspectiveState(result) })
  }

  /**
   * 横方向・縦方向の遠近感を設定する(-1〜1)。
   * 両方の値から四隅を再計算して置き換える。個別に編集した四隅は破棄される。
   */
  setPerspectiveSliders(horizontal: number, vertical: number): void {
    this.updatePerspective(() => createPerspectiveFromSliders(horizontal, vertical))
  }

  /**
   * 1 つの頂点を動かす(画像ローカル座標)。スライダーの値は変えない。
   * 目標位置が不正な変形になる場合は、有効な範囲の境界で止まる。
   */
  moveCorner(index: CornerIndex, target: Point2D): void {
    this.updatePerspective((state) => moveCornerInState(state, index, target))
  }

  /** 四隅と遠近感スライダーだけを初期値に戻す。基本変形は変えない。 */
  resetShape(): void {
    this.updatePerspective(() => DEFAULT_PERSPECTIVE_STATE)
  }

  // ---------------------------------------------------------------
  // リセット・削除・解放
  // ---------------------------------------------------------------

  /**
   * すべての変形情報を初期値に戻す(位置・拡大縮小・回転・不透明度・表示・左右反転・四隅)。
   * 画像は残す。
   */
  reset(): void {
    if (this.snapshot.image === null) {
      return
    }
    this.update({
      state: DEFAULT_CHARACTER_STATE,
      perspective: DEFAULT_PERSPECTIVE_STATE,
    })
  }

  /** 画像を削除し、リソースを解放する。進行中の読み込みも無効にする。 */
  remove(): void {
    this.loadToken += 1
    this.closeBitmap()
    this.update({
      image: null,
      state: DEFAULT_CHARACTER_STATE,
      perspective: DEFAULT_PERSPECTIVE_STATE,
      loading: false,
      error: null,
    })
  }

  /** 読み込みエラー表示を消す。 */
  clearError(): void {
    if (this.snapshot.error !== null) {
      this.update({ error: null })
    }
  }

  /** すべてのリソースを解放し、購読を解除する。 */
  dispose(): void {
    this.loadToken += 1
    this.closeBitmap()
    this.snapshot = EMPTY_SNAPSHOT
    this.listeners.clear()
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  private closeBitmap(): void {
    if (this.bitmap !== null) {
      this.bitmap.close()
      this.bitmap = null
    }
  }

  private update(partial: {
    image?: CharacterSnapshot['image']
    state?: CharacterImageState
    perspective?: PerspectiveState
    loading?: boolean
    error?: ImageLoadError | null
  }): void {
    this.snapshot = {
      image: partial.image === undefined ? this.snapshot.image : partial.image,
      state: partial.state === undefined ? this.snapshot.state : partial.state,
      perspective:
        partial.perspective === undefined ? this.snapshot.perspective : partial.perspective,
      loading: partial.loading === undefined ? this.snapshot.loading : partial.loading,
      error: partial.error === undefined ? this.snapshot.error : partial.error,
    }
    for (const listener of this.listeners) {
      listener(this.snapshot)
    }
  }
}