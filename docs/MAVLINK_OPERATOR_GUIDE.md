# MAVLink 運用ガイド (Operator guide)

Holybro X500 V2（Pixhawk 6C / ArduCopter 4.5.7）のテレメトリを SuisuiNavi に表示するための手順書。

> **この統合はアーム・離陸・着陸・RTL・スロットル操作を実装していません。**
> 設定フラグでも有効になりません。機体を飛ばす操作は従来どおり送信機と
> QGroundControl で行ってください。

---

## 1. 初回セットアップ（1回だけ）

```bash
npm install
```

```bash
npm run backend:setup
```

`backend:setup` はリポジトリ内に `.venv` を作成し、`backend/requirements-dev.txt`
をそこにインストールします。グローバルの Python 環境は変更しません。
`.venv` は `.gitignore` 済みでコミットされません。

---

## 2. 毎回の起動（モックモード）

実機なしで UI を動かす通常の開発手順です。

```bash
npm run dev
```

フロントエンド `http://localhost:4173/` とモックバックエンド
`http://127.0.0.1:8787/` が同時に起動します。Ctrl+C で両方停止します。

別々のターミナルで動かす場合:

```bash
npm run serve
```

```bash
npm run backend:mock
```

ブラウザで `http://localhost:4173/#survey` を開き、右パネルの
**ドローン / MAVLink** カードを展開してください。

Windows のランチャーを使う場合:

```powershell
.\scripts\dev.ps1
```

---

## 3. 実機モード（COM10）

### 3.1 事前チェックリスト（すべて必須）

| # | 確認事項 |
|---|---|
| 1 | **プロペラを4枚すべて取り外した** |
| 2 | 機体が DISARMED（解除）状態である |
| 3 | バッテリーを接続し、電圧が 14.0V 以上ある |
| 4 | 両方のテレメトリ無線にアンテナが接続されている |
| 5 | **QGroundControl を完全に終了した** |
| 6 | デバイスマネージャーで COM10 が存在する |
| 7 | 周囲に人がいない |

### 3.2 起動

```powershell
.\scripts\dev.ps1 -Real
```

`YES` と入力するまで COM10 は開きません。

コマンドを使わず、テレメトリの読み取りだけ行う場合はこれで十分です。
バックエンドは既定で **読み取り専用** です。

フライトモード変更まで行う場合のみ:

```powershell
.\scripts\dev.ps1 -Real -AllowSafeCommands
```

npm から起動する場合:

```bash
npm run backend:real
```

### 3.3 接続

1. パネルの「プロペラを取り外したことを確認しました」に**実際に取り外してから**チェック
2. 「接続」を押す
3. リンク状態が「接続済み」、テレメトリ鮮度が「正常」になることを確認
4. アーム状態が **DISARMED** であることを確認

### 3.4 停止

バックエンドのターミナルで **Ctrl+C**。
GCSハートビートを停止し、シリアルポートを解放してから終了します。

> **重要:** バックエンドが動いている間、機体側では GCS ハートビートが
> 届いている状態になります。GCS failsafe は 5 秒・RTL に設定されています。
> **飛行中にバックエンドを停止しないでください。** 地上での使用に限定してください。

---

## 4. なぜ QGroundControl を閉じる必要があるのか

Windows はシリアルポートを**1つのプロセスにのみ**割り当てます。
QGroundControl が COM10 を開いていると、このバックエンドは開けません
（逆も同じです）。バックエンドはこの状態を検出し、次のように報告します:

```
Serial port COM10 is already in use by another program.
QGroundControl and this backend cannot both own COM10 —
close QGroundControl (or any other GCS / serial terminal) and try again.
```

パラメータ変更・キャリブレーション・ファームウェア更新は引き続き
QGroundControl で行い、そのときはバックエンドを停止してください。

---

## 5. MAVLink 接続設定

| 項目 | 値 |
|---|---|
| 機体側ポート | TELEM2 |
| `SERIAL2_PROTOCOL` | 2 (MAVLink2) |
| `SERIAL2_BAUD` | 57 (= 57600) |
| PC側ポート | COM10 |
| ボーレート | 57600 |
| 機体 System ID | 1 |
| 地上局 System ID | 255 |
| 地上局 Component ID | 190 |

