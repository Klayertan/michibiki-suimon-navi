# MAVLink 運用ガイド / Operator guide

Holybro X500 V2（Pixhawk 6C / ArduCopter 4.5.7）向け telemetry と、明示的に有効化した
Manual Control の運用境界を説明します。

> 通常起動と実機起動は既定で manual output を許可しません。Manual Control は
> `-AllowPilotControl`、ARM/DISARM は `-AllowSafeCommands` が必要です。
> takeoff、land、RTL、mission、motor test、raw caller-selected RC frame、parameter write は
> 未実装です。force-arm と safety bypass はありません。

実機 Manual Control の前に [PILOT_CONTROL_GUIDE.md](PILOT_CONTROL_GUIDE.md) の
propellers-removed 15-step bench procedure を必ず実施してください。本リファクタでは COM10 と
実 Pixhawk を使わず、mock backend だけで自動確認しています。

---

## 1. 初回 setup

```bash
npm install
npm run backend:setup
```

`backend:setup` は repository 内の `.venv` に dependency を入れます。

---

## 2. Mock mode — hardware なし

通常の telemetry UI:

```bash
npm run dev
```

Manual Control と mock ARM/DISARM acceptance:

```powershell
# terminal 1
npm run backend:mock -- --allow-pilot-control

# terminal 2
npm run serve
```

- frontend: `http://localhost:4173/`
- backend: `http://127.0.0.1:8787/`

`backend:mock` は safe commands が有効です。mock ARM/DISARM は command/ACK/HEARTBEAT state flow を
シミュレーションし、result を simulation と明示します。serial port、COM10、telemetry radio は
開きません。

---

## 3. Real mode

### 3.1 読み取り専用

1. 全プロペラを外す。
2. vehicle が DISARMED であることを確認。
3. telemetry radio の両アンテナ、battery、周囲の安全を確認。
4. QGroundControl、Mission Planner、serial terminal を終了する。
5. Device Manager で port と baud を確認する。既定は COM10 / 57600。

```powershell
.\scripts\dev.ps1 -Real
```

`YES` confirmation なしに real port を開きません。safe command と pilot output は無効です。

### 3.2 Mode command のみ

```powershell
.\scripts\dev.ps1 -Real -AllowSafeCommands
```

safe commands は既知の DISARMED + fresh link で STABILIZE/ALT_HOLD mode change、read-only
version/stream requests を許可します。

### 3.3 Manual Control bench

```powershell
.\scripts\dev.ps1 -Real -AllowSafeCommands -AllowPilotControl
```

real-link confirmation と pilot confirmation は別です。その後も UI の props acknowledgement、
Enable Bench Pilot、ARM は3つの別操作です。起動 flag だけで ARM や mode change は起きません。

Windows は同じ serial port を複数 process に割り当てないため、backend 使用中は QGroundControl を
閉じます。parameter 設定・firmware update・calibration が必要なら backend を停止し、QGroundControl
で行ってください。

---

## 4. 接続設定と telemetry

| 項目 | 既定値 |
|---|---|
| vehicle port | TELEM2 |
| `SERIAL2_PROTOCOL` | 2 (MAVLink2) |
| `SERIAL2_BAUD` | 57 (= 57600) |
| PC port | COM10 |
| backend source system/component | 255 / 190 |
| target system | 1 |

アプリはこれらの vehicle parameter を変更しません。

最初の HEARTBEAT と再接続後、backend は次の stream を
`MAV_CMD_SET_MESSAGE_INTERVAL` で read-only request します。

| Message | ID | Rate |
|---|---:|---:|
| SYS_STATUS | 1 | 1 Hz |
| GPS_RAW_INT | 24 | 2 Hz |
| ATTITUDE | 30 | 10 Hz |
| GLOBAL_POSITION_INT | 33 | 5 Hz |
| VFR_HUD | 74 | 2 Hz |
| BATTERY_STATUS | 147 | 1 Hz |

