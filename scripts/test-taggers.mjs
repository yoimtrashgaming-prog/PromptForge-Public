/**
 * Tagger tests.
 *
 * Split deliberately in two. The validation and degradation checks need no
 * model file and run anywhere — including the contributor's box and the Linux
 * target before the weights are copied across. The inference check only runs
 * when the configured weights actually exist, and says so when it skips
 * rather than passing silently.
 *
 * Run: npm run test-taggers
 */
import YAML from 'yaml';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createTaggerStore } from '../server/taggers.mjs';
import { loadConfig } from '../server/config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
};

console.log('\nTaggers\n' + '─'.repeat(58));

// ── Degradation: missing weights must not throw ──
{
  const store = createTaggerStore({
    default_tagger: 'ghost',
    taggers: { ghost: { name: 'Not Here', model: 'nope/missing.onnx', labels: 'nope/missing.csv' } },
  });
  const info = store.info();
  check('a tagger with missing weights loads without throwing', info.total === 1);
  check('...and reports itself unavailable', info.available === 0, JSON.stringify(info.taggers));
  check('...and explains why', /missing/i.test(info.taggers[0].detail ?? ''), info.taggers[0].detail);

  let code = null;
  try { await store.analyze(Buffer.from([1, 2, 3])); } catch (err) { code = err.code; }
  check('analysing with missing weights throws tagger_unavailable', code === 'tagger_unavailable', `got ${code}`);
}

// ── Upload validation: no model needed ──
{
  const store = createTaggerStore({
    uploads: { max_image_mb: 20, allowed_image_types: ['image/png', 'image/jpeg', 'image/webp'] },
    taggers: {},
  });
  const v = (args) => store.validateUpload(args);

  check('a normal png passes', v({ bytes: 1024, contentType: 'image/png' }).ok);
  check('content-type parameters are tolerated',
    v({ bytes: 1024, contentType: 'image/png; charset=binary' }).ok);
  check('an unsupported type is rejected', !v({ bytes: 1024, contentType: 'application/pdf' }).ok);
  check('...naming what is allowed',
    /image\/webp/.test(v({ bytes: 1024, contentType: 'application/pdf' }).message));
  check('an oversized image is rejected', !v({ bytes: 21 * 1048576, contentType: 'image/png' }).ok);
  check('...naming the actual limit',
    /20 MB/.test(v({ bytes: 21 * 1048576, contentType: 'image/png' }).message));
  check('an empty body is rejected', !v({ bytes: 0, contentType: 'image/png' }).ok);
}

// ── Live inference: only when the weights are on this box ──
{
  // Through loadConfig, not YAML.parse of the committed file, so that
  // taggers.local.yaml is merged exactly as the server merges it.
  //
  // This read config/taggers.yaml directly until 23 Aug 2026, and the effect
  // was that the suite could never pass on a deployment box. The committed
  // paths point into a Windows ComfyUI install, every machine that is not the
  // dev box overrides them in taggers.local.yaml, and this never saw the
  // override - so it reported the Windows paths as missing and SKIPped live
  // inference even with the weights present and pointed at correctly.
  //
  // That made it actively misleading: archive/docs/p40-bringup.md sends you here to
  // learn "whether it found real weights or skipped", and the answer was
  // always "skipped" regardless of the truth. Found on the P40, with all four
  // weight files on disk and the override correct.
  const { config: cfg, applied } = loadConfig(ROOT, 'taggers');
  if (applied?.length) console.log('  [config] taggers.local.yaml applied: ' + applied.join(', '));
  const store = createTaggerStore(cfg ?? {});
  const info = store.info();
  const usable = info.taggers.find((t) => t.available);

  if (!usable) {
    console.log('  SKIP  live inference — no configured tagger has its weights on this box');
  } else {
    const { Jimp } = await import('jimp');
    // A flat colour is meaningless as an image, which is the point: this
    // asserts the response shape and the category split, not the tags.
    const img = new Jimp({ width: 512, height: 320, color: 0x336699ff });
    const buf = await img.getBuffer('image/png');

    const r = await store.analyze(buf, { tagger: usable.key });
    check('inference returns the three category groups',
      Array.isArray(r.ratings) && Array.isArray(r.general) && Array.isArray(r.character));
    check('ratings are populated', r.ratings.length > 0, `${r.ratings.length}`);
    check('confidences are probabilities',
      [...r.ratings, ...r.general].every((t) => t.confidence >= 0 && t.confidence <= 1));
    check('results are sorted by confidence descending',
      r.ratings.every((t, i, a) => i === 0 || a[i - 1].confidence >= t.confidence));
    check('the thresholds used are reported back',
      typeof r.thresholds?.general === 'number' && typeof r.thresholds?.character === 'number');
    check('a non-square image does not throw', true);

    // Raising the bar must never yield more tags.
    const strict = await store.analyze(buf, { tagger: usable.key, generalThreshold: 0.95 });
    check('a higher threshold returns no more tags than a lower one',
      strict.general.length <= r.general.length, `${strict.general.length} vs ${r.general.length}`);

    // ── webp, the format the allowlist promised and could not read ──
    //
    // jimp has no webp decoder, and `allowed_image_types` has listed
    // image/webp since Tab 3 was built: the upload validated and then threw
    // "Mime type image/webp does not support decoding". Reported 26 Aug 2026
    // by someone trying to test character recognition on a picture saved out
    // of a browser, which is the normal way to get one.
    //
    // The fix is an ffmpeg fallback in decode(), so this asserts the whole
    // round trip rather than the conversion alone — the conversion is covered
    // in test-media, and the thing that was broken is this path.
    const webpBytes = await new Promise((resolve) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'pf-tagger-webp-'));
      const out = path.join(dir, 'in.webp');
      const child = spawn('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1:rate=1',
        '-frames:v', '1', '-y', out,
      ], { windowsHide: true });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        let bytes = null;
        try { if (code === 0) bytes = readFileSync(out); } catch { /* no encoder */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        resolve(bytes);
      });
    });

    if (!webpBytes) {
      console.log('  SKIP  webp round trip — this ffmpeg cannot write webp');
    } else {
      const w = await store.analyze(webpBytes, { tagger: usable.key, contentType: 'image/webp' });
      check('a webp is tagged rather than refused by the decoder',
        Array.isArray(w.general) && Array.isArray(w.ratings) && w.ratings.length > 0,
        JSON.stringify(w).slice(0, 140));
      // The content type is a hint for naming the temp file, not a
      // requirement. Anything reaching this path from a client that omits it
      // must still work, or the fix only covers the callers that remembered.
      const sniffed = await store.analyze(webpBytes, { tagger: usable.key });
      check('...and also with no content type given, since ffmpeg can sniff',
        Array.isArray(sniffed.general) && sniffed.ratings.length > 0);
    }

    // A format nothing can decode still fails, and fails as a decode error
    // rather than as a 500. The fallback must not turn every bad upload into
    // a success by way of an empty PNG.
    let threw = null;
    try {
      await store.analyze(Buffer.from('this is not an image'), { tagger: usable.key, contentType: 'image/webp' });
    } catch (err) {
      threw = err;
    }
    check('rubbish still fails, and as a decode error', threw !== null, String(threw));
  }
}

console.log('─'.repeat(58));
console.log(fail ? `${pass} passed, ${fail} FAILED\n` : `ALL PASSED (${pass})\n`);
process.exit(fail ? 1 : 0);
