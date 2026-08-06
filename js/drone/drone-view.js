// DOM rendering for the drone / MAVLink panel.
//
// The view is a pure function of store state: render() reads a state snapshot
// and writes the DOM. It holds no state of its own and never calls the API, so
// what is on screen always matches what the backend last reported.
//
// Every value that carries meaning is written as text. `data-tone` adds colour
// on top of that text — it never replaces it — so the panel stays readable
// without colour perception.

import {
  EMPTY,
  batteryWarning,
  describeReason,
  formatAltitude,
  formatArmedState,
  formatClockTime,
  formatConnectionState,
  formatCoordinate,
  formatCurrent,
  formatDegrees,
  formatFixType,
  formatFreshness,
  formatHeading,
  formatPercent,
  formatSatellites,
  formatSeverity,
  formatSpeed,
  formatVoltage
} from "./drone-formatters.js";

/** Element ids the panel owns. Missing elements are tolerated so the module
 *  can be mounted against a partial page (and unit-tested) without throwing. */
const IDS = [
  "droneBackendStatus",
  "droneConnectionState",
  "droneModeBadge",
  "dronePort",
  "droneBaud",
  "droneFreshness",
  "droneLastHeartbeat",
  "droneFlightMode",
  "droneArmedState",
  "droneArmedWarning",
  "droneFirmware",
  "droneSystemId",
  "droneComponentId",
  "droneVoltage",
  "droneCurrent",
  "droneBatteryPercent",
  "droneBatteryWarning",
  "droneFixType",
  "droneSatellites",
  "droneLat",
  "droneLon",
  "dronePositionAvailable",
  "droneRoll",
  "dronePitch",
  "droneYaw",
  "droneHeading",
  "droneGroundSpeed",
  "droneAltitude",
  "droneMessageList",
  "droneConnectButton",
  "droneDisconnectButton",
  "droneRequestVersionButton",
  "droneModeSelect",
  "droneApplyModeButton",
  "droneStatusMessage",
  "droneCommandMessage",
  "dronePropsConfirmRow",
  "dronePropsConfirm",
  "droneReadOnlyNote",
  "droneControlsNote"
];

export class DroneView {
  constructor(root = document) {
    this.root = root;
    this.elements = {};
    IDS.forEach((id) => {
      this.elements[id] = root.getElementById ? root.getElementById(id) : null;
    });
  }

  /** True when the panel markup is present on the page. */
  get isMounted() {
    return Boolean(this.elements.droneConnectionState);
  }

  setText(id, value, tone) {
    const element = this.elements[id];
    if (!element) return;
    element.textContent = value ?? EMPTY;
    if (tone !== undefined) element.dataset.tone = tone;
  }

  setHidden(id, hidden) {
    const element = this.elements[id];
    if (element) element.hidden = Boolean(hidden);
  }

  setDisabled(id, disabled) {
    const element = this.elements[id];
    if (element) element.disabled = Boolean(disabled);
  }

  render(state) {
    if (!this.isMounted) return;
    this.renderConnection(state);
    this.renderVehicle(state);
    this.renderBattery(state);
    this.renderGps(state);
    this.renderMotion(state);
    this.renderMessages(state);
    this.renderControls(state);
    this.renderStatusLines(state);
  }

