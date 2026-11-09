# Character Camera:アーキテクチャ設計書

本書は、各モジュールの役割・依存関係・データの流れを定義します。
実装は Phase ごとに進めます。本書は **Phase 3 完了時点(実装完了、動作確認待ち)** の実装に合わせて更新しています。未実装の部分は「設計方針」、実機・ブラウザで未確認の部分は「未確認」と明記しています。

## 1. 設計の基本方針

1. **レイヤー分離**:カメラ映像は背景レイヤー、キャラクター画像は前景レイヤーとして独立して扱う。
2. **変形の適用範囲**:回転・拡大縮小・左右反転・射影変換・台形補正・四隅自由変形は、**キャラクター画像のみ**に適用する。カメラ映像には適用しない。
3. **ブラウザ内完結**:すべての処理はブラウザ内で行い、画像・映像を外部へ送信しない。サーバーサイド処理とデータベースは存在しない。
4. **責務の分離**:UI、カメラ制御、画像処理、描画、保存を別モジュールにする。
5. **純粋ロジックの分離**:数学的な計算は DOM・WebGL に依存させず、単体テスト可能にする。
6. **状態の分離**:カメラの状態(`CameraState`)、キャラクターの基本変形(`CharacterImageState`)、キャラクターの射影変換(`PerspectiveState`)は、別のオブジェクトで管理する。
7. **検知と対処の分離**:画面の向きの検知(`ViewportWatcher`)と、カメラ映像・描画の更新は、別の処理として設計する。
8. **不正な状態を持たない**:四隅は、検証を通った有効な凸四角形だけを状態として保持する。

## 2. モジュール構成(Phase 3 時点)

```text
src/
├── types/        共通の型
│   ├── app.ts            アプリ情報(Phase 0 の動作確認用)
│   ├── geometry.ts       点・サイズ・矩形・2 本指の位置
│   ├── character.ts      基本変形の状態・画像情報・読み込みエラー・スナップショット
│   └── perspective.ts    四隅(Quad)・頂点の番号・射影変換の状態
├── transform/    変形の数学(純粋関数)
│   ├── matrix.ts                 3×3 行列(gl-matrix のラッパー、倍精度)
│   ├── Homography.ts             ホモグラフィの計算・逆行列・失敗の検出
│   ├── characterTransform.ts     基本変形の正規化・移動/ピンチ/ズームの計算
│   ├── Transform2D.ts            基本変形の行列(左右反転を含む)・座標変換
│   └── PerspectiveTransform.ts   四隅の検証・スライダー・頂点の移動・射影行列の合成
├── camera/       カメラ制御
│   ├── CameraSettings.ts     カメラの型・定数・エラー分類・制約生成・向きの判定(純粋関数)
│   └── CameraManager.ts      起動・停止・切り替え・向きの調整・ストリーム管理
├── image/        画像読み込み・保持
│   ├── ImageLoader.ts        ファイル検証・デコード・縮小
│   └── CharacterImage.ts     画像と状態(基本変形・射影変換)の保持・リソース解放・購読
├── rendering/    描画
│   ├── layout.ts                 contain 矩形・canvas 内部解像度の計算(純粋関数)
│   ├── OverlayRenderer.ts        描画器の共通インターフェース
│   ├── shaders.ts                GLSL(文字列定数。背景用・キャラクター用)
│   ├── WebGL2Renderer.ts         WebGL2 描画(射影変換を画素ごとの逆変換で描く)
│   ├── Canvas2DRenderer.ts       Canvas 2D 描画(フォールバック。射影はメッシュ近似)
│   ├── createOverlayRenderer.ts  描画方式の選択
│   └── PreviewPresenter.ts       描画ループ・canvas 管理・リサイズ監視・射影行列の組み立て
├── ui/           UI
│   ├── CameraView.ts         カメラ画面(ステータス・起動/停止/切り替え・サイドバー構造)
│   ├── CharacterPanel.ts     画像の操作パネル(スライダー・ボタン)
│   ├── GestureHandler.ts     Pointer Events:ハンドル・移動・ピンチ・ホイール・中断
│   ├── PerspectiveHandles.ts 四隅ハンドルと輪郭線の表示(操作は受けない)
│   └── ViewportWatcher.ts    画面の寸法と向きの変化の監視
├── filters/      (未実装:Phase 4 以降)
├── capture/      (未実装:Phase 4 以降)
├── main.ts       エントリーポイント(組み立てのみ)
└── style.css     スタイル(縦画面・横画面・ハンドル)

public/shaders/   (未使用。シェーダーは rendering/shaders.ts に文字列で持つ)
tests/            単体テスト(src/ と同じ構成のサブフォルダ)
docs/             設計書・テスト計画
.github/workflows/deploy.yml   GitHub Pages へのデプロイ(確認用に前倒しで追加)
```

## 3. 各モジュールの役割

### 3.1 types/

