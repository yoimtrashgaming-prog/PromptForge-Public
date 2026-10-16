// Render from PromptForge: the workflow helpers, and the routes end to end
// against a stub ComfyUI.
//
//   node scripts/test-render.mjs
//
// The stub speaks the parts of ComfyUI's API the feature uses — /prompt,
// /history, /view, /object_info and the /ws progress socket — so what the
// server SENDS is asserted (the prompt in the right node, the size, the seed,
// the workflow in the PNG metadata) rather than inferred from a 200.
//
// Needs no ComfyUI, no GPU and no network.

import { freePort } from './lib/freeport.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  mapWorkflow,
  workflowDefaults,
  validateSettings,
  fillWorkflow,
  sizeFor,
  nativeSizeFor,
  composePositive,
  readLoraInfo,
  loraMatches,
  listModelFiles,
  MAX_LORAS,
  previewFrame,
  describeGraph,
  createComfy,
} from '../server/comfyui.mjs';
import { createQueue } from '../server/queue.mjs';
import { fillEditWorkflow, cleanEditPrompt, editUserText, editSettings, editPresets, editWorkflowFiles, editFileChoices, editAbout } from '../server/imageedit.mjs';
import { createUserRender, checkApiWorkflow } from '../server/userrender.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_PORT = await freePort(11495);
const APP_PORT = await freePort(9099); // 9099: clear of every other suite
const BASE = `http://127.0.0.1:${APP_PORT}`;
const OWNER = YAML.parse(readFileSync(path.join(ROOT, 'config/server.yaml'), 'utf8')).owner_username;

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};
const json = (f) => JSON.parse(readFileSync(path.join(ROOT, f), 'utf8'));

// ── the helpers ──────────────────────────────────────────────
{
  for (const model of ['illustrious', 'anima', 'krea2']) {
    const wf = json(`config/comfyui/${model}.json`);
    const map = mapWorkflow(wf);
    check(`${model}: the starter workflow maps`, !map.error, map.error);
    check(`${model}: positive and negative are different nodes`, map.positive && map.positive !== map.negative);
    check(`${model}: the positive is the node titled for it`, wf[map.positive]?._meta?.title?.includes('Positive'));
    check(`${model}: the size is the Empty Latent`, wf[map.size]?.class_type === 'EmptyLatentImage');
    check(`${model}: one model loader found`, Boolean(map.loader));
  }

  // Two samplers is the split kind the plan leaves for later: refused with a
  // reason, never half-filled.
  const two = { 1: { class_type: 'KSampler', inputs: {} }, 2: { class_type: 'KSampler', inputs: {} } };
  check('two samplers are refused, by count', /exactly one KSampler.*2/.test(mapWorkflow(two).error ?? ''));
  check('an empty object is refused', Boolean(mapWorkflow({}).error));

  const d = workflowDefaults(json('config/comfyui/krea2.json'), mapWorkflow(json('config/comfyui/krea2.json')));
  check('defaults come from the workflow', d.steps === 8 && d.cfg === 1 && d.sampler === 'euler', JSON.stringify(d));
  check('...including its model file', d.model_file === 'krea2_turbo_fp8_scaled.safetensors', d.model_file);

  // The owner's resolution table: short side = tier, multiples of 16.
  const s = sizeFor('2:3 Portrait', 1080);
  check('1080p 2:3 is 1088 × 1616', s?.width === 1088 && s?.height === 1616, JSON.stringify(s));
  const w = sizeFor('16:9 Wide', 720);
  check('720p 16:9 is landscape, 1280 × 720', w?.width === 1280 && w?.height === 720, JSON.stringify(w));
  check('N/A has no size of its own', sizeFor('N/A', 1080) === null);
  const n = nativeSizeFor('1:1 Square', 832, 1216);
  check('native keeps the workflow\'s pixel count', n && Math.abs(n.width * n.height - 832 * 1216) < 40_000, JSON.stringify(n));
  check('...in multiples of 16', n && n.width % 16 === 0 && n.height % 16 === 0);

  const caps = { max_steps: 60, max_megapixels: 2.1 };
  const ok = { steps: 30, cfg: 4.5, width: 832, height: 1216, seed: 7, sampler: 'euler', scheduler: 'simple' };
  check('good settings pass', validateSettings(ok, { caps }).ok);
  check('steps over the cap are refused, naming it', /60/.test(validateSettings({ ...ok, steps: 61 }, { caps }).message ?? ''));
  check('a size over the cap is refused', /cap/.test(validateSettings({ ...ok, width: 2048, height: 2048 }, { caps }).message ?? ''));
  check('an unknown sampler is refused when the list is known',
    !validateSettings({ ...ok, sampler: 'nope' }, { caps, samplers: ['euler'] }).ok);
  check('...and left to ComfyUI when it is not', validateSettings({ ...ok, sampler: 'nope' }, { caps, samplers: [] }).ok);
  check('a model file not on offer is refused',
    !validateSettings({ ...ok, model_file: '../../etc/passwd' }, { caps, modelFiles: ['a.safetensors'] }).ok);
  check('a negative seed is refused', !validateSettings({ ...ok, seed: -1 }, { caps }).ok);

  const wf = json('config/comfyui/krea2.json');
  const ui = json('config/comfyui/ui/krea2.json');
  const map = mapWorkflow(wf);
  const settings = validateSettings(
    { ...ok, steps: 50, cfg: 3.5, seed: 1234, width: 1088, height: 1616, model_file: 'krea2_raw_fp8_scaled.safetensors' },
    { caps, modelFiles: ['krea2_raw_fp8_scaled.safetensors'] }
  ).settings;
  const filled = fillWorkflow(wf, ui, map, { positive: 'a lighthouse at dusk', negative: '', settings });
  check('the prompt lands in the positive node', filled.api[map.positive].inputs.text === 'a lighthouse at dusk');
  check('sampler values are written', filled.api[map.sampler].inputs.steps === 50 && filled.api[map.sampler].inputs.seed === 1234);
  check('the size is written', filled.api[map.size].inputs.width === 1088 && filled.api[map.size].inputs.height === 1616);
  check('the model file is swapped', filled.api[map.loader].inputs.unet_name === 'krea2_raw_fp8_scaled.safetensors');
  check('the starter file is untouched', wf[map.positive].inputs.text === '' && wf[map.sampler].inputs.steps === 8);
  const uiSampler = filled.ui.nodes.find((x) => String(x.id) === map.sampler).widgets_values;
  check('the PNG workflow shows what ran, seed fixed', uiSampler[0] === 1234 && uiSampler[1] === 'fixed' && uiSampler[2] === 50,
    JSON.stringify(uiSampler));
}

