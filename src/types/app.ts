/**
 * アプリ共通の最小型定義。
 * Phase 0 ではテスト環境の動作確認と、型定義モジュールの置き場を確立する目的のみ。
 * 各機能の型は、後続Phaseで機能ごとにこのディレクトリへファイルを追加して定義する。
 */

/** アプリ名。画面表示やドキュメントで共通利用する。 */
export const APP_NAME = 'Character Camera'

/** 開発フェーズ名。Phase 0 時点では基盤構築のみ。 */
export type DevelopmentPhase = 'phase-0'

/** アプリの基本情報。 */
export interface AppInfo {
  readonly name: string
  readonly phase: DevelopmentPhase
}

/** 現在のアプリ情報を返す。 */
export function getAppInfo(): AppInfo {
  return {
    name: APP_NAME,
    phase: 'phase-0',
  }
}