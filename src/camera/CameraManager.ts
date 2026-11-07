import {
  buildConstraints,
  buildSizeConstraints,
  checkEnvironment,
  createCameraError,
  createInitialState,
  DEFAULT_CAMERA_FACING,
  isOrientationMismatch,
  oppositeFacing,
  toCameraError,
} from './CameraSettings.ts'
import type {
  CameraError,
  CameraFacing,
  CameraInfo,
  CameraState,
  LayoutOrientation,
  VideoResolution,
} from './CameraSettings.ts'

/** 状態変化のリスナー。 */
export type CameraStateListener = (state: CameraState) => void

/** フレームコールバック。将来の Canvas 2D / WebGL2 描画の入口。 */
export type VideoFrameHandler = (video: HTMLVideoElement, now: number) => void

/** フレームコールバックの登録解除関数。 */
export type Unsubscribe = () => void

/** applyConstraints 後、映像の寸法が変わるのを待つ最大時間(ミリ秒)。 */
export const ADAPT_RESIZE_WAIT_MS = 600

/** openCamera の結果。 */
type OpenResult = 'ok' | 'failed' | 'superseded'

/** openCamera のオプション。 */
interface OpenOptions {
  /** 要求する映像サイズの向き。 */
  readonly orientation: LayoutOrientation
  /** true の場合、失敗してもエラー状態にせず、呼び出し側が後始末をする。 */
  readonly quiet: boolean
}

/** 通常の起動(従来どおり横向きの指定、失敗時はエラー表示)。 */
const DEFAULT_OPEN_OPTIONS: OpenOptions = { orientation: 'landscape', quiet: false }

/**
 * requestVideoFrameCallback を実行時に使えるか判定する。
 * 型定義上は標準APIだが、古いブラウザでは存在しないため、実行時に確認する。
 */
function supportsVideoFrameCallback(video: HTMLVideoElement): boolean {
  return (
    typeof video.requestVideoFrameCallback === 'function' &&
    typeof video.cancelVideoFrameCallback === 'function'
  )
}

/**
 * カメラの起動・停止・切り替え・ストリーム管理を担当する。
 *
 * - UI からは公開メソッド(start / stop / switchCamera / subscribe / adaptToOrientation)のみを使う。
 * - 映像ピクセルには一切加工しない。
 * - 起動・停止・切り替え・向きの調整は直列化し、連続操作でも競合しない。
 * - 映像データは外部へ送信しない。
 */
export class CameraManager {
  private readonly video: HTMLVideoElement
  private readonly listeners = new Set<CameraStateListener>()
  private readonly frameHandlers = new Set<VideoFrameHandler>()

  private state: CameraState
  private stream: MediaStream | null = null
  /** 操作の世代番号。新しい操作が始まるたびに増やし、古い操作の結果を破棄する。 */
  private generation = 0
  /** 直列化のためのキュー。 */
  private queue: Promise<void> = Promise.resolve()
  /** 特定のカメラを指定する場合の deviceId。切り替え直後は null(facingMode で選ぶ)。 */
  private currentDeviceId: string | null = null

  /** 向きの調整の、待機中の目標。調整が始まると null に戻る。 */
  private pendingOrientation: LayoutOrientation | null = null
  /** 向きの調整がキューに入っていて、まだ始まっていないか。 */
  private adaptQueued = false
  private adaptPromise: Promise<void> = Promise.resolve()
  /** 再取得しても食い違いが解消しなかった向き。同じ向きでは再試行しない。 */
  private giveUpOrientation: LayoutOrientation | null = null

  private frameLoopActive = false
  private frameHandle: number | null = null
  private frameHandleKind: 'video' | 'raf' | null = null

  /** 映像の寸法が変わったとき、状態の解像度を更新する(再取得はしない)。 */
  private readonly onVideoResize = (): void => {
    this.syncResolution()
  }

  constructor(video: HTMLVideoElement) {
    this.video = video
    this.state = createInitialState(DEFAULT_CAMERA_FACING)
    this.configureVideoElement()
    this.video.addEventListener('resize', this.onVideoResize)
  }

  /** 現在の状態を返す。 */
  getState(): CameraState {
    return this.state
  }

