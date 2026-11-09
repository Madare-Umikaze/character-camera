import type { Point2D } from '../types/geometry.ts'
import { CORNER_INDICES, DEFAULT_PERSPECTIVE_STATE } from '../types/perspective.ts'
import type { CornerIndex, PerspectiveState, Quad } from '../types/perspective.ts'
import { clamp } from './characterTransform.ts'
import { computeUnitSquareHomography } from './Homography.ts'
import { multiplyMat3 } from './matrix.ts'
import type { Mat3 } from './matrix.ts'

/**
 * 四隅の自由変形・遠近補正の計算。DOM・WebGL には依存しない純粋関数。
 *
 * - 四隅は画像ローカル座標(中心が原点、単位矩形は -0.5〜0.5、y が下)で持つ。
 * - 頂点の順序は、左上・右上・右下・左下(Quad)。画面上で時計回り(y が下向きで外積が正)。
 * - 常に「有効な凸四角形」だけを状態として受け入れる(validateQuad)。
 * - 遠近感スライダーは、平面画像の射影変換による視覚的な近似。
 *   3D カメラの姿勢を推定するものではない。
 */

/** 座標の絶対値の上限。 */
export const MAX_QUAD_COORDINATE = 20

/** 辺の長さの下限(単位矩形の辺は 1)。 */
export const MIN_EDGE_LENGTH = 0.05

/** 面積の下限(単位矩形は 1)。 */
export const MIN_QUAD_AREA = 0.02

/** 各角の sin の下限。約 5.7° 未満の鋭い角・ほぼ一直線の角を拒否する。 */
export const MIN_CORNER_SINE = 0.1

/** スライダーが ±1 のときの、辺の長さの変化率(1 ± 0.4 倍)。 */
export const MAX_PERSPECTIVE_STRENGTH = 0.4

/** 二分探索の反復回数。 */
const BISECTION_STEPS = 40

/** 四角形が無効な理由。 */
export type QuadInvalidReason =
  | 'non-finite' // NaN や無限大
  | 'out-of-range' // 座標が大きすぎる
  | 'coincident-vertices' // 頂点が重なっている(辺が短すぎる)
  | 'self-intersecting' // 対辺が交差している
  | 'concave' // 凹形状
  | 'reversed' // 頂点順が逆(鏡像)
  | 'sharp-corner' // 角が鋭すぎる・ほぼ一直線
  | 'too-small' // 面積が小さすぎる
  | 'homography-failed' // ホモグラフィの計算に失敗(特異・不安定)

/** 四角形の検証結果。 */
export type QuadValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: QuadInvalidReason }

type Quad4<T> = readonly [T, T, T, T]

function invalid(reason: QuadInvalidReason): QuadValidation {
  return { ok: false, reason }
}

function nextCorner(index: CornerIndex): CornerIndex {
  switch (index) {
    case 0:
      return 1
    case 1:
      return 2
    case 2:
      return 3
    case 3:
      return 0
  }
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y }
}

function crossProduct(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x
}

/** 点 c が、有向線分 a→b の左右どちら側か(符号つきの面積の 2 倍)。 */
function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  return crossProduct(subtract(b, a), subtract(c, a))
}

function inBoundingBox(a: Point2D, b: Point2D, p: Point2D): boolean {
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  )
}

/** 2 つの線分(端点が接する場合も含む)が交差するか。 */
function segmentsIntersect(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): boolean {
  const d1 = orientation(p3, p4, p1)
  const d2 = orientation(p3, p4, p2)
  const d3 = orientation(p1, p2, p3)
  const d4 = orientation(p1, p2, p4)

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true
  }
  if (d1 === 0 && inBoundingBox(p3, p4, p1)) {
    return true
  }
  if (d2 === 0 && inBoundingBox(p3, p4, p2)) {
    return true
  }
  if (d3 === 0 && inBoundingBox(p1, p2, p3)) {
    return true
  }
  if (d4 === 0 && inBoundingBox(p1, p2, p4)) {
    return true
  }
  return false
}