これは aircraft state を変える command ではなく、telemetry を送るよう要求するだけです。
`ALLOW_SAFE_COMMANDS` が無効でも実行され、個別 stream の unsupported/reject は link 全体を停止
しません。

---

## 5. Manual Control transport

### 5.1 二つの異なる control concept

```text
Manual Control          -> RC_CHANNELS_OVERRIDE (message 70)
Guided external control -> send_velocity_setpoint()
                           SET_POSITION_TARGET_LOCAL_NED (message 84)
```

旧 Manual Pilot は後者を使用したため GUIDED が必要で、STABILIZE では
`Blocked: Not in GUIDED mode` でした。現在の Keyboard/PS5 path は前者だけを使用し、
**STABILIZE / ALT_HOLD** を support します。backend は enable/ARM 時に mode を自動変更しません。
Guided velocity sender は別用途の低レベル interface として保持されています。

### 5.2 Read-only RC discovery

接続後に `PARAM_REQUEST_READ` で次を取得し、不足値は retry します。

- `RCMAP_ROLL/PITCH/THROTTLE/YAW`
- `RC1_MIN/TRIM/MAX/REVERSED` から `RC8_*`
- `RC_OVERRIDE_TIME`、`RC_OPTIONS`
- Copter 4.5 系の `SYSID_MYGCS`、または新しい
  `MAV_GCS_SYSID/MAV_GCS_SYSID_HI`（optional diagnostic `MAV_OPTIONS`）

標準 mapping は CH1 Roll / CH2 Pitch / CH3 Throttle / CH4 Yaw ですが、実際の RCMAP が権威です。
primary axes は実 channel の MIN/TRIM/MAX/REVERSED で PWM に変換し、active frame の他 CH1-8 は
`65535` (ignore) です。

Throttle は mode-aware です。STABILIZE の semantic 0 は calibrated low-stick endpoint
（reversed channel は反対 endpoint）で、ALT_HOLD の 0 は calibrated MIN/MAX midpoint です。
したがって pitch-only の STABILIZE frame が throttle trim/half-stick を送ることはありません。

release frame は CH1-8 がすべて `0` です。これは ArduPilot に override を解除して normal RC input
へ戻す指示であり、trim command の保持ではありません。

このアプリは **`PARAM_SET` を実装/送信しません**。次の状態では fail closed し、diagnostic を
表示するだけです。

- missing/invalid RCMAP または RC1-8 calibration
- `RC_OVERRIDE_TIME == 0` (override disabled)
- `RC_OVERRIDE_TIME < 0`、non-finite、または sender cadence に対して短すぎる timeout
- `RC_OPTIONS` の bit 1（値 2）が MAVLink RC override を ignore
- legacy/new GCS-ID parameter が未取得、または常時適用される許可 ID/range と backend source ID が mismatch

finite positive `RC_OVERRIDE_TIME` が必須なので、browser/backend/radio が同時に失われても autopilot
側 timeout が最後の override を永久に保持しません。値をアプリが勝手に書き換えることはありません。

### 5.3 Runtime gates と release

Manual output は次をすべて要求します。

- `ALLOW_PILOT_CONTROL` + UI Pilot enabled
- connected/fresh MAVLink telemetry
- valid RC configuration
- STABILIZE または ALT_HOLD
- known ARMED telemetry
- fresh, monotonic-sequence input
- connected/calibrated selected provider
- continuously held Keyboard/PS5 dead-man

active override は 15 Hz、browser input timeout は 0.5 s です。dead-man release、focus/tab/page loss、
provider/controller/WebSocket/MAVLink disconnect、telemetry/input stale、source switch、Space、Esc、disable、
transmit failure、DISARM では desired axes と output-active state を消し、all-zero release を送ります。
通常は2秒間反復し、graceful link close 前は3-frame burst を試みます。再接続しても古い stick state は
復活しません。各 transport session で vehicle telemetry/RC parameter cache を捨て、再取得が完了するまで
fail closed します。provider/WebSocket gate の復旧後も dead-man release/re-press が必要です。

