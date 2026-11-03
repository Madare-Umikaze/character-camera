import {
  buildPixelToClipMatrix,
  createTrsMatrix,
  mat3ToFloat32Array,
  multiplyMat3,
} from '../transform/matrix.ts'
import type { Mat3 } from '../transform/matrix.ts'
import type { Size2D } from '../types/geometry.ts'
import type { FrameInput, OverlayRenderer, RendererKind } from './OverlayRenderer.ts'
import { QUAD_FRAGMENT_SHADER, QUAD_VERTEX_SHADER } from './shaders.ts'

/**
 * WebGL2 によるオーバーレイ描画。
 *
 * - 背景(カメラ映像)とキャラクターを、同じシェーダーで別々の行列を使って描く。
 *   キャラクターの変形は、キャラクターの行列にのみ含まれ、背景には影響しない。
 * - キャラクターはプリマルチプライドアルファで合成し、透過 PNG の透明部分を保つ。
 * - コンテキストの消失・復元に対応する。
 * - 座標系は CSS ピクセル。クリップ座標への変換は、この中に閉じ込める。
 */

/** GPU リソースの一式。 */
interface GlResources {
  readonly program: WebGLProgram
  readonly vao: WebGLVertexArrayObject
  readonly buffer: WebGLBuffer
  readonly matrixLocation: WebGLUniformLocation
  readonly opacityLocation: WebGLUniformLocation
  readonly textureLocation: WebGLUniformLocation
  readonly videoTexture: WebGLTexture
  readonly characterTexture: WebGLTexture
}

/** 単位矩形の頂点(TRIANGLE_STRIP)。 */
const QUAD_VERTICES = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])

/** video に現在のフレームがあり、描画できるか。 */
function isVideoReady(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (shader === null) {
    throw new Error('シェーダーを作成できませんでした')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    throw new Error(`シェーダーのコンパイルに失敗しました: ${log}`)
  }
  return shader
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (texture === null) {
    throw new Error('テクスチャを作成できませんでした')
  }
  return texture
}

/** プログラム・バッファ・テクスチャを作る。失敗時は例外を投げる。 */
function buildResources(gl: WebGL2RenderingContext): GlResources {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, QUAD_VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, QUAD_FRAGMENT_SHADER)

  const program = gl.createProgram()
  if (program === null) {
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    throw new Error('プログラムを作成できませんでした')
  }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  // リンク後、シェーダー単体は不要になる。
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program) ?? ''
    gl.deleteProgram(program)
    throw new Error(`プログラムのリンクに失敗しました: ${log}`)
  }

  const matrixLocation = gl.getUniformLocation(program, 'u_matrix')
  const opacityLocation = gl.getUniformLocation(program, 'u_opacity')
  const textureLocation = gl.getUniformLocation(program, 'u_texture')
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  if (
    matrixLocation === null ||
    opacityLocation === null ||
    textureLocation === null ||
    positionLocation < 0
  ) {
    gl.deleteProgram(program)
    throw new Error('シェーダーの変数を取得できませんでした')
  }

  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  if (vao === null || buffer === null) {
    gl.deleteProgram(program)
    throw new Error('頂点バッファを作成できませんでした')
  }
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(positionLocation)
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  const videoTexture = createTexture(gl)
  const characterTexture = createTexture(gl)

  return {
    program,
    vao,
    buffer,
    matrixLocation,
    opacityLocation,
    textureLocation,
    videoTexture,
    characterTexture,
  }
}

function deleteResources(gl: WebGL2RenderingContext, resources: GlResources): void {
  gl.deleteTexture(resources.videoTexture)
  gl.deleteTexture(resources.characterTexture)
  gl.deleteBuffer(resources.buffer)
  gl.deleteVertexArray(resources.vao)
  gl.deleteProgram(resources.program)
}

export class WebGL2Renderer implements OverlayRenderer {
  readonly kind: RendererKind = 'webgl2'

  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext

  private resources: GlResources | null = null
  private cssSize: Size2D = { width: 0, height: 0 }
  private pixelSize: Size2D = { width: 0, height: 0 }
  /** 現在 characterTexture にアップロードしてあるビットマップ。 */
  private uploadedBitmap: ImageBitmap | null = null
  private contextLost = false
  private disposed = false

  private readonly onContextLost = (event: Event): void => {
    // 復元を許可するために、既定の動作(復元の放棄)を止める。
    event.preventDefault()
    this.contextLost = true
    this.resources = null
    this.uploadedBitmap = null
  }

  private readonly onContextRestored = (): void => {
    if (this.disposed) {
      return
    }
    try {
      this.resources = buildResources(this.gl)
      this.uploadedBitmap = null
      this.contextLost = false
    } catch (error: unknown) {
      console.error('WebGL コンテキストの復元に失敗しました:', error)
      this.resources = null
    }
  }

