// Real-game Playwright smoke test: boots actual nfsu2.wasm + F:\Need for Speed Underground 2
// inside real Chrome with ?renderer=webgl2, waits for frames to render, captures logs & screenshot!
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18089;

const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'local-dev-server.mjs'), 'F:\\Need for Speed Underground 2', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  srv.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
  srv.stderr.on('data', d => process.stderr.write(d));
  srv.on('exit', c => reject(new Error(`server exited ${c}`)));
});

const logs = [];
let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-gl=angle', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', m => {
    const t = m.text();
    logs.push(`[${m.type()}] ${t}`);
    if (m.type() === 'warning' || m.type() === 'error' || /\[webgl2\]|\[gpu\]|compile|link|fail|fatal|shader|INVALID_/i.test(t)) console.log(`  BROWSER[${m.type()}]: ${t}`);
  });
  page.on('pageerror', e => {
    console.log(`  PAGEERROR: ${e.message}`);
    logs.push(`[pageerror] ${e.message}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/?renderer=webgl2`, { waitUntil: 'domcontentloaded' });
  // Wait for Ready / Play button to become enabled
  await page.waitForFunction(() => {
    const btn = document.querySelector('#play-btn, button#play, [data-play]');
    return btn && !btn.disabled;
  }, { timeout: 30000 }).catch(() => {});

  const statusText = await page.evaluate(() => ({
    status: document.querySelector('#status')?.textContent,
    sub: document.querySelector('#status-sub')?.textContent,
    checks: [...document.querySelectorAll('.check, [data-check]')].map(e => e.textContent?.trim()),
    buttons: [...document.querySelectorAll('button')].map(b => ({ id: b.id, text: b.textContent?.trim(), disabled: b.disabled })),
  }));
  console.log('START PAGE:', JSON.stringify(statusText, null, 2));

  // Click Play button
  const playBtn = page.locator('#play, #play-btn, button:has-text("Play")').first();
  if (await playBtn.isVisible() && !(await playBtn.isDisabled())) {
    console.log('Clicking Play...');
    await playBtn.click();
    await page.waitForTimeout(8000);
    // Press Enter a few times to skip intro video into 3D main menu!
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: path.join(ROOT, 'out', 'webgl2-menu-check.png') });
    const canvasInfo = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return c ? { w: c.width, h: c.height, hidden: c.hidden, rect: c.getBoundingClientRect() } : null;
    });
    console.log('CANVAS:', JSON.stringify(canvasInfo));
  } else {
    console.log('Play button not clickable!');
  }

  const errLines = logs.filter(l => /error|fail|fatal/i.test(l));
  console.log(`Total logs: ${logs.length}, Error-like lines: ${errLines.length}`);
  if (errLines.length) console.log(errLines.slice(0, 30).join('\n'));
} finally {
  if (browser) await browser.close();
  srv.kill();
}
