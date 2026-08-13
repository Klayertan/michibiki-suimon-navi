# 手動操縦ガイド / Manual Control guide

キーボードまたは PS5 コントローラーを、ArduPilot の通常の RC 入力に近い形で使うための手順です。

> **実機では、最初に必ず全プロペラを外してベンチ確認してください。**
> この機能は RC 送信機の代替ではありません。送信機を手元に置き、ArduPilot の
> pre-arm check、EKF、バッテリー、GCS/RC failsafe を有効なまま使用してください。
> 本リファクタの自動確認はモックだけで行い、COM10、Pixhawk、モーター、実飛行では
> 検証していません。

手動出力は既定で無効です。バックエンドを
`SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1` か `-AllowPilotControl` 付きで起動し、
UI で明示的に有効化するまで RC override は出ません。ARM にはさらに safe commands、
接続、新しいテレメトリ、対応モード、明示操作が必要です。

---

## 1. 変更理由とアーキテクチャ

以前の経路は次のとおりでした。

```text
Keyboard / Gamepad
        -> normalized axes
        -> PilotService
        -> send_velocity_setpoint()
        -> SET_POSITION_TARGET_LOCAL_NED
        -> GUIDED mode
```

速度 setpoint は GUIDED external control 用なので、機体が STABILIZE のときは
`PILOT ENABLED` でも `Blocked: Not in GUIDED mode`、`TRANSMITTING = false` に
なるのが旧実装の必然でした。GUIDED 判定だけを外しても STABILIZE がその setpoint を
手動スティックとして解釈するわけではないため、正しい修正にはなりません。

現在の手動経路は次の1本です。

```text
KeyboardProvider ─┐
                  ├─> GamepadController (calibration / normalized axes)
PS5 provider ─────┘
                         -> PilotController (dead-man / sequence / release)
                         -> POST /api/drone/pilot/input
                         -> PilotService (safety gates / RC mapping)
                         -> RC_CHANNELS_OVERRIDE
                         -> Pixhawk / ArduPilot
```

`js/gamepad/` は入力・校正だけを担当し、通信を持ちません。Keyboard と PS5 は
`{pitch, roll, throttle, yaw}` という同じ意味軸で `PilotController` に入り、その後の
安全判定、REST、MAVLink 経路を共有します。

Guided 用の既存経路は削除していません。概念を次のように分離しています。

```text
Manual Control          -> RC_CHANNELS_OVERRIDE
Guided external control -> send_velocity_setpoint()
```

後者は手動ジョイスティック経路から隔離して保持しているだけで、Manual Control UI からは
使用しません。

---

## 2. ひとつの Manual Control パネル

旧 `PS5 Controller / Gamepad` と旧 `Pilot - low-speed test` は、
**手動操縦 / Manual Control** という1枚のパネルに統合されています。

パネルには次が同じ場所に表示されます。

- Input source: `Keyboard` または `PS5 Controller`
- `PREVIEW`、`READY`、`PILOT ENABLED`、`TRANSMITTING`、`FAILSAFE`、`DISCONNECTED`
- Pitch / Roll / Throttle / Yaw と dead-man 状態
- 機体の mode、ARMED/DISARMED、MAVLink、telemetry age
- blocked reason。ボタンより上に表示され、スクロールしなくても理由を確認できます
- プロペラ取り外し確認、Enable Bench Pilot、ARM、DISARM、Neutral / Release
- 折りたたみ式の key/controller mapping、PS5 calibration、raw input、RC safety diagnostics

`TRANSMITTING` はバックエンドが有効な override を実際に送信した状態でのみ点灯します。
単に軸プレビューが動いた、または HTTP 入力が届いたという意味ではありません。
DISARMED は通常の待機状態なので、単独では FAILSAFE にせず `Ready to arm` と表示します。

---

## 3. 入力割り当て

### 3.1 Keyboard

Keyboard capture は Bench Pilot を有効化したときに始まります。テキスト入力、textarea、
select、編集可能領域にフォーカスがある間はキーを奪いません。

| キー | 意味軸 | 動作 |
|---|---|---|
| ↑ / ↓ | `pitch` | 前進 / 後退 |
| ← / → | `roll` | 左 / 右 |
| W / S | `throttle` | 上昇側 / 下降側 |
| A / D | `yaw` | 左ヨー / 右ヨー |
| **Left Shift（保持）** | dead-man | 放すと即 release |
| **Space** | neutral | 全軸 0 + RC override release。モーター kill ではありません |
| **Esc** | emergency input stop | 即 release + Pilot disable |