---

## 6. Normal ARM / DISARM

API:

```http
POST /api/drone/arm
Content-Type: application/json

{"confirmed": true}
```

```http
POST /api/drone/disarm
Content-Type: application/json

{"confirmed": true}
```

送る command は `MAV_CMD_COMPONENT_ARM_DISARM` (400) だけです。

| Operation | param1 | param2 |
|---|---:|---:|
| ARM | 1 | **0** |
| DISARM | 0 | **0** |

`21196` force value は codebase に定義せず、ArduPilot の通常 safety check を bypass しません。
どちらも safe commands、explicit confirmation、fresh link、`COMMAND_ACK` acceptance、その後の
HEARTBEAT state confirmation が必要です。ACK reject や telemetry verify timeout は成功ではありません。

ARM はさらに vehicle DISARMED、Pilot enabled、valid RC config、STABILIZE/ALT_HOLD を要求し、Bench
Mode なら stored props-removed acknowledgement も要求します。DISARM は安全方向なので Pilot が
disable 済みでも実行でき、props ack は要求しません。既に DISARMED なら telemetry state を返して
command を重ねて送りません。

ARM は takeoff ではありません。Pilot enable も ARM ではありません。いずれも自動連鎖しません。

---

## 7. UI status の意味

- `PREVIEW`: input monitor、manual output disabled
- `READY`: link/configuration が利用可能で output inactive
- `PILOT ENABLED`: control channel enabled。ARM または dead-man を意味しない
- `TRANSMITTING`: backend が active RC override を送信中
- `FAILSAFE`: active session 中の safety event で release
- `DISCONNECTED`: telemetry link が usable でない

Vehicle `DISARMED` は別表示です。意図した disarmed state は `Ready to arm` であり、それだけでは
FAILSAFE にしません。blocked reason と RC diagnostics は action button より上に表示されます。

---

## 8. Troubleshooting

| Symptom | Cause / response |
|---|---|
| port busy / access denied | QGroundControl 等を完全終了。port 番号を再確認 |
| heartbeat なし | vehicle power、paired radio、antenna、baud を確認 |
| telemetry stale | blind command を防ぐため全 command/override を拒否。link recovery を待つ |
| commands disabled | ARM/DISARM/mode には `-AllowSafeCommands` が必要 |
| pilot disabled | `-AllowPilotControl` が必要 |
| wrong mode | STABILIZE/ALT_HOLD を選択。アプリは自動変更しない |
| RC configuration pending/invalid | parameter response または QGroundControl の実設定を点検。アプリは書かない |
| dead-man released | 設計どおり all-zero release。継続保持して再入力 |
| ARM rejected | STATUSTEXT/pre-arm reason を確認。force/bypass しない |
| ACK accepted but verify timeout | HEARTBEAT が最終 state を報告しないため成功扱いしない |

---

## 9. Safe shutdown

1. dead-man を放す。
2. Neutral / Release。
3. ARMED なら DISARM し、telemetry で DISARMED を確認。
4. Disable Bench Pilot。
5. backend terminal で Ctrl+C。

graceful shutdown は可能な限り RC release burst を送り、heartbeat/worker を停止して serial port を
close します。physical link が既に失われている場合は finite `RC_OVERRIDE_TIME` が最後の防壁です。

---

## 10. 未実装 / 検証外

- takeoff、land、RTL execution
- mission upload、guided goto UI、raw public RC endpoint、MAVLink `MANUAL_CONTROL`
- motor test、servo command、parameter write
- force-arm、安全 check/failsafe の disable
- real COM10/Pixhawk/DualSense/motor/flight validation for this refactor

実機 Manual Control の次の安全な作業は、プロペラを付けることではなく、
[PILOT_CONTROL_GUIDE.md](PILOT_CONTROL_GUIDE.md) の propellers-removed bench をレビュー付きで
実施することです。
