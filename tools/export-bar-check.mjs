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
//   node export-bar-check.mjs [output-dir] [--real] [--shots] [--no-share]
//
//   default    reach the finished state by calling the page's own
//              showExportResult() with a dummy blob (fast - no recording), so
//              the DOM under test is the real one rather than a hand-written
//              copy that can drift
//   --real     actually run an export end to end and use the real result
//              (SLOW - see the note below; consider --real --quick)
//   --quick    with --real: record for ~15s, then jump the video to its last
//              second so the export finishes normally in about a minute. Same
//              MediaRecorder, same canvas frames, same blob, same result DOM -
//              just less of the middle of the video
//
// Note on --real: a full recording of the sample video does NOT finish inside
// puppeteer's 15 minute wait on this machine. Headless Chrome cannot decode a
// 1080x1920 video at 8x while also encoding it, so the replay runs far slower
// than the nominal output length. That is a property of the harness, not of the
// tool. Use --quick unless you specifically need the whole file.
//   --no-share force the download-only layout (browsers with no Web Share for
//              files) by removing navigator.share
//   --coarse   pretend to be a touch device, so the share button leads and the
//              download link steps back - what a phone actually sees
//
// Note: on file:// desktop Chrome DOES expose navigator.share with files, so
// the default fast run already shows both buttons - download leading, share
// second. That is the widest the bar ever gets (the leading button carries the
// file size), which is the case worth measuring.
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
const quick = argv.includes('--quick');
const noShare = argv.includes('--no-share');
const coarse = argv.includes('--coarse');
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
    await page.evaluate((q) => {
      document.getElementById('btn-export').click();
      if (q) {
        // 15s in, skip to the last seconds so 'ended' fires and the export
        // finishes through its normal path.
        //
        // The nudge back to play() afterwards is not optional: headless Chrome
        // cannot decode this 1080x1920 file fast enough to keep the element
        // running, so a few seconds into any export the video stops advancing
        // on its own (it reports paused/waiting with no pause() call anywhere).
        // That is why a plain --real never finishes here. It reproduces on the
        // pre-mp4 code too, so it is the harness, not the tool.
        setTimeout(() => {
          const v = document.getElementById('video');
          try { v.currentTime = Math.max(0, v.duration - 2); } catch (e) {}
          const kick = setInterval(() => {
            if (v.ended) return clearInterval(kick);
            if (!v.seeking && v.paused) v.play().catch(() => {});
          }, 500);
          setTimeout(() => clearInterval(kick), 120000);
        }, 15000);
      }
    }, quick);
    await page.waitForFunction(
      () => document.querySelector('#download-area a.download-btn'),
      { timeout: 15 * 60 * 1000, polling: 2000 });
    exportInfo = await page.evaluate(() => {
      const link = document.querySelector('#download-area a.download-btn');
      return {
        mode: 'real export',
        buttonOrder: [...document.querySelectorAll('#download-area > *')]
          .map(e => e.className + ': ' + e.textContent),
        status: document.getElementById('export-status').textContent,
        // does the recorded file really carry an mp4 signature and open again?
        fileName: link.getAttribute('download'),
        blobUrl: link.href,
      };
    });
    // verify the produced file the same way export-format-check.mjs does
    exportInfo.file = await page.evaluate(async (u) => {
      const blob = await (await fetch(u)).blob();
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const ascii = [...head].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
      const v = document.createElement('video');
      v.preload = 'metadata'; v.src = URL.createObjectURL(blob);
      const meta = await new Promise(res => {
        const to = setTimeout(() => res({ loaded: false }), 15000);
        v.onloadedmetadata = () => { clearTimeout(to); res({ loaded: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight }); };
        v.onerror = () => { clearTimeout(to); res({ loaded: false }); };
      });
      return { type: blob.type, bytes: blob.size, head: ascii, isMp4: ascii.slice(4, 8) === 'ftyp', meta };
    }, exportInfo.blobUrl);
    delete exportInfo.blobUrl;
    exportInfo.seconds = ((Date.now() - t0) / 1000).toFixed(0);
  } else {
    // drive the page's own finished-export renderer with a dummy blob
    exportInfo = await page.evaluate((opt) => {
      if (opt.noShare) {
        // share/canShare live on Navigator.prototype, so `delete navigator.share`
        // is a no-op - shadow them on the instance instead
        for (const k of ['share', 'canShare']) {
          Object.defineProperty(navigator, k, { value: undefined, configurable: true });
        }
      }
      if (opt.coarse) {
        // page.setViewport({hasTouch}) reloads the page and throws away the
        // analysed video (documented trap), so fake the media query instead -
        // it is the only thing the code under test asks about.
        const mm = window.matchMedia.bind(window);
        window.matchMedia = q => (q === '(pointer:coarse)' ? { matches: true, media: q } : mm(q));
      }
      // Allocating ~391MB of nothing would be silly; the label only reads
      // blob.size, so override that instead.
      const blob = new Blob([new Uint8Array(1024)], { type: 'video/mp4' });
      Object.defineProperty(blob, 'size', { value: 410000000 });
      window.__showExportResult(blob, 'video/mp4;codecs=avc1.42E01E,mp4a.40.2');
      const el = document.querySelectorAll('#download-area > *');
      return {
        mode: 'showExportResult() with a dummy blob'
          + (opt.noShare ? ' [no Web Share]' : '') + (opt.coarse ? ' [touch device]' : ''),
        buttonOrder: [...el].map(e => e.className + ': ' + e.textContent),
        status: document.getElementById('export-status').textContent,
      };
    }, { noShare, coarse });
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
      const share = document.getElementById('btn-share');
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
        shareVisible: !!share && r(share).width > 0,
        // both action buttons must sit fully inside the viewport, not just exist
        buttonsInsideViewport: [link, share].filter(Boolean).every(el => {
          const b = r(el);
          return b.left >= -0.5 && b.right <= window.innerWidth + 0.5;
        }),
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
  // Does pressing the share button actually hand a video File to the share
  // sheet? (The stub records what it was given; a real phone is the only place
  // to see what the sheet then offers.)
  let shareCall = null;
  if (!real && !noShare) {
    shareCall = await page.evaluate(async () => {
      let got = null;
      navigator.share = (d) => {
        got = {
          fileCount: (d.files || []).length,
          name: d.files && d.files[0] && d.files[0].name,
          type: d.files && d.files[0] && d.files[0].type,
          isFile: !!(d.files && d.files[0] instanceof File),
          bytes: d.files && d.files[0] && d.files[0].size,
          title: d.title,
        };
        return Promise.resolve();
      };
      document.getElementById('btn-share').click();
      await new Promise(r => setTimeout(r, 100));
      return got;
    });
  }
  console.log(JSON.stringify({ exportInfo, shareCall, report, pageErrors: errs }, null, 2));
} finally {
  await browser.close();
}
