import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMERA_FACING,
  IDEAL_FRAME_RATE,
  IDEAL_VIDEO_HEIGHT,
  IDEAL_VIDEO_WIDTH,
  buildConstraints,
  checkEnvironment,
  classifyCameraErrorName,
  createCameraError,
  createInitialState,
  describeState,
  extractErrorName,
  facingLabel,
  messageForKind,
  oppositeFacing,
  toCameraError,
} from '../../src/camera/CameraSettings.ts'
import type {
  CameraErrorKind,
  CameraInfo,
  CameraState,
} from '../../src/camera/CameraSettings.ts'

/** buildConstraints の結果から、video 制約をオブジェクトとして取り出す。 */
function getVideoConstraints(
  constraints: MediaStreamConstraints,
): MediaTrackConstraints {
  const video = constraints.video
  if (typeof video !== 'object') {
    throw new Error('video 制約がオブジェクトではありません')
  }
  return video
}

const ALL_ERROR_KINDS: readonly CameraErrorKind[] = [
  'insecure-context',
  'unsupported',
  'permission-denied',
  'not-found',
  'in-use',
  'constraint',
  'play-failed',
  'aborted',
  'unknown',
]

describe('向きの扱い', () => {
  it('反対の向きを返す', () => {
    expect(oppositeFacing('user')).toBe('environment')
    expect(oppositeFacing('environment')).toBe('user')
  })

  it('2回反転すると元に戻る', () => {
    expect(oppositeFacing(oppositeFacing('user'))).toBe('user')
    expect(oppositeFacing(oppositeFacing('environment'))).toBe('environment')
  })

  it('日本語ラベルを返す', () => {
    expect(facingLabel('user')).toBe('前面カメラ')
    expect(facingLabel('environment')).toBe('背面カメラ')
  })

  it('既定の向きは背面カメラ', () => {
    expect(DEFAULT_CAMERA_FACING).toBe('environment')
  })
})

describe('buildConstraints（CAM-U3）', () => {
  it('音声は取得しない', () => {
    expect(buildConstraints('environment', null).audio).toBe(false)
  })

  it('deviceId がない場合は facingMode を ideal で指定する（背面）', () => {
    const video = getVideoConstraints(buildConstraints('environment', null))
    expect(video.facingMode).toEqual({ ideal: 'environment' })
    expect(video.deviceId).toBeUndefined()
  })

  it('deviceId がない場合は facingMode を ideal で指定する（前面）', () => {
    const video = getVideoConstraints(buildConstraints('user', null))
    expect(video.facingMode).toEqual({ ideal: 'user' })
    expect(video.deviceId).toBeUndefined()
  })

  it('deviceId がある場合は exact で指定し、facingMode は指定しない', () => {
    const video = getVideoConstraints(buildConstraints('user', 'camera-123'))
    expect(video.deviceId).toEqual({ exact: 'camera-123' })
    expect(video.facingMode).toBeUndefined()
  })

  it('高解像度とフレームレートを ideal で要求する', () => {
    const video = getVideoConstraints(buildConstraints('environment', null))
    expect(video.width).toEqual({ ideal: IDEAL_VIDEO_WIDTH })
    expect(video.height).toEqual({ ideal: IDEAL_VIDEO_HEIGHT })
    expect(video.frameRate).toEqual({ ideal: IDEAL_FRAME_RATE })
  })
})

describe('classifyCameraErrorName（CAM-U1, CAM-U2）', () => {
  it.each<[string, CameraErrorKind]>([
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'not-found'],
    ['DevicesNotFoundError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['TrackStartError', 'in-use'],
    ['AbortError', 'in-use'],
    ['OverconstrainedError', 'constraint'],
    ['ConstraintNotSatisfiedError', 'constraint'],
    ['TypeError', 'unknown'],
  ])('%s は %s に分類される', (name, expected) => {
    expect(classifyCameraErrorName(name)).toBe(expected)
  })

  it('未知のエラー名は unknown になる', () => {
    expect(classifyCameraErrorName('SomethingElseError')).toBe('unknown')
  })

  it('空文字は unknown になる', () => {
    expect(classifyCameraErrorName('')).toBe('unknown')
  })

  it('名前が取得できない（null）場合は unknown になる', () => {
    expect(classifyCameraErrorName(null)).toBe('unknown')
  })
})

describe('extractErrorName', () => {
  it('name を持つ Error から名前を取り出す', () => {
    const error = new Error('denied')
    error.name = 'NotAllowedError'
    expect(extractErrorName(error)).toBe('NotAllowedError')
  })

  it('name を持つ素のオブジェクトから名前を取り出す', () => {
    expect(extractErrorName({ name: 'NotFoundError' })).toBe('NotFoundError')
  })

  it('name が文字列でない場合は null を返す', () => {
    expect(extractErrorName({ name: 123 })).toBeNull()
  })

  it('name を持たないオブジェクトは null を返す', () => {
    expect(extractErrorName({ message: 'x' })).toBeNull()
  })

  it('null・undefined・文字列・数値は null を返す', () => {
    expect(extractErrorName(null)).toBeNull()
    expect(extractErrorName(undefined)).toBeNull()
    expect(extractErrorName('NotAllowedError')).toBeNull()
    expect(extractErrorName(42)).toBeNull()
  })
})

