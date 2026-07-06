# ドローン⇄PC/スマホ データ伝送計画 (Drone data link plan)

機体: Holybro X500 V2 ／ ペイロード: 青いQZ1（Bluetooth SPP・内蔵バッテリー）
目的: 飛行中のQZ1測位データをPC/スマホへ届ける、または着陸後に確実に回収する。

## 結論（推奨）

- **主経路（Phase 0・実証済み技術のみ）:** スマホをドローンに搭載して機上ロギング → 着陸後にファイル共有 → アプリへアップロード。**新規ハードウェア不要、今すぐ可能。**
- **発展（Phase 1〜3・ライブ中継）:** E220-900T22S(JP) LoRaペアで GGA文を地上へダウンリンク → 地上局をUSBシリアルとしてPCに接続 → **Suimon Navi の「QZ1ライブ記録」（Web Serial）がそのまま受信** → 飛行中にリアルタイムで地図に点が増える。デモ映えが大きい。
- 機体付属の Holybro テレメトリ無線（SiK 915MHz 等）は**日本では技適なし＝送信不可**の個体が多く、確認できない限り使わない。E220-900T22S(JP) はCLEALINK扱いの技適（TELEC）取得済みモデルなので合法に使える。

## 3案比較

| 案 | 構成 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| A. 機上ロギング | QZ1 + スマホ（Serial Bluetooth Terminal）を機体に搭載 | 実証済み（2026-07-06 寮テストと同一フロー）・追加費用0・データ完全 | ライブ性なし・スマホ重量 約200g | **主経路** |
| B. LoRaライブ中継 | QZ1 →(BT SPP)→ ESP32 →(UART)→ E220機上局 ⇝920MHz⇝ E220地上局 →(USB)→ PC | 飛行中に地図へ点が増えるライブデモ・km級レンジ・TELEC適合 | 追加部品・ESP32ファーム開発・帯域制約(GGAのみ送る) | **発展目標** |
| C. MAVLink経由 | QZ1をPixhawk TELEM2に有線接続しMAVLinkで中継 | 機体テレメトリと統合 | fix=2等の生NMEA情報が失われる・配線/設定複雑・SiK無線の技適問題 | 不採用 |

## Phase 0 — 機上ロギング（今週可能）

1. QZ1とスマホ（Pixel可・古い端末推奨）を機体プレートに固定（QZ1のアンテナ上向き・金属から離す）
2. 離陸前に Serial Bluetooth Terminal 接続 → Log開始 → 機内モードにしない（BTのみ・モバイル通信は切ってよい）
3. 飛行（BT距離は機体〜スマホ間の数cmなので問題なし）
4. 着陸 → Log停止 → ファイル共有 → 「NMEAをアップロード」
- 重量: QZ1 約100g + スマホ 約200g ≪ X500 V2 ペイロード余裕（約1kg）→ 問題なし
- リスク: 振動でBT切断 → スマホとQZ1を同じ防振マウントに載せる

## Phase 1 — E220ペアの机上テスト（M5Stack Core2×2 + YwRobot Power MB V2で着手）

Arduino UNOは使わず、**空中局・地上局とも M5Stack Core2** で統一（保有機材のみで新規購入なし）。Core2は画面・タッチ・バッテリー内蔵のESP32ボードなので、地上局側は受信状況をその場で画面表示できる（PC不要でも動作確認できる）。

**役割分担**

| 機材 | 役割 |
|---|---|
| M5Stack Core2 #1（空中局） | QZ1へBluetooth SPP接続 → GGA行のみ抽出 → Port C（UART, G13/G14）経由でE220へ送信。画面は使わない（M5.begin()を呼ばず素のESP32 Arduino coreとして軽量に動かす） |
| M5Stack Core2 #2（地上局） | E220からPort C（G13/G14）で受信 → USB経由でPCへそのまま中継（Suimon NaviのWeb Serialが読む） → 同時に自機の画面へ受信バイト数・GGA件数・最新fix qualityを表示（デモ映え・PC無しでも動作確認可） |
| YwRobot Power MB V2 | **地上局E220専用の3.3V電源**。Core2のGroveポート(Port C)の5Vピンは電池/USB由来でそのまま5V系のため、**E220のVCCには使わない**。ブレッドボード上でYwRobotから安定3.3Vを別途供給し、Core2とはGNDのみ共通にする |

**⚠️ 配線前に必ず確認: E220-900T22S(JP)の許容入力電圧**
E220モジュールの基板シルク/データシートで「VCC 3.3V専用」か「3.3〜5.5V許容（オンボードレギュレータ内蔵）」かを確認してください。
- **3.3V専用の場合:** VCCは必ずYwRobot Power MB V2の3.3Vレールから取る（地上局）。空中局はCore2のGrove 5Vではなく、機体のBECから3.3Vへ落とす小型レギュレータ（または3.3V単体電源）を別途用意する
- **3.3〜5.5V許容の場合:** Core2のGrove Port C の5VピンからそのままVCCを取ってよい（地上・空中とも配線がシンプルになる）。この場合YwRobot Power MB V2はベンチテストの電源安定化用途のみに使う