/** 四隅の面積(シューレース公式)。 */
function quadArea(quad: Quad): number {
  let sum = 0
  for (const i of CORNER_INDICES) {
    const a = quad[i]
    const b = quad[nextCorner(i)]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

/**
 * 四隅が、画像の変形として有効かを検証する。
 * 有効なのは、座標が有限・範囲内で、頂点が重ならず、自己交差・凹形状・鏡像でなく、
 * 鋭すぎる角がなく、面積が十分で、ホモグラフィが安定して求まる凸四角形だけ。
 * 画像が画面外にはみ出すこと自体は、有効として扱う。
 */
export function validateQuad(quad: Quad): QuadValidation {
  for (const p of quad) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return invalid('non-finite')
    }
    if (Math.abs(p.x) > MAX_QUAD_COORDINATE || Math.abs(p.y) > MAX_QUAD_COORDINATE) {
      return invalid('out-of-range')
    }
  }

  const [p0, p1, p2, p3] = quad
  const [e0, e1, e2, e3]: Quad4<Point2D> = [
    subtract(p1, p0),
    subtract(p2, p1),
    subtract(p3, p2),
    subtract(p0, p3),
  ]
  const lengths: Quad4<number> = [
    Math.hypot(e0.x, e0.y),
    Math.hypot(e1.x, e1.y),
    Math.hypot(e2.x, e2.y),
    Math.hypot(e3.x, e3.y),
  ]
  if (lengths.some((length) => !(length >= MIN_EDGE_LENGTH))) {
    return invalid('coincident-vertices')
  }

  if (segmentsIntersect(p0, p1, p2, p3) || segmentsIntersect(p1, p2, p3, p0)) {
    return invalid('self-intersecting')
  }

  // 連続する辺の外積。y が下向きの座標系で、単位矩形(左上→右上→右下→左下)は正。
  const crosses: Quad4<number> = [
    crossProduct(e0, e1),
    crossProduct(e1, e2),
    crossProduct(e2, e3),
    crossProduct(e3, e0),
  ]
  const hasPositive = crosses.some((value) => value > 0)
  const hasNegative = crosses.some((value) => value < 0)
  if (hasPositive && hasNegative) {
    return invalid('concave')
  }
  if (hasNegative) {
    return invalid('reversed')
  }

  for (const i of CORNER_INDICES) {
    const sine = Math.abs(crosses[i]) / (lengths[i] * lengths[nextCorner(i)])
    if (!(sine >= MIN_CORNER_SINE)) {
      return invalid('sharp-corner')
    }
  }

  if (!(quadArea(quad) >= MIN_QUAD_AREA)) {
    return invalid('too-small')
  }

  if (!computeUnitSquareHomography(quad).ok) {
    return invalid('homography-failed')
  }
  return { ok: true }
}

/** 四隅が有効か。 */
export function isValidQuad(quad: Quad): boolean {
  return validateQuad(quad).ok
}

/** スライダーの値を -1〜1 に収める。有限でない値は 0。 */
export function clampSlider(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0
}

/**
 * 横方向・縦方向の遠近感の値から、四隅を計算する。
 *
 * - horizontal(-1〜1):正で左辺が高く(手前に)、右辺が低くなる。負でその逆。
 *   左の 2 頂点の y を (1 + 0.4h) 倍、右の 2 頂点の y を (1 - 0.4h) 倍する。
 * - vertical(-1〜1):正で上辺が広く、下辺が狭くなる。負でその逆。
 *   上の 2 頂点の x を (1 + 0.4v) 倍、下の 2 頂点の x を (1 - 0.4v) 倍する。
 * - 0 のとき、単位矩形になる。
 *
 * 平面画像の射影変換による視覚的な近似であり、3D カメラの姿勢の推定ではない。
 */
export function cornersFromSliders(horizontal: number, vertical: number): Quad {
  const h = clampSlider(horizontal) * MAX_PERSPECTIVE_STRENGTH
  const v = clampSlider(vertical) * MAX_PERSPECTIVE_STRENGTH
  return [
    { x: -0.5 * (1 + v), y: -0.5 * (1 + h) },
    { x: 0.5 * (1 + v), y: -0.5 * (1 - h) },
    { x: 0.5 * (1 - v), y: 0.5 * (1 - h) },
    { x: -0.5 * (1 - v), y: 0.5 * (1 + h) },
  ]
}

/**
 * スライダーの値から、射影変換の状態を作る。
 * 四隅は、スライダーの値から計算した四隅に置き換わる(個別に編集した四隅は破棄される)。
 */
