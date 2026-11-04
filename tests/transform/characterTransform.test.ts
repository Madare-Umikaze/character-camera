import { describe, expect, it } from 'vitest'
import {
  BASE_FILL_RATIO,
  MAX_POSITION_OFFSET,
  MAX_SCALE,
  MIN_PINCH_DISTANCE,
  MIN_SCALE,
  applyPinch,
  buildCharacterMatrix,
  clamp,
  computeBaseSize,
  degreesToRadians,
  normalizeAngle,
  normalizeCharacterState,
  panBy,
  radiansToDegrees,
  transformAround,
  wheelZoomFactor,
  withOpacity,
  withRotation,
  withVisible,
  zoomAt,
} from '../../src/transform/characterTransform.ts'
import { transformPoint } from '../../src/transform/matrix.ts'
import { DEFAULT_CHARACTER_STATE } from '../../src/types/character.ts'
import type { CharacterImageState } from '../../src/types/character.ts'
import type { Point2D, Size2D } from '../../src/types/geometry.ts'

/** 基準のプレビューサイズ(幅 400、高さ 800)。 */
const VIEWPORT: Size2D = { width: 400, height: 800 }
/** 基準の画像サイズ(幅 100、高さ 50)。scale = 1 のとき 200×100 で表示される。 */
const IMAGE: Size2D = { width: 100, height: 50 }

function makeState(partial: Partial<CharacterImageState>): CharacterImageState {
  return { ...DEFAULT_CHARACTER_STATE, ...partial }
}

function expectPoint(actual: Point2D | null, x: number, y: number): void {
  expect(actual).not.toBeNull()
  if (actual === null) {
    return
  }
  expect(actual.x).toBeCloseTo(x, 6)
  expect(actual.y).toBeCloseTo(y, 6)
}

describe('定数', () => {
  it('scale の範囲と位置の範囲が妥当', () => {
    expect(MIN_SCALE).toBeGreaterThan(0)
    expect(MIN_SCALE).toBeLessThan(1)
    expect(MAX_SCALE).toBeGreaterThan(1)
    expect(MAX_POSITION_OFFSET).toBe(0.5)
    expect(BASE_FILL_RATIO).toBe(0.5)
    expect(MIN_PINCH_DISTANCE).toBeGreaterThan(0)
  })
})