- 役割:モジュール間で共有する型を定義する。実行時のロジックは持たない(`app.ts`、`character.ts`、`perspective.ts` の初期値定数は例外)。
- 他のどのモジュールにも依存しない(`character.ts` が `perspective.ts` の型を参照するのみ)。
- `perspective.ts`:頂点の順序(左上・右上・右下・左下)を `Quad` の型と `CORNER_INDICES` で固定する。`UNIT_QUAD`(変形なし)と `DEFAULT_PERSPECTIVE_STATE` を定義する。
- **例外**:カメラ専用の型(`CameraState`、`LayoutOrientation` など)は、純粋関数と一体で管理するため `camera/CameraSettings.ts` に置く。

### 3.2 transform/

- 役割:キャラクター画像の変形に関する計算。すべて DOM・WebGL・カメラに依存しない純粋関数。
  - `matrix.ts`:3×3 行列の積、平行移動・回転・拡大縮小の合成(T×R×S)、点の変換(w による除算あり)、ピクセル座標からクリップ座標への行列。**計算結果は倍精度**。GPU に渡す直前だけ `mat3ToFloat32Array` で単精度にする。
  - `Homography.ts`:4 点の対応から 3×3 の射影変換行列(h33 = 1)を求める。8 個の未知数の連立一次方程式を、部分ピボット選択付きガウス消去法で解く。逆行列(余因子法)、行列式、失敗の検出(`non-finite`・`degenerate`・`unstable`)を持つ。
  - `characterTransform.ts`:基本変形の状態の正規化(範囲制限・NaN の除去・角度の正規化)、「単位矩形 → 画面座標」の行列(拡大縮小 → 回転 → 平行移動)、移動・ピンチ・指定点を基準にしたズームの計算。
  - `Transform2D.ts`:基本変形の行列 `Base = Place · F`(左右反転を含む)、ローカル座標と画面座標の相互変換、四隅の画面座標への変換。
  - `PerspectiveTransform.ts`:四隅の検証(`validateQuad`)、遠近感スライダーから四隅への変換、1 頂点の移動(不正な位置では境界で止める)、ハンドルの最近傍の選択、射影行列 `P = Base · H` の合成。
- 依存先:`types/`、`gl-matrix`、`transform/` 内部(循環なし:`matrix` ← `Homography`、`characterTransform` ← `Transform2D`・`PerspectiveTransform`)。

### 3.3 camera/

- 役割:`getUserMedia` によるカメラの起動・停止・前面背面の切り替え、エラーの分類、画面の向きへの映像の調整。
  - `CameraSettings.ts`:型、定数、エラー分類、制約の生成、向きの判定。すべて純粋関数。
  - `CameraManager.ts`:ストリーム管理。起動・停止・切り替え・向きの調整は**直列化**し、世代番号で古い操作の結果を破棄する。切り替えや停止では、既存のトラックを必ず `stop()` する。
- 映像のピクセルを加工しない。画像処理や描画の知識を持たない。**Phase 3 では変更していない。**
- 映像の `resize` イベントを監視し、状態の解像度(`info.resolution`)を実際の `videoWidth / videoHeight` に追従させる。再取得はしない。
- 向きの調整(`adaptToOrientation`)は 7.3 で説明する。
- 依存先:なし(`CameraSettings.ts` は自己完結)

### 3.4 image/

- 役割:ユーザーが選んだ画像を、描画可能な `ImageBitmap` にして保持する。
  - `ImageLoader.ts`:形式判定(PNG・JPEG・WebP。HEIC は専用エラー)、サイズ検証、`createImageBitmap` によるデコード(EXIF の向きを反映)、長辺 2048px 超の縮小(アルファを保持)。失敗時は例外でなく結果の型で返す。
  - `CharacterImage.ts`:画像と、基本変形(`state`)・射影変換(`perspective`)の保持、購読、`ImageBitmap` の `close()` の責任。連続読み込みでは最後の要求だけを採用する。失敗しても表示中の画像は維持する。
  - 新しい画像の読み込み・削除・「すべてリセット」で、基本変形と四隅は初期値に戻る。以前の変形は残らない。
- 外部への送信は行わない。画面の向きには関与しない。
- 依存先:`types/`、`transform/`

### 3.5 rendering/

