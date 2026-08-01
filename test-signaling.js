const WebSocket = require('ws');

async function testSignaling() {
  console.log('--- Starting WebRTC Signaling Test ---');
  
  const ws1 = new WebSocket('http://localhost:3000');
  const ws2 = new WebSocket('http://localhost:3000');

  let peer1Id, peer2Id, roomCode;

  ws1.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'joined') {
      peer1Id = msg.peerId;
      console.log('Peer 1 Joined (Auto Room). Requesting new Room Code...');
      ws1.send(JSON.stringify({ type: 'create-room' }));
    }
    if (msg.type === 'room-created') {
      roomCode = msg.roomCode;
      console.log('Peer 1 Created Room Code:', roomCode);
    }
    if (msg.type === 'peer-joined') {
      console.log(`Peer 1 sees Peer 2: ${msg.peerId}`);
      // Peer 1 acts as Initiator
      console.log('Peer 1 Sending Signal Offer...');
      ws1.send(JSON.stringify({ type: 'signal', targetId: msg.peerId, signal: { type: 'offer', sdp: 'fake-sdp-1' } }));
    }
    if (msg.type === 'signal') {
      console.log(`Peer 1 Received Signal from ${msg.from}: ${msg.signal.type}`);
    }
  });

  ws2.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'joined') {
      peer2Id = msg.peerId;
      console.log('Peer 2 Joined (Auto Room).');
      // Wait for peer 1 to get room code
      setTimeout(() => {
        console.log('Peer 2 joining room:', roomCode);
        ws2.send(JSON.stringify({ type: 'join-room', roomCode }));
      }, 500);
    }
    if (msg.type === 'peer-joined') {
      console.log(`Peer 2 sees Peer 1: ${msg.peerId}`);
    }
    if (msg.type === 'signal') {
      console.log(`Peer 2 Received Signal from ${msg.from}: ${msg.signal.type}`);
      // Peer 2 responds with Answer
      console.log('Peer 2 Sending Signal Answer...');
      ws2.send(JSON.stringify({ type: 'signal', targetId: msg.from, signal: { type: 'answer', sdp: 'fake-sdp-2' } }));
    }
  });

  ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join', deviceInfo: { name: 'P1' } })));
  ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join', deviceInfo: { name: 'P2' } })));

  setTimeout(() => {
    console.log('--- Test Complete ---');
    ws1.close();
    ws2.close();
    process.exit(0);
  }, 2000);
}

testSignaling();