**Core2 Port C（Grove）ピン配置（両局共通）**
- G13 = RX2、G14 = TX2、GND、5V（上記の電圧確認結果に応じて使用/未使用を判断）
- E220の TX/RX と Core2の RX2/TX2 をクロス接続（E220 TX → Core2 G13、E220 RX → Core2 G14）

**E220設定（両局共通・設定モード M0=0,M1=1 で書込み）**
- UARTボーレート: 9600 / 8N1（アプリのボーレート選択に既にある）
- 空中レート: 2.4kbps（最長レンジ設定。GGA 1Hz ≈ 0.7kbps なので余裕）
- チャンネル・アドレス: 両局一致（例: CH=0, ADDR=0xFFFF 透過モード）
- 送信出力: 22dBm（JP版はLBT内蔵で ARIB STD-T108 適合）

**テスト手順**
1. 地上局Core2とE220をPort C経由で配線、YwRobot Power MB V2（または電圧確認済みなら5V直結）でE220に給電、地上局Core2をPCにUSB接続
2. 地上局スケッチを書き込み（下記）→ PCのシリアルモニタでE220からの受信を確認
3. 空中局Core2にNMEAサンプルの中身を直接`Serial.println`で流し込むテストスケッチを一時的に書き込み、地上局が受信・画面表示することを確認
4. Suimon NaviのQZ1ライブ記録カードでボーレート9600・「QZ1に接続」→ 地上局Core2のUSBシリアルポートを選択 → 地図に点が増えることを確認

## Phase 2 — Core2ブリッジ開発

**空中局スケッチ骨子**（画面・バッテリー管理は使わず、素のESP32 Arduino coreのBluetoothSerial + HardwareSerial2のみ使用）:
```cpp
#include "BluetoothSerial.h"
BluetoothSerial SerialBT;
// QZ1のMACアドレスに接続（事前にスマホのBluetooth設定で確認）
uint8_t qz1mac[] = { /* QZ1 MAC */ };
String line;

void setup() {
  Serial2.begin(9600, SERIAL_8N1, 13, 14); // Core2 Port C = G13(RX)/G14(TX)
  SerialBT.begin("bridge", true);           // master mode
  SerialBT.connect(qz1mac);
}
void loop() {
  while (SerialBT.available()) {
    char c = SerialBT.read();
    if (c == '\n') {
      if (line.startsWith("$G") && line.indexOf("GGA,") == 3)
        Serial2.println(line);   // GGAのみダウンリンク
      line = "";
    } else if (c != '\r') line += c;
  }
}
```

**地上局スケッチ骨子**（M5Core2ライブラリで画面表示 + USBへ透過転送）:
```cpp
#include <M5Core2.h>
uint32_t byteCount = 0, ggaCount = 0;
String line;

void setup() {
  M5.begin();
  Serial2.begin(9600, SERIAL_8N1, 13, 14); // Port C から E220
  Serial.begin(9600);                       // USB→PC（Suimon Naviが読む側）
  M5.Lcd.println("Ground station ready");
}
void loop() {
  while (Serial2.available()) {
    char c = Serial2.read();
    Serial.write(c);       // PCへそのまま転送（Web Serialが受信）
    byteCount++;
    if (c == '\n') {
      if (line.indexOf("GGA,") >= 0) ggaCount++;
      line = "";
      M5.Lcd.fillRect(0, 40, 320, 60, BLACK);
      M5.Lcd.setCursor(0, 40);
      M5.Lcd.printf("bytes: %lu\nGGA: %lu", byteCount, ggaCount);
    } else if (c != '\r') {
      line += c;
    }
  }
}
```

- 空中局電源: 機体のBEC 5V（→E220の電圧要件次第でレギュレータ経由）または Core2内蔵バッテリー（390mAh、短時間テスト向け）
- 追加重量: Core2（約108g）+ E220+アンテナ（約30〜50g）≈ 150g前後 → X500 V2のペイロード余裕（約1kg）内で問題なし。ただし機上ロギング（Phase 0のスマホ+QZ1）と合わせて搭載する場合は総重量を確認

## Phase 3 — 実機搭載テスト（学校・教員承認済み区域）

1. 地上で機体アーム無し → リンク確認（PC地図に点が増える）
2. モーター回転（地上係留相当）→ ノイズでリンク切れないか確認
3. ホバリング→周回飛行 → ライブ受信＋機上ログ（Phase 0構成も同時搭載）を比較
4. 判定: ライブ受信欠落があっても**機上ログが常に正**。ライブはデモ用途と割り切る

## 法規・運用ノート

- E220-900T22S(JP): 技適（TELEC）取得済み・920MHz帯 ARIB STD-T108（LBT内蔵）→ 免許不要で合法
- プロポ（2.4GHz）と920MHz LoRaは帯域が離れており干渉しにくい。GNSS（1.5GHz帯）とも離れているがアンテナはQZ1から10cm以上離す
- Holybro付属テレメトリ（433/915MHz SiK）は技適表示が確認できない限り**電源を入れない**
- 飛行ルールは従来どおり: 学校区域・教員承認・同伴者、実圃場は祖父の同意後

## アプリ側の変更

**不要。** 地上局E220はUSBシリアルとして見えるため、既存の「QZ1ライブ記録」（Web Serial・9600bps選択）がそのまま受信する。二重取り込み（ライブ＋後からログ全体アップロード）をすると点が重複するので、本番データはどちらか一方を採用する。
