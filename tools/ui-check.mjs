// Dev-only UI check (NOT part of the shipped tool).
//
// verify-real-video.mjs answers "are the numbers right". This one answers
// "does the editing UI actually work when you click it" - the parts that a
// JSON dump cannot tell you. It drives the real page with the real sample
// video and asserts the step-3 review flow:
//
//   - the export button stays on screen at any scroll position
//   - clicking a caption on the video opens the inline editor
//   - typing there updates both the video overlay and the list panel
//   - dragging a caption moves it and does NOT open the editor
//   - deleting from the editor removes the caption
//
// It also writes screenshots so the rendering can be eyeballed:
//   ui-editor.png       editor open on a newly added caption
//   ui-editor-typed.png after typing and repositioning
//   ui-badge.png        the caption's edit affordance, editor dismissed
//
// Usage:
//   node ui-check.mjs [output-dir]      (default: current directory)
//
// Do not run this at the same time as verify-real-video.mjs - two Chrome
// instances decoding the same video will fight and one will drop its frames.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'michi-annai-editor.html');
const videoPath = path.resolve(__dirname, '..', 'sample', 'IMG_2886.MOV');
const outDir = path.resolve(process.argv[2] || process.cwd());

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge install found in the usual locations.');
if (!existsSync(videoPath)) throw new Error('Video not found: ' + videoPath);

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--window-size=1400,1000'], // no --disable-gpu (breaks video decode)
  defaultViewport: { width: 1400, height: 1000 },
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

  const loadErr = await page.evaluate(() => document.getElementById('load-error').textContent.trim());
  if (loadErr) { console.log(JSON.stringify({ loadErr, errs }, null, 2)); await browser.close(); process.exit(1); }

  // --- export button reachability ---
  const barBottom = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const b = document.getElementById('export-panel').getBoundingClientRect();
    const btn = document.getElementById('btn-export').getBoundingClientRect();
    return {
      pinnedToBottom: b.bottom <= window.innerHeight + 1 && b.top < window.innerHeight,
      buttonVisibleScrolledDown: btn.top >= 0 && btn.bottom <= window.innerHeight,
      bodyPaddingBottom: getComputedStyle(document.body).paddingBottom,
      estimate: document.getElementById('export-estimate').textContent,
    };
  });
  const barTop = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const btn = document.getElementById('btn-export').getBoundingClientRect();
    return { buttonVisibleScrolledUp: btn.top >= 0 && btn.bottom <= window.innerHeight };
  });

  // --- inline caption editor ---
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('btn-add-telop').click(); });
  await new Promise(r => setTimeout(r, 300));
  const afterAdd = await page.evaluate(() => ({
    editorOpens: !document.getElementById('telop-editor').classList.contains('hidden'),
    focusedField: document.activeElement && document.activeElement.id,
    stayedInsidePreview: (() => {
      const p = document.getElementById('preview-wrapper').getBoundingClientRect();
      const e = document.getElementById('telop-editor').getBoundingClientRect();
      return e.left >= p.left - 1 && e.right <= p.right + 1 && e.top >= p.top - 1 && e.bottom <= p.bottom + 1;
    })(),
  }));
  await page.screenshot({ path: path.join(outDir, 'ui-editor.png') });

  await page.focus('#te-text');
  await page.evaluate(() => { document.getElementById('te-text').value = ''; });
  await page.type('#te-text', 'ここを右に');
  await new Promise(r => setTimeout(r, 150));
  const synced = await page.evaluate(() => ({
    onVideo: document.querySelector('.telop-tag')?.textContent,
    inListPanel: document.querySelector('#telop-list .telop-text')?.value,
  }));

  await page.evaluate(() => document.querySelector('.te-pos[data-y="12"]').click());
  await new Promise(r => setTimeout(r, 120));
  const movedTop = await page.evaluate(() => document.querySelector('.telop-tag').style.top);
  await page.screenshot({ path: path.join(outDir, 'ui-editor-typed.png') });

  // --- drag must reposition without opening the editor ---
  await page.evaluate(() => document.getElementById('te-close').click());
  await new Promise(r => setTimeout(r, 150));
  await (await page.$('#preview-wrapper')).screenshot({ path: path.join(outDir, 'ui-badge.png') });

  const centre = async () => page.evaluate(() => {
    const b = document.querySelector('.telop-tag').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  let c = await centre();
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 8 });
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 150));
  const drag = await page.evaluate(() => ({
    editorStayedClosed: document.getElementById('telop-editor').classList.contains('hidden'),
    newTop: document.querySelector('.telop-tag').style.top,
  }));

  // --- a plain click should open it ---
  c = await centre();
  await page.mouse.click(c.x, c.y);
  await new Promise(r => setTimeout(r, 200));
  const clickOpensEditor = await page.evaluate(
    () => !document.getElementById('telop-editor').classList.contains('hidden'));

  const deleted = await page.evaluate(() => {
    const before = window.__debug.telops.length;
    document.getElementById('te-delete').click();
    return { before, after: window.__debug.telops.length,
             editorClosed: document.getElementById('telop-editor').classList.contains('hidden') };
  });

  // analysis must be untouched by a UI-only change
  const analysis = await page.evaluate(() => {
    const d = window.__debug;
    return {
      segments: d.segments.length,
      stops: d.segments.filter(s => s.type === 'stop').length,
      cruiseStretches: d.segments.filter(s => s.cruise).length,
      turns: d.walkTurns.map(w => `${w.dir} ${Math.round(w.deg)}deg @${w.t.toFixed(1)}`)
        .concat(d.segments.filter(s => s.turnDir).map(s => `${s.turnDir} ${Math.round(s.turnDeg)}deg @${s.end.toFixed(1)}`)),
    };
  });

  console.log(JSON.stringify({
    exportButton: { ...barBottom, ...barTop },
    captionEditor: { afterAdd, synced, movedTop, drag, clickOpensEditor, deleted },
    analysis, pageErrors: errs,
  }, null, 2));
} finally {
  await browser.close();
}
