import { CORNER_INDICES } from '../types/perspective.ts'
import type { CornerIndex, Quad } from '../types/perspective.ts'

/**
 * 四隅のハンドル(丸)と、四角形の輪郭線を表示する要素。
 *
 * - 表示だけを担当する。操作(ドラッグ)は、下の canvas が受ける(GestureHandler)。
 *   そのため、この要素は pointer-events: none で、イベントを受け取らない。
 * - 位置は、プレビューの左上を原点とした CSS ピクセル。canvas と同じ要素に重ねて置く。
 * - 頂点の順序は、左上・右上・右下・左下。
 * - 操作中のハンドルは、クラス perspective-handle--active で強調する。
 * - 見た目のスタイルは style.css で定義する。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

type HandleElements = readonly [HTMLElement, HTMLElement, HTMLElement, HTMLElement]

function createHandle(index: CornerIndex): HTMLElement {
  const handle = document.createElement('div')
  handle.className = 'perspective-handle'
  handle.dataset['corner'] = String(index)

  const dot = document.createElement('div')
  dot.className = 'perspective-handle__dot'
  handle.append(dot)
  return handle
}

function isFinitePoint(p: { readonly x: number; readonly y: number }): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
}

export class PerspectiveHandles {
  /** 全体の要素。プレビュー領域に追加する。 */
  readonly element: HTMLElement

  private readonly outline: SVGPolygonElement
  private readonly handles: HandleElements

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'perspective-handles'
    this.element.setAttribute('aria-hidden', 'true')
    this.element.hidden = true

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'perspective-handles__outline')

    this.outline = document.createElementNS(SVG_NS, 'polygon')
    this.outline.setAttribute('class', 'perspective-handles__shape')
    svg.append(this.outline)

    this.handles = [createHandle(0), createHandle(1), createHandle(2), createHandle(3)]
    this.element.append(svg, ...this.handles)
  }

  /**
   * 四隅の画面上の位置を設定する。null や、有限でない値を含む場合は、全体を隠す。
   * 位置が表示領域の外にある頂点は、領域の外にあるため見えない(クリップされる)。
   */
  setPositions(positions: Quad | null): void {
    if (positions === null || !positions.every(isFinitePoint)) {
      this.element.hidden = true
      return
    }
    this.element.hidden = false

    for (const i of CORNER_INDICES) {
      const p = positions[i]
      this.handles[i].style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`
    }
    this.outline.setAttribute(
      'points',
      positions.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    )
  }

  /** 操作中のハンドルを強調する。null で強調を解除する。 */
  setActive(index: CornerIndex | null): void {
    for (const i of CORNER_INDICES) {
      this.handles[i].classList.toggle('perspective-handle--active', i === index)
    }
    this.element.classList.toggle('perspective-handles--active', index !== null)
  }

  /** 要素を DOM から取り除く。 */
  remove(): void {
    this.element.remove()
  }
}