// ── stage 2 helpers: loaders, LoRAs, the assembled prompt ────
{
  const krea = mapWorkflow(json('config/comfyui/krea2.json'));
  const illus = mapWorkflow(json('config/comfyui/illustrious.json'));
  check('krea2 has a text encoder, a VAE and a LoRA loader', Boolean(krea.textEncoder && krea.vae && krea.lora));
  check('illustrious\'s checkpoint carries its own text encoder and VAE', !illus.textEncoder && !illus.vae && Boolean(illus.lora));
  check('the loader folders are named for listing', krea.loaderFolder === 'diffusion_models' && illus.loaderFolder === 'checkpoints');

  const caps = { max_steps: 60, max_megapixels: 2.1 };
  const base = { steps: 8, cfg: 1, width: 832, height: 1216, seed: 1, sampler: 'euler', scheduler: 'simple' };
  const lists = { caps, modelFiles: ['m.safetensors'], textEncoders: ['te.safetensors'], vaes: ['v.safetensors'], loras: ['a.safetensors', 'b.safetensors'] };
  const two = validateSettings({ ...base, loras: [{ file: 'a.safetensors', strength: 0.8 }, { file: 'b.safetensors', strength: -0.5 }] }, lists);
  check('LoRAs from the list pass, strengths kept', two.ok && two.settings.loras[1].strength === -0.5, JSON.stringify(two));
  check('a LoRA not installed is refused', !validateSettings({ ...base, loras: [{ file: '../x.safetensors', strength: 1 }] }, lists).ok);
  check('a wild strength is refused', !validateSettings({ ...base, loras: [{ file: 'a.safetensors', strength: 9 }] }, lists).ok);
  check('more than the cap is refused',
    !validateSettings({ ...base, loras: Array.from({ length: MAX_LORAS + 1 }, () => ({ file: 'a.safetensors', strength: 1 })) }, lists).ok);
  check('a text encoder not installed is refused', !validateSettings({ ...base, text_encoder: 'nope.safetensors' }, lists).ok);
  check('...nor a VAE', !validateSettings({ ...base, vae: 'nope.safetensors' }, lists).ok);

  const wf = json('config/comfyui/krea2.json');
  const ui = json('config/comfyui/ui/krea2.json');
  const settings = validateSettings(
    { ...base, text_encoder: 'te.safetensors', vae: 'v.safetensors', loras: [{ file: 'a.safetensors', strength: 0.8 }, { file: 'b.safetensors', strength: 1 }] },
    lists
  ).settings;
  const filled = fillWorkflow(wf, ui, krea, { positive: 'p', negative: '', settings });
  const li = filled.api[krea.lora].inputs;
  check('LoRAs land as lora_1, lora_2', li.lora_1?.lora === 'a.safetensors' && li.lora_1.strength === 0.8 && li.lora_2?.lora === 'b.safetensors', JSON.stringify(li));
  check('...each switched on', li.lora_1.on === true && li.lora_2.on === true);
  check('text encoder and VAE are swapped', filled.api[krea.textEncoder].inputs.clip_name === 'te.safetensors' && filled.api[krea.vae].inputs.vae_name === 'v.safetensors');
  const w = filled.ui.nodes.find((n) => String(n.id) === krea.lora).widgets_values;
  check('the PNG workflow shows the LoRA rows after the header', w[1]?.type === 'PowerLoraLoaderHeaderWidget' && w[2]?.lora === 'a.safetensors' && w[3]?.lora === 'b.safetensors' && w.at(-1) === '',
    JSON.stringify(w));
  const none = fillWorkflow(wf, ui, krea, { positive: 'p', negative: '', settings: { ...settings, loras: [] } });
  check('no LoRAs leaves no lora_N', !Object.keys(none.api[krea.lora].inputs).some((k) => /^lora_\d/.test(k)));

  // The assembled positive.
  check('prefix and triggers go first on a tag model',
    composePositive({ prompt: '1girl, rain', prefix: 'masterpiece, best quality', triggers: ['3sh'], tagModel: true }) === 'masterpiece, best quality, 3sh, 1girl, rain');
  check('a tag already in the prompt is kept once',
    composePositive({ prompt: '1girl, best_quality, rain', prefix: 'masterpiece, best quality', tagModel: true }) === 'masterpiece, 1girl, best_quality, rain');
  check('prose gets the prefix in front',
    composePositive({ prompt: 'A man on a dock.', prefix: 'cinematic photo', tagModel: false }) === 'cinematic photo, A man on a dock.');
  check('...unless the phrase is already there',
    composePositive({ prompt: 'A cinematic photo of a dock.', prefix: 'cinematic photo', tagModel: false }) === 'A cinematic photo of a dock.');
  check('nothing to add leaves the prompt alone', composePositive({ prompt: 'x, y', tagModel: true }) === 'x, y');

  // What a LoRA says about itself, from a real safetensors header.
  const dir = mkdtempSync(path.join(tmpdir(), 'pf-lora-'));
  const head = Buffer.from(JSON.stringify({ __metadata__: { 'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora', 'modelspec.trigger_phrase': '3sh,', ss_sd_model_name: 'illustrious-xl-v0.1.safetensors' } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(head.length));
  writeFileSync(path.join(dir, 'l.safetensors'), Buffer.concat([len, head]));
  writeFileSync(path.join(dir, 'junk.safetensors'), 'not a safetensors file');
  const info = readLoraInfo(path.join(dir, 'l.safetensors'));
  check('the architecture is read from the header', info.architecture === 'stable-diffusion-xl-v1-base/lora');
  check('...and the trigger phrase', info.trigger === '3sh,');
  check('a junk file reads as nothing, without throwing', readLoraInfo(path.join(dir, 'junk.safetensors')).architecture === null);
  check('an SDXL LoRA matches Illustrious\'s patterns', loraMatches(info, ['stable-diffusion-xl', 'sdxl']) === true);
  check('...and not Krea2\'s', loraMatches(info, ['krea']) === false);
  check('a LoRA that says nothing is "unknown", not "no"', loraMatches({}, ['krea']) === null);
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'deep.safetensors'), 'x');
  writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const listed = listModelFiles(dir);
  check('installed files are listed with subfolders, model files only', listed.join() === 'junk.safetensors,l.safetensors,sub/deep.safetensors', listed.join());
  rmSync(dir, { recursive: true, force: true });
}

// ── what a ComfyUI job is making ─────────────────────────────
{
  const d = (f) => describeGraph(json(f));
  check('the Illustrious starter is an Illustrious image', JSON.stringify(d('config/comfyui/illustrious.json')) === '{"model":"Illustrious","kind":"image"}');
  check('the Krea2 starter is a Krea2 image', JSON.stringify(d('config/comfyui/krea2.json')) === '{"model":"Krea2","kind":"image"}');
  const mmh3 = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors' } },
    3: { class_type: 'MiniMaxH3Director', inputs: {} },
    4: { class_type: 'DaSiWa_EnhancedVideoCombine', inputs: {} },
  };
  check('an MMH3 graph is an MMH3 video', JSON.stringify(describeGraph(mmh3)) === '{"model":"MMH3","kind":"video"}');
  const wan = { 1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors' } }, 2: { class_type: 'SaveVideo', inputs: {} } };
  check('a Wan graph is a Wan video', JSON.stringify(describeGraph(wan)) === '{"model":"Wan","kind":"video"}');
  check('a graph loading nothing known is just an image', JSON.stringify(describeGraph({ 1: { class_type: 'SaveImage', inputs: {} } })) === '{"model":null,"kind":"image"}');
  // The model loader decides, not a LoRA or text encoder that happens to name another family.
  const mixed = { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'Illustrious-XL-v0.1.safetensors' } }, 2: { class_type: 'LoraLoader', inputs: { lora_name: 'anima_style.safetensors' } } };
  check('the model loader outranks a LoRA\'s name', describeGraph(mixed).model === 'Illustrious');
}

// ── preview frames ───────────────────────────────────────────
{
  const jpeg = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from('abc')]);
  check('a PREVIEW_IMAGE frame decodes to a JPEG data URI', previewFrame(jpeg) === `data:image/jpeg;base64,${Buffer.from('abc').toString('base64')}`);
  const png = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), Buffer.from('abc')]);
  check('...type 2 is PNG', previewFrame(png)?.startsWith('data:image/png;base64,'));
  const meta = Buffer.from(JSON.stringify({ image_type: 'image/png', node_id: '7' }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.length);
  const withMeta = Buffer.concat([Buffer.from([0, 0, 0, 4]), len, meta, Buffer.from('xyz')]);
  check('a PREVIEW_IMAGE_WITH_METADATA frame decodes too', previewFrame(withMeta) === `data:image/png;base64,${Buffer.from('xyz').toString('base64')}`);
  check('another binary event is not a picture', previewFrame(Buffer.from([0, 0, 0, 3, 0, 0, 0, 1, 9])) === null);
  check('a short frame is nothing, without throwing', previewFrame(Buffer.from([1, 2])) === null);
}

// ── stage 3: what an upload must be ──────────────────────────
{
  const ok = json('config/comfyui/krea2.json');
  const types = checkApiWorkflow(ok);
  check('a good API workflow passes and lists its node types', types.includes('KSampler') && types.includes('UNETLoader'), types.join());
  const refused = (wf) => {
    try {
      checkApiWorkflow(wf);
      return '';
    } catch (err) {
      return err.message;
    }
  };
  check('the normal save is refused, pointing at Export (API)', /Export \(API\)/.test(refused(json('config/comfyui/ui/krea2.json'))));
  check('a split sampler is refused by name', /SamplerCustomAdvanced/.test(refused({ ...ok, 99: { class_type: 'SamplerCustomAdvanced', inputs: {} } })));
  check('a workflow that does not map is refused with the reason', /KSampler/.test(refused({ 1: { class_type: 'SaveImage', inputs: {} } })));
  check('junk is refused', Boolean(refused('nope')) && Boolean(refused([])));

  const tmpUsers = mkdtempSync(path.join(tmpdir(), 'pf-ur-'));
  const ur = createUserRender(ROOT, { paths: { users: tmpUsers } });
  const w = ur.addWorkflow('someone', { name: 'Mine', models: ['krea2'], api: ok, approved: false }, { modelKeys: ['krea2'] });
  check('an upload by someone else waits', w.approved === false && ur.pending().some((p) => p.id === w.id && p.user === 'someone'));
  ur.setApproved('someone', w.id, true);
  check('...until approved', ur.pending().length === 0 && ur.read('someone').workflows[0].approved === true);
  ur.savePreset('someone', { name: 'soft', model: 'krea2', steps: 20, cfg: 2 }, { modelKeys: ['krea2'] });
  ur.savePreset('someone', { name: 'soft', model: 'krea2', steps: 22, cfg: 2 }, { modelKeys: ['krea2'] });
  check('saving a preset under the same name replaces it', ur.read('someone').presets.length === 1 && ur.read('someone').presets[0].steps === 22);
  check('another person sees none of it', ur.read('other').workflows.length === 0 && ur.read('other').presets.length === 0);
  rmSync(tmpUsers, { recursive: true, force: true });
}

