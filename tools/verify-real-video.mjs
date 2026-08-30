// Dev-only verification script (NOT part of the shipped tool).
//
// Loads michi-annai-editor.html in a real Chrome instance, feeds it the real
// sample video, waits for analysis to finish, and prints a JSON summary of
// the result (segment list, turns, any window.__debug data). Use this after
// any change to the analysis algorithm to check it against real footage
// instead of only synthetic unit tests.
//
// Usage:
//   node verify-real-video.mjs [path-to-video] [--verbose]
// Defaults to ../sample/IMG_2886.MOV
//
// --verbose also prints the motion-rate distribution, the stop threshold, and
// each stop segment's median rate. That is the view that made the "33 phantom
// stops" bug diagnosable: the rate histogram turned out to be single-humped,
// which showed the threshold rule was wrong rather than the measurements.
//
// Requires an existing Chrome/Edge install (uses puppeteer-core, does not
// download its own Chromium). Do NOT pass --disable-gpu: headless Chrome's
// video decode silently stalls without GPU and analysis will fail.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const videoArg = argv.find(a => !a.startsWith('--'));
const htmlPath = path.resolve(__dirname, '..', 'michi-annai-editor.html');
const videoPath = path.resolve(videoArg || path.join(__dirname, '..', 'sample', 'IMG_2886.MOV'));

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
  args: ['--no-sandbox'], // deliberately no --disable-gpu (breaks video decode)
});