これらの機体側パラメータは**この統合では変更しません**。

### 5.1 テレメトリストリームの自動要求

機体の HEARTBEAT を最初に受信した直後（初回接続時・再接続のたびに毎回）、
バックエンドは自動的に以下のテレメトリストリームを要求します
（`MAV_CMD_SET_MESSAGE_INTERVAL`、コマンドID 511）。

| メッセージ | ID | レート | 周期 (µs) |
|---|---|---|---|
| SYS_STATUS（バッテリー） | 1 | 1 Hz | 1,000,000 |
| GPS_RAW_INT（GPS） | 24 | 2 Hz | 500,000 |
| ATTITUDE（姿勢） | 30 | 10 Hz | 100,000 |
| GLOBAL_POSITION_INT（統合位置） | 33 | 5 Hz | 200,000 |
| VFR_HUD（対地速度・高度） | 74 | 2 Hz | 500,000 |
| BATTERY_STATUS（バッテリー詳細） | 147 | 1 Hz | 1,000,000 |

**なぜ必要か:** ArduPilot（他の多くのオートパイロットも同様）は、GCS側から
明示的に要求されない限り、新しく接続したリンクに HEARTBEAT（と、ArduPilot
の場合は時刻同期用の TIMESYNC）以外のメッセージを送信しません。
QGroundControl や Mission Planner がこの挙動に気づかれにくいのは、それらの
アプリが接続直後に自動でこの種の要求を送っているためです。本バックエンドは
これまでこの要求を送っておらず、そのためフライトモードとアーム状態
（HEARTBEATのみで得られる情報）は正しく表示される一方、バッテリー・GPS・
姿勢・対地速度は常に null のままでした。

この自動要求は:

* **読み取り専用のテレメトリ設定**であり、フライトコマンドではありません。
  アーム・モード変更・機体の移動は一切行いません。
* `SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS` の設定に**関係なく**、常に送信されます
  （読み取り専用モードでも送信されます）。
* GCSハートビート（1Hz）の送信を妨げません。6件の要求はブロッキングなしで
  送信され、送信自体は数ミリ秒で完了します。
* 個々のストリームが一つ拒否・未対応でも、バックエンドやリンクを異常終了
  させません。**6件すべてが拒否・未応答の場合のみ**、バックエンドエラーとして
  表示されます（`error.kind === "stream_request"`）。

`REQUEST_DATA_STREAM`（旧式のストリーム要求方式）は使用していません。
ArduCopter 4.5.7 は `MAV_CMD_SET_MESSAGE_INTERVAL` に完全対応しているため、
フォールバックは実装していません。

---

## 6. トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| **COM10 access denied / port_busy** | QGroundControl か別のシリアル端末がポートを保持 | QGroundControl を終了。他に Mission Planner・Tera Term・Arduino IDE のシリアルモニタが開いていないか確認 |
| **ポートが見つからない (port_not_found)** | 無線ドングル未接続、ポート番号違い | デバイスマネージャー → ポート(COM & LPT) で実際の番号を確認し `npm run backend:real -- --port COM7` のように指定 |
| **ハートビートが来ない** | 機体の電源が入っていない／無線がペアリングしていない／ボーレート不一致 | 両方の無線の緑LEDが**点灯**（点滅ではない）していることを確認。`SERIAL2_BAUD` と `--baud` を一致させる |
| **ボーレートが違う** | 57600 以外に設定されている | QGroundControl で `SERIAL2_BAUD` を確認し、`--baud` を合わせる |
| **テレメトリ途絶（stale）** | 電波が弱い／障害物／干渉 | アンテナの向きと距離を確認。3秒以上メッセージが来ないと「途絶」、10秒でリンク喪失 |
| **リンク喪失 → 再接続中** | 一時的な電波切れ | 自動的に再接続します。復帰しない場合は無線の電源を確認 |
| **GPS Fix が「測位なし」** | 屋内では正常な動作 | GNSS は屋内で測位できません。屋外の開けた場所で 3D_FIX と衛星10個以上を確認 |
| **バックエンド応答なし** | バックエンド未起動 | `npm run backend:mock` を実行。`http://127.0.0.1:8787/api/health` が応答するか確認 |
| **コマンドが無効（読み取り専用）** | `ALLOW_SAFE_COMMANDS=0`（既定） | `npm run backend:mock`（モック）または `.\scripts\dev.ps1 -Real -AllowSafeCommands` |
| **ARMED 警告が出る** | 機体がアーム状態 | 送信機または QGroundControl で解除。アーム中はすべてのコマンドが拒否されます |
| **モード変更が verify_timeout** | ACK は返ったが機体がモードを報告しない | 機体側で拒否された可能性。QGroundControl で実際のモードを確認 |
| **バッテリー・GPS・姿勢が null のまま（フライトモード/アームは表示される）** | テレメトリストリーム要求（§5.1）が全て拒否・未応答 | ステータス欄のエラーに `telemetry` を含むメッセージが出ていないか確認。出ている場合はバックエンドログで `telemetry stream ... not accepted` を確認し、機体のファームウェアが `MAV_CMD_SET_MESSAGE_INTERVAL` に対応しているか（ArduCopter 4.5系は対応済み）を確認。一度切断→再接続すると要求をやり直します |

