# Character Camera:アーキテクチャ設計書

本書は、各モジュールの役割・依存関係・データの流れを定義します。
実装は Phase ごとに進めます。本書は **Phase 2.5 完了時点(実装完了、実機確認待ち)** の実装に合わせて更新しており、未実装の部分は「設計方針」、実機で未確認の部分は「未確認」と明記しています。

## 1. 設計の基本方針

1. **レイヤー分離**:カメラ映像は背景レイヤー、キャラクター画像は前景レイヤーとして独立して扱う。
2. **変形の適用範囲**:回転・拡大縮小・射影変換・台形補正・四隅自由変形は、**キャラクター画像のみ**に適用する。カメラ映像には適用しない。
3. **ブラウザ内完結**:すべての処理はブラウザ内で行い、画像・映像を外部へ送信しない。サーバーサイド処理とデータベースは存在しない。
4. **責務の分離**:UI、カメラ制御、画像処理、描画、保存を別モジュールにする。
5. **純粋ロジックの分離**:数学的な計算は DOM・WebGL に依存させず、単体テスト可能にする。
6. **状態の分離**:カメラの状態(`CameraState`)とキャラクターの状態(`CharacterImageState`)は、別のオブジェクトで管理する。
7. **検知と対処の分離**:画面の向きの検知(`ViewportWatcher`)と、カメラ映像・描画の更新は、別の処理として設計する。

## 2. モジュール構成(Phase 2.5 時点)

```text
src/
├── types/        共通の型
│   ├── app.ts            アプリ情報(Phase 0 の動作確認用)
│   ├── geometry.ts       点・サイズ・矩形・2 本指の位置
│   └── character.ts      キャラクターの状態・画像情報・読み込みエラー・スナップショット
├── transform/    変形の数学(純粋関数)
│   ├── matrix.ts             3×3 行列(gl-matrix のラッパー)
│   └── characterTransform.ts 状態の正規化・描画行列・移動/ピンチ/ズームの計算
├── camera/       カメラ制御
│   ├── CameraSettings.ts     カメラの型・定数・エラー分類・制約生成・向きの判定(純粋関数)
│   └── CameraManager.ts      起動・停止・切り替え・向きの調整・ストリーム管理
├── image/        画像読み込み・保持
│   ├── ImageLoader.ts        ファイル検証・デコード・縮小
│   └── CharacterImage.ts     画像と状態の保持・リソース解放・購読
├── rendering/    描画
│   ├── layout.ts                 contain 矩形・canvas 内部解像度の計算(純粋関数)
│   ├── OverlayRenderer.ts        描画器の共通インターフェース
│   ├── shaders.ts                GLSL(文字列定数)
│   ├── WebGL2Renderer.ts         WebGL2 描画
│   ├── Canvas2DRenderer.ts       Canvas 2D 描画(フォールバック)
│   ├── createOverlayRenderer.ts  描画方式の選択
│   └── PreviewPresenter.ts       描画ループ・canvas 管理・リサイズ監視・レイアウト更新
├── ui/           UI
│   ├── CameraView.ts         カメラ画面(ステータス・起動/停止/切り替え・サイドバー構造)
│   ├── CharacterPanel.ts     画像の操作パネル
│   ├── GestureHandler.ts     Pointer Events による移動・ピンチ・ホイール・中断
│   └── ViewportWatcher.ts    画面の寸法と向きの変化の監視
├── filters/      (未実装:Phase 3)
├── capture/      (未実装:Phase 4)
├── main.ts       エントリーポイント(組み立てのみ)
└── style.css     スタイル(縦画面・横画面)

public/shaders/   (未使用。シェーダーは rendering/shaders.ts に文字列で持つ)
tests/            単体テスト(src/ と同じ構成のサブフォルダ)
docs/             設計書・テスト計画
.github/workflows/deploy.yml   GitHub Pages へのデプロイ(確認用に前倒しで追加)
```

## 3. 各モジュールの役割

### 3.1 types/

- 役割:モジュール間で共有する型を定義する。実行時のロジックは持たない(`app.ts` と `character.ts` の初期値定数は例外)。
- 他のどのモジュールにも依存しない。
- **例外**:カメラ専用の型(`CameraState`、`LayoutOrientation` など)は、純粋関数と一体で管理するため `camera/CameraSettings.ts` に置く。複数モジュールで共有する必要が出た時点で `types/` に移す。

