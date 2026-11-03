import { DEFAULT_CHARACTER_STATE } from '../types/character.ts'
import type { CharacterImageState } from '../types/character.ts'
import type { Point2D, PointerPair, Size2D } from '../types/geometry.ts'
import { createTrsMatrix } from './matrix.ts'
import type { Mat3 } from './matrix.ts'

/**
 * キャラクター画像の変形に関する純粋な計算。
 * DOM・WebGL・カメラには依存しない。
 *
 * 座標系:
 * - 状態の x, y はプレビューの中心を 0 とした割合(右・下が正)。
 * - 画面上の点は CSS ピクセル(左上が原点、Y が下向き)で扱う。
 * - 回転は Y が下向きの座標系で時計回りが正(ラジアン)。
 */

/** scale の下限・上限。 */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 6

/** 画像中心の位置の許容範囲(プレビューに対する割合)。中心がプレビュー内に収まる範囲。 */
export const MAX_POSITION_OFFSET = 0.5

/** scale = 1 のときの画像サイズが、プレビューのどの割合に収まるか。 */
export const BASE_FILL_RATIO = 0.5

/** 2 本指の間隔がこの値(CSS ピクセル)より小さいときは、拡大縮小・回転を行わない。 */
export const MIN_PINCH_DISTANCE = 8

/** 値を範囲内に収める。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** 角度(ラジアン)を -π より大きく π 以下の範囲に収める。有限でない値は 0 にする。 */
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) {
    return 0
  }
  const twoPi = Math.PI * 2
  let a = angle % twoPi
  if (a > Math.PI) {
    a -= twoPi
  } else if (a <= -Math.PI) {
    a += twoPi
  }
  return a
}

/** 度をラジアンに変換する。 */
export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** ラジアンを度に変換する。 */
export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}

/**
 * 状態の各値を、有効な範囲に正規化する。
 * NaN や無限大は初期値に置き換え、範囲外の値は範囲内に収める。
 */
export function normalizeCharacterState(
  state: CharacterImageState,
): CharacterImageState {
  return {
    x: clamp(
      finiteOr(state.x, DEFAULT_CHARACTER_STATE.x),
      -MAX_POSITION_OFFSET,
      MAX_POSITION_OFFSET,
    ),
    y: clamp(
      finiteOr(state.y, DEFAULT_CHARACTER_STATE.y),
      -MAX_POSITION_OFFSET,
      MAX_POSITION_OFFSET,
    ),
    scale: clamp(finiteOr(state.scale, DEFAULT_CHARACTER_STATE.scale), MIN_SCALE, MAX_SCALE),
    rotation: normalizeAngle(state.rotation),
    opacity: clamp(finiteOr(state.opacity, DEFAULT_CHARACTER_STATE.opacity), 0, 1),
    visible: state.visible,
  }
}

/** 不透明度だけを変えた新しい状態を返す。 */
export function withOpacity(
  state: CharacterImageState,
  opacity: number,
): CharacterImageState {
  return normalizeCharacterState({ ...state, opacity })
}

/** 回転角(ラジアン)だけを変えた新しい状態を返す。 */
export function withRotation(
  state: CharacterImageState,
  rotation: number,
): CharacterImageState {
  return normalizeCharacterState({ ...state, rotation })
}

/** 表示・非表示だけを変えた新しい状態を返す。 */
export function withVisible(
  state: CharacterImageState,
  visible: boolean,
): CharacterImageState {
  return { ...state, visible }
}

/**
 * scale = 1 のときの画像の表示サイズ(CSS ピクセル)を返す。
 * 画像がプレビューの BASE_FILL_RATIO 以内に収まる大きさで、縦横比を保つ。
 * 画像またはプレビューのサイズが 0 以下の場合は、幅・高さとも 0 を返す。
 */
export function computeBaseSize(imageSize: Size2D, viewport: Size2D): Size2D {
  if (
    imageSize.width <= 0 ||
    imageSize.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: 0, height: 0 }
  }
  const fit = Math.min(
    (viewport.width * BASE_FILL_RATIO) / imageSize.width,
    (viewport.height * BASE_FILL_RATIO) / imageSize.height,
  )
  return { width: imageSize.width * fit, height: imageSize.height * fit }
}

/**
 * 「中心が原点の 1×1 の単位矩形」をプレビューの CSS ピクセル座標へ写す行列を返す。
 * 単位矩形の四隅は (-0.5, -0.5) 〜 (0.5, 0.5)。
 *
 * Phase 3 では、この関数と同じ役割(単位矩形 → 画面座標)を持つ
 * 射影変換の行列に差し替える。
 */
export function buildCharacterMatrix(
  state: CharacterImageState,
  imageSize: Size2D,
  viewport: Size2D,
): Mat3 {
  const s = normalizeCharacterState(state)
  const base = computeBaseSize(imageSize, viewport)
  const centerX = viewport.width / 2 + s.x * viewport.width
  const centerY = viewport.height / 2 + s.y * viewport.height
  return createTrsMatrix(
    centerX,
    centerY,
    s.rotation,
    base.width * s.scale,
    base.height * s.scale,
  )
}