- 役割:背景(カメラ映像)とキャラクターを、合成プレビューとして描画する。
  - `OverlayRenderer`:WebGL2 と Canvas 2D の共通インターフェース。背景とキャラクターは別のフィールドで渡す。背景の配置(矩形)とキャラクターの行列(射影行列 `P`)は、呼び出し側が計算して渡す。
  - `WebGL2Renderer`:**背景用とキャラクター用の 2 つのプログラム**を持つ。背景はアフィンの矩形だけを描く。キャラクターは、頂点シェーダーで四隅の位置を求め、フラグメントシェーダーで画素ごとに逆行列を掛けて UV を求める。プリマルチプライドアルファで合成し、透過 PNG の透明部分を保つ。コンテキストの消失・復元に対応する。初期化の途中で失敗した場合は、作成済みの GPU リソースを解放する。
  - `Canvas2DRenderer`:行列がアフィンなら 1 回の `drawImage`。射影成分を含む場合は、10×10 のメッシュに分割し、三角形ごとのアフィン変換で近似する。
  - `createOverlayRenderer`:WebGL2 を優先し、使えなければ(シェーダーのコンパイル失敗を含む)Canvas 2D にフォールバックする。一度 WebGL2 を取得した canvas は 2D を取得できないため、フォールバック時は新しい canvas を作る。`?renderer=canvas2d` で Canvas 2D を強制できる。
  - `PreviewPresenter`:描画ループ、canvas の配置、リサイズ監視、内部解像度の更新。キャラクターの射影行列 `P = Base · H` を組み立てる。
- 映像の寸法は**毎フレーム video 要素から読む**。
- 依存先:`types/`、`transform/`、`gl-matrix`
- `camera/`、`image/`、`ui/` には依存しない。映像要素やキャラクターの内容は、`main.ts` が渡す。

### 3.6 ui/

- 役割:DOM の構築、操作の受け取り、状態の表示、画面の向きの検知。
  - `CameraView`:ステータス、起動・停止・切り替え、エラー表示、ページ非表示時の停止。パネルとカメラ操作を `aside.camera-side` にまとめる。
  - `CharacterPanel`:画像選択、表示/非表示、左右反転、不透明度・回転・横の遠近・縦の遠近のスライダー、ハンドルの表示切り替え、形状リセット、すべてリセット、削除、読み込みエラー表示。
  - `GestureHandler`:Pointer Events による操作。ハンドルの近くを触れば四隅の頂点を動かし、それ以外は移動(1 本指・マウス)、拡大縮小・回転・移動(2 本指)、ホイールでのズーム。`cancel()` で進行中の操作を安全に終了する。
  - `PerspectiveHandles`:四隅のハンドル(丸)と輪郭線の表示。`pointer-events: none` で操作は受けない。
  - `ViewportWatcher`:`resize`、`orientationchange`、`screen.orientation` の `change`、`visualViewport` の `resize` を購読し、寸法が落ち着いた時点で通知する。存在しない API はスキップする。
- 操作対象は、各ファイルで定義した最小のインターフェース(`CameraController`、`CharacterController`、`GestureHost`)だけを使う。`CameraManager` や `CharacterImage` のクラスには依存しない。
- 依存先:`types/`、`transform/`(角度変換・ジェスチャーの計算・ハンドルの最近傍の選択)、`camera/CameraSettings.ts`(型と純粋関数のみ)

### 3.7 main.ts

- 役割:各モジュールの生成と接続。ロジックは持たない。
- `CameraManager` と `CharacterImage` は互いを知らない。接続するのはここだけ。
- `rendering/` と `ui/` が `image/` に依存しないため、`CharacterImage` から `PreviewContentProvider` と `GestureHost` を作る薄いアダプターをここに置く。
- ハンドルの画面位置の計算(`buildBaseMatrix` と `mapQuadToScreen` の呼び出し)と、画面座標からローカル座標への変換(`screenToLocal`)も、このアダプターが行う。計算そのものは `transform/` にある。
- `ViewportWatcher` の通知を、ジェスチャーの中断・描画サイズの更新・ハンドルの位置の更新・カメラの調整に振り分ける(7.4)。

### 3.8 filters/、capture/(未実装)

- `filters/`:フィルターと色覚シミュレーションの定義。
- `capture/`:撮影・保存。

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
- `rendering/WebGL2Renderer` は、シェーダーに渡す逆行列を求めるため、`transform/Homography` の `invertHomography` を使う。

## 5. データの流れ

全体像:

```text
[カメラ] ──MediaStream──▶ <video>(1px・透明。描画元としてだけ DOM に残す)
                              │
[ファイル] ──File──▶ ImageLoader ──ImageBitmap──▶ CharacterImage ◀── CharacterPanel(スライダー・ボタン)
                                          state(基本変形)+ perspective(四隅)
                                                       │  ▲
                                                       │  └── GestureHandler(ハンドル・ドラッグ・ピンチ・ホイール)
                                                       ▼
   main.ts のアダプター ──▶ PreviewPresenter
                              │ 背景:video(毎フレーム videoWidth/Height)→ contain 矩形(layout.ts)
                              │ 前景:P = Base · H(Transform2D.ts と PerspectiveTransform.ts)
                              ▼
                         OverlayRenderer(WebGL2 / Canvas 2D)
                              ▼
                         canvas(合成プレビュー)

   main.ts のアダプター ──▶ PerspectiveHandles(四隅の丸と輪郭線。画面位置 = Base · 四隅)

[window / screen / visualViewport] ──▶ ViewportWatcher ──▶ main.ts ──┬─▶ GestureHandler.cancel()
                                                                    ├─▶ PreviewPresenter.refreshLayout()
                                                                    ├─▶ ハンドルの位置の更新
                                                                    └─▶ CameraManager.adaptToOrientation()
```

