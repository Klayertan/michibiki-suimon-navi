// Pilot panel rendering.
//
// A pure function of state: given the controller's state and the latest
// telemetry snapshot, write the DOM. It never sends anything and never
// decides anything — if a gate is closed, the backend said so and this just
// reports it.
//
// Everything meaningful is written as text; colour is only ever an addition
// on top, so the panel stays readable without colour perception.

const EMPTY = "—";

/** Backend block reasons -> operator-facing explanation. */
const REASON_TEXT = {
  pilot_control_disabled:
    "バックエンドで操縦が無効です / Pilot control disabled in the backend (SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1)",
  not_enabled: "操縦チャンネル未有効 / Control channel not enabled",
  not_connected: "MAVLink未接続 / MAVLink not connected",
  telemetry_stale: "テレメトリ途絶 / Telemetry stale",
  no_input: "入力なし（中立）/ No input (neutral)",
  input_timeout: "入力タイムアウト → 中立 / Input timed out — commanding neutral",
  wrong_mode: "GUIDEDモードではありません / Not in GUIDED mode",
  disarmed: "機体がDISARMED（正常）/ Aircraft disarmed (expected on the bench)",
  arm_state_unknown: "アーム状態不明 / Armed state unknown",
  neutral_commanded: "中立を指令中 / Neutral commanded",
  transmit_failed: "送信失敗 / Transmit failed"
};

function fmt(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : EMPTY;
}

function axisRow(label, key, value) {
  const pct = Math.round(Math.abs(value) * 100);
  const tone = value === 0 ? "idle" : "ok";
  return `
    <div class="pilot-axis" data-axis="${key}">
      <span class="pilot-axis-label">${label}</span>
      <meter min="-1" max="1" value="${value}"></meter>
      <output id="pilotAxis-${key}" data-tone="${tone}">${value.toFixed(2)}</output>
      <span class="pilot-axis-pct">${pct}%</span>
    </div>`;
}

export class PilotView {
  constructor(root = document) {
    this.root = root;
    this.host = root.getElementById ? root.getElementById("pilotRoot") : null;
    this.panel = root.getElementById ? root.getElementById("pilotPanel") : null;
  }

  get isMounted() {
    return Boolean(this.host);
  }

