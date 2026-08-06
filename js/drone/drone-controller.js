// Drone / MAVLink panel controller.
//
// Wires the DOM controls to the local backend, keeps the store fed from the
// telemetry WebSocket, and re-renders the view on every change. Mounted from
// index.html the same way the recording and vegetation controllers are.
//
// Safety posture of this module:
//   * It can call exactly four backend operations: connect, disconnect,
//     request-version and mode. There is no code path here to arm, take off,
//     or send a raw MAVLink message.
//   * The mode <select> is populated from the backend's own allow-list, so the
//     UI cannot offer a mode the backend would refuse.
//   * A real-mode mode change requires an explicit confirm() from the operator
//     before the request is sent, and the backend independently requires the
//     confirmed flag.

import { DroneApiClient, DroneApiError } from "./drone-api-client.js";
import { DroneStore } from "./drone-store.js";
import { DroneView } from "./drone-view.js";
import { describeReason } from "./drone-formatters.js";

const SOCKET_RETRY_MIN_MS = 1000;
const SOCKET_RETRY_MAX_MS = 15000;
const HEALTH_POLL_MS = 5000;

export class DroneController {
  constructor({ baseUrl, document: doc = globalThis.document, client, confirmFn } = {}) {
    this.document = doc;
    this.client = client || new DroneApiClient({ baseUrl });
    this.store = new DroneStore();
    this.view = new DroneView(doc);
    // Injectable so tests do not have to drive a native dialog.
    this.confirm = confirmFn || ((message) => globalThis.confirm(message));

    this.socketHandle = null;
    this.socketRetryMs = SOCKET_RETRY_MIN_MS;
    this.socketRetryTimer = null;
    this.healthTimer = null;
    this.stopped = false;
    this.boundRender = () => this.view.render(this.store.getState());
  }

  async mount() {
    if (!this.view.isMounted) {
      // The panel markup is absent (e.g. a trimmed page). Nothing to do, and
      // definitely nothing to throw about.
      return false;
    }
    this.store.addEventListener("change", this.boundRender);
    this.bindControls();
    this.boundRender();

    await this.refreshHealthAndConfig();
    this.healthTimer = setInterval(() => this.refreshHealthAndConfig(), HEALTH_POLL_MS);
    this.openSocket();
    return true;
  }

