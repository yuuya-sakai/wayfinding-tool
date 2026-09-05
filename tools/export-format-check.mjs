// Dev-only check for the export FORMAT decision (9th round of changes).
//
// pickMimeType() now asks for mp4/H.264 before webm, because a .webm file is a
// dead end on a phone: iOS does not recognise it as a video, so it cannot go
// into the Photos app. This script checks the part of that we can actually
// check from here:
//
//   1. which of the candidate mime strings this browser really accepts
//      (the candidate list is read out of michi-annai-editor.html, so it can
//      never drift away from the shipped file)
//   2. that recording with the winning candidate produces a file that is
//      actually well-formed - right container signature, non-zero size, and
//      the browser can load it back and report a duration and frame size
//   3. whether the Web Share API with files is offered here, using exactly the
//      same feature detection as the tool
//
// What this CANNOT check: real iOS Safari. Neither its isTypeSupported answers
// nor whether its share sheet offers "ビデオを保存" for the resulting file.
// That needs a real iPhone.
//
//   node export-format-check.mjs

import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'michi-annai-editor.html');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
if (!CHROME) throw new Error('No Chrome found');

// pull the candidate list straight out of the shipped file
const html = readFileSync(htmlPath, 'utf8');
const m = html.match(/var MIME_CANDIDATES\s*=\s*\[([\s\S]*?)\];/);
if (!m) throw new Error('MIME_CANDIDATES not found in michi-annai-editor.html');
const CANDIDATES = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
if (!CANDIDATES.length) throw new Error('MIME_CANDIDATES parsed empty');

const browser = await puppeteer.launch({
  headless: true, executablePath: CHROME, args: ['--no-sandbox'],
  defaultViewport: { width: 900, height: 700 },
  protocolTimeout: 5 * 60 * 1000,
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m2 => { if (m2.type() === 'error') errs.push('console: ' + m2.text()); });
  await page.goto('about:blank');

  const out = await page.evaluate(async (cands) => {
    const support = {};
    for (const c of cands) {
      try { support[c] = !!(window.MediaRecorder && MediaRecorder.isTypeSupported(c)); }
      catch (e) { support[c] = 'threw: ' + e.message; }
    }
    const picked = cands.find(c => support[c] === true) || '';

    // --- record a few seconds the same way exportVideo() does ---
    // Full 1080x1920: the export records at the source video's resolution, and
    // the whole point of this check is whether the encoder copes with that.
    const canvas = document.createElement('canvas');
    canvas.width = 1080; canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);

    let audioNote = 'none';
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ac.createOscillator();
      const dest = ac.createMediaStreamDestination();
      osc.connect(dest); osc.start();
      dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      audioNote = 'oscillator track added';
    } catch (e) { audioNote = 'audio failed: ' + e.message; }

    let rec = null, usedMime = '';
    for (const c of [picked, ''].filter((v, i, a) => a.indexOf(v) === i)) {
      try {
        rec = new MediaRecorder(stream, c ? { mimeType: c, videoBitsPerSecond: 6000000 } : undefined);
        usedMime = c; break;
      } catch (e) { rec = null; }
    }
    if (!rec) return { support, picked, error: 'MediaRecorder constructor rejected every candidate' };
    if (!usedMime && rec.mimeType) usedMime = rec.mimeType;

    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(500);
    const t0 = performance.now();
    let frames = 0;
    await new Promise(done => {
      (function draw() {
        const t = (performance.now() - t0) / 1000;
        frames++;
        ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 1080, 1920);
        ctx.fillStyle = '#F0B44A';
        ctx.fillRect((t * 200) % 900, 400, 140, 140);
        ctx.font = '700 86px sans-serif'; ctx.fillStyle = '#fff';
        ctx.fillText('右に曲がります', 80, 1000);
        if (t > 5) return done();
        requestAnimationFrame(draw);
      })();
    });
    const drawSeconds = (performance.now() - t0) / 1000;
    rec.stop();
    const tStop = performance.now();
    await stopped;
    const flushSeconds = (performance.now() - tStop) / 1000;

    const ext = usedMime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const hex = [...head].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...head].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    const signatureOk = ext === 'mp4'
      ? ascii.slice(4, 8) === 'ftyp'                                   // ISO base media
      : (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3); // EBML

    // can the browser read back what it just wrote?
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata'; v.src = url;
    const playback = await new Promise(res => {
      const to = setTimeout(() => res({ loaded: false, reason: 'timeout' }), 10000);
      v.onloadedmetadata = () => {
        clearTimeout(to);
        res({ loaded: true, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      };
      v.onerror = () => { clearTimeout(to); res({ loaded: false, reason: 'video error' }); };
    });

    // --- share sheet detection, identical to the tool's ---
    let canShareFile = false, shareErr = null;
    try {
      const f = new File([blob], '道案内動画_編集済み.' + ext, { type: blob.type });
      canShareFile = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (e) { shareErr = String(e); }

    return {
      support, picked, usedMime, ext,
      audio: audioNote,
      canvas: '1080x1920',
      // drawSeconds should stay near 5 and fps near 30; if the encoder cannot
      // keep up it drags requestAnimationFrame down with it
      drawSeconds: +drawSeconds.toFixed(2),
      drawnFrames: frames,
      fps: +(frames / drawSeconds).toFixed(1),
      flushSeconds: +flushSeconds.toFixed(2),
      blobBytes: blob.size,
      headHex: hex, headAscii: ascii, signatureOk,
      playback,
      hasNavigatorShare: typeof navigator.share === 'function',
      hasNavigatorCanShare: typeof navigator.canShare === 'function',
      canShareFile, shareErr,
    };
  }, CANDIDATES);

  console.log(JSON.stringify({
    userAgent: await page.evaluate(() => navigator.userAgent),
    candidatesFromHtml: CANDIDATES,
    ...out,
    pageErrors: errs,
  }, null, 2));
} finally {
  await browser.close();
}
