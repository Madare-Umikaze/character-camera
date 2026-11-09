import { describe, expect, it } from 'vitest'
import {
  computeHomography,
  computeUnitSquareHomography,
  determinantMat3,
  invertHomography,
} from '../../src/transform/Homography.ts'
import type {
  HomographyFailureReason,
  HomographyResult,
} from '../../src/transform/Homography.ts'
import {
  IDENTITY_MAT3,
  createTrsMatrix,
  multiplyMat3,
  transformPoint,
} from '../../src/transform/matrix.ts'
import type { Mat3 } from '../../src/transform/matrix.ts'
import type { Point2D } from '../../src/types/geometry.ts'
import { CORNER_INDICES, UNIT_QUAD } from '../../src/types/perspective.ts'
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

function expectPoint(actual: Point2D | null, x: number, y: number, digits = DIGITS): void {
  expect(actual).not.toBeNull()
  if (actual === null) {
    return
  }
  expect(actual.x).toBeCloseTo(x, digits)
  expect(actual.y).toBeCloseTo(y, digits)
}

function expectMatrixCloseTo(actual: Mat3, expected: Mat3): void {
  for (let i = 0; i < 9; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] ?? Number.NaN, DIGITS)
  }
}

/** 計算に成功することを確認して、行列を返す。 */
function solve(source: Quad, destination: Quad): Mat3 {
  const result = computeHomography(source, destination)
  if (!result.ok) {
    throw new Error(`ホモグラフィの計算に失敗しました: ${result.reason}`)
  }
  return result.matrix
}

/** 計算に失敗することを確認して、理由を返す。 */
function failureReason(result: HomographyResult): HomographyFailureReason {
  if (result.ok) {
    throw new Error('失敗するはずの計算が成功しました')
  }
  return result.reason
}

/** 四隅がそれぞれ目的の位置に写ることを確認する。 */
function expectCornersMapped(
  matrix: Mat3,
  source: Quad,
  destination: Quad,
  digits = DIGITS,
): void {
  for (const i of CORNER_INDICES) {
    const target = destination[i]
    expectPoint(transformPoint(matrix, source[i]), target.x, target.y, digits)
  }
}

/** 四隅のすべてを、行列で変換した四隅を返す。 */
function mapQuadBy(matrix: Mat3, quad: Quad): Quad {
  const mapped = CORNER_INDICES.map((i) => {
    const p = transformPoint(matrix, quad[i])
    if (p === null) {
      throw new Error('点を変換できません')
    }
    return p
  })
  const [a, b, c, d] = mapped
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error('四隅の変換結果が不足しています')
  }
  return [a, b, c, d]
}

const TRAPEZOID = quadOf([-0.4, -0.5], [0.4, -0.5], [0.5, 0.5], [-0.5, 0.5])

describe('computeHomography:同じ四角形への変換', () => {
  it('単位矩形から単位矩形への変換は、単位行列になる', () => {
    expectMatrixCloseTo(solve(UNIT_QUAD, UNIT_QUAD), IDENTITY_MAT3)
  })

  it('任意の四角形から同じ四角形への変換も、単位行列になる', () => {
    const quad = quadOf([10, 20], [50, 25], [55, 70], [8, 66])
    expectMatrixCloseTo(solve(quad, quad), IDENTITY_MAT3)
  })

  it('computeUnitSquareHomography は、単位矩形を元にした computeHomography と一致する', () => {
    expectMatrixCloseTo(
      solveUnit(TRAPEZOID),
      solve(UNIT_QUAD, TRAPEZOID),
    )
  })
})

function solveUnit(destination: Quad): Mat3 {
  const result = computeUnitSquareHomography(destination)
  if (!result.ok) {
    throw new Error(`ホモグラフィの計算に失敗しました: ${result.reason}`)
  }
  return result.matrix
}

describe('computeHomography:アフィン変換(平行四辺形)', () => {
  it('拡大縮小と平行移動は、射影成分が 0 の行列になる', () => {
    // (-0.5,-0.5)→(1,1)、(0.5,-0.5)→(3,1)、(0.5,0.5)→(3,2):x を 2 倍、y を 1 倍、(2, 1.5) だけ移動
    const destination = quadOf([1, 1], [3, 1], [3, 2], [1, 2])
    const matrix = solve(UNIT_QUAD, destination)
    expectMatrixCloseTo(matrix, [2, 0, 0, 0, 1, 0, 2, 1.5, 1])
  })
})

