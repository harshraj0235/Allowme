/**
 * ═══════════════════════════════════════════════════════════════════
 * Allowme — App Controller
 * Discovery → Success Popup → Connected (Chat + Files Tabs)
 * ═══════════════════════════════════════════════════════════════════
 */

import { SignalingClient } from './signaling.js';
import { PeerConnection } from './webrtc.js';
import { FileTransfer } from './fileTransfer.js';
import { getDeviceInfo } from './deviceInfo.js';
import { BluetoothPairing } from './bluetooth.js';

function getDeviceLabel(d) {
  return `${d.name || 'Device'} · ${d.browser || ''}`.trim();
}
function getDeviceEmoji(d) {
  const n = (d?.name || '').toLowerCase();
  if (n.includes('iphone') || n.includes('ipad')) return '📱';
  if (n.includes('android')) return '📱';
  if (n.includes('mac')) return '💻';
  if (n.includes('linux')) return '🐧';
  return '🖥️';
}

class AllowmeApp {
  constructor() {
    this.deviceInfo = getDeviceInfo();
    this.signaling = new SignalingClient();
    this.peers = new Map();
    this.connections = new Map();
    this.selectedPeerId = null;
    this.connectedPeerId = null;
    this.selectedFiles = [];
    this.peerPositionIndex = 0;
    this.iceServers = null;

    // Chat
    this._chatMessages = [];
    this._unreadCount = 0;
    this._typingTimeout = null;
    this._lastTypingSent = 0;
    this._pendingImage = null; // { base64, name }

    // Camera
    this._cameraStream = null;
    this._facingMode = 'user';

    // Screen sharing
    this._screenStream = null;

    // Clipboard
    this._clipboardItems = [];

    // History (IndexedDB)
    this._historyDB = null;

    // Bluetooth
    this._bluetooth = new BluetoothPairing();
    this._pendingPairRequest = null; // { from, deviceInfo }
    this._pairRequestTimer = null;
    this._pairRequestTimeout = 30000; // 30 seconds to accept
    this._waitingForPairResponse = null; // peerId we're waiting response from

    this.dom = {};
    this._cacheDom();
  }

  _cacheDom() {
    const ids = [
      'discoveryPage', 'connectedPage', 'successPopup',
      'connectionStatus', 'statusText', 'radarContainer', 'noPeers',
      'themeToggle', 'themeIcon', 'themeToggle2', 'themeIcon2',
      // Success popup
      'successPeerName', 'successConnType', 'startChatBtn',
      // Connected header
      'connectedAvatar', 'connHeaderName', 'connHeaderType', 'disconnectBtn',
      'e2eeIndicator',
      // Tabs (bottom nav primary)
      'tabChat', 'tabFiles', 'tabCall',
      // Tabs (more panel)
      'tabScreen', 'tabClipboard', 'tabHistory',
      // Tab content panels
      'chatTab', 'filesTab', 'screenTab', 'callTab', 'clipboardTab', 'historyTab',
      'chatTabBadge',
      // Bottom nav & More panel
      'bottomNav', 'moreBtn', 'morePanel', 'morePanelOverlay',
      // Chat
      'chatMessages', 'chatInput', 'chatSendBtn', 'chatEmpty',
      'cameraBtn', 'imageUploadBtn', 'imageFileInput',
      'imagePreview', 'previewImg', 'previewName', 'cancelPreview',
      // Camera modal
      'cameraModal', 'cameraModalClose', 'cameraVideo', 'cameraCanvas',
      'captureBtn', 'switchCameraBtn', 'retakeBtn', 'sendPhotoBtn',
      // Files
      'dropZone', 'fileInput', 'selectedFiles', 'selectedCount', 'fileList',
      'sendBar', 'sendBtn', 'sendBtnText',
      'transfersSection', 'transferList', 'receivedSection', 'receivedList',
      'pauseAllBtn', 'resumeAllBtn',
      // Screen sharing
      'screenVideo', 'screenPlaceholder', 'shareScreenBtn', 'stopScreenBtn', 'shareScreenText',
      'fullscreenBtn', 'screenVideoWrapper',
      // Call
      'tabCall', 'callTab', 'callPlaceholder', 'callVideoWrapper', 'callRemoteVideo', 'callLocalVideo',
      'startAudioCallBtn', 'startVideoCallBtn', 'toggleMicBtn', 'toggleCamBtn', 'endCallBtn', 'micIcon', 'camIcon',
      // Clipboard
      'clipboardSyncBtn', 'clipboardPasteZone', 'clipboardList',
      // History
      'historyList', 'clearHistoryBtn',
      // Modals
      'qrBtn', 'roomBtn', 'qrModal', 'qrModalClose', 'qrCodeContainer', 'qrRoomCode', 'copyQrLink',
      'roomModal', 'roomModalClose', 'generatedRoomCode', 'newRoomBtn', 'copyRoomCode', 'roomCodeInput', 'joinRoomBtn',
      // Bluetooth
      'bluetoothBtn', 'bluetoothModal', 'bluetoothModalClose',
      'btUnsupported', 'btUnsupportedReason', 'btScanSection',
      'btStatus', 'btStatusIcon', 'btStatusText',
      'btScanAnim', 'btDeviceCard', 'btDeviceName', 'btDeviceStatus', 'btScanBtn', 'btScanBtnText', 'btSubtitle',
      'btScanBtnIcon', 'btDeviceList', 'btDeviceItems', 'btDeviceBattery', 'btBatteryLevel',
      // BT Pairing Notification
      'btPairNotification', 'btPairDeviceEmoji', 'btPairDeviceName', 'btPairDeviceDetail',
      'btPairTimerBar', 'btPairAcceptBtn', 'btPairRejectBtn',
      'toastContainer',
      // Quality
      'qualityBar', 'qualitySpeed', 'qualityRtt', 'qualityChunk',
    ];
    ids.forEach(id => { this.dom[id] = document.getElementById(id); });
  }

  // ═══════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════

  async init() {
    this._showPage('discovery');
    this._loadTheme();
    this._setupUI();
    this._setupSignaling();
    this._setupBtPairing();
    await this._initHistoryDB();

    try {
      const res = await fetch('/api/turn-credentials');
      const data = await res.json();
      this.iceServers = data.iceServers;
    } catch (e) { console.warn('TURN fetch failed', e); }

    // Check URL for room code
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    const savedRoom = localStorage.getItem('allowme_room');
    const targetRoom = room || savedRoom || undefined;

    this.signaling.connect(this.deviceInfo, targetRoom);
  }

  _showPage(page) {
    this.dom.discoveryPage?.classList.toggle('active', page === 'discovery');
    this.dom.connectedPage?.classList.toggle('active', page === 'connected');
  }

  // ═══════════════════════════════════════════════════════════
  // SIGNALING
  // ═══════════════════════════════════════════════════════════

  _setupSignaling() {
    this.signaling.on('connected', () => {
      this.dom.connectionStatus.className = 'connection-status connected';
      this.dom.statusText.textContent = 'Online — discovering devices';
    });
    this.signaling.on('disconnected', () => {
      this.dom.connectionStatus.className = 'connection-status disconnected';
      this.dom.statusText.textContent = 'Disconnected — reconnecting...';
    });
    this.signaling.on('reconnecting', () => {
      this.dom.connectionStatus.className = 'connection-status connecting';
      this.dom.statusText.textContent = 'Reconnecting...';
    });

    this.signaling.on('peer-joined', (msg) => this._addPeer(msg));
    this.signaling.on('peer-left', (msg) => this._removePeer(msg.peerId));
    this.signaling.on('signal', (msg) => this._handleIncomingSignal(msg));

    // Bluetooth pairing via signaling
    this.signaling.on('bt-pair-request', (msg) => this._onBtPairRequest(msg));
    this.signaling.on('bt-pair-response', (msg) => this._onBtPairResponse(msg));

    this.signaling.on('room-created', (msg) => {
      this.dom.generatedRoomCode.textContent = msg.roomCode;
      this._updateQR(msg.roomCode);
      this.dom.qrRoomCode.textContent = msg.roomCode;
      this._toast('success', `Room ${msg.roomCode} created`);
    });
    this.signaling.on('joined-room', (msg) => {
      this._toast('success', `Joined room ${msg.roomCode}`);
      this.dom.generatedRoomCode.textContent = msg.roomCode;
    });
  }

