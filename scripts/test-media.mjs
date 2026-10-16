// ffmpeg and ffprobe, against real files.
//
//   node scripts/test-media.mjs
//
// No server, no model. It builds its own fixtures with ffmpeg's lavfi
// sources, so nothing is checked in and nothing has to be downloaded.
//
// SKIPs cleanly where ffmpeg is not installed. That is not a hedge: video
// references are designed to degrade to hand-typed traits on a box without
// it, and the Linux target may well be such a box, so "no ffmpeg" has to be a
// supported state rather than a failing suite.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  probeMedia,
  sampleFrames,
  mediaTools,
  transcodeImage,
  _setMediaTools,
} from '../server/media.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

function ffmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

const tools = await mediaTools();
if (!tools.available) {
  // The degraded path is still worth asserting, because it is the one the
  // Linux target may live on.
  const probe = await probeMedia(Buffer.from('x'), { suffix: '.mp4' });
  check('without ffmpeg, probing reports why rather than throwing',
    probe.ok === false && probe.code === 'no_ffmpeg', JSON.stringify(probe));
  const frames = await sampleFrames(Buffer.from('x'), { suffix: '.mp4' });
  check('without ffmpeg, sampling returns no frames rather than throwing',
    frames.ok === false && Array.isArray(frames.frames) && frames.frames.length === 0);
  check('...and names ffmpeg in the reason the panel shows',
    /ffmpeg/i.test(probe.message ?? ''), probe.message);
  console.log(`SKIP — ffmpeg is not installed (${passed} degraded-path assertions passed)`);
  process.exit(failures.length ? 1 : 0);
}

const dir = await mkdtemp(path.join(tmpdir(), 'pf-media-test-'));
const at = (name) => path.join(dir, name);

