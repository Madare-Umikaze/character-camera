import { UNIT_QUAD } from '../types/perspective.ts'
import type { Quad } from '../types/perspective.ts'
import { transformPoint } from './matrix.ts'
import type { Mat3 } from './matrix.ts'

/**
 * ホモグラフィ(射影変換行列)の計算。DOM・WebGL には依存しない純粋関数。
 * gl-matrix にホモグラフィの計算機能があるとは仮定せず、自前で解く。
 *
 * 定義:
 * - 点は列ベクトル (x, y, 1)ᵀ。行列 H を左から掛けて (x', y', w')ᵀ = H·(x, y, 1)ᵀ とし、
 *   結果の点は (x'/w', y'/w')。
 * - Mat3 は列優先。要素 (行 r, 列 c) は m[3c + r]。
 *   x' = m[0]x + m[3]y + m[6]、y' = m[1]x + m[4]y + m[7]、w' = m[2]x + m[5]y + m[8]。
 * - h33 = m[8] = 1 に正規化する。
 * - 4 点の対応(source[i] → destination[i])から、次の 8 個の未知数を解く。
 *     h11·x + h12·y + h13 − x'·(h31·x + h32·y) = x'
 *     h21·x + h22·y + h23 − y'·(h31·x + h32·y) = y'
 * - 行列の適用順序は multiplyMat3(A, B) で「B が先、A が後」。
 * - 逆行列は invertHomography で求める。特異な場合は null。
 *
 * 数値計算:
 * - 部分ピボット選択付きガウス消去法。ピボットが係数の最大値に対して小さければ特異とみなす。
 * - 解いた後、4 点が目的の位置に写るか(残差)と、行列式、w の符号を検算する。
 */

/** 消去法のピボットの下限(係数の最大絶対値に対する比)。これ以下は特異とみなす。 */
export const PIVOT_EPSILON = 1e-10

/** 行列式の下限(行列のフロベニウスノルムの 3 乗に対する比)。これ以下は特異とみなす。 */
export const SINGULAR_DET_EPSILON = 1e-10

/** 解の検算(残差)の許容。目的座標の大きさ(1 + 最大絶対値)に対する相対値。 */
export const RESIDUAL_EPSILON = 1e-6

/** w の絶対値の下限。 */
const W_EPSILON = 1e-9

/** ホモグラフィの計算に失敗した理由。 */
export type HomographyFailureReason =
  | 'non-finite' // 入力に NaN や無限大がある
  | 'degenerate' // 特異(点の重なり・一直線など)
  | 'unstable' // 数値的に不安定(残差が大きい、w の符号が揃わない)

/** ホモグラフィの計算結果。 */
export type HomographyResult =
  | { readonly ok: true; readonly matrix: Mat3 }
  | { readonly ok: false; readonly reason: HomographyFailureReason }

const QUAD_INDEX = [0, 1, 2, 3] as const

function failure(reason: HomographyFailureReason): HomographyResult {
  return { ok: false, reason }
}

function isFiniteQuad(quad: Quad): boolean {
  return quad.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
}

function maxAbsCoordinate(quad: Quad): number {
  let max = 0
  for (const p of quad) {
    max = Math.max(max, Math.abs(p.x), Math.abs(p.y))
  }
  return max
}

function frobeniusNorm(m: Mat3): number {
  let sum = 0
  for (const value of m) {
    sum += value * value
  }
  return Math.sqrt(sum)
}

/** 3×3 行列の行列式。 */
export function determinantMat3(m: Mat3): number {
  const [a00, a10, a20, a01, a11, a21, a02, a12, a22] = m
  return (
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20)
  )
}

/**
 * 3×3 行列の逆行列を、余因子法で求める。
 * 行列式が、行列の大きさに対して 0 に近い(特異)場合や、結果が有限でない場合は null。
 */
export function invertHomography(m: Mat3): Mat3 | null {
  const [a00, a10, a20, a01, a11, a21, a02, a12, a22] = m
  const det = determinantMat3(m)
  const norm = frobeniusNorm(m)
  if (
    !Number.isFinite(det) ||
    !(norm > 0) ||
    Math.abs(det) <= SINGULAR_DET_EPSILON * norm * norm * norm
  ) {
    return null
  }
  const inv = 1 / det
  const i00 = (a11 * a22 - a12 * a21) * inv
  const i01 = (a02 * a21 - a01 * a22) * inv
  const i02 = (a01 * a12 - a02 * a11) * inv
  const i10 = (a12 * a20 - a10 * a22) * inv
  const i11 = (a00 * a22 - a02 * a20) * inv
  const i12 = (a02 * a10 - a00 * a12) * inv
  const i20 = (a10 * a21 - a11 * a20) * inv
  const i21 = (a01 * a20 - a00 * a21) * inv
  const i22 = (a00 * a11 - a01 * a10) * inv

  const out: Mat3 = [i00, i10, i20, i01, i11, i21, i02, i12, i22]
  if (!out.every((value) => Number.isFinite(value))) {
    return null
  }
  return out
}

// 8×9 の拡大係数行列(行優先)を、フラットな配列で扱う。
const UNKNOWNS = 8
const COLUMNS = 9

function at(a: Float64Array, row: number, col: number): number {
  return a[row * COLUMNS + col] ?? 0
}

