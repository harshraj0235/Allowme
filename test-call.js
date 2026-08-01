const puppeteer = require('puppeteer');
const fs = require('fs');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  console.log('🚀 Starting Live Call demo...');
  const browser = await puppeteer.launch({ 
    headless: 'new',
    channel: 'chrome',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--window-size=1280,720'
    ]
  });

  try {
    const page1 = await browser.newPage();
    await page1.setViewport({ width: 1280, height: 720 });
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1280, height: 720 });

    console.log('✅ Browser instances created with fake media devices.');

    await page1.goto('http://localhost:3000');
    await page2.goto('http://localhost:3000');
    console.log('✅ Pages loaded successfully.');

    // Connect them
    await page1.$eval('#roomBtn', b => b.click());
    await page1.$eval('#newRoomBtn', b => b.click());
    await delay(1000);
    const roomCode = await page1.$eval('#generatedRoomCode', el => el.textContent);
    console.log(`✅ Room code generated: ${roomCode}`);

    await page2.$eval('#roomBtn', b => b.click());
    await page2.type('#roomCodeInput', roomCode);
    await page2.$eval('#joinRoomBtn', b => b.click());
    
    await page1.waitForSelector('.success-popup.visible', { timeout: 10000 });
    await page2.waitForSelector('.success-popup.visible', { timeout: 10000 });
    console.log('✅ WebRTC Direct Connection established!');
    
    await delay(1000);

    // Go to Call tab on page1
    await page1.$eval('#tabCall', b => b.click());
    await delay(500);

    // Start Video Call from page1
    console.log('🎥 Starting Video Call from Page 1...');
    await page1.$eval('#startVideoCallBtn', b => b.click());
    
    // Wait for the UI to update on page1
    await delay(2000);
    
    // Page 2 should automatically switch to Call tab and show incoming call
    console.log('📸 Taking screenshot of Page 2 (Incoming Call)...');
    await page2.screenshot({ path: 'C:\\Users\\harshraj\\.gemini\\antigravity-ide\\brain\\ab055c4d-f01c-43fe-b97c-f16d497eebd3\\call_demo_page2.png' });

    console.log('📸 Taking screenshot of Page 1 (Active Call)...');
    await page1.screenshot({ path: 'C:\\Users\\harshraj\\.gemini\\antigravity-ide\\brain\\ab055c4d-f01c-43fe-b97c-f16d497eebd3\\call_demo_page1.png' });

    // Join back from Page 2 to establish 2-way video
    console.log('🎥 Starting Video Call from Page 2...');
    await page2.$eval('#startVideoCallBtn', b => b.click());
    
    await delay(3000);

    console.log('📸 Taking screenshot of 2-way active call (Page 1)...');
    await page1.screenshot({ path: 'C:\\Users\\harshraj\\.gemini\\antigravity-ide\\brain\\ab055c4d-f01c-43fe-b97c-f16d497eebd3\\call_demo_2way_page1.png' });

    console.log('✅ Demo complete. Screenshots saved to artifacts.');
  } catch (e) {
    console.error('❌ Error during demo:', e);
  } finally {
    await browser.close();
  }
})();
