import { describe, expect, it, vi } from 'vitest'
import { CharacterImage } from '../../src/image/CharacterImage.ts'
import type { ImageFileLoader } from '../../src/image/CharacterImage.ts'
import { createImageLoadError } from '../../src/image/ImageLoader.ts'
import type { ImageLoadResult } from '../../src/image/ImageLoader.ts'
import { MAX_POSITION_OFFSET } from '../../src/transform/characterTransform.ts'
import {
  createPerspectiveFromSliders,
  isValidQuad,
} from '../../src/transform/PerspectiveTransform.ts'
import { DEFAULT_CHARACTER_STATE } from '../../src/types/character.ts'
import type { CharacterSnapshot } from '../../src/types/character.ts'
import { DEFAULT_PERSPECTIVE_STATE, UNIT_QUAD } from '../../src/types/perspective.ts'

interface FakeLoadSuccess {
  readonly result: ImageLoadResult
  readonly bitmap: ImageBitmap
  readonly close: ReturnType<typeof vi.fn>
}

/** close() の呼び出しを記録できる、偽の読み込み成功結果を作る。 */
function createSuccess(name: string, width: number, height: number): FakeLoadSuccess {
  const close = vi.fn()
  const bitmap = { width, height, close } as unknown as ImageBitmap
  return {
    result: { ok: true, bitmap, info: { name, width, height } },
    bitmap,
    close,
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

/** 好きなタイミングで解決できる Promise を作る。 */
function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function createFile(name = 'a.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

/** 指定した結果を順に返す読み込み関数を作る。 */
function loaderReturning(...results: ImageLoadResult[]): ImageFileLoader {
  const queue = [...results]
  return async () => {
    const next = queue.shift()
    if (next === undefined) {
      throw new Error('想定より多く読み込み関数が呼ばれました')
    }
    return next
  }
}

/** 画像を 1 つ読み込んだ状態の CharacterImage を作る。 */
async function createLoaded(): Promise<{
  ci: CharacterImage
  close: FakeLoadSuccess['close']
}> {
  const success = createSuccess('a.png', 100, 50)
  const ci = new CharacterImage(loaderReturning(success.result))
  await ci.load(createFile())
  return { ci, close: success.close }
}

describe('初期状態', () => {
  it('画像なし・初期状態・四隅は初期値・読み込み中でない・エラーなし', () => {
    const ci = new CharacterImage(loaderReturning())
    expect(ci.getSnapshot()).toEqual({
      image: null,
      state: DEFAULT_CHARACTER_STATE,
      perspective: DEFAULT_PERSPECTIVE_STATE,
      loading: false,
      error: null,
    })
    expect(ci.getBitmap()).toBeNull()
    expect(ci.getImageSize()).toBeNull()
  })
})

describe('subscribe', () => {
  it('登録時に現在のスナップショットを一度通知する', () => {
    const ci = new CharacterImage(loaderReturning())
    const listener = vi.fn()
    ci.subscribe(listener)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(ci.getSnapshot())
  })

  it('解除すると、以降は通知されない', async () => {
    const success = createSuccess('a.png', 100, 50)
    const ci = new CharacterImage(loaderReturning(success.result))
    const listener = vi.fn()
    const unsubscribe = ci.subscribe(listener)
    unsubscribe()
    listener.mockClear()

    await ci.load(createFile())

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('load(成功)', () => {
  it('画像の情報とビットマップを保持し、基本変形と四隅は初期状態になる', async () => {
    const success = createSuccess('character.png', 100, 50)
    const ci = new CharacterImage(loaderReturning(success.result))

    await ci.load(createFile('character.png'))

    const snapshot = ci.getSnapshot()
    expect(snapshot.image).toEqual({ name: 'character.png', width: 100, height: 50 })
    expect(snapshot.state).toEqual(DEFAULT_CHARACTER_STATE)
    expect(snapshot.perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
    expect(snapshot.loading).toBe(false)
    expect(snapshot.error).toBeNull()
    expect(ci.getBitmap()).toBe(success.bitmap)
    expect(ci.getImageSize()).toEqual({ width: 100, height: 50 })
    expect(success.close).not.toHaveBeenCalled()
  })

  it('読み込み中は loading が true になり、完了後に false へ戻る', async () => {
    const success = createSuccess('a.png', 10, 10)
    const ci = new CharacterImage(loaderReturning(success.result))
    const loadingValues: boolean[] = []
    ci.subscribe((snapshot) => {
      loadingValues.push(snapshot.loading)
    })

    await ci.load(createFile())

    // 登録時の通知(false)、読み込み開始(true)、完了(false)
    expect(loadingValues).toEqual([false, true, false])
  })

  it('読み込み中も、前の画像は snapshot に残る', async () => {
    const first = createSuccess('first.png', 10, 10)
    const pending = createDeferred<ImageLoadResult>()
    const results: Array<Promise<ImageLoadResult>> = [
      Promise.resolve(first.result),
      pending.promise,
    ]
    const loader: ImageFileLoader = () => {
      const next = results.shift()
      if (next === undefined) {
        throw new Error('想定より多く呼ばれました')
      }
      return next
    }
    const ci = new CharacterImage(loader)
    await ci.load(createFile('first.png'))

    const secondLoad = ci.load(createFile('second.png'))

    expect(ci.getSnapshot().loading).toBe(true)
    expect(ci.getSnapshot().image?.name).toBe('first.png')

    const second = createSuccess('second.png', 20, 20)
    pending.resolve(second.result)
    await secondLoad
    expect(ci.getSnapshot().image?.name).toBe('second.png')
  })

  it('新しい画像に差し替えると、前のビットマップを閉じ、基本変形・左右反転・四隅を初期値に戻す', async () => {
    const first = createSuccess('first.png', 10, 10)
    const second = createSuccess('second.png', 20, 30)
    const ci = new CharacterImage(loaderReturning(first.result, second.result))

    await ci.load(createFile('first.png'))
    ci.setOpacity(0.3)
    ci.toggleVisible()
    ci.toggleFlipX()
    ci.setPerspectiveSliders(0.5, -0.5)
    await ci.load(createFile('second.png'))

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(ci.getBitmap()).toBe(second.bitmap)
    expect(ci.getSnapshot().state).toEqual(DEFAULT_CHARACTER_STATE)
    expect(ci.getSnapshot().perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
    expect(ci.getImageSize()).toEqual({ width: 20, height: 30 })
  })
})

describe('load(失敗)', () => {
  it('画像がない状態で失敗すると、エラーだけが設定される', async () => {
    const error = createImageLoadError('decode-failed')
    const ci = new CharacterImage(loaderReturning({ ok: false, error }))

    await ci.load(createFile())

    const snapshot = ci.getSnapshot()
    expect(snapshot.image).toBeNull()
    expect(snapshot.error).toEqual(error)
    expect(snapshot.loading).toBe(false)
    expect(ci.getBitmap()).toBeNull()
  })

  it('表示中の画像と、基本変形・四隅は、失敗しても維持され、ビットマップも閉じない', async () => {
    const first = createSuccess('first.png', 10, 10)
    const error = createImageLoadError('unsupported-heic')
    const ci = new CharacterImage(loaderReturning(first.result, { ok: false, error }))

    await ci.load(createFile('first.png'))
    ci.setOpacity(0.4)
    ci.setPerspectiveSliders(0.5, 0)
    const stateBefore = ci.getSnapshot().state
    const perspectiveBefore = ci.getSnapshot().perspective

    await ci.load(createFile('photo.heic'))

    const snapshot = ci.getSnapshot()
    expect(snapshot.image?.name).toBe('first.png')
    expect(snapshot.state).toEqual(stateBefore)
    expect(snapshot.perspective).toEqual(perspectiveBefore)
    expect(snapshot.error).toEqual(error)
    expect(ci.getBitmap()).toBe(first.bitmap)
    expect(first.close).not.toHaveBeenCalled()
  })

  it('読み込み関数が例外を投げたら、decode-failed のエラーにする', async () => {
    const loader: ImageFileLoader = async () => {
      throw new Error('unexpected')
    }
    const ci = new CharacterImage(loader)

    await ci.load(createFile())

    expect(ci.getSnapshot().error?.kind).toBe('decode-failed')
    expect(ci.getSnapshot().loading).toBe(false)
  })

  it('次の読み込みを始めるとエラーが消え、成功しても残らない', async () => {
    const error = createImageLoadError('decode-failed')
    const success = createSuccess('a.png', 10, 10)
    const ci = new CharacterImage(loaderReturning({ ok: false, error }, success.result))
    await ci.load(createFile())
    expect(ci.getSnapshot().error).not.toBeNull()

    const errors: Array<CharacterSnapshot['error']> = []
    ci.subscribe((snapshot) => {
      errors.push(snapshot.error)
    })
    await ci.load(createFile())

    // 登録時の通知(エラーあり)、読み込み開始(消える)、完了(なし)
    expect(errors[0]).not.toBeNull()
    expect(errors[1]).toBeNull()
    expect(errors[2]).toBeNull()
  })
})

describe('連続した読み込み・削除との競合', () => {
  it('古い読み込みの結果は採用されず、ビットマップが閉じられる', async () => {
    const slow = createDeferred<ImageLoadResult>()
    const fast = createDeferred<ImageLoadResult>()
    const queue = [slow, fast]
    const loader: ImageFileLoader = () => {
      const next = queue.shift()
      if (next === undefined) {
        throw new Error('想定より多く呼ばれました')
      }
      return next.promise
    }
    const ci = new CharacterImage(loader)

    const firstLoad = ci.load(createFile('slow.png'))
    const secondLoad = ci.load(createFile('fast.png'))

    const fastResult = createSuccess('fast.png', 20, 20)
    fast.resolve(fastResult.result)
    await secondLoad

    const slowResult = createSuccess('slow.png', 10, 10)
    slow.resolve(slowResult.result)
    await firstLoad

    expect(ci.getSnapshot().image?.name).toBe('fast.png')
    expect(ci.getBitmap()).toBe(fastResult.bitmap)
    expect(slowResult.close).toHaveBeenCalledTimes(1)
    expect(fastResult.close).not.toHaveBeenCalled()
    expect(ci.getSnapshot().loading).toBe(false)
  })

  it('古い読み込みが失敗しても、新しい結果は影響を受けない', async () => {
    const slow = createDeferred<ImageLoadResult>()
    const fast = createDeferred<ImageLoadResult>()
    const queue = [slow, fast]
    const loader: ImageFileLoader = () => {
      const next = queue.shift()
      if (next === undefined) {
        throw new Error('想定より多く呼ばれました')
      }
      return next.promise
    }
    const ci = new CharacterImage(loader)

    const firstLoad = ci.load(createFile('slow.png'))
    const secondLoad = ci.load(createFile('fast.png'))

    fast.resolve(createSuccess('fast.png', 20, 20).result)
    await secondLoad
    slow.resolve({ ok: false, error: createImageLoadError('decode-failed') })
    await firstLoad

    expect(ci.getSnapshot().image?.name).toBe('fast.png')
    expect(ci.getSnapshot().error).toBeNull()
  })

  it('読み込み中に削除すると、遅れて届いた結果は採用されず閉じられる', async () => {
    const pending = createDeferred<ImageLoadResult>()
    const ci = new CharacterImage(() => pending.promise)

    const load = ci.load(createFile())
    ci.remove()

    const late = createSuccess('late.png', 10, 10)
    pending.resolve(late.result)
    await load

    expect(ci.getSnapshot().image).toBeNull()
    expect(ci.getBitmap()).toBeNull()
    expect(ci.getSnapshot().loading).toBe(false)
    expect(late.close).toHaveBeenCalledTimes(1)
  })
})

describe('基本変形の更新', () => {
  it('画像がないときの更新は無視され、通知もされない(基本変形・反転・射影・リセットのすべて)', () => {
    const ci = new CharacterImage(loaderReturning())
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.setOpacity(0.2)
    ci.setRotation(1)
    ci.setVisible(false)
    ci.toggleVisible()
    ci.setFlipX(true)
    ci.toggleFlipX()
    ci.updateState((state) => ({ ...state, x: 0.3 }))
    ci.setState({ ...DEFAULT_CHARACTER_STATE, scale: 3 })
    ci.setPerspectiveSliders(0.5, 0.5)
    ci.moveCorner(0, { x: -0.6, y: -0.6 })
    ci.updatePerspective(() => createPerspectiveFromSliders(0.5, 0.5))
    ci.resetShape()
    ci.reset()

    expect(listener).not.toHaveBeenCalled()
    expect(ci.getSnapshot().state).toEqual(DEFAULT_CHARACTER_STATE)
    expect(ci.getSnapshot().perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
  })

  it('setOpacity は 0〜1 に収める', async () => {
    const { ci } = await createLoaded()
    ci.setOpacity(0.4)
    expect(ci.getSnapshot().state.opacity).toBe(0.4)
    ci.setOpacity(5)
    expect(ci.getSnapshot().state.opacity).toBe(1)
    ci.setOpacity(-1)
    expect(ci.getSnapshot().state.opacity).toBe(0)
  })

  it('setRotation は角度を正規化する', async () => {
    const { ci } = await createLoaded()
    ci.setRotation(1)
    expect(ci.getSnapshot().state.rotation).toBeCloseTo(1, 9)
    ci.setRotation(Math.PI * 2)
    expect(ci.getSnapshot().state.rotation).toBeCloseTo(0, 9)
  })

  it('setVisible と toggleVisible で表示・非表示を切り替える', async () => {
    const { ci } = await createLoaded()
    ci.setVisible(false)
    expect(ci.getSnapshot().state.visible).toBe(false)
    ci.toggleVisible()
    expect(ci.getSnapshot().state.visible).toBe(true)
    ci.toggleVisible()
    expect(ci.getSnapshot().state.visible).toBe(false)
  })

  it('updateState の結果は正規化される', async () => {
    const { ci } = await createLoaded()
    ci.updateState((state) => ({ ...state, x: 10, y: -10, scale: 100 }))
    const state = ci.getSnapshot().state
    expect(state.x).toBe(MAX_POSITION_OFFSET)
    expect(state.y).toBe(-MAX_POSITION_OFFSET)
    expect(state.scale).toBe(6)
  })

  it('setState でまとめて設定できる', async () => {
    const { ci } = await createLoaded()
    ci.setState({
      x: 0.1,
      y: 0.2,
      scale: 2,
      rotation: 0.5,
      opacity: 0.6,
      visible: false,
      flipX: true,
    })
    expect(ci.getSnapshot().state).toEqual({
      x: 0.1,
      y: 0.2,
      scale: 2,
      rotation: 0.5,
      opacity: 0.6,
      visible: false,
      flipX: true,
    })
  })

  it('更新のたびにリスナーへ通知される', async () => {
    const { ci } = await createLoaded()
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.setOpacity(0.5)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].state.opacity).toBe(0.5)
  })

  it('スナップショットは更新のたびに新しいオブジェクトになる', async () => {
    const { ci } = await createLoaded()
    const before = ci.getSnapshot()
    ci.setOpacity(0.5)
    expect(ci.getSnapshot()).not.toBe(before)
    expect(before.state.opacity).toBe(1)
  })
})

describe('左右反転', () => {
  it('setFlipX と toggleFlipX で切り替える', async () => {
    const { ci } = await createLoaded()
    expect(ci.getSnapshot().state.flipX).toBe(false)
    ci.setFlipX(true)
    expect(ci.getSnapshot().state.flipX).toBe(true)
    ci.toggleFlipX()
    expect(ci.getSnapshot().state.flipX).toBe(false)
    ci.toggleFlipX()
    expect(ci.getSnapshot().state.flipX).toBe(true)
  })

  it('反転しても、ほかの基本変形・四隅は変わらない', async () => {
    const { ci } = await createLoaded()
    ci.setOpacity(0.4)
    ci.setPerspectiveSliders(0.3, 0.3)
    const before = ci.getSnapshot()

    ci.setFlipX(true)

    const after = ci.getSnapshot()
    expect(after.state).toEqual({ ...before.state, flipX: true })
    expect(after.perspective).toBe(before.perspective)
  })

  it('ほかの基本変形を更新しても、反転は維持される', async () => {
    const { ci } = await createLoaded()
    ci.setFlipX(true)
    ci.setOpacity(0.5)
    ci.setRotation(1)
    expect(ci.getSnapshot().state.flipX).toBe(true)
  })
})

describe('射影変換(遠近感スライダー・四隅)', () => {
  it('setPerspectiveSliders は、スライダーの値と、そこから計算した四隅を設定する', async () => {
    const { ci } = await createLoaded()
    ci.setPerspectiveSliders(0.5, -0.25)
    expect(ci.getSnapshot().perspective).toEqual(createPerspectiveFromSliders(0.5, -0.25))
    expect(ci.getSnapshot().perspective.horizontal).toBe(0.5)
    expect(ci.getSnapshot().perspective.vertical).toBe(-0.25)
  })

  it('スライダーの値は -1〜1 に収められる', async () => {
    const { ci } = await createLoaded()
    ci.setPerspectiveSliders(5, -5)
    expect(ci.getSnapshot().perspective.horizontal).toBe(1)
    expect(ci.getSnapshot().perspective.vertical).toBe(-1)
  })

  it('スライダーを動かしても、基本変形は変わらない', async () => {
    const { ci } = await createLoaded()
    ci.setOpacity(0.4)
    ci.setRotation(0.5)
    const stateBefore = ci.getSnapshot().state

    ci.setPerspectiveSliders(0.7, 0.7)

    expect(ci.getSnapshot().state).toBe(stateBefore)
  })

  it('moveCorner は、指定した頂点だけを動かし、スライダーの値と基本変形は変えない', async () => {
    const { ci } = await createLoaded()
    ci.setPerspectiveSliders(0.3, -0.2)
    const before = ci.getSnapshot()

    ci.moveCorner(0, { x: -0.5, y: -0.55 })

    const after = ci.getSnapshot()
    expect(after.perspective.corners[0]).toEqual({ x: -0.5, y: -0.55 })
    expect(after.perspective.corners[1]).toBe(before.perspective.corners[1])
    expect(after.perspective.corners[2]).toBe(before.perspective.corners[2])
    expect(after.perspective.corners[3]).toBe(before.perspective.corners[3])
    expect(after.perspective.horizontal).toBe(0.3)
    expect(after.perspective.vertical).toBe(-0.2)
    expect(after.state).toBe(before.state)
  })

  it('moveCorner で不正な形になる位置を指定すると、有効な範囲の境界で止まる', async () => {
    const { ci } = await createLoaded()

    // 右下を、左上の方向へ(対角線を越えるように)動かす。
    ci.moveCorner(2, { x: -0.2, y: -0.2 })

    const corners = ci.getSnapshot().perspective.corners
    expect(isValidQuad(corners)).toBe(true)
    expect(corners[2].x).toBeGreaterThan(0)
    expect(corners[2].x).toBeLessThan(0.1)
  })

  it('moveCorner で位置が変わらない場合は、通知しない', async () => {
    const { ci } = await createLoaded()
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.moveCorner(0, UNIT_QUAD[0])
    ci.moveCorner(1, { x: Number.NaN, y: 0 })

    expect(listener).not.toHaveBeenCalled()
  })

  it('四隅を個別に動かした後にスライダーを動かすと、個別の調整は上書きされる', async () => {
    const { ci } = await createLoaded()
    ci.moveCorner(0, { x: -0.6, y: -0.4 })

    ci.setPerspectiveSliders(0.2, 0.2)

    expect(ci.getSnapshot().perspective).toEqual(createPerspectiveFromSliders(0.2, 0.2))
  })

  it('四隅を動かした後も、その後にさらに四隅を個別に動かせる', async () => {
    const { ci } = await createLoaded()
    ci.setPerspectiveSliders(0.4, 0.4)
    ci.moveCorner(1, { x: 0.55, y: -0.45 })
    ci.moveCorner(3, { x: -0.35, y: 0.6 })

    const corners = ci.getSnapshot().perspective.corners
    expect(corners[1]).toEqual({ x: 0.55, y: -0.45 })
    expect(corners[3]).toEqual({ x: -0.35, y: 0.6 })
    expect(isValidQuad(corners)).toBe(true)
  })

  it('更新のたびにリスナーへ通知される', async () => {
    const { ci } = await createLoaded()
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.setPerspectiveSliders(0.5, 0)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].perspective.horizontal).toBe(0.5)
  })

  it('updatePerspective は、同じ状態を返した場合は通知しない', async () => {
    const { ci } = await createLoaded()
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.updatePerspective((state) => state)

    expect(listener).not.toHaveBeenCalled()
  })

  it('updatePerspective が無効な四隅を返した場合は、初期状態に戻る', async () => {
    const { ci } = await createLoaded()
    ci.setPerspectiveSliders(0.5, 0.5)

    ci.updatePerspective((state) => ({
      ...state,
      // 蝶ネクタイ形(自己交差)の四隅
      corners: [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: -0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ],
    }))

    expect(ci.getSnapshot().perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
  })
})

describe('resetShape(形状リセット)', () => {
  it('四隅とスライダーだけを初期値に戻し、基本変形は維持する', async () => {
    const { ci } = await createLoaded()
    ci.setOpacity(0.4)
    ci.setFlipX(true)
    ci.setPerspectiveSliders(0.5, -0.5)
    ci.moveCorner(0, { x: -0.6, y: -0.4 })
    const stateBefore = ci.getSnapshot().state

    ci.resetShape()

    expect(ci.getSnapshot().perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
    expect(ci.getSnapshot().state).toBe(stateBefore)
  })

  it('すでに初期状態のときは、通知しない', async () => {
    const { ci } = await createLoaded()
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.resetShape()

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('reset(すべてリセット)', () => {
  it('基本変形・左右反転・四隅のすべてを初期値に戻し、画像は残す', async () => {
    const { ci, close } = await createLoaded()
    ci.setState({
      x: 0.3,
      y: -0.2,
      scale: 3,
      rotation: 1,
      opacity: 0.2,
      visible: false,
      flipX: true,
    })
    ci.setPerspectiveSliders(0.6, 0.6)
    ci.moveCorner(0, { x: -0.7, y: -0.6 })

    ci.reset()

    expect(ci.getSnapshot().state).toEqual(DEFAULT_CHARACTER_STATE)
    expect(ci.getSnapshot().perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
    expect(ci.getSnapshot().image).not.toBeNull()
    expect(ci.getBitmap()).not.toBeNull()
    expect(close).not.toHaveBeenCalled()
  })

  it('リセット後に、また変形できる', async () => {
    const { ci } = await createLoaded()
    ci.setPerspectiveSliders(0.6, 0.6)
    ci.reset()

    ci.setPerspectiveSliders(0.2, 0)
    ci.setOpacity(0.5)

    expect(ci.getSnapshot().perspective.horizontal).toBe(0.2)
    expect(ci.getSnapshot().state.opacity).toBe(0.5)
  })
})

describe('remove', () => {
  it('ビットマップを閉じ、画像・基本変形・四隅を初期化する', async () => {
    const success = createSuccess('a.png', 100, 50)
    const ci = new CharacterImage(loaderReturning(success.result))
    await ci.load(createFile())
    ci.setOpacity(0.2)
    ci.setFlipX(true)
    ci.setPerspectiveSliders(0.5, 0.5)

    ci.remove()

    expect(success.close).toHaveBeenCalledTimes(1)
    expect(ci.getBitmap()).toBeNull()
    expect(ci.getImageSize()).toBeNull()
    expect(ci.getSnapshot()).toEqual({
      image: null,
      state: DEFAULT_CHARACTER_STATE,
      perspective: DEFAULT_PERSPECTIVE_STATE,
      loading: false,
      error: null,
    })
  })

  it('削除後に同じ画像を読み込み直しても、以前の変形が残らない', async () => {
    const first = createSuccess('a.png', 10, 10)
    const second = createSuccess('a.png', 10, 10)
    const ci = new CharacterImage(loaderReturning(first.result, second.result))

    await ci.load(createFile())
    ci.setPerspectiveSliders(0.5, 0.5)
    ci.setFlipX(true)
    ci.remove()
    await ci.load(createFile())

    expect(ci.getBitmap()).toBe(second.bitmap)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(ci.getSnapshot().state).toEqual(DEFAULT_CHARACTER_STATE)
    expect(ci.getSnapshot().perspective).toEqual(DEFAULT_PERSPECTIVE_STATE)
  })

  it('画像がなくても、例外を投げない', () => {
    const ci = new CharacterImage(loaderReturning())
    expect(() => {
      ci.remove()
    }).not.toThrow()
  })
})

describe('clearError', () => {
  it('エラーを消し、通知する', async () => {
    const ci = new CharacterImage(
      loaderReturning({ ok: false, error: createImageLoadError('decode-failed') }),
    )
    await ci.load(createFile())
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.clearError()

    expect(ci.getSnapshot().error).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('エラーがないときは、通知しない', () => {
    const ci = new CharacterImage(loaderReturning())
    const listener = vi.fn()
    ci.subscribe(listener)
    listener.mockClear()

    ci.clearError()

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('dispose', () => {
  it('ビットマップを閉じ、以降は通知しない', async () => {
    const success = createSuccess('a.png', 100, 50)
    const ci = new CharacterImage(loaderReturning(success.result))
    await ci.load(createFile())
    const listener = vi.fn()
    ci.subscribe(listener)

    ci.dispose()
    listener.mockClear()
    ci.remove()
    ci.setOpacity(0.5)
    ci.setPerspectiveSliders(0.5, 0.5)

    expect(success.close).toHaveBeenCalledTimes(1)
    expect(ci.getBitmap()).toBeNull()
    expect(ci.getSnapshot().image).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('読み込み中に破棄すると、遅れて届いた結果は閉じられる', async () => {
    const pending = createDeferred<ImageLoadResult>()
    const ci = new CharacterImage(() => pending.promise)

    const load = ci.load(createFile())
    ci.dispose()

    const late = createSuccess('late.png', 10, 10)
    pending.resolve(late.result)
    await load

    expect(late.close).toHaveBeenCalledTimes(1)
    expect(ci.getBitmap()).toBeNull()
  })
})