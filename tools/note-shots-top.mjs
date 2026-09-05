// Dev-only: re-capture just the top screen at a tighter height (no video needed).
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'note-draft', 'shots'));
mkdirSync(outDir, { recursive: true });
const URL_ = 'https://yuuya-sakai.github.io/wayfinding-tool/michi-annai-editor.html';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true, executablePath: CHROME, args: ['--no-sandbox'],
  defaultViewport: { width: 1200, height: 760, deviceScaleFactor: 2 },
});
try {
  const page = await browser.newPage();
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#file-input');
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, '01-top.png') });

  // privacy line + step strip, cropped tight - the "送らない・覚えない" evidence shot
  const box = await page.evaluate(() => {
    const b = document.getElementById('dropzone').getBoundingClientRect();
    return { width: 1200, height: Math.ceil(b.bottom + 28) };
  });
  await page.screenshot({ path: path.join(outDir, '01b-top-tight.png'), clip: { x: 0, y: 0, ...box } });

  await page.evaluate(() => { [...document.querySelectorAll('details')].forEach(x => { x.open = true; }); });
  await sleep(400);
  await page.screenshot({ path: path.join(outDir, '03-about-open.png'), fullPage: true });

  await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2 });
  await sleep(600);
  await page.evaluate(() => { [...document.querySelectorAll('details')].forEach(x => { x.open = false; }); window.scrollTo(0, 0); });
  await sleep(400);
  await page.screenshot({ path: path.join(outDir, '15b-phone-top-clean.png') });
  console.log('ok', outDir, JSON.stringify(box));
} finally { await browser.close(); }
