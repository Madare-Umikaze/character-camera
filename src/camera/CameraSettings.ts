/**
 * カメラ設定の型・定数と、DOM に依存しない純粋関数。
 * getUserMedia のエラー分類や制約生成は、単体テストできるようここに置く。
 */

/** カメラの向き。 */
export type CameraFacing = 'user' | 'environment'

/** カメラの状態。 */
export type CameraStatus = 'stopped' | 'starting' | 'running' | 'error'

/** カメラエラーの種別。 */
export type CameraErrorKind =
  | 'insecure-context' // HTTPS ではない
  | 'unsupported' // 非対応ブラウザ
  | 'permission-denied' // 使用許可の拒否
  | 'not-found' // カメラが存在しない
  | 'in-use' // カメラが使用中
  | 'constraint' // 要求した条件を満たせない
  | 'play-failed' // 映像の再生開始に失敗
  | 'aborted' // 起動が中断された
  | 'unknown' // 起動処理の失敗(上記以外)

/** カメラエラー。 */
export interface CameraError {
  readonly kind: CameraErrorKind
  /** ユーザーに表示する日本語メッセージ。 */
  readonly message: string
}

/** 取得した映像の実際の解像度。 */
export interface VideoResolution {
  readonly width: number
  readonly height: number
}

/** 実行中のカメラ情報。 */
export interface CameraInfo {
  readonly facing: CameraFacing
  /** 実際に使用しているカメラの deviceId(取得できない場合は null)。 */
  readonly deviceId: string | null
  /** 実際の映像解像度。映像の寸法が変わると更新される。 */
  readonly resolution: VideoResolution
  /** 実際のフレームレート(取得できない場合は null)。 */
  readonly frameRate: number | null
}

/** カメラの状態スナップショット。 */
export interface CameraState {
  readonly status: CameraStatus
  /** 現在選択している向き(停止中でも保持する)。 */
  readonly facing: CameraFacing
  /** 稼働中のみ設定される。 */
  readonly info: CameraInfo | null
  /** エラー状態のみ設定される。 */
  readonly error: CameraError | null
  /** 切り替え可能なカメラが複数あるか。 */
  readonly canSwitch: boolean
}

/**
 * 画面や映像の縦横の向き。
 * square は、幅と高さが等しい場合と、寸法が不明(0 以下・NaN)な場合。
 * 「縦とも横とも言えない」ものとして扱い、向きの不一致とは判定しない。
 * (端末の物理的な向きや、前面・背面の選択とは別の概念。)
 */
export type LayoutOrientation = 'portrait' | 'landscape' | 'square'

/** 既定の設定値。 */
export const DEFAULT_CAMERA_FACING: CameraFacing = 'environment'

/** 理想とする映像の解像度(可能な限り高解像度を要求する)。横向きの場合の幅・高さ。 */
export const IDEAL_VIDEO_WIDTH = 3840
export const IDEAL_VIDEO_HEIGHT = 2160

/** 理想とするフレームレート。 */
export const IDEAL_FRAME_RATE = 30

/** 反対側の向きを返す。 */
export function oppositeFacing(facing: CameraFacing): CameraFacing {
  return facing === 'user' ? 'environment' : 'user'
}

/** 向きの日本語ラベル。 */
export function facingLabel(facing: CameraFacing): string {
  return facing === 'user' ? '前面カメラ' : '背面カメラ'
}

/**
 * 寸法から、縦横の向きを判定する。
 * 幅 > 高さ なら landscape、高さ > 幅 なら portrait。
 * 等しい場合や、寸法が有効でない場合は square。
 */
export function orientationOf(size: VideoResolution): LayoutOrientation {
  const { width, height } = size
  if (!(width > 0) || !(height > 0)) {
    return 'square'
  }
  if (width > height) {
    return 'landscape'
  }
  if (height > width) {
    return 'portrait'
  }
  return 'square'
}

/**
 * 映像の向きが、画面の向きと食い違っているか。
 * どちらかが square(判定不能・正方形)の場合は、食い違いとは判定しない。
 */
export function isOrientationMismatch(
  video: VideoResolution,
  viewport: LayoutOrientation,
): boolean {
  const videoOrientation = orientationOf(video)
  if (videoOrientation === 'square' || viewport === 'square') {
    return false
  }
  return videoOrientation !== viewport
}

/**
 * 画面の向きに合わせた、映像サイズの制約(width / height の ideal)を返す。
 * portrait のときだけ、幅と高さの ideal を入れ替える。
 * landscape と square は、従来どおりの横向きの指定。
 * 既存のトラックに applyConstraints する場合にも、そのまま使える
 * (カメラの選択には影響しない)。
 */