describe('computeHomography:長方形から台形への変換', () => {
  const matrix = solve(UNIT_QUAD, TRAPEZOID)

  it('4 頂点が対応する位置に写る', () => {
    expectCornersMapped(matrix, UNIT_QUAD, TRAPEZOID)
  })

  it('アフィンではなく、射影成分を持つ', () => {
    expect(Math.hypot(matrix[2], matrix[5])).toBeGreaterThan(1e-3)
  })

  it('単位矩形の中心は、台形の対角線の交点 (0, -1/18) に写る', () => {
    expectPoint(transformPoint(matrix, { x: 0, y: 0 }), 0, -1 / 18)
  })

  it('左右対称の台形では、左右の点が鏡映の関係で写る', () => {
    const left = transformPoint(matrix, { x: -0.3, y: 0.2 })
    const right = transformPoint(matrix, { x: 0.3, y: 0.2 })
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    if (left === null || right === null) {
      return
    }
    expect(left.x).toBeCloseTo(-right.x, DIGITS)
    expect(left.y).toBeCloseTo(right.y, DIGITS)
  })

  it('辺の上の点は、辺の上に写る(直線が保たれる)', () => {
    // 上辺の中点 (0, -0.5) は、台形の上辺 y = -0.5 の上に写る
    const top = transformPoint(matrix, { x: 0, y: -0.5 })
    expectPoint(top, 0, -0.5)
  })
})

describe('computeHomography:4 頂点の対応関係(単位矩形でない場合)', () => {
  it('任意の凸四角形同士で、4 頂点が対応する位置に写る', () => {
    const source = quadOf([0, 0], [2, 0], [2, 1], [0, 1])
    const destination = quadOf([10, 10], [14, 11], [15, 16], [9, 14])
    expectCornersMapped(solve(source, destination), source, destination)
  })

  it('座標が大きい(数百)場合も、4 頂点が対応する位置に写る', () => {
    const destination = quadOf([100, 200], [900, 150], [950, 700], [50, 650])
    // 座標が大きいため、許容誤差は 4 桁(5×10⁻⁵ 未満)
    expectCornersMapped(solve(UNIT_QUAD, destination), UNIT_QUAD, destination, 4)
  })
})

describe('computeHomography:左右非対称の変形', () => {
  const destination = quadOf([-0.5, -0.3], [0.4, -0.5], [0.5, 0.5], [-0.3, 0.4])
  const matrix = solve(UNIT_QUAD, destination)

  it('4 頂点が対応する位置に写る', () => {
    expectCornersMapped(matrix, UNIT_QUAD, destination)
  })

  it('単位矩形の中心は、対角線の交点 (-3/73, 4.9/73) に写る', () => {
    expectPoint(transformPoint(matrix, { x: 0, y: 0 }), -3 / 73, 4.9 / 73)
  })

  it('左右の点が、鏡映の関係にならない', () => {
    const left = transformPoint(matrix, { x: -0.3, y: 0.2 })
    const right = transformPoint(matrix, { x: 0.3, y: 0.2 })
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    if (left === null || right === null) {
      return
    }
    expect(Math.abs(left.x + right.x)).toBeGreaterThan(1e-3)
  })
})

describe('computeHomography:回転・拡大縮小・反転との併用', () => {
  // 画面座標への基本変形:中心 (200, 400)、30° 回転、幅 300・高さ 150 に拡大
  const base = createTrsMatrix(200, 400, Math.PI / 6, 300, 150)
  const homography = solve(UNIT_QUAD, TRAPEZOID)
  const projection = multiplyMat3(base, homography)

  it('P = Base · H は、単位矩形の四隅を、基本変形を適用した台形の四隅に写す', () => {
    for (const i of CORNER_INDICES) {
      const expected = transformPoint(base, TRAPEZOID[i])
      expect(expected).not.toBeNull()
      if (expected === null) {
        continue
      }
      expectPoint(transformPoint(projection, UNIT_QUAD[i]), expected.x, expected.y)
    }
  })

  it('基本変形を適用した四隅から直接求めたホモグラフィと、内部の点の行き先が一致する', () => {
    const mappedQuad = mapQuadBy(base, TRAPEZOID)
    const direct = solve(UNIT_QUAD, mappedQuad)
    const inner = { x: 0.2, y: -0.3 }
    const viaProjection = transformPoint(projection, inner)
    expect(viaProjection).not.toBeNull()
    if (viaProjection === null) {
      return
    }
    expectPoint(transformPoint(direct, inner), viaProjection.x, viaProjection.y)
  })

  it('P の逆行列は、画面上の四隅を、単位矩形の四隅に戻す', () => {
    const inverse = invertHomography(projection)
    expect(inverse).not.toBeNull()
    if (inverse === null) {
      return
    }
    for (const i of CORNER_INDICES) {
      const screen = transformPoint(base, TRAPEZOID[i])
      expect(screen).not.toBeNull()
      if (screen === null) {
        continue
      }
      expectPoint(transformPoint(inverse, screen), UNIT_QUAD[i].x, UNIT_QUAD[i].y)
    }
  })

  it('左右反転(鏡像の四隅)は、diag(-1, 1, 1) になる', () => {
    const mirrored = quadOf([0.5, -0.5], [-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5])
    expectMatrixCloseTo(solve(UNIT_QUAD, mirrored), [-1, 0, 0, 0, 1, 0, 0, 0, 1])
  })
})