  /** 初期化に失敗した場合は例外を投げる(createWebGL2Renderer が捕捉する)。 */
  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl
    this.resources = buildResources(gl)
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)
  }

  resize(cssSize: Size2D, pixelSize: Size2D): void {
    this.cssSize = cssSize
    this.pixelSize = pixelSize
    if (this.canvas.width !== pixelSize.width) {
      this.canvas.width = pixelSize.width
    }
    if (this.canvas.height !== pixelSize.height) {
      this.canvas.height = pixelSize.height
    }
  }

  render(frame: FrameInput): void {
    const resources = this.resources
    if (this.disposed || this.contextLost || resources === null) {
      return
    }
    if (
      !(this.cssSize.width > 0) ||
      !(this.cssSize.height > 0) ||
      this.pixelSize.width <= 0 ||
      this.pixelSize.height <= 0
    ) {
      return
    }

    const gl = this.gl
    gl.viewport(0, 0, this.pixelSize.width, this.pixelSize.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(resources.program)
    gl.bindVertexArray(resources.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(resources.textureLocation, 0)

    const pixelToClip = buildPixelToClipMatrix(this.cssSize)

    // --- 背景レイヤー(不透明。ブレンドなし) ---
    const background = frame.background
    if (
      background !== null &&
      background.rect.width > 0 &&
      background.rect.height > 0 &&
      isVideoReady(background.source)
    ) {
      gl.disable(gl.BLEND)
      gl.bindTexture(gl.TEXTURE_2D, resources.videoTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        background.source,
      )
      this.setSamplerParameters(false)

      const rect = background.rect
      const rectMatrix = createTrsMatrix(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        0,
        rect.width,
        rect.height,
      )
      this.drawQuad(resources, multiplyMat3(pixelToClip, rectMatrix), 1)
    }

    // --- 前景レイヤー(キャラクター。プリマルチプライドアルファで合成) ---
    const character = frame.character
    if (character !== null) {
      this.ensureCharacterTexture(resources, character.bitmap)
      gl.bindTexture(gl.TEXTURE_2D, resources.characterTexture)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      const opacity = Math.min(Math.max(character.opacity, 0), 1)
      this.drawQuad(resources, multiplyMat3(pixelToClip, character.matrix), opacity)
      gl.disable(gl.BLEND)
    }

    gl.bindVertexArray(null)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)

    if (this.resources !== null) {
      deleteResources(this.gl, this.resources)
      this.resources = null
    }
    this.uploadedBitmap = null
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  // ---------------------------------------------------------------
  // 内部処理
  // ---------------------------------------------------------------

  private drawQuad(resources: GlResources, matrix: Mat3, opacity: number): void {
    const gl = this.gl
    gl.uniformMatrix3fv(resources.matrixLocation, false, mat3ToFloat32Array(matrix))
    gl.uniform1f(resources.opacityLocation, opacity)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** 現在バインドされているテクスチャのサンプラー設定。 */
  private setSamplerParameters(mipmap: boolean): void {
    const gl = this.gl
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  /**
   * ビットマップが前回と異なる場合だけ、キャラクターのテクスチャにアップロードする。
   *
   * ImageBitmap を texImage2D に直接渡すと、UNPACK_PREMULTIPLY_ALPHA_WEBGL の設定が
   * 無視される。透明部分の縁が黒ずむのを防ぐため、一度 2D canvas に描いてからアップロードする。
   * canvas はフラグに従うため、プリマルチプライド状態が確定する。
   */
  private ensureCharacterTexture(resources: GlResources, bitmap: ImageBitmap): void {
    if (this.uploadedBitmap === bitmap) {
      return
    }
    const gl = this.gl

    const staging = document.createElement('canvas')
    staging.width = bitmap.width
    staging.height = bitmap.height
    try {
      const context = staging.getContext('2d')
      if (context === null) {
        throw new Error('2D コンテキストを取得できません')
      }
      context.clearRect(0, 0, staging.width, staging.height)
      context.drawImage(bitmap, 0, 0)

      gl.bindTexture(gl.TEXTURE_2D, resources.characterTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, staging)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.generateMipmap(gl.TEXTURE_2D)
      this.setSamplerParameters(true)
      this.uploadedBitmap = bitmap
    } finally {
      // staging canvas のメモリを早めに解放する。
      staging.width = 0
      staging.height = 0
    }
  }
}

/**
 * canvas から WebGL2 コンテキストを取得して、描画器を作る。
 * WebGL2 が使えない場合や、初期化に失敗した場合は null を返す。
 *
 * 注意: 一度 getContext('webgl2') を呼んだ canvas は、2D コンテキストを取得できない。
 * フォールバックする場合は、新しい canvas を用意すること(createOverlayRenderer が行う)。
 */
export function createWebGL2Renderer(canvas: HTMLCanvasElement): WebGL2Renderer | null {
  if (typeof WebGL2RenderingContext === 'undefined') {
    return null
  }
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  if (gl === null) {
    return null
  }
  try {
    return new WebGL2Renderer(canvas, gl)
  } catch (error: unknown) {
    console.warn('WebGL2 の初期化に失敗しました。Canvas 2D を使用します:', error)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
}