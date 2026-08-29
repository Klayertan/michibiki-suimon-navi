# experiments/qz1-water-level

QZ1 鉛直変位実験の**設定・データ・スクリプト置き場**。

背景と手順は [`docs/qz1-floating-water-level/`](../../docs/qz1-floating-water-level/)
にあります。ここはその実行環境です。

```text
configs/   実験設定（設計）。コミットされます
data/      実際の記録。.gitignore されています
scripts/   解析CLIと合成データ生成器
```

## data/ がコミットされない理由

GNSS記録は、受信機——したがって人あるいは特定の圃場——が**実際にどこにあったか**の
正確でタイムスタンプ付きの記録です。機微な情報として扱います。

`.gitignore` は `experiments/qz1-water-level/data/*` を除外します。共有したい記録が
あるときは、中身を確認したうえで明示的に `git add -f` してください。

`tests/fixtures/qz1-water-level/` の **SYNTHETIC** ファイルは例外です。ノイズモデルが
生成した架空の座標のデータで、測定値も実在の位置も含みません。

## scripts/analyze-experiment.mjs

取得とは独立した解析。シリアルポートに触れず、記録を書き換えません。

```bash
# 生NMEA + マークから
node experiments/qz1-water-level/scripts/analyze-experiment.mjs \
  --nmea data/run-001.nmea \
  --marks data/run-001.marks.json \
  --config configs/vertical-displacement-001.json

# 保存済みの実験CSVから（マークは行のラベルから復元）
node experiments/qz1-water-level/scripts/analyze-experiment.mjs \
  --csv data/run-001.csv \
  --config configs/vertical-displacement-001.json
```

| オプション | 内容 |
|---|---|
| `--filter <名前\|JSON>` | フィルタ鎖。既定は `none`（無加工）。プリセット: `none`, `valid-fix-only`, `standard-quality-gate`, `quality-gate-then-median-15` |
| `--html <path>` | 図つき自己完結HTMLレポート |
| `--csv-out <path>` | ラベル付き実験CSV |
| `--json-out <path>` | 解析結果すべてをJSONで |
| `--capture-date <YYYY-MM-DD>` | センテンスに日付がないログ用 |

終了コード: `0` = 1つ以上の段差を測定できた、`2` = どれも測定できなかった
（**エラーではなく有効な負の結果**）、`1` = 実行できなかった。

## scripts/make-synthetic-log.mjs

**合成データ生成器。出力は測定ではありません。**

解析コードを受信機なしで動かすためのものです。AR(1)ノイズ＋線形ドリフトという
都合のよい作り話であり、実際のGNSS鉛直誤差はこれより性質が悪く、定常でもありません。

**この生成器から得た PASS は、解析コードが動くことしか意味しません。**
QZ1 が 10 mm の段差を測れるかどうかについては何も言いません。

```bash
node experiments/qz1-water-level/scripts/make-synthetic-log.mjs \
  --out tests/fixtures/qz1-water-level \
  --name my-case --noise-sd-mm 40 --phi 0.9 --dwell 120 --seed 7
```

出力は3ファイル、すべてファイル名と中身に `SYNTHETIC` が入ります。

```text
<name>.SYNTHETIC.nmea         1行目が「# SYNTHETIC DATA」
<name>.SYNTHETIC.marks.json   "synthetic": true
<name>.SYNTHETIC.config.json  sensor: "SYNTHETIC (not a real receiver)"
```

主なオプション: `--heights`, `--dwell`, `--settle`, `--rate`, `--noise-sd-mm`,
`--phi`, `--drift-mm-per-hour`, `--gap-seconds`, `--no-descending`, `--seed`。
同じ `--seed` は同じ出力を返します。

## テスト

```bash
npm test
```

`tests/unit/qz1-*.test.js` が設定検証・サンプル変換・区間割当・フィルタ・統計・
解析・CSV往復・実行状態機械・較正・作図・レポートを網羅します。
`qz1-water-level-pipeline.test.js` は合成フィクスチャで NMEAファイル → 判定までを
通しで確認します。

**ハードウェアの精度は単体テストでは証明できません。** 実機で必要な作業は
[EXPERIMENT.md §5](../../docs/qz1-floating-water-level/EXPERIMENT.md) にあります。
