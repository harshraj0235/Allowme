/**
 * bluetooth.js — Web Bluetooth for Allowme.
 *
 * Handles real BLE device scanning, connection, and data exchange.
 * Works WITHOUT internet — uses Bluetooth radio directly.
 *
 * Architecture:
 *  - Browser acts as BLE Central (scanner/client)
 *  - Uses navigator.bluetooth.requestDevice() for secure device picking
 *  - Scans multiple times to build a device list
 *  - Connects via GATT for room code exchange
 *  - Falls back to generated room codes when GATT service isn't available
 *
 * NOTE: Web Bluetooth only works in Chrome/Edge on HTTPS or localhost.
 *       iOS Safari does NOT support Web Bluetooth.
 */

// Custom BLE Service & Characteristic UUIDs for Allowme pairing
const ALLOWME_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const ALLOWME_ROOM_CHAR_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

export class BluetoothPairing {
  constructor() {
    this._handlers = {};
    this._scanning = false;
    this._devices = []; // { device, name, id, rssi, connected }
    this._connectedDevice = null;
    this._server = null;
  }

  // ── Feature Detection ───────────────────────────────────

  static isSupported() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  static getUnsupportedReason() {
    if (!navigator.bluetooth) {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes('firefox')) return 'Firefox does not support Web Bluetooth. Please use Chrome or Edge.';
      if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari/iOS does not support Web Bluetooth. Please use Chrome on Android or Desktop.';
      if (!window.isSecureContext) return 'Bluetooth requires HTTPS. Please access this page over a secure connection.';
      return 'Your browser does not support Web Bluetooth. Try Chrome or Edge.';
    }
    return null;
  }

  /**
   * Check if device has Bluetooth hardware available.
   * @returns {Promise<boolean>}
   */
  static async isAvailable() {
    try {
      if (!navigator.bluetooth) return false;
      if (navigator.bluetooth.getAvailability) {
        return await navigator.bluetooth.getAvailability();
      }
      return true; // assume available if can't check
    } catch {
      return false;
    }
  }

  // ── Scan for a single device (browser picker) ───────────

  /**
   * Opens the browser's BLE device picker. The user selects a device.
   * Returns the selected device info.
   *
   * @returns {Promise<{name, id, device}|null>}
   */
  async scanOnce() {
    if (!BluetoothPairing.isSupported()) {
      this._emit('error', { message: BluetoothPairing.getUnsupportedReason() });
      return null;
    }

    this._scanning = true;
    this._emit('scan-start');

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [ALLOWME_SERVICE_UUID] },
          { namePrefix: 'Allowme' }
        ],
        optionalServices: ['battery_service', 'device_information']
      });

      if (!device) {
        this._scanning = false;
        this._emit('scan-end', { found: false });
        return null;
      }

      const info = {
        name: device.name || 'Unknown BLE Device',
        id: device.id,
        device
      };

      // Check if already in our list
      const existing = this._devices.find(d => d.id === device.id);
      if (!existing) {
        this._devices.push(info);
      }

      // Listen for disconnect
      device.addEventListener('gattserverdisconnected', () => {
        this._emit('device-disconnected', { id: device.id, name: info.name });
        if (this._connectedDevice?.id === device.id) {
          this._connectedDevice = null;
          this._server = null;
        }
      });

      this._scanning = false;
      this._emit('device-found', info);
      this._emit('scan-end', { found: true, device: info });
      return info;

    } catch (err) {
      this._scanning = false;
      if (err.name === 'NotFoundError') {
        this._emit('scan-end', { found: false, cancelled: true });
      } else {
        this._emit('error', { message: err.message || 'Bluetooth scan failed' });
      }
      return null;
    }
  }

  /**
   * Get the list of previously paired/discovered devices (Chrome 85+).
   * These don't require the picker dialog.
   *
   * @returns {Promise<Array>}
   */
  async getSavedDevices() {
    try {
      if (navigator.bluetooth.getDevices) {
        const devices = await navigator.bluetooth.getDevices();
        return devices.map(d => ({
          name: d.name || 'Saved Device',
          id: d.id,
          device: d,
          saved: true
        }));
      }
    } catch (e) {
      console.log('⚡ getDevices not available:', e.message);
    }
    return [];
  }

  // ── Connect to a BLE device ─────────────────────────────

  /**
   * Connect to a discovered BLE device via GATT.
   * Tries to read the Allowme service for room code exchange.
   * If the service doesn't exist (expected for non-Allowme devices),
   * generates a room code that both devices can use.
   *
   * @param {object} deviceInfo - { device, name, id } from scanOnce/getSavedDevices
   * @returns {Promise<{roomCode, deviceName, connected}|null>}
   */
  async connectToDevice(deviceInfo) {
    if (!deviceInfo?.device?.gatt) {
      this._emit('error', { message: 'Invalid device' });
      return null;
    }

    this._emit('connecting', { name: deviceInfo.name, id: deviceInfo.id });

    try {
      this._server = await deviceInfo.device.gatt.connect();
      this._connectedDevice = deviceInfo;

      this._emit('connected', {
        name: deviceInfo.name,
        id: deviceInfo.id
      });

      // Try to read room code from Allowme GATT service
      let roomCode = null;
      try {
        const service = await this._server.getPrimaryService(ALLOWME_SERVICE_UUID);
        const char = await service.getCharacteristic(ALLOWME_ROOM_CHAR_UUID);
        const value = await char.readValue();
        roomCode = new TextDecoder().decode(value);
        if (roomCode && roomCode.length >= 4) {
          this._emit('code-received', { roomCode, device: deviceInfo.name });
        } else {
          roomCode = null;
        }
      } catch {
        // Expected — most devices won't have our custom GATT service
        console.log('⚡ Allowme GATT service not found (expected for non-Allowme devices)');
      }

      // Try to get device info from standard services
      let deviceDetails = {};
      try {
        const diService = await this._server.getPrimaryService('device_information');
        try {
          const mfr = await diService.getCharacteristic('manufacturer_name_string');
          const val = await mfr.readValue();
          deviceDetails.manufacturer = new TextDecoder().decode(val);
        } catch {}
      } catch {}

      // Try battery level
      try {
        const batService = await this._server.getPrimaryService('battery_service');
        const batChar = await batService.getCharacteristic('battery_level');
        const batVal = await batChar.readValue();
        deviceDetails.battery = batVal.getUint8(0);
      } catch {}

      // Generate room code if none was exchanged
      if (!roomCode) {
        roomCode = this._generateRoomCode();
        this._emit('code-generated', { roomCode, device: deviceInfo.name });
      }

      return {
        roomCode,
        deviceName: deviceInfo.name,
        connected: true,
        details: deviceDetails
      };

    } catch (err) {
      this._emit('error', {
        message: `Connection failed: ${err.message}`,
        id: deviceInfo.id
      });
      return null;
    }
  }

  // ── Full flow: scan → select → connect ──────────────────

  /**
   * Complete pairing flow: opens picker, user selects device, connects.
   * @returns {Promise<{roomCode, deviceName}|null>}
   */
  async pairAndGetCode() {
    const device = await this.scanOnce();
    if (!device) return null;
    return this.connectToDevice(device);
  }

  // ── Get discovered devices ──────────────────────────────

  getDevices() {
    return [...this._devices];
  }

  clearDevices() {
    this._devices = [];
  }

  // ── Cleanup ─────────────────────────────────────────────

  disconnect() {
    if (this._server && this._server.connected) {
      try { this._server.disconnect(); } catch {}
    }
    this._server = null;
    this._connectedDevice = null;
  }

  disconnectAll() {
    this._devices.forEach(d => {
      try { d.device?.gatt?.disconnect(); } catch {}
    });
    this._devices = [];
    this._connectedDevice = null;
    this._server = null;
  }

  // ── Helpers ─────────────────────────────────────────────

  _generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // ── Event Emitter ───────────────────────────────────────

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter(h => h !== handler);
    }
    return this;
  }

  _emit(event, data) {
    const handlers = this._handlers[event];
    if (handlers) {
      handlers.forEach(h => {
        try { h(data); } catch (e) { console.error(`BT [${event}]:`, e); }
      });
    }
  }
}
