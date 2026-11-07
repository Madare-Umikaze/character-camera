import { describe, expect, it } from 'vitest'
import {
  IDEAL_FRAME_RATE,
  IDEAL_VIDEO_HEIGHT,
  IDEAL_VIDEO_WIDTH,
  buildConstraints,
  buildSizeConstraints,
  isOrientationMismatch,
  orientationOf,
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

describe('orientationOf', () => {
  it('幅が高さより大きければ landscape', () => {
    expect(orientationOf({ width: 1920, height: 1080 })).toBe('landscape')
  })

  it('高さが幅より大きければ portrait', () => {
    expect(orientationOf({ width: 1080, height: 1920 })).toBe('portrait')
  })

  it('幅と高さが等しければ square', () => {
    expect(orientationOf({ width: 100, height: 100 })).toBe('square')
  })

  it('寸法が 0 のとき(映像が未取得)は square', () => {
    expect(orientationOf({ width: 0, height: 0 })).toBe('square')
    expect(orientationOf({ width: 0, height: 100 })).toBe('square')
    expect(orientationOf({ width: 100, height: 0 })).toBe('square')
  })

  it('負の値や NaN は square', () => {
    expect(orientationOf({ width: -1, height: 100 })).toBe('square')
    expect(orientationOf({ width: Number.NaN, height: 100 })).toBe('square')
    expect(orientationOf({ width: 100, height: Number.NaN })).toBe('square')
  })

  it('わずかな差でも向きを判定する', () => {
    expect(orientationOf({ width: 101, height: 100 })).toBe('landscape')
    expect(orientationOf({ width: 100, height: 101 })).toBe('portrait')
  })
})

describe('isOrientationMismatch', () => {
  const landscapeVideo = { width: 1920, height: 1080 }
  const portraitVideo = { width: 1080, height: 1920 }

  it('映像が横長で画面が縦なら食い違い', () => {
    expect(isOrientationMismatch(landscapeVideo, 'portrait')).toBe(true)
  })

  it('映像が縦長で画面が横なら食い違い', () => {
    expect(isOrientationMismatch(portraitVideo, 'landscape')).toBe(true)
  })

  it('向きが同じなら食い違いではない', () => {
    expect(isOrientationMismatch(landscapeVideo, 'landscape')).toBe(false)
    expect(isOrientationMismatch(portraitVideo, 'portrait')).toBe(false)
  })

  it('映像が正方形・寸法不明なら、食い違いとは判定しない', () => {
    expect(isOrientationMismatch({ width: 100, height: 100 }, 'portrait')).toBe(false)
    expect(isOrientationMismatch({ width: 0, height: 0 }, 'landscape')).toBe(false)
  })

  it('画面が square なら、食い違いとは判定しない', () => {
    expect(isOrientationMismatch(landscapeVideo, 'square')).toBe(false)
    expect(isOrientationMismatch(portraitVideo, 'square')).toBe(false)
  })
})

describe('buildSizeConstraints', () => {
  it('landscape は、幅を長辺・高さを短辺として要求する', () => {
    const size = buildSizeConstraints('landscape')
    expect(size.width).toEqual({ ideal: IDEAL_VIDEO_WIDTH })
    expect(size.height).toEqual({ ideal: IDEAL_VIDEO_HEIGHT })
  })

  it('portrait は、幅と高さの ideal を入れ替える', () => {
    const size = buildSizeConstraints('portrait')
    expect(size.width).toEqual({ ideal: IDEAL_VIDEO_HEIGHT })
    expect(size.height).toEqual({ ideal: IDEAL_VIDEO_WIDTH })
  })

  it('square は、従来どおりの横向きの指定になる', () => {
    expect(buildSizeConstraints('square')).toEqual(buildSizeConstraints('landscape'))
  })

  it('カメラの選択(facingMode / deviceId)を含まない', () => {
    for (const orientation of ['landscape', 'portrait', 'square'] as const) {
      const size = buildSizeConstraints(orientation)
      expect(size.facingMode).toBeUndefined()
      expect(size.deviceId).toBeUndefined()
    }
  })
})

describe('buildConstraints(向きの指定)', () => {
  it('向きを省略すると、従来どおりの横向きの指定になる', () => {
    const video = getVideoConstraints(buildConstraints('environment', null))
    expect(video.width).toEqual({ ideal: IDEAL_VIDEO_WIDTH })
    expect(video.height).toEqual({ ideal: IDEAL_VIDEO_HEIGHT })
    expect(video.facingMode).toEqual({ ideal: 'environment' })
    expect(video.frameRate).toEqual({ ideal: IDEAL_FRAME_RATE })
  })

  it('portrait を指定すると、幅と高さの ideal が入れ替わる', () => {
    const video = getVideoConstraints(buildConstraints('environment', null, 'portrait'))
    expect(video.width).toEqual({ ideal: IDEAL_VIDEO_HEIGHT })
    expect(video.height).toEqual({ ideal: IDEAL_VIDEO_WIDTH })
  })

  it('向きを変えても、前面・背面の選択は変わらない', () => {
    expect(
      getVideoConstraints(buildConstraints('user', null, 'portrait')).facingMode,
    ).toEqual({ ideal: 'user' })
    expect(
      getVideoConstraints(buildConstraints('environment', null, 'landscape')).facingMode,
    ).toEqual({ ideal: 'environment' })
  })

  it('deviceId を指定した場合は、向きを変えても exact のまま', () => {
    const video = getVideoConstraints(buildConstraints('user', 'camera-1', 'portrait'))
    expect(video.deviceId).toEqual({ exact: 'camera-1' })
    expect(video.facingMode).toBeUndefined()
  })

  it('向きによらず、音声は取得せず、フレームレートを要求する', () => {
    for (const orientation of ['landscape', 'portrait', 'square'] as const) {
      const constraints = buildConstraints('environment', null, orientation)
      expect(constraints.audio).toBe(false)
      expect(getVideoConstraints(constraints).frameRate).toEqual({
        ideal: IDEAL_FRAME_RATE,
      })
    }
  })
})