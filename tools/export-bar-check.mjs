// Dev-only check for the bottom action bar in its POST-EXPORT state.
//
// The bar looks fine before an export, but once the export finishes it also
// has to hold the download link. On a phone that extra, non-shrinkable button
// can starve the text block next to it down to near-zero width - and Japanese
// text has no spaces, so it will happily wrap at every single character and
// grow to hundreds of lines. That is invisible to any test that only looks at
// the pre-export layout, which is why it shipped.
//
// Usage:
//   node export-bar-check.mjs [output-dir] [--real] [--shots]
//
//   default  simulate the finished state by injecting exactly the DOM that
//            exportVideo() produces (fast - no recording)
//   --real   actually run an export end to end and use the real result
//            (slow: replays and records the whole edited video)
//
// Do not run alongside the other tools.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'michi-annai-editor.html');
const videoPath = path.resolve(__dirname, '..', 'sample', 'IMG_2886.MOV');
const argv = process.argv.slice(2);
const real = argv.includes('--real');
const shots = argv.includes('--shots');
const outDir = path.resolve(argv.find(a => !a.startsWith('--')) || process.cwd());

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
if (!CHROME) throw new Error('No Chrome found');

const WIDTHS = [
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'phone-430', width: 430, height: 932 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 900 },
];

const browser = await puppeteer.launch({
  headless: true, executablePath: CHROME,
  args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 900 },
  // a real export re-plays and records the whole edited video, which easily
  // outlasts puppeteer's 3 minute default CDP timeout
  protocolTimeout: 30 * 60 * 1000,
});
const errs = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('file://' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
  const input = await page.waitForSelector('#file-input');
  await input.uploadFile(videoPath);
  await page.waitForFunction(() => {
    const p = document.getElementById('preview-panel');
    const e = document.getElementById('load-error');
    return (p && !p.classList.contains('hidden')) || (e && e.textContent.trim());
  }, { timeout: 10 * 60 * 1000, polling: 1000 });

  let exportInfo;
  if (real) {
    // crank the speeds up first so the recording does not take three minutes
    await page.evaluate(() => {
      document.querySelector('#speed-group button[data-speed="8"]').click();
      document.querySelector('#cruise-speed-group button[data-cspeed="3"]').click();
    });
    const t0 = Date.now();
    await page.evaluate(() => document.getElementById('btn-export').click());
    await page.waitForFunction(
      () => document.querySelector('#download-area a.download-btn'),
      { timeout: 15 * 60 * 1000, polling: 2000 });
    exportInfo = await page.evaluate(() => ({
      mode: 'real export',
      link: document.querySelector('#download-area a.download-btn').textContent,
      status: document.getElementById('export-status').textContent,
    }));
    exportInfo.seconds = ((Date.now() - t0) / 1000).toFixed(0);
  } else {
    // reproduce exactly what exportVideo() leaves behind on success
    exportInfo = await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'download-btn';
      a.textContent = '⬇ 動画をダウンロード（.webm　391.1MB）';
      document.getElementById('download-area').appendChild(a);
      const pr = document.getElementById('export-progress');
      pr.classList.remove('hidden'); pr.value = 100;
      document.getElementById('export-status').textContent =
        '書き出しが完了しました。WebM形式です（標準プレーヤーやYouTube、LINEでそのまま再生できます）。';
      // mirror the real success path, which retires the export button
      document.getElementById('btn-export').classList.add('hidden');
      return { mode: 'simulated finished state' };
    });
  }

  const report = [];
  for (const vp of WIDTHS) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    await new Promise(r => setTimeout(r, 300));
    const m = await page.evaluate(() => {
      const bar = document.getElementById('export-panel');
      const info = document.querySelector('.ab-info');
      const status = document.getElementById('export-status');
      const est = document.getElementById('export-estimate');
      const link = document.querySelector('#download-area a.download-btn');
      const btn = document.getElementById('btn-export');
      const cs = getComputedStyle(status);
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight) || fs * 1.65;
      const r = el => el ? el.getBoundingClientRect() : null;
      const sb = r(status);
      return {
        barHeight: Math.round(r(bar).height),
        barPctOfViewport: +(r(bar).height / window.innerHeight * 100).toFixed(1),
        abInfoWidth: Math.round(r(info).width),
        statusWidth: Math.round(sb.width),
        statusHeight: Math.round(sb.height),
        statusLines: Math.max(1, Math.round(sb.height / lh)),
        approxCharsPerLine: +(sb.width / fs).toFixed(1),
        estimateWidth: Math.round(r(est).width),
        downloadVisible: !!link && r(link).width > 0,
        exportBtnVisible: !!btn && r(btn).width > 0 && getComputedStyle(btn).display !== 'none',
        pageHorizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        barOverflowsViewportHeight: r(bar).height > window.innerHeight * 0.5,
      };
    });
    if (shots) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 150));
      await page.screenshot({ path: path.join(outDir, `x-${vp.name}.png`) });
    }
    report.push({ viewport: vp.name, ...m });
  }
  console.log(JSON.stringify({ exportInfo, report, pageErrors: errs }, null, 2));
} finally {
  await browser.close();
}