/**
 * 画像を平行移動する(1 本指・マウスのドラッグ)。
 *
 * @param dx 移動量(CSS ピクセル)
 * @param dy 移動量(CSS ピクセル)
 */
export function panBy(
  state: CharacterImageState,
  dx: number,
  dy: number,
  viewport: Size2D,
): CharacterImageState {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return state
  }
  const s = normalizeCharacterState(state)
  return normalizeCharacterState({
    ...s,
    x: s.x + dx / viewport.width,
    y: s.y + dy / viewport.height,
  })
}

/**
 * アンカー点が anchorFrom から anchorTo へ動いたものとして、
 * 拡大縮小・回転・平行移動をまとめて適用する。
 * アンカー点の下にある画像上の点が、アンカー点に追従する。
 *
 * scale が上限・下限で止まった場合は、実際に適用された倍率で位置を計算する。
 *
 * @param scaleFactor 倍率の変化(1 で変化なし)
 * @param deltaRotation 回転の変化(ラジアン)
 */
export function transformAround(
  state: CharacterImageState,
  anchorFrom: Point2D,
  anchorTo: Point2D,
  scaleFactor: number,
  deltaRotation: number,
  viewport: Size2D,
): CharacterImageState {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return state
  }
  const s = normalizeCharacterState(state)
  const factor = finiteOr(scaleFactor, 1)
  const rotation = finiteOr(deltaRotation, 0)

  const nextScale = clamp(s.scale * factor, MIN_SCALE, MAX_SCALE)
  const effectiveFactor = nextScale / s.scale

  const centerX = viewport.width / 2 + s.x * viewport.width
  const centerY = viewport.height / 2 + s.y * viewport.height

  // アンカーから画像中心へのベクトルを、拡大縮小・回転して、新しいアンカーから伸ばす。
  const vx = centerX - anchorFrom.x
  const vy = centerY - anchorFrom.y
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const nextCenterX = anchorTo.x + effectiveFactor * (cos * vx - sin * vy)
  const nextCenterY = anchorTo.y + effectiveFactor * (sin * vx + cos * vy)

  return normalizeCharacterState({
    ...s,
    x: (nextCenterX - viewport.width / 2) / viewport.width,
    y: (nextCenterY - viewport.height / 2) / viewport.height,
    scale: nextScale,
    rotation: s.rotation + rotation,
  })
}

function distanceBetween(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function midpointOf(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * 2 本指の操作(ピンチ・回転・平行移動)を適用する。
 * 指の中点を基準に、倍率と回転を同時に変える。
 *
 * @param previous 直前の 2 本の指の位置(CSS ピクセル)
 * @param next 現在の 2 本の指の位置(CSS ピクセル)
 */
export function applyPinch(
  state: CharacterImageState,
  previous: PointerPair,
  next: PointerPair,
  viewport: Size2D,
): CharacterImageState {
  const prevDistance = distanceBetween(previous.a, previous.b)
  const nextDistance = distanceBetween(next.a, next.b)

  let scaleFactor = 1
  let deltaRotation = 0
  if (prevDistance >= MIN_PINCH_DISTANCE && nextDistance >= MIN_PINCH_DISTANCE) {
    scaleFactor = nextDistance / prevDistance
    const prevAngle = Math.atan2(previous.b.y - previous.a.y, previous.b.x - previous.a.x)
    const nextAngle = Math.atan2(next.b.y - next.a.y, next.b.x - next.a.x)
    deltaRotation = normalizeAngle(nextAngle - prevAngle)
  }

  return transformAround(
    state,
    midpointOf(previous.a, previous.b),
    midpointOf(next.a, next.b),
    scaleFactor,
    deltaRotation,
    viewport,
  )
}

/**
 * 指定した点を基準に拡大縮小する(マウスホイールなど)。
 *
 * @param factor 倍率の変化(1 で変化なし)
 * @param anchor 基準点(CSS ピクセル)
 */
export function zoomAt(
  state: CharacterImageState,
  factor: number,
  anchor: Point2D,
  viewport: Size2D,
): CharacterImageState {
  return transformAround(state, anchor, anchor, factor, 0, viewport)
}

/** ホイールの 1 ステップあたりの倍率の変化の強さ。 */
const WHEEL_ZOOM_SENSITIVITY = 0.0015

/** ホイールの縦方向の移動量から、倍率の変化を求める。上スクロール(負)で拡大。 */
export function wheelZoomFactor(deltaY: number): number {
  const clamped = clamp(finiteOr(deltaY, 0), -400, 400)
  return Math.exp(-clamped * WHEEL_ZOOM_SENSITIVITY)
}