  renderConnection(state) {
    const { telemetry, backendReachable, config } = state;

    if (backendReachable === null) {
      this.setText("droneBackendStatus", "確認中", "pending");
    } else if (backendReachable) {
      this.setText("droneBackendStatus", "応答あり", "ok");
    } else {
      this.setText("droneBackendStatus", "応答なし（未起動の可能性）", "danger");
    }

    const connection = formatConnectionState(state.connectionState);
    this.setText("droneConnectionState", `${connection.label} / ${connection.en}`, connection.tone);

    const mode = telemetry?.mode || config?.config?.mode;
    if (mode === "mock") {
      this.setText("droneModeBadge", "モック（模擬）モード — 実機に接続していません", "info");
    } else if (mode === "real") {
      this.setText("droneModeBadge", "実機モード — COM10の実リンク", "warn");
    } else {
      this.setText("droneModeBadge", EMPTY, "unknown");
    }

    const transport = telemetry?.transport || {};
    const configured = config?.config || {};
    this.setText("dronePort", transport.port || configured.port || (mode === "mock" ? "なし（モック）" : EMPTY));
    this.setText("droneBaud", transport.baud || configured.baud ? String(transport.baud || configured.baud) : (mode === "mock" ? "なし（モック）" : EMPTY));

    const freshness = formatFreshness(telemetry?.link);
    this.setText("droneFreshness", freshness.label, freshness.tone);
    this.setText("droneLastHeartbeat", formatClockTime(telemetry?.link?.lastHeartbeatAt));
  }

  renderVehicle(state) {
    const vehicle = state.telemetry?.vehicle || {};
    this.setText("droneFlightMode", vehicle.flightMode || EMPTY);

    const armed = formatArmedState(state.armed);
    this.setText("droneArmedState", armed.label, armed.tone);

    // A hard, unmissable warning: while the vehicle reports armed, every
    // control in this panel is disabled and the operator is told why.
    const warning = this.elements.droneArmedWarning;
    if (warning) {
      warning.hidden = armed.armed !== true;
      if (armed.armed === true) {
        warning.textContent =
          "⚠ 機体がARMED（アーム中）を報告しています。このパネルからのコマンドはすべて無効化されています。" +
          "送信機またはQGroundControlで解除してください。";
      }
    }

    const version = state.telemetry?.version;
    this.setText("droneFirmware", version?.flightSwVersion ? `ArduCopter ${version.flightSwVersion}` : EMPTY);
    this.setText("droneSystemId", vehicle.systemId === null || vehicle.systemId === undefined ? EMPTY : String(vehicle.systemId));
    this.setText("droneComponentId", vehicle.componentId === null || vehicle.componentId === undefined ? EMPTY : String(vehicle.componentId));
  }

  renderBattery(state) {
    const battery = state.telemetry?.battery || {};
    this.setText("droneVoltage", formatVoltage(battery.voltage));
    this.setText("droneCurrent", formatCurrent(battery.current));
    this.setText("droneBatteryPercent", formatPercent(battery.remaining));

    const warning = batteryWarning(battery);
    this.setText("droneBatteryWarning", warning.label, warning.tone);
  }

  renderGps(state) {
    const gps = state.telemetry?.gps || {};
    const position = state.telemetry?.position || {};
    this.setText("droneFixType", formatFixType(gps.fixTypeName));
    this.setText("droneSatellites", formatSatellites(gps.satellites));
    this.setText("droneLat", formatCoordinate(position.lat ?? gps.lat));
    this.setText("droneLon", formatCoordinate(position.lon ?? gps.lon));

    // Trust the backend's `available` alone -- it is the one place fix
    // quality (GPS_RAW_INT.fixType >= 2D_FIX) is judged. Re-deriving it here
    // from a raw coordinate being non-null was the bug: ArduPilot reports
    // lat/lon as a real 0 while it has no fix at all, so "not null" is not
    // "usable". Do not add a fallback like `|| gps.lat != null` back here.
    const available = position.available === true;
    this.setText(
      "dronePositionAvailable",
      available ? "利用可能" : "利用不可（GPS Fixなし）",
      available ? "ok" : "warn"
    );
  }

  renderMotion(state) {
    const attitude = state.telemetry?.attitude || {};
    const motion = state.telemetry?.motion || {};
    this.setText("droneRoll", formatDegrees(attitude.roll));
    this.setText("dronePitch", formatDegrees(attitude.pitch));
    this.setText("droneYaw", formatDegrees(attitude.yawNormalized ?? attitude.yaw));
    this.setText("droneHeading", formatHeading(motion.heading));
    this.setText("droneGroundSpeed", formatSpeed(motion.groundSpeed));
    this.setText("droneAltitude", formatAltitude(motion.altitude));
  }