describe('invertHomography / determinantMat3', () => {
  it('単位行列の行列式は 1、逆行列は単位行列', () => {
    expect(determinantMat3(IDENTITY_MAT3)).toBeCloseTo(1, DIGITS)
    const inverse = invertHomography(IDENTITY_MAT3)
    expect(inverse).not.toBeNull()
    if (inverse !== null) {
      expectMatrixCloseTo(inverse, IDENTITY_MAT3)
    }
  })

  it('対角行列 diag(2, 3, 4) の行列式は 24', () => {
    expect(determinantMat3([2, 0, 0, 0, 3, 0, 0, 0, 4])).toBeCloseTo(24, DIGITS)
  })

  it('H · H⁻¹ は単位行列になる', () => {
    const homography = solve(UNIT_QUAD, TRAPEZOID)
    const inverse = invertHomography(homography)
    expect(inverse).not.toBeNull()
    if (inverse === null) {
      return
    }
    expectMatrixCloseTo(multiplyMat3(homography, inverse), IDENTITY_MAT3)
  })

  it('逆行列は、変換した点を元の点に戻す', () => {
    const homography = solve(UNIT_QUAD, TRAPEZOID)
    const inverse = invertHomography(homography)
    expect(inverse).not.toBeNull()
    if (inverse === null) {
      return
    }
    const original = { x: 0.3, y: -0.2 }
    const mapped = transformPoint(homography, original)
    expect(mapped).not.toBeNull()
    if (mapped === null) {
      return
    }
    expectPoint(transformPoint(inverse, mapped), original.x, original.y)
  })

  it('行列の大きさに依らず、正則な行列は逆行列を持つ(diag(1000, 1000, 1))', () => {
    const inverse = invertHomography([1000, 0, 0, 0, 1000, 0, 0, 0, 1])
    expect(inverse).not.toBeNull()
    if (inverse !== null) {
      expectMatrixCloseTo(inverse, [0.001, 0, 0, 0, 0.001, 0, 0, 0, 1])
    }
  })
})

describe('特異行列の検出(invertHomography)', () => {
  it('列が平行な行列(行列式が厳密に 0)は null', () => {
    expect(invertHomography([1, 0, 0, 2, 0, 0, 0, 0, 1])).toBeNull()
  })

  it('零行列は null', () => {
    expect(invertHomography([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
  })

  it('行列式が行列の大きさに対して極めて小さい(ほぼ特異)行列は null', () => {
    expect(invertHomography([1, 0, 0, 0, 1e-12, 0, 0, 0, 1])).toBeNull()
  })

  it('NaN や無限大を含む行列は null', () => {
    expect(invertHomography([Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull()
    expect(invertHomography([Number.POSITIVE_INFINITY, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull()
  })
})

describe('computeHomography:失敗の検出', () => {
  it('入力に NaN があれば non-finite', () => {
    const bad = quadOf([-0.5, -0.5], [0.5, -0.5], [Number.NaN, 0.5], [-0.5, 0.5])
    expect(failureReason(computeHomography(UNIT_QUAD, bad))).toBe('non-finite')
  })

  it('入力に無限大があれば non-finite(元の四隅の側も検査される)', () => {
    const bad = quadOf([-0.5, -0.5], [Number.POSITIVE_INFINITY, -0.5], [0.5, 0.5], [-0.5, 0.5])
    expect(failureReason(computeHomography(bad, UNIT_QUAD))).toBe('non-finite')
  })

  it('目的の 4 点がすべて同じ点なら degenerate', () => {
    const point = quadOf([0, 0], [0, 0], [0, 0], [0, 0])
    expect(failureReason(computeHomography(UNIT_QUAD, point))).toBe('degenerate')
  })

  it('元の 4 点がすべて同じ点なら degenerate', () => {
    const point = quadOf([0, 0], [0, 0], [0, 0], [0, 0])
    expect(failureReason(computeHomography(point, UNIT_QUAD))).toBe('degenerate')
  })

  it('目的の 3 点が一直線なら、ホモグラフィとして成立しない(特異または不安定)', () => {
    const collinear = quadOf([0, 0], [1, 0], [2, 0], [0, 1])
    const result = computeHomography(UNIT_QUAD, collinear)
    expect(result.ok).toBe(false)
    expect(['degenerate', 'unstable']).toContain(failureReason(result))
  })

  it('元の 3 点が一直線なら、ホモグラフィとして成立しない(特異または不安定)', () => {
    const collinear = quadOf([0, 0], [1, 0], [2, 0], [0, 1])
    const result = computeHomography(collinear, UNIT_QUAD)
    expect(result.ok).toBe(false)
    expect(['degenerate', 'unstable']).toContain(failureReason(result))
  })

  it('目的が自己交差(蝶ネクタイ)の四角形なら、有効な行列として返さない', () => {
    // 下の 2 点を入れ替えた四隅。w の符号が揃わない、または h33 = 1 に正規化できない。
    const bowtie = quadOf([-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5])
    const result = computeHomography(UNIT_QUAD, bowtie)
    expect(result.ok).toBe(false)
    expect(['degenerate', 'unstable']).toContain(failureReason(result))
  })

  it('失敗しても例外を投げない', () => {
    const point = quadOf([0, 0], [0, 0], [0, 0], [0, 0])
    expect(() => computeHomography(point, point)).not.toThrow()
  })
})