### 3.2 transform/

- 役割:キャラクター画像の変形に関する計算。
  - `matrix.ts`:3×3 行列の積、平行移動・回転・拡大縮小の合成(T×R×S)、点の変換(w による除算あり)、ピクセル座標からクリップ座標への行列。
  - `characterTransform.ts`:状態の正規化(範囲制限・NaN の除去・角度の正規化)、「単位矩形 → 画面座標」の行列の生成、移動・ピンチ・指定点を基準にしたズームの計算。
- DOM・WebGL・カメラに依存しない純粋関数。
- 依存先:`types/`、`gl-matrix`

### 3.3 camera/

- 役割:`getUserMedia` によるカメラの起動・停止・前面背面の切り替え、エラーの分類、画面の向きへの映像の調整。
  - `CameraSettings.ts`:型、定数、エラー分類、制約の生成、向きの判定(`orientationOf`、`isOrientationMismatch`、`buildSizeConstraints`)。すべて純粋関数。
  - `CameraManager.ts`:ストリーム管理。起動・停止・切り替え・向きの調整は**直列化**し、世代番号で古い操作の結果を破棄する。切り替えや停止では、既存のトラックを必ず `stop()` する。
- 映像のピクセルを加工しない。画像処理や描画の知識を持たない。
- 映像の `resize` イベントを監視し、状態の解像度(`info.resolution`)を実際の `videoWidth / videoHeight` に追従させる。再取得はしない。
- `onFrame()` は用意しているが、現在は未使用。
- 向きの調整(`adaptToOrientation`)は 6.3 で説明する。
- 依存先:なし(`CameraSettings.ts` は自己完結)

### 3.4 image/

- 役割:ユーザーが選んだ画像を、描画可能な `ImageBitmap` にして保持する。
  - `ImageLoader.ts`:形式判定(PNG・JPEG・WebP。HEIC は専用エラー)、サイズ検証、`createImageBitmap` によるデコード(EXIF の向きを反映)、長辺 2048px 超の縮小(アルファを保持)。失敗時は例外でなく結果の型で返す。
  - `CharacterImage.ts`:画像と `CharacterImageState` の保持、購読、`ImageBitmap` の `close()` の責任。連続読み込みでは最後の要求だけを採用する。失敗しても表示中の画像は維持する。
- 外部への送信は行わない。画面の向きには関与しない。
- 依存先:`types/`、`transform/`

### 3.5 rendering/

- 役割:背景(カメラ映像)とキャラクターを、合成プレビューとして描画する。
  - `OverlayRenderer`:WebGL2 と Canvas 2D の共通インターフェース。背景とキャラクターは別のフィールドで渡し、背景の配置(矩形)とキャラクターの行列は呼び出し側が計算して渡す。
  - `WebGL2Renderer`:同じシェーダーを、背景とキャラクターで別の行列を使って描く。キャラクターはプリマルチプライドアルファで合成する。コンテキストの消失・復元に対応する。
  - `Canvas2DRenderer`:アフィン変換のみ対応するフォールバック。
  - `createOverlayRenderer`:WebGL2 を優先し、使えなければ Canvas 2D にフォールバックする。一度 WebGL2 を取得した canvas は 2D を取得できないため、フォールバック時は新しい canvas を作る。`?renderer=canvas2d` で Canvas 2D を強制できる。
  - `PreviewPresenter`:描画ループ、canvas の配置、リサイズ監視、内部解像度の更新。`refreshLayout()` で表示領域を測り直す。映像の `resize` でも描き直す。
- 映像の寸法は**毎フレーム video 要素から読む**。映像の向きや大きさが変わっても、背景の配置は自動で追従する。
- 依存先:`types/`、`transform/`、`gl-matrix`
- `camera/`、`image/`、`ui/` には依存しない。映像要素やキャラクターの内容は、`main.ts` が渡す。

### 3.6 ui/

- 役割:DOM の構築、操作の受け取り、状態の表示、画面の向きの検知。
  - `CameraView`:ステータス、起動・停止・切り替え、エラー表示、ページ非表示時の停止。パネルとカメラ操作を `aside.camera-side` にまとめる。
  - `CharacterPanel`:画像選択、表示/非表示、不透明度、回転、リセット、削除、読み込みエラー表示。
  - `GestureHandler`:Pointer Events による移動(1 本指・マウス)、拡大縮小・回転・移動(2 本指)、ホイールでのズーム。`cancel()` で進行中の操作を安全に終了する。
  - `ViewportWatcher`:`resize`、`orientationchange`、`screen.orientation` の `change`、`visualViewport` の `resize` を購読し、寸法が落ち着いた時点で通知する。存在しない API はスキップする。ブラウザ API は `ViewportEnvironment` に分離している。