  /** 状態変化を購読する。登録時には現在の状態を一度通知する。 */
  subscribe(listener: CameraStateListener): Unsubscribe {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 映像フレームごとのコールバックを登録する。
   * requestVideoFrameCallback が使える環境ではそれを、
   * そうでなければ requestAnimationFrame を使う。
   * 現在は未使用。将来の描画モジュールの入口として用意している。
   */
  onFrame(handler: VideoFrameHandler): Unsubscribe {
    this.frameHandlers.add(handler)
    this.ensureFrameLoop()
    return () => {
      this.frameHandlers.delete(handler)
      if (this.frameHandlers.size === 0) {
        this.cancelFrameLoop()
      }
    }
  }

  /** カメラを起動する(指定がなければ現在の向き)。 */
  start(facing?: CameraFacing): Promise<void> {
    return this.enqueue(async () => {
      this.giveUpOrientation = null
      const target = facing ?? this.state.facing
      const deviceId =
        facing !== undefined && facing !== this.state.facing
          ? null
          : this.currentDeviceId
      await this.openCamera(target, deviceId, DEFAULT_OPEN_OPTIONS)
    })
  }

  /** カメラを停止する。 */
  stop(): Promise<void> {
    // 停止は進行中の起動・調整を無効化するため、キューに入れる前に世代を進める。
    this.generation += 1
    return this.enqueue(async () => {
      this.giveUpOrientation = null
      this.releaseStream()
      this.setState({
        status: 'stopped',
        info: null,
        error: null,
      })
    })
  }

  /** 前面と背面を切り替える。稼働中でなくても向きの選択は変更できる。 */
  switchCamera(): Promise<void> {
    return this.enqueue(async () => {
      this.giveUpOrientation = null
      const next = oppositeFacing(this.state.facing)
      this.currentDeviceId = null

      if (this.state.status === 'stopped' || this.state.status === 'error') {
        this.setState({ facing: next })
        return
      }
      await this.openCamera(next, null, DEFAULT_OPEN_OPTIONS)
    })
  }

  /**
   * 画面の向きに、映像の向きを合わせる。画面の向きが落ち着いた時点で呼ぶ。
   *
   * 映像の向きがすでに画面と一致していれば、何もしない。
   * 食い違っている場合だけ、次の順で試す。
   *   1. 同じトラックに applyConstraints で寸法を要求する(再取得しない)。
   *   2. それでも食い違う場合に限り、1 回だけ再取得する(前面/背面と deviceId は維持)。
   *
   * 呼び出しは直列化され、待機中の呼び出しは最新の向きに統合される。
   * 停止・切り替えが割り込んだ場合は中断する。
   */
  adaptToOrientation(orientation: LayoutOrientation): Promise<void> {
    this.pendingOrientation = orientation
    if (this.adaptQueued) {
      return this.adaptPromise
    }
    this.adaptQueued = true
    this.adaptPromise = this.enqueue(async () => {
      this.adaptQueued = false
      const target = this.pendingOrientation
      this.pendingOrientation = null
      if (target !== null) {
        await this.runAdapt(target)
      }
    })
    return this.adaptPromise
  }

  /**
   * ページの非表示などで、ユーザー操作なしに停止する場合に使う。
   * 稼働中・起動中のときだけ停止する。
   */
  stopIfActive(): Promise<void> {
    if (this.state.status === 'running' || this.state.status === 'starting') {
      return this.stop()
    }
    return Promise.resolve()
  }

  /** すべてのリソースを解放する。 */
  async dispose(): Promise<void> {
    this.cancelFrameLoop()
    this.frameHandlers.clear()
    this.video.removeEventListener('resize', this.onVideoResize)
    await this.stop()
    this.listeners.clear()
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  /** iPhone Safari で再生するために必要な属性を設定する。 */
  private configureVideoElement(): void {
    this.video.muted = true
    this.video.autoplay = true
    this.video.playsInline = true
    this.video.setAttribute('muted', '')
    this.video.setAttribute('autoplay', '')
    this.video.setAttribute('playsinline', '')
    this.video.setAttribute('webkit-playsinline', '')
    this.video.disablePictureInPicture = true
  }

  /** 操作を直列化して実行する。失敗しても後続の操作を止めない。 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => {
      // 個別の操作のエラーは task 内で状態に反映済み。キューは継続する。
    })
    return run
  }

  private setState(partial: Partial<CameraState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private fail(error: CameraError): void {
    this.releaseStream()
    this.setState({
      status: 'error',
      info: null,
      error,
      canSwitch: this.state.canSwitch,
    })
  }

  /**
   * quiet の場合は、エラー状態にせず、ストリームを解放するだけにする
   * (呼び出し側が復旧を試みる)。
   */
  private failWith(error: CameraError, quiet: boolean): void {
    if (quiet) {
      this.releaseStream()
      return
    }
    this.fail(error)
  }

  /**
   * 指定の向きでカメラを開く。
   * 既存のストリームを先に停止する(iOS Safari は 2 つのカメラを同時に開けないため)。
   */
  private async openCamera(
    facing: CameraFacing,
    deviceId: string | null,
    options: OpenOptions,
  ): Promise<OpenResult> {
    this.generation += 1
    const myGeneration = this.generation

    const envError = checkEnvironment({
      isSecureContext: window.isSecureContext,
      hasMediaDevices: typeof navigator.mediaDevices !== 'undefined',
      hasGetUserMedia:
        typeof navigator.mediaDevices !== 'undefined' &&
        typeof navigator.mediaDevices.getUserMedia === 'function',
    })
    if (envError !== null) {
      this.fail(envError)
      return 'failed'
    }

    this.releaseStream()
    this.setState({ status: 'starting', facing, info: null, error: null })

    let newStream: MediaStream
    try {
      newStream = await navigator.mediaDevices.getUserMedia(
        buildConstraints(facing, deviceId, options.orientation),
      )
    } catch (error: unknown) {
      if (!this.isCurrent(myGeneration)) {
        return 'superseded'
      }
      // deviceId 指定で失敗した場合は、facingMode だけで一度やり直す。
      if (deviceId !== null) {
        this.currentDeviceId = null
        return this.openCamera(facing, null, options)
      }
      this.failWith(toCameraError(error), options.quiet)
      return 'failed'
    }

    // 待っている間に、停止や別の操作が始まっていた場合は、取得したストリームを捨てる。
    if (!this.isCurrent(myGeneration)) {
      stopStream(newStream)
      return 'superseded'
    }

    this.stream = newStream

    try {
      await this.attachAndPlay(newStream)
    } catch {
      if (!this.isCurrent(myGeneration)) {
        return 'superseded'
      }
      this.failWith(createCameraError('play-failed'), options.quiet)
      return 'failed'
    }

    if (!this.isCurrent(myGeneration)) {
      return 'superseded'
    }

    const info = this.readInfo(newStream, facing)
    this.currentDeviceId = info.deviceId
    this.setState({
      status: 'running',
      facing: info.facing,
      info,
      error: null,
    })

    // 権限取得後は、カメラの台数とラベルを取得できる。
    const canSwitch = await this.detectCanSwitch()
    if (this.isCurrent(myGeneration)) {
      this.setState({ canSwitch })
    }

    this.ensureFrameLoop()
    return 'ok'
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  /** video 要素にストリームを接続して再生を開始する。 */
  private async attachAndPlay(stream: MediaStream): Promise<void> {
    this.video.srcObject = stream
    await this.video.play()

    // メタデータが未取得の場合は、解像度が分かるまで待つ。
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      await new Promise<void>((resolve, reject) => {
        const onLoaded = (): void => {
          cleanup()
          resolve()
        }
        const onError = (): void => {
          cleanup()
          reject(new Error('video error'))
        }
        const cleanup = (): void => {
          this.video.removeEventListener('loadedmetadata', onLoaded)
          this.video.removeEventListener('error', onError)
        }
        this.video.addEventListener('loadedmetadata', onLoaded)
        this.video.addEventListener('error', onError)
        // 待っている間にメタデータが届いた場合の取りこぼしを防ぐ。
        if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
          onLoaded()
        }
      })
    }
  }

  /** 実際に取得できた映像の情報を読み取る。 */
  private readInfo(stream: MediaStream, requestedFacing: CameraFacing): CameraInfo {
    const track = stream.getVideoTracks()[0]
    const settings: MediaTrackSettings = track?.getSettings() ?? {}

    const width = settings.width ?? this.video.videoWidth
    const height = settings.height ?? this.video.videoHeight

    let facing: CameraFacing = requestedFacing
    if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
      facing = settings.facingMode
    }

    return {
      facing,
      deviceId: settings.deviceId ?? null,
      resolution: {
        width: this.video.videoWidth > 0 ? this.video.videoWidth : width,
        height: this.video.videoHeight > 0 ? this.video.videoHeight : height,
      },
      frameRate: settings.frameRate ?? null,
    }
  }