  // ═══════════════════════════════════════════════════════════
  // UI SETUP
  // ═══════════════════════════════════════════════════════════

  _setupUI() {
    // Theme toggles (both pages)
    this.dom.themeToggle?.addEventListener('click', () => this._toggleTheme());
    this.dom.themeToggle2?.addEventListener('click', () => this._toggleTheme());

    // Tab switching (bottom nav primary buttons)
    this.dom.tabChat?.addEventListener('click', () => this._switchTab('chat'));
    this.dom.tabFiles?.addEventListener('click', () => this._switchTab('files'));
    this.dom.tabCall?.addEventListener('click', () => this._switchTab('call'));

    // More panel
    this.dom.moreBtn?.addEventListener('click', () => this._toggleMorePanel());
    this.dom.morePanelOverlay?.addEventListener('click', () => this._closeMorePanel());

    // More panel items (open tab & close panel)
    this.dom.tabScreen?.addEventListener('click', () => { this._switchTab('screen'); this._closeMorePanel(); });
    this.dom.tabClipboard?.addEventListener('click', () => { this._switchTab('clipboard'); this._closeMorePanel(); });
    this.dom.tabHistory?.addEventListener('click', () => { this._switchTab('history'); this._loadHistory(); this._closeMorePanel(); });

    // Success popup
    this.dom.startChatBtn?.addEventListener('click', () => {
      this.dom.successPopup.classList.remove('visible');
      this._showPage('connected');
      this._switchTab('chat');
    });

    // ── Chat ──
    this.dom.chatSendBtn?.addEventListener('click', () => this._sendChatMessage());
    this.dom.chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendChatMessage(); }
    });
    this.dom.chatInput?.addEventListener('input', () => {
      const now = Date.now();
      if (now - this._lastTypingSent > 2000) {
        this._lastTypingSent = now;
        const conn = this.connections.get(this.connectedPeerId);
        if (conn) conn.ft.sendTyping(true);
      }
      clearTimeout(this._typingTimeout);
      this._typingTimeout = setTimeout(() => {
        const conn = this.connections.get(this.connectedPeerId);
        if (conn) conn.ft.sendTyping(false);
      }, 3000);
    });

    // Camera
    this.dom.cameraBtn?.addEventListener('click', () => this._openCamera());
    this.dom.cameraModalClose?.addEventListener('click', () => this._closeCamera());
    this.dom.captureBtn?.addEventListener('click', () => this._capturePhoto());
    this.dom.switchCameraBtn?.addEventListener('click', () => this._switchCamera());
    this.dom.retakeBtn?.addEventListener('click', () => this._retakePhoto());
    this.dom.sendPhotoBtn?.addEventListener('click', () => this._sendCapturedPhoto());

    // Image upload
    this.dom.imageUploadBtn?.addEventListener('click', () => this.dom.imageFileInput?.click());
    this.dom.imageFileInput?.addEventListener('change', (e) => {
      if (e.target.files.length) this._prepareImageUpload(e.target.files[0]);
      e.target.value = '';
    });
    this.dom.cancelPreview?.addEventListener('click', () => this._cancelImagePreview());

    // ── Files Tab ──
    const dz = this.dom.dropZone;
    if (dz) {
      dz.addEventListener('click', () => this.dom.fileInput.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag-over');
        if (e.dataTransfer.items) this._handleDropItems(e.dataTransfer.items);
        else if (e.dataTransfer.files.length) this._addFiles(Array.from(e.dataTransfer.files));
      });
    }
    this.dom.fileInput?.addEventListener('change', (e) => {
      this._addFiles(Array.from(e.target.files)); e.target.value = '';
    });
    this.dom.sendBtn?.addEventListener('click', () => this._sendFiles());
    this.dom.pauseAllBtn?.addEventListener('click', () => { const c = this.connections.get(this.connectedPeerId); if (c) c.ft.pauseSend(); });
    this.dom.resumeAllBtn?.addEventListener('click', () => { const c = this.connections.get(this.connectedPeerId); if (c) c.ft.resumeSend(); });

    // ── Screen sharing ──
    this.dom.shareScreenBtn?.addEventListener('click', () => this._startScreenShare());
    this.dom.stopScreenBtn?.addEventListener('click', () => this._stopScreenShare());
    this.dom.fullscreenBtn?.addEventListener('click', () => this._toggleScreenFullscreen());

    // ── Call ──
    this.dom.startAudioCallBtn?.addEventListener('click', () => this._startCall('audio'));
    this.dom.startVideoCallBtn?.addEventListener('click', () => this._startCall('video'));
    this.dom.endCallBtn?.addEventListener('click', () => this._stopCall());
    this.dom.toggleMicBtn?.addEventListener('click', () => this._toggleCallMic());
    this.dom.toggleCamBtn?.addEventListener('click', () => this._toggleCallCam());

    // ── Clipboard ──
    this.dom.clipboardSyncBtn?.addEventListener('click', () => this._sendClipboard());
    this.dom.clipboardPasteZone?.addEventListener('paste', (e) => this._handleClipboardPaste(e));

    // ── History ──
    this.dom.clearHistoryBtn?.addEventListener('click', () => this._clearHistory());

    // Disconnect
    this.dom.disconnectBtn?.addEventListener('click', () => this._disconnect());

    // Modals
    this.dom.qrBtn?.addEventListener('click', () => this._showModal('qrModal'));
    this.dom.roomBtn?.addEventListener('click', () => this._showModal('roomModal'));
    this.dom.qrModalClose?.addEventListener('click', () => this._hideModal('qrModal'));
    this.dom.roomModalClose?.addEventListener('click', () => this._hideModal('roomModal'));
    this.dom.newRoomBtn?.addEventListener('click', () => this.signaling.send({ type: 'create-room' }));
    this.dom.joinRoomBtn?.addEventListener('click', () => {
      const code = this.dom.roomCodeInput?.value?.replace(/\D/g, '');
      if (code?.length >= 4) { this.signaling.send({ type: 'join-room', roomCode: code }); this._hideModal('roomModal'); }
      else this._toast('warning', 'Enter a valid room code');
    });
    this.dom.copyQrLink?.addEventListener('click', () => {
      const code = this.dom.qrRoomCode?.textContent;
      this._copyToClipboard(`${location.origin}?room=${code}`, 'Room link copied!');
    });
    this.dom.copyRoomCode?.addEventListener('click', () => {
      const code = this.dom.generatedRoomCode?.textContent;
      this._copyToClipboard(code, 'Room code copied!');
    });

    // Bluetooth
    this._setupBluetooth();
    this.dom.roomCodeInput?.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
  }

  _switchTab(tab) {
    const allTabs = ['chat', 'files', 'screen', 'call', 'clipboard', 'history'];
    const primaryTabs = ['chat', 'files', 'call']; // bottom nav buttons

    // Toggle tab content panels
    allTabs.forEach(t => {
      const content = this.dom[`${t}Tab`];
      content?.classList.toggle('active', t === tab);
    });

    // Highlight bottom nav buttons (only primary ones have nav-btn)
    const navBtns = this.dom.bottomNav?.querySelectorAll('.nav-btn');
    navBtns?.forEach(btn => {
      const btnTab = btn.dataset.tab;
      if (btnTab) {
        btn.classList.toggle('active', btnTab === tab);
      } else {
        // "More" button: highlight if a More-panel tab is active
        const isMoreTab = !primaryTabs.includes(tab);
        btn.classList.toggle('active', isMoreTab);
      }
    });

    if (tab === 'chat') {
      this._unreadCount = 0;
      this._updateChatBadge();
      this._scrollChatToBottom();
      setTimeout(() => this.dom.chatInput?.focus(), 150);
    }
  }

  _toggleMorePanel() {
    const isOpen = this.dom.morePanel?.classList.contains('visible');
    if (isOpen) this._closeMorePanel();
    else this._openMorePanel();
  }

  _openMorePanel() {
    this.dom.morePanel?.classList.add('visible');
    this.dom.morePanelOverlay?.classList.add('visible');
  }

  _closeMorePanel() {
    this.dom.morePanel?.classList.remove('visible');
    this.dom.morePanelOverlay?.classList.remove('visible');
  }

  // ═══════════════════════════════════════════════════════════
  // PEERS
  // ═══════════════════════════════════════════════════════════

  _addPeer(msg) {
    if (this.peers.has(msg.peerId)) return;
    this.peers.set(msg.peerId, msg);
    this.dom.noPeers.style.display = 'none';

    const el = document.createElement('div');
    el.className = `peer-device peer-pos-${this.peerPositionIndex % 6}`;
    el.dataset.peerId = msg.peerId;
    el.innerHTML = `
      <div class="peer-avatar" style="position:relative;">
        ${getDeviceEmoji(msg.deviceInfo)}
        <div class="peer-bt-badge" title="Bluetooth Pairing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>
        </div>
      </div>
      <div class="peer-name">${msg.deviceInfo?.name || 'Device'}</div>
    `;
    el.addEventListener('click', () => this._requestBtPair(msg.peerId));
    this.dom.radarContainer.appendChild(el);
    this.peerPositionIndex++;
  }

  _removePeer(peerId) {
    this.peers.delete(peerId);
    this.dom.radarContainer?.querySelector(`[data-peer-id="${peerId}"]`)?.remove();
    if (this.peers.size === 0) this.dom.noPeers.style.display = '';
    if (this.connectedPeerId === peerId) this._disconnect();
    // Clear waiting state if peer left
    if (this._waitingForPairResponse === peerId) {
      this._waitingForPairResponse = null;
      this._toast('warning', 'Device disconnected before responding');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BLUETOOTH PAIRING FLOW (Request → Accept → Connect)
  // ═══════════════════════════════════════════════════════════

  /**
   * Step 1: User clicks a device → send Bluetooth pairing request.
   */
  _requestBtPair(peerId) {
    if (this.connections.has(peerId)) return;
    if (this._waitingForPairResponse) {
      this._toast('warning', 'Already waiting for a pairing response...');
      return;
    }

    this.selectedPeerId = peerId;
    this._waitingForPairResponse = peerId;

    // UI: show waiting state on clicked device
    const el = this.dom.radarContainer?.querySelector(`[data-peer-id="${peerId}"]`);
    this.dom.radarContainer?.querySelectorAll('.peer-device').forEach(p => {
      p.classList.remove('selected', 'waiting');
      p.querySelector('.peer-waiting-label')?.remove();
    });
    el?.classList.add('selected', 'waiting');
    const waitLabel = document.createElement('div');
    waitLabel.className = 'peer-waiting-label';
    waitLabel.textContent = 'Requesting...';
    el?.appendChild(waitLabel);

    // Send pairing request via signaling server
    this.signaling.send({ type: 'bt-pair-request', targetId: peerId });
    this._toast('info', 'Sending pairing request...');
    this._vibrate([50, 30, 50]);

    // Auto-timeout after 30s
    this._pairResponseTimeout = setTimeout(() => {
      if (this._waitingForPairResponse === peerId) {
        this._waitingForPairResponse = null;
        el?.classList.remove('waiting');
        el?.querySelector('.peer-waiting-label')?.remove();
        this._toast('warning', 'Pairing request timed out');
      }
    }, this._pairRequestTimeout);
  }

  /**
   * Step 2: Receiving device gets pairing request → show accept/reject notification.
   */
  _onBtPairRequest(msg) {
    // Store pending request
    this._pendingPairRequest = { from: msg.from, deviceInfo: msg.deviceInfo };

    // Show notification
    const emoji = getDeviceEmoji(msg.deviceInfo);
    const name = msg.deviceInfo?.name || 'Unknown Device';
    const browser = msg.deviceInfo?.browser || '';

    this.dom.btPairDeviceEmoji.textContent = emoji;
    this.dom.btPairDeviceName.textContent = `${name} · ${browser}`.trim();
    this.dom.btPairDeviceDetail.textContent = 'wants to connect with you via Bluetooth';
    this.dom.btPairTimerBar.style.width = '100%';
    this.dom.btPairNotification.classList.add('visible');

    // Vibrate + sound for incoming request
    this._vibrate([100, 50, 100, 50, 100]);
    this._playPairSound();

    // Start countdown timer bar
    let remaining = this._pairRequestTimeout;
    const interval = 300;
    if (this._pairRequestTimer) clearInterval(this._pairRequestTimer);
    this._pairRequestTimer = setInterval(() => {
      remaining -= interval;
      const pct = Math.max(0, (remaining / this._pairRequestTimeout) * 100);
      this.dom.btPairTimerBar.style.width = pct + '%';
      if (remaining <= 0) {
        this._dismissPairNotification(false);
      }
    }, interval);
  }

  /**
   * Step 3: Requesting device gets accept/reject response.
   */
  _onBtPairResponse(msg) {
    if (this._waitingForPairResponse !== msg.from) return;

    clearTimeout(this._pairResponseTimeout);
    this._waitingForPairResponse = null;

    const el = this.dom.radarContainer?.querySelector(`[data-peer-id="${msg.from}"]`);
    el?.classList.remove('waiting');
    el?.querySelector('.peer-waiting-label')?.remove();

    if (msg.accepted) {
      this._toast('success', 'Pairing accepted! Connecting...');
      this._vibrate([50, 50, 50]);
      // Now do the actual WebRTC connection
      this._connectToPeer(msg.from);
    } else {
      this._toast('error', 'Pairing request was rejected');
      el?.classList.remove('selected');
    }
  }

  /**
   * Setup the accept/reject button handlers for the notification popup.
   */
  _setupBtPairing() {
    this.dom.btPairAcceptBtn?.addEventListener('click', () => {
      this._respondToPairRequest(true);
    });
    this.dom.btPairRejectBtn?.addEventListener('click', () => {
      this._respondToPairRequest(false);
    });
  }

  /**
   * Respond to an incoming pairing request.
   */
  _respondToPairRequest(accepted) {
    if (!this._pendingPairRequest) return;

    const { from } = this._pendingPairRequest;

    // Send response back via signaling
    this.signaling.send({ type: 'bt-pair-response', targetId: from, accepted });

    // Dismiss notification
    this._dismissPairNotification(accepted);

    if (accepted) {
      this._toast('success', 'Pairing accepted! Connecting...');
      this._vibrate([50, 50, 50]);
      
      // Do NOT call _connectToPeer here to avoid WebRTC Glare (colliding offers).
      // The requester will send the offer. We just prepare the UI.
      this.selectedPeerId = from;
      const el = this.dom.radarContainer?.querySelector(`[data-peer-id="${from}"]`);
      this.dom.radarContainer?.querySelectorAll('.peer-device').forEach(p => p.classList.remove('selected', 'waiting'));
      el?.classList.add('selected');
    } else {
      this._toast('info', 'Pairing request rejected');
    }
  }

  /**
   * Dismiss the pairing notification popup.
   */
  _dismissPairNotification(wasAccepted) {
    if (this._pairRequestTimer) {
      clearInterval(this._pairRequestTimer);
      this._pairRequestTimer = null;
    }

    this.dom.btPairNotification?.classList.remove('visible');

    if (!wasAccepted && this._pendingPairRequest) {
      // Auto-reject if timed out
      this.signaling.send({
        type: 'bt-pair-response',
        targetId: this._pendingPairRequest.from,
        accepted: false
      });
    }

    this._pendingPairRequest = null;
  }

  /**
   * Play a distinctive sound for incoming pairing requests.
   */
  _playPairSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Two-tone chime
      [0, 0.15].forEach((delay, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(i === 0 ? 660 : 880, ctx.currentTime + delay);
        gain.gain.setValueAtTime(0.12, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.25);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.25);
      });
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════
  // WEBRTC
  // ═══════════════════════════════════════════════════════════

  _connectToPeer(peerId) {
    if (this.connections.has(peerId)) return;
    this.selectedPeerId = peerId;
    const el = this.dom.radarContainer?.querySelector(`[data-peer-id="${peerId}"]`);
    this.dom.radarContainer?.querySelectorAll('.peer-device').forEach(p => p.classList.remove('selected', 'waiting'));
    el?.classList.add('selected');
    el?.querySelector('.peer-waiting-label')?.remove();
    this._toast('info', 'Connecting...');

    const pc = new PeerConnection(this.iceServers);
    const ft = new FileTransfer(pc);
    this.connections.set(peerId, { pc, ft });

    pc.on('signal', (data) => {
      this.signaling.send({ type: 'signal', targetId: peerId, signal: data });
    });

    this._wireConnection(peerId, pc, ft);
    pc.createOffer();
  }

  _handleIncomingSignal(msg) {
    let conn = this.connections.get(msg.from);
    if (!conn) {
      const pc = new PeerConnection(this.iceServers);
      const ft = new FileTransfer(pc);
      this.connections.set(msg.from, { pc, ft });
      pc.on('signal', (data) => {
        this.signaling.send({ type: 'signal', targetId: msg.from, signal: data });
      });
      this._wireConnection(msg.from, pc, ft);
      conn = { pc, ft };
    }
    conn.pc.handleSignal(msg.signal);
  }

  _wireConnection(peerId, pc, ft) {
    const peerInfo = this.peers.get(peerId);
    const name = peerInfo?.deviceInfo?.name || 'Device';
    const emoji = getDeviceEmoji(peerInfo?.deviceInfo);
    const label = peerInfo ? getDeviceLabel(peerInfo.deviceInfo) : name;

    pc.on('open', () => {
      this.connectedPeerId = peerId;
      this.selectedPeerId = peerId;

      // Show success popup
      this.dom.successPeerName.textContent = label;
      this.dom.successPopup.classList.add('visible');

      // Prepare connected header
      this.dom.connectedAvatar.textContent = emoji;
      this.dom.connHeaderName.textContent = label;

      this._chatMessages = [];
      this._unreadCount = 0;
      this._renderChatMessages();
      this._updateSendBtn();
      this._vibrate([50, 50, 50]);
    });

    pc.on('connection-type', (type) => {
      const typeText = type === 'direct' ? '⚡ Direct P2P' : '🔄 Relayed';
      const typeColor = type === 'direct' ? 'var(--success)' : 'var(--warning)';
      this.dom.successConnType.innerHTML = `<span class="badge-dot" style="background:${typeColor};box-shadow:0 0 4px ${typeColor}"></span> ${typeText}`;
      this.dom.connHeaderType.innerHTML = `<span class="badge-dot-sm" style="background:${typeColor};box-shadow:0 0 4px ${typeColor}"></span> ${typeText}`;
    });

    pc.on('quality', (q) => {
      this.dom.qualityBar.style.display = 'flex';
      if (q.speed > 0) this.dom.qualitySpeed.textContent = `${(q.speed / (1024*1024)).toFixed(1)} MB/s`;
      if (q.rtt > 0) this.dom.qualityRtt.textContent = `${Math.round(q.rtt)}ms`;
    });

    pc.on('connection-state', (state) => {
      if (state === 'reconnecting') {
        this.dom.connHeaderType.innerHTML = `<span class="badge-dot-sm" style="background:var(--warning);box-shadow:0 0 4px var(--warning)"></span> 🔄 Reconnecting...`;
        this._toast('warning', 'Connection interrupted, reconnecting...');
      }
    });

    pc.on('close', () => {
      if (this.connectedPeerId === peerId) this._disconnect();
    });
    pc.on('error', () => {
      this._toast('error', `Connection to ${name} failed.`);
      if (this.connectedPeerId === peerId) this._disconnect();
    });

    pc.on('track', (stream) => {
      // Differentiate between screen share and video/audio call
      const hasAudio = stream.getAudioTracks().length > 0;
      
      if (hasAudio) {
        // It's a call (has audio tracks)
        this.dom.callRemoteVideo.srcObject = stream;
        this.dom.callPlaceholder.style.display = 'none';
        this.dom.callVideoWrapper.style.display = 'flex';
        this.dom.callRemoteVideo.load();
        this.dom.callRemoteVideo.play().catch(e => console.warn('Play error:', e));
        if (!this.dom.callTab?.classList.contains('active')) {
          this._switchTab('call');
        }
      } else {
        // It's a screen share (video only, no audio)
        this.dom.screenVideo.srcObject = stream;
        this.dom.screenPlaceholder.style.display = 'none';
        this.dom.screenVideo.style.display = 'block';
        this.dom.fullscreenBtn.style.display = 'flex';
        this.dom.screenVideo.load();
        this.dom.screenVideo.play().catch(e => console.warn('Play error:', e));
        if (!this.dom.screenTab?.classList.contains('active')) {
          this._switchTab('screen');
        }
      }
    });

    // ── Transfer events ──
    ft.on('send-start', (d) => { this._addTransferUI(d.fileId, d.name, d.size, 'send'); this._showPauseBtn(); });
    ft.on('send-progress', (d) => {
      this._updateTransferUI(d.fileId, d.progress, d.speed, d.sent, d.total, d.eta);
      if (d.chunkSize) this.dom.qualityChunk.textContent = FileTransfer.formatSize(d.chunkSize);
    });
    ft.on('send-complete', (d) => { this._completeTransferUI(d.fileId, '✓✓ Sent'); this._toast('success', `${d.name} sent`); this._vibrate(100); });
    ft.on('send-all-complete', () => { this.selectedFiles = []; this._renderFiles(); this._hidePauseBtn(); this._playSound(); });
    ft.on('send-error', (d) => { this._toast('error', `Transfer failed: ${d.error}`); this._completeTransferUI(d.fileId, '✕ Failed'); this._hidePauseBtn(); });
    ft.on('send-paused', () => this._toast('info', 'Transfer paused'));
    ft.on('send-resumed', () => this._toast('info', 'Transfer resumed'));
    ft.on('receive-start', (d) => { this._addTransferUI(d.fileId, d.name, d.size, 'receive'); this._toast('info', `Receiving ${d.name}...`); });
    ft.on('receive-progress', (d) => this._updateTransferUI(d.fileId, d.progress, d.speed, d.received, d.total, d.eta));
    ft.on('receive-complete', (d) => {
      this._completeTransferUI(d.fileId, '✓ Received');
      this._addReceivedFile(d);
      this._toast('success', `${d.name} received!`);
      this._vibrate([50, 100, 50]);
      this._playSound();
    });

    // ── Chat events ──
    ft.on('chat-message', (d) => this._onChatMessage(d));
    ft.on('typing', (d) => this._onTypingIndicator(d));
    ft.on('clipboard', (d) => this._onClipboardReceived(d));
    ft.on('screen-offer', (d) => this._onScreenOffer(d));
    ft.on('call-offer', (d) => this._onCallOffer(d));
  }

  _disconnect() {
    if (!this.connectedPeerId) return;
    const conn = this.connections.get(this.connectedPeerId);
    if (conn) { conn.pc.close(); this.connections.delete(this.connectedPeerId); }
    this.connectedPeerId = null;
    this.dom.qualityBar.style.display = 'none';
    this.dom.successPopup.classList.remove('visible');
    this._showPage('discovery');
    this._updateSendBtn();
    this._toast('info', 'Disconnected');
  }

  // ═══════════════════════════════════════════════════════════
  // CHAT
  // ═══════════════════════════════════════════════════════════

  _sendChatMessage() {
    // If there's a pending image, send it
    if (this._pendingImage) {
      this._sendPendingImage();
      return;
    }
    const text = this.dom.chatInput?.value?.trim();
    if (!text) return;
    if (!this.connectedPeerId) return this._toast('warning', 'Connect to a device first');
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Connection lost');

    conn.ft.sendChat(text);
    this.dom.chatInput.value = '';
    conn.ft.sendTyping(false);
  }

  _onChatMessage(data) {
    this._chatMessages.push(data);
    this._renderChatMessages();
    this._scrollChatToBottom();

    if (data.from === 'remote') {
      const chatActive = this.dom.chatTab?.classList.contains('active');
      if (!chatActive) {
        this._unreadCount++;
        this._updateChatBadge();
      }
      this._vibrate(30);
    }
  }

  _onTypingIndicator(data) {
    let el = this.dom.chatMessages?.querySelector('.typing-bubble');
    if (data.isTyping) {
      if (!el) {
        el = document.createElement('div');
        el.className = 'typing-bubble visible';
        el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
        this.dom.chatMessages?.appendChild(el);
        this._scrollChatToBottom();
      }
    } else {
      el?.remove();
    }
  }

  _renderChatMessages() {
    if (!this.dom.chatMessages) return;
    const empty = this.dom.chatEmpty;
    if (this._chatMessages.length === 0) { if (empty) empty.style.display = 'flex'; return; }
    if (empty) empty.style.display = 'none';

    const existing = this.dom.chatMessages.querySelectorAll('.chat-bubble').length;
    const toRender = this._chatMessages.slice(existing);

    for (const msg of toRender) {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${msg.from === 'self' ? 'sent' : 'received'}`;
      const time = this._formatTime(msg.timestamp);
      const check = msg.from === 'self' ? '<span class="chat-check">✓✓</span>' : '';

      if (msg.msgType === 'image') {
        bubble.innerHTML = `
          <div style="position:relative; display:inline-block;">
            <img class="chat-bubble-image" src="${msg.data}" alt="${msg.name || 'photo'}" loading="lazy">
            <a href="${msg.data}" download="${msg.name || 'photo.png'}" class="chat-bubble-download" title="Download Image">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </a>
          </div>
          <div class="chat-bubble-time">${time} ${check}</div>
        `;
      } else {
        bubble.innerHTML = `
          <div class="chat-bubble-text">${this._escChat(msg.text)}</div>
          <div class="chat-bubble-time">${time} ${check}</div>
        `;
      }
      // Remove typing indicator before appending
      this.dom.chatMessages.querySelector('.typing-bubble')?.remove();
      this.dom.chatMessages.appendChild(bubble);
    }
  }

  _scrollChatToBottom() {
    if (this.dom.chatMessages) {
      requestAnimationFrame(() => { this.dom.chatMessages.scrollTop = this.dom.chatMessages.scrollHeight; });
    }
  }

  _updateChatBadge() {
    if (!this.dom.chatTabBadge) return;
    if (this._unreadCount > 0) {
      this.dom.chatTabBadge.textContent = this._unreadCount > 99 ? '99+' : this._unreadCount;
      this.dom.chatTabBadge.style.display = 'inline-flex';
    } else {
      this.dom.chatTabBadge.style.display = 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CAMERA
  // ═══════════════════════════════════════════════════════════

  async _openCamera() {
    this._showModal('cameraModal');
    this.dom.cameraCanvas.style.display = 'none';
    this.dom.cameraVideo.style.display = 'block';
    this.dom.retakeBtn.style.display = 'none';
    this.dom.sendPhotoBtn.style.display = 'none';
    this.dom.captureBtn.style.display = 'flex';

    try {
      this._cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this._facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      this.dom.cameraVideo.srcObject = this._cameraStream;
    } catch (e) {
      this._toast('error', 'Camera access denied');
      this._hideModal('cameraModal');
    }
  }

  _closeCamera() {
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(t => t.stop());
      this._cameraStream = null;
    }
    this.dom.cameraVideo.srcObject = null;
    this._hideModal('cameraModal');
  }

  async _switchCamera() {
    this._facingMode = this._facingMode === 'user' ? 'environment' : 'user';
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(t => t.stop());
    }
    try {
      this._cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this._facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      this.dom.cameraVideo.srcObject = this._cameraStream;
      this.dom.cameraVideo.style.display = 'block';
      this.dom.cameraCanvas.style.display = 'none';
      this.dom.retakeBtn.style.display = 'none';
      this.dom.sendPhotoBtn.style.display = 'none';
      this.dom.captureBtn.style.display = 'flex';
    } catch (e) { this._toast('error', 'Cannot switch camera'); }
  }

  _capturePhoto() {
    const video = this.dom.cameraVideo;
    const canvas = this.dom.cameraCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    video.style.display = 'none';
    canvas.style.display = 'block';
    this.dom.captureBtn.style.display = 'none';
    this.dom.retakeBtn.style.display = 'flex';
    this.dom.sendPhotoBtn.style.display = 'flex';
  }

  _retakePhoto() {
    this.dom.cameraCanvas.style.display = 'none';
    this.dom.cameraVideo.style.display = 'block';
    this.dom.retakeBtn.style.display = 'none';
    this.dom.sendPhotoBtn.style.display = 'none';
    this.dom.captureBtn.style.display = 'flex';
  }

  _sendCapturedPhoto() {
    const canvas = this.dom.cameraCanvas;
    const base64 = this._compressCanvas(canvas);
    this._closeCamera();

    if (!this.connectedPeerId) return this._toast('warning', 'Connect first');
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Connection lost');

    conn.ft.sendImage(base64, `camera_${Date.now()}.jpg`);
    this._toast('success', 'Photo sent!');
  }

  _compressCanvas(canvas, maxWidth = 1200, quality = 0.7) {
    // Resize if too large
    if (canvas.width > maxWidth) {
      const ratio = maxWidth / canvas.width;
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = maxWidth;
      tmpCanvas.height = canvas.height * ratio;
      tmpCanvas.getContext('2d').drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);
      return tmpCanvas.toDataURL('image/jpeg', quality);
    }
    return canvas.toDataURL('image/jpeg', quality);
  }

  // ═══════════════════════════════════════════════════════════
  // IMAGE UPLOAD
  // ═══════════════════════════════════════════════════════════

  _prepareImageUpload(file) {
    if (!file.type.startsWith('image/')) return this._toast('warning', 'Only images allowed');
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 600; // Smaller width to keep payload under 64KB limit
        let w = img.width, h = img.height;
        if (w > maxW) { h = h * (maxW / w); w = maxW; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const base64 = canvas.toDataURL('image/jpeg', 0.6); // Lower quality for smaller base64

        this._pendingImage = { base64, name: file.name };
        this.dom.previewImg.src = base64;
        this.dom.previewName.textContent = file.name;
        this.dom.imagePreview.style.display = 'flex';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  _cancelImagePreview() {
    this._pendingImage = null;
    this.dom.imagePreview.style.display = 'none';
  }

  _sendPendingImage() {
    if (!this._pendingImage) return;
    if (!this.connectedPeerId) return this._toast('warning', 'Connect first');
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Connection lost');

    conn.ft.sendImage(this._pendingImage.base64, this._pendingImage.name);
    this._cancelImagePreview();
    this._toast('success', 'Image sent!');
  }

  // ═══════════════════════════════════════════════════════════
  // FILES
  // ═══════════════════════════════════════════════════════════

  _addFiles(files) {
    this.selectedFiles.push(...files);
    this._renderFiles();
    this._updateSendBtn();
  }

  async _handleDropItems(items) {
    const files = [];
    const traverseEntry = async (entry) => {
      if (entry.isFile) {
        return new Promise(r => entry.file(f => { files.push(f); r(); }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise(r => reader.readEntries(r));
        for (const e of entries) await traverseEntry(e);
      }
    };
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) await traverseEntry(entry);
      else if (items[i].getAsFile) files.push(items[i].getAsFile());
    }
    if (files.length) this._addFiles(files);
  }

  _renderFiles() {
    const list = this.dom.fileList;
    if (!list) return;
    list.innerHTML = '';
    this.dom.selectedFiles?.classList.toggle('visible', this.selectedFiles.length > 0);
    this.dom.sendBar?.classList.toggle('visible', this.selectedFiles.length > 0);
    this.dom.selectedCount.textContent = this.selectedFiles.length;

    this.selectedFiles.forEach((file, i) => {
      const ext = file.name.split('.').pop().toLowerCase();
      const { icon, cls } = FileTransfer.getFileIcon(file.type, ext);
      const el = document.createElement('div');
      el.className = 'file-item';
      el.innerHTML = `
        <div class="file-icon ${cls}">${icon}</div>
        <div class="file-details"><div class="file-name">${file.name}</div><div class="file-size">${FileTransfer.formatSize(file.size)}</div></div>
        <button class="file-remove" data-idx="${i}" title="Remove">✕</button>
      `;
      el.querySelector('.file-remove').addEventListener('click', () => {
        this.selectedFiles.splice(i, 1); this._renderFiles(); this._updateSendBtn();
      });
      list.appendChild(el);
    });
  }

  _updateSendBtn() {
    const hasFiles = this.selectedFiles.length > 0;
    const conn = this.connectedPeerId ? this.connections.get(this.connectedPeerId) : null;
    const connected = conn && conn.pc && conn.pc.isConnected;
    
    if (this.dom.sendBtn) this.dom.sendBtn.disabled = !hasFiles || !connected;
    if (this.dom.sendBtnText) {
      const totalSize = this.selectedFiles.reduce((a, f) => a + f.size, 0);
      this.dom.sendBtnText.textContent = !hasFiles 
        ? 'Select files to send' 
        : !connected 
          ? 'Connect to a device first' 
          : `Send ${this.selectedFiles.length} file${this.selectedFiles.length > 1 ? 's' : ''} (${FileTransfer.formatSize(totalSize)})`;
    }
  }

  _sendFiles() {
    if (!this.selectedFiles.length || !this.connectedPeerId) return;
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Not connected');
    conn.ft.sendFiles(this.selectedFiles);
  }

  // ═══════════════════════════════════════════════════════════
  // TRANSFER UI
  // ═══════════════════════════════════════════════════════════

  _addTransferUI(fileId, name, size, dir) {
    this.dom.transfersSection?.classList.add('visible');
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.id = `transfer-${fileId}`;
    el.innerHTML = `
      <div class="transfer-header">
        <span class="transfer-name">${name}</span>
        <span class="transfer-status">${dir === 'send' ? '✓ Sending...' : '↓ Receiving...'}</span>
      </div>
      <div class="transfer-progress-bar"><div class="transfer-progress-fill ${dir === 'receive' ? 'receiving' : ''}" style="width:0%"></div></div>
      <div class="transfer-footer"><span class="transfer-bytes">0 / ${FileTransfer.formatSize(size)}</span><span class="transfer-speed">—</span></div>
    `;
    this.dom.transferList?.appendChild(el);
  }

  _updateTransferUI(fileId, progress, speed, bytes, total, eta) {
    const el = document.getElementById(`transfer-${fileId}`);
    if (!el) return;
    el.querySelector('.transfer-progress-fill').style.width = `${Math.round(progress * 100)}%`;
    el.querySelector('.transfer-bytes').textContent = `${FileTransfer.formatSize(bytes)} / ${FileTransfer.formatSize(total)}`;
    const etaText = eta < Infinity ? `${Math.ceil(eta)}s left` : '';
    el.querySelector('.transfer-speed').textContent = speed > 0 ? `${(speed / (1024*1024)).toFixed(1)} MB/s · ${etaText}` : '';
  }

  _completeTransferUI(fileId, status) {
    const el = document.getElementById(`transfer-${fileId}`);
    if (!el) return;
    el.classList.add('transfer-complete');
    el.querySelector('.transfer-status').textContent = status;
    el.querySelector('.transfer-progress-fill').style.width = '100%';
    el.querySelector('.transfer-speed').textContent = 'Complete';
  }

  _addReceivedFile(d) {
    this.dom.receivedSection?.classList.add('visible');
    const ext = d.name.split('.').pop().toLowerCase();
    const { icon, cls } = FileTransfer.getFileIcon(d.fileType, ext);
    
    // Security check: Warn about executables and prevent auto-download
    const dangerousExts = ['exe', 'bat', 'cmd', 'sh', 'vbs', 'ps1', 'scr', 'msi', 'app', 'jar'];
    const isDangerous = dangerousExts.includes(ext);

    const el = document.createElement('div');
    el.className = `received-item ${isDangerous ? 'danger-item' : ''}`;
    
    let warningHtml = '';
    if (isDangerous) {
      warningHtml = `<div style="color:var(--error); font-size:0.7rem; font-weight:bold; margin-top:4px;">⚠️ SECURITY WARNING: Executable file. Open at your own risk.</div>`;
    }

    el.innerHTML = `
      <div class="file-icon ${cls}">${icon}</div>
      <div class="file-details">
        <div class="file-name">${d.name}</div>
        <div class="file-size">${FileTransfer.formatSize(d.size)}</div>
        ${warningHtml}
      </div>
      <button class="download-btn">↓ Save</button>
    `;
    const downloadFn = () => { const a = document.createElement('a'); a.href = d.url; a.download = d.name; a.click(); };
    el.querySelector('.download-btn').addEventListener('click', downloadFn);
    this.dom.receivedList?.appendChild(el);
    this._saveToHistory(d);
    
    // Only auto-download if it's not a dangerous file
    if (!isDangerous) {
      downloadFn();
    } else {
      this._toast('warning', `Blocked auto-download of potentially dangerous file: ${d.name}`);
    }
  }

  _showPauseBtn() { if (this.dom.pauseAllBtn) this.dom.pauseAllBtn.style.display = 'flex'; }
  _hidePauseBtn() { if (this.dom.pauseAllBtn) this.dom.pauseAllBtn.style.display = 'none'; if (this.dom.resumeAllBtn) this.dom.resumeAllBtn.style.display = 'none'; }

  // ═══════════════════════════════════════════════════════════
  // SCREEN SHARING
  // ═══════════════════════════════════════════════════════════

  _isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
  }

  async _startScreenShare() {
    if (!this.connectedPeerId) return this._toast('warning', 'Connect first');
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Connection lost');

    try {
      // Try getDisplayMedia first (works on desktop + some Android)
      if (navigator.mediaDevices.getDisplayMedia) {
        try {
          this._screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
            audio: false
          });
        } catch (displayErr) {
          console.warn('getDisplayMedia failed, falling back to camera:', displayErr.name);
          if (this._isMobile()) {
            this._screenStream = await this._getCameraFallback();
          } else {
            throw displayErr;
          }
        }
      } else {
        if (this._isMobile()) {
          this._screenStream = await this._getCameraFallback();
        } else {
          this._toast('error', 'Screen sharing not supported in this browser');
          return;
        }
      }

      const videoTrack = this._screenStream.getVideoTracks()[0];
      const transceivers = conn.pc.pc.getTransceivers();
      const videoTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
      
      if (videoTransceiver) {
        await videoTransceiver.sender.replaceTrack(videoTrack);
        videoTransceiver.direction = 'sendrecv';
      } else {
        conn.pc.pc.addTransceiver(videoTrack, { direction: 'sendrecv', streams: [this._screenStream] });
      }

      this.dom.screenPlaceholder.style.display = 'none';
      this.dom.screenVideo.style.display = 'block';
      this.dom.screenVideo.srcObject = this._screenStream;
      this.dom.shareScreenBtn.style.display = 'none';
      this.dom.stopScreenBtn.style.display = 'flex';
      this.dom.fullscreenBtn.style.display = 'flex';

      videoTrack.onended = () => this._stopScreenShare();

      conn.ft.sendScreenOffer('start');
      const msg = this._screenStream._isCameraFallback
        ? 'Camera sharing started (screen share unavailable on mobile)'
        : 'Screen sharing started';
      this._toast('info', msg);
    } catch (e) {
      console.error('Screen share error:', e);
      if (e.name === 'NotAllowedError') {
        this._toast('warning', 'Permission denied. Allow screen or camera access.');
      } else {
        this._toast('error', 'Failed to share screen');
      }
    }
  }

  async _getCameraFallback() {
    this._toast('info', 'Using camera instead (screen share unavailable on mobile)');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    });
    stream._isCameraFallback = true;
    return stream;
  }

  _stopScreenShare() {
    if (this._screenStream) {
      this._screenStream.getTracks().forEach(t => t.stop());
      this._screenStream = null;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.dom.screenVideo.srcObject = null;
    this.dom.screenVideo.style.display = 'none';
    this.dom.screenPlaceholder.style.display = 'flex';
    this.dom.shareScreenBtn.style.display = 'flex';
    this.dom.stopScreenBtn.style.display = 'none';
    this.dom.fullscreenBtn.style.display = 'none';
  }

  _onScreenOffer(d) {
    if (d.offer === 'start') {
      this._toast('info', 'Remote user started sharing screen');
      this._switchTab('screen');
      this.dom.screenPlaceholder.style.display = 'none';
      this.dom.screenVideo.style.display = 'block';
      this.dom.fullscreenBtn.style.display = 'flex';
    } else {
      this._toast('info', 'Remote user stopped sharing screen');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      this.dom.screenVideo.style.display = 'none';
      this.dom.screenPlaceholder.style.display = 'flex';
      this.dom.fullscreenBtn.style.display = 'none';
    }
  }

  _toggleScreenFullscreen() {
    const wrapper = this.dom.screenVideoWrapper;
    if (!wrapper) return;
    if (!document.fullscreenElement) {
      wrapper.requestFullscreen().catch(e => this._toast('error', 'Fullscreen not supported'));
    } else {
      document.exitFullscreen();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CALLING
  // ═══════════════════════════════════════════════════════════

  async _startCall(type) {
    if (!this.connectedPeerId) return this._toast('warning', 'Connect first');
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Connection lost');

    try {
      const constraints = type === 'video' 
        ? { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: true }
        : { video: false, audio: true };
        
      this._callStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      this.dom.callLocalVideo.srcObject = this._callStream;
      this.dom.callLocalVideo.style.display = type === 'video' ? 'block' : 'none';
      
      this._callStream.getTracks().forEach(track => {
        const transceivers = conn.pc.pc.getTransceivers();
        const transceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === track.kind);
        
        if (transceiver) {
          transceiver.sender.replaceTrack(track).catch(e => console.error('replaceTrack failed:', e));
          transceiver.direction = 'sendrecv';
        } else {
          conn.pc.pc.addTransceiver(track, { direction: 'sendrecv', streams: [this._callStream] });
        }
      });

      this.dom.callPlaceholder.style.display = 'none';
      this.dom.callVideoWrapper.style.display = 'flex';
      this.dom.startAudioCallBtn.style.display = 'none';
      this.dom.startVideoCallBtn.style.display = 'none';
      this.dom.endCallBtn.style.display = 'flex';
      this.dom.toggleMicBtn.style.display = 'flex';
      this.dom.toggleMicBtn.classList.remove('muted');
      if (type === 'video') {
        this.dom.toggleCamBtn.style.display = 'flex';
        this.dom.toggleCamBtn.classList.remove('muted');
      }

      conn.ft.sendCallOffer('start');
      this._toast('info', `${type === 'video' ? 'Video' : 'Audio'} call started`);
    } catch (e) {
      console.error(e);
      this._toast('error', 'Could not access camera/microphone');
    }
  }

  _stopCall() {
    if (this._callStream) {
      this._callStream.getTracks().forEach(t => t.stop());
      this._callStream = null;
    }
    this.dom.callLocalVideo.srcObject = null;
    this.dom.callRemoteVideo.srcObject = null;
    
    this.dom.callVideoWrapper.style.display = 'none';
    this.dom.callPlaceholder.style.display = 'flex';
    this.dom.startAudioCallBtn.style.display = 'flex';
    this.dom.startVideoCallBtn.style.display = 'flex';
    this.dom.endCallBtn.style.display = 'none';
    this.dom.toggleMicBtn.style.display = 'none';
    this.dom.toggleCamBtn.style.display = 'none';
    
    if (this.connectedPeerId) {
      const conn = this.connections.get(this.connectedPeerId);
      if (conn?.pc.isConnected) conn.ft.sendCallOffer('stop');
    }
  }

  _onCallOffer(d) {
    if (d.offer === 'start') {
      this._toast('info', 'Incoming call...');
      this._switchTab('call');
      this.dom.callPlaceholder.style.display = 'none';
      this.dom.callVideoWrapper.style.display = 'flex';
      // If we haven't started our own tracks, we only show remote and a button to join back
      if (!this._callStream) {
         this.dom.startAudioCallBtn.style.display = 'flex';
         this.dom.startVideoCallBtn.style.display = 'flex';
         this.dom.endCallBtn.style.display = 'none';
      }
    } else {
      this._toast('info', 'Call ended');
      this._stopCall();
    }
  }

  _toggleCallMic() {
    if (!this._callStream) return;
    const audioTrack = this._callStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.dom.toggleMicBtn.classList.toggle('muted', !audioTrack.enabled);
    }
  }

  _toggleCallCam() {
    if (!this._callStream) return;
    const videoTrack = this._callStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      this.dom.toggleCamBtn.classList.toggle('muted', !videoTrack.enabled);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CLIPBOARD SYNC
  // ═══════════════════════════════════════════════════════════

  _handleClipboardPaste(e) {
    e.preventDefault();
    let pastedText = '';
    if (e.clipboardData && e.clipboardData.getData) {
      pastedText = e.clipboardData.getData('text/plain');
    } else if (window.clipboardData && window.clipboardData.getData) {
      pastedText = window.clipboardData.getData('Text');
    }
    if (pastedText) {
      document.execCommand('insertText', false, pastedText);
    }
  }

  _sendClipboard() {
    if (!this.connectedPeerId) return this._toast('warning', 'Connect to a device first');
    const text = this.dom.clipboardPasteZone.innerText.trim();
    if (!text) return this._toast('warning', 'Clipboard is empty');
    const conn = this.connections.get(this.connectedPeerId);
    if (!conn?.pc.isConnected) return this._toast('error', 'Connection lost');

    conn.ft.sendClipboard(text);
    this.dom.clipboardPasteZone.innerHTML = '';
    this._clipboardItems.unshift({ text, type: 'sent', timestamp: Date.now() });
    this._renderClipboardItems();
    this._toast('success', 'Clipboard beamed successfully!');
  }

  _onClipboardReceived(d) {
    this._clipboardItems.unshift({ text: d.text, type: 'received', timestamp: d.timestamp });
    this._renderClipboardItems();
    this._copyToClipboard(d.text, 'Received clipboard automatically copied!');
    this._vibrate([50, 50, 50]);
    if (!this.dom.clipboardTab?.classList.contains('active')) {
      this._switchTab('clipboard');
    }
  }

  _renderClipboardItems() {
    const list = this.dom.clipboardList;
    if (!list) return;
    if (this._clipboardItems.length === 0) {
      list.innerHTML = '<div class="clipboard-empty">No clipboard items yet. Paste or send your clipboard!</div>';
      return;
    }
    list.innerHTML = '';
    this._clipboardItems.slice(0, 50).forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'clipboard-item';
      const icon = item.type === 'sent' ? '↗️' : '📥';
      el.innerHTML = `
        <div class="clipboard-item-icon">${icon}</div>
        <div class="clipboard-item-content">
          <div class="clipboard-item-text">${this._escChat(item.text)}</div>
          <div class="clipboard-item-meta">${item.type === 'sent' ? 'Sent' : 'Received'} · ${this._formatTime(item.timestamp)}</div>
        </div>
        <div class="clipboard-item-actions">
          <button class="clipboard-copy-btn" title="Copy">📋</button>
        </div>
      `;
      el.querySelector('.clipboard-copy-btn').addEventListener('click', () => this._copyToClipboard(item.text, 'Copied!'));
      list.appendChild(el);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // LOCAL FILE VAULT (INDEXEDDB HISTORY)
  // ═══════════════════════════════════════════════════════════

  _initHistoryDB() {
    return new Promise((resolve) => {
      const request = indexedDB.open('AllowmeHistoryDB', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = (e) => { this._historyDB = e.target.result; resolve(); };
      request.onerror = () => resolve(); // Ignore failures gracefully
    });
  }

  _saveToHistory(d) {
    if (!this._historyDB) return;
    try {
      const tx = this._historyDB.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      store.add({
        name: d.name, size: d.size, type: d.fileType,
        timestamp: Date.now(), url: d.url
      });
      // We don't auto-reload here unless the tab is open, handled by UI refresh if needed
    } catch (e) { console.warn('History save failed', e); }
  }

  _loadHistory() {
    if (!this._historyDB) return;
    try {
      const tx = this._historyDB.transaction('history', 'readonly');
      const store = tx.objectStore('history');
      const request = store.getAll();
      request.onsuccess = () => {
        const items = request.result.reverse(); // newest first
        this._renderHistory(items);
      };
    } catch (e) { console.warn('History load failed', e); }
  }

  _renderHistory(items) {
    const list = this.dom.historyList;
    if (!list) return;
    if (!items || items.length === 0) {
      list.innerHTML = '<div class="history-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><div>No transfer history yet</div><div class="hint">Your received files will appear here</div></div>';
      return;
    }
    list.innerHTML = '';
    items.forEach(item => {
      const ext = item.name.split('.').pop().toLowerCase();
      const { icon, cls } = FileTransfer.getFileIcon(item.type, ext);
      const el = document.createElement('div');
      el.className = 'history-item';
      el.innerHTML = `
        <div class="history-item-icon ${cls}">${icon}</div>
        <div class="history-item-details">
          <div class="history-item-name" title="${item.name}">${item.name}</div>
          <div class="history-item-meta">${FileTransfer.formatSize(item.size)} · ${this._formatTime(item.timestamp)}</div>
        </div>
        <button class="history-download-btn">↓</button>
      `;
      el.querySelector('.history-download-btn').addEventListener('click', () => {
        const a = document.createElement('a'); a.href = item.url; a.download = item.name; a.click();
      });
      list.appendChild(el);
    });
  }

  _clearHistory() {
    if (!this._historyDB) return;
    if (!confirm('Are you sure you want to clear your local file history?')) return;
    try {
      const tx = this._historyDB.transaction('history', 'readwrite');
      tx.objectStore('history').clear();
      tx.oncomplete = () => this._loadHistory();
      this._toast('success', 'History cleared');
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════
  // THEME
  // ═══════════════════════════════════════════════════════════

  _loadTheme() {
    const saved = localStorage.getItem('allowme-theme');
    const theme = saved || (window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    this._updateThemeIcons(theme);
  }

  _toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('allowme-theme', next);
    this._updateThemeIcons(next);
  }

  _updateThemeIcons(theme) {
    const icon = theme === 'dark' ? '🌙' : '☀️';
    if (this.dom.themeIcon) this.dom.themeIcon.textContent = icon;
    if (this.dom.themeIcon2) this.dom.themeIcon2.textContent = icon;
  }

  // ═══════════════════════════════════════════════════════════
  // MODALS
  // ═══════════════════════════════════════════════════════════

  _showModal(id) { this.dom[id]?.classList.add('visible'); }
  _hideModal(id) { this.dom[id]?.classList.remove('visible'); }

  // ═══════════════════════════════════════════════════════════
  // BLUETOOTH
  // ═══════════════════════════════════════════════════════════

  _setupBluetooth() {
    // Bluetooth modal works on ALL browsers, ALL networks.
    // It shows Allowme devices discovered via the signaling server.
    // No actual BLE hardware required — uses WebSocket for discovery.

    this.dom.bluetoothBtn?.addEventListener('click', () => this._openBluetoothModal());

    this.dom.bluetoothModalClose?.addEventListener('click', () => {
      this._hideModal('bluetoothModal');
    });

    // "Scan" button refreshes the list from current peers
    this.dom.btScanBtn?.addEventListener('click', () => this._bluetoothRefresh());
  }

  _openBluetoothModal() {
    // Always show the scan section (no BLE dependency)
    if (this.dom.btScanSection) this.dom.btScanSection.style.display = 'block';
    if (this.dom.btUnsupported) this.dom.btUnsupported.style.display = 'none';

    // Reset state
    this.dom.btDeviceCard.style.display = 'none';
    this.dom.btDeviceList.style.display = 'block';
    this.dom.btScanAnim.style.display = 'none';
    this.dom.btScanBtn.disabled = false;
    this.dom.btScanBtn.style.display = 'flex';
    this.dom.btScanBtnText.textContent = 'Refresh Devices';
    this.dom.btSubtitle.textContent = 'Tap a device to connect instantly';

    // Populate with current peers
    this._renderBluetoothDevices();
    this._showModal('bluetoothModal');
  }

  _bluetoothRefresh() {
    // Show scanning animation briefly
    this.dom.btScanBtn.classList.add('scanning');
    this.dom.btScanBtnText.textContent = 'Searching...';
    this.dom.btScanAnim.style.display = 'flex';
    this.dom.btStatus.style.display = 'none';

    // Simulate brief scan delay for UX, then refresh from live peers
    setTimeout(() => {
      this.dom.btScanBtn.classList.remove('scanning');
      this.dom.btScanBtnText.textContent = 'Refresh Devices';
      this.dom.btScanAnim.style.display = 'none';
      this._renderBluetoothDevices();
    }, 1200);
  }

  _renderBluetoothDevices() {
    const container = this.dom.btDeviceItems;
    container.innerHTML = '';

    if (this.peers.size === 0) {
      this.dom.btStatus.style.display = 'flex';
      this.dom.btStatusText.textContent = 'No Allowme devices found';
      return;
    }

    this.dom.btStatus.style.display = 'none';

    this.peers.forEach((peerData, peerId) => {
      const isConnected = this.connections.has(peerId);
      const isWaiting = this._waitingForPairResponse === peerId;
      const info = peerData.deviceInfo || {};
      const name = info.name || 'Allowme Device';
      const browser = info.browser || '';
      const emoji = getDeviceEmoji(info);

      const el = document.createElement('div');
      el.className = `bt-device-item ${isConnected ? 'connected' : ''}`;
      el.dataset.id = peerId;

      let actionHtml = '';
      if (isConnected) {
        actionHtml = `<div class="bt-device-item-connected-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Connected</div>`;
      } else if (isWaiting) {
        actionHtml = `<button class="bt-device-item-connect connecting" disabled>Waiting...</button>`;
      } else {
        actionHtml = `<button class="bt-device-item-connect">Connect</button>`;
      }

      el.innerHTML = `
        <div class="bt-device-item-icon">${emoji}</div>
        <div class="bt-device-item-info">
          <div class="bt-device-item-name" title="${name}">${name}</div>
          <div class="bt-device-item-id">${browser ? browser + ' · ' : ''}Allowme</div>
        </div>
        ${actionHtml}
      `;

      if (!isConnected && !isWaiting) {
        const btn = el.querySelector('.bt-device-item-connect');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._hideModal('bluetoothModal');
          this._requestBtPair(peerId);
        });
      }

      container.appendChild(el);
    });
  }

  _updateQR(code) {
    const container = this.dom.qrCodeContainer;
    if (!container) return;
    const url = `${location.origin}?room=${code}`;
    container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}&bgcolor=0f1923&color=419fd9" alt="QR Code" style="border-radius:12px;">`;
  }

  // ═══════════════════════════════════════════════════════════
  // UTILS
  // ═══════════════════════════════════════════════════════════

  _toast(type, message) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    el.textContent = `${icons[type] || ''} ${message}`;
    this.dom.toastContainer?.appendChild(el);
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  _vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch {} }

  _playSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
    } catch {}
  }

  _formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }

  _escChat(text) {
    const d = document.createElement('div');
    d.textContent = text;
    let html = d.innerHTML;
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">$1</a>');
    return html;
  }

  async _copyToClipboard(text, msg) {
    try { await navigator.clipboard.writeText(text); this._toast('success', msg); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); this._toast('success', msg); }
  }
}

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.appInstance = new AllowmeApp();
  window.appInstance.init();
});
