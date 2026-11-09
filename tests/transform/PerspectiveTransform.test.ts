import { describe, expect, it } from 'vitest'
import { IDENTITY_MAT3, createTrsMatrix, transformPoint } from '../../src/transform/matrix.ts'
import type { Mat3 } from '../../src/transform/matrix.ts'
import {
  MAX_PERSPECTIVE_STRENGTH,
  clampSlider,
  composeProjection,
  cornersFromSliders,
  createPerspectiveFromSliders,
  findNearestCornerIndex,
  isValidQuad,
  moveCorner,
  moveCornerInState,
  normalizePerspectiveState,
  validateQuad,
} from '../../src/transform/PerspectiveTransform.ts'
import type { QuadInvalidReason } from '../../src/transform/PerspectiveTransform.ts'
import type { Point2D } from '../../src/types/geometry.ts'
import {
  CORNER_INDICES,
  DEFAULT_PERSPECTIVE_STATE,
  UNIT_QUAD,
  isCornerIndex,
} from '../../src/types/perspective.ts'
import type { Quad } from '../../src/types/perspective.ts'

/** 座標・行列要素の許容誤差(小数点以下の桁数)。誤差 5×10⁻⁷ 未満。 */
const DIGITS = 6

function quadOf(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): Quad {
  return [
    { x: a[0], y: a[1] },
    { x: b[0], y: b[1] },
    { x: c[0], y: c[1] },
    { x: d[0], y: d[1] },
  ]
}

function expectPoint(actual: Point2D | null, x: number, y: number): void {
  expect(actual).not.toBeNull()
  if (actual === null) {
    return
  }
  expect(actual.x).toBeCloseTo(x, DIGITS)
  expect(actual.y).toBeCloseTo(y, DIGITS)
}

function expectQuadCloseTo(actual: Quad, expected: Quad): void {
  for (const i of CORNER_INDICES) {
    expect(actual[i].x).toBeCloseTo(expected[i].x, DIGITS)
    expect(actual[i].y).toBeCloseTo(expected[i].y, DIGITS)
  }
}

function expectMatrixCloseTo(actual: Mat3, expected: Mat3): void {
  for (let i = 0; i < 9; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] ?? Number.NaN, DIGITS)
  }
}

const TRAPEZOID = quadOf([-0.4, -0.5], [0.4, -0.5], [0.5, 0.5], [-0.5, 0.5])

describe('validateQuad:有効な四角形', () => {
  it('単位矩形は有効', () => {
    expect(validateQuad(UNIT_QUAD)).toEqual({ ok: true })
  })

  it('台形は有効', () => {
    expect(validateQuad(TRAPEZOID)).toEqual({ ok: true })
  })

  it('画像が画面外にはみ出すほど大きい四角形も有効', () => {
    const large = quadOf([-5, -5], [5, -5], [5, 5], [-5, 5])
    expect(validateQuad(large)).toEqual({ ok: true })
  })
})

