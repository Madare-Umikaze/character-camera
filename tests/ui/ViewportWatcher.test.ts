import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VIEWPORT_SETTLE_MS,
  ViewportWatcher,
} from '../../src/ui/ViewportWatcher.ts'
import type {
  ViewportChange,
  ViewportEnvironment,
} from '../../src/ui/ViewportWatcher.ts'
import type { Size2D } from '../../src/types/geometry.ts'

const PORTRAIT: Size2D = { width: 400, height: 800 }
const LANDSCAPE: Size2D = { width: 800, height: 400 }

interface FakeEnvironment {
  readonly env: ViewportEnvironment
  /** 現在のウィンドウサイズを変える(イベントは発火しない)。 */
  setSize(size: Size2D): void
  /** ブラウザのイベントが発生したことにする。 */
  fire(): void
  readonly subscribe: ReturnType<typeof vi.fn>
  readonly unsubscribe: ReturnType<typeof vi.fn>
}

function createFakeEnvironment(initial: Size2D): FakeEnvironment {
  let size = initial
  const holder: { listener: (() => void) | null } = { listener: null }
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((onEvent: () => void) => {
    holder.listener = onEvent
    return () => {
      unsubscribe()
      holder.listener = null
    }
  })
  const env: ViewportEnvironment = {
    getSize: () => size,
    subscribe,
  }
  return {
    env,
    setSize(next) {
      size = next
    },
    fire() {
      holder.listener?.()
    },
    subscribe,
    unsubscribe,
  }
}

function createHandlers() {
  return {
    onSettled: vi.fn<(change: ViewportChange) => void>(),
    onOrientationChangeStart: vi.fn<() => void>(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('start', () => {
  it('現在の寸法を基準として記録し、通知はしない', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)

    expect(watcher.getCurrent()).toBeNull()
    watcher.start()

    expect(watcher.getCurrent()).toEqual({ size: PORTRAIT, orientation: 'portrait' })
    expect(handlers.onSettled).not.toHaveBeenCalled()
    expect(handlers.onOrientationChangeStart).not.toHaveBeenCalled()
  })

  it('二重に呼んでも、購読は 1 回だけ', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const watcher = new ViewportWatcher(createHandlers(), fake.env)

    watcher.start()
    watcher.start()

    expect(fake.subscribe).toHaveBeenCalledTimes(1)
  })
})

describe('向きの変化', () => {
  it('変わり始めに即座に通知し、落ち着いた後に結果を通知する', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize(LANDSCAPE)
    fake.fire()

    expect(handlers.onOrientationChangeStart).toHaveBeenCalledTimes(1)
    expect(handlers.onSettled).not.toHaveBeenCalled()

    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS - 1)
    expect(handlers.onSettled).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(handlers.onSettled).toHaveBeenCalledTimes(1)
    const change = handlers.onSettled.mock.calls[0]?.[0]
    expect(change?.orientationChanged).toBe(true)
    expect(change?.snapshot).toEqual({ size: LANDSCAPE, orientation: 'landscape' })
    expect(watcher.getCurrent()).toEqual({ size: LANDSCAPE, orientation: 'landscape' })
  })

  it('連続するイベントは、1 回の通知にまとまる', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize(LANDSCAPE)
    fake.fire()
    vi.advanceTimersByTime(100)
    fake.fire()
    vi.advanceTimersByTime(100)
    fake.fire()

    // 最後のイベントから 250ms 経つまでは、通知されない。
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS - 1)
    expect(handlers.onSettled).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(handlers.onSettled).toHaveBeenCalledTimes(1)
    expect(handlers.onOrientationChangeStart).toHaveBeenCalledTimes(1)
  })

  it('元の向きに戻り、寸法も同じなら、通知しない', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize(LANDSCAPE)
    fake.fire()
    vi.advanceTimersByTime(100)
    fake.setSize(PORTRAIT)
    fake.fire()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onSettled).not.toHaveBeenCalled()
  })

  it('落ち着いた後の次の回転では、変わり始めが再び通知される', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize(LANDSCAPE)
    fake.fire()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)
    expect(handlers.onOrientationChangeStart).toHaveBeenCalledTimes(1)

    fake.setSize(PORTRAIT)
    fake.fire()
    expect(handlers.onOrientationChangeStart).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onSettled).toHaveBeenCalledTimes(2)
    expect(handlers.onSettled.mock.calls[1]?.[0].orientationChanged).toBe(true)
  })
})