### 5.1 カメラ映像の取得

1. 「起動」ボタンで `CameraManager.start()` が `getUserMedia` を呼ぶ(音声なし、高解像度を `ideal` で要求)。通常の起動の制約は、横向きの幅・高さの `ideal`。
2. 初期は背面カメラ(`facingMode: ideal environment`)。切り替えは、既存ストリームを停止してから新しいストリームを取得する(iOS Safari は 2 つのカメラを同時に開けないため)。
3. `MediaStream` を `<video>` の `srcObject` に設定し、`muted`・`autoplay`・`playsinline` で再生する。
4. `<video>` は `hidden` や `display: none` にせず、1px・透明で DOM に置く。画面に映像を表示するのは canvas。
5. エラーは種別に分類して日本語メッセージで表示する。ページが非表示になるとカメラを停止し、復帰時の自動再起動はしない。
6. 映像ピクセルには、変形を一切加えない。

### 5.2 キャラクター画像の読み込み

1. 「画像を選択」で `<input type="file" accept="image/*">` を開く。
2. `ImageLoader` が形式とサイズを検証する(PNG・JPEG・WebP。HEIC は専用メッセージ。上限 30MB)。
3. `createImageBitmap(file, { imageOrientation: 'from-image' })` でデコードする。長辺 2048px を超える場合は 2D canvas で縮小する。透過 PNG のアルファは保持される。
4. `CharacterImage` が `ImageBitmap` と情報を保持し、基本変形と四隅を初期値にする。前の `ImageBitmap` は `close()` する。
5. 失敗した場合は、表示中の画像と状態を維持し、エラーだけを表示する。連続して選んだ場合は、最後の要求の結果だけを採用する。
6. ファイルの内容は外部へ送信しない。

### 5.3 画像の変形

変形の全体式、座標系、適用順序は第6章で定義する。ここでは、操作から描画までの流れを示す。

1. **基本変形**(`CharacterImageState`:`x`、`y`、`scale`、`rotation`、`opacity`、`visible`、`flipX`)
   - `GestureHandler`(ハンドルから離れた位置のドラッグ・2 本指・ホイール)、`CharacterPanel`(不透明度・回転・表示・左右反転)が、`CharacterImage.updateState()` を通して更新する。範囲内に正規化される。
2. **射影変換**(`PerspectiveState`:`corners`、`horizontal`、`vertical`)
   - **四隅の個別移動**:
     1. `GestureHandler` が、ハンドルの近くに触れた 1 本目の指で、最も近い頂点を掴む。
     2. 移動のたびに、画面上の目標位置を `GestureHost.moveHandle` に渡す。
     3. `main.ts` のアダプターが、`screenToLocal(Base)` で画像ローカル座標へ戻す。
     4. `CharacterImage.moveCorner` から `moveCornerInState` を経て `moveCorner` が呼ばれる。
     5. 目標位置が有効ならそのまま動かす。無効なら、現在位置から目標への線分を二分探索し、有効な範囲の境界で止める。
   - **遠近感スライダー**:`CharacterImage.setPerspectiveSliders(h, v)` が、両方の値から四隅を再計算して**置き換える**。個別に動かした四隅は上書きされる。四隅の個別移動は、スライダーの値を変えない。
   - **形状リセット**:四隅とスライダーだけを初期値に戻す。基本変形は維持する。
   - **すべてリセット**:基本変形と四隅のすべてを初期値に戻す。
3. `PreviewPresenter` が `P = Base · H` を組み立て、キャラクターの行列として描画器に渡す。背景の矩形の計算には、キャラクターの状態は一切入らない。
4. `main.ts` が、同じ `Base` で四隅を画面座標に変換し、ハンドルと輪郭線の位置を更新する。

### 5.4 描画

1. `PreviewPresenter` が、描画ループと canvas を管理する。
   - カメラ稼働中は毎フレーム描画する。停止中は、状態が変わったとき、または映像の寸法が変わったときに 1 回だけ描画する。
   - リサイズ時は、canvas の内容が消えるため、その場で描き直す。
2. 各フレームの内容:
   1. **背景**:`<video>` の現在のフレームを、`computeContainRect()` で縦横比を保って全体が収まる矩形に描く。切り取りや引き伸ばしはしない。
   2. **前景**:キャラクターを、射影行列 `P` で変形し、不透明度を反映して重ねる。