  unmount() {
    this.stopped = true;
    this.store.removeEventListener("change", this.boundRender);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.socketRetryTimer) clearTimeout(this.socketRetryTimer);
    this.healthTimer = null;
    this.socketRetryTimer = null;
    this.closeSocket();
  }

  bindControls() {
    const on = (id, handler) => {
      const element = this.document.getElementById(id);
      if (element) element.addEventListener("click", handler);
    };
    on("droneConnectButton", () => this.handleConnect());
    on("droneDisconnectButton", () => this.handleDisconnect());
    on("droneRequestVersionButton", () => this.handleRequestVersion());
    on("droneApplyModeButton", () => this.handleApplyMode());
  }

  // ------------------------------------------------------------------
  // Backend health and configuration
  // ------------------------------------------------------------------

  async refreshHealthAndConfig() {
    if (this.stopped) return;
    try {
      await this.client.health();
      this.store.setBackendReachable(true);
    } catch {
      this.store.setBackendReachable(false);
      return;
    }
    if (!this.store.config) {
      try {
        const config = await this.client.config();
        this.store.setConfig(config);
        this.populateModeOptions(config?.allowedModes || []);
      } catch (error) {
        this.reportCommand({ ok: false, reason: error.reason, message: error.message });
      }
    }
    // When the socket is down, keep the panel truthful by polling status.
    if (!this.store.socketOpen) {
      try {
        this.store.setTelemetry(await this.client.status());
      } catch {
        // Health just succeeded; a transient status failure is not worth a
        // second error banner. The connection chip already shows the truth.
      }
    }
  }

  /** Fill the mode <select> from the backend allow-list, never from a literal. */
  populateModeOptions(modes) {
    const select = this.document.getElementById("droneModeSelect");
    if (!select) return;
    select.textContent = "";
    modes.forEach((mode) => {
      const option = this.document.createElement("option");
      option.value = mode;
      option.textContent = mode;
      select.append(option);
    });
  }

  // ------------------------------------------------------------------
  // Telemetry socket
  // ------------------------------------------------------------------

  openSocket() {
    if (this.stopped) return;
    try {
      this.socketHandle = this.client.openTelemetrySocket({
        onOpen: () => {
          this.socketRetryMs = SOCKET_RETRY_MIN_MS;
          this.store.setSocketOpen(true);
        },
        onMessage: (payload) => this.store.setTelemetry(payload),
        onClose: () => {
          this.store.setSocketOpen(false);
          this.scheduleSocketRetry();
        },
        onError: (error) => {
          if (error instanceof DroneApiError) {
            this.reportCommand({ ok: false, reason: error.reason, message: error.message });
          }
        }
      });
    } catch (error) {
      this.store.setSocketOpen(false);
      this.scheduleSocketRetry();
      this.reportCommand({ ok: false, reason: error.reason || "socket_failed", message: error.message });
    }
  }

  closeSocket() {
    this.socketHandle?.close();
    this.socketHandle = null;
    this.store.setSocketOpen(false);
  }

  /** Exponential backoff so a stopped backend does not spin the browser. */
  scheduleSocketRetry() {
    if (this.stopped || this.socketRetryTimer) return;
    const delay = this.socketRetryMs;
    this.socketRetryMs = Math.min(this.socketRetryMs * 2, SOCKET_RETRY_MAX_MS);
    this.socketRetryTimer = setTimeout(() => {
      this.socketRetryTimer = null;
      this.openSocket();
    }, delay);
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  async run(operation) {
    this.store.setBusy(true);
    try {
      return await operation();
    } finally {
      this.store.setBusy(false);
    }
  }

  reportCommand({ ok, reason, message }) {
    this.store.setCommandResult({ ok, reason, message });
  }

  async handleConnect() {
    const propsCheckbox = this.document.getElementById("dronePropsConfirm");
    const propellersRemoved = Boolean(propsCheckbox?.checked);
    await this.run(async () => {
      try {
        const result = await this.client.connect({ propellersRemoved });
        this.reportCommand({ ok: true, reason: "connected", message: result?.message || "接続を開始しました。" });
        if (result?.detail?.status) this.store.setTelemetry(result.detail.status);
      } catch (error) {
        this.reportCommand({ ok: false, reason: error.reason, message: error.message });
      }
    });
    await this.refreshHealthAndConfig();
  }

  async handleDisconnect() {
    await this.run(async () => {
      try {
        const result = await this.client.disconnect();
        this.store.clearVehicleState();
        this.reportCommand({ ok: true, reason: "disconnected", message: result?.message || "切断しました。" });
        if (result?.detail?.status) this.store.setTelemetry(result.detail.status);
      } catch (error) {
        this.reportCommand({ ok: false, reason: error.reason, message: error.message });
      }
    });
  }

  async handleRequestVersion() {
    await this.run(async () => {
      try {
        const result = await this.client.requestVersion();
        const version = result?.detail?.version?.flightSwVersion;
        this.reportCommand({
          ok: true,
          reason: "accepted",
          message: version ? `ファームウェア: ArduCopter ${version}` : result.message
        });
      } catch (error) {
        this.reportCommand({ ok: false, reason: error.reason, message: error.message });
      }
    });
  }

  async handleApplyMode() {
    const select = this.document.getElementById("droneModeSelect");
    const mode = select?.value;
    if (!mode) return;

    const state = this.store.getState();
    if (state.armed === true) {
      // Belt and braces: the button is already disabled in this state.
      this.reportCommand({ ok: false, reason: "armed", message: describeReason("armed") });
      return;
    }

    const isReal = (state.telemetry?.mode || state.config?.config?.mode) === "real";
    if (isReal) {
      const accepted = this.confirm(
        `実機のフライトモードを ${mode} に変更します。\n\n` +
          "・プロペラが取り外されていることを確認してください\n" +
          "・機体がDISARMED（解除）であることを確認してください\n" +
          "・周囲に人がいないことを確認してください\n\n" +
          "実行しますか？"
      );
      if (!accepted) {
        this.reportCommand({ ok: false, reason: "cancelled", message: "操作をキャンセルしました。" });
        return;
      }
    }

    await this.run(async () => {
      try {
        const result = await this.client.setMode(mode, { confirmed: isReal });
        const finalMode = result?.detail?.finalMode;
        this.reportCommand({
          ok: true,
          reason: "accepted",
          message: `機体が報告した現在のモード: ${finalMode || "不明"}`
        });
      } catch (error) {
        const finalMode = error.detail?.finalMode;
        this.reportCommand({
          ok: false,
          reason: error.reason,
          message: finalMode ? `${error.message}（機体の現在モード: ${finalMode}）` : error.message
        });
      }
    });
  }
}
