// Dev-only screenshot capture for the note article (NOT part of the shipped tool).
//
// Loads the PUBLISHED site (GitHub Pages) in a real Chrome, feeds it the real
// sample video, and saves the screenshots used in the paid note article.
//
// Usage:
//   node note-shots.mjs [output-dir] [--local] [--no-export]
//
// Same rules as the other tools here: puppeteer-core (no Chromium download),
// never pass --disable-gpu (headless video decode stalls), never pass
// isMobile/hasTouch to setViewport (it reloads the page and loses the analysis).

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const useLocal = argv.includes('--local');
const noExport = argv.includes('--no-export');
const outDir = path.resolve(argv.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'note-draft', 'shots'));
mkdirSync(outDir, { recursive: true });

const LIVE_URL = 'https://yuuya-sakai.github.io/wayfinding-tool/michi-annai-editor.html';
const localPath = path.resolve(__dirname, '..', 'michi-annai-editor.html');
const targetUrl = useLocal ? 'file://' + localPath.replace(/\\/g, '/') : LIVE_URL;
const videoPath = path.resolve(__dirname, '..', 'sample', 'IMG_2886.MOV');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge install found.');
if (!existsSync(videoPath)) throw new Error('Video not found: ' + videoPath);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const shot = async (page, name, sel) => {
  const p = path.join(outDir, name);
  if (sel) {
    const el = await page.$(sel);
    if (!el) { log.push(`SKIP ${name} (no ${sel})`); return; }
    await el.screenshot({ path: p });
  } else {
    await page.screenshot({ path: p });
  }
  log.push(`saved ${name}${sel ? ' <- ' + sel : ''}`);
};

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--window-size=1400,1000'], // no --disable-gpu
  defaultViewport: { width: 1400, height: 1000, deviceScaleFactor: 2 },
});

