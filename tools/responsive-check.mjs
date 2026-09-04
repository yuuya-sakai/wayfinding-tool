// Dev-only responsive audit (NOT part of the shipped tool).
//
// Analyses the real sample video once, then re-renders the finished editor at
// a set of realistic viewport sizes, measuring overflow / tap-target sizes and
// saving screenshots so the layout can actually be looked at.
//
// Usage:
//   node responsive-check.mjs [output-dir] [--shots]
//
// Do not run alongside verify-real-video.mjs / ui-check.mjs.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'michi-annai-editor.html');
const videoPath = path.resolve(__dirname, '..', 'sample', 'IMG_2886.MOV');
const args = process.argv.slice(2);
const shots = args.includes('--shots');
const outDir = path.resolve(args.find(a => !a.startsWith('--')) || process.cwd());

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
if (!CHROME) throw new Error('No Chrome found');

const VIEWPORTS = [
  { name: 'phone-375', width: 375, height: 812, mobile: true },
  { name: 'phone-430', width: 430, height: 932, mobile: true },
  { name: 'phone-landscape-812x375', width: 812, height: 375, mobile: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true },
  { name: 'desktop-1280', width: 1280, height: 900, mobile: false },
  { name: 'desktop-1600', width: 1600, height: 1000, mobile: false },
];

const browser = await puppeteer.launch({
  headless: true, executablePath: CHROME,
  args: ['--no-sandbox'],
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

  const ready = await page.evaluate(() => ({
    hasDebug: !!window.__debug,
    loadErr: document.getElementById('load-error').textContent.trim(),
    status: document.getElementById('analysis-status').textContent.trim(),
    previewHidden: document.getElementById('preview-panel').classList.contains('hidden'),
  }));
  if (!ready.hasDebug || ready.previewHidden) {
    console.log(JSON.stringify({ abort: 'analysis did not complete', ready, errs }, null, 2));
    await browser.close();
    process.exit(1);
  }

  const report = [];
  for (const vp of VIEWPORTS) {
    // NOTE: do not pass isMobile/hasTouch here. Toggling mobile emulation
    // mid-session tears down and reloads the page, which throws away the
    // analysed video and leaves every panel empty (measured 0x0 everywhere).
    // Plain width/height re-lays-out without disturbing page state.
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
    await new Promise(r => setTimeout(r, 350)); // let resize handlers redraw

    const m = await page.evaluate(() => {
      const vw = window.innerWidth;
      const overflowing = [];
      // any element whose content is wider than its own box
      document.querySelectorAll('.segmented,.seg-actions,.telop-meta,.action-bar-inner,.steps,#timeline-wrap,.seg,.telop-item,.panel,.summary,.controls-row,.timeline-legend')
        .forEach(el => {
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
            overflowing.push({
              sel: el.className.toString().split(' ')[0] || el.id,
              id: el.id || null, scrollW: el.scrollWidth, clientW: el.clientWidth,
            });
          }
        });
      // anything sticking out past the right edge of the window
      const past = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1.5) {
          past.push({ tag: el.tagName.toLowerCase(), cls: (el.className.toString() || '').slice(0, 40), right: Math.round(r.right) });
        }
      });
      const btnSizes = [];
      document.querySelectorAll('.seg-actions button, .segmented button, .telop-meta button, .te-row button, .controls-row button')
        .forEach(b => { const r = b.getBoundingClientRect(); if (r.width > 0) btnSizes.push(Math.round(Math.min(r.width, r.height))); });
      const tl = document.getElementById('timeline').getBoundingClientRect();
      const barEl = document.getElementById('export-panel').getBoundingClientRect();
      const prev = document.getElementById('preview-wrapper').getBoundingClientRect();
      const v = document.getElementById('video');
      return {
        state: {
          hasDebug: !!window.__debug,
          previewHidden: document.getElementById('preview-panel').classList.contains('hidden'),
          videoErr: v.error ? v.error.code + ':' + v.error.message : null,
          videoReadyState: v.readyState,
          loadErr: document.getElementById('load-error').textContent.trim().slice(0, 80),
          activeStep: document.querySelector('.step.active')?.textContent.trim(),
        },
        docScrollW: document.documentElement.scrollWidth, innerW: vw,
        horizontalPageOverflow: document.documentElement.scrollWidth - vw,
        overflowing: overflowing.slice(0, 12),
        pastRightEdge: past.slice(0, 12),
        smallestTapTarget: btnSizes.length ? Math.min(...btnSizes) : null,
        timeline: { w: Math.round(tl.width), h: Math.round(tl.height) },
        actionBar: { h: Math.round(barEl.height), pctOfViewport: +(barEl.height / window.innerHeight * 100).toFixed(1) },
        preview: { w: Math.round(prev.width), h: Math.round(prev.height) },
        bodyPadBottom: getComputedStyle(document.body).paddingBottom,
      };
    });

    // open the on-video caption editor and check it fits horizontally
    const editor = await page.evaluate(() => {
      const first = document.querySelector('.telop-tag');
      if (!first) {
        document.getElementById('btn-add-telop').click();
      } else {
        first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
      }
      const ed = document.getElementById('telop-editor');
      if (ed.classList.contains('hidden')) return { open: false };
      const e = ed.getBoundingClientRect();
      const p = document.getElementById('preview-wrapper').getBoundingClientRect();
      const btns = [...ed.querySelectorAll('.te-row button')].map(b => {
        const r = b.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height));
      });
      return {
        open: true,
        insidePreview: e.left >= p.left - 1 && e.right <= p.right + 1 && e.top >= p.top - 1 && e.bottom <= p.bottom + 1,
        editorW: Math.round(e.width), previewW: Math.round(p.width),
        rowOverflow: ed.querySelector('.te-row').scrollWidth - ed.querySelector('.te-row').clientWidth,
        smallestButton: btns.length ? Math.min(...btns) : null,
      };
    });

    if (shots) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(outDir, `r-${vp.name}-top.png`) });
      const sel = await page.$('#result-panel');
      if (sel) await sel.screenshot({ path: path.join(outDir, `r-${vp.name}-segments.png`) }).catch(() => {});
      const st = await page.$('#settings-panel');
      if (st) await st.screenshot({ path: path.join(outDir, `r-${vp.name}-settings.png`) }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: path.join(outDir, `r-${vp.name}-bottom.png`) });
    }
    await page.evaluate(() => document.getElementById('te-close')?.click());
    report.push({ viewport: vp.name, ...m, editor });
  }
  console.log(JSON.stringify({ report, pageErrors: errs }, null, 2));
} finally {
  await browser.close();
}
