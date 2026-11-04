import './style.css'
import { CameraManager } from './camera/CameraManager.ts'
import { CharacterImage } from './image/CharacterImage.ts'
import { parseRendererPreference } from './rendering/createOverlayRenderer.ts'
import type { RendererKind } from './rendering/OverlayRenderer.ts'
import { PreviewPresenter } from './rendering/PreviewPresenter.ts'
import type {
  CharacterContent,
  PreviewContentProvider,
} from './rendering/PreviewPresenter.ts'
import { CameraView } from './ui/CameraView.ts'
import { CharacterPanel } from './ui/CharacterPanel.ts'
import { GestureHandler } from './ui/GestureHandler.ts'
import type { GestureHost } from './ui/GestureHandler.ts'

/** 描画方式の表示名。 */
function rendererLabel(kind: RendererKind | null): string {
  switch (kind) {
    case 'webgl2':
      return 'WebGL2'
    case 'canvas2d':
      return 'Canvas 2D'
    case null:
      return '描画不可'
  }
}

/**
 * アプリのエントリーポイント。
 * 各モジュールの生成と接続のみを行い、ロジックは持たない。
 *
 * - カメラ(camera/)とキャラクター画像(image/)は互いを知らない。接続するのはここだけ。
 * - 映像はカメラの video 要素から、PreviewPresenter が背景として描く。
 * - キャラクターの変形は、キャラクターの状態にだけ反映される。
 *
 * Phase 2: カメラ + 画像読み込み・オーバーレイ。四隅変形・フィルター・保存は未実装。
 */
function bootstrap(): void {
  const root = document.querySelector<HTMLDivElement>('#app')

  if (root === null) {
    throw new Error('#app 要素が見つかりません。index.html を確認してください。')
  }

  const view = new CameraView(root)
  const camera = new CameraManager(view.video)
  const character = new CharacterImage()

  // --- キャラクター画像の操作パネル ---
  const panel = new CharacterPanel()
  view.panelSlot.append(panel.element)

  // --- 描画 ---
  // rendering/ は image/ に依存しないため、必要な値をここで組み立てて渡す。
  const provider: PreviewContentProvider = {
    getCharacter(): CharacterContent | null {
      const bitmap = character.getBitmap()
      const imageSize = character.getImageSize()
      if (bitmap === null || imageSize === null) {
        return null
      }
      return { bitmap, imageSize, state: character.getSnapshot().state }
    },
  }

  const presenter = new PreviewPresenter(
    view.viewport,
    view.video,
    provider,
    parseRendererPreference(window.location.search),
  )
  const kind = presenter.start()
  view.setRendererLabel(rendererLabel(kind))

  // --- タッチ・マウス操作 ---
  const canvas = presenter.getCanvas()
  if (canvas !== null) {
    const gestureHost: GestureHost = {
      isEnabled: () => character.getSnapshot().image !== null,
      getViewportSize: () => presenter.getViewportSize(),
      update: (updater) => {
        character.updateState(updater)
      },
    }
    new GestureHandler(canvas, gestureHost)
  } else {
    console.error('プレビューの描画器を作成できませんでした。')
  }

  // --- 接続 ---
  // キャラクターの状態が変わったら、停止中でも 1 回描き直す。
  character.subscribe(() => {
    presenter.requestRender()
  })

  // カメラが稼働している間だけ、毎フレーム描画する。
  camera.subscribe((state) => {
    presenter.setLive(state.status === 'running')
  })

  view.bind(camera)
  panel.bind(character)
}

bootstrap()