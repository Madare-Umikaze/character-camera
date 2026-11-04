# Character Camera:アーキテクチャ設計書

本書は、各モジュールの役割・依存関係・データの流れを定義します。
実装は Phase ごとに進めます。本書は **Phase 2 完了時点** の実装に合わせて更新しており、未実装の部分は「設計方針」と明記しています。

## 1. 設計の基本方針

1. **レイヤー分離**:カメラ映像は背景レイヤー、キャラクター画像は前景レイヤーとして独立して扱う。
2. **変形の適用範囲**:回転・拡大縮小・射影変換・台形補正・四隅自由変形は、**キャラクター画像のみ**に適用する。カメラ映像には適用しない。
3. **ブラウザ内完結**:すべての処理はブラウザ内で行い、画像・映像を外部へ送信しない。サーバーサイド処理とデータベースは存在しない。
4. **責務の分離**:UI、カメラ制御、画像処理、描画、保存を別モジュールにする。
5. **純粋ロジックの分離**:数学的な計算は DOM・WebGL に依存させず、単体テスト可能にする。
6. **状態の分離**:カメラの状態(`CameraState`)とキャラクターの状態(`CharacterImageState`)は、別のオブジェクトで管理する。

## 2. モジュール構成(Phase 2 時点)

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
│   ├── CameraSettings.ts     カメラの型・定数・エラー分類・制約生成(純粋関数)
│   └── CameraManager.ts      起動・停止・切り替え・ストリーム管理
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
│   └── PreviewPresenter.ts       描画ループ・canvas 管理・リサイズ監視
├── ui/           UI
│   ├── CameraView.ts         カメラ画面(ステータス・起動/停止/切り替え)
│   ├── CharacterPanel.ts     画像の操作パネル
│   └── GestureHandler.ts     Pointer Events による移動・ピンチ・ホイール
├── filters/      (未実装:Phase 3)
├── capture/      (未実装:Phase 4)
├── main.ts       エントリーポイント(組み立てのみ)
└── style.css     スタイル