// ── the queue hook renders use ───────────────────────────────
{
  const order = [];
  const q = createQueue({
    beforeStart: async (t) => {
      order.push(`before:${t.kind}`);
      if (t.kind === 'boom') throw new Error('x');
    },
  });
  const a = q.enqueue({ kind: 'prompt' });
  await a.started;
  order.push('started:prompt');
  a.release();
  const b = q.enqueue({ kind: 'boom' });
  await b.started;
  b.release();
  // Reaching this line at all means a throwing beforeStart still let `boom` start.
  check('beforeStart runs before the job starts, and a throwing one does not stall the line',
    order.join() === 'before:prompt,started:prompt,before:boom', order.join());
}

// ── picture edits: the helpers ───────────────────────────────
{
  const wf = json('config/comfyui/qwen-edit.json');
  const api = fillEditWorkflow(wf, { prompt: 'Change the jacket to red.', images: ['promptforge/a.png', 'promptforge/b.png'], seed: 7, steps: 25, resolution: 1024 });
  const enc = Object.values(api).find((n) => n.class_type === 'TextEncodeQwenImage21');
  const loads = Object.entries(api).filter(([, n]) => n.class_type === 'LoadImage');
  check('edit: the prompt goes into the Qwen encoder', enc?.inputs?.prompt === 'Change the jacket to red.' && enc.inputs.negative_prompt === '');
  check('edit: one LoadImage per picture, wired in order', loads.length === 2 &&
    enc.inputs['images.image_1']?.[0] === loads.find(([, n]) => n.inputs.image === 'promptforge/a.png')?.[0] &&
    enc.inputs['images.image_2']?.[0] === loads.find(([, n]) => n.inputs.image === 'promptforge/b.png')?.[0], JSON.stringify(enc?.inputs));
  check('edit: the sampler gets the seed and steps, and samples the encoder\'s latent',
    Object.values(api).some((n) => n.class_type === 'KSampler' && n.inputs.seed === 7 && n.inputs.latent_image?.[0] === Object.keys(api).find((k) => api[k] === enc)));
  check('edit: the workflow file itself is untouched', !Object.values(wf).some((n) => n.class_type === 'LoadImage'));
  let threw = false;
  try { fillEditWorkflow(wf, { prompt: 'x', images: [], seed: 1, steps: 1, resolution: 1024 }); } catch { threw = true; }
  check('edit: no picture is an error, not an empty edit', threw);
  check('edit: a broken-up answer becomes one paragraph', cleanEditPrompt('Edit prompt: Change the sky.\n\nKeep the rest.') === 'Change the sky. Keep the rest.');
  check('edit: the writer is told which picture is edited', /<image1> is the one being edited/.test(editUserText({ instruction: 'x', count: 2 })));
  check('edit: ...and about marks only when there are some', /red marks/.test(editUserText({ instruction: 'x', marked: true })) && !/red marks/.test(editUserText({ instruction: 'x' })));
  check('edit: off when ComfyUI is', editSettings({ edit: { enabled: true }, comfyui: { enabled: false } }) === null);

  // The speed LoRA: between the loader and everything that took its model.
  const lo = fillEditWorkflow(wf, { prompt: 'x', images: ['a.png'], seed: 1, steps: 4, resolution: 1024, lora: 'fast.safetensors' });
  const loId = Object.keys(lo).find((k) => lo[k].class_type === 'LoraLoaderModelOnly');
  const unetId = Object.keys(lo).find((k) => lo[k].class_type === 'UNETLoader');
  check('edit: the LoRA takes the loader\'s model at full strength', lo[loId]?.inputs?.model?.[0] === unetId && lo[loId].inputs.lora_name === 'fast.safetensors' && lo[loId].inputs.strength_model === 1);
  check('edit: ...and nothing else reads the loader directly any more',
    !Object.entries(lo).some(([k, n]) => k !== loId && Object.values(n.inputs ?? {}).some((v) => Array.isArray(v) && v[0] === unetId)));
  check('edit: ...the sampler runs the steps asked for', Object.values(lo).find((n) => n.class_type === 'KSampler')?.inputs?.steps === 4);
  check('edit: no LoRA, no LoRA node', !Object.values(fillEditWorkflow(wf, { prompt: 'x', images: ['a.png'], seed: 1, steps: 25, resolution: 1024 })).some((n) => n.class_type === 'LoraLoaderModelOnly'));
  const ps = editSettings({ edit: { steps: 25, presets: [{ name: 'Fast', steps: 4, lora: 'fast.safetensors' }, { name: 'Full', steps: 25 }] }, comfyui: { enabled: true } });
  check('edit: Fast is the default when its LoRA is installed', editPresets(ps, ['fast.safetensors']).map((p) => p.name).join() === 'Fast,Full');
  check('edit: ...and not offered when it is not', editPresets(ps, []).map((p) => p.name).join() === 'Full');
  check('edit: no presets configured means one at the edit\'s steps', editPresets(editSettings({ edit: { steps: 30 }, comfyui: { enabled: true } }), [])[0]?.steps === 30);

  // The file pickers.
  const s = editSettings({ edit: {}, comfyui: { enabled: true } });
  const defaults = editWorkflowFiles(wf);
  check('edit: the workflow names its three files', defaults.model === 'qwen_image_2.1_int8_convrot.safetensors' && /qwen3vl_8b/.test(defaults.text_encoder) && /vae/.test(defaults.vae), JSON.stringify(defaults));
  const ch = editFileChoices(s, defaults, {
    model: ['krea2_turbo_fp8_scaled.safetensors', 'qwen_image_2.1_bf16.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'],
    text_encoder: ['qwen3vl_8b_w4a8.safetensors', 'umt5_xxl.safetensors'],
    vae: ['wan_2.1_vae.safetensors', 'qwen_image_vae.safetensors'],
  });
  check('edit: the pickers offer matching files, the workflow\'s first, without repeats',
    ch.model.join() === 'qwen_image_2.1_int8_convrot.safetensors,qwen_image_2.1_bf16.safetensors' && ch.text_encoder.join() === `${defaults.text_encoder},qwen3vl_8b_w4a8.safetensors`, JSON.stringify(ch));
  check('edit: ...and nothing for another model', !ch.model.includes('krea2_turbo_fp8_scaled.safetensors') && ch.vae.length === 1, JSON.stringify(ch.vae));
  const g = fillEditWorkflow(wf, { prompt: 'x', images: ['a.png'], seed: 1, steps: 4, resolution: 1024, files: { model: 'qwen_image_2.1_bf16.safetensors', text_encoder: 'qwen3vl_8b_w4a8.safetensors' } });
  check('edit: picked files go into the stock loaders',
    Object.values(g).find((n) => n.class_type === 'UNETLoader')?.inputs?.unet_name === 'qwen_image_2.1_bf16.safetensors' &&
    Object.values(g).find((n) => n.class_type === 'CLIPLoader')?.inputs?.clip_name === 'qwen3vl_8b_w4a8.safetensors' &&
    Object.values(g).find((n) => n.class_type === 'CLIPLoader')?.inputs?.type === 'qwen_image');
  check('edit: the About text reaches the tab as plain strings', editAbout({ summary: ' x ', needs: 'y', files: ['a', 7, ''], smaller: 'not a list' })?.files?.join() === 'a' && editAbout({ needs: 'y' })?.needs === 'y' && editAbout({}) === null);
}

// ── freeing a ComfyUI somebody else started, only when it is idle ──
{
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-free-'));
  let queue = { queue_running: [], queue_pending: [] };
  let frees = 0;
  let down = false;
  const fetchImpl = async (url) => {
    if (down) throw new Error('ECONNREFUSED');
    if (url.endsWith('/free')) {
      frees += 1;
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => queue };
  };
  const c = createComfy({ comfyui: { enabled: true, url: 'http://127.0.0.1:1' } }, { rootDir: ROOT, dataDir, fetchImpl, log: () => {} });
  check('an idle ComfyUI this server did not start is freed for an LLM', (await c.freeIfIdle()) === true && frees === 1);
  queue = { queue_running: [[0, 'someone', {}, {}, []]], queue_pending: [] };
  check('...but never while it is running something', (await c.freeIfIdle()) === false && frees === 1);
  queue = { queue_running: [], queue_pending: [[1, 'waiting', {}, {}, []]] };
  check('...or has something waiting', (await c.freeIfIdle()) === false && frees === 1);
  down = true;
  check('...and a ComfyUI that is not running is left alone', (await c.freeIfIdle()) === false && frees === 1);
  const off = createComfy({ comfyui: { enabled: false } }, { rootDir: ROOT, dataDir, fetchImpl, log: () => {} });
  check('...nothing at all with rendering switched off', (await off.freeIfIdle()) === false);
  rmSync(dataDir, { recursive: true, force: true });
}