function put(a: Float64Array, row: number, col: number, value: number): void {
  a[row * COLUMNS + col] = value
}

/**
 * 8×9 の拡大係数行列を、部分ピボット選択付きガウス消去法で解く(配列は書き換える)。
 * 特異・非有限の場合は null。
 */
function solveLinearSystem(a: Float64Array): Float64Array | null {
  let scale = 0
  for (let r = 0; r < UNKNOWNS; r += 1) {
    for (let c = 0; c < UNKNOWNS; c += 1) {
      scale = Math.max(scale, Math.abs(at(a, r, c)))
    }
  }
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return null
  }
  const tolerance = scale * PIVOT_EPSILON

  for (let col = 0; col < UNKNOWNS; col += 1) {
    // 部分ピボット選択:この列で絶対値が最大の行を選ぶ。
    let pivotRow = col
    let best = Math.abs(at(a, col, col))
    for (let r = col + 1; r < UNKNOWNS; r += 1) {
      const value = Math.abs(at(a, r, col))
      if (value > best) {
        best = value
        pivotRow = r
      }
    }
    if (!(best > tolerance)) {
      return null
    }
    if (pivotRow !== col) {
      for (let c = 0; c < COLUMNS; c += 1) {
        const tmp = at(a, col, c)
        put(a, col, c, at(a, pivotRow, c))
        put(a, pivotRow, c, tmp)
      }
    }

    const pivot = at(a, col, col)
    for (let r = col + 1; r < UNKNOWNS; r += 1) {
      const factor = at(a, r, col) / pivot
      if (factor === 0) {
        continue
      }
      for (let c = col; c < COLUMNS; c += 1) {
        put(a, r, c, at(a, r, c) - factor * at(a, col, c))
      }
    }
  }

  // 後退代入。
  const x = new Float64Array(UNKNOWNS)
  for (let r = UNKNOWNS - 1; r >= 0; r -= 1) {
    let sum = at(a, r, UNKNOWNS)
    for (let c = r + 1; c < UNKNOWNS; c += 1) {
      sum -= at(a, r, c) * (x[c] ?? 0)
    }
    x[r] = sum / at(a, r, r)
  }
  return x
}

/**
 * 4 点の対応(source[i] → destination[i])から、ホモグラフィを求める。
 * 頂点の順序は、左上・右上・右下・左下で統一する。
 *
 * 失敗する場合(特異・不安定・非有限)は、理由つきで返す。例外は投げない。
 */
export function computeHomography(source: Quad, destination: Quad): HomographyResult {
  if (!isFiniteQuad(source) || !isFiniteQuad(destination)) {
    return failure('non-finite')
  }

  // 未知数の並び:h11, h12, h13, h21, h22, h23, h31, h32(h33 = 1)
  const a = new Float64Array(UNKNOWNS * COLUMNS)
  for (const i of QUAD_INDEX) {
    const s = source[i]
    const d = destination[i]
    const r0 = 2 * i
    const r1 = 2 * i + 1

    put(a, r0, 0, s.x)
    put(a, r0, 1, s.y)
    put(a, r0, 2, 1)
    put(a, r0, 6, -d.x * s.x)
    put(a, r0, 7, -d.x * s.y)
    put(a, r0, 8, d.x)

    put(a, r1, 3, s.x)
    put(a, r1, 4, s.y)
    put(a, r1, 5, 1)
    put(a, r1, 6, -d.y * s.x)
    put(a, r1, 7, -d.y * s.y)
    put(a, r1, 8, d.y)
  }

  const solution = solveLinearSystem(a)
  if (solution === null) {
    return failure('degenerate')
  }

  const h = (k: number): number => solution[k] ?? Number.NaN
  // 列優先:[h11, h21, h31, h12, h22, h32, h13, h23, 1]
  const matrix: Mat3 = [h(0), h(3), h(6), h(1), h(4), h(7), h(2), h(5), 1]
  if (!matrix.every((value) => Number.isFinite(value))) {
    return failure('unstable')
  }

  // 特異な行列(例:目的の 3 点が一直線)は、ここで検出する。
  if (invertHomography(matrix) === null) {
    return failure('degenerate')
  }

  // 検算:4 点が目的の位置に写るか。w の符号が揃っているか。
  const tolerance = RESIDUAL_EPSILON * (1 + maxAbsCoordinate(destination))
  const ws: number[] = []
  for (const i of QUAD_INDEX) {
    const s = source[i]
    const d = destination[i]
    const mapped = transformPoint(matrix, s)
    if (
      mapped === null ||
      Math.abs(mapped.x - d.x) > tolerance ||
      Math.abs(mapped.y - d.y) > tolerance
    ) {
      return failure('unstable')
    }
    ws.push(matrix[2] * s.x + matrix[5] * s.y + matrix[8])
  }
  const allPositive = ws.every((w) => w > W_EPSILON)
  const allNegative = ws.every((w) => w < -W_EPSILON)
  if (!allPositive && !allNegative) {
    return failure('unstable')
  }

  return { ok: true, matrix }
}

/** 単位矩形(画像全体)を、与えた四隅に写すホモグラフィを求める。 */
export function computeUnitSquareHomography(destination: Quad): HomographyResult {
  return computeHomography(UNIT_QUAD, destination)
}