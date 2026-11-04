import { createCanvas2DRenderer } from './Canvas2DRenderer.ts'
import type { OverlayRenderer } from './OverlayRenderer.ts'
import { createWebGL2Renderer } from './WebGL2Renderer.ts'

/**
 * 描画方式の選択。
 *
 * - 既定(auto)では WebGL2 を試し、使えなければ Canvas 2D にフォールバックする。
 * - canvas2d を指定すると、WebGL2 を試さずに Canvas 2D を使う(動作確認用)。
 */

/** 描画方式の希望。 */
export type RendererPreference = 'auto' | 'canvas2d'

/** 生成した描画器と、それが使っている canvas の組。 */
export interface OverlayRendererHandle {
  readonly renderer: OverlayRenderer
  /** 描画器が使っている canvas。呼び出し側が DOM に配置する。 */
  readonly canvas: HTMLCanvasElement
}

/**
 * URL のクエリ文字列(例: "?renderer=canvas2d")から、描画方式の希望を読み取る。
 * 認識できない値や指定なしは auto にする。
 */
export function parseRendererPreference(search: string): RendererPreference {
  const params = new URLSearchParams(search)
  return params.get('renderer') === 'canvas2d' ? 'canvas2d' : 'auto'
}

/**
 * 描画器を作る。
 *
 * 一度 WebGL2 のコンテキストを取得した canvas は 2D コンテキストを取得できないため、
 * canvas は生成関数で受け取り、フォールバック時は新しい canvas を作る。
 * どちらの描画器も作れない場合は null を返す。
 */
export function createOverlayRenderer(
  createCanvas: () => HTMLCanvasElement,
  preference: RendererPreference,
): OverlayRendererHandle | null {
  if (preference !== 'canvas2d') {
    const glCanvas = createCanvas()
    const glRenderer = createWebGL2Renderer(glCanvas)
    if (glRenderer !== null) {
      return { renderer: glRenderer, canvas: glCanvas }
    }
  }

  const canvas2d = createCanvas()
  const renderer2d = createCanvas2DRenderer(canvas2d)
  if (renderer2d !== null) {
    return { renderer: renderer2d, canvas: canvas2d }
  }
  return null
}