  /**
   * @param {object} view
   * @param {string} view.source      active input source name
   * @param {boolean} view.sourceActive whether that source is actually live
   * @param {object} view.axes        {forward,right,up,yaw} normalized
   * @param {boolean} view.enabled    control channel enabled locally
   * @param {object|null} view.pilot  backend pilot snapshot
   * @param {object|null} view.telemetry backend telemetry snapshot
   * @param {string|null} view.error
   * @param {boolean} view.neutralFlash
   */
  render(view) {
    if (!this.isMounted) return;
    const { source, sourceActive, axes, enabled, pilot, telemetry, error, neutralFlash } = view;
    const limits = pilot?.limits;
    const reason = pilot?.blockedReason ?? null;
    const outputActive = Boolean(pilot?.outputActive);
    const available = Boolean(pilot?.available);

    const vehicle = telemetry?.vehicle || {};
    const mode = vehicle.flightMode || EMPTY;
    const armed = vehicle.armed;
    const armedText = armed === true ? "ARMED（アーム中）" : armed === false ? "DISARMED（解除）" : "不明 / unknown";
    const armedTone = armed === true ? "danger" : armed === false ? "ok" : "warn";
    const modeOk = mode === (pilot?.requiredMode || "GUIDED");

    this.host.innerHTML = `
      <div class="pilot-safety" role="note">
        キーボード操縦は<strong>低速テスト専用</strong>です。RC送信機の代わりにはなりません。<br>
        Keyboard piloting is for <strong>low-speed testing only</strong> and is not a replacement for an RC transmitter.
        Arm, takeoff, land and RTL are not implemented here.
      </div>

      <div class="pilot-grid">
        <div class="kv"><span>入力ソース / Input source</span><strong id="pilotSource" class="drone-chip" data-tone="${sourceActive ? "ok" : "idle"}">${source}</strong></div>
        <div class="kv"><span>キーボード操縦 / Keyboard control</span><strong id="pilotEnabled" class="drone-chip" data-tone="${enabled ? "ok" : "idle"}">${enabled ? "有効 / enabled" : "無効 / disabled"}</strong></div>
        <div class="kv"><span>MAVLink出力 / Command output</span><strong id="pilotOutput" class="drone-chip" data-tone="${outputActive ? "warn" : "idle"}">${outputActive ? "送信中 / ACTIVE" : "停止 / inactive"}</strong></div>
        <div class="kv"><span>フライトモード / Flight mode</span><strong id="pilotMode" class="drone-chip" data-tone="${modeOk ? "ok" : "warn"}">${mode}</strong></div>
        <div class="kv"><span>アーム状態 / Armed</span><strong id="pilotArmed" class="drone-chip" data-tone="${armedTone}">${armedText}</strong></div>
        <div class="kv"><span>ロック理由 / Blocked</span><strong id="pilotReason">${reason ? (REASON_TEXT[reason] || reason) : "なし / none"}</strong></div>
      </div>

      <section class="pilot-axes-section">
        <h3 class="drone-section-title">入力軸 <span class="en">Pilot axes (normalized −1…+1)</span></h3>
        ${axisRow("前後 / Fwd-Back", "forward", axes.forward)}
        ${axisRow("左右 / Left-Right", "right", axes.right)}
        ${axisRow("上下 / Up-Down", "up", axes.up)}
        ${axisRow("ヨー / Yaw", "yaw", axes.yaw)}
        <p id="pilotNeutralFlash" class="pilot-neutral" ${neutralFlash ? "" : "hidden"}>
          movement neutralised — 移動を中立化しました
        </p>
      </section>

      <section class="pilot-axes-section">
        <h3 class="drone-section-title">速度上限 <span class="en">Configured limits</span></h3>
        <div class="pilot-grid">
          <div class="kv"><span>水平 / Horizontal</span><strong id="pilotLimitH">${fmt(limits?.maxHorizontalSpeed)} m/s</strong></div>
          <div class="kv"><span>上昇 / Climb</span><strong id="pilotLimitUp">${fmt(limits?.maxClimbSpeed)} m/s</strong></div>
          <div class="kv"><span>下降 / Descent</span><strong id="pilotLimitDown">${fmt(limits?.maxDescentSpeed)} m/s</strong></div>
          <div class="kv"><span>ヨー / Yaw rate</span><strong id="pilotLimitYaw">${fmt(limits?.maxYawRateDeg, 0)} °/s</strong></div>
        </div>
        <p class="meta">
          送信レート ${fmt(pilot?.setpointRateHz, 0)} Hz ／ 入力タイムアウト ${fmt(pilot?.inputTimeoutSeconds, 1)} s
          — この時間内に入力が更新されないと自動的に中立になります。
        </p>
      </section>

      <section class="pilot-axes-section">
        <div class="pilot-buttons">
          <button id="pilotEnableButton" class="panel-button ${enabled ? "" : "primary"}" type="button" ${available ? "" : "disabled"}>
            ${enabled ? "操縦を無効化 / Disable" : "操縦を有効化 / Enable keyboard control"}
          </button>
          <button id="pilotNeutralButton" class="panel-button danger" type="button" ${enabled ? "" : "disabled"}>
            中立 / Neutral (Space)
          </button>
        </div>
        <p id="pilotMessage" class="meta" role="status" aria-live="polite">${error ? `エラー: ${error}` : ""}</p>
      </section>

      <details class="pilot-keymap">
        <summary>キー割り当て / Key mapping</summary>
        <table class="pilot-keymap-table">
          <tbody>
            <tr><td>↑</td><td>前進 / forward</td></tr>
            <tr><td>↓</td><td>後退 / backward</td></tr>
            <tr><td>←</td><td>左 / left</td></tr>
            <tr><td>→</td><td>右 / right</td></tr>
            <tr><td>W</td><td>上昇 / climb</td></tr>
            <tr><td>S</td><td>下降 / descend</td></tr>
            <tr><td>A</td><td>左ヨー / yaw left</td></tr>
            <tr><td>D</td><td>右ヨー / yaw right</td></tr>
            <tr><td>Space</td><td>移動中立 / neutral movement (not a motor kill)</td></tr>
          </tbody>
        </table>
        <p class="meta">
          テキスト入力中はこれらのキーは無効です。ウィンドウのフォーカスが外れる、タブが非表示になる、
          または入力が途絶すると自動的に中立になります。
        </p>
      </details>
    `;
  }
}
