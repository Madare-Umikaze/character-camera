import { invertHomography } from '../transform/Homography.ts'
import {
  buildPixelToClipMatrix,
  createTrsMatrix,
  mat3ToFloat32Array,
  multiplyMat3,
} from '../transform/matrix.ts'
import type { Mat3 } from '../transform/matrix.ts'
import type { Size2D } from '../types/geometry.ts'
import type {
  CharacterLayer,
  FrameInput,
  OverlayRenderer,
  RendererKind,
} from './OverlayRenderer.ts'
import {
  PROJECTIVE_FRAGMENT_SHADER,
  PROJECTIVE_VERTEX_SHADER,
  QUAD_FRAGMENT_SHADER,
  QUAD_VERTEX_SHADER,
} from './shaders.ts'

/**
 * WebGL2 によるオーバーレイ描画。
 *
 * - 背景(カメラ映像)は、アフィンの矩形だけを描く専用のプログラムで描く。
 *   キャラクターの変形は、背景には一切影響しない。
 * - キャラクターは、射影変換の専用プログラムで描く。画素ごとに逆行列で UV を求めるため、
 *   画像全体が射影変換される。プリマルチプライドアルファで合成し、透過 PNG の透明部分を保つ。
 * - コンテキストの消失・復元に対応する。
 * - 座標系は CSS ピクセル。クリップ座標への変換は、この中に閉じ込める。
 */

/** 単位矩形を描くプログラム(背景用)。 */
interface QuadProgram {
  readonly program: WebGLProgram
  readonly vao: WebGLVertexArrayObject
  readonly matrixLocation: WebGLUniformLocation
  readonly opacityLocation: WebGLUniformLocation
  readonly textureLocation: WebGLUniformLocation
}

/** 射影変換で単位矩形を描くプログラム(キャラクター用)。 */
interface ProjectiveProgram extends QuadProgram {
  readonly inverseLocation: WebGLUniformLocation
}

/** GPU リソースの一式。 */
interface GlResources {
  readonly background: QuadProgram
  readonly projective: ProjectiveProgram
  readonly buffer: WebGLBuffer
  readonly videoTexture: WebGLTexture
  readonly characterTexture: WebGLTexture
}

/** 単位矩形の頂点(TRIANGLE_STRIP)。左上・右上・左下・右下の順。 */
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

/** 頂点・フラグメントのシェーダーをコンパイルして、プログラムにリンクする。失敗時は解放して例外を投げる。 */
function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  let fragmentShader: WebGLShader
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  } catch (error: unknown) {
    gl.deleteShader(vertexShader)
    throw error
  }

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
  return program
}

function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (location === null) {
    throw new Error(`シェーダーの変数 ${name} を取得できませんでした`)
  }
  return location
}

/** 共有の頂点バッファを使う VAO を、プログラムごとに作る。 */
function createQuadVao(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  buffer: WebGLBuffer,
): WebGLVertexArrayObject {
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  if (positionLocation < 0) {
    throw new Error('頂点の変数 a_position を取得できませんでした')
  }
  const vao = gl.createVertexArray()
  if (vao === null) {
    throw new Error('頂点配列を作成できませんでした')
  }
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.enableVertexAttribArray(positionLocation)
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return vao
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (texture === null) {
    throw new Error('テクスチャを作成できませんでした')
  }
  return texture
}

/**
 * プログラム・バッファ・テクスチャを作る。
 * 途中で失敗した場合は、作成済みのものを解放してから例外を投げる。
 */
