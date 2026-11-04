import { describe, expect, it } from 'vitest'
import {
  IDENTITY_MAT3,
  buildPixelToClipMatrix,
  createTrsMatrix,
  mat3ToFloat32Array,
  multiplyMat3,
  transformPoint,
} from '../../src/transform/matrix.ts'
import type { Mat3 } from '../../src/transform/matrix.ts'
import type { Point2D } from '../../src/types/geometry.ts'

/** 変換結果の点が、期待する座標と(許容誤差内で)一致することを確認する。 */
function expectPoint(actual: Point2D | null, x: number, y: number): void {
  expect(actual).not.toBeNull()
  if (actual === null) {
    return
  }
  expect(actual.x).toBeCloseTo(x, 6)
  expect(actual.y).toBeCloseTo(y, 6)
}

/** 2 つの行列が、許容誤差内で等しいことを確認する。 */
function expectMatrixCloseTo(actual: Mat3, expected: Mat3): void {
  for (let i = 0; i < 9; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] ?? Number.NaN, 6)
  }
}

describe('IDENTITY_MAT3(TRF-U1)', () => {
  it('単位行列の並びになっている', () => {
    expect(IDENTITY_MAT3).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('点を変えない', () => {
    expectPoint(transformPoint(IDENTITY_MAT3, { x: 12.5, y: -7 }), 12.5, -7)
  })
})

describe('createTrsMatrix', () => {
  it('変形なしの引数では単位行列になる', () => {
    expectMatrixCloseTo(createTrsMatrix(0, 0, 0, 1, 1), IDENTITY_MAT3)
  })

  it('平行移動のみ(TRF-U2)', () => {
    const m = createTrsMatrix(10, 20, 0, 1, 1)
    expectPoint(transformPoint(m, { x: 0, y: 0 }), 10, 20)
    expectPoint(transformPoint(m, { x: 5, y: -5 }), 15, 15)
  })

  it('拡大縮小のみ。原点が固定される(TRF-U3)', () => {
    const m = createTrsMatrix(0, 0, 0, 2, 3)
    expectPoint(transformPoint(m, { x: 0, y: 0 }), 0, 0)
    expectPoint(transformPoint(m, { x: 1, y: 1 }), 2, 3)
    expectPoint(transformPoint(m, { x: -1, y: 2 }), -2, 6)
  })

  it('回転のみ。+90° で (1,0) が (0,1) に移る(Y 下向きで時計回り)(TRF-U4)', () => {
    const m = createTrsMatrix(0, 0, Math.PI / 2, 1, 1)
    expectPoint(transformPoint(m, { x: 1, y: 0 }), 0, 1)
    expectPoint(transformPoint(m, { x: 0, y: 1 }), -1, 0)
  })

  it('回転 180° で点が反転する', () => {
    const m = createTrsMatrix(0, 0, Math.PI, 1, 1)
    expectPoint(transformPoint(m, { x: 3, y: -2 }), -3, 2)
  })

  it('回転 360° で元に戻る', () => {
    const m = createTrsMatrix(0, 0, Math.PI * 2, 1, 1)
    expectPoint(transformPoint(m, { x: 3, y: -2 }), 3, -2)
  })

  it('負の角度は反時計回り', () => {
    const m = createTrsMatrix(0, 0, -Math.PI / 2, 1, 1)
    expectPoint(transformPoint(m, { x: 1, y: 0 }), 0, -1)
  })

  it('拡大縮小 → 回転 → 平行移動の順で適用される(TRF-U5)', () => {
    // (1,0) → 拡大縮小 (2,0) → 回転 90° (0,2) → 平行移動 (10,22)
    const m = createTrsMatrix(10, 20, Math.PI / 2, 2, 3)
    expectPoint(transformPoint(m, { x: 1, y: 0 }), 10, 22)
    // (0,1) → 拡大縮小 (0,3) → 回転 90° (-3,0) → 平行移動 (7,20)
    expectPoint(transformPoint(m, { x: 0, y: 1 }), 7, 20)
  })
})

describe('multiplyMat3', () => {
  it('単位行列との積は元の行列と等しい', () => {
    const m = createTrsMatrix(5, -3, 0.7, 2, 1.5)
    expectMatrixCloseTo(multiplyMat3(IDENTITY_MAT3, m), m)
    expectMatrixCloseTo(multiplyMat3(m, IDENTITY_MAT3), m)
  })

  it('右側の行列が先に適用される', () => {
    const translate = createTrsMatrix(10, 0, 0, 1, 1)
    const scale = createTrsMatrix(0, 0, 0, 2, 2)

    // scale が先: (1,1) → (2,2) → (12,2)
    expectPoint(transformPoint(multiplyMat3(translate, scale), { x: 1, y: 1 }), 12, 2)
    // translate が先: (1,1) → (11,1) → (22,2)
    expectPoint(transformPoint(multiplyMat3(scale, translate), { x: 1, y: 1 }), 22, 2)
  })
})

describe('transformPoint', () => {
  it('射影成分があるとき、w で除算する', () => {
    // x = 1, y = 0, w = m[2]·1 + m[8] = 2 なので、結果は (0.5, 0)
    const m: Mat3 = [1, 0, 1, 0, 1, 0, 0, 0, 1]
    expectPoint(transformPoint(m, { x: 1, y: 0 }), 0.5, 0)
  })

  it('w が 0 のときは null を返す', () => {
    const m: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 0]
    expect(transformPoint(m, { x: 1, y: 1 })).toBeNull()
  })
})

describe('buildPixelToClipMatrix', () => {
  const size = { width: 200, height: 100 }

  it('左上が (-1, 1) になる', () => {
    expectPoint(transformPoint(buildPixelToClipMatrix(size), { x: 0, y: 0 }), -1, 1)
  })

  it('右下が (1, -1) になる', () => {
    expectPoint(transformPoint(buildPixelToClipMatrix(size), { x: 200, y: 100 }), 1, -1)
  })

  it('中心が (0, 0) になる', () => {
    expectPoint(transformPoint(buildPixelToClipMatrix(size), { x: 100, y: 50 }), 0, 0)
  })

  it('サイズが 0 でも、有限の値を返す(ゼロ除算を避ける)', () => {
    const m = buildPixelToClipMatrix({ width: 0, height: 0 })
    for (const value of m) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('mat3ToFloat32Array', () => {
  it('9 要素の Float32Array になり、並び順が保たれる', () => {
    const m: Mat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    const array = mat3ToFloat32Array(m)
    expect(array).toBeInstanceOf(Float32Array)
    expect(array.length).toBe(9)
    expect(Array.from(array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})