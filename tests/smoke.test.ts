import { describe, expect, it } from 'vitest'
import { APP_NAME, getAppInfo } from '../src/types/app.ts'

describe('スモークテスト：テスト環境の動作確認', () => {
  it('アプリ名が定義されている', () => {
    expect(APP_NAME).toBe('Character Camera')
  })

  it('アプリ情報が Phase 0 として返される', () => {
    const info = getAppInfo()
    expect(info.name).toBe(APP_NAME)
    expect(info.phase).toBe('phase-0')
  })
})