try {
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('[pageerror]', err.message));
  page.on('console', msg => { if (msg.type() === 'error') console.error('[console.error]', msg.text()); });

  await page.goto('file://' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });

  const input = await page.waitForSelector('#file-input');
  await input.uploadFile(videoPath); // fires the 'change' event itself

  const t0 = Date.now();
  await page.waitForFunction(
    () => {
      const preview = document.getElementById('preview-panel');
      const err = document.getElementById('load-error');
      return (preview && !preview.classList.contains('hidden')) ||
             (err && err.textContent.trim().length > 0);
    },
    { timeout: 10 * 60 * 1000, polling: 1000 }
  );
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  const result = await page.evaluate((verbose) => {
    const errEl = document.getElementById('load-error');
    if (errEl && errEl.textContent.trim().length > 0) {
      return { error: errEl.textContent.trim() };
    }
    const strip = h => h.replace(/<br\s*\/?>/g, ' | ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const summary = strip(document.getElementById('result-summary')?.innerHTML || '');
    const notice = strip(document.getElementById('result-notice')?.innerHTML || '');
    const dbg = window.__debug;
    if (!dbg) return { summary, notice, hasDebugHook: false };

    const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
    const ratesIn = (a, b) => dbg.samples
      .filter(s => s.t >= a && s.t < b && isFinite(s.rateS)).map(s => s.rateS);

    const segments = dbg.segments.map(s => {
      const o = {
        kind: s.type === 'stop' ? 'stop' : (s.cruise ? 'cruise' : 'walk'),
        start: +s.start.toFixed(1),
        end: +s.end.toFixed(1),
        sec: +(s.end - s.start).toFixed(1),
        fastForward: !!s.enabled,
      };
      if (s.turnDir) { o.turnDir = s.turnDir; o.turnDeg = +s.turnDeg.toFixed(1); }
      if (verbose) {
        const m = med(ratesIn(s.start, s.end));
        if (m !== null) o.medianRateDegPerSec = +m.toFixed(2);
      }
      return o;
    });

    const walkTurns = dbg.walkTurns.map(w => ({
      t: +w.t.toFixed(1), dir: w.dir, deg: +w.deg.toFixed(1), conf: +w.conf.toFixed(2), manual: w.manual,
    }));

    const turns = [
      ...dbg.segments.filter(s => s.turnDir).map(s => ({ t: +s.end.toFixed(1), dir: s.turnDir, deg: +s.turnDeg.toFixed(1), via: 'after-stop' })),
      ...walkTurns.map(w => ({ t: w.t, dir: w.dir, deg: w.deg, via: 'while-walking' })),
    ].sort((a, b) => a.t - b.t);

    const dur = dbg.samples.length ? dbg.samples[dbg.samples.length - 1].t : 0;
    let ffRaw = 0, ffOut = 0, nStop = 0, nCruise = 0;
    dbg.segments.forEach(s => {
      if (!s.enabled) return;
      const len = s.end - s.start;
      ffRaw += len;
      ffOut += len / (s.type === 'stop' ? 4 : 2); // indicative only; UI holds the real rates
      if (s.type === 'stop') nStop++; else nCruise++;
    });

    const out = {
      summary, notice, hasDebugHook: true,
      videoSec: +dur.toFixed(1),
      counts: {
        segments: dbg.segments.length,
        stops: dbg.segments.filter(s => s.type === 'stop').length,
        cruiseStretches: dbg.segments.filter(s => s.cruise).length,
        turns: turns.length,
        telops: dbg.telops.length,
      },
      fastForward: { stopSegments: nStop, cruiseSegments: nCruise, rawSec: +ffRaw.toFixed(1) },
      turns, segments,
    };

    if (verbose) {
      const all = dbg.samples.map(s => s.rateS).filter(isFinite).sort((a, b) => a - b);
      const pc = p => +all[Math.floor(p * (all.length - 1))].toFixed(2);
      out.motion = {
        unit: 'degrees of apparent motion per second',
        p1: pc(0.01), p10: pc(0.10), p50: pc(0.50), p90: pc(0.90), max: +all[all.length - 1].toFixed(2),
        stopThreshold: +dbg.stopThreshold.toFixed(3),
        pctBelowThreshold: +(100 * all.filter(v => v < dbg.stopThreshold).length / all.length).toFixed(1),
        noStopsFound: dbg.noStopsFound,
      };
    }
    return out;
  }, verbose);

  // Optional: exercise the "same scenery" controls without re-analysing, and
  // confirm that (a) changing them actually changes the segmentation and
  // (b) turn detection is untouched by any of it.
  let cruiseControls = null;
  if (argv.includes('--check-toggle')) {
    cruiseControls = await page.evaluate(() => {
      const snap = label => {
        const d = window.__debug;
        const cruise = d.segments.filter(s => s.cruise);
        return {
          label,
          segments: d.segments.length,
          cruiseStretches: cruise.length,
          cruiseSec: +cruise.reduce((a, s) => a + (s.end - s.start), 0).toFixed(1),
          fastForwarded: d.segments.filter(s => s.enabled).length,
          turns: d.segments.filter(s => s.turnDir).length + d.walkTurns.length,
          // the speed picker does not move any boundaries, so this is what
          // shows that it did anything at all
          exportLength: (document.getElementById('export-estimate')?.textContent || '').trim(),
        };
      };
      const pick = (sel, attr, val) => {
        const b = document.querySelector(`${sel} button[data-${attr}="${val}"]`);
        if (!b) throw new Error(`no button ${sel} [data-${attr}="${val}"]`);
        b.click();
      };
      const out = [snap('default (20s / 2x)')];
      pick('#cruise-len-group', 'clen', '10'); out.push(snap('min length 10s'));
      pick('#cruise-len-group', 'clen', '40'); out.push(snap('min length 40s'));
      pick('#cruise-len-group', 'clen', '20');
      pick('#cruise-speed-group', 'cspeed', '3'); out.push(snap('speed 3x'));
      pick('#cruise-speed-group', 'cspeed', '1.5'); out.push(snap('speed 1.5x'));
      const cb = document.getElementById('cruise-long');
      cb.click(); out.push(snap('cruise off'));
      cb.click(); out.push(snap('cruise back on'));
      return out;
    });
  }

  console.log(JSON.stringify({ elapsedSec, ...result, ...(cruiseControls ? { cruiseControls } : {}) }, null, 2));
} finally {
  await browser.close();
}