- 操作対象は、各ファイルで定義した最小のインターフェース(`CameraController`、`CharacterController`、`GestureHost`)だけを使う。`CameraManager` や `CharacterImage` のクラスには依存しない。
- 依存先:`types/`、`transform/`、`camera/CameraSettings.ts`(型と純粋関数のみ。`describeState`、`orientationOf` など)

### 3.7 main.ts

- 役割:各モジュールの生成と接続のみ。ロジックは持たない。
- `CameraManager` と `CharacterImage` は互いを知らない。接続するのはここだけ。
- `rendering/` と `ui/` が `image/` に依存しないため、`CharacterImage` から `PreviewContentProvider` と `GestureHost` を作る薄いアダプターをここに置く。
- `ViewportWatcher` の通知を、ジェスチャーの中断・描画サイズの更新・カメラの調整に振り分ける(6.4)。

### 3.8 filters/、capture/(未実装)

- `filters/`(Phase 3):フィルターと色覚シミュレーションの定義。
- `capture/`(Phase 4):撮影・保存。

## 4. 依存関係

矢印は「依存する」を表します。

```text
                         main.ts
      ┌────────┬───────────┼───────────┬────────────┐
      ▼        ▼           ▼           ▼            ▼
    ui/     camera/     image/    rendering/   (filters/, capture/ は未実装)
     │  │                 │  │       │  │
     │  └──▶ camera/      │  │       │  │
     │     CameraSettings │  │       │  │
     ▼     (型・純粋関数) ▼  ▼       ▼  ▼
  transform/ ◀──────── transform/  transform/
     │                    │          │
     └────────────────────┴──────────┘
                          ▼
                       types/   (gl-matrix は transform/ と rendering/ から)
```

### 依存ルール

| モジュール | 依存してよい | 依存しない |
|---|---|---|
| `types/` | なし | すべて |
| `transform/` | `types/`、`gl-matrix` | DOM、WebGL、`camera/`、`image/`、`rendering/`、`ui/` |
| `camera/` | なし | それ以外のすべて |
| `image/` | `types/`、`transform/` | `camera/`、`rendering/`、`ui/` |
| `rendering/` | `types/`、`transform/`、`gl-matrix` | `camera/`、`image/`、`ui/` |
| `ui/` | `types/`、`transform/`、`camera/CameraSettings.ts`(型と純粋関数のみ) | `CameraManager`、`CharacterImage`、`rendering/` |
| `main.ts` | すべて | (なし) |

- 循環依存を作らない。
- `ui/` が `camera/CameraSettings.ts` を参照するのは、状態の型・日本語の表示文字列・向きの判定を共有するため。ストリーム管理には触れない。

## 5. データの流れ

全体像:

```text
[カメラ] ──MediaStream──▶ <video>(1px・透明。描画元としてだけ DOM に残す)
                              │
[ファイル] ──File──▶ ImageLoader ──ImageBitmap──▶ CharacterImage ◀── CharacterPanel(スライダー・ボタン)
                                                       │  ▲
                                                       │  └── GestureHandler(ドラッグ・ピンチ・ホイール)
                                              state / bitmap
                                                       ▼
   main.ts のアダプター ──▶ PreviewPresenter
                              │ 背景:video(毎フレーム videoWidth/Height)→ contain 矩形(layout.ts)
                              │ 前景:state → 単位矩形→画面座標の行列(characterTransform.ts)
                              ▼
                         OverlayRenderer(WebGL2 / Canvas 2D)
                              ▼
                         canvas(合成プレビュー)

[window / screen / visualViewport] ──▶ ViewportWatcher ──▶ main.ts ──┬─▶ GestureHandler.cancel()
                                                                    ├─▶ PreviewPresenter.refreshLayout()
                                                                    └─▶ CameraManager.adaptToOrientation()
```

### 5.1 カメラ映像の取得