3. 座標系は「プレビューの CSS ピクセル」に統一。canvas の内部解像度は `CSS サイズ × devicePixelRatio`(0.5〜4、長辺 4096 まで)。
4. **WebGL2**:
   - 背景:矩形の行列だけを使う専用プログラム(`mediump`)。不透明、ブレンドなし。
   - キャラクター:射影専用プログラム(フラグメントは `highp`)。
     - TypeScript 側で、クリップ座標への行列 `pixelToClip · P` と、その逆行列を求めて渡す。逆行列が求まらない(特異な)場合は、キャラクターだけ描かない。
     - 頂点シェーダー:単位矩形の 4 頂点に行列を掛け、`w` で割って、変形後の四隅の位置にする。
     - フラグメントシェーダー:画素ごとに逆行列を掛け、`w` で割って UV を求める。画像全体が射影変換として扱われる。
     - テクスチャは、2D canvas に描いてからプリマルチプライドアルファでアップロードする。
   - コンテキストの消失(`webglcontextlost`)で描画を止め、復元(`webglcontextrestored`)でリソースを作り直す。
5. **Canvas 2D**:アフィンなら `setTransform` と 1 回の `drawImage`。射影成分を含むなら、10×10 のメッシュの三角形ごとにアフィン変換で描く(近似)。
6. 描画中の例外でループを止めない(ログは 1 回だけ)。

### 5.5 フィルター(未実装)

- 設計方針:`filters/` が色変換の定義を提供し、`rendering/` がシェーダーの uniform として適用する。
- 適用範囲(プレビュー・保存)は、該当する Phase の指示に従って確定し、本書を更新する。

### 5.6 撮影・保存(未実装)

- 設計方針:

| 保存の種類 | 内容 | 禁止事項 |
|---|---|---|
| 背景のみ | カメラ映像のフレームだけ | キャラクターを**絶対に含めない** |
| 合成画像 | 背景+変形後のキャラクター | (なし) |

- 背景のみの保存は、キャラクターを描くパスを通さずに生成する。描画後の画面から、キャラクターを後から消す方式は取らない。
- 保存で必要になる事項:
  - キャラクターの座標は、**プレビュー(canvas 全体)基準**。保存画像は映像の矩形が基準になるため、`Base` と `P` を、保存画像の座標系で組み立て直す必要がある。四隅(ローカル座標)は、座標系に依存しないため、そのまま使える。
  - 画面の向きによって、プレビューの縦横比と映像の contain 矩形が変わる。保存時の座標変換は、向きごとの結果に対しても正しく動く必要がある。
  - 保存画像でも射影変換を再現する必要がある。WebGL2 の描画をそのまま使うか、Canvas 2D のメッシュ近似で十分かは、保存の指示の際に判断する。
  - WebGL2 の `preserveDrawingBuffer` は現在 `false`。保存方式に合わせて見直す。

## 6. 変形の定義(座標系・行列・適用順序)

### 6.1 座標系

| 名前 | 定義 |
|---|---|
| 画像ローカル座標 | 画像の中心が原点、x が右、y が下。画像全体は (-0.5, -0.5)〜(0.5, 0.5)(単位矩形)。UV は (x + 0.5, y + 0.5) |
| 画面座標 | プレビューの左上が原点、単位は CSS ピクセル、y が下 |
| クリップ座標 | WebGL の標準(-1〜1、y が上)。`rendering/` の内部に閉じ込める |
| 四隅の座標 | 画像ローカル座標。**基本変形を適用する前**の値で持つ |

### 6.2 行列の定義

- 点は列ベクトル `(x, y, 1)ᵀ`。行列は左から掛け、結果 `(x', y', w')` を `w'` で割って点にする。
- `Mat3` は列優先で 9 要素。(行 r, 列 c)の要素は `m[3c + r]`。
  `x' = m[0]x + m[3]y + m[6]`、`y' = m[1]x + m[4]y + m[7]`、`w' = m[2]x + m[5]y + m[8]`。
- ホモグラフィは `h33 = m[8] = 1` に正規化する。
- `multiplyMat3(A, B)` は **B を先に適用**する。
- 回転は、y が下向きの座標系で時計回りが正(ラジアン)。

### 6.3 適用順序(統一)

```text
画面座標の点 = Place · F · H · (画像ローカル座標の点)       ← 右が先に適用される

H     : 単位矩形 → 変形後の四隅(PerspectiveTransform.ts / Homography.ts)
F     : 左右反転。flipX のとき diag(-1, 1, 1)、それ以外は単位行列(Transform2D.ts)
Place : 拡大縮小 → 回転 → 平行移動(characterTransform.ts の buildCharacterMatrix)

Base = Place · F        (Transform2D.ts の buildBaseMatrix)
P    = Base · H         (PerspectiveTransform.ts の composeProjection。描画に渡す行列)
```

- 基本変形は、変形後の形ごと動かす。
- 左右反転は `Place` の内側で適用される。画像自身の縦軸で、変形後の形全体を鏡映する。画面上の回転の向きや、2 本指操作の挙動は、反転の有無に影響されない。
- ハンドルの画面位置は `Base · corners[i]`。ドラッグ時は `Base⁻¹` で画面座標を画像ローカル座標に戻す。