describe('validateQuad:無効な四角形の検出', () => {
  it.each<[string, Quad, QuadInvalidReason]>([
    [
      'NaN を含む',
      quadOf([-0.5, -0.5], [0.5, Number.NaN], [0.5, 0.5], [-0.5, 0.5]),
      'non-finite',
    ],
    [
      '無限大を含む',
      quadOf([Number.POSITIVE_INFINITY, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]),
      'non-finite',
    ],
    [
      '座標が大きすぎる',
      quadOf([-0.5, -0.5], [21, -0.5], [0.5, 0.5], [-0.5, 0.5]),
      'out-of-range',
    ],
    [
      '頂点がほぼ重なっている(辺が 0.05 未満)',
      quadOf([-0.5, -0.5], [-0.49, -0.5], [0.5, 0.5], [-0.5, 0.5]),
      'coincident-vertices',
    ],
    [
      '対辺が交差している(蝶ネクタイ)',
      quadOf([-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]),
      'self-intersecting',
    ],
    [
      '凹形状(頂点が内側へ入り込んでいる)',
      quadOf([-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [0.3, -0.2]),
      'concave',
    ],
    [
      '頂点の順序が逆(反時計回り)',
      quadOf([-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]),
      'reversed',
    ],
    [
      '左右を鏡映した四隅(頂点の順序が逆になる)',
      quadOf([0.5, -0.5], [-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]),
      'reversed',
    ],
    [
      'ほぼ一直線の角がある(角の sin が 0.1 未満)',
      quadOf([-1, -0.5], [0, -0.52], [1, -0.5], [0, 0.5]),
      'sharp-corner',
    ],
    [
      '面積が小さすぎる(0.02 未満)',
      quadOf([-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]),
      'too-small',
    ],
  ])('%s', (_label, quad, reason) => {
    expect(validateQuad(quad)).toEqual({ ok: false, reason })
    expect(isValidQuad(quad)).toBe(false)
  })

  it('3 点が一直線に並ぶ四角形は無効(ホモグラフィとして成立しない)', () => {
    const collinear = quadOf([-0.5, -0.5], [0, -0.5], [0.5, -0.5], [-0.5, 0.5])
    expect(isValidQuad(collinear)).toBe(false)
  })
})

describe('clampSlider', () => {
  it('範囲内の値はそのまま返す', () => {
    expect(clampSlider(0.3)).toBe(0.3)
    expect(clampSlider(-0.7)).toBe(-0.7)
  })

  it('-1〜1 に収める', () => {
    expect(clampSlider(5)).toBe(1)
    expect(clampSlider(-5)).toBe(-1)
  })

  it('有限でない値は 0', () => {
    expect(clampSlider(Number.NaN)).toBe(0)
    expect(clampSlider(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('cornersFromSliders:スライダーから四隅への変換', () => {
  it('両方 0 のとき、単位矩形になる', () => {
    expect(cornersFromSliders(0, 0)).toEqual(UNIT_QUAD)
  })

  it('横方向 +1:左辺が高く(×1.4)、右辺が低く(×0.6)なる', () => {
    expectQuadCloseTo(
      cornersFromSliders(1, 0),
      quadOf([-0.5, -0.7], [0.5, -0.3], [0.5, 0.3], [-0.5, 0.7]),
    )
  })

  it('横方向 -1:右辺が高く、左辺が低くなる(+1 の鏡映)', () => {
    expectQuadCloseTo(
      cornersFromSliders(-1, 0),
      quadOf([-0.5, -0.3], [0.5, -0.7], [0.5, 0.7], [-0.5, 0.3]),
    )
  })

  it('縦方向 +1:上辺が広く(×1.4)、下辺が狭く(×0.6)なる', () => {
    expectQuadCloseTo(
      cornersFromSliders(0, 1),
      quadOf([-0.7, -0.5], [0.7, -0.5], [0.3, 0.5], [-0.3, 0.5]),
    )
  })

  it('縦方向 -1:下辺が広く、上辺が狭くなる', () => {
    expectQuadCloseTo(
      cornersFromSliders(0, -1),
      quadOf([-0.3, -0.5], [0.3, -0.5], [0.7, 0.5], [-0.7, 0.5]),
    )
  })

  it('両方 +1:横と縦の変形が合成される', () => {
    expectQuadCloseTo(
      cornersFromSliders(1, 1),
      quadOf([-0.7, -0.7], [0.7, -0.3], [0.3, 0.3], [-0.3, 0.7]),
    )
  })

  it('強さの定数に基づく', () => {
    const quad = cornersFromSliders(1, 0)
    expect(quad[0].y).toBeCloseTo(-0.5 * (1 + MAX_PERSPECTIVE_STRENGTH), DIGITS)
    expect(quad[1].y).toBeCloseTo(-0.5 * (1 - MAX_PERSPECTIVE_STRENGTH), DIGITS)
  })

  it('範囲外の値は -1〜1 に収められる', () => {
    expect(cornersFromSliders(5, -5)).toEqual(cornersFromSliders(1, -1))
  })

  it('有限でない値は 0 として扱われる', () => {
    expect(cornersFromSliders(Number.NaN, Number.NaN)).toEqual(UNIT_QUAD)
  })

  it('スライダーの全範囲の組み合わせで、常に有効な凸四角形になる', () => {
    const values = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
    for (const horizontal of values) {
      for (const vertical of values) {
        const quad = cornersFromSliders(horizontal, vertical)
        expect(validateQuad(quad), `h=${horizontal}, v=${vertical}`).toEqual({ ok: true })
      }
    }
  })
})

describe('createPerspectiveFromSliders / normalizePerspectiveState', () => {
  it('スライダーの値と、そこから計算した四隅を持つ状態を作る', () => {
    const state = createPerspectiveFromSliders(0.5, -0.25)
    expect(state.horizontal).toBe(0.5)
    expect(state.vertical).toBe(-0.25)
    expectQuadCloseTo(state.corners, cornersFromSliders(0.5, -0.25))
  })

  it('範囲外の値は、スライダーの値も -1〜1 に収められる', () => {
    const state = createPerspectiveFromSliders(2, -3)
    expect(state.horizontal).toBe(1)
    expect(state.vertical).toBe(-1)
  })

  it('両方 0 で、変形なしの四隅になる', () => {
    expect(createPerspectiveFromSliders(0, 0).corners).toEqual(UNIT_QUAD)
  })

  it('normalize:有効な状態の四隅は、そのまま維持する', () => {
    const state = createPerspectiveFromSliders(0.3, 0.2)
    const normalized = normalizePerspectiveState(state)
    expect(normalized.corners).toBe(state.corners)
    expect(normalized.horizontal).toBe(0.3)
    expect(normalized.vertical).toBe(0.2)
  })

  it('normalize:スライダーの値を -1〜1 に収める', () => {
    const normalized = normalizePerspectiveState({
      corners: UNIT_QUAD,
      horizontal: 5,
      vertical: -5,
    })
    expect(normalized.horizontal).toBe(1)
    expect(normalized.vertical).toBe(-1)
    expect(normalized.corners).toBe(UNIT_QUAD)
  })

  it('normalize:四隅が無効なら、初期状態に戻す', () => {
    const invalid = {
      corners: quadOf([-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]),
      horizontal: 0.4,
      vertical: 0.4,
    }
    expect(normalizePerspectiveState(invalid)).toBe(DEFAULT_PERSPECTIVE_STATE)
  })
})

describe('moveCorner:四隅の個別移動', () => {
  it('有効な位置なら、その頂点だけが目標位置へ動く', () => {
    const moved = moveCorner(UNIT_QUAD, 0, { x: -0.6, y: -0.4 })
    expect(moved[0]).toEqual({ x: -0.6, y: -0.4 })
    expect(moved[1]).toBe(UNIT_QUAD[1])
    expect(moved[2]).toBe(UNIT_QUAD[2])
    expect(moved[3]).toBe(UNIT_QUAD[3])
  })

  it('4 つの頂点のどれでも、指定した頂点だけが動く', () => {
    for (const i of CORNER_INDICES) {
      const from = UNIT_QUAD[i]
      const target = { x: from.x * 1.2, y: from.y * 1.2 }
      const moved = moveCorner(UNIT_QUAD, i, target)
      expect(moved[i]).toEqual(target)
      for (const j of CORNER_INDICES) {
        if (j !== i) {
          expect(moved[j]).toBe(UNIT_QUAD[j])
        }
      }
    }
  })

  it('目標が有限でない場合は、四隅を変えない', () => {
    expect(moveCorner(UNIT_QUAD, 0, { x: Number.NaN, y: 0 })).toBe(UNIT_QUAD)
    expect(moveCorner(UNIT_QUAD, 2, { x: 0, y: Number.POSITIVE_INFINITY })).toBe(UNIT_QUAD)
  })

  it('現在の四隅がすでに無効な場合は、四隅を変えない', () => {
    const invalid = quadOf([-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5])
    expect(moveCorner(invalid, 0, { x: -0.6, y: -0.6 })).toBe(invalid)
  })

  it('反対側の頂点に近づきすぎる位置へは、手前の境界で止まる', () => {
    // 左上を、右上の向こうへ水平に動かす。辺が 0.05 未満になる x = 0.45 が境界。
    const moved = moveCorner(UNIT_QUAD, 0, { x: 2, y: -0.5 })
    expect(isValidQuad(moved)).toBe(true)
    expect(moved[0].y).toBeCloseTo(-0.5, 9)
    expect(moved[0].x).toBeGreaterThan(0.449)
    expect(moved[0].x).toBeLessThanOrEqual(0.45 + 1e-9)
  })

  it('凹形状になる位置へは、手前で止まる(裏返らない)', () => {
    // 右下を、左上の方向へ(対角線を越えるように)動かす。
    const moved = moveCorner(UNIT_QUAD, 2, { x: -0.2, y: -0.2 })
    expect(isValidQuad(moved)).toBe(true)
    // 一直線(対角線上、x = y = 0)に達する手前で止まる。
    expect(moved[2].x).toBeGreaterThan(0)
    expect(moved[2].x).toBeLessThan(0.1)
    expect(moved[2].y).toBeCloseTo(moved[2].x, 9)
  })

  it('極端に遠い目標でも、有効な四隅を返し、座標が有限になる', () => {
    const moved = moveCorner(UNIT_QUAD, 2, { x: 1e9, y: 1e9 })
    expect(isValidQuad(moved)).toBe(true)
    expect(Number.isFinite(moved[2].x)).toBe(true)
    expect(Number.isFinite(moved[2].y)).toBe(true)
    // 動けるところまでは動く。
    expect(moved[2].x).toBeGreaterThan(1)
  })
})

describe('moveCornerInState', () => {
  it('スライダーの値は変えず、指定した頂点だけを動かす', () => {
    const state = createPerspectiveFromSliders(0.3, -0.2)
    const moved = moveCornerInState(state, 0, { x: -0.5, y: -0.55 })
    expect(moved.horizontal).toBe(0.3)
    expect(moved.vertical).toBe(-0.2)
    expect(moved.corners[0]).toEqual({ x: -0.5, y: -0.55 })
    expect(moved.corners[1]).toBe(state.corners[1])
  })

  it('位置が変わらない場合は、同じ状態のオブジェクトを返す', () => {
    const moved = moveCornerInState(DEFAULT_PERSPECTIVE_STATE, 0, { x: -0.5, y: -0.5 })
    expect(moved).toBe(DEFAULT_PERSPECTIVE_STATE)
  })

  it('目標が有限でない場合は、同じ状態のオブジェクトを返す', () => {
    const moved = moveCornerInState(DEFAULT_PERSPECTIVE_STATE, 1, { x: Number.NaN, y: 0 })
    expect(moved).toBe(DEFAULT_PERSPECTIVE_STATE)
  })
})

describe('findNearestCornerIndex:ハンドルの最近傍の選択', () => {
  const screen = quadOf([100, 100], [300, 100], [300, 300], [100, 300])

  it('半径内にある、最も近い頂点を返す', () => {
    expect(findNearestCornerIndex(screen, { x: 105, y: 98 }, 28)).toBe(0)
    expect(findNearestCornerIndex(screen, { x: 295, y: 103 }, 28)).toBe(1)
    expect(findNearestCornerIndex(screen, { x: 295, y: 305 }, 28)).toBe(2)
    expect(findNearestCornerIndex(screen, { x: 90, y: 310 }, 28)).toBe(3)
  })

  it('どの頂点も半径外なら null', () => {
    expect(findNearestCornerIndex(screen, { x: 200, y: 200 }, 28)).toBeNull()
  })

  it('距離がちょうど半径のときは、選ばれる(半径は含む)', () => {
    expect(findNearestCornerIndex(screen, { x: 128, y: 100 }, 28)).toBe(0)
  })

  it('半径をわずかに超えると、選ばれない', () => {
    expect(findNearestCornerIndex(screen, { x: 128.5, y: 100 }, 28)).toBeNull()
  })

  it('頂点が近接していても、より近いほうを選ぶ', () => {
    const close = quadOf([100, 100], [112, 100], [300, 300], [100, 300])
    expect(findNearestCornerIndex(close, { x: 109, y: 100 }, 28)).toBe(1)
    expect(findNearestCornerIndex(close, { x: 103, y: 100 }, 28)).toBe(0)
  })

  it('距離が同じなら、番号の小さいほうを選ぶ', () => {
    const close = quadOf([100, 100], [112, 100], [300, 300], [100, 300])
    expect(findNearestCornerIndex(close, { x: 106, y: 100 }, 28)).toBe(0)
  })
})

describe('composeProjection:P = Base · H', () => {
  it('基本変形が単位行列で、四隅が単位矩形なら、単位行列になる', () => {
    const projection = composeProjection(IDENTITY_MAT3, UNIT_QUAD)
    expect(projection).not.toBeNull()
    if (projection !== null) {
      expectMatrixCloseTo(projection, IDENTITY_MAT3)
    }
  })

  it('四隅が単位矩形のときは、基本変形そのもの(アフィン)になる', () => {
    const base = createTrsMatrix(200, 400, 0, 300, 150)
    const projection = composeProjection(base, UNIT_QUAD)
    expect(projection).not.toBeNull()
    if (projection === null) {
      return
    }
    expectPoint(transformPoint(projection, { x: 0.5, y: 0.5 }), 350, 475)
    expectPoint(transformPoint(projection, { x: -0.5, y: -0.5 }), 50, 325)
    expect(Math.abs(projection[2])).toBeLessThan(1e-9)
    expect(Math.abs(projection[5])).toBeLessThan(1e-9)
  })

  it('単位矩形の四隅を、基本変形を適用した四隅に写す(H が先、Base が後)', () => {
    const base = createTrsMatrix(200, 400, Math.PI / 6, 300, 150)
    const projection = composeProjection(base, TRAPEZOID)
    expect(projection).not.toBeNull()
    if (projection === null) {
      return
    }
    for (const i of CORNER_INDICES) {
      const expected = transformPoint(base, TRAPEZOID[i])
      expect(expected).not.toBeNull()
      if (expected === null) {
        continue
      }
      expectPoint(transformPoint(projection, UNIT_QUAD[i]), expected.x, expected.y)
    }
  })

  it('ホモグラフィを求められない四隅では null', () => {
    const point = quadOf([0, 0], [0, 0], [0, 0], [0, 0])
    expect(composeProjection(IDENTITY_MAT3, point)).toBeNull()
  })
})

describe('isCornerIndex', () => {
  it('0〜3 だけが、頂点の番号として有効', () => {
    for (const value of [0, 1, 2, 3]) {
      expect(isCornerIndex(value)).toBe(true)
    }
    for (const value of [-1, 4, 0.5, Number.NaN]) {
      expect(isCornerIndex(value)).toBe(false)
    }
  })
})