1. 「起動」ボタンで `CameraManager.start()` が `getUserMedia` を呼ぶ(音声なし、高解像度を `ideal` で要求)。通常の起動の制約は、従来どおり横向きの幅・高さの `ideal`。
2. 初期は背面カメラ(`facingMode: ideal environment`)。切り替えは、既存ストリームを停止してから新しいストリームを取得する(iOS Safari は 2 つのカメラを同時に開けないため)。
3. `MediaStream` を `<video>` の `srcObject` に設定し、`muted`・`autoplay`・`playsinline` で再生する。
4. `<video>` は `hidden` や `display: none` にせず、1px・透明で DOM に置く(iOS Safari でフレームが更新されないことを避けるため)。画面に映像を表示するのは canvas。
5. エラーは種別に分類して日本語メッセージで表示する。ページが非表示になるとカメラを停止し、復帰時の自動再起動はしない。
6. 映像ピクセルには、変形を一切加えない。

### 5.2 キャラクター画像の読み込み

1. 「画像を選択」で `<input type="file" accept="image/*">` を開く。
2. `ImageLoader` が形式とサイズを検証する(PNG・JPEG・WebP。HEIC は専用メッセージ。上限 30MB)。
3. `createImageBitmap(file, { imageOrientation: 'from-image' })` でデコードする。長辺 2048px を超える場合は 2D canvas で縮小する。透過 PNG のアルファは保持される。
4. `CharacterImage` が `ImageBitmap` と情報を保持し、状態を初期値にする。前の `ImageBitmap` は `close()` する。
5. 失敗した場合は、表示中の画像と状態を維持し、エラーだけを表示する。連続して選んだ場合は、最後の要求の結果だけを採用する。
6. ファイルの内容は外部へ送信しない。

### 5.3 画像の変形(アフィン変換)

1. `CharacterImageState`(`x`、`y`、`scale`、`rotation`、`opacity`、`visible`)が唯一の変形状態。
   - `x`、`y`:画像中心の位置。プレビュー中心を 0 とした、プレビューの幅・高さに対する割合。
   - `scale`:基準サイズ(プレビューの約 50% に収まる大きさ)に対する倍率(0.1〜6)。
   - `rotation`:ラジアン。画面上で時計回りが正。
2. 操作の入口は 3 つ。どれも `CharacterImage.updateState()` を通り、範囲内に正規化される。
   - `GestureHandler`:1 本指/マウスのドラッグで移動、2 本指で拡大縮小・回転・移動(指の中点を基準)、ホイールでカーソル位置を基準にズーム。
   - `CharacterPanel`:不透明度・回転のスライダー、表示/非表示、リセット、削除。
   - リセットは、位置・拡大縮小・回転・不透明度・表示のすべてを初期値に戻す。
3. `buildCharacterMatrix()` が、状態から「中心が原点の 1×1 の単位矩形 → プレビューの CSS ピクセル座標」の 3×3 行列を作る。
4. この行列は、キャラクターの描画にのみ使う。背景の矩形の計算には渡さない。
5. 位置は割合で持つため、プレビューの寸法が変わっても(画面の回転を含む)、状態は変わらず、行列だけが再計算される。

### 5.4 描画

1. `PreviewPresenter` が、描画ループと canvas を管理する。
   - カメラ稼働中は毎フレーム描画する。停止中は、状態が変わったとき、または映像の寸法が変わったときに 1 回だけ描画する。
   - リサイズ時は、canvas の内容が消えるため、その場で描き直す。
2. 各フレームの内容:
   1. **背景**:`<video>` の現在のフレームを、`computeContainRect()` で縦横比を保って全体が収まる矩形に描く。切り取りや引き伸ばしはしない。寸法は毎フレーム video 要素から読む。
   2. **前景**:キャラクターを、5.3 の行列で変形し、不透明度を反映して重ねる。
3. 座標系は「プレビューの CSS ピクセル」に統一。canvas の内部解像度は `CSS サイズ × devicePixelRatio`(0.5〜4、長辺 4096 まで)で、CSS サイズと区別して管理する。
4. WebGL2:
   - 行列は `buildPixelToClipMatrix` との積でクリップ座標に変換して、シェーダーに渡す。
   - キャラクターのテクスチャは、2D canvas に描いてからプリマルチプライドアルファでアップロードする(`ImageBitmap` の直接アップロードでは、アルファの扱いが実装依存になるため)。
   - コンテキストの消失(`webglcontextlost`)で描画を止め、復元(`webglcontextrestored`)でリソースを作り直す。
