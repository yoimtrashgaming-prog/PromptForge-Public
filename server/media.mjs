// ffmpeg and ffprobe, for video and audio references.
//
// H3's Director accepts video and audio references, not only stills, but the
// local tagger reads pixels — so a video reference is described by sampling
// frames out of it and tagging those. That is the whole reason this file
// exists, and it is why it deliberately adds no npm dependency: ffmpeg and
// ffprobe are already on this box, and shelling out to them costs nothing at
// install time on the Linux target either.
//
// **Everything here degrades rather than throws.** ffmpeg missing, a corrupt
// container, a video with no video stream — each returns a result that says
// what went wrong. A reference row is usable by hand the moment it appears;
// the probe only ever fills traits in for you. Losing auto-description is a
// worse prompt, not a broken app.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Long enough for a big container to be parsed, short enough that a wedged
// process cannot hold an upload open. Sampling gets more because it decodes.
const PROBE_TIMEOUT_MS = 15_000;
const SAMPLE_TIMEOUT_MS = 60_000;

/**
 * Run a binary and collect stdout. Never rejects on a non-zero exit — the
 * caller decides whether that is fatal, and every caller here treats it as
 * "no description available" rather than an error.
 */
function run(bin, args, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      // ENOENT lands here on some platforms and on the 'error' event on
      // others, so both paths return the same shape.
      return resolve({ ok: false, code: 'not_installed', stdout: '', stderr: String(err.message) });
    }

    const out = [];
    const err = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, code: 'timeout', stdout: '', stderr: `${bin} took longer than ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      finish({
        ok: false,
        code: e.code === 'ENOENT' ? 'not_installed' : 'spawn_failed',
        stdout: '',
        stderr: String(e.message),
      });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        code: code === 0 ? null : 'exit_nonzero',
        exitCode: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

let availability = null;

/**
 * Whether ffmpeg and ffprobe can actually be run, cached after the first ask.
 *
 * Cached because this is checked on every reference upload and the answer
 * cannot change without restarting the box's PATH. Restart the server after
 * installing ffmpeg — which is the same thing every other tool on this box
 * expects, and is stated in the message the user sees.
 */
export async function mediaTools() {
  if (availability) return availability;
  const [ff, fp] = await Promise.all([
    run('ffmpeg', ['-version'], { timeoutMs: 5000 }),
    run('ffprobe', ['-version'], { timeoutMs: 5000 }),
  ]);
  const version = (r) => (r.stdout.match(/version\s+(\S+)/)?.[1] ?? null);
  availability = {
    available: ff.ok && fp.ok,
    ffmpeg: ff.ok ? version(ff) : null,
    ffprobe: fp.ok ? version(fp) : null,
    reason: ff.ok && fp.ok
      ? null
      : 'ffmpeg and ffprobe are not on PATH. Video and audio references still work — type the traits by hand.',
  };
  return availability;
}

/** Test seam. The suite flips availability without touching PATH. */
export function _setMediaTools(value) {
  availability = value;
}

/**
 * What is actually inside the container.
 *
 * `has_audio` is the load-bearing one: the official reference guide says an
 * ordinary reference video does not create an <Audio N> merely because the
 * file contains sound, so the stream mode is the user's declaration and this
 * only says whether that declaration is *possible*. Offering "audio" on a
 * silent clip would produce a label with nothing behind it.
 */
export async function probeMedia(bytes, { suffix = '' } = {}) {
  const tools = await mediaTools();
  if (!tools.available) return { ok: false, code: 'no_ffmpeg', message: tools.reason };

  const dir = await mkdtemp(path.join(tmpdir(), 'pf-ref-'));
  const file = path.join(dir, `input${suffix}`);
  try {
    await writeFile(file, bytes);
    const res = await run('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    if (!res.ok) {
      return { ok: false, code: 'unreadable', message: 'That file could not be read as media.' };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { ok: false, code: 'unreadable', message: 'That file could not be read as media.' };
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    // Duration lives on the format for most containers and on the stream for
    // some; a file with neither is still usable, it just cannot be sampled at
    // proportional timestamps.
    const duration = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || null;

    return {
      ok: true,
      duration_seconds: duration,
      has_video: Boolean(video),
      has_audio: Boolean(audio),
      width: video?.width ?? null,
      height: video?.height ?? null,
      video_codec: video?.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pull still frames out of a video, as JPEG buffers.
 *
 * Sampled at evenly spaced points *inside* the clip rather than from the
 * start: the first frame of a video is very often black, a fade, or a title
 * card, and tagging that describes the wrong thing entirely. With `count` of
 * 3 and a 12s clip the samples land at 3s, 6s and 9s.
 *
 * A clip whose duration ffprobe could not determine falls back to a single
 * frame from the start — worse, but better than refusing.
 */
/**
 * Re-encode a still image to PNG, for formats the decoder cannot read.
 *
 * jimp ships bmp, gif, jpeg, png and tiff. It has **no webp decoder**, and
 * `config/taggers.yaml` has advertised `image/webp` as an accepted type since
 * Tab 3 was built — so a webp upload passed validation and then died at
 * `Jimp.read` with "Mime type image/webp does not support decoding". Measured
 * 26 Aug 2026 on both `/api/analyze` and `/api/references/analyze`.
 *
 * That is not a small gap in practice. Civitai, danbooru's thumbnails and
 * anything saved out of Chrome are webp by default, which is most of the
 * pictures anyone would reach for when testing whether the tagger recognises
 * a character.
 *
 * ffmpeg is used rather than a fourth npm dependency, for the same reason this
 * file exists at all: it is already required for video references, already on
 * the box, and costs nothing at install time on the Linux target. Only
 * `ffmpeg` is checked, not `ffprobe` — there is no container to probe, and
 * refusing a still because ffprobe is missing would be an unrelated excuse.
 *
 * Degrades like everything else here: no ffmpeg, no conversion, and a message
 * that names what is missing rather than repeating the decoder's error.
 */
export async function transcodeImage(bytes, { suffix = '' } = {}) {
  const tools = await mediaTools();
  if (!tools.ffmpeg) {
    return {
      ok: false,
      code: 'no_ffmpeg',
      message: 'That image format needs ffmpeg to be read, and ffmpeg is not on PATH. PNG and JPEG work without it.',
    };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'pf-img-'));
  const input = path.join(dir, `input${suffix}`);
  const out = path.join(dir, 'out.png');
  try {
    await writeFile(input, bytes);
    // -frames:v 1 matters: an ANIMATED webp is a video stream to ffmpeg, and
    // without this it writes a numbered sequence and out.png never appears.
    // The tagger reads one picture, so the first frame is the whole answer.
    const res = await run('ffmpeg', ['-v', 'error', '-i', input, '-frames:v', '1', '-y', out], {
      timeoutMs: SAMPLE_TIMEOUT_MS,
    });
    if (!res.ok) {
      return { ok: false, code: 'decode_failed', message: 'That image could not be decoded.' };
    }
    const buf = await readFile(out).catch(() => null);
    // ffmpeg exits 0 having written nothing on some malformed inputs, so the
    // length check is what actually rejects them — same trap as sampleFrames.
    if (!buf?.length) {
      return { ok: false, code: 'decode_failed', message: 'That image could not be decoded.' };
    }
    return { ok: true, bytes: buf };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function sampleFrames(bytes, { count = 3, duration = null, suffix = '' } = {}) {
  const tools = await mediaTools();
  if (!tools.available) return { ok: false, code: 'no_ffmpeg', message: tools.reason, frames: [] };

  const dir = await mkdtemp(path.join(tmpdir(), 'pf-frame-'));
  const input = path.join(dir, `input${suffix}`);
  try {
    await writeFile(input, bytes);

    const stamps = duration && duration > 0
      ? Array.from({ length: count }, (_, i) => (duration * (i + 1)) / (count + 1))
      : [0];

    const frames = [];
    for (const [i, at] of stamps.entries()) {
      const out = path.join(dir, `frame-${i}.jpg`);
      // -ss before -i seeks by keyframe, which is fast and accurate enough for
      // a tagger that resizes to 448x448 anyway. -frames:v 1 takes exactly one
      // picture; -q:v 3 is visually clean without writing a large file.
      const res = await run('ffmpeg', [
        '-v', 'error',
        '-ss', String(at.toFixed(3)),
        '-i', input,
        '-frames:v', '1',
        '-q:v', '3',
        '-y',
        out,
      ], { timeoutMs: SAMPLE_TIMEOUT_MS });
      if (!res.ok) continue;
      const buf = await readFile(out).catch(() => null);
      // A seek past the end writes a zero-byte file rather than failing, so
      // the length check is what actually rejects it.
      if (buf?.length) frames.push({ at_seconds: Number(at.toFixed(3)), bytes: buf });
    }

    if (!frames.length) {
      return { ok: false, code: 'no_frames', message: 'No frames could be read from that video.', frames: [] };
    }
    return { ok: true, frames };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