// ── a stub ComfyUI ───────────────────────────────────────────
const seen = { prompts: [], frees: 0, refuse: false, uploads: [] };
const sockets = new Set();
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function wsSend(sock, obj) {
  const data = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  // 0x81 text, 0x82 binary (preview frames).
  const op = Buffer.isBuffer(obj) ? 0x82 : 0x81;
  const head = data.length < 126 ? Buffer.from([op, data.length]) : Buffer.from([op, 126, data.length >> 8, data.length & 255]);
  sock.write(Buffer.concat([head, data]));
}
// A preview as ComfyUI sends it: uint32 event 1, uint32 type 1 (JPEG), bytes.
const PREVIEW = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from('fakejpeg')]);

const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/system_stats') return send(200, { system: {} });
  if (url.pathname === '/object_info/KSampler') {
    return send(200, { KSampler: { input: { required: { sampler_name: [['euler', 'er_sde', 'dpmpp_2m_sde']], scheduler: [['simple', 'karras']] } } } });
  }
  // The loaders' file lists: what this "ComfyUI" has installed.
  const LISTS = {
    UNETLoader: ['unet_name', ['krea2_turbo_fp8_scaled.safetensors', 'krea2_raw_fp8_scaled.safetensors', 'krea2_mine.safetensors', 'wan_other.safetensors']],
    CheckpointLoaderSimple: ['ckpt_name', ['Illustrious-XL-v0.1.safetensors']],
    CLIPLoader: ['clip_name', ['qwen3vl_4b_fp8_scaled.safetensors', 'other_te.safetensors', 'qwen3vl_8b_w4a8.safetensors']],
    VAELoader: ['vae_name', ['qwen_image_vae.safetensors']],
    LoraLoader: ['lora_name', ['style_a.safetensors', 'sub/style_b.safetensors']],
  };
  const node = url.pathname.replace('/object_info/', '');
  if (LISTS[node]) return send(200, { [node]: { input: { required: { [LISTS[node][0]]: [LISTS[node][1]] } } } });
  if (url.pathname === '/queue' && req.method === 'GET') {
    return send(200, { queue_running: seen.outside ? [[0, 'outside-1', seen.outside, {}, []]] : [], queue_pending: [] });
  }
  if (url.pathname === '/free') {
    seen.frees += 1;
    return send(200, {});
  }
  // An edit's pictures. Only the file name is read back out of the form.
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    const name = /filename="([^"]+)"/.exec(body)?.[1];
    seen.uploads.push(name);
    // Was this upload a picture an earlier edit made? Those carry a marker.
    seen.uploadedEdits = (seen.uploadedEdits ?? 0) + (body.includes('EDITED') ? 1 : 0);
    return send(200, { name, subfolder: 'promptforge', type: 'input' });
  }
  if (url.pathname === '/prompt') {
    const p = JSON.parse(body);
    if (seen.refuse) {
      return send(400, { error: { message: 'Prompt outputs failed validation' }, node_errors: { 1: { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: 'unet_name: missing.safetensors' }] } } });
    }
    seen.prompts.push(p);
    const id = `p${seen.prompts.length}`;
    send(200, { prompt_id: id, number: 1 });
    setTimeout(() => {
      const ks = Object.entries(p.prompt).find(([, n]) => n.class_type === 'KSampler')?.[0];
      for (const s of sockets) {
        wsSend(s, { type: 'execution_start', data: { prompt_id: id } });
        wsSend(s, { type: 'executing', data: { prompt_id: id, node: ks } });
        wsSend(s, PREVIEW);
        wsSend(s, { type: 'progress', data: { prompt_id: id, value: 1, max: 2, node: ks } });
        wsSend(s, { type: 'progress', data: { prompt_id: id, value: 2, max: 2 } });
        wsSend(s, { type: 'execution_success', data: { prompt_id: id } });
      }
    }, 50);
    return;
  }
  const hist = /^\/history\/(p\d+)$/.exec(url.pathname);
  if (hist) {
    // An edit's picture is told apart from a render's by name, and its bytes
    // by a marker, so a later upload can be traced back to it.
    const isEdit = Object.values(seen.prompts[Number(hist[1].slice(1)) - 1]?.prompt ?? {}).some((n) => n.class_type === 'TextEncodeQwenImage21');
    return send(200, { [hist[1]]: { outputs: { 9: { images: [{ filename: isEdit ? 'edit_00001_.png' : 'pf_00001_.png', subfolder: 'PromptForge', type: 'output' }] } } } });
  }
  if (url.pathname === '/view') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(url.searchParams.get('filename')?.startsWith('edit_') ? Buffer.concat([PNG, Buffer.from('EDITED')]) : PNG);
  }
  return send(404, {});
});
stub.on('upgrade', (req, sock) => {
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(sock);
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => sockets.delete(sock));
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

// ── a stub LLM, llama.cpp-shaped, for render from chat ───────
// A chat turn offered render_picture calls it; a prompt generation (no tools)
// writes a two-segment Krea2 answer. Every request is kept, so the test can
// tell a rewrite from a reuse.
const llmSeen = { chats: [], generations: 0, edits: [], editCalls: [] };
const LLM_PORT = await freePort(11494);
const llmStub = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
  }
  if (req.method === 'GET' && req.url.startsWith('/running')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ running: [] }));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  const p = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  const tool = (p.tools ?? []).find((t) => t.function?.name === 'render_picture');
  const userText = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : String(m?.content ?? ''));
  const lastText = userText(p.messages.at(-1));
  if (/picture edits/.test(String(p.messages[0]?.content ?? ''))) {
    // The edit writer: it must be handed the pictures to look at.
    llmSeen.edits.push({ images: (p.messages.at(-1)?.content ?? []).filter?.((c) => c.type === 'image_url').length ?? 0, text: lastText });
    chunk({ content: '===SEGMENT: Edit prompt===\nChange the jacket to deep red leather.\nKeep her face and the street unchanged.\n' });
  } else if ((p.tools ?? []).some((t) => t.function?.name === 'edit_picture') && /make (it|the)/.test(lastText)) {
    llmSeen.editCalls.push(p.tools.map((t) => t.function.name));
    chunk({ tool_calls: [{ index: 0, id: 'e1', function: { name: 'edit_picture', arguments: JSON.stringify({ instruction: lastText }) } }] });
  } else if (tool) {
    const last = String(p.messages.at(-1)?.content ?? '');
    llmSeen.chats.push({ tools: p.tools.map((t) => t.function.name), last });
    chunk({ content: 'Here it is.' });
    const args = JSON.stringify({ model: 'krea2', brief: 'a lighthouse at dusk', same_prompt: /again/.test(last) });
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'render_picture', arguments: args } }] });
  } else {
    llmSeen.generations += 1;
    chunk({ content: '===SEGMENT: Enhanced prompt===\nA lighthouse on a cliff at dusk, waves below.\n===SEGMENT: What changed===\nAdded the waves.\n' });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => llmStub.listen(LLM_PORT, '127.0.0.1', r));

const usersDir = mkdtempSync(path.join(tmpdir(), 'pf-render-users-'));
const dataDir = mkdtempSync(path.join(tmpdir(), 'pf-render-data-'));
const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PROMPTFORGE_PORT: String(APP_PORT),
    PROMPTFORGE_AUTH: 'off',
    // The stub above. Renders never call it; render from chat does.
    PROMPTFORGE_LLM_BACKEND: 'llamacpp',
    PROMPTFORGE_LLM_MODEL: 'stub-model',
    PROMPTFORGE_MODEL_DEFAULTS: 'h3=pinned-h3-model',
    PROMPTFORGE_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
    PROMPTFORGE_USERS_DIR: usersDir,
    PROMPTFORGE_DATA_DIR: dataDir,
    PROMPTFORGE_SEARCH: 'off',
    PROMPTFORGE_COMFYUI: `http://127.0.0.1:${STUB_PORT}`,
    // The stub writes edits, so it must see pictures whatever this box's
    // server.local.yaml says its own vision models are.
    PROMPTFORGE_VISION_MODELS: 'stub-model',
  },
  stdio: 'ignore',
});

