import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_DIMENSION,
  computeScaledSize,
  createImageLoadError,
  detectImageFormat,
  loadImageFile,
  messageForImageError,
  validateFileMeta,
} from '../../src/image/ImageLoader.ts'
import type { ImageLoadErrorKind } from '../../src/types/character.ts'

const ALL_ERROR_KINDS: readonly ImageLoadErrorKind[] = [
  'unsupported-type',
  'unsupported-heic',
  'empty-file',
  'file-too-large',
  'decode-failed',
  'unsupported-browser',
  'processing-failed',
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('エラーメッセージ', () => {
  it.each(ALL_ERROR_KINDS)('%s のメッセージは空でない', (kind) => {
    expect(messageForImageError(kind).length).toBeGreaterThan(0)
  })

  it('すべての種別でメッセージが異なる', () => {
    const messages = ALL_ERROR_KINDS.map((kind) => messageForImageError(kind))
    expect(new Set(messages).size).toBe(ALL_ERROR_KINDS.length)
  })

  it('ファイルサイズ超過のメッセージに上限が含まれる', () => {
    expect(messageForImageError('file-too-large')).toContain('30MB')
  })

  it('HEIC のメッセージは形式を名指しする', () => {
    expect(messageForImageError('unsupported-heic')).toContain('HEIC')
  })

  it('createImageLoadError は種別とメッセージを対応させる', () => {
    const error = createImageLoadError('decode-failed')
    expect(error.kind).toBe('decode-failed')
    expect(error.message).toBe(messageForImageError('decode-failed'))
  })
})

describe('detectImageFormat', () => {
  it.each<[string, string, string]>([
    ['a.png', 'image/png', 'png'],
    ['a.jpg', 'image/jpeg', 'jpeg'],
    ['a.jpg', 'image/jpg', 'jpeg'],
    ['a.jpg', 'image/pjpeg', 'jpeg'],
    ['a.webp', 'image/webp', 'webp'],
    ['a.heic', 'image/heic', 'heic'],
    ['a.heif', 'image/heif', 'heic'],
    ['a.gif', 'image/gif', 'unknown'],
    ['a.svg', 'image/svg+xml', 'unknown'],
  ])('%s(%s)は %s と判定される', (name, mime, expected) => {
    expect(detectImageFormat(name, mime)).toBe(expected)
  })

  it('MIME タイプが空のときは拡張子で判定する(大文字小文字を区別しない)', () => {
    expect(detectImageFormat('photo.PNG', '')).toBe('png')
    expect(detectImageFormat('photo.JPG', '')).toBe('jpeg')
    expect(detectImageFormat('photo.jpeg', '')).toBe('jpeg')
    expect(detectImageFormat('photo.WebP', '')).toBe('webp')
    expect(detectImageFormat('photo.HEIC', '')).toBe('heic')
    expect(detectImageFormat('photo.heif', '')).toBe('heic')
  })

  it('application/octet-stream のときも拡張子で判定する', () => {
    expect(detectImageFormat('photo.png', 'application/octet-stream')).toBe('png')
  })

  it('MIME タイプが image/* の場合は、拡張子より MIME タイプを優先する', () => {
    expect(detectImageFormat('photo.png', 'image/gif')).toBe('unknown')
  })

  it('拡張子がない、または未知の場合は unknown', () => {
    expect(detectImageFormat('noextension', '')).toBe('unknown')
    expect(detectImageFormat('trailingdot.', '')).toBe('unknown')
    expect(detectImageFormat('photo.bmp', '')).toBe('unknown')
  })
})

describe('validateFileMeta(IMG-U1, IMG-U2, IMG-U3)', () => {
  it('PNG・JPEG・WebP は通る', () => {
    expect(validateFileMeta({ name: 'a.png', type: 'image/png', size: 100 })).toBeNull()
    expect(validateFileMeta({ name: 'a.jpg', type: 'image/jpeg', size: 100 })).toBeNull()
    expect(validateFileMeta({ name: 'a.webp', type: 'image/webp', size: 100 })).toBeNull()
  })

  it('MIME タイプが空でも、拡張子が許可形式なら通る', () => {
    expect(validateFileMeta({ name: 'a.png', type: '', size: 100 })).toBeNull()
  })

  it('サイズ 0 は empty-file', () => {
    expect(validateFileMeta({ name: 'a.png', type: 'image/png', size: 0 })?.kind).toBe(
      'empty-file',
    )
  })

  it('HEIC / HEIF は unsupported-heic', () => {
    expect(validateFileMeta({ name: 'a.heic', type: 'image/heic', size: 100 })?.kind).toBe(
      'unsupported-heic',
    )
    expect(validateFileMeta({ name: 'a.heif', type: '', size: 100 })?.kind).toBe(
      'unsupported-heic',
    )
  })

  it('GIF や画像以外は unsupported-type', () => {
    expect(validateFileMeta({ name: 'a.gif', type: 'image/gif', size: 100 })?.kind).toBe(
      'unsupported-type',
    )
    expect(validateFileMeta({ name: 'a.txt', type: 'text/plain', size: 100 })?.kind).toBe(
      'unsupported-type',
    )
    expect(validateFileMeta({ name: 'noext', type: '', size: 100 })?.kind).toBe(
      'unsupported-type',
    )
  })

  it('上限ちょうどは通り、1 バイト超えると file-too-large', () => {
    expect(
      validateFileMeta({ name: 'a.png', type: 'image/png', size: MAX_FILE_BYTES }),
    ).toBeNull()
    expect(
      validateFileMeta({ name: 'a.png', type: 'image/png', size: MAX_FILE_BYTES + 1 })?.kind,
    ).toBe('file-too-large')
  })

  it('サイズが大きくても、形式の問題が先に報告される', () => {
    expect(
      validateFileMeta({ name: 'a.gif', type: 'image/gif', size: MAX_FILE_BYTES + 1 })?.kind,
    ).toBe('unsupported-type')
  })

  it('空ファイルの判定が、形式の判定より先に行われる', () => {
    expect(validateFileMeta({ name: 'a.gif', type: 'image/gif', size: 0 })?.kind).toBe(
      'empty-file',
    )
  })
})

describe('computeScaledSize', () => {
  it('上限以内ならそのまま返す', () => {
    expect(computeScaledSize(1000, 500, MAX_IMAGE_DIMENSION)).toEqual({
      width: 1000,
      height: 500,
    })
  })

  it('長辺がちょうど上限なら縮小しない', () => {
    expect(computeScaledSize(2048, 1024, MAX_IMAGE_DIMENSION)).toEqual({
      width: 2048,
      height: 1024,
    })
  })

  it('横長の画像は、幅が上限になるよう縮小される', () => {
    expect(computeScaledSize(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 })
  })

  it('縦長の画像は、高さが上限になるよう縮小される', () => {
    expect(computeScaledSize(1000, 4000, 2048)).toEqual({ width: 512, height: 2048 })
  })

  it('縦横比を(丸め誤差の範囲で)保つ', () => {
    const result = computeScaledSize(5000, 3333, 2048)
    expect(result.width / result.height).toBeCloseTo(5000 / 3333, 2)
  })

  it('極端に細長い画像でも、幅・高さは 1 以上になる', () => {
    expect(computeScaledSize(10000, 1, 2048)).toEqual({ width: 2048, height: 1 })
  })

  it('幅または高さが 0 以下なら 0 を返す', () => {
    expect(computeScaledSize(0, 100, 2048)).toEqual({ width: 0, height: 0 })
    expect(computeScaledSize(100, -1, 2048)).toEqual({ width: 0, height: 0 })
  })
})

describe('loadImageFile', () => {
  function createFakeBitmap(width: number, height: number): ImageBitmap {
    const fake = { width, height, close: vi.fn() }
    return fake as unknown as ImageBitmap
  }

  it('空のファイルは empty-file を返し、デコードを試みない', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)

    const result = await loadImageFile(new File([], 'a.png', { type: 'image/png' }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('empty-file')
    }
    expect(decode).not.toHaveBeenCalled()
  })

  it('HEIC は unsupported-heic を返す', async () => {
    const result = await loadImageFile(new File(['x'], 'a.heic', { type: 'image/heic' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('unsupported-heic')
    }
  })

  it('createImageBitmap が使えない環境では unsupported-browser を返す', async () => {
    vi.stubGlobal('createImageBitmap', undefined)

    const result = await loadImageFile(new File(['x'], 'a.png', { type: 'image/png' }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('unsupported-browser')
    }
  })

  it('デコードに失敗したら decode-failed を返す', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('broken')))

    const result = await loadImageFile(new File(['x'], 'a.png', { type: 'image/png' }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('decode-failed')
    }
  })

  it('幅や高さが 0 のビットマップは decode-failed とし、閉じる', async () => {
    const bitmap = createFakeBitmap(0, 0)
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))

    const result = await loadImageFile(new File(['x'], 'a.png', { type: 'image/png' }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('decode-failed')
    }
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('上限以内の画像は縮小せず、そのまま返す(閉じない)', async () => {
    const bitmap = createFakeBitmap(100, 50)
    const decode = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', decode)

    const file = new File(['x'], 'character.png', { type: 'image/png' })
    const result = await loadImageFile(file)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bitmap).toBe(bitmap)
      expect(result.info).toEqual({ name: 'character.png', width: 100, height: 50 })
    }
    expect(bitmap.close).not.toHaveBeenCalled()
    // EXIF の向きを反映する指定で呼ばれる。
    expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' })
  })
})