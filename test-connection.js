const puppeteer = require('puppeteer');

async function runTest() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  
  // Open Tab 1
  const page1 = await browser.newPage();
  page1.on('console', msg => console.log('PAGE 1:', msg.text()));
  await page1.goto('http://localhost:3000');
  
  // Open Tab 2
  const page2 = await browser.newPage();
  page2.on('console', msg => console.log('PAGE 2:', msg.text()));
  await page2.goto('http://localhost:3000');

  // Wait for both to load
  await new Promise(r => setTimeout(r, 2000));
  
  console.log('--- Clicking peer in Tab 2 ---');
  // In Tab 2, find the peer and click it
  await page2.evaluate(() => {
    const peer = document.querySelector('.peer-device');
    if (peer) {
      peer.click();
      console.log('Clicked peer in DOM');
    } else {
      console.log('No peer found in DOM');
    }
  });

  // Wait for connection
  await new Promise(r => setTimeout(r, 4000));
  
  console.log('--- Test Finished ---');
  await browser.close();
}

runTest().catch(console.error);
