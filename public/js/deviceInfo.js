/**
 * deviceInfo.js — Detects device type, name, OS, browser, network type.
 * Persistent device ID across sessions. Telegram-style device labeling.
 */

/**
 * Generate or retrieve a persistent device ID.
 */
function getDeviceId() {
  let id = localStorage.getItem('allowme-device-id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    localStorage.setItem('allowme-device-id', id);
  }
  return id;
}

/**
 * Detect network type via navigator.connection.
 */
function getNetworkType() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return { type: 'unknown', downlink: null, effectiveType: null };
  return {
    type: conn.type || 'unknown',
    downlink: conn.downlink || null,
    effectiveType: conn.effectiveType || null,
    rtt: conn.rtt || null,
  };
}

export function getDeviceInfo() {
  const ua = navigator.userAgent;
  let type = 'desktop';
  let name = 'Unknown Device';
  let os = 'Unknown';
  let icon = 'monitor';

  // ── iOS ──────────────────────────────────────────────────
  if (/iPhone/.test(ua)) {
    type = 'phone';
    icon = 'smartphone';
    os = 'iOS';
    const ver = ua.match(/iPhone OS (\d+_\d+)/);
    name = ver ? `iPhone (iOS ${ver[1].replace('_', '.')})` : 'iPhone';
  } else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) {
    type = 'tablet';
    icon = 'tablet';
    os = 'iPadOS';
    name = 'iPad';
  }
  // ── Android ──────────────────────────────────────────────
  else if (/Android/.test(ua)) {
    os = 'Android';
    if (/Mobile/.test(ua)) {
      type = 'phone';
      icon = 'smartphone';
    } else {
      type = 'tablet';
      icon = 'tablet';
    }
    const match = ua.match(/Android[^;]*;\s*(.+?)\s*(?:Build|;|\))/);
    if (match) {
      let model = match[1].trim();
      model = model.replace(/^(SAMSUNG|HUAWEI|XIAOMI|OPPO|VIVO|REALME|ONEPLUS)\s*/i, '');
      name = model || 'Android Phone';
    } else {
      name = type === 'tablet' ? 'Android Tablet' : 'Android Phone';
    }
  }
  // ── Windows ──────────────────────────────────────────────
  else if (/Windows/.test(ua)) {
    os = 'Windows';
    icon = 'monitor';
    name = 'Windows PC';
  }
  // ── macOS ────────────────────────────────────────────────
  else if (/Macintosh/.test(ua)) {
    os = 'macOS';
    icon = 'monitor';
    name = 'Mac';
  }
  // ── Linux ────────────────────────────────────────────────
  else if (/Linux/.test(ua)) {
    os = 'Linux';
    icon = 'monitor';
    name = 'Linux PC';
  }
  // ── ChromeOS ─────────────────────────────────────────────
  else if (/CrOS/.test(ua)) {
    os = 'ChromeOS';
    icon = 'monitor';
    name = 'Chromebook';
  }

  // ── Browser Detection ────────────────────────────────────
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';

  // Generate a consistent color for this device
  const colors = ['#00d4ff', '#7c3aed', '#f43f5e', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];
  const deviceId = getDeviceId();
  const colorIndex = deviceId.charCodeAt(0) % colors.length;
  const color = colors[colorIndex];

  const network = getNetworkType();

  return { type, name, os, icon, browser, color, deviceId, network };
}

/**
 * Returns an SVG icon string for the device type.
 */
export function getDeviceIcon(type) {
  const icons = {
    phone: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
    smartphone: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
    tablet: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
    monitor: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  };
  return icons[type] || icons.monitor;
}

/**
 * Returns a human-friendly label like "iPhone · Safari"
 */
export function getDeviceLabel(info) {
  return `${info.name} · ${info.browser}`;
}