デジタルキー1つは共通入力層で **quarter-stick (`0.25`)** に制限されます。バックエンドも
Keyboard と Bench Mode に別の保守的な RC deflection limit を適用するため、ブラウザを
変更して full-stick にすることはできません。

### 3.2 PS5 Controller

Mode 2 の意味は次のとおりです。

| 操作 | 意味軸 |
|---|---|
| 左スティック横 | yaw |
| 左スティック縦 | throttle |
| 右スティック横 | roll |
| 右スティック縦 | pitch |

正の意味は forward / right / climb / yaw-right です。物理 raw axis の番号、反転、
中心・最小・最大、deadzone、expo、dead-man button は保存した calibration が権威です。
バックエンドで `L1` の button index を決め打ちしません。provider が校正済みの
`deadmanHeld: true/false` を共通 controller に渡します。

Keyboard 選択時は PS5 の calibration/raw monitor を隠し、`Calibration: not required`
だけを表示します。PS5 選択時だけ Advanced / Calibration と Raw input diagnostics が
表示されます。

---

## 4. RC mapping とパラメータ方針

ArduCopter の標準的な概念は次の対応です。ただし、実機の対応を固定値として仮定しません。

| 標準 channel | 操作 |
|---|---|
| CH1 | Roll |
| CH2 | Pitch |
| CH3 | Throttle |
| CH4 | Yaw |

接続後、バックエンドは `PARAM_REQUEST_READ` で次を読みます。

- `RCMAP_ROLL/PITCH/THROTTLE/YAW`
- `RC1_` から `RC8_` の `MIN/TRIM/MAX/REVERSED`
- `RC_OVERRIDE_TIME`、`RC_OPTIONS`
- Copter 4.5 系の `SYSID_MYGCS`、または新しい firmware の
  `MAV_GCS_SYSID/MAV_GCS_SYSID_HI`（および diagnostic の `MAV_OPTIONS`）

不足している値は再要求しますが、**`PARAM_SET` は一度も送りません**。RC calibration、
timeout、failsafe、arming check をアプリが自動変更することはありません。

normalized axis は `pilot_limits.py` の1つの mapping layer で、実機の RCMAP channel と
MIN/TRIM/MAX/REVERSED に変換されます。正の pitch は forward なので通常は trim から
MIN 側、正の roll/yaw は通常は MAX 側へ向かい、最後に `RCx_REVERSED` を反映します。
Throttle だけは flight-mode semantics を分離します。**STABILIZE の semantic 0 は安全な
low-stick endpoint**（通常 MIN、reversed は MAX）で、正方向だけをそこから上げます。
**ALT_HOLD の semantic 0 は calibrated MIN/MAX midpoint**で、下降/hold/上昇の centered input
として扱います。STABILIZE で throttle 0 を RC3_TRIM にする実装ではありません。

有効な override frame では、4つの primary channel だけに計算済み PWM を入れ、所有しない
CH1-8 は `65535`（ignore）にします。neutral/failsafe/disable では CH1-8 をすべて `0`
（release back to normal RC input）にします。したがって、この実装の「neutral」は4 channel
へ trim を保持することではなく、**override の所有権を解放すること**です。

### 4.1 fail-closed diagnostics

次のどれかなら Manual Control は送信しません。UI の RC diagnostics に理由を表示し、
機体パラメータは書き換えません。

- RCMAP または RC1-8 calibration が未取得、非有限、非整数、不正範囲、重複 mapping
- `RC_OVERRIDE_TIME == 0`（override disabled）
- `RC_OVERRIDE_TIME < 0`（infinite/no-timeout）、非有限、または 15 Hz refresh と
  0.5 秒 input timeout に安全余裕を持てない短すぎる値
- `RC_OPTIONS` の bit 1（値 2、MAVLink override を無視）が有効
- `SYSID_MYGCS` と `MAV_GCS_SYSID` のどちらも取得できない、または取得した許可 ID/range が
  backend source ID と不一致（ArduPilot は RC override で常にこの source ID を検査します）

`RC_OVERRIDE_TIME` は**有限かつ安全な送信間隔より十分長い実機値**が必要です。ソフトウェアはブラウザの
停止通知だけに依存せず、最終的には ArduPilot 側の finite timeout でも通常 RC input に戻れる
構成だけを許可します。

