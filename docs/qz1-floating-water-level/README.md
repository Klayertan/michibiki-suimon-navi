# QZ1 Floating Paddy Water-Level Sensor

浮体に載せた QZ1 / QZ1LE の **GNSS標高の変化** から、水田の **水位変化** を読み取れるか
どうかを実験的に確かめるためのサブプロジェクトです。

**これは製品機能ではありません。** 「読み取れる」ことを前提にした機能でもありません。
目的は、読み取れるかどうかを実験的に決めることであり、読み取れないという結論も
同じくらい正当な成果です。

---

## 中心仮説 / The hypothesis

> 係留された浮体GNSS受信機の**相対的な標高変化**から、水位の**相対的な変化**を
> 推定できるかもしれない。
>
> A tethered floating GNSS receiver may allow relative water-level change to be
> estimated from relative GNSS altitude change.

絶対標高ではなく相対変化を使う点が要です。GNSSの絶対標高には数メートル規模の
バイアスが乗りますが、同じ受信機を同じ場所で比べる限り、その多くは差し引かれます。

## 中心的な限界 / The limitation

> GNSSの鉛直精度と、水面・水田環境のマルチパスは、水管理に必要なセンチメートル級の
> 変化に対して**不十分かもしれない**。
>
> GNSS vertical accuracy and environmental multipath may be insufficient for the
> centimetre-level changes relevant to paddy water management.

これは注意書きではなく、この実験が答えようとしている問いそのものです。

**この，リポジトリ自身のログからの実測値:**
`data/samples/qz1-dorm-walk-20260706.txt`（2026-07-06、屋内・コールドスタート、
QZ1を持って移動）では、測位が得られた206エポックの標高は **-11.8 m 〜 +92.0 m**、
最後の50エポックに限っても **7.8 m の幅** がありました。

この数字はそのまま「QZ1は水位計測に使えない」を意味しません。屋内・コールドスタート・
収束途中という最悪条件のログであり、公正な試験ではないからです。しかしこれは、
**10 mm を読もうとしている対象が、条件次第で数メートル動く量である**ことを示しています。
だから固定治具による対照実験を先にやります。

---

## センサIDと圃場IDは別 / Sensor identity is not field identity

センサが知っているのは自分のIDだけです。

```text
QZ1-FLOAT-001
```

どの圃場にあるかは、GNSS位置と登録済みポリゴンからスイスイナビが判定します。

```text
paddy-003（北の田）
```

**この部分は標高実験とは独立しています。** 標高が水位計測に使えないという結論に
なっても、緯度・経度による圃場の自動判定はそのまま機能します。GNSSが得意なのは
水平位置のほうで、聞いている問いも別だからです。
詳細は [SENSOR_FIELD_ASSIGNMENT.md](SENSOR_FIELD_ASSIGNMENT.md)。

## 何ができるか / What this gives you

| | |
|---|---|
| 取得 | 既存のQZ1シリアル接続（Web Serial）をそのまま利用。二つ目のGNSSスタックは作りません |
| センサ同一性 | 永続的な `sensorId`。座標からは決して導きません |
| 圃場の自動判定 | 登録済みポリゴンとの内外判定＋揺れ対策のローリングウィンドウ |
| 割り当て | 自動検出 → 人が一度確認 → ロック。検出だけで割り当てが変わることはありません |
| 移動検知 | 継続的な不一致で警告。**自動では割り当て直しません** |
| 記録 | 生NMEAを保持したまま、各サンプルに**既知の基準高さ**を紐づけ |
| 解析 | 取得とは独立したCLI。同じログを別のフィルタで何度でも再解析できます |
| 判定 | 10/20/30/50/100 mm それぞれについて PASS / INCONCLUSIVE / FAIL / INSUFFICIENT |
| 出力 | 実験CSV＋JSONメタデータ、プロット付きHTMLレポート |

判定結果が

```
10 mm   FAIL
20 mm   FAIL
30 mm   INCONCLUSIVE
50 mm   PASS
100 mm  PASS
```

となっても、それは**ソフトウェアの失敗ではなく実験の成果**です。

---

## ドキュメント

| ファイル | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | ハードウェア・ソフトウェア・データの流れ、既存コードとの接続点 |
| [HARDWARE.md](HARDWARE.md) | 浮体の構造、材料、防水、アンテナ配置、係留ケーブル |
| [EXPERIMENT.md](EXPERIMENT.md) | 実験手順（第1段階：固定治具／第2段階：浮体） |
| [SENSOR_FIELD_ASSIGNMENT.md](SENSOR_FIELD_ASSIGNMENT.md) | センサID・圃場の自動判定・割り当て・移動検知 |
| [SENSOR_MANAGEMENT.md](SENSOR_MANAGEMENT.md) | 水位センサーの登録・設定・較正・データ表示（実装/未実装の区別つき） |
| [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md) | 端末・ブラウザ別の接続方法。正直な対応表 |

## すぐ試す（合成データ）

ハードウェアなしでパイプライン全体を動かせます。**合成データは測定ではありません。**

```bash
node experiments/qz1-water-level/scripts/analyze-experiment.mjs   --nmea tests/fixtures/qz1-water-level/noisy-40mm.SYNTHETIC.nmea   --marks tests/fixtures/qz1-water-level/noisy-40mm.SYNTHETIC.marks.json   --config tests/fixtures/qz1-water-level/noisy-40mm.SYNTHETIC.config.json   --html /tmp/report.html
```

## 画面

`設定` → `QZ1測量` ワークスペース → **QZ1 水位実験** カード。
基本モードには出しません。農作業の道具ではないからです。

カードは3つの量を**別々の行**に出します。

* ① 生のGNSS標高 — 受信機が言った値そのもの
* ② 相対変位 — その実験自身の基準位置からの差。**水深ではありません**
* ③ 較正済み水深 — 実験で裏付けられた較正がある場合**のみ**。無ければ数値ではなく理由が出ます

## 現状 / Status

| | |
|---|---|
| ソフトウェア | 実装済み・単体テスト済み（`npm test`） |
| 合成データでの検証 | 済み（コードの検証であって、ハードウェアの検証ではありません） |
| センサ同一性・圃場判定 | 実装済み・単体テスト済み・合成位置でUI確認済み（実機の測位では未検証） |
| 水位センサー管理UI | 実装済み（登録・設定・割り当て・較正の門番）。接続はシリアルとファイル読込のみ実装 |
| **実機実験** | **未実施** — [EXPERIMENT.md](EXPERIMENT.md) の手順が丸ごと残っています |
| 浮体プロトタイプ | 未製作 |
| 較正 | 実験が裏付けるまで、水深表示は仕様として拒否されます |