public/shaders/   (未使用。シェーダーは rendering/shaders.ts に文字列で持つ)
tests/            単体テスト(src/ と同じ構成のサブフォルダ)
docs/             設計書・テスト計画
```

## 3. 各モジュールの役割

### 3.1 types/

- 役割:モジュール間で共有する型を定義する。実行時のロジックは持たない(`app.ts` と `character.ts` の初期値定数は例外)。
- 他のどのモジュールにも依存しない。
- **例外**:カメラ専用の型(`CameraState` など)は、純粋関数と一体で管理するため `camera/CameraSettings.ts` に置く。複数モジュールで共有する必要が出た時点で `types/` に移す。

### 3.2 transform/

- 役割:キャラクター画像の変形に関する計算。
  - `matrix.ts`:3×3 行列の積、平行移動・回転・拡大縮小の合成(T×R×S)、点の変換(w による除算あり)、ピクセル座標からクリップ座標への行列。
  - `characterTransform.ts`:状態の正規化(範囲制限・NaN の除去・角度の正規化)、「単位矩形 → 画面座標」の行列の生成、移動・ピンチ・指定点を基準にしたズームの計算。
- DOM・WebGL・カメラに依存しない純粋関数。
- 依存先:`types/`、`gl-matrix`

### 3.3 camera/

- 役割:`getUserMedia` によるカメラの起動・停止・前面背面の切り替え、エラーの分類。
- 操作は直列化し、世代番号で古い操作の結果を破棄する。切り替えや停止では、既存のトラックを必ず `stop()` する。
- 映像のピクセルを加工しない。画像処理や描画の知識を持たない。
- `onFrame()`(`requestVideoFrameCallback`、なければ `requestAnimationFrame`)を用意しているが、現在は未使用。
- 依存先:なし(`CameraSettings.ts` は自己完結)

### 3.4 image/

- 役割:ユーザーが選んだ画像を、描画可能な `ImageBitmap` にして保持する。
  - `ImageLoader.ts`:形式判定(PNG・JPEG・WebP。HEIC は専用エラー)、サイズ検証、`createImageBitmap` によるデコード(EXIF の向きを反映)、長辺 2048px 超の縮小(アルファを保持)。失敗時は例外でなく結果の型で返す。
  - `CharacterImage.ts`:画像と `CharacterImageState` の保持、購読、`ImageBitmap` の `close()` の責任。連続読み込みでは最後の要求だけを採用する。失敗しても表示中の画像は維持する。
- 外部への送信は行わない。
- 依存先:`types/`、`transform/`

### 3.5 rendering/

- 役割:背景(カメラ映像)とキャラクターを、合成プレビューとして描画する。
  - `OverlayRenderer`:WebGL2 と Canvas 2D の共通インターフェース。背景とキャラクターは別のフィールドで渡し、背景の配置(矩形)とキャラクターの行列は呼び出し側が計算して渡す。
  - `WebGL2Renderer`:同じシェーダーを、背景とキャラクターで別の行列を使って描く。キャラクターはプリマルチプライドアルファで合成する。コンテキストの消失・復元に対応する。
  - `Canvas2DRenderer`:アフィン変換のみ対応するフォールバック。
  - `createOverlayRenderer`:WebGL2 を優先し、使えなければ Canvas 2D にフォールバックする。一度 WebGL2 を取得した canvas は 2D を取得できないため、フォールバック時は新しい canvas を作る。`?renderer=canvas2d` で Canvas 2D を強制できる。
  - `PreviewPresenter`:描画ループ、canvas の配置、リサイズ監視、内部解像度の更新。
- 依存先:`types/`、`transform/`、`gl-matrix`
- `camera/`、`image/`、`ui/` には依存しない。映像要素やキャラクターの内容は、`main.ts` が渡す。

### 3.6 ui/

- 役割:DOM の構築、操作の受け取り、状態の表示。
  - `CameraView`:ステータス、起動・停止・切り替え、エラー表示、ページ非表示時の停止。
  - `CharacterPanel`:画像選択、表示/非表示、不透明度、回転、リセット、削除、読み込みエラー表示。
  - `GestureHandler`:Pointer Events による移動(1 本指・マウス)、拡大縮小・回転・移動(2 本指)、ホイールでのズーム。
- 操作対象は、各ファイルで定義した最小のインターフェース(`CameraController`、`CharacterController`、`GestureHost`)だけを使う。`CameraManager` や `CharacterImage` のクラスには依存しない。
- 依存先:`types/`、`transform/`(角度変換とジェスチャー計算)、`camera/CameraSettings.ts`(型と純粋関数のみ)

### 3.7 main.ts

- 役割:各モジュールの生成と接続のみ。ロジックは持たない。
- `CameraManager` と `CharacterImage` は互いを知らない。接続するのは `main.ts` だけ。
- `rendering/` と `ui/` が `image/` に依存しないため、`CharacterImage` から `PreviewContentProvider` と `GestureHost` を作る薄いアダプターをここに置く。

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
- `ui/` が `camera/CameraSettings.ts` を参照するのは、状態の型と日本語の表示文字列を共有するため。ストリーム管理には触れない。

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
                              │ 背景:video → contain 矩形(layout.ts)
                              │ 前景:state → 単位矩形→画面座標の行列(characterTransform.ts)
                              ▼
                         OverlayRenderer(WebGL2 / Canvas 2D)
                              ▼
                         canvas(合成プレビュー)
```

### 5.1 カメラ映像の取得

1. 「起動」ボタンで `CameraManager.start()` が `getUserMedia` を呼ぶ(音声なし、高解像度を `ideal` で要求)。
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

### 5.3 画像の変形(Phase 2:アフィン変換)

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

### 5.4 描画

1. `PreviewPresenter` が、描画ループと canvas を管理する。
   - カメラ稼働中は毎フレーム描画する。停止中は、状態が変わったときに 1 回だけ描画する(停止中も操作が反映される)。
   - リサイズ時は、canvas の内容が消えるため、その場で描き直す。
2. 各フレームの内容:
   1. **背景**:`<video>` の現在のフレームを、`computeContainRect()` で縦横比を保って全体が収まる矩形に描く。切り取りや引き伸ばしはしない。
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
  - WebGL2 の `preserveDrawingBuffer` は現在 `false`。保存方式に合わせて見直す。

### 5.7 Phase 3 で拡張する箇所(設計方針)