---

## 5. 出力ゲート、rate、release

有効な manual override には、すべてが必要です。

1. `ALLOW_PILOT_CONTROL` が有効
2. Pilot/Bench Pilot が UI で有効
3. MAVLink が connected、telemetry が fresh
4. RC mapping/calibration/timeout diagnostics が valid
5. mode が **STABILIZE または ALT_HOLD**
6. telemetry が **ARMED** を確認
7. 入力 provider が connected/calibrated、sample が fresh
8. Keyboard/PS5 の dead-man が継続して held
9. 入力 sequence が最後に受理した値より新しい

有効化は ARM も mode change も自動実行しません。STABILIZE/ALT_HOLD は RC-style manual
input の対応モードで、GUIDED は要求しません。

override は 15 Hz で更新し、browser input が 0.5 秒途絶えると stale input として release
します。sequence high-water mark は enable/disable を越えて保持され、遅延または replay した
`sequence <= last` のフレームは拒否されます。

Keyboard は held key の repeat event も freshness proof に使います。event stream が止まれば
cached Shift/key を破棄します。focus/visibility/stale/disconnect/WebSocket gate の復旧時も、押したままの
dead-man では自動再開せず、一度 release を観測してから新しく press した入力だけを許可します。

次のイベントは desired movement と `outputActive` を直ちに消し、書き込み可能な link には
all-zero release を送ります。

- Left Shift または configured PS5 dead-man の release
- browser blur、tab hidden、page hidden
- input/provider/controller disconnect、source switch
- WebSocket disconnect、MAVLink disconnect、telemetry stale
- input stale、backend unreachable
- Space、Esc、Pilot disable
- transmission failure、DISARM

通常の gate close では release を 15 Hz で2秒間反復し、意図した link close 前は3 frame の
release burst を試みます。リンクが既に物理的に失われて送れない場合は、最後の防壁として
finite `RC_OVERRIDE_TIME` が機体側で override を失効させます。最後の stick command を再接続後に
復活させることはありません。

---

## 6. 通常 ARM / DISARM

Manual Control パネルの ARM と DISARM は次だけを使用します。

```text
MAV_CMD_COMPONENT_ARM_DISARM (command 400)
ARM:    param1 = 1, param2 = 0
DISARM: param1 = 0, param2 = 0
```

ArduPilot の force value `21196` は定義も送信もせず、pre-arm check を迂回しません。
成功表示には `COMMAND_ACK` の accept と、その後の HEARTBEAT による ARMED/DISARMED の確認が
必要です。ACK reject、timeout、または最終 telemetry 不一致は成功として扱わず、最近の
STATUSTEXT を含む理由を表示します。

ARM の gate:

- safe commands enabled
- connected + fresh telemetry
- 明示的な `confirmed: true` 操作
- vehicle が既知の DISARMED
- Pilot が enabled、RC configuration ready、mode が STABILIZE/ALT_HOLD
- Bench Mode では保存済みの「全プロペラ取り外し」acknowledgement

DISARM は安全方向の操作なので Pilot が既に disabled でも使え、props acknowledgement を
要求しません。ただし safe commands、fresh link、明示確認、通常 command 400、ACK と
HEARTBEAT 確認は省略しません。

モック backend は同じ API と状態遷移をシミュレーションし、結果を simulation と明示します。
実機を ARM できるのは real link が接続されている場合だけです。

**Safe idle（Bench Mode 限定）:** Bench Pilot が enabled の間、DISARMED で待機中・ARM
verification 中・ARM 直後で dead-man の再押下待ち、のいずれの状態でも、RC override は
完全な release（全チャンネル ignore）ではなく roll/pitch/yaw = trim、throttle = 較正済み
safe-low endpoint（STABILIZE の unipolar mapping で MIN 相当）の**ゼロ deflection frame**
を送り続けます。これは ArduPilot に有効な RC 入力を見せ続けるためで、値は常に
`normalized_to_rc_override(pitch=0, roll=0, throttle=0, yaw=0, ...)` から計算され、
実際の movement とは独立です。dead-man を握っていない・disarmed である、という理由で
動きが出ることはありません。この resting state は `pilot.snapshot()["armingInputActive"]`
で判別でき、`transmitting`/`outputActive`（実際の movement）とは別のフラグです。
General（非 Bench）enable はこの変更の対象外で、従来どおり完全 release のままです。