const errs = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('#file-input');
  await sleep(1500); // let Google Fonts settle
  log.push('loaded ' + page.url());

  // --- 1. top screen, as a first-time visitor sees it -----------------------
  await shot(page, '01-top.png');
  await shot(page, '02-top-full.png');

  // open the "このツールについて / うまく作るコツ" disclosure
  const opened = await page.evaluate(() => {
    const d = [...document.querySelectorAll('details')];
    d.forEach(x => { x.open = true; });
    return d.length;
  });
  log.push('details opened: ' + opened);
  await sleep(400);
  await shot(page, '03-about-open.png');

  // --- 2. analysis in progress ---------------------------------------------
  await page.evaluate(() => { [...document.querySelectorAll('details')].forEach(x => { x.open = false; }); });
  const input = await page.$('#file-input');
  await input.uploadFile(videoPath);
  const t0 = Date.now();
  await page.waitForFunction(
    () => { const a = document.getElementById('analysis-panel'); return a && !a.classList.contains('hidden'); },
    { timeout: 120000, polling: 500 });
  await sleep(12000);
  await shot(page, '04-analyzing.png');
  await shot(page, '04b-analyzing-panel.png', '#analysis-panel');

  // --- 3. finished analysis -------------------------------------------------
  await page.waitForFunction(() => {
    const p = document.getElementById('preview-panel');
    const e = document.getElementById('load-error');
    return (p && !p.classList.contains('hidden')) || (e && e.textContent.trim());
  }, { timeout: 12 * 60 * 1000, polling: 1000 });
  const analysisSec = ((Date.now() - t0) / 1000).toFixed(0);
  log.push('analysis finished in ' + analysisSec + 's');

  const loadErr = await page.evaluate(() => document.getElementById('load-error').textContent.trim());
  if (loadErr) throw new Error('load error: ' + loadErr);

  const summary = await page.evaluate(() => {
    const strip = h => (h || '').replace(/<br\s*\/?>/g, ' | ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const d = window.__debug;
    return {
      resultSummary: strip(document.getElementById('result-summary')?.innerHTML),
      resultNotice: strip(document.getElementById('result-notice')?.innerHTML),
      exportEstimate: (document.getElementById('export-estimate')?.textContent || '').trim(),
      segments: d ? d.segments.length : null,
      stops: d ? d.segments.filter(s => s.type === 'stop').length : null,
      cruise: d ? d.segments.filter(s => s.cruise).length : null,
      telops: d ? d.telops.map(t => `${t.text} @${t.start.toFixed(1)}`) : null,
      turns: d ? [
        ...d.segments.filter(s => s.turnDir).map(s => `${s.turnDir} ${Math.round(s.turnDeg)}deg @${s.end.toFixed(1)} (after-stop)`),
        ...d.walkTurns.map(w => `${w.dir} ${Math.round(w.deg)}deg @${w.t.toFixed(1)} (while-walking)`),
      ] : null,
      videoSize: (() => { const v = document.getElementById('video'); return v ? `${v.videoWidth}x${v.videoHeight} ${v.duration.toFixed(1)}s` : null; })(),
    };
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await shot(page, '05-result-top.png');
  await shot(page, '06-result-summary.png', '#result-panel');
  await shot(page, '07-preview.png', '#preview-panel');
  await shot(page, '08-timeline.png', '#timeline-wrap');
  await shot(page, '09-settings.png', '#settings-panel');

  // segment list: scroll it into view first so lazy layout settles
  await page.evaluate(() => document.getElementById('segment-list')?.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await shot(page, '10-segment-list.png', '#segment-list');
  await shot(page, '10b-segment-list-view.png');

  // whole editing screen, one tall image
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await page.screenshot({ path: path.join(outDir, '11-editor-fullpage.png'), fullPage: true });
  log.push('saved 11-editor-fullpage.png (fullPage)');

  // --- 4. inline caption editing -------------------------------------------
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const d = window.__debug;
    const v = document.getElementById('video');
    // jump to the first auto-generated turn caption so the shot shows a real one
    const t = d && d.telops.find(x => /曲がります/.test(x.text));
    if (t && v) v.currentTime = t.start + 0.6;
  });
  await sleep(1200);
  await shot(page, '12-preview-with-telop.png', '#preview-panel');

  const clicked = await page.evaluate(() => {
    const tag = document.querySelector('.telop-tag');
    if (!tag) return false;
    const b = tag.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (clicked) {
    await page.mouse.click(clicked.x, clicked.y);
    await sleep(500);
    await shot(page, '13-telop-editor.png', '#preview-panel');
    await shot(page, '13b-telop-editor-view.png');
    await page.evaluate(() => document.getElementById('te-close')?.click());
    await sleep(200);
  } else {
    log.push('SKIP telop editor (no .telop-tag at this time)');
  }

  await shot(page, '14-telop-list.png', '#telop-panel');

  // --- 5. phone width -------------------------------------------------------
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); // width/height only
  await sleep(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await shot(page, '15-phone-top.png');
  await page.evaluate(() => document.getElementById('segment-list')?.scrollIntoView({ block: 'start' }));
  await sleep(400);
  await shot(page, '16-phone-segments.png');
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
  await sleep(800);

  // --- 6. export --------------------------------------------------------
  let exportInfo = null;
  if (!noExport) {
    await page.evaluate(() => {
      document.getElementById('btn-export').click();
      // headless Chrome cannot decode this 1080x1920 clip fast enough to reach
      // the end of a full export, so record ~20s then jump to the tail and
      // nudge play() until it ends. Same recorder/canvas/blob/finish screen.
      setTimeout(() => {
        const v = document.getElementById('video');
        try { v.currentTime = Math.max(0, v.duration - 2); } catch (e) {}
        const kick = setInterval(() => {
          if (v.ended) return clearInterval(kick);
          if (!v.seeking && v.paused) v.play().catch(() => {});
        }, 500);
        setTimeout(() => clearInterval(kick), 120000);
      }, 20000);
    });
    await sleep(9000);
    await shot(page, '17-exporting.png', '#export-panel');
    await shot(page, '17b-exporting-view.png');

    await page.waitForFunction(() => document.querySelector('#download-area a.download-btn'),
      { timeout: 15 * 60 * 1000, polling: 2000 });
    await sleep(600);
    exportInfo = await page.evaluate(async () => {
      const link = document.querySelector('#download-area a.download-btn');
      const blob = await (await fetch(link.href)).blob();
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const ascii = [...head].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
      return {
        status: document.getElementById('export-status').textContent.trim(),
        fileName: link.getAttribute('download'),
        buttons: [...document.querySelectorAll('#download-area > *')].map(e => e.textContent.trim()),
        type: blob.type, bytes: blob.size, isMp4: ascii.slice(4, 8) === 'ftyp',
      };
    });
    await shot(page, '18-export-done.png', '#export-panel');
    await shot(page, '18b-export-done-view.png');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await sleep(700);
    await shot(page, '19-phone-export-done.png');
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
  }

  console.log(JSON.stringify({
    url: page.url(), outDir, analysisSec, summary, exportInfo, log, pageErrors: errs,
  }, null, 2));
} catch (e) {
  console.error('FAILED:', e.message);
  console.log(JSON.stringify({ log, pageErrors: errs }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
