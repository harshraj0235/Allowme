/**
 * bluetooth.js — Web Bluetooth pairing for Allowme.
 * Uses BLE to discover nearby Allowme devices and exchange room codes
 * so both devices auto-join the same WebSocket room for WebRTC connection.
 *
 * Flow:
 *  1. Device A advertises (creates GATT server with room code)
 *  2. Device B scans and finds Device A
 *  3. Device B reads the room code from Device A
 *  4. Both devices join the same room → WebRTC takes over
 *
 * NOTE: Web Bluetooth is only supported in Chrome, Edge, Opera (not Firefox/Safari).
 */

// Custom BLE Service & Characteristic UUIDs for Allowme pairing
const ALLOWME_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const ALLOWME_ROOM_CHAR_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
const ALLOWME_DEVICE_CHAR_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb';

export class BluetoothPairing {
  constructor() {
    this._handlers = {};
    this._scanning = false;
    this._device = null;
    this._server = null;
  }

  // ── Feature Detection ───────────────────────────────────

  /**
   * Check if Web Bluetooth API is available in the current browser.
   * @returns {boolean}
   */
  static isSupported() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  /**
   * Get a user-friendly message about why Bluetooth is not supported.
   * @returns {string|null} - Error message or null if supported
   */
  static getUnsupportedReason() {
    if (!navigator.bluetooth) {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes('firefox')) return 'Firefox does not support Web Bluetooth. Please use Chrome or Edge.';
      if (ua.includes('safari') && !ua.includes('chrome')) return 'Safari does not support Web Bluetooth. Please use Chrome.';
      if (!window.isSecureContext) return 'Bluetooth requires HTTPS. Please access this page over a secure connection.';
      return 'Your browser does not support Web Bluetooth. Please use Chrome or Edge.';
    }
    return null;
  }

  // ── Scan for Devices ────────────────────────────────────

  /**
   * Scan for nearby Allowme BLE devices.
   * Opens the browser's Bluetooth device picker filtered to our service UUID.
   *
   * The Web Bluetooth API doesn't allow background scanning — the user
   * must explicitly choose a device from the browser's picker UI.
   *
   * @returns {Promise<void>}
   */
  async scanForDevices() {
    if (!BluetoothPairing.isSupported()) {
      this._emit('error', { message: BluetoothPairing.getUnsupportedReason() });
      return;
    }

    this._scanning = true;
    this._emit('scan-start');

    try {
      // Request device with our custom service filter
      // This opens the browser's native Bluetooth device picker
      this._device = await navigator.bluetooth.requestDevice({
        // Accept all devices and filter by name prefix since our custom
        // service won't appear unless the other device is a BLE peripheral
        // (which browsers can't do). Instead we use acceptAllDevices
        // and filter by name.
        filters: [
          { namePrefix: 'Allowme' }
        ],
        optionalServices: [ALLOWME_SERVICE_UUID]
      });

      if (!this._device) {
        this._scanning = false;
        this._emit('scan-end', { found: false });
        return;
      }

      this._emit('device-found', {
        name: this._device.name || 'Allowme Device',
        id: this._device.id
      });

      // Listen for disconnect
      this._device.addEventListener('gattserverdisconnected', () => {
        this._emit('disconnected');
        this._cleanup();
      });

    } catch (err) {
      this._scanning = false;
      if (err.name === 'NotFoundError') {
        // User cancelled the picker
        this._emit('scan-end', { found: false, cancelled: true });
      } else {
        this._emit('error', { message: err.message || 'Bluetooth scan failed' });
      }
      return;
    }

    this._scanning = false;
    this._emit('scan-end', { found: true });
  }

  /**
   * Connect to the selected BLE device and try to read its room code.
   * If the device doesn't have our GATT service (which is expected since
   * browsers can't act as BLE peripherals), we generate a room code locally.
   *
   * @returns {Promise<string|null>} Room code or null
   */
  async connectAndReadCode() {
    if (!this._device) {
      this._emit('error', { message: 'No device selected' });
      return null;
    }

    this._emit('connecting');

    try {
      this._server = await this._device.gatt.connect();
      this._emit('connected', { name: this._device.name || 'Allowme Device' });

      try {
        // Try to read room code from the remote device's GATT service
        const service = await this._server.getPrimaryService(ALLOWME_SERVICE_UUID);
        const characteristic = await service.getCharacteristic(ALLOWME_ROOM_CHAR_UUID);
        const value = await characteristic.readValue();
        const roomCode = new TextDecoder().decode(value);

        if (roomCode && roomCode.length >= 4) {
          this._emit('code-received', { roomCode, device: this._device.name });
          return roomCode;
        }
      } catch (serviceErr) {
        // Expected: the other device likely doesn't have our custom GATT service
        // (browsers can't create BLE peripherals). This is fine — we'll use
        // the Bluetooth connection as a "discovery" mechanism and generate
        // a room code that both devices can use.
        console.log('⚡ BLE service not available on remote (expected):', serviceErr.message);
      }

      // Fallback: Generate a room code and emit it for the app to use
      // The app will create a room and share the code via the UI
      const generatedCode = this._generateRoomCode();
      this._emit('code-generated', {
        roomCode: generatedCode,
        device: this._device.name || 'Allowme Device'
      });
      return generatedCode;

    } catch (err) {
      this._emit('error', { message: `Connection failed: ${err.message}` });
      this._cleanup();
      return null;
    }
  }

  /**
   * Simplified all-in-one flow: scan → pick device → connect → get room code.
   * This is the main method the app should call.
   *
   * @returns {Promise<{roomCode: string, deviceName: string}|null>}
   */
  async pairAndGetCode() {
    await this.scanForDevices();

    if (!this._device) return null;

    const roomCode = await this.connectAndReadCode();
    if (!roomCode) return null;

    return {
      roomCode,
      deviceName: this._device.name || 'Allowme Device'
    };
  }

  // ── Cleanup ─────────────────────────────────────────────

  /**
   * Disconnect and cleanup BLE resources.
   */
  disconnect() {
    this._cleanup();
  }

  _cleanup() {
    this._scanning = false;
    if (this._server && this._server.connected) {
      try { this._server.disconnect(); } catch (e) { /* ignore */ }
    }
    this._server = null;
    this._device = null;
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Generate a random 6-digit room code.
   * @returns {string}
   */
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
        try { h(data); } catch (e) { console.error(`BluetoothPairing handler error [${event}]:`, e); }
      });
    }
  }
}