### 6.4 ホモグラフィの計算(Homography.ts)

- 4 点の対応(`source[i] → destination[i]`)から、次の 2 式を 4 組並べた 8 個の未知数の連立一次方程式を解く。
  - `h11·x + h12·y + h13 − x'·(h31·x + h32·y) = x'`
  - `h21·x + h22·y + h23 − y'·(h31·x + h32·y) = y'`
- 解法は、部分ピボット選択付きガウス消去法。ピボットが係数の最大値に対して小さい場合は特異とみなす(`PIVOT_EPSILON = 1e-10`)。
- 解いた後に、次の検算を行い、通らなければ失敗として返す(例外は投げない)。
  - 逆行列が求まるか(行列式が、行列の大きさの 3 乗に対して `1e-10` 以下なら特異)
  - 4 点が目的の位置に写るか(残差。許容は `1e-6 × (1 + 目的座標の最大絶対値)`)
  - 4 点で `w` の符号が揃っているか
- 失敗の理由:`non-finite`(入力が有限でない)、`degenerate`(特異)、`unstable`(残差が大きい・`w` の符号が揃わない)。
- 逆行列は余因子法(`invertHomography`)。特異・非有限なら `null`。
- `h33 = 1` の正規化は、元の 4 点が原点の近くにあることを前提にしている(画像ローカル座標の単位矩形)。

### 6.5 不正な変形の防止(validateQuad)

次の順に検査し、最初に当てはまったものを理由にする。

| 理由 | 検出内容 |
|---|---|
| `non-finite` | NaN・無限大 |
| `out-of-range` | 座標の絶対値が 20 超 |
| `coincident-vertices` | 辺の長さが 0.05 未満 |
| `self-intersecting` | 対辺(0-1 と 2-3、1-2 と 3-0)が交差(端点が接する場合を含む) |
| `concave` | 連続する辺の外積の符号が混在 |
| `reversed` | 外積がすべて負(頂点の順序が逆・鏡像) |
| `sharp-corner` | 角の sin が 0.1 未満(約 5.7° 未満・ほぼ一直線) |
| `too-small` | 面積が 0.02 未満(単位矩形は 1) |
| `homography-failed` | ホモグラフィの計算に失敗 |

- 画像が画面外にはみ出すこと自体は、有効として扱う。
- `reversed` は、四隅の側では拒否する。左右反転は `flipX` で別に扱う。
- 状態に入るのは、有効な四隅だけ。`CharacterImage` が、更新のたびに正規化し、無効なら初期状態に戻す。
- 頂点の個別移動(`moveCorner`)で、目標位置が無効な場合は、現在位置から目標への線分を 40 回の二分探索で絞り、有効な範囲で最も遠い点に止める。1 頂点だけを動かすとき、凸性の条件は 3 本の半平面になるため、ハンドルは境界で安定して止まる。辺の長さ・角度・面積の条件は半平面ではないため、境界の位置は厳密ではない。

### 6.6 遠近感スライダー

- `horizontal`、`vertical`(-1〜1)から、四隅を次のように計算する(`h = horizontal × 0.4`、`v = vertical × 0.4`)。
  - 左上 `(-0.5(1+v), -0.5(1+h))`、右上 `(0.5(1+v), -0.5(1-h))`、右下 `(0.5(1-v), 0.5(1-h))`、左下 `(-0.5(1-v), 0.5(1+h))`
- 横方向が正で左辺が高く(手前に)、縦方向が正で上辺が広くなる。
- スライダーの全範囲の組み合わせで、有効な凸四角形になる(単体テストで格子状に検証)。
- **平面画像の射影変換による視覚的な近似**であり、3D カメラの姿勢を推定するものではない。

## 7. 画面の向きへの対応(Phase 2.5)

### 7.1 方針

- 画面の向きの検知と、カメラ映像・描画の更新は、別の処理として扱う。
- 端末の向きと、前面・背面カメラの選択は別の概念。画面を回転しても、前面・背面や `deviceId` は変更しない。
- `screen.orientation.lock()` による向きの固定、`DeviceOrientationEvent` などのセンサー権限の要求は行わない。
- 映像の実際の寸法(`video.videoWidth / videoHeight`)を根拠にする。

### 7.2 検知(ViewportWatcher)

- 購読するイベント(存在するものだけ):`window` の `resize` と `orientationchange`、`screen.orientation` の `change`、`visualViewport` の `resize`。
- 向きは、**ウィンドウ全体の寸法**から判定する(幅 > 高さで landscape、高さ > 幅で portrait、等しい・不明は square)。
- 回転の直後は寸法が古いことがあるため、イベントが止まってから 250ms 後の値を採用する。連続するイベントは 1 回の通知にまとめる。
- 通知は 2 種類:`onOrientationChangeStart`(向きが変わり始めたとき)と `onSettled`(寸法が落ち着いたとき)。
- リスナーは `start()` で 1 回だけ登録し、`dispose()` で解除する。

