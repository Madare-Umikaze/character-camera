import {
  buildConstraints,
  checkEnvironment,
  createCameraError,
  createInitialState,
  DEFAULT_CAMERA_FACING,
  oppositeFacing,
  toCameraError,
} from './CameraSettings.ts'
import type {
  CameraError,
  CameraFacing,
  CameraInfo,
  CameraState,
} from './CameraSettings.ts'

/** 状態変化のリスナー。 */
export type CameraStateListener = (state: CameraState) => void

/** フレームコールバック。将来の Canvas 2D / WebGL2 描画の入口。 */
export type VideoFrameHandler = (video: HTMLVideoElement, now: number) => void

/** フレームコールバックの登録解除関数。 */
export type Unsubscribe = () => void

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
 * - UI からは公開メソッド（start / stop / switchCamera / subscribe）のみを使う。
 * - 映像ピクセルには一切加工しない。
 * - 起動・停止・切り替えは直列化し、連続操作でも競合しない。
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
  /** 特定のカメラを指定する場合の deviceId。切り替え直後は null（facingMode で選ぶ）。 */
  private currentDeviceId: string | null = null

  private frameLoopActive = false
  private frameHandle: number | null = null
  private frameHandleKind: 'video' | 'raf' | null = null

  constructor(video: HTMLVideoElement) {
    this.video = video
    this.state = createInitialState(DEFAULT_CAMERA_FACING)
    this.configureVideoElement()
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
   * 今回は描画処理を行わないが、将来の描画モジュールの入口として用意する。
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

  /** カメラを起動する（指定がなければ現在の向き）。 */
  start(facing?: CameraFacing): Promise<void> {
    return this.enqueue(async () => {
      const target = facing ?? this.state.facing
      const deviceId =
        facing !== undefined && facing !== this.state.facing
          ? null
          : this.currentDeviceId
      await this.openCamera(target, deviceId)
    })
  }

  /** カメラを停止する。 */
  stop(): Promise<void> {
    // 停止は進行中の起動を無効化するため、キューに入れる前に世代を進める。
    this.generation += 1
    return this.enqueue(async () => {
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
      const next = oppositeFacing(this.state.facing)
      this.currentDeviceId = null

      if (this.state.status === 'stopped' || this.state.status === 'error') {
        this.setState({ facing: next })
        return
      }
      await this.openCamera(next, null)
    })
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
   * 指定の向きでカメラを開く。
   * 既存のストリームを先に停止する（iOS Safari は 2 つのカメラを同時に開けないため）。
   */
  private async openCamera(
    facing: CameraFacing,
    deviceId: string | null,
  ): Promise<void> {
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
      return
    }

    this.releaseStream()
    this.setState({ status: 'starting', facing, info: null, error: null })

    let newStream: MediaStream
    try {
      newStream = await navigator.mediaDevices.getUserMedia(
        buildConstraints(facing, deviceId),
      )
    } catch (error: unknown) {
      if (!this.isCurrent(myGeneration)) {
        return
      }
      // deviceId 指定で失敗した場合は、facingMode だけで一度やり直す。
      if (deviceId !== null) {
        this.currentDeviceId = null
        await this.openCamera(facing, null)
        return
      }
      this.fail(toCameraError(error))
      return
    }

    // 待っている間に、停止や別の操作が始まっていた場合は、取得したストリームを捨てる。
    if (!this.isCurrent(myGeneration)) {
      stopStream(newStream)
      return
    }

    this.stream = newStream

    try {
      await this.attachAndPlay(newStream)
    } catch {
      if (!this.isCurrent(myGeneration)) {
        return
      }
      this.fail(createCameraError('play-failed'))
      return
    }

    if (!this.isCurrent(myGeneration)) {
      return
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
  this.cancelFrameLoop()

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