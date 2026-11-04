import { describe, expect, it } from 'vitest'
import {
  MAX_CANVAS_DIMENSION,
  computeCanvasPixelSize,
  computeContainRect,
  sanitizeDevicePixelRatio,
} from '../../src/rendering/layout.ts'

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 }

describe('computeContainRect(RND-U1)', () => {
  it('横長の映像を縦長の領域に収めると、幅が一杯になり、上下に余白ができる', () => {
    // 倍率 = min(400/1920, 800/1080) = 400/1920 → 400 × 225、y = (800 - 225) / 2
    const rect = computeContainRect({ width: 1920, height: 1080 }, { width: 400, height: 800 })
    expect(rect.x).toBeCloseTo(0, 6)
    expect(rect.y).toBeCloseTo(287.5, 6)
    expect(rect.width).toBeCloseTo(400, 6)
    expect(rect.height).toBeCloseTo(225, 6)
  })

  it('縦長の映像を縦長の領域に収める', () => {
    // 倍率 = min(400/1080, 800/1920) = 400/1080 → 400 × 711.11…
    const rect = computeContainRect({ width: 1080, height: 1920 }, { width: 400, height: 800 })
    expect(rect.width).toBeCloseTo(400, 6)
    expect(rect.height).toBeCloseTo((1920 * 400) / 1080, 6)
    expect(rect.x).toBeCloseTo(0, 6)
    expect(rect.y).toBeCloseTo((800 - rect.height) / 2, 6)
  })

  it('領域が横長のときは、高さが一杯になり、左右に余白ができる', () => {
    // 倍率 = min(800/400, 400/800) = 0.5 → 200 × 400、x = (800 - 200) / 2
    const rect = computeContainRect({ width: 400, height: 800 }, { width: 800, height: 400 })
    expect(rect.width).toBeCloseTo(200, 6)
    expect(rect.height).toBeCloseTo(400, 6)
    expect(rect.x).toBeCloseTo(300, 6)
    expect(rect.y).toBeCloseTo(0, 6)
  })

  it('縦横比が同じなら、領域いっぱいに広がる(拡大もする)', () => {
    const rect = computeContainRect({ width: 200, height: 400 }, { width: 400, height: 800 })
    expect(rect).toEqual({ x: 0, y: 0, width: 400, height: 800 })
  })

  it('縦横比を保つ(引き伸ばさない)', () => {
    const rect = computeContainRect({ width: 1280, height: 720 }, { width: 390, height: 600 })
    expect(rect.width / rect.height).toBeCloseTo(1280 / 720, 6)
  })

  it('領域からはみ出さない', () => {
    const rect = computeContainRect({ width: 3000, height: 100 }, { width: 400, height: 800 })
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(400 + 1e-9)
    expect(rect.y + rect.height).toBeLessThanOrEqual(800 + 1e-9)
  })

  it('映像のサイズがまだ 0 のとき(未起動)は、すべて 0 の矩形を返す', () => {
    expect(computeContainRect({ width: 0, height: 0 }, { width: 400, height: 800 })).toEqual(
      ZERO_RECT,
    )
  })

  it('領域のサイズが 0 以下のときは、すべて 0 の矩形を返す', () => {
    expect(computeContainRect({ width: 100, height: 100 }, { width: 0, height: 800 })).toEqual(
      ZERO_RECT,
    )
    expect(computeContainRect({ width: 100, height: 100 }, { width: 400, height: -1 })).toEqual(
      ZERO_RECT,
    )
  })

  it('NaN が含まれるときも、すべて 0 の矩形を返す', () => {
    expect(
      computeContainRect({ width: Number.NaN, height: 100 }, { width: 400, height: 800 }),
    ).toEqual(ZERO_RECT)
    expect(
      computeContainRect({ width: 100, height: 100 }, { width: 400, height: Number.NaN }),
    ).toEqual(ZERO_RECT)
  })
})

describe('sanitizeDevicePixelRatio', () => {
  it('有効な値はそのまま返す', () => {
    expect(sanitizeDevicePixelRatio(1)).toBe(1)
    expect(sanitizeDevicePixelRatio(2)).toBe(2)
    expect(sanitizeDevicePixelRatio(3)).toBe(3)
  })

  it('下限・上限に収める', () => {
    expect(sanitizeDevicePixelRatio(0.1)).toBe(0.5)
    expect(sanitizeDevicePixelRatio(10)).toBe(4)
  })

  it('0 以下、NaN、無限大は 1 にする', () => {
    expect(sanitizeDevicePixelRatio(0)).toBe(1)
    expect(sanitizeDevicePixelRatio(-2)).toBe(1)
    expect(sanitizeDevicePixelRatio(Number.NaN)).toBe(1)
    expect(sanitizeDevicePixelRatio(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('computeCanvasPixelSize(RND-U2)', () => {
  it('CSS サイズに devicePixelRatio を掛けた整数サイズになる', () => {
    expect(computeCanvasPixelSize({ width: 400, height: 800 }, 2)).toEqual({
      width: 800,
      height: 1600,
    })
    expect(computeCanvasPixelSize({ width: 100, height: 200 }, 1.5)).toEqual({
      width: 150,
      height: 300,
    })
    expect(computeCanvasPixelSize({ width: 400, height: 800 }, 1)).toEqual({
      width: 400,
      height: 800,
    })
  })

  it('結果は整数になる', () => {
    const size = computeCanvasPixelSize({ width: 333.3, height: 777.7 }, 2.625)
    expect(Number.isInteger(size.width)).toBe(true)
    expect(Number.isInteger(size.height)).toBe(true)
  })

  it('長辺が上限を超える場合は、縦横比を保って縮める', () => {
    // 4000 × 8000 → 長辺 8000 を 4096 に縮める → 2048 × 4096
    const size = computeCanvasPixelSize({ width: 2000, height: 4000 }, 2)
    expect(size).toEqual({ width: 2048, height: MAX_CANVAS_DIMENSION })
  })

  it('上限を引数で指定できる', () => {
    expect(computeCanvasPixelSize({ width: 100, height: 100 }, 1, 50)).toEqual({
      width: 50,
      height: 50,
    })
  })

  it('上限を超えない場合は縮めない', () => {
    expect(computeCanvasPixelSize({ width: 100, height: 100 }, 1, 100)).toEqual({
      width: 100,
      height: 100,
    })
  })

  it('極端に小さいサイズでも、1 以上になる', () => {
    expect(computeCanvasPixelSize({ width: 0.1, height: 0.1 }, 1)).toEqual({
      width: 1,
      height: 1,
    })
  })

  it('無効な devicePixelRatio は 1 として扱う', () => {
    expect(computeCanvasPixelSize({ width: 400, height: 800 }, Number.NaN)).toEqual({
      width: 400,
      height: 800,
    })
  })

  it('表示サイズが 0 以下のときは 0 を返す', () => {
    const zero = { width: 0, height: 0 }
    expect(computeCanvasPixelSize({ width: 0, height: 800 }, 2)).toEqual(zero)
    expect(computeCanvasPixelSize({ width: 400, height: -1 }, 2)).toEqual(zero)
    expect(computeCanvasPixelSize({ width: Number.NaN, height: 800 }, 2)).toEqual(zero)
  })
})