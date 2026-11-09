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
import { buildBaseMatrix, mapQuadToScreen, screenToLocal } from './transform/Transform2D.ts'
import type { Quad } from './types/perspective.ts'
import { CameraView } from './ui/CameraView.ts'
import { CharacterPanel } from './ui/CharacterPanel.ts'
import { GestureHandler } from './ui/GestureHandler.ts'
import type { GestureHost } from './ui/GestureHandler.ts'
import { PerspectiveHandles } from './ui/PerspectiveHandles.ts'
import { ViewportWatcher } from './ui/ViewportWatcher.ts'

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
 * タッチ操作ができる端末か。
 * デスクトップでウィンドウを縦長にしたとき、Web カメラを再取得しないために使う。
 */
function isTouchDevice(): boolean {
  return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
}

/**
 * アプリのエントリーポイント。
 * 各モジュールの生成と接続のみを行い、ロジックは持たない
 * (ハンドルの位置の計算は、変換の関数を呼ぶだけの薄いアダプター)。
 *
 * - カメラ(camera/)とキャラクター画像(image/)は互いを知らない。接続するのはここだけ。
 * - 映像はカメラの video 要素から、PreviewPresenter が背景として描く。
 * - キャラクターの変形(基本変形・四隅の射影変換)は、キャラクターの状態にだけ反映される。
 *   カメラ映像には一切適用されない。
 * - 画面の向きの検知(ViewportWatcher)と、カメラの調整は別の処理として接続する。
 *
 * Phase 3: 四隅の自由変形・遠近補正。フィルター・保存は未実装。
 */
function bootstrap(): void {
  const root = document.querySelector<HTMLDivElement>('#app')

  if (root === null) {
    throw new Error('#app 要素が見つかりません。index.html を確認してください。')
  }

  const view = new CameraView(root)
  const camera = new CameraManager(view.video)
  const character = new CharacterImage()

  // --- 描画 ---
  // rendering/ は image/ に依存しないため、必要な値をここで組み立てて渡す。
  const provider: PreviewContentProvider = {
    getCharacter(): CharacterContent | null {
      const bitmap = character.getBitmap()
      const imageSize = character.getImageSize()
      if (bitmap === null || imageSize === null) {
        return null
      }
      const snapshot = character.getSnapshot()
      return {
        bitmap,
        imageSize,
        state: snapshot.state,
        perspective: snapshot.perspective,
      }
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
  const canvas = presenter.getCanvas()

  // --- 四隅ハンドル(表示のみ。操作は canvas が受ける) ---
  const handles = new PerspectiveHandles()
  view.viewport.append(handles.element)
  let handlesVisible = true

  /**
   * 四隅ハンドルの画面上の位置(canvas の左上を原点とした CSS ピクセル)。
   * 画像がない・キャラクターが非表示・ハンドルを隠している・領域のサイズが 0 の場合は null。
   */
  function computeHandlePositions(): Quad | null {
    if (!handlesVisible || canvas === null) {
      return null
    }
    const snapshot = character.getSnapshot()
    const imageSize = character.getImageSize()
    if (snapshot.image === null || imageSize === null || !snapshot.state.visible) {
      return null
    }
    const viewport = presenter.getViewportSize()
    if (!(viewport.width > 0) || !(viewport.height > 0)) {
      return null
    }
    const base = buildBaseMatrix(snapshot.state, imageSize, viewport)
    return mapQuadToScreen(base, snapshot.perspective.corners)
  }

  function updateHandles(): void {
    handles.setPositions(computeHandlePositions())
  }

  // --- キャラクター画像の操作パネル ---
  const panel = new CharacterPanel()
  view.panelSlot.append(panel.element)

  // --- タッチ・マウス操作 ---
  let gesture: GestureHandler | null = null
  if (canvas !== null) {
    const gestureHost: GestureHost = {
      isEnabled: () => character.getSnapshot().image !== null,
      getViewportSize: () => presenter.getViewportSize(),
      update: (updater) => {
        character.updateState(updater)
      },
      getHandlePositions: computeHandlePositions,
      moveHandle: (index, screenPoint) => {
        const imageSize = character.getImageSize()
        if (imageSize === null) {
          return
        }
        const base = buildBaseMatrix(
          character.getSnapshot().state,
          imageSize,
          presenter.getViewportSize(),
        )
        // 画面上の目標位置を、画像ローカル座標へ戻す。
        // 不正な変形になる位置は、moveCorner の側で有効な範囲の境界に止められる。
        const local = screenToLocal(base, screenPoint)
        if (local === null) {
          return
        }
        character.moveCorner(index, local)
      },
      setActiveHandle: (index) => {
        handles.setActive(index)
      },
    }
    gesture = new GestureHandler(canvas, gestureHost)
  } else {
    console.error('プレビューの描画器を作成できませんでした。')
  }

  // --- 接続 ---
  // キャラクターの状態が変わったら、停止中でも 1 回描き直し、ハンドルの位置も更新する。
  character.subscribe(() => {
    presenter.requestRender()
    updateHandles()
  })

  // プレビュー領域の大きさが変わったら(パネルの高さの変化を含む)、ハンドルの位置を更新する。
  // PreviewPresenter の ResizeObserver より後に登録しているため、
  // 通知は、描画サイズの更新の後に届く。
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      updateHandles()
    }).observe(view.viewport)
  }

  // カメラが稼働している間だけ、毎フレーム描画する。
  camera.subscribe((state) => {
    presenter.setLive(state.status === 'running')
  })

  // --- 画面の向き ---
  // 検知(ViewportWatcher)と、カメラの調整・描画の更新は、別の処理として接続する。
  const touchDevice = isTouchDevice()
  const watcher = new ViewportWatcher({
    // 向きが変わり始めた時点で、進行中のジェスチャー(ハンドルのドラッグを含む)を安全に終わらせる。
    onOrientationChangeStart: () => {
      gesture?.cancel()
    },
    // 寸法が落ち着いたら、描画サイズとハンドルの位置を更新する。
    onSettled: (change) => {
      gesture?.cancel()
      presenter.refreshLayout()
      updateHandles()

      // 向きが変わり、タッチ端末で、カメラが稼働中の場合だけ、映像の向きを合わせる。
      // 食い違いがなければ、camera 側は何もしない(再取得しない)。
      if (
        change.orientationChanged &&
        touchDevice &&
        camera.getState().status === 'running'
      ) {
        camera.adaptToOrientation(change.snapshot.orientation).catch((error: unknown) => {
          console.error('カメラの向きの調整中に予期しないエラーが発生しました:', error)
        })
      }
    },
  })
  watcher.start()

  view.bind(camera)
  panel.bind(character, (visible) => {
    handlesVisible = visible
    updateHandles()
  })
}

bootstrap()