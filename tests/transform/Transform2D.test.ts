import { describe, expect, it } from 'vitest'
import { buildCharacterMatrix } from '../../src/transform/characterTransform.ts'
import { IDENTITY_MAT3, transformPoint } from '../../src/transform/matrix.ts'
import type { Mat3 } from '../../src/transform/matrix.ts'
import { composeProjection } from '../../src/transform/PerspectiveTransform.ts'
import {
  FLIP_X_MATRIX,
  buildBaseMatrix,
  buildFlipMatrix,
  localToScreen,
  mapQuadToScreen,
  screenToLocal,
} from '../../src/transform/Transform2D.ts'
import { DEFAULT_CHARACTER_STATE } from '../../src/types/character.ts'
import type { CharacterImageState } from '../../src/types/character.ts'
import type { Point2D, Size2D } from '../../src/types/geometry.ts'
import { CORNER_INDICES, UNIT_QUAD } from '../../src/types/perspective.ts'
import type { Quad } from '../../src/types/perspective.ts'

/** 座標の許容誤差(小数点以下の桁数)。誤差 5×10⁻⁷ 未満。 */
const DIGITS = 6

/** 基準のプレビューサイズ(幅 400、高さ 800)。 */
const VIEWPORT: Size2D = { width: 400, height: 800 }
/** 基準の画像サイズ(幅 100、高さ 50)。scale = 1 のとき 200×100 で表示される。 */
const IMAGE: Size2D = { width: 100, height: 50 }

const TRAPEZOID: Quad = [
  { x: -0.4, y: -0.5 },
  { x: 0.4, y: -0.5 },
  { x: 0.5, y: 0.5 },
  { x: -0.5, y: 0.5 },
]

function makeState(partial: Partial<CharacterImageState>): CharacterImageState {
  return { ...DEFAULT_CHARACTER_STATE, ...partial }
}

function expectPoint(actual: Point2D | null, x: number, y: number): void {
  expect(actual).not.toBeNull()
  if (actual === null) {
    return
  }
  expect(actual.x).toBeCloseTo(x, DIGITS)
  expect(actual.y).toBeCloseTo(y, DIGITS)
}