  /** 稼働中、video 要素の実際の寸法を、状態の解像度に反映する。 */
  private syncResolution(): void {
    const info = this.state.info
    if (this.state.status !== 'running' || info === null) {
      return
    }
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (width <= 0 || height <= 0) {
      return
    }
    if (width === info.resolution.width && height === info.resolution.height) {
      return
    }
    this.setState({ info: { ...info, resolution: { width, height } } })
  }

  /** video 要素の実際の寸法(判断の根拠は、getSettings ではなくこちら)。 */
  private readVideoSize(): VideoResolution {
    return { width: this.video.videoWidth, height: this.video.videoHeight }
  }

  /** 映像の向きが、指定の画面の向きと食い違っているか。 */
  private isMismatched(target: LayoutOrientation): boolean {
    return isOrientationMismatch(this.readVideoSize(), target)
  }

  /** resize イベントか、タイムアウトの、早いほうまで待つ。 */
  private waitForVideoResize(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.video.removeEventListener('resize', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.video.addEventListener('resize', finish)
    })
  }

  /** 向きの調整の本体。enqueue の中で実行される(直列化済み)。 */
  private async runAdapt(target: LayoutOrientation): Promise<void> {
    if (this.state.status !== 'running' || target === 'square') {
      return
    }
    const stream = this.stream
    if (stream === null) {
      return
    }
    // 映像の向きがすでに合っているなら、何もしない。
    if (!this.isMismatched(target)) {
      this.giveUpOrientation = null
      return
    }
    // 再取得しても解消しなかった向きでは、繰り返さない。
    if (this.giveUpOrientation === target) {
      return
    }

    const myGeneration = this.generation

    // 手順 1:同じトラックに寸法を要求する(再取得しない)。
    const track = stream.getVideoTracks()[0]
    if (track !== undefined && typeof track.applyConstraints === 'function') {
      try {
        await track.applyConstraints(buildSizeConstraints(target))
      } catch {
        // 要求が受け入れられなかった場合は、次の手順へ進む。
      }
      if (!this.isCurrent(myGeneration)) {
        return
      }
      this.syncResolution()
      if (this.isMismatched(target)) {
        await this.waitForVideoResize(ADAPT_RESIZE_WAIT_MS)
        if (!this.isCurrent(myGeneration)) {
          return
        }
        this.syncResolution()
      }
      if (!this.isMismatched(target)) {
        this.giveUpOrientation = null
        return
      }
    }

    // 手順 2:それでも食い違う場合に限り、1 回だけ再取得する。
    const facing = this.state.facing
    const deviceId = this.currentDeviceId
    const result = await this.openCamera(facing, deviceId, {
      orientation: target,
      quiet: true,
    })
    if (result === 'superseded') {
      return
    }
    if (result === 'failed') {
      // 元の(横向きの標準の)条件で、1 回だけ復旧を試みる。失敗した場合はエラー表示になる。
      this.giveUpOrientation = target
      await this.openCamera(facing, deviceId, DEFAULT_OPEN_OPTIONS)
      return
    }
    if (this.isMismatched(target)) {
      // 再取得しても解消しなかった。この向きでは、これ以上繰り返さない。
      this.giveUpOrientation = target
    } else {
      this.giveUpOrientation = null
    }
  }

  /** 映像入力デバイスが 2 台以上あるかを調べる。 */
  private async detectCanSwitch(): Promise<boolean> {
    try {
      if (typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        // 台数が分からない場合は、facingMode での切り替えを試せるようにする。
        return true
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      const cameras = devices.filter((d) => d.kind === 'videoinput')
      return cameras.length >= 2
    } catch {
      return true
    }
  }

  /** 現在のストリームのトラックをすべて停止し、video から切り離す。 */
  private releaseStream(): void {
    if (this.stream !== null) {
      stopStream(this.stream)
      this.stream = null
    }
    this.video.pause()
    this.video.srcObject = null
  }

  // ---------------------------------------------------------------
  // フレームループ
  // ---------------------------------------------------------------

  private ensureFrameLoop(): void {
    if (this.frameLoopActive) {
      return
    }
    if (this.frameHandlers.size === 0 || this.state.status !== 'running') {
      return
    }
    this.frameLoopActive = true
    this.scheduleNextFrame()
  }

  private scheduleNextFrame(): void {
    if (supportsVideoFrameCallback(this.video)) {
      this.frameHandleKind = 'video'
      this.frameHandle = this.video.requestVideoFrameCallback((now) => {
        this.handleFrame(now)
      })
    } else {
      this.frameHandleKind = 'raf'
      this.frameHandle = window.requestAnimationFrame((now) => {
        this.handleFrame(now)
      })
    }
  }

  private handleFrame(now: number): void {
    this.frameHandle = null
    this.frameHandleKind = null

    if (!this.frameLoopActive) {
      return
    }
    if (this.state.status !== 'running' || this.frameHandlers.size === 0) {
      // 稼働していないときはループを止める。次回の起動時に ensureFrameLoop で再開する。
      this.frameLoopActive = false
      return
    }

    for (const handler of this.frameHandlers) {
      handler(this.video, now)
    }
    this.scheduleNextFrame()
  }

  private cancelFrameLoop(): void {
    this.frameLoopActive = false
    if (this.frameHandle === null) {
      return
    }
    if (this.frameHandleKind === 'video') {
      this.video.cancelVideoFrameCallback(this.frameHandle)
    } else if (this.frameHandleKind === 'raf') {
      window.cancelAnimationFrame(this.frameHandle)
    }
    this.frameHandle = null
    this.frameHandleKind = null
  }
}

/** ストリームのすべてのトラックを停止する。 */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}