export function createPerspectiveFromSliders(
  horizontal: number,
  vertical: number,
): PerspectiveState {
  const h = clampSlider(horizontal)
  const v = clampSlider(vertical)
  const corners = cornersFromSliders(h, v)
  if (!isValidQuad(corners)) {
    // スライダーの範囲内では起こらない想定。安全のため、初期状態に戻す。
    return DEFAULT_PERSPECTIVE_STATE
  }
  return { corners, horizontal: h, vertical: v }
}

/**
 * 射影変換の状態を、有効な範囲に正規化する。
 * スライダーの値は -1〜1 に収め、四隅が無効なら、初期状態に戻す。
 */
export function normalizePerspectiveState(state: PerspectiveState): PerspectiveState {
  if (!isValidQuad(state.corners)) {
    return DEFAULT_PERSPECTIVE_STATE
  }
  return {
    corners: state.corners,
    horizontal: clampSlider(state.horizontal),
    vertical: clampSlider(state.vertical),
  }
}

function replaceCorner(quad: Quad, index: CornerIndex, point: Point2D): Quad {
  switch (index) {
    case 0:
      return [point, quad[1], quad[2], quad[3]]
    case 1:
      return [quad[0], point, quad[2], quad[3]]
    case 2:
      return [quad[0], quad[1], point, quad[3]]
    case 3:
      return [quad[0], quad[1], quad[2], point]
  }
}

function lerpPoint(from: Point2D, to: Point2D, t: number): Point2D {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}

/**
 * 1 つの頂点を、目標位置へ動かした四隅を返す。
 *
 * 目標位置で有効なら、そのまま動かす。無効なら、現在位置から目標位置への線分を二分探索し、
 * 有効な範囲で最も遠い点に止める(ハンドルが境界で止まる)。
 * 現在の四隅がすでに無効な場合や、目標が有限でない場合は、四隅を変えない。
 *
 * @param target 目標位置(画像ローカル座標)
 */
export function moveCorner(quad: Quad, index: CornerIndex, target: Point2D): Quad {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    return quad
  }
  if (!isValidQuad(quad)) {
    return quad
  }

  const clampedTarget: Point2D = {
    x: clamp(target.x, -MAX_QUAD_COORDINATE, MAX_QUAD_COORDINATE),
    y: clamp(target.y, -MAX_QUAD_COORDINATE, MAX_QUAD_COORDINATE),
  }
  const direct = replaceCorner(quad, index, clampedTarget)
  if (isValidQuad(direct)) {
    return direct
  }

  const start = quad[index]
  let low = 0
  let high = 1
  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const mid = (low + high) / 2
    const candidate = replaceCorner(quad, index, lerpPoint(start, clampedTarget, mid))
    if (isValidQuad(candidate)) {
      low = mid
    } else {
      high = mid
    }
  }
  if (low === 0) {
    return quad
  }
  return replaceCorner(quad, index, lerpPoint(start, clampedTarget, low))
}

/**
 * 射影変換の状態の、1 つの頂点を動かす。スライダーの値は変更しない。
 * 動かせなかった場合(変化がない場合)は、同じオブジェクトを返す。
 */
export function moveCornerInState(
  state: PerspectiveState,
  index: CornerIndex,
  target: Point2D,
): PerspectiveState {
  const moved = moveCorner(state.corners, index, target)
  if (moved === state.corners) {
    return state
  }
  const before = state.corners[index]
  const after = moved[index]
  if (before.x === after.x && before.y === after.y) {
    return state
  }
  return { ...state, corners: moved }
}

/**
 * 画面上の四隅(ハンドルの位置)のうち、指定の点に最も近いものの番号を返す。
 * 半径(CSS ピクセル)以内にない場合は null。
 * 近接していても、最も近い頂点を選ぶ。距離が同じ場合は、番号の小さいほう。
 */
export function findNearestCornerIndex(
  screenQuad: Quad,
  point: Point2D,
  radius: number,
): CornerIndex | null {
  let best: CornerIndex | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const i of CORNER_INDICES) {
    const corner = screenQuad[i]
    const distance = Math.hypot(corner.x - point.x, corner.y - point.y)
    if (distance <= radius && distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/**
 * 基本変形(Base)と四隅から、画面への射影行列 P = Base · H を求める。
 * H は単位矩形から四隅へのホモグラフィで、先に適用される。
 * ホモグラフィを求められない場合は null。
 */
export function composeProjection(base: Mat3, corners: Quad): Mat3 | null {
  const homography = computeUnitSquareHomography(corners)
  if (!homography.ok) {
    return null
  }
  return multiplyMat3(base, homography.matrix)
}