5. Canvas 2D:`setTransform` でアフィン変換を適用する。射影成分は表現できない。
6. 描画中の例外でループを止めない(ログは 1 回だけ)。

### 5.5 フィルター(未実装:Phase 3)

- 設計方針:`filters/` が色変換の定義を提供し、`rendering/` がシェーダーの uniform として適用する。
- 適用範囲(プレビュー・保存)は、Phase 3 の指示に従って確定し、本書を更新する。

### 5.6 撮影・保存(未実装:Phase 4)

- 設計方針:

| 保存の種類 | 内容 | 禁止事項 |
|---|---|---|
| 背景のみ | カメラ映像のフレームだけ | キャラクターを**絶対に含めない** |
| 合成画像 | 背景+変形後のキャラクター | (なし) |

- 背景のみの保存は、キャラクターを描くパスを通さずに生成する。描画後の画面から、キャラクターを後から消す方式は取らない。
- Phase 4 で必要になる事項:
  - 現在のキャラクターの座標は、**プレビュー(canvas 全体)基準**。保存画像は映像の矩形が基準になるため、座標の変換が必要。
  - 画面の向きによって、プレビューの縦横比と映像の contain 矩形が変わる。保存時の座標変換は、向きごとの結果に対しても正しく動く必要がある。
  - WebGL2 の `preserveDrawingBuffer` は現在 `false`。保存方式に合わせて見直す。

### 5.7 Phase 3 で拡張する箇所(設計方針)

- 四隅の座標による射影変換は、`CharacterImageState` に含めず、別の型で扱う。
- `buildCharacterMatrix()` と同じ役割(単位矩形 → 画面座標)を持つ、射影変換の行列に差し替える。`OverlayRenderer.CharacterLayer.matrix` の型は変えない。
- WebGL2 側は、頂点シェーダーを w を扱う形に拡張する。
- Canvas 2D はアフィン変換のみ。フォールバックでの射影変換の扱いは、Phase 3 で決める。
- 四隅ハンドルのタッチ操作も、画面の向きが変わる場合の中断(`GestureHandler.cancel()` 相当)を考慮する。

## 6. 画面の向きへの対応(Phase 2.5)

### 6.1 方針

- 画面の向きの検知と、カメラ映像・描画の更新は、別の処理として扱う。
- 端末の向きと、前面・背面カメラの選択は別の概念。画面を回転しても、前面・背面や `deviceId` は変更しない。
- `screen.orientation.lock()` による向きの固定、`DeviceOrientationEvent` などのセンサー権限の要求は行わない。
- 特定のブラウザの挙動を想定した固定値や、独自の回転補正は入れない。映像の実際の寸法(`video.videoWidth / videoHeight`)を根拠にする。

### 6.2 検知(ViewportWatcher)

- 購読するイベント(存在するものだけ):`window` の `resize` と `orientationchange`、`screen.orientation` の `change`、`visualViewport` の `resize`。
- 向きは、**ウィンドウ全体の寸法**(幅と高さ)から判定する(幅 > 高さで landscape、高さ > 幅で portrait、等しい・不明は square)。プレビュー領域は、パネルの大きさで縦横比が変わるため使わない。
- iOS では回転の直後に寸法が古いことがあるため、イベントが止まってから 250ms 後の値を採用する。連続するイベントは 1 回の通知にまとめる。
- 通知は 2 種類:
  - `onOrientationChangeStart`:向きが変わり始めたと分かった時点(1 回の変化につき 1 回)。
  - `onSettled`:寸法が落ち着いた時点。向きが変わったかどうかを含む。
- リスナーは `start()` で 1 回だけ登録し、`dispose()` で解除する。

### 6.3 カメラ映像の調整(CameraManager.adaptToOrientation)

映像の向きが画面の向きと**食い違っている場合だけ**、次の順で試す。

1. **何もしない**:映像の向きがすでに画面と一致していれば、再取得も `applyConstraints` もしない。判断の根拠は、`getSettings()` ではなく video 要素の実際の寸法。
2. **`applyConstraints()`**:同じトラックに、画面の向きに合わせた幅・高さの `ideal` を要求する(カメラの選択には影響しない)。映像の `resize` か 600ms を待つ。
3. **再取得**:それでも食い違う場合に限り、既存の `openCamera` で**1 回だけ**取得し直す。前面/背面と `deviceId` は維持する。
   - 再取得の失敗時は、一時的なエラー表示を出さず、標準の(横向きの)制約で 1 回だけ復旧を試みる。復旧にも失敗した場合は、通常のエラー表示にする。
   - 再取得しても食い違いが解消しなかった向きは記録し、同じ向きでの再試行をしない(ループ防止)。起動・停止・切り替えで解除する。