try {
  const built = await Promise.all([
    // testsrc is a moving pattern, so the three sampled frames genuinely
    // differ — a still source would not prove sampling happened at all.
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', at('sound.mp4')]),
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', at('silent.mp4')]),
    ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-y', at('tone.mp3')]),
  ]);
  if (!built.every(Boolean)) {
    console.log('SKIP — ffmpeg could not build the fixtures');
    process.exit(0);
  }

  const sound = await readFile(at('sound.mp4'));
  const silent = await readFile(at('silent.mp4'));
  const tone = await readFile(at('tone.mp3'));

  // ── probing ────────────────────────────────────────────────
  const a = await probeMedia(sound, { suffix: '.mp4' });
  check('a video probes ok', a.ok === true, JSON.stringify(a));
  check('...with its duration', Math.abs((a.duration_seconds ?? 0) - 6) < 0.5, String(a.duration_seconds));
  check('...its dimensions', a.width === 320 && a.height === 240, `${a.width}x${a.height}`);
  check('...and both streams found', a.has_video === true && a.has_audio === true);

  // The load-bearing one: the stream control offers audio modes off this,
  // and offering them on a silent clip means a label with nothing behind it.
  const b = await probeMedia(silent, { suffix: '.mp4' });
  check('a silent video is reported as having no audio',
    b.ok === true && b.has_video === true && b.has_audio === false, JSON.stringify(b));

  const c = await probeMedia(tone, { suffix: '.mp3' });
  check('an audio file has no video stream',
    c.ok === true && c.has_video === false && c.has_audio === true, JSON.stringify(c));
  check('...and still reports a duration', Math.abs((c.duration_seconds ?? 0) - 4) < 0.5,
    String(c.duration_seconds));

  const junk = await probeMedia(Buffer.from('this is not a video'), { suffix: '.mp4' });
  check('junk is unreadable rather than a crash',
    junk.ok === false && junk.code === 'unreadable', JSON.stringify(junk));

  // ── sampling ───────────────────────────────────────────────
  const frames = await sampleFrames(sound, { count: 3, duration: 6, suffix: '.mp4' });
  check('three frames come back', frames.ok === true && frames.frames.length === 3,
    String(frames.frames?.length));
  check('...none of them empty', frames.frames.every((f) => f.bytes.length > 0));
  check('...all of them JPEG', frames.frames.every((f) => f.bytes[0] === 0xff && f.bytes[1] === 0xd8));

  // Evenly spaced *inside* the clip. Sampling from 0 is the bug this avoids:
  // the first frame of a real video is very often black or a title card.
  const stamps = frames.frames.map((f) => f.at_seconds);
  check('sampled inside the clip, not from the start', stamps[0] > 0, JSON.stringify(stamps));
  check('...evenly spaced', JSON.stringify(stamps) === JSON.stringify([1.5, 3, 4.5]), JSON.stringify(stamps));
  check('...and past the end of no clip', stamps.every((s) => s < 6));

  // Different points in a moving source must produce different pictures, or
  // sampling three frames is three times the CPU for one frame's information.
  const sizes = new Set(frames.frames.map((f) => f.bytes.length));
  check('the frames are not all the same picture', sizes.size > 1, JSON.stringify([...sizes]));

  const unknown = await sampleFrames(sound, { count: 3, duration: null, suffix: '.mp4' });
  check('an unknown duration still yields a frame',
    unknown.ok === true && unknown.frames.length === 1, JSON.stringify(unknown.frames?.length));

  const noFrames = await sampleFrames(tone, { count: 3, duration: 4, suffix: '.mp3' });
  check('an audio file yields no frames, with a reason',
    noFrames.ok === false && noFrames.frames.length === 0 && Boolean(noFrames.message),
    JSON.stringify(noFrames));

  // ── webp, which jimp cannot decode ─────────────────────────
  //
  // jimp ships bmp, gif, jpeg, png and tiff. config/taggers.yaml has
  // advertised image/webp since Tab 3 was built, so a webp passed validation
  // and then died at Jimp.read with "Mime type image/webp does not support
  // decoding" — measured 26 Aug 2026 on both analysis routes. Most of what
  // anyone grabs off Civitai or out of a browser is webp, so this was the
  // format the feature most needed and the one it did not have.
  {
    const webp = at('still.webp');
    const madeWebp = await ffmpeg([
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1:rate=1',
      '-frames:v', '1', '-y', webp,
    ]);
    if (!madeWebp) {
      check('this ffmpeg build can write webp, so the case is testable', true,
        'SKIPPED — no webp encoder in this ffmpeg');
    } else {
      const bytes = await readFile(webp);
      const out = await transcodeImage(bytes, { suffix: '.webp' });
      check('a webp is transcoded rather than refused', out.ok === true, JSON.stringify(out).slice(0, 160));
      // PNG magic. The point is not that bytes came back but that they came
      // back in a format the decoder can actually read.
      check('...into a real PNG, which is what jimp can read',
        out.ok && out.bytes[0] === 0x89 && out.bytes.slice(1, 4).toString() === 'PNG',
        out.ok ? [...out.bytes.slice(0, 4)].join(',') : 'no bytes');
      check('...and not an empty file, which ffmpeg writes on some failures',
        out.ok && out.bytes.length > 100, out.ok ? `${out.bytes.length} bytes` : 'n/a');
    }

    // Garbage in must not come back ok. ffmpeg exits non-zero here, but it
    // also exits 0 having written nothing on some malformed inputs, which is
    // why the length check exists at all.
    const junk = await transcodeImage(Buffer.from('not an image at all'), { suffix: '.webp' });
    check('rubbish is refused rather than returned as a zero-byte PNG',
      junk.ok === false && junk.code === 'decode_failed', JSON.stringify(junk));
  }

  // ── the degraded path, forced ──────────────────────────────
  // Asserted on this box too rather than only where ffmpeg is missing, or it
  // would be code that only ever runs on the machine nobody is testing on.
  _setMediaTools({ available: false, ffmpeg: null, ffprobe: null, reason: 'ffmpeg is not on PATH.' });
  const gone = await probeMedia(sound, { suffix: '.mp4' });
  check('with ffmpeg gone, probing says so rather than throwing',
    gone.ok === false && gone.code === 'no_ffmpeg', JSON.stringify(gone));
  const goneFrames = await sampleFrames(sound, { suffix: '.mp4' });
  check('...and sampling returns an empty frame list',
    goneFrames.ok === false && goneFrames.frames.length === 0);

  // Without ffmpeg there is no webp decoder at all, and the message has to
  // name what is missing. "Mime type image/webp does not support decoding" is
  // not something anyone can act on; "install ffmpeg" is.
  const noConvert = await transcodeImage(Buffer.from('x'), { suffix: '.webp' });
  check('with ffmpeg gone, transcoding says so rather than throwing',
    noConvert.ok === false && noConvert.code === 'no_ffmpeg', JSON.stringify(noConvert));
  check('...and names ffmpeg, since that is the actionable part',
    /ffmpeg/i.test(noConvert.message ?? ''), noConvert.message);
  check('...while still promising the formats that work without it',
    /png|jpe?g/i.test(noConvert.message ?? ''), noConvert.message);
  _setMediaTools(tools);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