---

## 7. モック受け入れ確認（実機を接続しない）

この確認では COM10、Pixhawk、テレメトリ無線を開きません。

```powershell
# terminal 1
npm run backend:mock -- --allow-pilot-control

# terminal 2
npm run serve
```

`http://localhost:4173/?gamepadMock=1#survey` を開きます。

この query は要求フラグにすぎません。backend status が `mode=mock` を確認した場合だけ simulator
provider が有効になります。real backend では simulator UI を出さず、API も active
`provider=mock` を拒否して release します。

Keyboard flow:

1. Manual Control を開き、Input source を Keyboard にする。
2. props removed の mock acknowledgement をチェックし、Enable Bench Pilot。
3. ARM。UI が mock HEARTBEAT の `ARMED` を確認するまで待つ。
4. Left Shift を保持し W を押す。小さい throttle axis と `TRANSMITTING` を確認。
5. Shift を放し、axis 0、override released、output inactive を確認。
6. DISARM し、mock telemetry が `DISARMED` になることを確認。

PS5 mock flow:

1. Input source を PS5 Controller にし、Simulation を Connect。
2. stick の center/extremes、trigger/dead-man を含む calibration を完了して Save。
3. configured dead-man を保持し、小さく stick を動かして `TRANSMITTING` を確認。
4. dead-man を放し、axis 0、override released、output inactive を確認。
5. sudden disconnect、stale input、focus loss でも同じ release になることを確認。

シミュレータは browser input と mock vehicle state だけです。実機 telemetry ではありません。

---

## 8. 実機ベンチ手順 — 全プロペラ取り外し必須

開始例:

```powershell
.\scripts\dev.ps1 -Real -AllowSafeCommands -AllowPilotControl
```

QGroundControl は COM port を共有できないため終了してください。実際の port/baud、アンテナ、
電源、送信機、周囲の安全を確認し、ランチャーの確認に正直に答えてください。

次の15項目を順番どおり実施します。

1. **すべてのプロペラを取り外す。**
2. 機体が物理的に推力を発生できないことを確認する。
3. real MAVLink を接続する。
4. connected と fresh telemetry、vehicle DISARMED を確認する。
5. 初回 manual bench test は **STABILIZE** を選び、UI の current mode と一致することを確認する。
6. 「すべてのプロペラを取り外した」を acknowledgement する。
7. **Enable Bench Pilot** を押す。これは ARM とは別操作である。
8. **ARM** を1回、通常手順で要求する。失敗した pre-arm check は迂回せず、表示理由を解決するか試験を中止する。
9. HEARTBEAT telemetry が **ARMED** を報告したことを確認する。ACK だけでは進まない。
10. 選択した入力の dead-man（Keyboard は Left Shift、PS5 は configured button）を保持する。
11. throttle を利用可能な最小量だけ入力する。大きい入力や複数軸を同時に試さない。
12. プロペラなしで期待した小さい motor response と `TRANSMITTING` を確認する。異常なら dead-man を放して DISARM。
13. dead-man を放し、即時に `TRANSMITTING` が消え、RC override released/output inactive になることを確認する。
14. **DISARM** を要求し、telemetry が **DISARMED** を報告するまで待つ。
15. すべての motor が停止したことを目視確認してから Pilot を disable し、電源を切る。

`21196`、force-arm、arming-check disable、failsafe disable、RC parameter 自動変更を使って
先へ進んではいけません。ARM が拒否されたら、その拒否は試験結果です。

---

## 9. よくある blocked reason