export function buildSizeConstraints(
  orientation: LayoutOrientation,
): MediaTrackConstraints {
  const portrait = orientation === 'portrait'
  return {
    width: { ideal: portrait ? IDEAL_VIDEO_HEIGHT : IDEAL_VIDEO_WIDTH },
    height: { ideal: portrait ? IDEAL_VIDEO_WIDTH : IDEAL_VIDEO_HEIGHT },
  }
}

/**
 * 向きと deviceId から getUserMedia の制約を生成する。
 * 音声は取得しない。deviceId が指定された場合は exact で指定する。
 *
 * @param orientation 画面の向きに合わせた映像サイズを要求する場合に指定する。
 *   省略時は、従来どおりの横向きの指定(通常の起動の挙動は変わらない)。
 */
export function buildConstraints(
  facing: CameraFacing,
  deviceId: string | null,
  orientation: LayoutOrientation = 'landscape',
): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    ...buildSizeConstraints(orientation),
    frameRate: { ideal: IDEAL_FRAME_RATE },
  }

  if (deviceId !== null) {
    video.deviceId = { exact: deviceId }
  } else {
    video.facingMode = { ideal: facing }
  }

  return { audio: false, video }
}

/** エラー種別から日本語メッセージを返す。 */
export function messageForKind(kind: CameraErrorKind): string {
  switch (kind) {
    case 'insecure-context':
      return 'カメラを使用するには HTTPS で接続する必要があります。安全な接続(https://)でアクセスしてください。'
    case 'unsupported':
      return 'このブラウザはカメラ機能に対応していません。iPhone の Safari や Android の Chrome など、最新のブラウザをお試しください。'
    case 'permission-denied':
      return 'カメラの使用が許可されていません。ブラウザやOSの設定でこのサイトのカメラ使用を許可してから、もう一度お試しください。'
    case 'not-found':
      return 'カメラが見つかりませんでした。カメラが搭載されている端末か、接続されているかをご確認ください。'
    case 'in-use':
      return 'カメラを起動できませんでした。ほかのアプリやタブがカメラを使用している可能性があります。それらを終了してからお試しください。'
    case 'constraint':
      return '要求した条件でカメラを起動できませんでした。別のカメラに切り替えてお試しください。'
    case 'play-failed':
      return 'カメラの映像を再生できませんでした。もう一度、起動ボタンを押してお試しください。'
    case 'aborted':
      return 'カメラの起動が中断されました。もう一度お試しください。'
    case 'unknown':
      return 'カメラの起動に失敗しました。ページを再読み込みして、もう一度お試しください。'
  }
}

/** エラー種別から CameraError を作る。 */
export function createCameraError(kind: CameraErrorKind): CameraError {
  return { kind, message: messageForKind(kind) }
}

/**
 * getUserMedia などが投げた値を、アプリのエラー種別に分類する。
 * DOMException 以外の値や未知の名前は 'unknown' にする。
 */
export function classifyCameraErrorName(name: string | null): CameraErrorKind {
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'constraint'
    case 'TypeError':
      // constraints が不正な場合などに発生する。
      return 'unknown'
    default:
      return 'unknown'
  }
}

/** 投げられた値から、エラー名を安全に取り出す。 */
export function extractErrorName(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name
    if (typeof name === 'string') {
      return name
    }
  }
  return null
}

/** 投げられた値を CameraError に変換する。 */
export function toCameraError(error: unknown): CameraError {
  return createCameraError(classifyCameraErrorName(extractErrorName(error)))
}

/** 実行環境の判定に必要な最小情報(テストしやすいよう注入可能にする)。 */
export interface EnvironmentInfo {
  readonly isSecureContext: boolean
  readonly hasMediaDevices: boolean
  readonly hasGetUserMedia: boolean
}

/**
 * 環境がカメラ利用に適しているか判定する。
 * 問題がなければ null、問題があれば該当する CameraError を返す。
 * HTTPS でない場合と、API 自体が無い場合を区別する。
 */
export function checkEnvironment(env: EnvironmentInfo): CameraError | null {
  if (!env.isSecureContext) {
    return createCameraError('insecure-context')
  }
  if (!env.hasMediaDevices || !env.hasGetUserMedia) {
    return createCameraError('unsupported')
  }
  return null
}

/** 初期状態を返す。 */
export function createInitialState(
  facing: CameraFacing = DEFAULT_CAMERA_FACING,
): CameraState {
  return {
    status: 'stopped',
    facing,
    info: null,
    error: null,
    canSwitch: false,
  }
}

/**
 * ステータス表示用の日本語テキストを返す。
 */
export function describeState(state: CameraState): string {
  switch (state.status) {
    case 'stopped':
      return '停止中'
    case 'starting':
      return '起動中…'
    case 'running': {
      const label = facingLabel(state.info?.facing ?? state.facing)
      const res = state.info?.resolution
      if (res === undefined) {
        return `${label}：稼働中`
      }
      return `${label}：${res.width}×${res.height}`
    }
    case 'error':
      return 'エラー'
  }
}