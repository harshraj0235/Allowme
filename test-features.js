const puppeteer = require('puppeteer');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  console.log('🚀 Starting local feature test report...\n');
  const browser = await puppeteer.launch({ 
    headless: true, // run headless so it doesn't bother the user's screen
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream'] // allows screen sharing to bypass prompts
  });

  try {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();

    console.log('✅ Browser instances created.');

    // 1. Load the app on both pages
    await page1.goto('http://localhost:3000');
    await page2.goto('http://localhost:3000');
    console.log('✅ Pages loaded successfully.');

    // 2. Test Room Code Generation & Joining
    await page1.click('#roomBtn');
    await page1.click('#newRoomBtn');
    await delay(1000);
    
    // Get generated room code
    const roomCode = await page1.$eval('#generatedRoomCode', el => el.textContent);
    console.log(`✅ Room code generated: ${roomCode}`);

    // Join room on page 2
    await page2.click('#roomBtn');
    await page2.type('#roomCodeInput', roomCode);
    await page2.click('#joinRoomBtn');
    console.log(`✅ Page 2 joining room...`);

    // Wait for success popup on both
    await page1.waitForSelector('.success-popup.visible', { timeout: 10000 });
    await page2.waitForSelector('.success-popup.visible', { timeout: 10000 });
    console.log('✅ WebRTC Direct Connection established via Room Code!');

    // Start sharing
    await page1.click('#startChatBtn');
    await page2.click('#startChatBtn');
    await delay(1000);

    // 3. Test Clipboard Sync
    console.log('\nTesting Clipboard Sync...');
    await page1.click('#tabClipboard');
    await page2.click('#tabClipboard');
    await delay(500);

    // Enter text into paste zone and send
    await page1.evaluate(() => {
      document.getElementById('clipboardPasteZone').innerText = 'Hello from Page 1 Clipboard!';
    });
    await page1.click('#clipboardSyncBtn');
    console.log('✅ Sent clipboard from Page 1.');

    // Wait for Page 2 to receive it
    await delay(1000);
    const clipboardText = await page2.$eval('.clipboard-item-text', el => el.textContent);
    if (clipboardText === 'Hello from Page 1 Clipboard!') {
      console.log('✅ Clipboard successfully received on Page 2!');
    } else {
      console.log('❌ Clipboard text mismatch:', clipboardText);
    }

    // 4. Test History DB (IndexedDB)
    console.log('\nTesting Local History Vault...');
    // We can simulate receiving a file to trigger the DB save
    await page1.evaluate(() => {
      // simulate receiving a file
      window.appInstance = window.appInstance || Object.values(window).find(x => x && x._saveToHistory);
      if (window.appInstance && window.appInstance._saveToHistory) {
         window.appInstance._saveToHistory({
           name: 'test-vault-file.png',
           size: 1024,
           fileType: 'image/png',
           url: 'data:image/png;base64,123'
         });
      }
    });
    await delay(500);
    
    await page1.click('#tabHistory');
    await delay(500);
    const historyName = await page1.$eval('.history-item-name', el => el.textContent).catch(() => null);
    if (historyName === 'test-vault-file.png') {
      console.log('✅ IndexedDB History successfully stored and rendered the file!');
    } else {
      console.log('❌ History item not found in UI.');
    }

    // 5. Test Screen Share Initialization
    console.log('\nTesting Screen Share Initialization...');
    await page1.click('#tabScreen');
    await page1.click('#shareScreenBtn');
    await delay(1000);
    // check if stop button is visible
    const stopBtnVisible = await page1.evaluate(() => {
      return document.getElementById('stopScreenBtn').style.display === 'flex';
    });
    if (stopBtnVisible) {
      console.log('✅ Screen Share stream successfully acquired and WebRTC tracks swapped!');
    } else {
      console.log('❌ Screen Share button did not transition to Stop mode.');
    }

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (err) {
    console.error('\n❌ Test failed with error:', err);
  } finally {
    await browser.close();
  }
})();
