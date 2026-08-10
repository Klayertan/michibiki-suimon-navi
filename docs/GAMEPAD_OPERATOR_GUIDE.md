# Keyboard / PS5 operator guide

Keyboard と PS5 は、ひとつの **手動操縦 / Manual Control** パネルにある2つの入力 source です。
旧 Gamepad preview card と Pilot card は別々には存在しません。

`js/gamepad/` は browser input、normalization、calibration、dead-man gate の所有者であり、
MAVLink/HTTP/WebSocket transport を持ちません。統合パネルで Bench Pilot を有効にしたときだけ、
共通 `PilotController` が安全な axes を backend の manual RC path に渡します。つまり同じ UI は
無効時には preview、明示的な有効化後には command input になります。

実機を動かす前に [PILOT_CONTROL_GUIDE.md](PILOT_CONTROL_GUIDE.md) を読み、必ず全プロペラを
外した bench procedure を完了してください。

## 1. Input source

選択肢は次の2つだけです。

- `Keyboard` (`source: "keyboard"`)
- `PS5 Controller` (`source: "ps5"`)

source switch は古い source の入力を引き継がず、即 neutral/release を発行します。

### Keyboard

| Key | Axis / action |
|---|---|
| ↑ / ↓ | pitch forward / back |
| ← / → | roll left / right |
| W / S | throttle up / down |
| A / D | yaw left / right |
| Left Shift | dead-man。常に保持が必要 |
| Space | neutral + RC override release |
| Escape | neutral + disable |

Keyboard は calibration 不要です。デジタル key は browser で `KEYBOARD_DEFLECTION=0.25` の
quarter-stick input に縮小され、backend の ceiling（normal throttle 15%、Bench throttle 10%、
Bench の他軸 15%）でさらに上限を守ります。これは二重乗算ではなく magnitude clamp です。
capture は Bench Pilot enable 後だけ有効で、form field 編集中は key を奪いません。

### PS5 Controller

Mode 2 mapping:

- left stick horizontal = yaw
- left stick vertical = throttle
- right stick horizontal = roll
- right stick vertical = pitch

最終的な正の意味は forward / right / climb / yaw-right です。browser が報告する raw axis/button
index は controller、USB/Bluetooth、driver によって変わり得ます。保存された axis assignment、
inversion、center/min/max、deadzone、expo と `deadmanButtonIndex` を使用し、L1 などを backend に
決め打ちしません。

## 2. Calibration と diagnostics

Keyboard 選択中は `Calibration: not required` だけを表示し、PS5 の wizard/raw table を隠します。
PS5 を選ぶと次が disclosure 内に現れます。

- Advanced / Calibration
- semantic-to-raw axis assignment と axis inversion
- center/min/max、deadzone、expo
- configured dead-man button
- Raw input diagnostics

calibration が incomplete/invalid の間、安全 axes は 0 のままです。保存済み calibration は同じ
controller ID に対して再利用しますが、物理表示と raw monitor を目視で照合してください。

## 3. Mock PS5 acceptance — hardware なし

1. mock backend を `npm run backend:mock -- --allow-pilot-control` で起動し、別 terminal で `npm run serve`。
2. `http://localhost:4173/?gamepadMock=1#survey` を開く。
3. Manual Control を開き、Input source を `PS5 Controller` にする。
4. Simulation / PS5 controller を開き、`Connect`。
5. center、両 stick の全方向、trigger/dead-man を含む calibration step を完了し `Save`。
6. raw、preview、normalized Mode 2 axes が一致することを確認。
7. props acknowledgement、Enable Bench Pilot、mock ARM の順に操作。
8. configured dead-man を保持し、小さい stick input で `TRANSMITTING` を確認。
9. dead-man を放し、すべての安全 axes が 0、output inactive、RC override released になることを確認。
10. sudden disconnect、stale sample、focus loss、source switch でも同じ release を確認し、DISARM。

`?gamepadMock=1` は simulator の要求にすぎず、backend が `mode=mock` と確認した場合だけ simulation
control を表示します。real backend では query を付けても simulator を active provider にせず、
backend も active `provider=mock` を拒否します。mock sample は aircraft telemetry ではなく、
COM10 や Pixhawk に接続しません。

## 4. 物理 DualSense を購入後に確認する手順

このリファクタでは物理 DualSense を検証していません。最初の確認では機体の電源を入れません。

1. USB-C で接続し、Windows `joy.cpl` で認識を確認。
2. simulator query なしでアプリを開き、PS5 Controller を選択。
3. controller ID、raw axes/buttons を確認。
4. calibration を最初から実行して保存。
5. stick 4軸、dead-man press/release、cable disconnect を monitor だけで確認。
6. Bluetooth でも別 calibration を実施し、USB と同じ ID/mapping だと仮定しない。
7. その後にだけ、PILOT_CONTROL_GUIDE の propellers-removed real bench 手順へ進む。

## 5. 共通 safety gate

dead-man は preview、Bench Mode、Keyboard、PS5 の**すべてで常時必須**です。release または次の
どれかで provider は gated axes を直ちに 0 にし、共通 controller が backend に release を伝えます。

- source switch
- controller/provider disconnect
- focus loss、tab/page hidden
- input stale
- Space、Escape
- capture stop / Pilot disable
- calibration removal または mapping/dead-man reconfiguration

gate が戻っても、押したままの dead-man/stick は自動再開しません。dead-man の release を一度観測し、
新しく press した後の sample だけが再び active になります。Keyboard event stream 自体が止まった場合も
cached key/Shift を期限切れにします。

さらに backend が input age、MAVLink/telemetry、armed/mode、RC configuration を独立に再確認します。
browser の表示や calibration だけで aircraft output を許可することはありません。