describe('左右反転の行列', () => {
  it('反転しない場合は単位行列', () => {
    expect(buildFlipMatrix(false)).toBe(IDENTITY_MAT3)
  })

  it('反転する場合は diag(-1, 1, 1)', () => {
    expect(buildFlipMatrix(true)).toBe(FLIP_X_MATRIX)
    expect(FLIP_X_MATRIX).toEqual([-1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('x だけを反転し、y は変えない', () => {
    expectPoint(transformPoint(FLIP_X_MATRIX, { x: 1, y: 2 }), -1, 2)
  })
})

describe('buildBaseMatrix:Base = Place · F', () => {
  it('反転なしでは、拡大縮小・回転・平行移動のみ(Phase 2 の行列と一致)', () => {
    const state = makeState({ x: 0.1, y: -0.05, scale: 1.5, rotation: 0.4 })
    const base = buildBaseMatrix(state, IMAGE, VIEWPORT)
    const place = buildCharacterMatrix(state, IMAGE, VIEWPORT)
    for (let i = 0; i < 9; i += 1) {
      expect(base[i]).toBeCloseTo(place[i] ?? Number.NaN, DIGITS)
    }
  })

  it('初期状態では、画像の四隅が基準サイズの矩形に写る', () => {
    const base = buildBaseMatrix(DEFAULT_CHARACTER_STATE, IMAGE, VIEWPORT)
    expectPoint(transformPoint(base, { x: 0, y: 0 }), 200, 400)
    expectPoint(transformPoint(base, { x: -0.5, y: -0.5 }), 100, 350)
    expectPoint(transformPoint(base, { x: 0.5, y: 0.5 }), 300, 450)
  })

  it('反転ありでは、画像の中心を通る縦軸で左右が入れ替わる', () => {
    const base = buildBaseMatrix(makeState({ flipX: true }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(base, { x: 0, y: 0 }), 200, 400)
    expectPoint(transformPoint(base, { x: 0.5, y: 0.5 }), 100, 450)
    expectPoint(transformPoint(base, { x: -0.5, y: -0.5 }), 300, 350)
  })

  it('反転は回転の内側で適用される(画像の向きに追従して鏡映される)', () => {
    // 回転 +90°。反転なしでは (0.5, 0) → (200, 500)。反転ありでは (200, 300)。
    const rotation = Math.PI / 2
    const plain = buildBaseMatrix(makeState({ rotation }), IMAGE, VIEWPORT)
    const flipped = buildBaseMatrix(makeState({ rotation, flipX: true }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(plain, { x: 0.5, y: 0 }), 200, 500)
    expectPoint(transformPoint(flipped, { x: 0.5, y: 0 }), 200, 300)
  })

  it('反転しても、画像の中心の位置は変わらない', () => {
    const state = makeState({ x: 0.25, y: -0.125, scale: 2, rotation: 0.6 })
    const plain = transformPoint(buildBaseMatrix(state, IMAGE, VIEWPORT), { x: 0, y: 0 })
    const flipped = transformPoint(
      buildBaseMatrix({ ...state, flipX: true }, IMAGE, VIEWPORT),
      { x: 0, y: 0 },
    )
    expect(plain).not.toBeNull()
    expectPoint(flipped, plain?.x ?? Number.NaN, plain?.y ?? Number.NaN)
  })

  it('範囲外の状態は、正規化してから使う(scale 100 は 6 に収まる)', () => {
    const base = buildBaseMatrix(makeState({ scale: 100 }), IMAGE, VIEWPORT)
    expectPoint(transformPoint(base, { x: 0.5, y: 0.5 }), 800, 700)
  })
})

describe('localToScreen / screenToLocal', () => {
  const state = makeState({
    x: 0.1,
    y: -0.05,
    scale: 1.5,
    rotation: 0.7,
    flipX: true,
  })
  const base = buildBaseMatrix(state, IMAGE, VIEWPORT)

  it('localToScreen は、行列による点の変換と同じ', () => {
    const p = { x: 0.2, y: -0.3 }
    const direct = transformPoint(base, p)
    expect(direct).not.toBeNull()
    expectPoint(localToScreen(base, p), direct?.x ?? Number.NaN, direct?.y ?? Number.NaN)
  })

  it('screenToLocal は、localToScreen の逆変換になる(回転・拡大・反転を含む)', () => {
    const local = { x: 0.2, y: -0.3 }
    const screen = localToScreen(base, local)
    expect(screen).not.toBeNull()
    if (screen === null) {
      return
    }
    expectPoint(screenToLocal(base, screen), local.x, local.y)
  })

  it('反転なしでは、画面の (300, 450) はローカルの (0.5, 0.5)', () => {
    const plain = buildBaseMatrix(DEFAULT_CHARACTER_STATE, IMAGE, VIEWPORT)
    expectPoint(screenToLocal(plain, { x: 300, y: 450 }), 0.5, 0.5)
  })

  it('反転ありでは、画面の (300, 450) はローカルの (-0.5, 0.5)', () => {
    const flipped = buildBaseMatrix(makeState({ flipX: true }), IMAGE, VIEWPORT)
    expectPoint(screenToLocal(flipped, { x: 300, y: 450 }), -0.5, 0.5)
  })

  it('画像のサイズが 0 のとき(基本変形が特異)は null', () => {
    const singular = buildBaseMatrix(DEFAULT_CHARACTER_STATE, { width: 0, height: 0 }, VIEWPORT)
    expect(screenToLocal(singular, { x: 1, y: 1 })).toBeNull()
  })

  it('プレビューのサイズが 0 のときも null', () => {
    const singular = buildBaseMatrix(DEFAULT_CHARACTER_STATE, IMAGE, { width: 0, height: 0 })
    expect(screenToLocal(singular, { x: 1, y: 1 })).toBeNull()
  })
})

describe('mapQuadToScreen', () => {
  it('単位矩形の四隅を、画面上の四隅に変換する(頂点の順序は保たれる)', () => {
    const base = buildBaseMatrix(DEFAULT_CHARACTER_STATE, IMAGE, VIEWPORT)
    const screen = mapQuadToScreen(base, UNIT_QUAD)
    expect(screen).not.toBeNull()
    if (screen === null) {
      return
    }
    expectPoint(screen[0], 100, 350)
    expectPoint(screen[1], 300, 350)
    expectPoint(screen[2], 300, 450)
    expectPoint(screen[3], 100, 450)
  })

  it('反転ありでは、左右の頂点が入れ替わった位置に出る', () => {
    const base = buildBaseMatrix(makeState({ flipX: true }), IMAGE, VIEWPORT)
    const screen = mapQuadToScreen(base, TRAPEZOID)
    expect(screen).not.toBeNull()
    if (screen === null) {
      return
    }
    expectPoint(screen[0], 280, 350)
    expectPoint(screen[1], 120, 350)
    expectPoint(screen[2], 100, 450)
    expectPoint(screen[3], 300, 450)
  })

  it('変換できない点(w = 0)があれば null', () => {
    const broken: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 0]
    expect(mapQuadToScreen(broken, UNIT_QUAD)).toBeNull()
  })
})

describe('ハンドルの位置と、描画される四隅の一致', () => {
  it('反転・回転・拡大を含んでも、画面上の四隅が、射影行列で描かれる単位矩形の四隅と一致する', () => {
    const state = makeState({
      x: 0.1,
      y: 0.05,
      scale: 1.3,
      rotation: Math.PI / 6,
      flipX: true,
    })
    const base = buildBaseMatrix(state, IMAGE, VIEWPORT)
    const handles = mapQuadToScreen(base, TRAPEZOID)
    const projection = composeProjection(base, TRAPEZOID)
    expect(handles).not.toBeNull()
    expect(projection).not.toBeNull()
    if (handles === null || projection === null) {
      return
    }
    for (const i of CORNER_INDICES) {
      expectPoint(transformPoint(projection, UNIT_QUAD[i]), handles[i].x, handles[i].y)
    }
  })
})