競合の防止:
- 調整は、起動・停止・切り替えと同じ直列化のキューに載せる。待機中の調整は 1 件に統合し、連続回転で処理が溜まらない。
- 世代番号により、調整中の停止・切り替え・別の起動で中断する。古いストリームは必ず停止される。
- カメラ権限を不必要に再要求しない(再取得はストリームの取得のみ)。

### 6.4 接続(main.ts)

| タイミング | 処理 |
|---|---|
| 向きが変わり始めた | `GestureHandler.cancel()`(進行中のドラッグ・ピンチを安全に終了) |
| 寸法が落ち着いた | `GestureHandler.cancel()`、`PreviewPresenter.refreshLayout()` |
| 向きが変わった **かつ** タッチ端末 **かつ** カメラ稼働中 | `CameraManager.adaptToOrientation()` |

- タッチ端末の判定は `navigator.maxTouchPoints > 0`。デスクトップでウィンドウを縦長にしても、Web カメラは再取得されない。
- カメラ停止中に向きが変わった場合、調整は行わない。次回の起動は、従来どおり横向きの制約で始まる。
- 縦画面のまま起動した場合は、起動時の調整は走らない(ブラウザが縦向きの映像を返せば食い違わず、`contain` 表示のまま映る)。向きが**変わった**ときだけ調整が走る。

### 6.5 レイアウト(CSS)

- **縦画面(既定)**:Phase 2 のレイアウトを維持する。`aside.camera-side` は `display: contents` にして、4 行グリッド(ヘッダー・プレビュー・パネル・カメラ操作)がそのまま効く。
- **横画面(`@media (orientation: landscape)`)**:2 列グリッド。左がヘッダー+プレビュー(画面の大部分)、右が幅 `clamp(240px, 34vw, 320px)` のサイドバー。
  - サイドバーは縦に並べ、高さが足りない場合はサイドバー全体がスクロールする。カメラ操作ボタンは `position: sticky` で下端に固定する。
  - パネルの操作ボタンは 2 列、カメラ操作は「起動・停止」を 1 行、「切り替え」を全幅の 1 行にする。
- 高さは `100dvh` を優先し、非対応なら `100%`。
- セーフエリア:縦画面は従来どおり。横画面では、左側(ノッチ)はヘッダーの左余白、右側はサイドバーの右余白、下側はサイドバーのカメラ操作の下余白で吸収する。
- CSS の `orientation`(幅 ≥ 高さで landscape)と、`ViewportWatcher` の判定(幅 > 高さで landscape)は、幅と高さがちょうど等しい場合だけ異なる。

### 6.6 キャラクターの維持

- 位置は割合、`scale` は基準サイズに対する倍率で持つため、プレビューの寸法が変わっても、画像と状態は失われず、行列だけが再計算される。
- 回転中の進行中のジェスチャーは、`cancel()` で終了する。指が画面に残っている場合、その指の以後の動きは無視される(指を離して触り直すと、新しい操作になる)。

## 7. 座標系と単位

- **画面座標**:プレビューの左上を原点、単位は CSS ピクセル。`GestureHandler` は、canvas の左上を原点とした座標で受け取る(canvas は表示領域と同じサイズ)。
- **キャラクターの位置**:プレビュー中心を 0 とした、プレビューの幅・高さに対する割合。リサイズ・`devicePixelRatio` の変化・画面の回転があっても、相対位置が保たれる。
- **単位矩形**:中心が原点、(-0.5, -0.5)〜(0.5, 0.5)。画像の左上が (-0.5, -0.5)。
- **クリップ座標**:WebGL の標準(-1〜1、Y が上向き)。変換は `rendering/` の内部に閉じ込める。
- 回転は、Y が下向きの座標系で時計回りが正。

## 8. エラー処理とリソース管理

- 非同期処理(`getUserMedia`、`applyConstraints`、画像デコード、縮小)は、すべて失敗時の処理を持つ。
- ブラウザ API は使用前に存在を確認する(`navigator.mediaDevices`、`WebGL2RenderingContext`、`createImageBitmap`、`requestVideoFrameCallback`、`ResizeObserver`、`screen.orientation`、`visualViewport`、`applyConstraints`)。
- 解放の責任:

