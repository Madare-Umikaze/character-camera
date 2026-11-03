import type {
  CharacterImageInfo,
  ImageLoadError,
  ImageLoadErrorKind,
} from '../types/character.ts'
import type { Size2D } from '../types/geometry.ts'

/**
 * 画像ファイルの検証・デコード・縮小。
 *
 * - 判定や計算は純粋関数にして、単体テストできるようにしている。
 * - デコードには createImageBitmap を使う。ファイルの内容は外部へ送信しない。
 * - 失敗時は例外を投げず、結果の型で返す。
 * - 返した ImageBitmap の close() は、受け取った側(CharacterImage)の責任。
 */

/** 読み込みを許可するファイルサイズの上限(バイト)。 */
export const MAX_FILE_BYTES = 30 * 1024 * 1024

/** 描画に使う画像の長辺の上限(ピクセル)。超える場合は縮小する。 */
export const MAX_IMAGE_DIMENSION = 2048

/** 判定した画像形式。 */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'heic' | 'unknown'

/** ファイル検証に必要な最小情報(File をそのまま渡さなくてもテストできるようにする)。 */
export interface FileMeta {
  readonly name: string
  readonly type: string
  readonly size: number
}

/** 読み込み結果。 */
export type ImageLoadResult =
  | {
      readonly ok: true
      /** 呼び出し側が close() の責任を持つ。 */
      readonly bitmap: ImageBitmap
      readonly info: CharacterImageInfo
    }
  | {
      readonly ok: false
      readonly error: ImageLoadError
    }

/** エラー種別から日本語メッセージを返す。 */
export function messageForImageError(kind: ImageLoadErrorKind): string {
  switch (kind) {
    case 'unsupported-type':
      return 'この形式の画像は読み込めません。PNG、JPEG、WebP の画像を選択してください。'
    case 'unsupported-heic':
      return 'HEIC / HEIF 形式の画像は、このアプリでは読み込めません。PNG、JPEG、WebP に変換してから選択してください。'
    case 'empty-file':
      return 'ファイルが空です。別の画像を選択してください。'
    case 'file-too-large':
      return `ファイルサイズが大きすぎます(上限 ${Math.round(MAX_FILE_BYTES / (1024 * 1024))}MB)。サイズの小さい画像を選択してください。`
    case 'decode-failed':
      return '画像を読み込めませんでした。ファイルが壊れているか、対応していない形式の可能性があります。'
    case 'unsupported-browser':
      return 'このブラウザは画像の読み込みに必要な機能に対応していません。最新のブラウザをお試しください。'
    case 'processing-failed':
      return '画像の処理に失敗しました。サイズの小さい画像で、もう一度お試しください。'
  }
}

/** エラー種別から ImageLoadError を作る。 */
export function createImageLoadError(kind: ImageLoadErrorKind): ImageLoadError {
  return { kind, message: messageForImageError(kind) }
}

/** ファイル名から小文字の拡張子(ドットなし)を取り出す。ない場合は空文字。 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  if (index < 0 || index === name.length - 1) {
    return ''
  }
  return name.slice(index + 1).toLowerCase()
}

function formatFromMime(mime: string): ImageFormat {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
    case 'image/pjpeg':
      return 'jpeg'
    case 'image/webp':
      return 'webp'
    case 'image/heic':
    case 'image/heif':
    case 'image/heic-sequence':
    case 'image/heif-sequence':
      return 'heic'
    default:
      return 'unknown'
  }
}

function formatFromExtension(extension: string): ImageFormat {
  switch (extension) {
    case 'png':
      return 'png'
    case 'jpg':
    case 'jpeg':
      return 'jpeg'
    case 'webp':
      return 'webp'
    case 'heic':
    case 'heif':
      return 'heic'
    default:
      return 'unknown'
  }
}

/**
 * MIME タイプとファイル名から、画像形式を判定する。
 * MIME タイプが image/* の場合はそれだけで判定する(GIF などは unknown)。
 * 空文字や application/octet-stream など画像以外のときは、拡張子で判定する。
 */
