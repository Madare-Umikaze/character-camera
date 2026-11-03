import './style.css'
import { CameraManager } from './camera/CameraManager.ts'
import { CameraView } from './ui/CameraView.ts'

/**
 * アプリのエントリーポイント。
 * 各モジュールの生成と接続のみを行い、ロジックは持たない。
 *
 * Phase 1: カメラ機能のみ。画像読み込み・重ね合わせ・変形・フィルター・保存は未実装。
 */
function bootstrap(): void {
  const root = document.querySelector<HTMLDivElement>('#app')

  if (root === null) {
    throw new Error('#app 要素が見つかりません。index.html を確認してください。')
  }

  const view = new CameraView(root)
  const camera = new CameraManager(view.video)

  view.bind(camera)
}

bootstrap()