  renderMessages(state) {
    const list = this.elements.droneMessageList;
    if (!list) return;
    list.textContent = "";

    if (!state.messages.length) {
      const empty = this.root.createElement("li");
      empty.className = "drone-message drone-message-empty";
      empty.textContent = "受信メッセージはありません。";
      list.append(empty);
      return;
    }

    state.messages.forEach((entry) => {
      const severity = formatSeverity(entry.severityName);
      const item = this.root.createElement("li");
      item.className = "drone-message";
      item.dataset.tone = severity.tone;

      const time = this.root.createElement("span");
      time.className = "drone-message-time";
      time.textContent = formatClockTime(entry.receivedAt);

      const level = this.root.createElement("span");
      level.className = "drone-message-severity";
      level.textContent = severity.label;

      const text = this.root.createElement("span");
      text.className = "drone-message-text";
      text.textContent = entry.text || EMPTY;

      item.append(time, level, text);
      list.append(item);
    });
  }

  renderControls(state) {
    const { telemetry, backendReachable, busy, canCommand } = state;
    const isReal = (telemetry?.mode || state.config?.config?.mode) === "real";
    const linkRunning = Boolean(telemetry?.connected) || state.connectionState === "connecting";

    this.setDisabled("droneConnectButton", busy || !backendReachable || linkRunning);
    this.setDisabled("droneDisconnectButton", busy || !backendReachable || !linkRunning);

    // Mode controls are disabled unless connected, unarmed, and commands are
    // enabled in the backend. Armed always wins.
    const armedBlocked = state.armed === true;
    const modeEnabled = Boolean(canCommand) && !armedBlocked && !busy;
    this.setDisabled("droneModeSelect", !modeEnabled);
    this.setDisabled("droneApplyModeButton", !modeEnabled);
    this.setDisabled("droneRequestVersionButton", !Boolean(canCommand) || busy);

    // The propellers-removed confirmation only applies to a real connection.
    this.setHidden("dronePropsConfirmRow", !isReal);

    const readOnly = telemetry?.allowSafeCommands === false;
    this.setHidden("droneReadOnlyNote", !readOnly);

    this.setText("droneControlsNote", this.controlsNote({ backendReachable, linkRunning, armedBlocked, readOnly, canCommand }));
  }

  controlsNote({ backendReachable, linkRunning, armedBlocked, readOnly, canCommand }) {
    if (backendReachable === false) return "バックエンドが応答しません。npm run backend:mock で起動してください。";
    if (armedBlocked) return "機体がARMEDのため、すべての操作を無効化しています。";
    if (!linkRunning) return "「接続」を押すとMAVLinkリンクを開始します。";
    if (readOnly) return "バックエンドは読み取り専用モードです。コマンドは無効です。";
    if (!canCommand) return "リンクが安定するまでコマンドは送信できません。";
    return "モード変更は解除（DISARMED）状態でのみ、STABILISE / ALT_HOLD に限り実行できます。";
  }

  renderStatusLines(state) {
    const connection = formatConnectionState(state.connectionState);
    const socket = state.socketOpen ? "テレメトリ受信中" : "テレメトリ停止中";
    this.setText("droneStatusMessage", `${connection.label}（${socket}）`);

    const command = state.lastCommand;
    if (!command) {
      this.setText("droneCommandMessage", "", "idle");
      return;
    }
    const prefix = command.ok ? "成功" : "失敗";
    const explanation = command.ok ? command.message : describeReason(command.reason, command.message);
    this.setText(
      "droneCommandMessage",
      `${prefix}: ${explanation}${command.ok && command.message !== explanation ? ` (${command.message})` : ""}`,
      command.ok ? "ok" : "danger"
    );
  }
}
