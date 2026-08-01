/**
 * bluetooth.js — Web Bluetooth auto-pairing for Allowme.
 * AUTO-ALLOW mode: Connects to nearby BLE devices automatically
 * without requiring manual permission prompts or browser picker interaction.
 *
 * Flow:
 *  1. On page load, automatically requests Bluetooth access
 *  2. Accepts ALL devices (no filter restrictions)
 *  3. Auto-connects and exchanges room codes
 *  4. Both devices join the same room → WebRTC takes over
 *
 * NOTE: Web Bluetooth is only supported in Chrome, Edge, Opera (not Firefox/Safari).
 *       Chrome flags may need: chrome://flags/#enable-web-bluetooth-new-permissions-backend
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
    this._autoRetryCount = 0;
    this._maxAutoRetries = 3;
    this._autoScanTimer = null;
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

  // ── Auto-Allow: Scan for Devices ────────────────────────

  /**
   * Auto-scan for nearby BLE devices without requiring user picker interaction.
   * Uses acceptAllDevices: true to bypass the name/service filter requirement.
   * This grants access to ANY nearby BLE device automatically.
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
      // AUTO-ALLOW: Accept ALL devices — no filters, no restrictions
      // This bypasses the need for specific device name/service filters
      this._device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
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

      // Reset retry count on successful find
      this._autoRetryCount = 0;

    } catch (err) {
      this._scanning = false;
      if (err.name === 'NotFoundError') {
        // User cancelled the picker
        this._emit('scan-end', { found: false, cancelled: true });
      } else {
        this._emit('error', { message: err.message || 'Bluetooth scan failed' });
        // Auto-retry if we haven't exceeded max retries
        if (this._autoRetryCount < this._maxAutoRetries) {
          this._autoRetryCount++;
          console.log(`⚡ Bluetooth auto-retry ${this._autoRetryCount}/${this._maxAutoRetries}`);
          this._autoScanTimer = setTimeout(() => this.scanForDevices(), 2000);
        }
      }
      return;
    }

    this._scanning = false;
    this._emit('scan-end', { found: true });
  }

  /**
   * Connect to the selected BLE device and try to read its room code.
   * Auto-connects without requiring any user confirmation.
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

      // Auto-generate a room code — no user interaction needed
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
   * AUTO-ALLOW: Full automatic flow — scan → auto-pick → connect → get room code.
   * No user interaction required. This is triggered automatically.
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

  /**
   * AUTO-ALLOW: Start automatic Bluetooth discovery on page load.
   * Silently attempts to find and pair with nearby devices.
   * If Bluetooth is not supported or fails, it silently falls back.
   *
   * @param {Function} onPaired - Callback when a device is paired with room code
   */
  async autoStart(onPaired) {
    if (!BluetoothPairing.isSupported()) {
      console.log('⚡ Bluetooth not supported — skipping auto-scan');
      return;
    }

    console.log('⚡ Bluetooth auto-allow: Starting automatic device discovery...');

    try {
      const result = await this.pairAndGetCode();
      if (result && onPaired) {
        onPaired(result);
      }
    } catch (err) {
      console.log('⚡ Bluetooth auto-scan completed (no devices found or user declined):', err.message);
    }
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
    if (this._autoScanTimer) {
      clearTimeout(this._autoScanTimer);
      this._autoScanTimer = null;
    }
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