### 7.3 カメラ映像の調整(CameraManager.adaptToOrientation)

映像の向きが画面の向きと**食い違っている場合だけ**、次の順で試す。

1. **何もしない**:すでに一致していれば、再取得も `applyConstraints` もしない。
2. **`applyConstraints()`**:同じトラックに、画面の向きに合わせた幅・高さの `ideal` を要求する。映像の `resize` か 600ms を待つ。
3. **再取得**:それでも食い違う場合に限り、**1 回だけ**取得し直す。前面/背面と `deviceId` は維持する。失敗時は、標準の制約で 1 回だけ復旧を試み、それも失敗したらエラー表示にする。再取得しても食い違いが解消しなかった向きでは、再試行しない。

競合の防止:調整は、起動・停止・切り替えと同じ直列化のキューに載せ、待機中の調整は 1 件に統合する。世代番号で、停止・切り替え・別の起動の割り込みを検知して中断する。

### 7.4 接続(main.ts)

| タイミング | 処理 |
|---|---|
| 向きが変わり始めた | `GestureHandler.cancel()`(ハンドルのドラッグを含め、進行中の操作を安全に終了) |
| 寸法が落ち着いた | `GestureHandler.cancel()`、`PreviewPresenter.refreshLayout()`、ハンドルの位置の更新 |
| 向きが変わった **かつ** タッチ端末 **かつ** カメラ稼働中 | `CameraManager.adaptToOrientation()` |

- プレビュー領域の大きさが変わったとき(パネルの高さの変化を含む)も、`ResizeObserver` でハンドルの位置を更新する。
- タッチ端末の判定は `navigator.maxTouchPoints > 0`。

### 7.5 レイアウト(CSS)

- **縦画面(既定)**:ヘッダー・プレビュー・パネル・カメラ操作の 4 行。`aside.camera-side` は `display: contents`。パネルは、高さの上限 `38svh` の中でスクロールする。
- **横画面(`@media (orientation: landscape)`)**:2 列グリッド。左がヘッダー+プレビュー、右が幅 `clamp(260px, 34vw, 340px)` のサイドバー(パネル+カメラ操作)。サイドバー内でスクロールし、カメラ操作は下端に固定する。
- 高さは `100dvh` を優先し、非対応なら `100%`。セーフエリアは、縦画面・横画面とも `env(safe-area-inset-*)` で吸収する。

### 7.6 キャラクターの維持

- 位置は割合、`scale` は基準サイズに対する倍率、四隅は画像ローカル座標で持つ。プレビューの寸法が変わっても(画面の回転を含む)、状態は変わらず、行列とハンドルの位置だけが再計算される。

## 8. 四隅ハンドルの操作

- ハンドルの表示は `PerspectiveHandles`(丸と輪郭線の SVG、`pointer-events: none`)。操作は下の canvas が `GestureHandler` で受ける。
- **掴む**:1 本目のポインターが、いずれかのハンドルから一定距離以内に触れたら、**最も近いハンドル**を掴む。距離が同じなら番号の小さいほう。四隅が近接していても、最近傍が選ばれる。
  - 半径:タッチ・ペンは 28px、マウスは 16px。見た目の半径(18px)より広くして、指の誤差を吸収する。
- **ずれの保持**:掴んだ時点のハンドルと指の位置のずれを保ち、ハンドルが指の位置へ飛ばない。
- **掴んでいる間**:ほかの指を無視する。画像の移動やピンチは起きない。操作中のハンドルは拡大して黄色にし、ほかは薄くする。
- ハンドルから離れた位置で触れたときは、画像の移動・ピンチ(Phase 2.5 と同じ動作)。
- 画面の回転時は、`cancel()` でドラッグを終了する。
- 画像が画面外にはみ出した頂点は、表示領域の外にあり、見えず、掴めない。その場合は「形状リセット」で戻せる。
- 「ハンドルを隠す」で、ハンドルと輪郭線を隠せる(変形は維持される)。

## 9. エラー処理とリソース管理

- 非同期処理(`getUserMedia`、`applyConstraints`、画像デコード、縮小)は、すべて失敗時の処理を持つ。
- ブラウザ API は使用前に存在を確認する。
- 解放の責任:

| リソース | 解放責任 |
|---|---|
| `MediaStream` のトラック | `camera/`(`CameraManager`) |
| `ImageBitmap` | `image/`(`CharacterImage`) |
| WebGL のプログラム・バッファ・VAO・テクスチャ | `rendering/`(`WebGL2Renderer`)。初期化の途中失敗でも解放する |
| Canvas 2D の半透明描画用の canvas | `rendering/`(`Canvas2DRenderer.dispose()`) |
| 描画ループ・`ResizeObserver`・映像の `resize` リスナー | `rendering/`(`PreviewPresenter`) |
| 映像の `resize` リスナー(状態の解像度用) | `camera/`(`CameraManager.dispose()`) |
| 画面の向きの購読・タイマー | `ui/`(`ViewportWatcher.dispose()`) |
| イベントリスナー | 各 UI クラスの `unbind()` / `dispose()` |

