// User-driven BLE GATT explorer. UUIDs below are discovery allowlist entries,
// never receiver profile claims; data determines whether a characteristic is useful.
import { NmeaLineSplitter } from "./qz1le-bluetooth.js";

export const BLE_EXPLORER_OPTIONAL_SERVICES = [
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART
  "0000ffe0-0000-1000-8000-00805f9b34fb", // HM-10 family
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip transparent UART
  "0000ff00-0000-1000-8000-00805f9b34fb", // common UART bridge family
  "0000180a-0000-1000-8000-00805f9b34fb"  // Device Information
];

export function isChecksumValidNmea(line) {
  const value = String(line || "").trim();
  const star = value.lastIndexOf("*");
  if (!value.startsWith("$") || star < 2 || !/^[0-9A-Fa-f]{2}$/.test(value.slice(star + 1))) return false;
  let checksum = 0;
  for (let i = 1; i < star; i += 1) checksum ^= value.charCodeAt(i);
  return checksum === Number.parseInt(value.slice(star + 1), 16);
}

export function hasTwoValidNmeaSentences(lines) {
  return lines.filter(isChecksumValidNmea).length >= 2;
}

export function saveRuntimeBleProfile(storage, profile) {
  const normalized = {
    serviceUuid: String(profile?.serviceUuid || "").toLowerCase(),
    notifyCharacteristicUuid: String(profile?.notifyCharacteristicUuid || "").toLowerCase(),
    deviceName: String(profile?.deviceName || "").trim(),
    deviceId: String(profile?.deviceId || "")
  };
  if (!normalized.serviceUuid || !normalized.notifyCharacteristicUuid) throw new TypeError("BLE service and characteristic UUIDs are required");
  storage.setItem("suisui.qz1le.bleProfile", JSON.stringify(normalized));
  return normalized;
}

export function readRuntimeBleProfile(storage) {
  try {
    const value = JSON.parse(storage?.getItem("suisui.qz1le.bleProfile") || "null");
    return value?.serviceUuid && value?.notifyCharacteristicUuid ? value : null;
  } catch { return null; }
}

export function mergeBleProfile(committed, runtime) {
  const committedReady = Boolean(committed?.serviceUuid && committed?.notifyCharacteristicUuid);
  return committedReady ? { ...committed, source: "committed" }
    : runtime?.serviceUuid && runtime?.notifyCharacteristicUuid ? { ...runtime, configured: true, reason: null, source: "device-local" }
      : committed;
}

export class Qz1LeBleExplorer {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onState = () => {}, onData = () => {}, onError = () => {} } = {}) {
    this.bluetooth = bluetooth;
    this.onState = onState;
    this.onData = onData;
    this.onError = onError;
    this.device = null;
    this.services = [];
    this.activeCharacteristic = null;
    this.splitter = new NmeaLineSplitter();
    this.receivedLines = [];
    this._onValue = this._onValue.bind(this);
  }

  async discover() {
    if (!this.bluetooth?.requestDevice) throw new Error("このブラウザではWeb Bluetoothを利用できません。");
    this.onState("選択中");
    this.device = await this.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_EXPLORER_OPTIONAL_SERVICES });
    this.onState("接続中");
    const server = await this.device.gatt.connect();
    const allServices = await server.getPrimaryServices();
    this.services = [];
    for (const service of allServices) {
      const characteristics = await service.getCharacteristics();
      this.services.push({ service, characteristics: characteristics.map((characteristic) => ({ characteristic, properties: { ...characteristic.properties } })) });
    }
    this.onState("探索完了");
    return { device: this.device, services: this.services };
  }

  async subscribe(serviceUuid, characteristicUuid) {
    const serviceItem = this.services.find((entry) => entry.service.uuid === serviceUuid);
    const item = serviceItem?.characteristics.find((entry) => entry.characteristic.uuid === characteristicUuid);
    if (!item || !(item.characteristic.properties.notify || item.characteristic.properties.indicate)) throw new Error("Notify / Indicate対応キャラクタリスティックを選択してください。");
    await item.characteristic.startNotifications();
    item.characteristic.addEventListener("characteristicvaluechanged", this._onValue);
    this.activeCharacteristic = item.characteristic;
    return { serviceUuid, notifyCharacteristicUuid: characteristicUuid, deviceName: this.device?.name || "", deviceId: this.device?.id || "" };
  }

  async stop() {
    this.activeCharacteristic?.removeEventListener("characteristicvaluechanged", this._onValue);
    await this.activeCharacteristic?.stopNotifications?.();
    this.activeCharacteristic = null;
  }

  _onValue(event) {
    const bytes = new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength);
    const { lines } = this.splitter.push(bytes);
    for (const line of lines) {
      if (!line) continue;
      this.receivedLines.push(line);
      this.onData({ line, ascii: [...bytes].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join(""), hex: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" "), nmeaCandidate: hasTwoValidNmeaSentences(this.receivedLines) });
    }
  }
}
