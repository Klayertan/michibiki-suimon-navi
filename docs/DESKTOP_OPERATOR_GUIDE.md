# SuisuiNavi デスクトップ版 運用ガイド (Desktop Operator Guide)

`SuisuiNavi.exe` の使い方。PowerShell も npm も Python も、別のブラウザも不要です。

> **キーボードとゲームパッドによる実機の手動操縦は有効化されていません。**
> Keyboard and gamepad manual flight control of the real aircraft is not enabled.
>
> このアプリにはアーム・離陸・着陸・RTL・スロットル操作が実装されていません。
> 設定でも有効になりません。飛行操作は従来どおり送信機とQGroundControlで行います。

---

## 1. 必要なもの (Requirements)

| 項目 | 内容 |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| Microsoft Edge WebView2 ランタイム | **必須**。Windows 10/11 と Microsoft Edge に標準搭載 |
| Python / Node.js | **不要**（実行するPCには何もインストール不要） |

WebView2 が無い場合、アプリは起動時に明確なメッセージを表示して終了します。
**自動ダウンロードは行いません。** Microsoft の公式サイトから
「Evergreen WebView2 Runtime」を入手してください。

初回起動時に Windows SmartScreen の警告が出ることがあります。
このビルドは**コード署名されていません**。「詳細情報」→「実行」で起動できます。

---

## 2. 起動 (Start)

1. **`SuisuiNavi.exe` をダブルクリックします。**
2. デスクトップウィンドウが開きます（ブラウザは開きません）。
3. バックエンドは自動的に起動します（数秒）。

タイトルバーに動作モードが表示されます:

```
SuisuiNavi — Preview
```

---

## 3. Preview モードの確認 (Verify Preview mode)

起動直後は必ず **Preview** です。確認方法:

* タイトルバーが `SuisuiNavi — Preview`
* 右パネル「PS5コントローラー / Gamepad」を開くと
  **デスクトップ版 / Desktop — Preview mode** バッジが表示される
* ドローンパネルの動作モードが「モック（模擬）モード」

Preview モードでは:

* シリアルポート (COM10) は**開きません**
* 機体には**接続しません**
* テレメトリはすべて模擬データです

---

## 4. キーボード操作のテスト（ドローン不要）

1. 右パネル「PS5コントローラー / Gamepad」を開く
2. **入力ソース / Input source** で「キーボード / Keyboard」を選択
3. **「キーボードをキャプチャ」** ボタンを押す

| キー | 動作（プレビューのみ） |
|---|---|
| W / S | ピッチ 前 / 後 |
| A / D | ロール 左 / 右 |
| ← / → | ヨー 左 / 右 |
| ↑ / ↓ | 上昇 / 下降 入力プレビュー |
| **左Shift を押し続ける** | **Dead-man（これを押している間だけ値が出ます）** |
| **Esc** | 即時中立・キャプチャ解除 |

確認すべき動作:

* 左Shift を離した瞬間、すべての値が 0.000 になる
* Esc でキャプチャが解除される
* テキスト入力欄に文字を打っている間は飛行キーが反応しない
* ウィンドウが非アクティブになると値が 0 になる

**キャプチャは明示的に開始するまで一切キーを奪いません。**

---

## 5. シミュレーションゲームパッドのテスト

1. **入力ソース** で「シミュレーション / Simulated gamepad」を選択
2. 表示されるシミュレーターパネルで **接続** を押す
3. スライダーでスティックを動かし、プレビュー値を確認
4. **突然切断** を押すと、状態が正しく次のように戻ることを確認:

```
Controller   : 未検出 / Not detected
Neutral      : 利用不可 / unavailable
Input active : いいえ / no
Dead-man     : 無効 / inactive — source unavailable
```

コントローラーが未接続のときに「Neutral: active」と表示されることはありません。

`SIMULATION` バッジが常に表示されます。**これは実機ではありません。**

---

## 6. 実機テレメトリへの接続（必要になったときだけ）

### 6.1 事前チェックリスト（すべて必須）

| # | 確認事項 |
|---|---|
| 1 | **プロペラを4枚すべて取り外した** |
| 2 | 機体が DISARMED（解除）状態である |
| 3 | バッテリー電圧が 14.0V 以上ある |
| 4 | 両方のテレメトリ無線にアンテナが接続されている |
| 5 | **QGroundControl を完全に終了した** |
| 6 | デバイスマネージャーで COM10 が存在する |
| 7 | 周囲に人がいない |

### 6.2 Real モードでの起動

Real モードは**明示的に選んだときだけ**有効になります:

```powershell
.\dist\SuisuiNavi\SuisuiNavi.exe --mode real
```

Real モードでも:

* 起動時に COM10 は**開きません**
* 機体には**自動接続しません**
* バックエンドは**読み取り専用**です
* 自動再接続は無効です（切断したポートを勝手に開き直しません）

### 6.3 明示的な接続と切断

1. ドローンパネルで「プロペラを取り外したことを確認しました」にチェック
2. **「接続」** を押す
3. リンク状態が「接続済み」、テレメトリ鮮度が「正常」になることを確認
4. アーム状態が **DISARMED** であることを確認
5. 終了時は **「切断」** を押す

なぜ QGroundControl を閉じる必要があるかは
[`MAVLINK_OPERATOR_GUIDE.md`](./MAVLINK_OPERATOR_GUIDE.md) §4 を参照してください。

---

## 7. 終了 (Close)

ウィンドウを閉じるだけです（×ボタン）。

自動的に次の順で終了します:

1. ウィンドウ位置・サイズを保存
2. MAVLinkリンクを停止し、**シリアルポートを解放**
3. バックエンドを停止
4. ログをフラッシュ
5. 単一インスタンスロックを解放

確認方法（PowerShell）:

```powershell
Get-Process SuisuiNavi -ErrorAction SilentlyContinue
```

何も表示されなければ、プロセスは残っていません。

実測: ウィンドウを閉じてから **2.69秒** で完全終了、残存プロセス 0、
ポート解放済み、WebView2 の子プロセスも 0 でした。

---

## 8. 二重起動 (Second launch)

すでに起動している状態でもう一度 `SuisuiNavi.exe` を実行すると:

```
SuisuiNavi is already running.
Switch to the existing SuisuiNavi window instead of starting a second copy.
```

というメッセージが表示され、**終了コード 3** で終了します。

2つ目のインスタンスは:

* バックエンドを起動しません
* ポートを取りません
* ウィンドウを開きません
* COM10 に触れません
* 動作中のインスタンスを一切妨げません

これは Windows の名前付きミューテックスで保証されています。
クラッシュした場合もロックは自動的に解放されるため、
手動でファイルを削除する必要はありません。

---

## 9. 保存される場所 (Where things are stored)

```
%LOCALAPPDATA%\SuisuiNavi\
  config\desktop.json    ウィンドウ位置・サイズ・UI設定
  logs\                  動作ログ（自動ローテーション）
  calibration\           ゲームパッド校正
  diagnostics\           診断情報・クラッシュログ
```

ログを開く:

```powershell
explorer "$env:LOCALAPPDATA\SuisuiNavi\logs"
```

診断情報を表示（ウィンドウを開かずに）:

```powershell
.\dist\SuisuiNavi\SuisuiNavi.exe --diagnostics
```

**保存されないもの**（意図的に）: Dead-man の状態、押されているキー、
制御値、アーム状態、飛行セッション、コマンド認可、動作モード。
再起動時に危険な状態が復元されることはありません。

---

## 10. 困ったとき (Troubleshooting)

| 症状 | 対処 |
|---|---|
| ウィンドウが開かない・すぐ消える | `%LOCALAPPDATA%\SuisuiNavi\logs\` のログ末尾を確認 |
| 「WebView2 Runtime が必要です」 | Microsoft から Evergreen WebView2 Runtime をインストール |
| 「SuisuiNavi is already running」 | 既存ウィンドウに切り替える。無い場合は数秒待って再実行 |
| SmartScreen の警告 | このビルドは未署名です。「詳細情報」→「実行」 |
| キーボードが反応しない | 入力ソースが「キーボード」か、キャプチャが開始されているか確認 |
| Dead-man が効かない | 左Shift を**押し続ける**必要があります |
| バッテリー・GPSが null のまま（実機） | [`MAVLINK_OPERATOR_GUIDE.md`](./MAVLINK_OPERATOR_GUIDE.md) §5.1 / §6 を参照 |
| COM10 access denied | QGroundControl や他のシリアル端末を終了 |

---

## 11. 安全上の制限（実装済み）

* 起動時は必ず Preview モード
* Preview / SITL では COM ポートを開けません
* Real モードでも自動接続・自動再接続はしません
* キーボード・ゲームパッドは**プレビュー専用**で、機体には送信されません
* アーム・離陸・着陸・RTL・ミッション・GUIDED・RC override・モーターテストは
  **未実装**で、要求しても MAVLink を一切送信せず 501 を返します
* バックエンドは 127.0.0.1 のランダムポートのみで待ち受けます
* 危険な状態は一切保存されません