---

## 7. 安全上の制限（実装済み）

* 実機モードは既定ではありません（`SUISUI_MAVLINK_MODE=mock`）
* 実機接続時、バックエンドは既定で読み取り専用です
* 実機接続には毎回「プロペラ取り外し確認」が必要です
* 変更できるフライトモードは **STABILIZE / ALT_HOLD の2つのみ**、**解除中のみ**
* 機体が ARMED を報告した時点で、すべてのコマンドを拒否します
* アーム状態が**不明**な場合も拒否します（「たぶん解除」とは扱いません）
* テレメトリ途絶中はコマンドを拒否します
* モード変更は機体のハートビートで確認できるまで成功を報告しません
* アーム・離陸・着陸・RTL・ミッション・GUIDED・RC override・モーターテストは
  **未実装**で、要求すると MAVLink を一切送信せずに 501 を返します
* バックエンドは 127.0.0.1 のみで待ち受けます
* 自動テレメトリストリーム要求（§5.1）は読み取り専用の設定コマンドのみで、
  アーム・モード変更・機体移動のコマンドは一切含まれません

---

## 8. バックエンドの安全な停止

1. ブラウザのパネルで「切断」を押す（任意）
2. バックエンドのターミナルで **Ctrl+C**

Ctrl+C により、GCS ハートビートの停止 → ワーカースレッドの停止 →
シリアルポートのクローズ、の順で終了します。
ポートは即座に解放され、QGroundControl から使えるようになります。

---

## 9. 統合を取り消す方法

追加されたファイルを削除し、変更された3ファイルを戻すだけです。
機体側のパラメータは一切変更していないため、機体側の作業は不要です。

```bash
git checkout -- index.html package.json .gitignore README.md docs/DRONE_LINK_PLAN.md
```

```bash
rm -rf backend js/drone css/drone.css .venv docs/MAVLINK_INTEGRATION_REPORT.md docs/MAVLINK_OPERATOR_GUIDE.md tests/browser/drone-panel.spec.js tests/unit/drone-formatters.test.js tests/unit/drone-store.test.js scripts/venv.mjs scripts/setup-backend.mjs scripts/run-backend.mjs scripts/run-pytest.mjs scripts/dev-all.mjs scripts/dev.ps1
```

確認:

```bash
npm test
```

---

## 10. まだ実装していないもの（今後の段階）

以下は**未実装**です。実装済みとして扱わないでください。

* ミッションプランニング・ウェイポイントのアップロード
* GUIDED モードでの位置指令
* RTL / LAND の実行
* Jetson との連携
* 圃場境界に追従した飛行
* ジオフェンス
* 農業用画像取得

次の段階として安全なのは、**このバックエンドを読み取り専用のまま地上で
運用し、テレメトリログを SuisuiNavi の記録機能に統合すること**です。
飛行制御の自動化は、その先の別課題として扱ってください。