- 四隅の座標による射影変換は、`CharacterImageState` に含めず、別の型で扱う。
- `buildCharacterMatrix()` と同じ役割(単位矩形 → 画面座標)を持つ、射影変換の行列に差し替える。`OverlayRenderer.CharacterLayer.matrix` の型は変えない。
- WebGL2 側は、頂点シェーダーを w を扱う形に拡張する。
- Canvas 2D はアフィン変換のみ。フォールバックでの射影変換の扱いは、Phase 3 で決める。

## 6. 座標系と単位

- **画面座標**:プレビューの左上を原点、単位は CSS ピクセル。`GestureHandler` は、canvas の左上を原点とした座標で受け取る(canvas は表示領域と同じサイズ)。
- **キャラクターの位置**:プレビュー中心を 0 とした、プレビューの幅・高さに対する割合。リサイズや `devicePixelRatio` が変わっても、相対位置が保たれる。
- **単位矩形**:中心が原点、(-0.5, -0.5)〜(0.5, 0.5)。画像の左上が (-0.5, -0.5)。
- **クリップ座標**:WebGL の標準(-1〜1、Y が上向き)。変換は `rendering/` の内部に閉じ込める。
- 回転は、Y が下向きの座標系で時計回りが正。

## 7. エラー処理とリソース管理

- 非同期処理(`getUserMedia`、画像デコード、縮小)は、すべて失敗時の処理を持つ。
- ブラウザ API は使用前に存在を確認する(`navigator.mediaDevices`、`WebGL2RenderingContext`、`createImageBitmap`、`requestVideoFrameCallback`、`ResizeObserver`)。
- 解放の責任:

| リソース | 解放責任 |
|---|---|
| `MediaStream` のトラック | `camera/`(`CameraManager`) |
| `ImageBitmap` | `image/`(`CharacterImage`) |
| WebGL のテクスチャ・バッファ・プログラム | `rendering/`(`WebGL2Renderer`) |
| 描画ループ・`ResizeObserver` | `rendering/`(`PreviewPresenter`) |
| イベントリスナー | 各 UI クラスの `unbind()` / `dispose()` |

- ユーザー向けのエラーメッセージは、型(種別)と文字列を各モジュールが持ち、表示は `ui/` が行う。

## 8. テスト容易性

- 単体テスト(node 環境)で検証するもの:`transform/`、`camera/CameraSettings.ts`、`image/ImageLoader.ts` の判定・計算、`image/CharacterImage.ts`(読み込み関数を差し替えて検証)、`rendering/layout.ts`、`rendering/createOverlayRenderer.ts` の選択ロジック。
- 実機・ブラウザで確認するもの:カメラの実動作、WebGL2/Canvas 2D の実描画、縮小処理(2D canvas を使う)、タッチ操作、ファイル選択。
- `CameraManager`、`PreviewPresenter`、各 UI クラスは、ブラウザ API に依存するため、現時点では単体テストの対象外。
- 詳細は `docs/TEST_PLAN.md` を参照する。

## 9. 今後確定する事項

| 事項 | 確定する Phase |
|---|---|
| 前面カメラのプレビューを左右反転表示するか(現在は反転しない)。保存画像への反映は別途決める | 未定(Phase 3 または 4 の指示時) |
| フィルターの適用範囲(プレビュー・保存) | Phase 3 |
| Canvas 2D フォールバックでの射影変換の扱い | Phase 3 |
| キャラクター座標の、保存画像(映像矩形基準)への変換 | Phase 4 |
| WebGL2 の `preserveDrawingBuffer` と保存方式 | Phase 4 |
| PWA の scope・Service Worker のキャッシュ方針 | Phase 5 |
| GitHub Pages 用の公開設定 | Phase 5 |
| 実機(iPhone Safari、Android Chrome)での確認 | Phase 5(公開後) |

## 10. Phase 2 時点の状態

- 実装済み:カメラの起動・停止・切り替え、画像の読み込み、オーバーレイ表示(移動・拡大縮小・回転・不透明度・表示/非表示・削除・リセット)、WebGL2/Canvas 2D の描画、タッチ・マウス操作。
- 未実装:四隅の自由変形、射影変換、台形補正、遠近感調整、フィルター、色覚シミュレーション、撮影・保存、PWA、公開。
- 実機確認:未実施(Phase 5 で実施)。