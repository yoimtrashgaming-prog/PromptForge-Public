/**
 * The shared image library: /api/shared-images end to end.
 *
 * The library is a folder of `<name>.png` + `<name>.txt` pairs that five
 * people write into over a tailnet, which puts three things under test that
 * nothing else in this project covers:
 *
 *   1. **Names become filenames.** A person types "Rin's Blue Coat!" and a
 *      file has to come out of it that is safe on Linux, lowercase, and
 *      cannot address anything outside the folder.
 *   2. **The pair is a pair.** An upload writes both files or the entry is
 *      wrong, and the directory — not index.json — is what decides the
 *      listing, so a pair dropped in over SSH must appear.
 *   3. **Who may remove what.** Deleting is the author or the owner; editing
 *      the prompt text deliberately is not restricted, and a test is the only
 *      place that difference is written down as intent rather than accident.
 *
 * Needs no Ollama, no model, no GPU — the server runs on the mock backend.
 *
 * Run: npm run test-shared-images
 */
import { freePort } from './lib/freeport.mjs';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import YAML from 'yaml';

const APP_PORT = await freePort(8096);
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pf-shared-data-'));
const BASE = `http://127.0.0.1:${APP_PORT}`;
const SHARED_DIR = path.join(DATA_DIR, 'shared-images');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); if (detail) console.log(`        ${detail}`); }
};

const serverConfig = YAML.parse(readFileSync('config/server.yaml', 'utf8'));
const OWNER = serverConfig.owner_username;
if (!OWNER) throw new Error('config/server.yaml has no owner_username — cannot test the delete gate');

const userA = `testrunner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const userB = `testrunner_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/**
 * A real PNG, built here rather than committed as a fixture.
 *
 * It has to be a genuine file: the route reads the data URI's media type and
 * the module picks the extension from it, so a base64 blob that is not a PNG
 * would pass every case here and fail the moment a browser tried to show it.
 */
const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/**
 * A ComfyUI graph in a PNG, the way SaveImage writes one: a `tEXt` chunk
 * keyed `prompt`, holding the API-form graph as JSON, before the pixels.
 *
 * The JSON is assembled as a string rather than stringified from an object,
 * because one of the cases below turns on a seed literal that no JavaScript
 * number can hold — round-tripping it through an object would destroy the
 * very thing under test before the file was ever written.
 */
function pngWithGraph(json) {
  const base = png();
  const text = Buffer.concat([Buffer.from('prompt'), Buffer.from([0]), Buffer.from(json, 'utf8')]);
  // After the 8-byte signature and the 25-byte IHDR chunk, which is where
  // ComfyUI puts it and where a reader expects to find it.
  const at = 8 + 25;
  return Buffer.concat([base.subarray(0, at), chunk('tEXt', text), base.subarray(at)]);
}

