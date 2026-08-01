/**
 * webrtc.js — WebRTC peer connection manager for Allowme.
 * Event-based API: emits 'signal' events instead of calling signaling directly.
 * Full TURN relay support, connection type detection, quality monitoring.
 */

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

export class PeerConnection {
  /**
   * @param {Array} iceServers - ICE server configuration (STUN+TURN)
   */
  constructor(iceServers) {
    this.pc = null;
    this.dataChannel = null;
    this._handlers = {};
    this._pendingCandidates = [];
    this._connectionType = 'unknown';
    this._iceServers = iceServers || DEFAULT_ICE_SERVERS;
    this._statsInterval = null;
    this._closed = false;
    this._makingOffer = false;  // Perfect negotiation flag
    this._isPolite = false;     // Set to true on responder side
    this._iceRestartTimer = null;
    this._iceRestartAttempts = 0;

    this._createPeerConnection();
  }

  // ── Connection Setup ──────────────────────────────────────

  _createPeerConnection() {
    this.pc = new RTCPeerConnection({
      iceServers: this._iceServers,
      iceCandidatePoolSize: 10,
    });



    // Emit ICE candidates as 'signal' events
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._emit('signal', { type: 'ice-candidate', candidate: event.candidate });
      }
    };

    // Auto-renegotiate when tracks are added/removed (with perfect negotiation)
    this.pc.onnegotiationneeded = async () => {
      try {
        this._makingOffer = true;

        if (this.pc.signalingState !== 'stable') {
          console.warn('⚡ Skipping offer: signaling state is', this.pc.signalingState);
          return;
        }
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this._emit('signal', { type: 'offer', sdp: this.pc.localDescription });
      } catch (e) {
        console.error('⚡ Renegotiation failed', e);
      } finally {
        this._makingOffer = false;
      }
    };

    // Track connection state
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const state = this.pc.connectionState;
      console.log(`⚡ WebRTC state: ${state}`);

      if (state === 'connected') {
        this._iceRestartAttempts = 0;
        clearTimeout(this._iceRestartTimer);
        this._detectConnectionType();
        this._startStatsMonitoring();
      }
      if (state === 'failed') {
        // Attempt ICE restart before giving up
        if (this._iceRestartAttempts < 3) {
          console.log(`⚡ Connection failed, attempting ICE restart (${this._iceRestartAttempts + 1}/3)`);
          this._restartIce();
        } else {
          this._emit('error', new Error('Connection failed after retries'));
          this._stopStatsMonitoring();
        }
      }
      if (state === 'disconnected') {
        // Brief disconnects are normal (network switch). Wait before acting.
        this._iceRestartTimer = setTimeout(() => {
          if (this.pc && this.pc.connectionState === 'disconnected') {
            console.log('⚡ Still disconnected, attempting ICE restart');
            this._restartIce();
          }
        }, 3000);
        this._emit('connection-state', 'reconnecting');
      }
      if (state === 'closed') {
        this._stopStatsMonitoring();
        this._emit('close');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const state = this.pc.iceConnectionState;
      console.log(`⚡ ICE state: ${state}`);
    };

    // Listen for remote data channel (responder side)
    this.pc.ondatachannel = (event) => {
      console.log('⚡ Remote data channel received');
      this.dataChannel = event.channel;
      this._setupDataChannel(this.dataChannel);
    };

    // Listen for remote video/audio tracks (screen sharing & calls)
    this.pc.ontrack = (event) => {
      console.log('⚡ Remote track received:', event.track.kind, event.track.id);
      // Some browsers/renegotiations don't include event.streams — create one from the track
      const stream = (event.streams && event.streams[0])
        ? event.streams[0]
        : new MediaStream([event.track]);
      this._emit('track', stream);
    };
  }

  _setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 1 * 1024 * 1024;

    if (channel.readyState === 'open') {
      console.log('⚡ Data channel OPEN (already)');
      // Use setTimeout to allow app.js to bind its events first
      setTimeout(() => this._emit('open'), 0);
    }

    channel.onopen = () => {
      console.log('⚡ Data channel OPEN');
      this._emit('open');
    };

    channel.onclose = () => {
      console.log('⚡ Data channel CLOSED');
      this._emit('close');
    };

    channel.onerror = (err) => {
      console.error('⚡ Data channel ERROR:', err);
      this._emit('error', err);
    };

    channel.onmessage = (event) => {
      this._emit('message', event.data);
    };

    channel.onbufferedamountlow = () => {
      this._emit('drain');
    };
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Create an offer and emit it as a 'signal' event.
   * Call this on the INITIATOR side.
   */
  async createOffer() {
    try {
      // Create data channel (initiator creates it)
      this.dataChannel = this.pc.createDataChannel('allowme-files', { ordered: true });
      this._setupDataChannel(this.dataChannel);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this._emit('signal', { type: 'offer', sdp: this.pc.localDescription });
    } catch (e) {
      console.error('⚡ Failed to create offer:', e);
      this._emit('error', e);
    }
  }

  /**
   * Handle an incoming signaling message (offer, answer, or ICE candidate).
   */
  async handleSignal(signal) {
    if (this._closed) return;
    try {
      if (signal.type === 'offer') {
        // Perfect negotiation: handle offer collision
        const offerCollision = this._makingOffer || this.pc.signalingState !== 'stable';
        if (offerCollision && !this._isPolite) {
          console.warn('⚡ Ignoring colliding offer (impolite peer)');
          return;
        }
        // Responder is the polite peer in perfect negotiation
        if (!this.dataChannel) this._isPolite = true;
        await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await this._flushPendingCandidates();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        this._emit('signal', { type: 'answer', sdp: this.pc.localDescription });

      } else if (signal.type === 'answer') {
        if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          await this._flushPendingCandidates();
        } else {
          console.warn('⚡ Ignoring answer in state:', this.pc.signalingState);
        }

      } else if (signal.type === 'ice-candidate') {
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          this._pendingCandidates.push(signal.candidate);
        }
      }
    } catch (e) {
      console.error('⚡ Signal handling error:', e);
    }
  }

  async _flushPendingCandidates() {
    for (const candidate of this._pendingCandidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('⚡ Failed to add queued ICE candidate:', e);
      }
    }
    this._pendingCandidates = [];
  }

  /**
   * Send data through the data channel.
   */
  send(data) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(data);
      return true;
    }
    return false;
  }

  get bufferedAmount() {
    return this.dataChannel ? this.dataChannel.bufferedAmount : 0;
  }

  get isConnected() {
    return this.dataChannel && this.dataChannel.readyState === 'open';
  }

  // ── Connection Type Detection ─────────────────────────────

  async _detectConnectionType() {
    try {
      const stats = await this.pc.getStats();
      for (const [, report] of stats) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          let localType = 'unknown', remoteType = 'unknown';
          for (const [, r] of stats) {
            if (r.id === report.localCandidateId) localType = r.candidateType || 'unknown';
            if (r.id === report.remoteCandidateId) remoteType = r.candidateType || 'unknown';
          }
          this._connectionType = (localType === 'relay' || remoteType === 'relay') ? 'relay' : 'direct';
          console.log(`⚡ Connection type: ${this._connectionType} (local: ${localType}, remote: ${remoteType})`);
          this._emit('connection-type', this._connectionType);
          return;
        }
      }
    } catch (e) {
      console.warn('⚡ Failed to detect connection type:', e);
    }
  }

  // ── ICE Restart ────────────────────────────────────────────

  async _restartIce() {
    if (this._closed || !this.pc) return;
    this._iceRestartAttempts++;
    try {
      this._makingOffer = true;
      const offer = await this.pc.createOffer({ iceRestart: true });
      if (this.pc.signalingState === 'stable' || this.pc.signalingState === 'have-local-offer') {
        await this.pc.setLocalDescription(offer);
        this._emit('signal', { type: 'offer', sdp: this.pc.localDescription });
        console.log('⚡ ICE restart offer sent');
      }
    } catch (e) {
      console.error('⚡ ICE restart failed:', e);
    } finally {
      this._makingOffer = false;
    }
  }

  // ── Stats Monitoring ──────────────────────────────────────

  _startStatsMonitoring() {
    this._statsInterval = setInterval(() => this._pollStats(), 3000);
  }

  _stopStatsMonitoring() {
    if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
  }

  async _pollStats() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      for (const [, report] of stats) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const rtt = report.currentRoundTripTime ? report.currentRoundTripTime * 1000 : 0;
          const speed = report.availableOutgoingBitrate || 0;
          this._emit('quality', { rtt, speed });
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ── Cleanup ───────────────────────────────────────────────

  close() {
    this._closed = true;
    this._stopStatsMonitoring();
    clearTimeout(this._iceRestartTimer);
    if (this.dataChannel) { try { this.dataChannel.close(); } catch(e) {} this.dataChannel = null; }
    if (this.pc) { try { this.pc.close(); } catch(e) {} this.pc = null; }
    this._handlers = {};
  }

  // ── Event Emitter ─────────────────────────────────────────

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
    return this;
  }

  _emit(event, data) {
    const handlers = this._handlers[event];
    if (handlers) {
      handlers.forEach(h => { try { h(data); } catch (e) { console.error(`Handler error [${event}]:`, e); } });
    }
  }
}