describe('toCameraError', () => {
  it('投げられた値を CameraError に変換する', () => {
    const error = new Error('denied')
    error.name = 'NotAllowedError'
    const result = toCameraError(error)
    expect(result.kind).toBe('permission-denied')
    expect(result.message).toBe(messageForKind('permission-denied'))
  })

  it('想定外の値は unknown になる', () => {
    expect(toCameraError('文字列').kind).toBe('unknown')
    expect(toCameraError(undefined).kind).toBe('unknown')
  })
})

describe('エラーメッセージ', () => {
  it.each(ALL_ERROR_KINDS)('%s のメッセージは空でない', (kind) => {
    expect(messageForKind(kind).length).toBeGreaterThan(0)
  })

  it('すべての種別でメッセージが異なる', () => {
    const messages = ALL_ERROR_KINDS.map((kind) => messageForKind(kind))
    expect(new Set(messages).size).toBe(ALL_ERROR_KINDS.length)
  })

  it('createCameraError は種別とメッセージを対応させる', () => {
    const error = createCameraError('in-use')
    expect(error.kind).toBe('in-use')
    expect(error.message).toBe(messageForKind('in-use'))
  })
})

describe('checkEnvironment（CAM-U5）', () => {
  it('問題がなければ null を返す', () => {
    expect(
      checkEnvironment({
        isSecureContext: true,
        hasMediaDevices: true,
        hasGetUserMedia: true,
      }),
    ).toBeNull()
  })

  it('HTTPS でない場合は insecure-context を返す', () => {
    const result = checkEnvironment({
      isSecureContext: false,
      hasMediaDevices: true,
      hasGetUserMedia: true,
    })
    expect(result?.kind).toBe('insecure-context')
  })

  it('mediaDevices がない場合は unsupported を返す', () => {
    const result = checkEnvironment({
      isSecureContext: true,
      hasMediaDevices: false,
      hasGetUserMedia: false,
    })
    expect(result?.kind).toBe('unsupported')
  })

  it('getUserMedia がない場合は unsupported を返す', () => {
    const result = checkEnvironment({
      isSecureContext: true,
      hasMediaDevices: true,
      hasGetUserMedia: false,
    })
    expect(result?.kind).toBe('unsupported')
  })

  it('HTTPS でなく API もない場合は、HTTPS の問題を優先して返す', () => {
    const result = checkEnvironment({
      isSecureContext: false,
      hasMediaDevices: false,
      hasGetUserMedia: false,
    })
    expect(result?.kind).toBe('insecure-context')
  })
})

describe('createInitialState', () => {
  it('停止状態で、既定は背面カメラ', () => {
    const state = createInitialState()
    expect(state.status).toBe('stopped')
    expect(state.facing).toBe('environment')
    expect(state.info).toBeNull()
    expect(state.error).toBeNull()
    expect(state.canSwitch).toBe(false)
  })

  it('向きを指定できる', () => {
    expect(createInitialState('user').facing).toBe('user')
  })
})

describe('describeState', () => {
  const info: CameraInfo = {
    facing: 'environment',
    deviceId: 'camera-1',
    resolution: { width: 1920, height: 1080 },
    frameRate: 30,
  }

  it('停止中', () => {
    expect(describeState(createInitialState())).toBe('停止中')
  })

  it('起動中', () => {
    const state: CameraState = { ...createInitialState(), status: 'starting' }
    expect(describeState(state)).toBe('起動中…')
  })

  it('稼働中は向きと実際の解像度を表示する', () => {
    const state: CameraState = { ...createInitialState(), status: 'running', info }
    expect(describeState(state)).toBe('背面カメラ：1920×1080')
  })

  it('稼働中でも info がない場合は向きのみを表示する', () => {
    const state: CameraState = {
      ...createInitialState('user'),
      status: 'running',
    }
    expect(describeState(state)).toBe('前面カメラ：稼働中')
  })

  it('稼働中は info の向きを優先する', () => {
    const state: CameraState = {
      ...createInitialState('environment'),
      status: 'running',
      info: { ...info, facing: 'user' },
    }
    expect(describeState(state)).toBe('前面カメラ：1920×1080')
  })

  it('エラー', () => {
    const state: CameraState = {
      ...createInitialState(),
      status: 'error',
      error: createCameraError('unknown'),
    }
    expect(describeState(state)).toBe('エラー')
  })
})