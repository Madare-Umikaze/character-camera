import { DEFAULT_CHARACTER_STATE } from '../types/character.ts'
import type {
  CharacterImageState,
  CharacterSnapshot,
  ImageLoadError,
} from '../types/character.ts'
import type { Size2D } from '../types/geometry.ts'
import {
  normalizeCharacterState,
  withOpacity,
  withRotation,
  withVisible,
} from '../transform/characterTransform.ts'
import { createImageLoadError, loadImageFile } from './ImageLoader.ts'
import type { ImageLoadResult } from './ImageLoader.ts'

/** スナップショットの変更を受け取るリスナー。 */
export type CharacterImageListener = (snapshot: CharacterSnapshot) => void

/** 画像ファイルの読み込み関数。テスト時に差し替えられる。 */
export type ImageFileLoader = (file: File) => Promise<ImageLoadResult>

/** 解除関数。 */
export type Unsubscribe = () => void

/**
 * キャラクター画像と、その変形・表示状態を保持する。
 *
 * - カメラの状態(CameraState)とは別のオブジェクト。両者を混ぜない。
 * - ImageBitmap の close() の責任はこのクラスが持つ。
 * - 読み込みに失敗しても、表示中の画像と状態は維持する。
 * - 連続した読み込みでは、最後の要求の結果だけを採用する。
 * - 外部への送信処理は行わない。
 */
export class CharacterImage {
  private readonly loader: ImageFileLoader
  private readonly listeners = new Set<CharacterImageListener>()

  private bitmap: ImageBitmap | null = null
  private snapshot: CharacterSnapshot = {
    image: null,
    state: DEFAULT_CHARACTER_STATE,
    loading: false,
    error: null,
  }
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
   * 成功すると、前の画像を解放して差し替え、状態を初期値に戻す。
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
      loading: false,
      error: null,
    })
  }

  /** 変形・表示状態を、与えた関数で更新する。画像がない場合は何もしない。 */
  updateState(updater: (state: CharacterImageState) => CharacterImageState): void {
    if (this.snapshot.image === null) {
      return
    }
    const next = normalizeCharacterState(updater(this.snapshot.state))
    this.update({ state: next })
  }

  /** 状態をまとめて設定する(正規化される)。画像がない場合は何もしない。 */
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

  /** 変形状態を初期値に戻す(位置・拡大縮小・回転・不透明度・表示)。画像は残す。 */
  reset(): void {
    this.updateState(() => DEFAULT_CHARACTER_STATE)
  }

  /** 画像を削除し、リソースを解放する。進行中の読み込みも無効にする。 */
  remove(): void {
    this.loadToken += 1
    this.closeBitmap()
    this.update({
      image: null,
      state: DEFAULT_CHARACTER_STATE,
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
    this.snapshot = {
      image: null,
      state: DEFAULT_CHARACTER_STATE,
      loading: false,
      error: null,
    }
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
    loading?: boolean
    error?: ImageLoadError | null
  }): void {
    this.snapshot = {
      image: partial.image === undefined ? this.snapshot.image : partial.image,
      state: partial.state === undefined ? this.snapshot.state : partial.state,
      loading: partial.loading === undefined ? this.snapshot.loading : partial.loading,
      error: partial.error === undefined ? this.snapshot.error : partial.error,
    }
    for (const listener of this.listeners) {
      listener(this.snapshot)
    }
  }
}