describe('clamp', () => {
  it('範囲内の値はそのまま返す', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('範囲外の値は端に収める', () => {
    expect(clamp(-3, 0, 10)).toBe(0)
    expect(clamp(42, 0, 10)).toBe(10)
  })
})

describe('normalizeAngle', () => {
  it.each<[string, number, number]>([
    ['0', 0, 0],
    ['π/2', Math.PI / 2, Math.PI / 2],
    ['π はそのまま', Math.PI, Math.PI],
    ['-π は π になる(-π は範囲外)', -Math.PI, Math.PI],
    ['3π/2 は -π/2', (3 * Math.PI) / 2, -Math.PI / 2],
    ['-3π/2 は π/2', (-3 * Math.PI) / 2, Math.PI / 2],
    ['2π は 0', Math.PI * 2, 0],
    ['-2π は 0', -Math.PI * 2, 0],
    ['5π は π', Math.PI * 5, Math.PI],
  ])('%s', (_label, input, expected) => {
    expect(normalizeAngle(input)).toBeCloseTo(expected, 9)
  })

  it('NaN と無限大は 0 になる', () => {
    expect(normalizeAngle(Number.NaN)).toBe(0)
    expect(normalizeAngle(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeAngle(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('角度の単位変換', () => {
  it('度とラジアンを相互に変換できる', () => {
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI, 9)
    expect(degreesToRadians(90)).toBeCloseTo(Math.PI / 2, 9)
    expect(radiansToDegrees(Math.PI)).toBeCloseTo(180, 9)
    expect(radiansToDegrees(degreesToRadians(37))).toBeCloseTo(37, 9)
  })
})

describe('normalizeCharacterState(TRF-U13)', () => {
  it('範囲内の状態は変わらない', () => {
    const state = makeState({
      x: 0.1,
      y: -0.2,
      scale: 2,
      rotation: 0.5,
      opacity: 0.7,
      visible: false,
    })
    expect(normalizeCharacterState(state)).toEqual(state)
  })

  it('位置を範囲内に収める', () => {
    const result = normalizeCharacterState(makeState({ x: 3, y: -3 }))
    expect(result.x).toBe(MAX_POSITION_OFFSET)
    expect(result.y).toBe(-MAX_POSITION_OFFSET)
  })

  it('scale を範囲内に収める', () => {
    expect(normalizeCharacterState(makeState({ scale: 0.001 })).scale).toBe(MIN_SCALE)
    expect(normalizeCharacterState(makeState({ scale: 100 })).scale).toBe(MAX_SCALE)
  })

  it('不透明度を 0〜1 に収める', () => {
    expect(normalizeCharacterState(makeState({ opacity: 2 })).opacity).toBe(1)
    expect(normalizeCharacterState(makeState({ opacity: -1 })).opacity).toBe(0)
  })

  it('回転を -π より大きく π 以下に収める', () => {
    const result = normalizeCharacterState(makeState({ rotation: (3 * Math.PI) / 2 }))
    expect(result.rotation).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('NaN は初期値に置き換える', () => {
    const result = normalizeCharacterState(
      makeState({
        x: Number.NaN,
        y: Number.NaN,
        scale: Number.NaN,
        rotation: Number.NaN,
        opacity: Number.NaN,
      }),
    )
    expect(result).toEqual(DEFAULT_CHARACTER_STATE)
  })

  it('無限大は初期値に置き換える', () => {
    const result = normalizeCharacterState(
      makeState({ x: Number.POSITIVE_INFINITY, scale: Number.NEGATIVE_INFINITY }),
    )
    expect(result.x).toBe(DEFAULT_CHARACTER_STATE.x)
    expect(result.scale).toBe(DEFAULT_CHARACTER_STATE.scale)
  })

  it('visible は変更しない', () => {
    expect(normalizeCharacterState(makeState({ visible: false })).visible).toBe(false)
  })
})

describe('with 系のヘルパー', () => {
  it('withOpacity は不透明度だけを変え、範囲に収める', () => {
    const state = makeState({ x: 0.2, scale: 2 })
    const result = withOpacity(state, 0.4)
    expect(result.opacity).toBe(0.4)
    expect(result.x).toBe(0.2)
    expect(result.scale).toBe(2)
    expect(withOpacity(state, 5).opacity).toBe(1)
  })

  it('withRotation は回転だけを変え、範囲に収める', () => {
    const state = makeState({ x: 0.2 })
    expect(withRotation(state, 1).rotation).toBe(1)
    expect(withRotation(state, 1).x).toBe(0.2)
    expect(withRotation(state, Math.PI * 2).rotation).toBeCloseTo(0, 9)
  })

  it('withVisible は表示だけを変える', () => {
    const state = makeState({ scale: 3 })
    const hidden = withVisible(state, false)
    expect(hidden.visible).toBe(false)
    expect(hidden.scale).toBe(3)
    expect(withVisible(hidden, true).visible).toBe(true)
  })

  it('元の状態を書き換えない', () => {
    const state = makeState({ opacity: 0.5 })
    withOpacity(state, 0.9)
    withRotation(state, 1)
    withVisible(state, false)
    expect(state.opacity).toBe(0.5)
    expect(state.rotation).toBe(0)
    expect(state.visible).toBe(true)
  })
})

describe('computeBaseSize', () => {
  it('プレビューの 50% 以内に収まる大きさになる(横長の画像)', () => {
    // fit = min(400·0.5/200, 800·0.5/100) = min(1, 4) = 1
    expect(computeBaseSize({ width: 200, height: 100 }, VIEWPORT)).toEqual({
      width: 200,
      height: 100,
    })
  })

  it('縦長の画像でも収まる', () => {
    // fit = min(200/100, 400/400) = 1
    expect(computeBaseSize({ width: 100, height: 400 }, VIEWPORT)).toEqual({
      width: 100,
      height: 400,
    })
  })

  it('小さい画像は拡大して基準サイズにする', () => {
    // fit = min(200/10, 400/10) = 20
    expect(computeBaseSize({ width: 10, height: 10 }, VIEWPORT)).toEqual({
      width: 200,
      height: 200,
    })
  })

  it('縦横比を保つ', () => {
    const size = computeBaseSize({ width: 123, height: 45 }, VIEWPORT)
    expect(size.width / size.height).toBeCloseTo(123 / 45, 9)
  })

  it('画像またはプレビューのサイズが 0 以下なら 0 を返す', () => {
    const zero = { width: 0, height: 0 }
    expect(computeBaseSize({ width: 0, height: 10 }, VIEWPORT)).toEqual(zero)
    expect(computeBaseSize({ width: 10, height: -1 }, VIEWPORT)).toEqual(zero)
    expect(computeBaseSize(IMAGE, { width: 0, height: 800 })).toEqual(zero)
    expect(computeBaseSize(IMAGE, { width: 400, height: 0 })).toEqual(zero)
  })
})

describe('buildCharacterMatrix', () => {
  // 画像 100×50 のとき、基準サイズは 200×100(fit = min(200/100, 400/50) = 2)。
  it('初期状態では、単位矩形の中心がプレビューの中心に来る', () => {
    const m = buildCharacterMatrix(DEFAULT_CHARACTER_STATE, IMAGE, VIEWPORT)
    expectPoint(transformPoint(m, { x: 0, y: 0 }), 200, 400)
  })

  it('初期状態では、単位矩形の四隅が基準サイズの矩形に写る', () => {
    const m = buildCharacterMatrix(DEFAULT_CHARACTER_STATE, IMAGE, VIEWPORT)
    expectPoint(transformPoint(m, { x: -0.5, y: -0.5 }), 100, 350)
    expectPoint(transformPoint(m, { x: 0.5, y: 0.5 }), 300, 450)
  })

  it('scale を反映する', () => {
    const m = buildCharacterMatrix(makeState({ scale: 2 }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(m, { x: 0.5, y: 0.5 }), 400, 500)
    expectPoint(transformPoint(m, { x: -0.5, y: -0.5 }), 0, 300)
  })

  it('位置(割合)を反映する', () => {
    // x = 0.25 → 400 × 0.25 = 100 右へ、y = -0.125 → 800 × 0.125 = 100 上へ
    const m = buildCharacterMatrix(makeState({ x: 0.25, y: -0.125 }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(m, { x: 0, y: 0 }), 300, 300)
  })

  it('回転を反映する(中心を軸に +90°)', () => {
    // (0.5, 0) → 拡大縮小 (100, 0) → 回転 (0, 100) → 平行移動 (200, 500)
    const m = buildCharacterMatrix(makeState({ rotation: Math.PI / 2 }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(m, { x: 0.5, y: 0 }), 200, 500)
  })

  it('範囲外の状態は正規化してから使う', () => {
    // scale 100 は 6 に収まる。(0.5, 0.5) → (200 + 0.5·200·6, 400 + 0.5·100·6)
    const m = buildCharacterMatrix(makeState({ scale: 100 }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(m, { x: 0.5, y: 0.5 }), 800, 700)
  })
})

describe('panBy', () => {
  it('移動量(CSS ピクセル)を、プレビューに対する割合として加える', () => {
    const result = panBy(DEFAULT_CHARACTER_STATE, 40, -80, VIEWPORT)
    expect(result.x).toBeCloseTo(0.1, 9)
    expect(result.y).toBeCloseTo(-0.1, 9)
  })

  it('移動を重ねると加算される', () => {
    const once = panBy(DEFAULT_CHARACTER_STATE, 40, 0, VIEWPORT)
    const twice = panBy(once, 40, 0, VIEWPORT)
    expect(twice.x).toBeCloseTo(0.2, 9)
  })

  it('画像の中心がプレビュー内に収まるよう制限される', () => {
    const result = panBy(DEFAULT_CHARACTER_STATE, 100000, -100000, VIEWPORT)
    expect(result.x).toBe(MAX_POSITION_OFFSET)
    expect(result.y).toBe(-MAX_POSITION_OFFSET)
  })

  it('移動以外の値は変えない', () => {
    const state = makeState({ scale: 2, rotation: 1, opacity: 0.3, visible: false })
    const result = panBy(state, 10, 10, VIEWPORT)
    expect(result.scale).toBe(2)
    expect(result.rotation).toBeCloseTo(1, 9)
    expect(result.opacity).toBe(0.3)
    expect(result.visible).toBe(false)
  })

  it('プレビューのサイズが 0 のときは、状態をそのまま返す', () => {
    expect(panBy(DEFAULT_CHARACTER_STATE, 10, 10, { width: 0, height: 800 })).toBe(
      DEFAULT_CHARACTER_STATE,
    )
  })
})

describe('transformAround', () => {
  it('アンカーが動かず、変化なしなら、状態は変わらない', () => {
    const anchor = { x: 123, y: 456 }
    const result = transformAround(DEFAULT_CHARACTER_STATE, anchor, anchor, 1, 0, VIEWPORT)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
    expect(result.scale).toBeCloseTo(1, 9)
    expect(result.rotation).toBeCloseTo(0, 9)
  })

  it('アンカーの移動だけなら、平行移動になる', () => {
    // 中心 (200, 400) とアンカー (100, 100) のずれを保ったまま、アンカーを (150, 120) へ動かす。
    // 新しい中心 = (150 + 100, 120 + 300) = (250, 420)
    const result = transformAround(
      DEFAULT_CHARACTER_STATE,
      { x: 100, y: 100 },
      { x: 150, y: 120 },
      1,
      0,
      VIEWPORT,
    )
    expect(result.x).toBeCloseTo(0.125, 9)
    expect(result.y).toBeCloseTo(0.025, 9)
  })

  it('画像の中心をアンカーにして拡大すると、位置は変わらない', () => {
    const center = { x: 200, y: 400 }
    const result = transformAround(DEFAULT_CHARACTER_STATE, center, center, 2, 0, VIEWPORT)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
    expect(result.scale).toBeCloseTo(2, 9)
  })

  it('中心以外をアンカーにして拡大すると、アンカーの下の点が固定される', () => {
    // アンカー (300, 400)。中心 (200, 400) までのベクトル (-100, 0) が 2 倍になり、
    // 新しい中心は (300 - 200, 400) = (100, 400)。x = (100 - 200) / 400 = -0.25
    const anchor = { x: 300, y: 400 }
    const result = transformAround(DEFAULT_CHARACTER_STATE, anchor, anchor, 2, 0, VIEWPORT)
    expect(result.x).toBeCloseTo(-0.25, 9)
    expect(result.y).toBeCloseTo(0, 9)
    expect(result.scale).toBeCloseTo(2, 9)
  })

  it('アンカーを軸に回転すると、中心がアンカーの周りを回る', () => {
    // アンカー (300, 400)、中心までのベクトル (-100, 0) を +90°(時計回り)回すと (0, -100)。
    // 新しい中心 = (300, 300)。x = (300 - 200) / 400 = 0.25、y = (300 - 400) / 800 = -0.125
    const anchor = { x: 300, y: 400 }
    const result = transformAround(
      DEFAULT_CHARACTER_STATE,
      anchor,
      anchor,
      1,
      Math.PI / 2,
      VIEWPORT,
    )
    expect(result.x).toBeCloseTo(0.25, 9)
    expect(result.y).toBeCloseTo(-0.125, 9)
    expect(result.rotation).toBeCloseTo(Math.PI / 2, 9)
  })

  it('回転は累積し、-π〜π に正規化される', () => {
    const anchor = { x: 200, y: 400 }
    const result = transformAround(makeState({ rotation: 3 }), anchor, anchor, 1, 1, VIEWPORT)
    expect(result.rotation).toBeCloseTo(4 - Math.PI * 2, 9)
  })

  it('scale が上限で止まっても、位置は実際の倍率で計算される', () => {
    // すでに上限。さらに 2 倍にしようとしても、倍率は変わらず、中心も動かない。
    const anchor = { x: 300, y: 400 }
    const result = transformAround(
      makeState({ scale: MAX_SCALE }),
      anchor,
      anchor,
      2,
      0,
      VIEWPORT,
    )
    expect(result.scale).toBe(MAX_SCALE)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
  })

  it('scale が下限で止まっても、中心は動かない', () => {
    const anchor = { x: 300, y: 400 }
    const result = transformAround(
      makeState({ scale: MIN_SCALE }),
      anchor,
      anchor,
      0.5,
      0,
      VIEWPORT,
    )
    expect(result.scale).toBe(MIN_SCALE)
    expect(result.x).toBeCloseTo(0, 9)
  })

  it('倍率や回転が NaN のときは、変化なしとして扱う', () => {
    const anchor = { x: 300, y: 400 }
    const result = transformAround(
      DEFAULT_CHARACTER_STATE,
      anchor,
      anchor,
      Number.NaN,
      Number.NaN,
      VIEWPORT,
    )
    expect(result.scale).toBeCloseTo(1, 9)
    expect(result.rotation).toBeCloseTo(0, 9)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
  })

  it('位置は、中心がプレビュー内に収まるよう制限される', () => {
    const result = transformAround(
      DEFAULT_CHARACTER_STATE,
      { x: 0, y: 0 },
      { x: 100000, y: 100000 },
      1,
      0,
      VIEWPORT,
    )
    expect(result.x).toBe(MAX_POSITION_OFFSET)
    expect(result.y).toBe(MAX_POSITION_OFFSET)
  })

  it('プレビューのサイズが 0 のときは、状態をそのまま返す', () => {
    const anchor = { x: 1, y: 1 }
    expect(
      transformAround(DEFAULT_CHARACTER_STATE, anchor, anchor, 2, 1, {
        width: 0,
        height: 0,
      }),
    ).toBe(DEFAULT_CHARACTER_STATE)
  })
})

describe('applyPinch', () => {
  it('指の間隔が 1.5 倍になると、scale が 1.5 倍になる', () => {
    // 中点は (200, 400) のまま。画像中心と一致するので、位置は動かない。
    const result = applyPinch(
      DEFAULT_CHARACTER_STATE,
      { a: { x: 100, y: 400 }, b: { x: 300, y: 400 } },
      { a: { x: 50, y: 400 }, b: { x: 350, y: 400 } },
      VIEWPORT,
    )
    expect(result.scale).toBeCloseTo(1.5, 9)
    expect(result.rotation).toBeCloseTo(0, 9)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
  })

  it('指の間隔が縮むと、scale が小さくなる', () => {
    const result = applyPinch(
      DEFAULT_CHARACTER_STATE,
      { a: { x: 50, y: 400 }, b: { x: 350, y: 400 } },
      { a: { x: 100, y: 400 }, b: { x: 300, y: 400 } },
      VIEWPORT,
    )
    expect(result.scale).toBeCloseTo(2 / 3, 9)
  })

  it('2 本の指の向きが 90° 変わると、rotation が +90° になる', () => {
    // 水平(角度 0)から垂直(角度 π/2)へ。間隔と中点は同じ。
    const result = applyPinch(
      DEFAULT_CHARACTER_STATE,
      { a: { x: 100, y: 400 }, b: { x: 300, y: 400 } },
      { a: { x: 200, y: 300 }, b: { x: 200, y: 500 } },
      VIEWPORT,
    )
    expect(result.rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(result.scale).toBeCloseTo(1, 9)
  })

  it('2 本の指が同じ形のまま動くと、平行移動になる', () => {
    // 中点が (200, 400) から (220, 440) へ。x = 20/400、y = 40/800
    const result = applyPinch(
      DEFAULT_CHARACTER_STATE,
      { a: { x: 100, y: 400 }, b: { x: 300, y: 400 } },
      { a: { x: 120, y: 440 }, b: { x: 320, y: 440 } },
      VIEWPORT,
    )
    expect(result.x).toBeCloseTo(0.05, 9)
    expect(result.y).toBeCloseTo(0.05, 9)
    expect(result.scale).toBeCloseTo(1, 9)
  })

  it('直前の間隔が小さすぎるときは、拡大縮小・回転を行わない', () => {
    // 直前の間隔 4px(MIN_PINCH_DISTANCE 未満)。中点は (202, 400) のまま。
    const result = applyPinch(
      DEFAULT_CHARACTER_STATE,
      { a: { x: 200, y: 400 }, b: { x: 204, y: 400 } },
      { a: { x: 190, y: 400 }, b: { x: 214, y: 400 } },
      VIEWPORT,
    )
    expect(result.scale).toBeCloseTo(1, 9)
    expect(result.rotation).toBeCloseTo(0, 9)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
  })

  it('180° をまたぐ回転でも、角度が飛ばない', () => {
    // 角度 π - 0.1 から -π + 0.1 へ。実際の変化は +0.2 であり、-2π + 0.2 ではない。
    const radius = 100
    const before = Math.PI - 0.1
    const after = -Math.PI + 0.1
    const result = applyPinch(
      DEFAULT_CHARACTER_STATE,
      {
        a: { x: 200, y: 400 },
        b: { x: 200 + radius * Math.cos(before), y: 400 + radius * Math.sin(before) },
      },
      {
        a: { x: 200, y: 400 },
        b: { x: 200 + radius * Math.cos(after), y: 400 + radius * Math.sin(after) },
      },
      VIEWPORT,
    )
    expect(result.rotation).toBeCloseTo(0.2, 6)
  })
})

describe('zoomAt', () => {
  it('画像の中心を基準に拡大すると、scale だけが変わる', () => {
    const result = zoomAt(DEFAULT_CHARACTER_STATE, 2, { x: 200, y: 400 }, VIEWPORT)
    expect(result.scale).toBeCloseTo(2, 9)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
    expect(result.rotation).toBeCloseTo(0, 9)
  })

  it('中心以外を基準にすると、アンカーの下の点が固定される', () => {
    const result = zoomAt(DEFAULT_CHARACTER_STATE, 2, { x: 300, y: 400 }, VIEWPORT)
    expect(result.x).toBeCloseTo(-0.25, 9)
  })

  it('拡大してから同じ倍率の逆数で縮小すると、元に戻る', () => {
    const anchor = { x: 250, y: 300 }
    const zoomed = zoomAt(DEFAULT_CHARACTER_STATE, 2, anchor, VIEWPORT)
    const back = zoomAt(zoomed, 0.5, anchor, VIEWPORT)
    expect(back.scale).toBeCloseTo(1, 9)
    expect(back.x).toBeCloseTo(0, 9)
    expect(back.y).toBeCloseTo(0, 9)
  })
})

describe('wheelZoomFactor', () => {
  it('動きがなければ 1', () => {
    expect(wheelZoomFactor(0)).toBe(1)
  })

  it('上スクロール(負)で拡大、下スクロール(正)で縮小', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
  })

  it('逆向きの同じ量は、掛け合わせると 1 になる', () => {
    expect(wheelZoomFactor(120) * wheelZoomFactor(-120)).toBeCloseTo(1, 9)
  })

  it('極端な値は、一定の範囲に制限される', () => {
    expect(wheelZoomFactor(100000)).toBe(wheelZoomFactor(400))
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-400))
  })

  it('NaN は変化なし(1)として扱う', () => {
    expect(wheelZoomFactor(Number.NaN)).toBe(1)
  })
})