function buildResources(gl: WebGL2RenderingContext): GlResources {
  const cleanups: Array<() => void> = []
  try {
    const buffer = gl.createBuffer()
    if (buffer === null) {
      throw new Error('頂点バッファを作成できませんでした')
    }
    cleanups.push(() => {
      gl.deleteBuffer(buffer)
    })
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)

    const backgroundProgram = linkProgram(gl, QUAD_VERTEX_SHADER, QUAD_FRAGMENT_SHADER)
    cleanups.push(() => {
      gl.deleteProgram(backgroundProgram)
    })
    const backgroundVao = createQuadVao(gl, backgroundProgram, buffer)
    cleanups.push(() => {
      gl.deleteVertexArray(backgroundVao)
    })
    const background: QuadProgram = {
      program: backgroundProgram,
      vao: backgroundVao,
      matrixLocation: requireUniform(gl, backgroundProgram, 'u_matrix'),
      opacityLocation: requireUniform(gl, backgroundProgram, 'u_opacity'),
      textureLocation: requireUniform(gl, backgroundProgram, 'u_texture'),
    }

    const projectiveProgram = linkProgram(
      gl,
      PROJECTIVE_VERTEX_SHADER,
      PROJECTIVE_FRAGMENT_SHADER,
    )
    cleanups.push(() => {
      gl.deleteProgram(projectiveProgram)
    })
    const projectiveVao = createQuadVao(gl, projectiveProgram, buffer)
    cleanups.push(() => {
      gl.deleteVertexArray(projectiveVao)
    })
    const projective: ProjectiveProgram = {
      program: projectiveProgram,
      vao: projectiveVao,
      matrixLocation: requireUniform(gl, projectiveProgram, 'u_matrix'),
      opacityLocation: requireUniform(gl, projectiveProgram, 'u_opacity'),
      textureLocation: requireUniform(gl, projectiveProgram, 'u_texture'),
      inverseLocation: requireUniform(gl, projectiveProgram, 'u_inverse'),
    }

    const videoTexture = createTexture(gl)
    cleanups.push(() => {
      gl.deleteTexture(videoTexture)
    })
    const characterTexture = createTexture(gl)
    cleanups.push(() => {
      gl.deleteTexture(characterTexture)
    })

    return { background, projective, buffer, videoTexture, characterTexture }
  } catch (error: unknown) {
    for (const cleanup of cleanups) {
      cleanup()
    }
    throw error
  }
}

function deleteResources(gl: WebGL2RenderingContext, resources: GlResources): void {
  gl.deleteTexture(resources.videoTexture)
  gl.deleteTexture(resources.characterTexture)
  gl.deleteVertexArray(resources.background.vao)
  gl.deleteVertexArray(resources.projective.vao)
  gl.deleteBuffer(resources.buffer)
  gl.deleteProgram(resources.background.program)
  gl.deleteProgram(resources.projective.program)
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

    const pixelToClip = buildPixelToClipMatrix(this.cssSize)

    // --- 背景レイヤー(不透明。ブレンドなし。キャラクターの変形とは無関係) ---
    const background = frame.background
    if (
      background !== null &&
      background.rect.width > 0 &&
      background.rect.height > 0 &&
      isVideoReady(background.source)
    ) {
      const program = resources.background
      gl.useProgram(program.program)
      gl.bindVertexArray(program.vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1i(program.textureLocation, 0)

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
      this.drawBackground(program, multiplyMat3(pixelToClip, rectMatrix))
    }

    // --- 前景レイヤー(キャラクター。射影変換、プリマルチプライドアルファで合成) ---
    const character = frame.character
    if (character !== null) {
      this.drawCharacter(resources, character, pixelToClip)
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

  private drawBackground(program: QuadProgram, matrix: Mat3): void {
    const gl = this.gl
    gl.uniformMatrix3fv(program.matrixLocation, false, mat3ToFloat32Array(matrix))
    gl.uniform1f(program.opacityLocation, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /**
   * キャラクターを描く。
   * layer.matrix は「画像ローカル座標(単位矩形)→ CSS ピクセル座標」の射影行列(アフィンでも可)。
   * クリップ座標への行列と、その逆行列(クリップ座標 → 画像ローカル座標)をシェーダーへ渡す。
   * 逆行列が求まらない(特異な)場合は、キャラクターだけ描かない。
   */
  private drawCharacter(
    resources: GlResources,
    layer: CharacterLayer,
    pixelToClip: Mat3,
  ): void {
    const clipMatrix = multiplyMat3(pixelToClip, layer.matrix)
    const inverse = invertHomography(clipMatrix)
    if (inverse === null) {
      return
    }

    const gl = this.gl
    this.ensureCharacterTexture(resources, layer.bitmap)

    const program = resources.projective
    gl.useProgram(program.program)
    gl.bindVertexArray(program.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(program.textureLocation, 0)
    gl.bindTexture(gl.TEXTURE_2D, resources.characterTexture)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    gl.uniformMatrix3fv(program.matrixLocation, false, mat3ToFloat32Array(clipMatrix))
    gl.uniformMatrix3fv(program.inverseLocation, false, mat3ToFloat32Array(inverse))
    gl.uniform1f(program.opacityLocation, Math.min(Math.max(layer.opacity, 0), 1))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.disable(gl.BLEND)
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
 * WebGL2 が使えない場合や、初期化(シェーダーのコンパイル・リンクを含む)に失敗した場合は null を返す。
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