const as = (user, init = {}) => ({
  ...init,
  headers: { 'content-type': 'application/json', 'x-promptforge-user': user, ...(init.headers ?? {}) },
});

/** POST /api/render and collect the SSE events as [name, data]. */
async function render(user, body) {
  const res = await fetch(`${BASE}/api/render`, as(user, { method: 'POST', body: JSON.stringify(body) }));
  if (!res.ok) return { status: res.status, body: await res.json(), events: [] };
  const text = await res.text();
  const events = text.split('\n\n').map((f) => [/^event: (.+)$/m.exec(f)?.[1], /^data: (.+)$/m.exec(f)?.[1]])
    .filter(([e, d]) => e && d).map(([e, d]) => [e, JSON.parse(d)]);
  return { status: res.status, events };
}

const GOOD = { steps: 50, cfg: 3.5, sampler: 'euler', scheduler: 'simple', seed: 42, width: 1088, height: 1616, model_file: 'krea2_raw_fp8_scaled.safetensors' };

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`server did not start on ${APP_PORT}`);

  // The gate. With accounts off, only the owner header renders.
  const denied = await fetch(`${BASE}/api/render/options?model=krea2`, as('friend'));
  check('someone without the grant cannot see render options', denied.status === 403, String(denied.status));
  check('...and is told which permission it needs', /"render"/.test((await denied.json()).message ?? ''));
  const deniedPost = await render('friend', { model: 'krea2', positive: 'x', settings: GOOD });
  check('...or render', deniedPost.status === 403, String(deniedPost.status));

  const models = await (await fetch(`${BASE}/api/models`, as(OWNER))).json();
  const pub = models.models.find((m) => m.key === 'krea2');
  check('the registry says krea2 can render', pub?.can_render === true);
  check('...without sending the workflow paths', pub && !('render' in pub));
  check('a video model cannot', models.models.find((m) => m.key === 'h3')?.can_render === false);

  const opts = await (await fetch(`${BASE}/api/render/options?model=krea2`, as(OWNER))).json();
  check('options are available for krea2', opts.available === true, JSON.stringify(opts).slice(0, 200));
  check('krea2 takes no negative', opts.has_negative === false && opts.defaults.negative === '');
  check('presets come from the registry', opts.presets?.length === 2 && /Turbo/.test(opts.presets[0].name));
  check('sampler lists come from ComfyUI', opts.samplers?.includes('er_sde') && opts.schedulers?.includes('karras'));
  check('sizes come worked out', opts.sizes?.['2:3 Portrait']?.['1080']?.width === 1088, JSON.stringify(opts.sizes?.['2:3 Portrait']));
  check('...N/A has none', opts.sizes?.['N/A']?.native === null);
  const illus = await (await fetch(`${BASE}/api/render/options?model=illustrious`, as(OWNER))).json();
  check('illustrious\'s basic negative is its negative_defaults', /worst quality/.test(illus.defaults?.negative ?? ''));
  const h3 = await (await fetch(`${BASE}/api/render/options?model=h3`, as(OWNER))).json();
  check('h3 says plainly it has no workflow', h3.available === false && /no render workflow/.test(h3.message ?? ''));

  // Refusals before anything reaches the GPU queue, as plain 400s.
  const over = await render(OWNER, { model: 'krea2', positive: 'x', settings: { ...GOOD, steps: 500 } });
  check('steps over the cap are a 400', over.status === 400 && /60/.test(over.body?.message ?? ''), JSON.stringify(over.body));
  const file = await render(OWNER, { model: 'krea2', positive: 'x', settings: { ...GOOD, model_file: 'other.safetensors' } });
  check('a model file not on offer is a 400', file.status === 400);
  const empty = await render(OWNER, { model: 'krea2', positive: '  ', settings: GOOD });
  check('an empty prompt is a 400', empty.status === 400);

  // A whole render.
  const r = await render(OWNER, { model: 'krea2', positive: 'a lighthouse at dusk', negative: 'ignored', settings: GOOD });
  const names = r.events.map(([e]) => e);
  const done = r.events.find(([e]) => e === 'done')?.[1];
  check('the render finishes', Boolean(done), names.join(','));
  check('progress streams as steps', r.events.filter(([e]) => e === 'progress').length === 2, names.join(','));
  check('the running node is named, as the workflow names it', r.events.some(([e, d]) => e === 'node' && d.name === 'KSampler'), names.join(','));
  check('...and the steps say which node they belong to', r.events.find(([e]) => e === 'progress')?.[1]?.node === 'KSampler');
  const pv = r.events.find(([e]) => e === 'preview')?.[1]?.image;
  check('a preview frame reaches the page as a JPEG', pv === `data:image/jpeg;base64,${Buffer.from('fakejpeg').toString('base64')}`, String(pv).slice(0, 60));
  const sent = seen.prompts.at(-1);
  const map = mapWorkflow(sent?.prompt ?? {});
  check('ComfyUI got the prompt in the positive node', sent?.prompt?.[map.positive]?.inputs?.text === 'a lighthouse at dusk');
  check('...and no negative for a model without one', sent?.prompt?.[map.negative]?.inputs?.text === '');
  check('...the seed and size asked for', sent?.prompt?.[map.sampler]?.inputs?.seed === 42 && sent?.prompt?.[map.size]?.inputs?.height === 1616);
  check('...the Raw file', sent?.prompt?.[map.loader]?.inputs?.unet_name === 'krea2_raw_fp8_scaled.safetensors');
  check('...and the editable workflow for the PNG', Array.isArray(sent?.extra_data?.extra_pnginfo?.workflow?.nodes));

  const img = await fetch(`${BASE}${done?.url}`, as(OWNER));
  check('the picture is served to whoever made it', img.status === 200 && (await img.arrayBuffer()).byteLength === PNG.length);
  // What an <img> sends: no header at all. Found 3 Oct on the server, when
  // the picture sat behind the grant check and never loaded.
  const bare = await fetch(`${BASE}${done?.url}`);
  check('the picture loads in an <img>, with no header', bare.status === 200, String(bare.status));
  const theirs = await fetch(`${BASE}${done?.url}`, as('friend'));
  check('...and to nobody else', theirs.status === 403 || theirs.status === 404, String(theirs.status));
  check('it is stored in the data folder', readdirSync(path.join(dataDir, 'renders')).some((f) => f === `${done?.id}.png`));

  const pin = await fetch(`${BASE}/api/render/${done?.id}/pin`, as(OWNER, { method: 'POST', body: JSON.stringify({ brief: 'pier' }) }));
  const pinned = await pin.json();
  check('Pin puts it on the pinboard', pin.status === 201 && /krea2-render/.test(pinned.name ?? ''), JSON.stringify(pinned));
  check('...with its prompt', pinned.text === 'a lighthouse at dusk');

  // ── stage 2: the owner's catalogue, loaders and LoRAs ──
  const k2 = await (await fetch(`${BASE}/api/render/options?model=krea2`, as(OWNER))).json();
  check('text encoders are the installed ones', k2.text_encoders?.includes('other_te.safetensors'), JSON.stringify(k2.text_encoders));
  check('the Model dropdown holds only the workflow\'s and the presets\' files',
    k2.model_files?.map((f) => f.file).join() === 'krea2_turbo_fp8_scaled.safetensors,krea2_raw_fp8_scaled.safetensors', JSON.stringify(k2.model_files));
  check('...not every file in the folder', !k2.model_files?.some((f) => f.file === 'wan_other.safetensors'));
  check('a file named by a preset carries that preset', k2.model_files?.[1]?.steps === 50);
  check('LoRAs are listed, subfolders included', k2.loras?.map((l) => l.file).join() === 'style_a.safetensors,sub/style_b.safetensors', JSON.stringify(k2.loras));

  const adminDenied = await fetch(`${BASE}/api/admin/render`, as('friend'));
  check('the catalogue is the owner\'s alone', adminDenied.status === 403, String(adminDenied.status));
  const put = (route, body, user = OWNER) => fetch(`${BASE}/api/admin/render${route}`, as(user, { method: 'PUT', body: JSON.stringify(body) }));
  const added = await put('/files', { file: 'krea2_mine.safetensors', model: 'krea2', steps: 12, cfg: 2, prefix: 'pfstyle' });
  check('the owner adds a model file', added.status === 200, String(added.status));
  check('a file that is not installed is refused', (await put('/files', { file: 'ghost.safetensors', model: 'krea2' })).status === 404);
  check('a file for an unknown model is refused', (await put('/files', { file: 'krea2_mine.safetensors', model: 'nope' })).status === 400);
  const loraPut = await put('/loras', { file: 'style_a.safetensors', models: ['krea2'], triggers: 'aaa, bbb' });
  check('the owner corrects a LoRA', loraPut.status === 200, String(loraPut.status));

  const k3 = await (await fetch(`${BASE}/api/render/options?model=krea2`, as(OWNER))).json();
  const mine = k3.model_files?.find((f) => f.file === 'krea2_mine.safetensors');
  check('the added file is in the Model dropdown with its own preset', mine?.steps === 12 && mine?.prefix === 'pfstyle', JSON.stringify(mine));
  const sa = k3.loras?.find((l) => l.file === 'style_a.safetensors');
  check('the corrected LoRA matches krea2, with its triggers', sa?.matches === true && sa?.triggers?.join() === 'aaa,bbb', JSON.stringify(sa));
  const i3 = await (await fetch(`${BASE}/api/render/options?model=illustrious`, as(OWNER))).json();
  check('...and not illustrious', i3.loras?.find((l) => l.file === 'style_a.safetensors')?.matches === false);

  const r2 = await render(OWNER, {
    model: 'krea2',
    positive: 'a lighthouse at dusk',
    settings: { ...GOOD, steps: 12, cfg: 2, model_file: 'krea2_mine.safetensors', text_encoder: 'other_te.safetensors', loras: [{ file: 'style_a.safetensors', strength: 0.7 }] },
  });
  const done2 = r2.events.find(([e]) => e === 'done')?.[1];
  check('a render with a LoRA finishes', Boolean(done2), r2.events.map(([e, d]) => e + (e === 'error' ? `:${d.message}` : '')).join(','));
  const s2 = seen.prompts.at(-1)?.prompt ?? {};
  const m2 = mapWorkflow(s2);
  check('ComfyUI got prefix, then triggers, then the prompt', s2[m2.positive]?.inputs?.text === 'pfstyle, aaa, bbb, a lighthouse at dusk', s2[m2.positive]?.inputs?.text);
  check('...the LoRA at its strength', s2[m2.lora]?.inputs?.lora_1?.lora === 'style_a.safetensors' && s2[m2.lora]?.inputs?.lora_1?.strength === 0.7);
  check('...the added model file and the picked text encoder',
    s2[m2.loader]?.inputs?.unet_name === 'krea2_mine.safetensors' && s2[m2.textEncoder]?.inputs?.clip_name === 'other_te.safetensors');
  check('the done event says what was sent', done2?.positive === 'pfstyle, aaa, bbb, a lighthouse at dusk');
  const notMine = await render(OWNER, { model: 'krea2', positive: 'x', settings: { ...GOOD, model_file: 'wan_other.safetensors' } });
  check('a file not added for this model is refused', notMine.status === 400);

  // Illustrious writes its own negative; the basic one is only the fallback.
  await render(OWNER, { model: 'illustrious', positive: '1girl', negative_segment: 'bad hands, extra digits', settings: { ...GOOD, model_file: undefined, width: 832, height: 1216, steps: 30, cfg: 4.5, sampler: 'dpmpp_2m_sde', scheduler: 'karras' } });
  const si = seen.prompts.at(-1)?.prompt ?? {};
  check('the negative the model wrote is the one sent', si[mapWorkflow(si).negative]?.inputs?.text === 'bad hands, extra digits');
  await render(OWNER, { model: 'illustrious', positive: '1girl', settings: { ...GOOD, model_file: undefined, width: 832, height: 1216, steps: 30, cfg: 4.5, sampler: 'dpmpp_2m_sde', scheduler: 'karras' } });
  const sb = seen.prompts.at(-1)?.prompt ?? {};
  check('...and with none written, the basic one', /worst quality/.test(sb[mapWorkflow(sb).negative]?.inputs?.text ?? ''));
  // The Render panel's Negative box: what it holds is sent exactly.
  const illusSettings = { ...GOOD, model_file: undefined, width: 832, height: 1216, steps: 30, cfg: 4.5, sampler: 'dpmpp_2m_sde', scheduler: 'karras' };
  await render(OWNER, { model: 'illustrious', positive: '1girl', negative_segment: 'bad hands', negative: '  my own negative  ', settings: illusSettings });
  const se = seen.prompts.at(-1)?.prompt ?? {};
  check('an edited negative from the box is sent as it is', se[mapWorkflow(se).negative]?.inputs?.text === 'my own negative');
  await render(OWNER, { model: 'illustrious', positive: '1girl', negative_segment: 'bad hands', negative: '', settings: illusSettings });
  const sz = seen.prompts.at(-1)?.prompt ?? {};
  check('...an emptied box sends no negative', sz[mapWorkflow(sz).negative]?.inputs?.text === '');
  await render(OWNER, { model: 'krea2', positive: 'x', negative: 'ignored', settings: GOOD });
  const sk = seen.prompts.at(-1)?.prompt ?? {};
  check('...and a model without a negative still sends none', sk[mapWorkflow(sk).negative]?.inputs?.text === '');

  const removed = await fetch(`${BASE}/api/admin/render/files`, as(OWNER, { method: 'DELETE', body: JSON.stringify({ file: 'krea2_mine.safetensors' }) }));
  check('the owner removes a file', removed.status === 200);
  const k4 = await (await fetch(`${BASE}/api/render/options?model=krea2`, as(OWNER))).json();
  check('...and it leaves the dropdown', !k4.model_files?.some((f) => f.file === 'krea2_mine.safetensors'));

  // ── stage 3: your own workflows and presets ──
  const upload = structuredClone(JSON.parse(readFileSync(path.join(ROOT, 'config/comfyui/krea2.json'), 'utf8')));
  const um = mapWorkflow(upload);
  upload[um.save].inputs.filename_prefix = 'MINE/krea2';
  upload[um.loader].inputs.unet_name = 'wan_other.safetensors'; // not in the catalogue
  const upRes = await fetch(`${BASE}/api/render/workflows`, as(OWNER, { method: 'POST', body: JSON.stringify({ name: 'My krea', models: ['krea2'], api: upload }) }));
  const wfEntry = await upRes.json();
  check('the owner uploads a workflow, approved at once', upRes.status === 201 && wfEntry.approved === true, JSON.stringify(wfEntry));
  const bad = await fetch(`${BASE}/api/render/workflows`, as(OWNER, { method: 'POST', body: JSON.stringify({ name: 'x', models: ['krea2'], api: JSON.parse(readFileSync(path.join(ROOT, 'config/comfyui/ui/krea2.json'), 'utf8')) }) }));
  check('uploading the normal save is a 400 that says what to export', bad.status === 400 && /Export \(API\)/.test((await bad.json()).message));
  const wo = await (await fetch(`${BASE}/api/render/options?model=krea2&workflow=${wfEntry.id}`, as(OWNER))).json();
  check('options list the starter and the upload', wo.workflows?.map((w) => w.name).join() === 'Starter: krea2,My krea', JSON.stringify(wo.workflows));
  check('...and switch to it', wo.workflow_id === wfEntry.id && wo.workflow === 'My krea' && wo.runnable === true);
  check('an upload naming a file the owner never added gets the starter\'s', wo.defaults?.model_file === 'krea2_turbo_fp8_scaled.safetensors', wo.defaults?.model_file);
  const io = await (await fetch(`${BASE}/api/render/options?model=illustrious&workflow=${wfEntry.id}`, as(OWNER))).json();
  check('an upload for krea2 is not offered on illustrious', io.workflow_id === null && io.workflows.length === 1);

  const r3 = await render(OWNER, { model: 'krea2', workflow: wfEntry.id, positive: 'mine', settings: { ...GOOD, model_file: 'krea2_turbo_fp8_scaled.safetensors', steps: 8, cfg: 1 } });
  check('a render through your own workflow finishes', r3.events.some(([e]) => e === 'done'), r3.events.map(([e]) => e).join());
  const s3 = seen.prompts.at(-1)?.prompt ?? {};
  check('ComfyUI ran the uploaded graph', s3[mapWorkflow(s3).save]?.inputs?.filename_prefix === 'MINE/krea2');

  // One waiting for approval cannot run, and shows up for the owner.
  const ownerRender = createUserRender(ROOT, { paths: { users: usersDir } });
  const waiting = ownerRender.addWorkflow(OWNER, { name: 'Waits', models: ['krea2'], api: upload, approved: false }, { modelKeys: ['krea2'] });
  const blocked = await render(OWNER, { model: 'krea2', workflow: waiting.id, positive: 'x', settings: { ...GOOD, model_file: 'krea2_turbo_fp8_scaled.safetensors' } });
  check('a workflow waiting for approval does not run', blocked.status === 403 && blocked.body?.error === 'awaiting_approval', JSON.stringify(blocked.body));
  const stPending = await (await fetch(`${BASE}/api/status`, as(OWNER))).json();
  check('the owner\'s status counts the workflow waiting', stPending.render_pending === 1, String(stPending.render_pending));
  const stFriend = await (await fetch(`${BASE}/api/status`, as('friend'))).json();
  check('...and nobody else\'s does', stFriend.render_pending === 0, String(stFriend.render_pending));
  const pendList = (await (await fetch(`${BASE}/api/admin/render`, as(OWNER))).json()).pending ?? [];
  check('the owner sees it waiting, with its node types', pendList.some((p) => p.id === waiting.id && p.node_types.includes('KSampler')));
  const approve = await fetch(`${BASE}/api/admin/render/approve`, as(OWNER, { method: 'PUT', body: JSON.stringify({ user: OWNER, id: waiting.id, approve: true }) }));
  check('the owner approves it', approve.status === 200 && !(await approve.json()).pending.some((p) => p.id === waiting.id));
  const approveDenied = await fetch(`${BASE}/api/admin/render/approve`, as('friend', { method: 'PUT', body: JSON.stringify({ user: OWNER, id: waiting.id, approve: true }) }));
  check('nobody else can approve', approveDenied.status === 403);

  // Presets of your own.
  const sp = await fetch(`${BASE}/api/render/presets`, as(OWNER, { method: 'POST', body: JSON.stringify({ name: 'soft dusk', model: 'krea2', steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple' }) }));
  check('you save a preset of your own', sp.status === 201);
  const po = await (await fetch(`${BASE}/api/render/options?model=krea2`, as(OWNER))).json();
  check('...and it comes back with the options', po.my_presets?.some((p) => p.name === 'soft dusk' && p.steps === 20));
  const dp = await fetch(`${BASE}/api/render/presets`, as(OWNER, { method: 'DELETE', body: JSON.stringify({ model: 'krea2', name: 'soft dusk' }) }));
  check('...and delete it', dp.status === 200);
  const dw = await fetch(`${BASE}/api/render/workflows/${wfEntry.id}`, as(OWNER, { method: 'DELETE' }));
  check('you delete your workflow', dw.status === 200);
  const gone = await (await fetch(`${BASE}/api/render/options?model=krea2&workflow=${wfEntry.id}`, as(OWNER))).json();
  check('...and asking for it falls back to the starter', gone.workflow_id === null && gone.available === true);

  // ── render from chat ──
  const chatTurn = async (user, body) => {
    const res = await fetch(`${BASE}/api/chat`, as(user, { method: 'POST', body: JSON.stringify(body) }));
    const text = await res.text();
    return text.split('\n\n').map((f) => [/^event: (.+)$/m.exec(f)?.[1], /^data: (.+)$/m.exec(f)?.[1]])
      .filter(([e, d]) => e && d).map(([e, d]) => [e, JSON.parse(d)]);
  };
  const before = seen.prompts.length;
  const gensBefore = llmSeen.generations;
  const c1 = await chatTurn(OWNER, { message: 'make me a picture of a lighthouse on krea2' });
  const chatId = c1.find(([e]) => e === 'chat')?.[1]?.id;
  check('chat is offered render_picture beside write_prompt', llmSeen.chats.at(-1)?.tools.join() === 'write_prompt,render_picture,edit_picture', JSON.stringify(llmSeen.chats.at(-1)));
  const renderEv = c1.find(([e]) => e === 'render')?.[1];
  check('a chat turn renders a picture', Boolean(renderEv?.url) && seen.prompts.length === before + 1, c1.map(([e, d]) => e + (e === 'error' ? `:${d.message}` : '')).join());
  check('...with the prompt the model\'s own writer wrote', seen.prompts.at(-1)?.prompt?.[mapWorkflow(seen.prompts.at(-1).prompt).positive]?.inputs?.text === 'A lighthouse on a cliff at dusk, waves below.');
  check('...one generation, then one render', llmSeen.generations === gensBefore + 1);
  check('the progress reaches the chat', c1.some(([e]) => e === 'render_progress') && c1.some(([e, d]) => e === 'status' && d.state === 'rendering'));
  const done1 = c1.find(([e]) => e === 'done')?.[1];
  check('the reply carries the prompt and how it was made', /A lighthouse on a cliff/.test(done1?.content ?? '') && /Rendered with Krea2/.test(done1?.content ?? ''), done1?.content);
  const stored = await (await fetch(`${BASE}/api/chat/${chatId}`, as(OWNER))).json();
  const last = stored.messages?.at(-1);
  check('the conversation keeps the picture\'s link and its prompt', last?.render?.url === renderEv?.url && last?.tool?.positive === 'A lighthouse on a cliff at dusk, waves below.', JSON.stringify(last?.render));

  const c2 = await chatTurn(OWNER, { id: chatId, message: 'render that again' });
  check('"render that again" draws the same prompt without rewriting it',
    llmSeen.generations === gensBefore + 1 && seen.prompts.at(-1)?.prompt?.[mapWorkflow(seen.prompts.at(-1).prompt).positive]?.inputs?.text === 'A lighthouse on a cliff at dusk, waves below.',
    `generations ${llmSeen.generations - gensBefore}`);
  check('...as a new picture', c2.find(([e]) => e === 'render')?.[1]?.id && c2.find(([e]) => e === 'render')[1].id !== renderEv?.id);

  // Someone without the grant is never offered the tool.
  // (The stub records a chat only when render_picture is in its tools.)
  const offeredBefore = llmSeen.chats.length;
  await chatTurn('friend', { message: 'make me a picture' });
  check('without the render grant, chat has no render_picture', llmSeen.chats.length === offeredBefore, String(llmSeen.chats.length - offeredBefore));

  // ── picture edits ──
  const editReq = async (user, body) => {
    const res = await fetch(`${BASE}/api/edit`, as(user, { method: 'POST', body: JSON.stringify(body) }));
    if (!res.ok) return { status: res.status, body: await res.json(), events: [] };
    const text = await res.text();
    return {
      status: res.status,
      events: text.split('\n\n').map((f) => [/^event: (.+)$/m.exec(f)?.[1], /^data: (.+)$/m.exec(f)?.[1]])
        .filter(([e, d]) => e && d).map(([e, d]) => [e, JSON.parse(d)]),
    };
  };
  const PIC = { type: 'image/png', data: PNG.toString('base64') };
  check('edit options are refused without the grant', (await fetch(`${BASE}/api/edit/options`, as('friend'))).status === 403);
  const eo = await (await fetch(`${BASE}/api/edit/options`, as(OWNER))).json();
  check('edit options name the editor', eo.available === true && eo.label === 'Qwen Image 2.1' && eo.max_pictures === 4, JSON.stringify(eo));
  check('edit options carry the About text from config', /Qwen Image 2\.1/.test(eo.about?.summary ?? '') && eo.about?.smaller?.length > 0, JSON.stringify(eo.about));
  const teNames = (eo.files?.text_encoder ?? []).map((f) => f.file);
  check('edit options list installed text encoders that match, the workflow\'s first',
    teNames[0] === eo.defaults?.text_encoder && teNames.includes('qwen3vl_8b_w4a8.safetensors') && !teNames.includes('other_te.safetensors'), JSON.stringify(eo.files));
  check('...but not another model\'s Qwen3-VL (Krea2\'s 4B)', !teNames.includes('qwen3vl_4b_fp8_scaled.safetensors'), JSON.stringify(eo.files));
  check('...each with a size slot (none here: this ComfyUI\'s folder is not on disk)', (eo.files?.text_encoder ?? []).every((f) => 'gb' in f && f.gb === null));
  // The templates: the editor's workflow, and a render model's starter.
  const ewf = await fetch(`${BASE}/api/edit/workflow`, as(OWNER));
  check('the edit workflow downloads as an attachment', ewf.status === 200 && /attachment; filename="promptforge-qwen-image-edit.json"/.test(ewf.headers.get('content-disposition') ?? '') &&
    Object.values(await ewf.json()).some((n) => n.class_type === 'TextEncodeQwenImage21'));
  check('...not without the grant', (await fetch(`${BASE}/api/edit/workflow`, as('friend'))).status === 403);
  const tpl = await fetch(`${BASE}/api/render/starter?model=krea2`, as(OWNER));
  check('a render model\'s workflow downloads as a template, in the ComfyUI layout', tpl.status === 200 &&
    /promptforge-krea2\.json/.test(tpl.headers.get('content-disposition') ?? '') && Array.isArray((await tpl.json()).nodes));
  check('...a model with no workflow is a 404', (await fetch(`${BASE}/api/render/starter?model=h3`, as(OWNER))).status === 404);
  check('...and not without the grant', (await fetch(`${BASE}/api/render/starter?model=krea2`, as('friend'))).status === 403);
  check('a file that is not on offer is a 400', (await editReq(OWNER, { instruction: 'x', pictures: [PIC], files: { model: 'krea2_turbo_fp8_scaled.safetensors' } })).status === 400);
  const ePick = await editReq(OWNER, { instruction: 'x', pictures: [PIC], as_written: true, files: { text_encoder: 'qwen3vl_8b_w4a8.safetensors' } });
  check('a picked text encoder reaches ComfyUI', ePick.events.some(([e]) => e === 'done') &&
    Object.values(seen.prompts.at(-1)?.prompt ?? {}).find((n) => n.class_type === 'CLIPLoader')?.inputs?.clip_name === 'qwen3vl_8b_w4a8.safetensors');
  check('an edit with no instruction is a 400', (await editReq(OWNER, { instruction: ' ', pictures: [PIC] })).status === 400);
  check('an edit with no picture is a 400', (await editReq(OWNER, { instruction: 'x', pictures: [] })).status === 400);
  check('a GIF is a 400 that names what works', /PNG, JPEG or WebP/.test((await editReq(OWNER, { instruction: 'x', pictures: [{ type: 'image/gif', data: 'R0lG' }] })).body?.message ?? ''));
  check('five pictures is a 400', (await editReq(OWNER, { instruction: 'x', pictures: [PIC, PIC, PIC, PIC, PIC] })).status === 400);

  const upBefore = seen.uploads.length;
  const e1 = await editReq(OWNER, { instruction: 'make her jacket red', pictures: [PIC, PIC], marked: true });
  const eDone = e1.events.find(([e]) => e === 'done')?.[1];
  check('an edit finishes', Boolean(eDone), e1.events.map(([e, d]) => e + (e === 'error' ? `:${d.message}` : '')).join());
  check('...the writer saw both pictures and was told about the marks', llmSeen.edits.at(-1)?.images === 2 && /red marks/.test(llmSeen.edits.at(-1)?.text ?? ''), JSON.stringify(llmSeen.edits.at(-1)));
  check('...the written instruction streams before the picture, as one paragraph',
    e1.events.find(([e]) => e === 'prompt')?.[1]?.text === 'Change the jacket to deep red leather. Keep her face and the street unchanged.');
  const eSent = seen.prompts.at(-1)?.prompt ?? {};
  const eEnc = Object.values(eSent).find((n) => n.class_type === 'TextEncodeQwenImage21');
  check('...ComfyUI got that instruction and both uploads', eEnc?.inputs?.prompt === eDone?.prompt && seen.uploads.length === upBefore + 2 &&
    eSent[eEnc.inputs['images.image_1']?.[0]]?.inputs?.image === `promptforge/${seen.uploads[upBefore]}`, JSON.stringify(eEnc?.inputs));
  check('...and the picture comes back like a render', (await fetch(`${BASE}${eDone?.url}`, as(OWNER))).status === 200);
  const e2 = await editReq(OWNER, { instruction: 'Turn the sky purple.', pictures: [PIC], as_written: true });
  const e2Sent = Object.values(seen.prompts.at(-1)?.prompt ?? {}).find((n) => n.class_type === 'TextEncodeQwenImage21');
  check('"as written" skips the writer and sends the words', e2.events.some(([e]) => e === 'done') && e2Sent?.inputs?.prompt === 'Turn the sky purple.' && llmSeen.edits.length === 1);
  // This stub ComfyUI has no speed LoRA installed, so only Full is offered.
  check('the 4-step preset is not offered without its LoRA installed', eo.presets?.map((p) => p.name).join() === 'Full · 25 steps', JSON.stringify(eo.presets));
  check('...an edit with no preset runs the default at its steps', Object.values(seen.prompts.at(-1)?.prompt ?? {}).find((n) => n.class_type === 'KSampler')?.inputs?.steps === 25);
  check('...and asking for Fast anyway is a 400', (await editReq(OWNER, { instruction: 'x', pictures: [PIC], preset: 'Fast · 4 steps' })).status === 400);

  // Edit from chat: the picture sent, then "now make it…" on the result.
  const ec1 = await chatTurn(OWNER, { message: 'make it night time', pictures: [PIC] });
  const ecId = ec1.find(([e]) => e === 'chat')?.[1]?.id;
  const ecEv = ec1.find(([e]) => e === 'edit')?.[1];
  check('chat edits the picture it was sent', Boolean(ecEv?.url) && llmSeen.editCalls.length === 1, ec1.map(([e, d]) => e + (e === 'error' ? `:${d.message}` : '')).join());
  check('...and keeps it with the conversation, not as a render', /^\/api\/chat\/.+\/pictures\/p_[a-f0-9]{24}\.png$/.test(ecEv?.url ?? ''), ecEv?.url);
  check('...served to whoever owns the conversation', (await fetch(`${BASE}${ecEv?.url}`, as(OWNER))).status === 200);
  check('...and to nobody else', (await fetch(`${BASE}${ecEv?.url}`, as('friend'))).status === 404);
  const ecStored = (await (await fetch(`${BASE}/api/chat/${ecId}`, as(OWNER))).json()).messages?.at(-1);
  check('the stored reply carries the picture and the instruction', ecStored?.edit?.url === ecEv?.url && /deep red leather/.test(ecStored?.content ?? ''), JSON.stringify(ecStored?.edit));
  const upChat = seen.uploads.length;
  const editedBefore = seen.uploadedEdits ?? 0;
  const ec2 = await chatTurn(OWNER, { id: ecId, message: 'now make it snow' });
  check('a second edit works on the last result, not the picture sent',
    ec2.some(([e]) => e === 'edit') && seen.uploads.length === upChat + 1 && seen.uploadedEdits === editedBefore + 1, ec2.map(([e]) => e).join());
  const ecDel = await fetch(`${BASE}/api/chat/${ecId}`, as(OWNER, { method: 'DELETE' }));
  check('deleting the conversation deletes its pictures', ecDel.status === 200 && (await fetch(`${BASE}${ecEv?.url}`, as(OWNER))).status === 404);
  const ecNone = await chatTurn(OWNER, { message: 'make it brighter' });
  check('with no picture in the conversation, chat says so', /no picture in this conversation/.test(ecNone.find(([e]) => e === 'done')?.[1]?.content ?? ''));

  // ── what the GPU panel is told about ComfyUI ──
  seen.outside = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors' } },
    2: { class_type: 'MiniMaxH3Director', inputs: {} },
  };
  await new Promise((r) => setTimeout(r, 2100)); // past the activity cache
  const st = await (await fetch(`${BASE}/api/status`, as(OWNER))).json();
  check('status says ComfyUI is making an MMH3 video, started outside PromptForge',
    st.comfyui?.busy?.model === 'MMH3' && st.comfyui.busy.kind === 'video' && st.comfyui.busy.source === 'outside' && st.comfyui.busy.user === null,
    JSON.stringify(st.comfyui));
  seen.outside = null;
  await new Promise((r) => setTimeout(r, 2100));
  const idle = await (await fetch(`${BASE}/api/status`, as(OWNER))).json();
  check('...and idle once it is done', idle.comfyui?.up === true && idle.comfyui.busy === null, JSON.stringify(idle.comfyui));

  // ComfyUI refusing the workflow names the node and the input.
  seen.refuse = true;
  const refused = await render(OWNER, { model: 'krea2', positive: 'x', settings: GOOD });
  seen.refuse = false;
  const err = refused.events.find(([e]) => e === 'error')?.[1];
  check('a refused workflow is an error event naming the node', /UNETLoader.*missing\.safetensors/.test(err?.message ?? ''), JSON.stringify(err));

  // Clearing the history deletes the renders now.
  const del = await (await fetch(`${BASE}/api/render`, as(OWNER, { method: 'DELETE' }))).json();
  check('clearing deletes this person\'s renders', del.deleted >= 1, JSON.stringify(del));
  check('...and the picture is gone', (await fetch(`${BASE}${done?.url}`, as(OWNER))).status === 404);
} catch (err) {
  failures.push(`suite threw — ${err.message}`);
} finally {
  app.kill();
  stub.close();
  llmStub.close();
  for (const s of sockets) s.destroy();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('render');
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(failures.length ? `\n${failures.length} of ${passed + failures.length} FAILED` : `ok, ${passed} assertions`);
process.exit(failures.length ? 1 : 0);
