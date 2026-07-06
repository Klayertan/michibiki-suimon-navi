# Leaflet 活用技術 (Leaflet techniques used in Suimon Navi)

このドキュメントは、`index.html` の地図表示に Leaflet をどのように活用したかを審査員向けにまとめたものです。すべて実装済みで、コード上の行番号付きで示します。

## 1. ベースマップ (Base map)

```js
// index.html:777-781
const map = L.map("map", { zoomControl: true }).setView([34.65, 135.83], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);
```
OpenStreetMap タイルを読み込み、対象の水田周辺（奈良）を初期表示。

## 2. レイヤーグループによる表示切り替え (Layer groups + toggles)

```js
// index.html:836-839
let pointLayer = L.layerGroup().addTo(map);
let phoneLayer = L.layerGroup().addTo(map);
let fieldLayer = L.layerGroup().addTo(map);
```
```js
// index.html:1360-1368
function setLayerVisible(layer, visible) {
  if (visible && !map.hasLayer(layer)) layer.addTo(map);
  if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
}
```
圃場・QZ1測量点・スマホGPS の3レイヤーを独立してON/OFFできる比較UIを、`map.hasLayer` / `addTo` / `removeLayer` の組み合わせで実装。

## 3. 圃場形状の描画（ポリゴン・ポリライン） (Field boundary & channel)

```js
// index.html:1132-1151
L.polygon(boundary, { color: "#15803d", weight: 2, fillColor: "#22c55e", fillOpacity: 0.08 })
  .bindTooltip(String(fieldData.name ?? "圃場"))
  .addTo(fieldLayer);

L.polyline(channel, { color: "#0e7490", weight: 3, dashArray: "6 6", opacity: 0.85 })
  .bindTooltip("水路")
  .addTo(fieldLayer);
```
QZ1で実測した圃場境界を `L.polygon`、水路を破線の `L.polyline` として描画。`Turf.js` と組み合わせて面積（㎡・反）も算出（1176-1180行）。

## 4. 水門位置マーカー (Gate marker with permanent tooltip)

```js
// index.html:1156-1165
L.circleMarker([gate.lat, gate.lon], {
  radius: 10, color: "#1e3a8a", fillColor: "#3b82f6", fillOpacity: 0.95, weight: 3
})
  .bindTooltip("水門", { permanent: true, direction: "top", offset: [0, -10] })
  .addTo(fieldLayer);
```
常時表示ツールチップ（`permanent: true`）で水門位置をラベル付き表示。

## 5. Fix品質に応じた測位点の色分け (Data-driven marker styling)

```js
// index.html:1251-1261
function markerStyle(point) {
  const fillColor = point.augmented ? "#15803d" : "#d97706";
  return {
    radius: 8,
    color: FEATURE_COLORS[point.feature],
    fillColor,
    fillOpacity: 0.84,
    weight: point.feature === "unknown" ? 3 : 5
  };
}
```
NMEA の GGA センテンスから得た fix-quality（SLAS補強 or GPS単独）とタグ（水門/畦/水路/圃場の角）に応じて、`L.circleMarker` の色・線幅を動的に変える。

## 6. ポップアップ内フォームでの現地タグ付け (Interactive popups)

```js
// index.html:1235-1237
L.circleMarker([point.lat, point.lon], markerStyle(point))
  .bindPopup(buildPopup(point), { maxWidth: 360 })
  .addTo(pointLayer);
```
`buildPopup()`（1454行〜）がポップアップ内に HTML フォームを生成し、地物タグ・メモをその場で保存 → 測量ポイントを「水門」としてマーキングすると水門位置が更新される仕組み。

## 7. 大量点のクラスタリング (Marker clustering for high-density logs)

```html
<!-- index.html:8-9, 721 -->
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
```
```js
// index.html:1213-1225
function ensurePointContainer(pointCount) {
  const shouldCluster = pointCount > CLUSTER_THRESHOLD && typeof L.markerClusterGroup === "function";
  ...
  pointLayer = shouldCluster
    ? L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 40 })
    : L.layerGroup();
}
```
1Hzで記録した徒歩/ドローン測量ログ（数百〜数千点）が重くならないよう、閾値（400点）を超えたら `Leaflet.markercluster` プラグインへ自動切り替え。

## 8. スマホGPSとの比較レイヤー (Accuracy-circle comparison layer)

```js
// index.html:1266-1274
L.circle([point.lat, point.lon], {
  radius: point.accuracy,
  color: "#dc2626",
  ...
}).addTo(phoneLayer);

L.circleMarker([point.lat, point.lon], { ... }).addTo(phoneLayer);
```
スマホ単体GPSの測位精度円（`L.circle` の半径 = accuracy）を重ねて、QZ1/SLASとの誤差を視覚的に比較できるようにした（地域課題「技術の壁」の実証）。

## 9. 自動フィッティング (Auto fit-to-bounds)

```js
// index.html:1241-1242
const bounds = L.latLngBounds(visiblePoints.map((point) => [point.lat, point.lon]));
map.fitBounds(bounds, { padding: [36, 36], maxZoom: 18 });
```
NMEAファイルの読み込みやレイヤー切り替え時に、表示中の全点が収まるよう自動でズーム・パンする（`fitVisibleLayers`, `zoomToField` 等でも同様のパターンを再利用）。

## まとめ

| 技術 | Leaflet API | 目的 |
|---|---|---|
| ベースマップ | `L.map`, `L.tileLayer` | OSM表示 |
| レイヤー切替 | `L.layerGroup`, `map.hasLayer/addTo/removeLayer` | 圃場/QZ1/スマホの比較UI |
| 圃場形状 | `L.polygon`, `L.polyline` | 境界・水路の実測データ表示 |
| 水門マーカー | `L.circleMarker` + `bindTooltip({permanent:true})` | 常時ラベル表示 |
| 動的スタイリング | `L.circleMarker` スタイル関数 | fix品質・地物タグの色分け |
| インタラクティブポップアップ | `bindPopup` + HTMLフォーム | 現地でのタグ付け・保存 |
| クラスタリング | `Leaflet.markercluster` | 高密度ログのパフォーマンス対策 |
| 精度円 | `L.circle` | スマホGPS誤差の可視化 |
| 自動フィット | `L.latLngBounds`, `map.fitBounds` | 表示範囲の自動調整 |

すべて `index.html` 単体（CDN経由でLeaflet/markercluster/Turfを読み込み）で完結しており、ビルド工程なしで GitHub Pages にそのままデプロイ可能。