- シェーダーのコンパイル・リンクの失敗は、ログつきの例外になり、`createWebGL2Renderer` が捕捉して Canvas 2D にフォールバックする。
- ユーザー向けのエラーメッセージは、型(種別)と文字列を各モジュールが持ち、表示は `ui/` が行う。

## 10. テスト容易性

- 単体テスト(node 環境)で検証するもの:`transform/` の全ファイル(`Homography`、`PerspectiveTransform`、`Transform2D` を含む)、`camera/CameraSettings.ts`、`image/ImageLoader.ts` の判定・計算、`image/CharacterImage.ts`、`rendering/layout.ts`、`rendering/createOverlayRenderer.ts` の選択ロジック、`ui/ViewportWatcher.ts`。
- 実機・ブラウザで確認するもの:カメラの実動作、WebGL2 の射影描画、Canvas 2D のメッシュ近似、ハンドルのタッチ操作、ファイル選択、横画面のレイアウト、セーフエリア。
- `CameraManager`、`PreviewPresenter`、`WebGL2Renderer`、`Canvas2DRenderer`、各 UI クラスは、ブラウザ API に依存するため、単体テストの対象外。
- 詳細は `docs/TEST_PLAN.md` を参照する。

## 11. 数値精度に関する注意

- gl-matrix の `mat3.create()` は、既定で単精度(Float32Array)を返す。画面座標(数百)を含む行列を合成すると、約 3×10⁻⁵ の丸め誤差が出る。
- そのため `matrix.ts` は、計算結果を通常の配列(倍精度)で受け取る。GPU に渡す直前だけ、`mat3ToFloat32Array` で単精度に変換する。
- キャラクター用のフラグメントシェーダーは `highp`(WebGL2 の仕様で、フラグメントシェーダーでも利用できる)。背景用は `mediump`。

## 12. 今後確定する事項

| 事項 | 確定する Phase |
|---|---|
| 前面カメラのプレビューを左右反転表示するか(現在は反転しない)。保存画像への反映は別途決める | 未定(保存またはフィルターの指示時) |
| フィルターの適用範囲(プレビュー・保存) | フィルターの Phase |
| 保存画像での射影変換の再現方式(WebGL2 の再利用か、メッシュ近似か) | 保存の Phase |
| キャラクター座標の、保存画像(映像矩形基準)への変換 | 保存の Phase |
| WebGL2 の `preserveDrawingBuffer` と保存方式 | 保存の Phase |
| PWA の scope・Service Worker のキャッシュ方針 | PWA の Phase |
| GitHub Pages 用の公開設定の整備(現在は確認用の最小設定) | PWA・公開の Phase |
| 四隅の検証のしきい値(辺 0.05・角の sin 0.1・面積 0.02)の妥当性 | 実機での操作確認の結果次第 |

## 13. 既知の制約・未確認事項(Phase 3 時点)

- **未確認**:`npm run check`(型チェック・テスト・ビルド)の結果。第9回までのコードは、私は実行しておらず、結果の報告を受けていない。
- **未確認**:WebGL2 での射影描画の見た目、透過 PNG の縁、ハンドルのタッチ操作。PC ブラウザ・iPhone Safari・iPhone Chrome・Android Chrome のいずれも、確認の報告はまだない。
- Canvas 2D のメッシュ近似は、極端な変形で WebGL2 と見た目が少し異なる。不透明度が 1 未満のときは、別の canvas を経由して継ぎ目を抑えるが、その canvas を作れない場合は、継ぎ目が見える可能性がある。
- 遠近感スライダーを動かすと、個別に調整した四隅は上書きされる(四隅の個別移動は、スライダーの表示値を変えない)。
- 画面外にはみ出した頂点は掴めない。「形状リセット」で戻す。
- 回転直後に指を離さず操作を続けると、画像やハンドルが動かない場合がある(`cancel()` の仕様。指を離して触り直すと復帰する)。
- 四隅は頂点の順序が逆になる状態(鏡像)を拒否する。鏡映は「左右反転」で行う。
- Android Chrome は、Phase 2 の時点から確認の報告がない。

## 14. Phase 3 時点の状態

- 実装済み:Phase 2.5 までの機能、左右反転、四隅の個別移動(ハンドル)、射影変換による台形補正、横・縦方向の遠近感スライダー、形状リセット、不正な変形の検出と境界での停止、WebGL2 の射影描画、Canvas 2D のメッシュ近似、ハンドルの表示・非表示。
- 未実装:フィルター、色覚シミュレーション、撮影・保存、PWA、公開の整備。
- 動作確認:Phase 2.5 までは、PC・iPhone Safari・iPhone Chrome で確認済み(利用者の報告による)。**Phase 3 は確認待ち**。