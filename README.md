# ⚡ Allowme — Universal File Sharing

Share **any file** between **any device** — Android, iPhone, PC, Mac — instantly through your browser. No app install required.

## Features

- **Cross-Platform**: Works on any device with a modern browser
- **Peer-to-Peer**: Files transfer directly between devices via WebRTC — nothing stored on servers
- **Fast**: 256KB chunking with adaptive flow control
- **Any File Size**: No limits — send 10KB or 10GB
- **Secure**: End-to-end encrypted via WebRTC DTLS
- **No Install**: Just open the URL
- **QR Code & Room Code**: Pair devices on different networks
- **PWA**: Install on your home screen like a native app

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3000** on two or more devices on the same Wi-Fi.

## How It Works

1. Open Allowme on **Device A**
2. Open it on **Device B** (same Wi-Fi)
3. Devices auto-discover each other
4. Tap a device → connection established
5. Select files → Send

### Different Networks?
Use **QR Code** or **Room Code** to pair devices across networks.

## Tech Stack

| Component | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + JS (ES Modules) |
| Backend | Node.js + Express + ws |
| Transfer | WebRTC Data Channels |
| Discovery | WebSocket Signaling |

## Architecture

```
Device A ◄══════ WebRTC P2P ══════► Device B
    │         (direct transfer)          │
    │                                    │
    └──── WebSocket (signaling) ────────┘
                    │
           Node.js Server
          (no files pass here)
```

## License

MIT