function png(w = 8, h = 8, rgb = [40, 120, 220]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = png();
const DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`;

async function api(method, route, { user, body, raw } = {}) {
  const headers = {};
  if (user) headers['x-promptforge-user'] = user;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, res };
  let parsed = null;
  try { parsed = await res.json(); } catch { /* a streamed file has no JSON */ }
  return { status: res.status, body: parsed };
}

const app = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_LLM_BACKEND: 'mock',
    PROMPTFORGE_AUTH: 'off',
    PROMPTFORGE_SEARCH: 'off',
    PROMPTFORGE_DATA_DIR: DATA_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let booted = false;
app.stdout.on('data', (d) => {
  if (/listening on/i.test(String(d))) booted = true;
});

for (let i = 0; i < 100 && !booted; i++) await new Promise((r) => setTimeout(r, 100));
if (!booted) {
  console.error('server did not start — did PROMPTFORGE_PORT take effect?');
  app.kill();
  process.exit(1);
}

console.log('\nShared image library\n' + '─'.repeat(58));

try {
  // ── 1. the data directory override actually moved this store ──
  //
  // The failure this guards against is on record: PROMPTFORGE_DATA_DIR used
  // to rewrite paths.data while every path under it was named separately, so
  // a test suite wrote into the live directory. A new store added to
  // config/server.yaml inherits that trap unless the rebase is generic.
  console.log('\nwhere it writes');
  {
    const { status, body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'first upload', text: 'a prompt', image: DATA_URI } });
    check('an upload is accepted', status === 201, `${status} ${JSON.stringify(body)}`);
    check('...into the throwaway data directory, not the real one',
      existsSync(path.join(SHARED_DIR, 'first-upload.png')),
      readdirSync(DATA_DIR).join(' '));
    check('...and never into the repo',
      !existsSync(path.join(process.cwd(), 'data', 'shared-images', 'first-upload.png')));
  }

  // ── 2. a typed name becomes a filename ──
  console.log('\nnames become filenames');
  {
    const { body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: "Rin's Blue Coat!", text: '1girl, blue coat', image: DATA_URI } });
    check('punctuation and case are flattened', body?.name === 'rins-blue-coat', body?.name);
    check('...and the pair is written as a pair',
      existsSync(path.join(SHARED_DIR, 'rins-blue-coat.png')) &&
      existsSync(path.join(SHARED_DIR, 'rins-blue-coat.txt')));
    check('...with the prompt in the .txt, verbatim',
      readFileSync(path.join(SHARED_DIR, 'rins-blue-coat.txt'), 'utf8') === '1girl, blue coat');

    const second = await api('POST', '/api/shared-images',
      { user: userB, body: { name: 'rins blue coat', image: DATA_URI } });
    check('a colliding name is suffixed rather than refused',
      second.body?.name === 'rins-blue-coat-2', second.body?.name);

    const noText = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'no prompt here', image: DATA_URI } });
    check('a picture with no prompt is still a valid entry', noText.status === 201, noText.body?.message);
    check('...and still gets a .txt beside it, so the folder is a dataset',
      existsSync(path.join(SHARED_DIR, 'no-prompt-here.txt')));

    const unusable = await api('POST', '/api/shared-images',
      { user: userA, body: { name: '!!!', image: DATA_URI } });
    check('a name with nothing usable in it is refused', unusable.status === 400, String(unusable.status));

    const noImage = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'just words', text: 'hello' } });
    check('an entry with no picture is refused', noImage.status === 400, String(noImage.status));

    const notAnImage = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'sneaky', image: 'data:text/html;base64,PHNjcmlwdD4=' } });
    check('a data URI that is not an accepted image is refused',
      notAnImage.status === 415, String(notAnImage.status));
  }

  // ── 3. the directory is the truth, not index.json ──
  //
  // The whole reason for two files on disk instead of one record: a pair
  // copied in over SSH has no index entry and must still appear, credited to
  // nobody rather than hidden.
  console.log('\na pair dropped in by hand');
  {
    writeFileSync(path.join(SHARED_DIR, 'by-hand.png'), PNG);
    writeFileSync(path.join(SHARED_DIR, 'by-hand.txt'), 'scenery, no humans', 'utf8');
    const { body } = await api('GET', '/api/shared-images', { user: userA });
    const found = body?.entries?.find((e) => e.name === 'by-hand');
    check('it is listed without ever going through the upload', Boolean(found),
      body?.entries?.map((e) => e.name).join(' '));
    check('...with its prompt read off the .txt', found?.text === 'scenery, no humans', found?.text);
    check('...and no author claimed for it', found?.author === null, String(found?.author));

    writeFileSync(path.join(SHARED_DIR, 'orphan.txt'), 'notes with no picture', 'utf8');
    const after = await api('GET', '/api/shared-images', { user: userA });
    check('a .txt with no picture is not an entry',
      !after.body?.entries?.some((e) => e.name === 'orphan'),
      after.body?.entries?.map((e) => e.name).join(' '));
  }

  // ── 4. the picture comes back as a picture ──
  console.log('\nserving the file');
  {
    const { status, res } = await api('GET', '/api/shared-images/rins-blue-coat/file',
      { user: userB, raw: true });
    const bytes = Buffer.from(await res.arrayBuffer());
    check('the image streams back', status === 200, String(status));
    check('...with the right content type', res.headers.get('content-type') === 'image/png',
      String(res.headers.get('content-type')));
    check('...byte for byte', bytes.equals(PNG), `${bytes.length} vs ${PNG.length}`);
  }

  // ── 5. a name in a URL cannot address anything else ──
  //
  // The name is validated against a shape before it is ever joined to a path,
  // which is the same argument server/storage.mjs makes for entry ids: the
  // property is asserted where the filename is built, not left to depend on
  // how some future route happens to decode its input.
  console.log('\nnames that try to leave the folder');
  {
    for (const bad of [
      '..%2F..%2Fconfig%2Fserver.yaml',
      '../../package.json',
      '..',
      'rins-blue-coat.png',
      'Rins-Blue-Coat',
    ]) {
      const { status } = await api('GET', `/api/shared-images/${bad}/file`, { user: userA, raw: true });
      check(`${bad} is not served`, status === 404, String(status));
    }
    check('and config/server.yaml is still where it was',
      existsSync(path.join(process.cwd(), 'config', 'server.yaml')));
  }

  // ── 6. what somebody pinned is theirs ──
  //
  // Editing was open to everyone when this shipped, on the reasoning that a
  // shared prompt is a wiki entry. The owner reversed that on 20 Sep 2026:
  // "I don't want everyone to be able to edit each others prompts unless it's
  // in the brief." Both halves of that are asserted here — the board is
  // locked, and taking a copy into your own brief is untouched by it.
  console.log('\nwho may change what');
  {
    const stranger = await api('PATCH', '/api/shared-images/rins-blue-coat',
      { user: userB, body: { text: 'fixed by somebody else' } });
    check('somebody else may not rewrite the prompt', stranger.status === 403,
      `${stranger.status} ${JSON.stringify(stranger.body)}`);
    check('...and the prompt on disk is untouched',
      readFileSync(path.join(SHARED_DIR, 'rins-blue-coat.txt'), 'utf8') === '1girl, blue coat',
      readFileSync(path.join(SHARED_DIR, 'rins-blue-coat.txt'), 'utf8'));

    const edited = await api('PATCH', '/api/shared-images/rins-blue-coat',
      { user: userA, body: { text: 'fixed by its author' } });
    check('the person who put it up may', edited.status === 200,
      `${edited.status} ${JSON.stringify(edited.body)}`);
    check('...and it lands on disk',
      readFileSync(path.join(SHARED_DIR, 'rins-blue-coat.txt'), 'utf8') === 'fixed by its author');
    check('...without changing who uploaded it', edited.body?.author === userA, String(edited.body?.author));

    const ownerEdit = await api('PATCH', '/api/shared-images/rins-blue-coat',
      { user: OWNER, body: { text: 'fixed by its author' } });
    check('...and so may the owner', ownerEdit.status === 200, String(ownerEdit.status));

    const handEdit = await api('PATCH', '/api/shared-images/by-hand',
      { user: userB, body: { text: 'nope' } });
    check('a pair with no author is not editable by just anyone', handEdit.status === 403,
      String(handEdit.status));

    // The half the browser uses to decide what to even offer. The server
    // refuses regardless — this only stops the UI showing a Save that bounces.
    const listed = await api('GET', '/api/shared-images', { user: userA });
    const own = listed.body?.entries?.find((e) => e.name === 'rins-blue-coat');
    const theirs = listed.body?.entries?.find((e) => e.name === 'rins-blue-coat-2');
    check('the listing says which rows you may change',
      own?.can_edit === true && theirs?.can_edit === false,
      `${own?.can_edit} / ${theirs?.can_edit}`);

    const strangerDelete = await api('DELETE', '/api/shared-images/rins-blue-coat', { user: userB });
    check('somebody else may not remove it', strangerDelete.status === 403,
      String(strangerDelete.status));

    const byHand = await api('DELETE', '/api/shared-images/by-hand', { user: userB });
    check('a pair with no author is not deletable by just anyone', byHand.status === 403,
      String(byHand.status));
    const byOwner = await api('DELETE', '/api/shared-images/by-hand', { user: OWNER });
    check('...but the owner can clear it up', byOwner.status === 200, String(byOwner.status));

    const author = await api('DELETE', '/api/shared-images/rins-blue-coat', { user: userA });
    check('the person who uploaded it may remove it', author.status === 200, String(author.status));
    check('...taking both halves of the pair with it',
      !existsSync(path.join(SHARED_DIR, 'rins-blue-coat.png')) &&
      !existsSync(path.join(SHARED_DIR, 'rins-blue-coat.txt')));

    const gone = await api('GET', '/api/shared-images/rins-blue-coat', { user: userA });
    check('...and it is gone from the listing', gone.status === 404, String(gone.status));
  }

  // ── 6a. two prompts, and the one worth reusing ──
  //
  // A user, 20 Sep 2026: "I have the prompt I gave to qwen, and the prompt
  // that generated the pic." Both are worth keeping, and the brief is the one
  // somebody else can adapt — taking a finished prompt and changing the
  // character means hand-editing every tag.
  console.log('\nthe brief as well as the prompt');
  {
    const { body } = await api('POST', '/api/shared-images', {
      user: userA,
      body: {
        name: 'two prompts',
        image: DATA_URI,
        text: 'masterpiece, 1girl, blue coat, snow',
        brief: 'a girl in a blue military coat, standing in snow',
      },
    });
    check('both are kept', body?.text === 'masterpiece, 1girl, blue coat, snow' &&
      body?.brief === 'a girl in a blue military coat, standing in snow',
      JSON.stringify({ text: body?.text, brief: body?.brief }));

    // The finished prompt stays in `<name>.txt` and nothing else does, which
    // is what keeps the folder usable as a caption dataset.
    check('...with the FINISHED prompt in the .txt, alone',
      readFileSync(path.join(SHARED_DIR, 'two-prompts.txt'), 'utf8') ===
        'masterpiece, 1girl, blue coat, snow',
      readFileSync(path.join(SHARED_DIR, 'two-prompts.txt'), 'utf8'));
    check('...and the brief in its own file beside it',
      readFileSync(path.join(SHARED_DIR, 'two-prompts.brief.txt'), 'utf8') ===
        'a girl in a blue military coat, standing in snow');

    const listed = await api('GET', '/api/shared-images', { user: userB });
    check('...both in the listing, so the tab can offer the choice',
      listed.body?.entries?.find((e) => e.name === 'two-prompts')?.brief?.startsWith('a girl'),
      JSON.stringify(listed.body?.entries?.find((e) => e.name === 'two-prompts')?.brief));

    const edited = await api('PATCH', '/api/shared-images/two-prompts',
      { user: userA, body: { text: 'kept', brief: 'reworded brief' } });
    check('the author can rewrite either', edited.body?.brief === 'reworded brief',
      String(edited.body?.brief));

    // A pin from before this existed has no .brief.txt at all — the file is
    // deleted here to make that exact state — and reading one that is not
    // there must be an empty string rather than a throw.
    await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'older pin', image: DATA_URI, text: 'just a prompt' } });
    rmSync(path.join(SHARED_DIR, 'older-pin.brief.txt'), { force: true });
    const older = await api('GET', '/api/shared-images/older-pin', { user: userB });
    check('a pin with no brief file at all reads as empty rather than failing',
      older.status === 200 && older.body?.brief === '',
      `${older.status} ${JSON.stringify(older.body?.brief)}`);

    await api('DELETE', '/api/shared-images/two-prompts', { user: userA });
    check('removing the pin takes the brief file with it',
      !existsSync(path.join(SHARED_DIR, 'two-prompts.brief.txt')));
  }

  // ── 6b. which model made it ──
  //
  // Validated against the registry rather than a list written in the route,
  // for the reason CLAUDE.md gives: adding a model is meant to be one
  // registry entry and one prompt file. Image models only — the board holds
  // pictures, and h3 does not answer "which model made this".
  console.log('\nwhich model made it');
  {
    const withModel = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'model tagged', image: DATA_URI, model: 'illustrious' } });
    check('a registry image model is kept', withModel.body?.model === 'illustrious',
      String(withModel.body?.model));

    const video = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'video tagged', image: DATA_URI, model: 'h3' } });
    check('a video model is not offered and not kept', video.body?.model === null,
      String(video.body?.model));

    const nonsense = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'nonsense tagged', image: DATA_URI, model: 'not-a-model' } });
    check('an unknown key is dropped rather than bouncing the upload',
      nonsense.status === 201 && nonsense.body?.model === null,
      `${nonsense.status} ${nonsense.body?.model}`);

    const changed = await api('PATCH', '/api/shared-images/model-tagged',
      { user: userA, body: { text: '', model: 'krea2' } });
    check('the author can change it later', changed.body?.model === 'krea2', String(changed.body?.model));

    const listed = await api('GET', '/api/shared-images', { user: userA });
    check('...and the listing carries it',
      listed.body?.entries?.find((e) => e.name === 'model-tagged')?.model === 'krea2');
  }

  // ── 6c. where the weights live, pasted in by hand ──
  //
  // A name is where the trail goes cold: Civitai resolves a file by SHA256
  // and ComfyUI records no hashes, so nothing automatic can say which model a
  // picture used. Somebody types it once and everyone gets it, keyed on the
  // weight rather than on the pin — see server/weightlinks.mjs.
  console.log('\nlinks to the weights');
  {
    const set = await api('PUT', '/api/weight-links/image-gen%2FDetail_v5.safetensors',
      { user: userA, body: { url: 'https://civitai.com/models/1234' } });
    check('a link can be added by hand', set.status === 200, JSON.stringify(set.body));
    check('...filed under the bare name, without folder or extension',
      set.body?.key === 'detail_v5', String(set.body?.key));

    const listed = await api('GET', '/api/weight-links', { user: userB });
    check('...and everyone sees it',
      listed.body?.links?.detail_v5?.url === 'https://civitai.com/models/1234',
      JSON.stringify(listed.body?.links));

    // The same weight as another person's folder layout spells it.
    const other = await api('GET', '/api/weight-links', { user: userB });
    check('...so a different folder layout finds the same link',
      Boolean(other.body?.links?.detail_v5), JSON.stringify(Object.keys(other.body?.links ?? {})));

    const stranger = await api('PUT', '/api/weight-links/Detail_v5.safetensors',
      { user: userB, body: { url: 'https://example.com/hijack' } });
    check('somebody else may not repoint it', stranger.status === 403, String(stranger.status));

    const owner = await api('PUT', '/api/weight-links/Detail_v5.safetensors',
      { user: OWNER, body: { url: 'https://civitai.com/models/5678' } });
    check('...but the owner may', owner.status === 200, String(owner.status));

    const fresh = await api('PUT', '/api/weight-links/SomethingElse.safetensors',
      { user: userB, body: { url: 'https://civitai.com/models/9' } });
    check('anyone may add one nobody has claimed', fresh.status === 200, String(fresh.status));

    // The one that matters. This value goes into an href that four other
    // people click, and it is the only place in this app where one person's
    // text becomes another person's link.
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'not a url at all',
    ]) {
      const res = await api('PUT', '/api/weight-links/Nasty.safetensors',
        { user: userA, body: { url: bad } });
      check(`${bad.slice(0, 28)} is refused`, res.status === 400, String(res.status));
    }
    const after = await api('GET', '/api/weight-links', { user: userA });
    check('...and none of them was stored', !after.body?.links?.nasty,
      JSON.stringify(after.body?.links?.nasty));

    const gone = await api('DELETE', '/api/weight-links/SomethingElse.safetensors', { user: userA });
    check('somebody else may not remove it', gone.status === 403, String(gone.status));
    const removed = await api('DELETE', '/api/weight-links/SomethingElse.safetensors', { user: userB });
    check('...the person who added it may', removed.status === 200, String(removed.status));
  }

  // ── 7. the settings ComfyUI left in the file ──
  //
  // The point of this half: somebody pins a picture they made, and the next
  // person gets the seed and the sampler settings without anyone retyping
  // them. Parsed once at upload and remembered, so the grid stays cheap.
  console.log('\nwhat ComfyUI wrote inside the PNG');
  {
    const graph = JSON.stringify({
      '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'TrashGatcha3Dv2.safetensors' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl, blue coat' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, bad anatomy' } },
      '8': {
        class_type: 'KSampler',
        inputs: {
          seed: 789106437980024, steps: 20, cfg: 9,
          sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 0.35,
          model: ['29', 0],
          // Which of the two text nodes is the positive one is decided HERE
          // and nowhere else — both are the same class, and the negative is
          // negative only because of where its wire goes.
          positive: ['6', 0],
          negative: ['7', 0],
        },
      },
      '11': {
        class_type: 'UltimateSDUpscale',
        inputs: { seed: 209530387217408, steps: 20, cfg: 7, denoise: 0.2, image: ['8', 0] },
      },
      '29': {
        class_type: 'LoraLoader',
        inputs: { lora_name: 'image-gen\\AddMicroDetails_Illustrious_v5.safetensors', strength_model: 0.35, strength_clip: 0.6, model: ['2', 0] },
      },
      '30': { class_type: 'SaveImage', inputs: { images: ['11', 0] } },
    });
    const uri = `data:image/png;base64,${pngWithGraph(graph).toString('base64')}`;
    const { body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'from comfy', text: 'a prompt', image: uri } });

    check('the seed is read off the upload', String(body?.comfy?.seed) === '789106437980024',
      JSON.stringify(body?.comfy?.seed));
    check('...with the KSampler settings beside it',
      body?.comfy?.settings?.steps === 20 && body.comfy.settings.cfg === 9 &&
      body.comfy.settings.sampler_name === 'dpmpp_2m' && body.comfy.settings.scheduler === 'karras',
      JSON.stringify(body?.comfy?.settings));
    check('...the checkpoint', body?.comfy?.checkpoints?.[0] === 'TrashGatcha3Dv2.safetensors',
      JSON.stringify(body?.comfy?.checkpoints));
    check('...the LoRA and its strengths, with the Windows path normalised',
      body?.comfy?.loras?.[0]?.name === 'image-gen/AddMicroDetails_Illustrious_v5.safetensors' &&
      body.comfy.loras[0].model === 0.35 && body.comfy.loras[0].clip === 0.6,
      JSON.stringify(body?.comfy?.loras));

    // The ordering case. Both nodes sample, and the base pass is the seed
    // anybody means — but it is the one FURTHER from SaveImage, so a reader
    // that took the first node it found would report the upscale's.
    check('the base pass is reported before the upscale that consumes it',
      body?.comfy?.samplers?.[0]?.type === 'KSampler' &&
      body.comfy.samplers[1]?.type === 'UltimateSDUpscale',
      (body?.comfy?.samplers ?? []).map((s) => s.type).join(' → '));

    check('the positive prompt is read off the wire to the sampler',
      body?.comfy?.prompt === 'masterpiece, 1girl, blue coat', String(body?.comfy?.prompt));
    check('...and the negative from the other input, not from the node class',
      body?.comfy?.negative === 'worst quality, bad anatomy', String(body?.comfy?.negative));

    const listed = await api('GET', '/api/shared-images', { user: userA });
    const row = listed.body?.entries?.find((e) => e.name === 'from-comfy');
    check('the listing says there are settings without carrying the graph',
      row?.has_comfy === true && !('comfy' in (row ?? {})), JSON.stringify(row));

    // What the upload form calls when you pick a file, so it can fill itself
    // in the way Civitai's does. Reads and stores nothing.
    const before = (await api('GET', '/api/shared-images', { user: userA })).body?.entries?.length;
    const peek = await api('POST', '/api/shared-images/inspect', { user: userB, body: { image: uri } });
    const after = (await api('GET', '/api/shared-images', { user: userA })).body?.entries?.length;
    check('inspect reads a file without storing it',
      peek.status === 200 && peek.body?.comfy?.prompt === 'masterpiece, 1girl, blue coat' &&
      before === after, `${peek.status} ${before} vs ${after}`);

    const peekPlain = await api('POST', '/api/shared-images/inspect',
      { user: userB, body: { image: DATA_URI } });
    check('...and answers 200 with nothing for a picture that has none',
      peekPlain.status === 200 && peekPlain.body?.comfy === null,
      `${peekPlain.status} ${JSON.stringify(peekPlain.body?.comfy)}`);
  }

  // The shapes real workflows are actually built in. Every case here comes
  // from a graph on this project's own boxes, not from imagination: the
  // owner's pinned picture reported a seed and a checkpoint and nothing else,
  // and each assertion below is one reason why.
  console.log('\nworkflows that do not look like the manual');
  {
    // 1. The seed is a LINK to an rgthree Seed node, not a number on the
    //    sampler. Detection used to require a literal seed, so it picked the
    //    Seed node — which has no steps, no cfg and no conditioning.
    // 2. The LoRAs are stacked inside ONE rgthree node as objects, with
    //    per-LoRA enable switches, instead of one node per LoRA.
    // 3. One of them is switched off and did not make the picture.
    const graph = JSON.stringify({
      '260': { class_type: 'Seed (rgthree)', inputs: { seed: 465708246482365 } },
      '467': {
        class_type: 'Power Lora Loader (rgthree)',
        inputs: {
          lora_1: { on: true, lora: 'image-gen\\Detail.safetensors', strength: 0.8 },
          lora_2: { on: true, lora: 'Style.safetensors', strength: 1, strengthTwo: 0.5 },
          lora_3: { on: false, lora: 'SwitchedOff.safetensors', strength: 1 },
        },
      },
      '276': { class_type: 'CLIPTextEncode', inputs: { text: 'a lotus, night' } },
      '275': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality' } },
      '261': {
        class_type: 'KSampler',
        inputs: {
          seed: ['260', 0], steps: 30, cfg: 3.5, sampler_name: 'euler_ancestral',
          scheduler: 'normal', denoise: 1, model: ['467', 0],
          positive: ['276', 0], negative: ['275', 0],
        },
      },
      '999': { class_type: 'SaveImage', inputs: { images: ['261', 0] } },
    });
    const uri = `data:image/png;base64,${pngWithGraph(graph).toString('base64')}`;
    const { body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'wired seed', image: uri } });

    check('a seed wired in from a seed node is followed to its number',
      String(body?.comfy?.seed) === '465708246482365', String(body?.comfy?.seed));
    check('...and the sampler is still the sampler, with all its settings',
      body?.comfy?.settings?.steps === 30 && body.comfy.settings.cfg === 3.5 &&
      body.comfy.settings.sampler_name === 'euler_ancestral',
      JSON.stringify(body?.comfy?.settings));
    check('...so the seed node is not mistaken for one',
      body?.comfy?.samplers?.length === 1 && body.comfy.samplers[0].type === 'KSampler',
      (body?.comfy?.samplers ?? []).map((s) => s.type).join(', '));
    check('...and the prompt is found through it',
      body?.comfy?.prompt === 'a lotus, night', String(body?.comfy?.prompt));

    const names = (body?.comfy?.loras ?? []).map((l) => l.name);
    check('LoRAs stacked inside one node are all read',
      names.length === 2 && names[0] === 'image-gen/Detail.safetensors' &&
      names[1] === 'Style.safetensors', JSON.stringify(names));
    check('...with a separate clip strength where one was set, and mirrored where not',
      body.comfy.loras[0].clip === 0.8 && body.comfy.loras[1].clip === 0.5,
      JSON.stringify(body.comfy.loras));
    check('...and one switched off is not reported as used',
      !names.some((n) => n.includes('SwitchedOff')), JSON.stringify(names));
  }

  // A prompt the file does not actually hold. Concatenation and wildcard
  // nodes record their INPUTS, never what they produced, so the finished
  // string is genuinely not in there — and saying so beats pasting template
  // syntax into somebody's brief two clicks later.
  console.log('\na prompt assembled at run time');
  {
    const graph = JSON.stringify({
      '442': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'best quality, score_9' } },
      '437': { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: '{neon|dusk}' } },
      '438': {
        class_type: 'StringConcatenate',
        inputs: { string_a: ['442', 0], string_b: ['437', 0], delimiter: ', ' },
      },
      '276': { class_type: 'CLIPTextEncode', inputs: { text: ['438', 0] } },
      '261': {
        class_type: 'KSampler',
        inputs: { seed: 1, steps: 30, cfg: 3.5, sampler_name: 'euler', positive: ['276', 0] },
      },
      '999': { class_type: 'SaveImage', inputs: { images: ['261', 0] } },
    });
    const uri = `data:image/png;base64,${pngWithGraph(graph).toString('base64')}`;
    const { body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'runtime prompt', image: uri } });

    check('the fragments that ARE in the file are collected',
      (body?.comfy?.prompt ?? '').includes('best quality, score_9'), String(body?.comfy?.prompt));
    check('...and flagged as partial, so nothing auto-fills from it',
      body?.comfy?.prompt_partial === true, String(body?.comfy?.prompt_partial));
    check('...without the node settings getting in among the words',
      !(body?.comfy?.prompt ?? '').includes(', ,') &&
      !/\bfalse\b/.test(body?.comfy?.prompt ?? ''), String(body?.comfy?.prompt));
  }

  // A CLIPTextEncode's `clip` input leads to the checkpoint loader, whose
  // `ckpt_name` is a string like any other. Without a rule against following
  // that wire, the negative prompt came back ending in the checkpoint's
  // filename — seen on screen before this test existed.
  console.log('\nweight filenames are not prompt words');
  {
    const graph = JSON.stringify({
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'TrashGatcha3Dv2.safetensors' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a lotus', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['4', 1] } },
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: 1, steps: 20, cfg: 7, sampler_name: 'euler',
          model: ['4', 0], positive: ['6', 0], negative: ['7', 0],
        },
      },
      '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    });
    const uri = `data:image/png;base64,${pngWithGraph(graph).toString('base64')}`;
    const { body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'clip wire', image: uri } });

    check('the positive is only the words', body?.comfy?.prompt === 'a lotus',
      String(body?.comfy?.prompt));
    check('...and the negative does not pick up the checkpoint filename',
      body?.comfy?.negative === 'worst quality', String(body?.comfy?.negative));
    check('...while the checkpoint is still reported as a resource',
      body?.comfy?.checkpoints?.[0] === 'TrashGatcha3Dv2.safetensors',
      JSON.stringify(body?.comfy?.checkpoints));
  }

  // A seed too long for a double. ComfyUI's widgets go to 2^64-1 and
  // JSON.parse silently rounds anything past 2^53-1, which would hand
  // somebody a seed that looks right and reproduces nothing.
  console.log('\na seed no double can hold');
  {
    const graph =
      '{"1":{"class_type":"KSampler","inputs":{"seed":18446744073709551615,"steps":30,"cfg":5}},' +
      '"2":{"class_type":"SaveImage","inputs":{"images":["1",0]}}}';
    const uri = `data:image/png;base64,${pngWithGraph(graph).toString('base64')}`;
    const { body } = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'big seed', image: uri } });
    check('it survives as exact digits', String(body?.comfy?.seed) === '18446744073709551615',
      String(body?.comfy?.seed));
    check('...which a naive parse would not have',
      String(JSON.parse(graph)['1'].inputs.seed) !== '18446744073709551615');
  }

  // Most pictures are not ComfyUI outputs, and saying nothing is the right
  // answer rather than an error or an empty settings block.
  console.log('\npictures with nothing in them');
  {
    const plain = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'just a picture', image: DATA_URI } });
    check('a plain PNG reports no settings', plain.body?.comfy === null,
      JSON.stringify(plain.body?.comfy));

    const notGraph = `data:image/png;base64,${pngWithGraph('not json at all').toString('base64')}`;
    const broken = await api('POST', '/api/shared-images',
      { user: userA, body: { name: 'broken graph', image: notGraph } });
    check('an unparseable graph is not half-reported', broken.status === 201 &&
      broken.body?.comfy === null, `${broken.status} ${JSON.stringify(broken.body?.comfy)}`);
  }

  // The other way a picture arrives. A pair copied into the folder has no
  // index row, so nothing has parsed it — the settings have to be read on
  // demand and remembered, or a hand-dropped file would be the one kind that
  // never shows what is inside it.
  console.log('\na ComfyUI picture dropped in by hand');
  {
    const graph = JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { seed: 4242, steps: 12, cfg: 4.5 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    });
    writeFileSync(path.join(SHARED_DIR, 'dropped.png'), pngWithGraph(graph));
    writeFileSync(path.join(SHARED_DIR, 'dropped.txt'), 'pasted prompt', 'utf8');

    const first = await api('GET', '/api/shared-images/dropped', { user: userB });
    check('opening it reads the settings that nothing had parsed',
      String(first.body?.comfy?.seed) === '4242', JSON.stringify(first.body?.comfy?.seed));

    const index = JSON.parse(readFileSync(path.join(SHARED_DIR, 'index.json'), 'utf8'));
    check('...and remembers them, so the next open is free',
      index.dropped?.comfy?.seed === 4242, JSON.stringify(index.dropped));

    const listed = await api('GET', '/api/shared-images', { user: userB });
    check('...which the listing then reflects',
      listed.body?.entries?.find((e) => e.name === 'dropped')?.has_comfy === true);
  }

  // ── 8. what the browser is told ──
  //
  // The listing carries the limits the upload form needs. It must NOT carry
  // the absolute path of the folder: this project took a document out of its
  // history rather than describe the deployment, and a JSON response is a
  // worse place for it than a file.
  console.log('\nwhat the listing hands the browser');
  {
    const { body } = await api('GET', '/api/shared-images', { user: userA });
    check('the accepted types are named', Array.isArray(body?.limits?.accepted_types) &&
      body.limits.accepted_types.includes('image/png'), JSON.stringify(body?.limits));
    check('...along with the size and text caps',
      typeof body?.limits?.max_image_mb === 'number' && typeof body?.limits?.text_max === 'number',
      JSON.stringify(body?.limits));
    check('...and never the server-side path of the folder',
      !('dir' in (body?.limits ?? {})) && !JSON.stringify(body).includes(SHARED_DIR),
      JSON.stringify(body?.limits));
  }
} finally {
  app.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(58));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