export function detectImageFormat(name: string, mimeType: string): ImageFormat {
  const mime = mimeType.trim().toLowerCase()
  if (mime.startsWith('image/')) {
    return formatFromMime(mime)
  }
  return formatFromExtension(extensionOf(name))
}

/**
 * ファイルの種別とサイズを検証する。
 * 問題がなければ null、問題があれば該当する ImageLoadError を返す。
 */
export function validateFileMeta(meta: FileMeta): ImageLoadError | null {
  if (meta.size <= 0) {
    return createImageLoadError('empty-file')
  }

  const format = detectImageFormat(meta.name, meta.type)
  if (format === 'heic') {
    return createImageLoadError('unsupported-heic')
  }
  if (format === 'unknown') {
    return createImageLoadError('unsupported-type')
  }

  if (meta.size > MAX_FILE_BYTES) {
    return createImageLoadError('file-too-large')
  }
  return null
}

/**
 * 長辺が maxDimension 以内になるサイズを返す。縦横比を保ち、拡大はしない。
 * 結果の幅・高さは 1 以上の整数。
 */
export function computeScaledSize(
  width: number,
  height: number,
  maxDimension: number,
): Size2D {
  if (width <= 0 || height <= 0) {
    return { width: 0, height: 0 }
  }
  const longSide = Math.max(width, height)
  if (longSide <= maxDimension) {
    return { width, height }
  }
  const ratio = maxDimension / longSide
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

/** createImageBitmap が使えるか。 */
function supportsCreateImageBitmap(): boolean {
  return typeof createImageBitmap === 'function'
}

/**
 * ビットマップを、2D canvas を使って指定サイズへ縮小した新しいビットマップを返す。
 * 元のビットマップは閉じない(呼び出し側が閉じる)。アルファは保持される。
 */
async function downscaleBitmap(source: ImageBitmap, target: Size2D): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  try {
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('2D コンテキストを取得できません')
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, target.width, target.height)
    context.drawImage(source, 0, 0, target.width, target.height)
    return await createImageBitmap(canvas)
  } finally {
    // canvas のメモリを早めに解放する。
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * 画像ファイルを読み込み、描画に使える ImageBitmap にする。
 *
 * - PNG / JPEG / WebP に対応。HEIC は専用のエラーを返す。
 * - EXIF の向きを反映する。
 * - 長辺が MAX_IMAGE_DIMENSION を超える場合は縮小する。
 * - 透過 PNG のアルファチャンネルを保持する。
 */
export async function loadImageFile(file: File): Promise<ImageLoadResult> {
  const invalid = validateFileMeta({ name: file.name, type: file.type, size: file.size })
  if (invalid !== null) {
    return { ok: false, error: invalid }
  }

  if (!supportsCreateImageBitmap()) {
    return { ok: false, error: createImageLoadError('unsupported-browser') }
  }

  let decoded: ImageBitmap
  try {
    decoded = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return { ok: false, error: createImageLoadError('decode-failed') }
  }

  if (decoded.width <= 0 || decoded.height <= 0) {
    decoded.close()
    return { ok: false, error: createImageLoadError('decode-failed') }
  }

  const target = computeScaledSize(decoded.width, decoded.height, MAX_IMAGE_DIMENSION)
  if (target.width === decoded.width && target.height === decoded.height) {
    return {
      ok: true,
      bitmap: decoded,
      info: { name: file.name, width: decoded.width, height: decoded.height },
    }
  }

  try {
    const scaled = await downscaleBitmap(decoded, target)
    return {
      ok: true,
      bitmap: scaled,
      info: { name: file.name, width: scaled.width, height: scaled.height },
    }
  } catch {
    return { ok: false, error: createImageLoadError('processing-failed') }
  } finally {
    // 縮小の成否にかかわらず、元のビットマップは不要になる。
    decoded.close()
  }
}