| 表示 | 意味 / 対処 |
|---|---|
| `pilot_control_disabled` | `-AllowPilotControl` なし。再起動が必要 |
| `not_enabled` / `no_input` | Bench Pilot 未有効、または安全な初期 neutral 状態 |
| `disarmed` | 意図した DISARMED。RC 出力の失敗ではなく `Ready to arm` |
| `wrong_mode` | STABILIZE/ALT_HOLD 以外。アプリは自動で mode を変えない |
| `deadman_released` | dead-man を継続保持していない。release は設計どおり |
| `input_timeout` | 0.5秒以内に新しい入力がない。tab/PC負荷または接続を確認 |
| `telemetry_stale` / `not_connected` | blind command を防止。無線、アンテナ、距離を確認 |
| `rc_configuration_missing` | vehicle parameter の read response 待ち |
| `rc_mapping_invalid` / `rc_calibration_invalid` | QGroundControl で実機設定を点検。アプリは修正しない |
| `rc_override_disabled` | `RC_OVERRIDE_TIME=0`。診断のみ表示し、自動変更しない |
| `rc_override_timeout_infinite` | infinite timeout は拒否。診断のみ表示 |
| `rc_overrides_ignored` | `RC_OPTIONS` が MAVLink override を無視 |
| `rc_gcs_sysid_mismatch` | vehicle が別 GCS system ID だけを許可 |
| `stale_sequence` | 遅延/replay input を拒否。status の `nextSequence` から再同期 |
| `rejected_by_vehicle` / `verify_timeout` | ARM/DISARM の ACK または HEARTBEAT 確認失敗。STATUSTEXT を読む |

---

## 10. 検証済み範囲

- 自動 test と browser acceptance は mock backend のみ
- COM10 を開いていない
- 実 Pixhawk、DualSense、motor、propeller、hover/flight を検証していない
- `send_velocity_setpoint()` は Guided external control 用として保持され、Manual Control から未使用

---

## 11. ARM 拒否の詳細診断 / ARM rejection diagnostics

「ARM rejected: FAILED」しか出ず、詳細な STATUSTEXT が得られない実機報告に対応するために
追加した、読み取り専用の診断です。**ARMING_CHECK/ARMING_SKIPCHK など安全パラメータの変更、
force-arm、事前チェックの迂回は一切行っていません。** これは可視化だけです。

### 11.1 何が増えたか

- **RC INPUT SEEN BY PIXHAWK**（Manual Control パネル常時表示）: 機体自身が送ってくる
  `RC_CHANNELS`（RCMAP で mapping 済み）の roll/pitch/throttle/yaw、RC failsafe
  （`SYS_STATUS` の RC_RECEIVER センサー health bit から判定）、override active、
  override age、pre-arm check health。ブラウザが「送ろうとした値」ではなく、
  **機体自身が実際に見ている値**です。
- **Pre-arm check health**: `SYS_STATUS.onboard_control_sensors_*` の
  `MAV_SYS_STATUS_PREARM_CHECK` bit を PASS/FAIL/UNKNOWN として表示します。個々の
  チェック項目（EKF/compass/GPS/…）までは分解しません — ArduPilot が明示的に返す
  全体の合否だけを伝えます。
- **FS_THR_ENABLE / FS_THR_VALUE**: 読み取るだけで、変更も強制もしません。
  実際の throttle RC 入力と並べて表示します。
- **ARM evidence snapshot**: `vehicleReason`（STATUSTEXT）が取得できなかった ARM 拒否
  でのみ表示。mode、armed、pre-arm health、実際の throttle PWM、RC3 の MIN、
  FS_THR_*、override 状態、dead-man 状態を、その瞬間の生データとしてそのまま表示します。
  **原因を断定する文言は一切出しません。**

### 11.2 実機診断チェックリスト（次回 ARM 試行時に報告する項目）

プロペラを外した状態で、ARM を1回試行したあと、Manual Control パネルから次を報告してください。
これだけで次の診断に十分な情報になります。推測は不要です。

1. **Pre-arm check health**（PASS / FAIL / UNKNOWN）
2. **実際の roll PWM**（RC INPUT SEEN BY PIXHAWK の Roll 行）
3. **実際の pitch PWM**
4. **実際の throttle PWM**
5. **実際の yaw PWM**
6. **RC override**（Active / Released）
7. **RC failsafe**（YES / NO / UNKNOWN）
8. **ARM result**（Command result 行、例: `ARM FAILED`）
9. **Vehicle reason**（あれば STATUSTEXT の全文。なければ「no detailed reason received」+
   その下の evidence ブロック全体）

これらが判明した原因（Safety Switch、RC 未較正、throttle failsafe、EKF、compass、
accelerometer、battery、その他の正当な ArduPilot pre-arm 条件）を指し示していても、
このアプリはそれをソフトウェアで迂回しません。実機側の設定・状態として報告し、
QGroundControl 側で対処してください。

実機での最初の確認は §8 の propellers-removed bench です。プロペラを付けた試験手順は、
このベンチ結果と実機 RC mapping/timeout diagnostics をレビューするまで本書の範囲外です。
