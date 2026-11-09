import { mat3 } from 'gl-matrix'
import type { Point2D, Size2D } from '../types/geometry.ts'

/**
 * 3×3 行列(列優先、gl-matrix と同じ並び)。
 * 要素は [m00, m01, m02, m10, m11, m12, m20, m21, m22] の順で、
 * 平行移動は [6], [7] に入る。点は列ベクトル (x, y, 1) として左から掛ける。
 *
 * 読み取り専用のタプルにして、添字アクセスが undefined にならないようにしている。
 * DOM・WebGL には依存しない。
 *
 * 精度:
 * gl-matrix の mat3.create() は、既定で単精度(Float32Array)を返す。
 * 画面座標(数百)を含む行列を単精度で合成すると、約 3×10⁻⁵ の丸め誤差が出るため、
 * 計算結果は通常の配列(倍精度)で受け取る。
 * GPU に渡す直前だけ、mat3ToFloat32Array で単精度に変換する。
 */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

/** gl-matrix の関数の出力先として使う、書き換え可能な倍精度の行列。 */
type Mat3Tuple = [number, number, number, number, number, number, number, number, number]

/** 単位行列。 */
export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function identityTuple(): Mat3Tuple {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

function toTuple(m: Mat3): Mat3Tuple {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]]
}

/**
 * 行列の積 a × b を返す。
 * 点に適用すると、b が先に、a が後に適用される。
 */
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = identityTuple()
  mat3.multiply(out, toTuple(a), toTuple(b))
  return out
}

/**
 * 平行移動・回転・拡大縮小の合成行列 T × R × S を返す。
 * 点には、拡大縮小 → 回転 → 平行移動の順で適用される。
 *
 * @param tx 平行移動(X)
 * @param ty 平行移動(Y)
 * @param rotation 回転角(ラジアン)。Y 軸が下向きの座標系で時計回りが正。
 * @param sx 拡大縮小(X)
 * @param sy 拡大縮小(Y)
 */
export function createTrsMatrix(
  tx: number,
  ty: number,
  rotation: number,
  sx: number,
  sy: number,
): Mat3 {
  const m = identityTuple()
  mat3.translate(m, m, [tx, ty])
  mat3.rotate(m, m, rotation)
  mat3.scale(m, m, [sx, sy])
  return m
}

/**
 * 行列で点を変換する。
 * 射影変換(Phase 3 以降)に対応するため、同次座標の w による除算を行う。
 * w が 0 に等しい場合は変換できないため null を返す。
 */
export function transformPoint(m: Mat3, p: Point2D): Point2D | null {
  const x = m[0] * p.x + m[3] * p.y + m[6]
  const y = m[1] * p.x + m[4] * p.y + m[7]
  const w = m[2] * p.x + m[5] * p.y + m[8]
  if (w === 0) {
    return null
  }
  return { x: x / w, y: y / w }
}

/**
 * CSS ピクセル座標(左上が原点、Y が下向き)を
 * WebGL のクリップ座標(中心が原点、-1〜1、Y が上向き)へ写す行列を返す。
 * size が 0 以下の場合は、1 として扱う(ゼロ除算の回避)。
 */
export function buildPixelToClipMatrix(size: Size2D): Mat3 {
  const w = Math.max(size.width, 1)
  const h = Math.max(size.height, 1)
  return [2 / w, 0, 0, 0, -2 / h, 0, -1, 1, 1]
}

/** uniformMatrix3fv に渡すための Float32Array へ変換する(GPU への受け渡し用)。 */
export function mat3ToFloat32Array(m: Mat3): Float32Array {
  return new Float32Array(m)
}