describe('向きが変わらない寸法の変化', () => {
  it('orientationChanged が false で通知され、変わり始めは通知されない', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize({ width: 450, height: 800 })
    fake.fire()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onOrientationChangeStart).not.toHaveBeenCalled()
    expect(handlers.onSettled).toHaveBeenCalledTimes(1)
    const change = handlers.onSettled.mock.calls[0]?.[0]
    expect(change?.orientationChanged).toBe(false)
    expect(change?.snapshot.orientation).toBe('portrait')
  })

  it('寸法が変わっていなければ、通知しない', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.fire()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onSettled).not.toHaveBeenCalled()
  })
})

describe('無効な寸法', () => {
  it('落ち着いた時点の寸法が 0 なら、無視する', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize({ width: 0, height: 0 })
    fake.fire()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onSettled).not.toHaveBeenCalled()
    expect(watcher.getCurrent()).toEqual({ size: PORTRAIT, orientation: 'portrait' })
  })

  it('開始時の寸法が無効でも、後で有効になれば通知される(向きの変化ではない)', () => {
    const fake = createFakeEnvironment({ width: 0, height: 0 })
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()
    expect(watcher.getCurrent()).toBeNull()

    fake.setSize(PORTRAIT)
    fake.fire()
    expect(handlers.onOrientationChangeStart).not.toHaveBeenCalled()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onSettled).toHaveBeenCalledTimes(1)
    expect(handlers.onSettled.mock.calls[0]?.[0].orientationChanged).toBe(false)
  })
})

describe('待ち時間の指定', () => {
  it('コンストラクタで待ち時間を変えられる', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env, 50)
    watcher.start()

    fake.setSize(LANDSCAPE)
    fake.fire()
    vi.advanceTimersByTime(49)
    expect(handlers.onSettled).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handlers.onSettled).toHaveBeenCalledTimes(1)
  })

  it('onOrientationChangeStart は省略できる', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const onSettled = vi.fn<(change: ViewportChange) => void>()
    const watcher = new ViewportWatcher({ onSettled }, fake.env)
    watcher.start()

    fake.setSize(LANDSCAPE)
    expect(() => {
      fake.fire()
    }).not.toThrow()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(onSettled).toHaveBeenCalledTimes(1)
  })
})

describe('dispose', () => {
  it('購読を解除し、以降のイベントを無視する', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    watcher.dispose()
    fake.setSize(LANDSCAPE)
    fake.fire()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
    expect(handlers.onOrientationChangeStart).not.toHaveBeenCalled()
    expect(handlers.onSettled).not.toHaveBeenCalled()
  })

  it('待機中のタイマーを取り消す', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const handlers = createHandlers()
    const watcher = new ViewportWatcher(handlers, fake.env)
    watcher.start()

    fake.setSize(LANDSCAPE)
    fake.fire()
    watcher.dispose()
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS)

    expect(handlers.onSettled).not.toHaveBeenCalled()
  })

  it('二重に呼んでも、解除は 1 回だけ', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const watcher = new ViewportWatcher(createHandlers(), fake.env)
    watcher.start()

    watcher.dispose()
    watcher.dispose()

    expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('dispose 後の start は何もしない', () => {
    const fake = createFakeEnvironment(PORTRAIT)
    const watcher = new ViewportWatcher(createHandlers(), fake.env)

    watcher.dispose()
    watcher.start()

    expect(fake.subscribe).not.toHaveBeenCalled()
  })
})