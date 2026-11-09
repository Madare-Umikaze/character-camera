import type { PerspectiveState } from './perspective.ts'

/**
 * キャラクター画像に関する共通の型。
 *
 * カメラ映像の状態(camera/CameraSettings.ts の CameraState)とは
 * 別のオブジェクトとして管理する。両者を 1 つの型にまとめない。
 */

/**
 * キャラクター画像の基本変形・表示状態。
 * 四隅の座標(射影変換)は、この型には含めず PerspectiveState で扱う。
 */
export interface CharacterImageState {
  /**
   * 画像中心の水平位置。
   * プレビューの中心を 0 とし、プレビュー幅に対する割合(右が正)。
   */
  readonly x: number
  /**
   * 画像中心の垂直位置。
   * プレビューの中心を 0 とし、プレビュー高さに対する割合(下が正)。
   */
  readonly y: number
  /** 基準サイズ(プレビューの約 50% に収まる大きさ)に対する倍率。 */
  readonly scale: number
  /** 回転角(ラジアン)。画面上で時計回りが正。 */
  readonly rotation: number
  /** 不透明度。0(透明)〜1(不透明)。 */
  readonly opacity: number
  /** 表示するか。 */
  readonly visible: boolean
  /** 左右反転するか。反転は、変形後の形全体を、画像の中心を通る縦軸で鏡映する。 */
  readonly flipX: boolean
}

/** 初期状態(読み込み直後・リセット時)。 */
export const DEFAULT_CHARACTER_STATE: CharacterImageState = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  visible: true,
  flipX: false,
}

/** 読み込んだ画像の情報。 */
export interface CharacterImageInfo {
  /** 元のファイル名。 */
  readonly name: string
  /** 描画に使う画像の幅(縮小後。ピクセル)。 */
  readonly width: number
  /** 描画に使う画像の高さ(縮小後。ピクセル)。 */
  readonly height: number
}

/** 画像読み込みエラーの種別。 */
export type ImageLoadErrorKind =
  | 'unsupported-type' // PNG / JPEG / WebP 以外
  | 'unsupported-heic' // HEIC / HEIF
  | 'empty-file' // サイズ 0
  | 'file-too-large' // ファイルサイズの上限超過
  | 'decode-failed' // 壊れている、またはデコードできない
  | 'unsupported-browser' // createImageBitmap が使えない
  | 'processing-failed' // 縮小などの処理に失敗

/** 画像読み込みエラー。 */
export interface ImageLoadError {
  readonly kind: ImageLoadErrorKind
  /** ユーザーに表示する日本語メッセージ。 */
  readonly message: string
}

/**
 * キャラクター画像の現在の状況(UI に通知する読み取り専用のスナップショット)。
 */
export interface CharacterSnapshot {
  /** 読み込み済みの画像情報。画像がない場合は null。 */
  readonly image: CharacterImageInfo | null
  /** 基本変形・表示状態。画像がない場合も初期値を保持する。 */
  readonly state: CharacterImageState
  /** 射影変換(四隅・遠近感)の状態。画像がない場合も初期値を保持する。 */
  readonly perspective: PerspectiveState
  /** 読み込み中か。読み込み中も、前の画像は image に残る。 */
  readonly loading: boolean
  /** 直近の読み込みエラー。次の読み込み開始・成功・削除で null に戻る。 */
  readonly error: ImageLoadError | null
}