| リソース | 解放責任 |
|---|---|
| `MediaStream` のトラック | `camera/`(`CameraManager`) |
| `ImageBitmap` | `image/`(`CharacterImage`) |
| WebGL のテクスチャ・バッファ・プログラム | `rendering/`(`WebGL2Renderer`) |
| 描画ループ・`ResizeObserver`・映像の `resize` リスナー | `rendering/`(`PreviewPresenter`) |
| 映像の `resize` リスナー(状態の解像度用) | `camera/`(`CameraManager.dispose()`) |
| 画面の向きの購読・タイマー | `ui/`(`ViewportWatcher.dispose()`) |
| イベントリスナー | 各 UI クラスの `unbind()` / `dispose()` |

- ユーザー向けのエラーメッセージは、型(種別)と文字列を各モジュールが持ち、表示は `ui/` が行う。

## 9. テスト容易性

- 単体テスト(node 環境)で検証するもの:`transform/`、`camera/CameraSettings.ts`(向きの判定と制約を含む)、`image/ImageLoader.ts` の判定・計算、`image/CharacterImage.ts`(読み込み関数を差し替えて検証)、`rendering/layout.ts`、`rendering/createOverlayRenderer.ts` の選択ロジック、`ui/ViewportWatcher.ts`(偽の環境と偽タイマーで検証)。
- 実機・ブラウザで確認するもの:カメラの実動作、`adaptToOrientation` の実際の効果、WebGL2/Canvas 2D の実描画、縮小処理(2D canvas を使う)、タッチ操作、ファイル選択、横画面のレイアウト、セーフエリア。
- `CameraManager`、`PreviewPresenter`、各 UI クラス、`createBrowserViewportEnvironment()` は、ブラウザ API に依存するため、現時点では単体テストの対象外。
- 詳細は `docs/TEST_PLAN.md` を参照する。

## 10. 今後確定する事項

| 事項 | 確定する Phase |
|---|---|
| 縦画面のまま起動した場合の、起動時の向きの指定(現在は横向きの制約で起動し、向きの変化時のみ調整) | Phase 2.5 の実機確認の結果次第 |
| 前面カメラのプレビューを左右反転表示するか(現在は反転しない)。保存画像への反映は別途決める | 未定(Phase 3 または 4 の指示時) |
| フィルターの適用範囲(プレビュー・保存) | Phase 3 |
| Canvas 2D フォールバックでの射影変換の扱い | Phase 3 |
| キャラクター座標の、保存画像(映像矩形基準)への変換 | Phase 4 |
| WebGL2 の `preserveDrawingBuffer` と保存方式 | Phase 4 |
| PWA の scope・Service Worker のキャッシュ方針 | Phase 5 |
| GitHub Pages 用の公開設定の整備(現在は確認用の最小設定) | Phase 5 |

## 11. 既知の制約・未確認事項(Phase 2.5 時点)

- **未確認**:iPhone Safari・iPhone Chrome・Android Chrome で、画面の回転後に映像の向きが追従するか。`applyConstraints()` が効くか、再取得が必要になるかは、実機での確認が必要。
- **未確認**:回転直後にジェスチャーを続けた場合の体感(`cancel()` 後は、指を離して触り直すまで画像が動かない)。
- 向きの調整は、タッチ端末かつカメラ稼働中に、向きが変わったときだけ走る。
- 再取得しても食い違いが解消しない向きでは、それ以上の再試行を行わず、`contain` 表示のまま映す。
- 極端に狭い横画面(幅 600px 未満など)では、サイドバーの下限幅(240px)により、プレビューが狭くなる。

## 12. Phase 2.5 時点の状態

- 実装済み:Phase 2 までの機能、縦画面・横画面のレイアウト切り替え、画面の向きの検知、カメラ映像の向きの調整(段階的)、回転時のジェスチャー中断、`100dvh` とセーフエリアへの対応。
- 未実装:四隅の自由変形、射影変換、台形補正、遠近感調整、フィルター、色覚シミュレーション、撮影・保存、PWA、公開の整備。
- 実機確認:Phase 2 の確認(iPhone Safari・Chrome)は完了。Phase 2.5 の確認は未実施。