// PromptForge — entry point.
//
// node:http, no framework. This runs on one box for five friends; it does not
// need a routing abstraction. The one place genuine indirection exists is the
// LLM backend, because the migration path depends on it.

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, statSync, createReadStream, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { promptToolFor, promptToolArgs, promptReply, renderToolFor, renderToolArgs, renderSizeArgs, renderReply, editToolFor, editToolArgs, editReply } from './server/chat-prompt-tool.mjs';
import YAML from 'yaml';

import { loadRegistry, RegistryError } from './server/registry.mjs';
import { createPromptStore, runtimeContext } from './server/prompts.mjs';
import {
  formatReferences,
  referenceGroundingWarnings,
  groupWarnings,
  resolveAutoControls,
  limitsFor,
  MODE_LIMITS,
  CLIP_SECONDS,
  TOTAL_SECONDS,
  LANE_LIMITS,
  ROLE_LABEL,
  STREAM_MODES,
  labelsFor,
} from './server/references.mjs';
import { musicOnlyWhenAsked } from './server/music.mjs';
import { loadCaptionStyles, loadLoraTypes, publicStyles, publicLoraTypes, captionInstructions, parseExclude, finishCaption, captionRequest, closestTag } from './server/captions.mjs';
import { shotsLine, shotCountWarning, repairCutTimes, foldShotBriefs } from './server/shots.mjs';
import { applyPictureLabels, promptMode, usesLabels, labelledCast, labelledBrief, labelledLines, labelledSegments, keepReferenceLook, describeUnits, describeMessage, framedBrief, givenCast, castDescriptions, unitsToRead, castUnit, sceneUnit, castLook, framedCastLines, characterCards } from './server/picture-labels.mjs';
import { cropImage, pictureSize, parsePeople, FIND_PEOPLE_PROMPT } from './server/people-boxes.mjs';
// Reference images on the image models. A separate formatter from the one
// above on purpose — that one answers to the MiniMax Director, this one to the
// image prompt files. See the note at the top of server/imagerefs.mjs.
import { formatImageReferences, orderReferences } from './server/imagerefs.mjs';
// The look-first half of the reference pipeline. One call reads the pictures
// under their roles, the pictures come off the wire, and the compile call
// writes from the text. See the header of server/refblueprint.mjs.
import {
  BLUEPRINT_TEMPERATURE,
  BLUEPRINT_RULE,
  blueprintBudget,
  buildBlueprintMessage,
  blueprintUsable,
  referenceAnalysisIdentity,
  reusableReferenceAnalysis,
  referenceLabelLeaks,
  stripFence,
} from './server/refblueprint.mjs';
import { ROLE_CARRIES_CHARACTER } from './web/appearance.js';
import {
  directorBlocks,
  expectedSegments,
  segmentsOutsideMode,
  directorLines,
  directorKeyframes,
  fixDirectorSeams,
} from './server/director.mjs';
import { simplePrompt } from './server/h3-simple.mjs';
import {
  KEYFRAME_TEMPERATURE,
  KEYFRAME_BUDGET,
  createKeyframeCache,
  keyframeHash,
  keyframeLines,
  keyframeMessage,
  usableReading,
} from './server/keyframes.mjs';
import {
  PICTURE_TEMPERATURE,
  PICTURE_BUDGET,
  readingUnits,
  readingHash,
  readingMessage,
  readingLines,
  givenReading,
} from './server/picture-readings.mjs';
import { probeMedia, sampleFrames, mediaTools, transcodeImage } from './server/media.mjs';
import { createLLM, chooseModel, probeModels, speedOf, LLMError, ERR } from './server/llm.mjs';
import { createQueue } from './server/queue.mjs';
import { SegmentStream, SegmentParseError, parseSegments, segmentPlan, optionalSegments, omitFor } from './server/segments.mjs';
import { createTagStore } from './server/tags.mjs';
import { createToolbox } from './server/tools.mjs';
import { createGuidance } from './server/guidance.mjs';
import { createCandidateFinder } from './server/candidates.mjs';
import { createLexicon } from './server/lexicon.mjs';
import { tagPass, loadModifierVocabulary } from './server/tagpass.mjs';
import { createVisionTags } from './server/visiontags.mjs';
import { createBenchmarks } from './server/benchmarks.mjs';
import { createTraitStore } from './server/traits.mjs';
import { resolveCharacters, characterBlock, findCustomCharacters, customCharacterBlock } from './server/character.mjs';
// Lives under web/ because the reference card's chips grey themselves with the
// same list this strips with, and the browser can only fetch what is served.
// See its header for where the line between a trait and furniture sits.
import { splitAppearance, isGarment, isProp, withoutCostumeBody } from './web/appearance.js';
// Preferences moved out on 26 Aug 2026, when `language` was added and the
// count made the split obvious: storage.mjs defined seven and this file
// accepted four, with the other three storing nothing at all. The list of
// keys nothing accepts is explicit and tested now — see server/preferences.mjs.
import { validatePreferences, CHAT_TEMPERATURE_RANGE, CUSTOM_INSTRUCTION_MAX, LANGUAGES, THEMES, FONTS, TEXT_SIZES, REFERENCE_ANALYSIS } from './server/preferences.mjs';
import { cleanNegative, ensureDefaults, capExtras } from './server/negative.mjs';
import { cleanPositive } from './server/positive.mjs';
import { spaceUnderscores } from './server/tagspacing.mjs';
import { escapeLiteralParens } from './server/parens.mjs';
import { stripAspect } from './server/aspect.mjs';
import { layoutLines, tidyLayout, rewriteMessages } from './server/layout.mjs';
import { createTaggerStore } from './server/taggers.mjs';
import { createStorage, safeUsername } from './server/storage.mjs';
import { createSharedImages } from './server/sharedimages.mjs';
import { editSettings, editPresets, editSystemPrompt, editUserText, cleanEditPrompt, fillEditWorkflow, fromDataUrl, editWorkflowFiles, editFileChoices, EDIT_SEGMENT } from './server/imageedit.mjs';
import { freeOtherComfyUIs, explainLoadFailure, describeHolder } from './server/gpu-holders.mjs';
import { createComfy,mapWorkflow, workflowDefaults, validateSettings, fillWorkflow, composePositive, loraMatches, MAX_LORAS, RESOLUTION_TIERS, sizeFor, nativeSizeFor } from './server/comfyui.mjs';
import { createRenderModels } from './server/rendermodels.mjs';
import { createUserRender } from './server/userrender.mjs';
import { readComfyMetadata } from './server/comfymeta.mjs';
import { createWeightLinks } from './server/weightlinks.mjs';
import { createRequestStore } from './server/requests.mjs';
import { createTraining } from './server/training.mjs';
import { createUsageStore } from './server/usage.mjs';
import { rebaseDataPaths } from './server/paths.mjs';
import { createRandomizer } from './server/randomizer.mjs';
import { createSysmon } from './server/sysmon.mjs';
import { loadConfig } from './server/config.mjs';
import { createRuntimeSettings, parseKeepAlive, keepAliveLabel, KEEP_ALIVE_PRESETS, createIdleOffload } from './server/keepalive.mjs';
import { createVersionWatch } from './server/version.mjs';
import { createSearch } from './server/search.mjs';
import * as chatPictures from './server/chatpictures.mjs';
import { createAuth, SESSION_COOKIE } from './server/auth.mjs';
import { loadTlsCredentials } from './server/certs.mjs';
import { createTaggerSetup } from './server/taggersetup.mjs';
import { createFeatureSetup, findComfy, cleanUrl } from './server/featuresetup.mjs';
import { createBenchRunner } from './server/benchrun.mjs';
import { createCharCast } from './server/charcast.mjs';
import { createMetrics } from './server/metrics.mjs';
import { getGrafanaUrl } from './server/grafana.mjs';
import { pastedStyle, styleInstruction, stripStyle, pasteStyle } from './server/style.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Per-model system_prompt swaps from PROMPTFORGE_PROMPTS, filled while the
// server config is read and consumed by loadRegistry below. Empty in every
// normal run — this exists so "how much of this prompt file is load-bearing"
// can be measured without editing the tracked registry on a live box.
const promptOverrides = new Map();

// ─────────────────────────────── boot ───────────────────────────────

// True when server.local.yaml names this machine's LLM server. Together with
// a saved data/backend.json it is what "already set up" means: the first-run
// setup opens for the owner only when neither exists, so a box configured the
// old way (the P40) never sees it.
let localLlmConfigured = false;
// Same idea for who can connect: server.local.yaml naming server.bind (the
// P40 does) outranks the "Let other devices connect" switch.
let localBindConfigured = false;
// Every key server.local.yaml set, so the ComfyUI and LoRA training choices
// from the setup wizard can stand aside for a block set there by hand.
let localServerKeys = [];

function loadServerConfig() {
  const { config, applied, error } = loadConfig(ROOT, 'server');
  if (error || !config) {
    console.error(`FATAL: ${error ?? 'config/server.yaml could not be read'}`);
    process.exit(1);
  }
  // Named, not counted. "3 overrides applied" on a box behaving oddly is the
  // start of an investigation; the list is the end of one.
  if (applied.length) {
    console.log(`[config] server.local.yaml applied: ${applied.join(', ')}`);
  }
  localLlmConfigured = applied.some((k) => k === 'llm.backend' || k === 'llm.base_url');
  localBindConfigured = applied.includes('server.bind');
  localServerKeys = applied;
  return config;
}

/**
 * config/taggers.yaml is optional. Unlike server.yaml, its absence is not
 * fatal — it only powers Tab 3, and a box without the ONNX weights should
 * still run everything else.
 */
// Which tagger keys taggers.local.yaml set, so the Setup panel can say "set
// in taggers.local.yaml" rather than offer to change them.
let localTaggerKeys = [];

function loadTaggerConfig() {
  const { config, applied, error } = loadConfig(ROOT, 'taggers');
  if (error) {
    // Not fatal, unlike server.yaml: this only powers Tab 3, and a box without
    // the ONNX weights should still run everything else.
    console.warn(`[taggers] ${error} — image analysis disabled`);
    return config ?? {};
  }
  if (applied.length) {
    console.log(`[config] taggers.local.yaml applied: ${applied.join(', ')}`);
  }
  localTaggerKeys = applied;
  // Paths the owner found or downloaded from the Setup panel, below
  // taggers.local.yaml and above the shared defaults.
  return taggerSetup.apply(config ?? {}, applied);
}

/**
 * Env overrides for the llm block, so a throwaway run can point at a
 * different backend or model without editing config/server.yaml. The cross
 * platform rules call for process.env with defaults; this is that. The file
 * stays the source of truth for the real deployment.
 *
 *   PROMPTFORGE_LLM_BACKEND=ollama PROMPTFORGE_LLM_MODEL=qwen3:1.7b npm start
 */
function applyEnvOverrides(config) {
  const llm = (config.llm ??= {});
  const map = {
    PROMPTFORGE_LLM_BACKEND: 'backend',
    PROMPTFORGE_LLM_MODEL: 'model',
    PROMPTFORGE_LLM_BASE_URL: 'base_url',
  };
  const applied = [];
  for (const [env, key] of Object.entries(map)) {
    if (process.env[env]) {
      llm[key] = process.env[env];
      applied.push(`${key}=${llm[key]}`);
    }
  }
  if (process.env.PROMPTFORGE_LLM_CONTEXT) {
    llm.context_length = Number(process.env.PROMPTFORGE_LLM_CONTEXT);
    applied.push(`context_length=${llm.context_length}`);
  }
  // Bind address. The one server-block setting that genuinely differs between
  // this box and the deployment box, and the reason it is here as well as in
  // the local config file is that a one-off LAN test should not mean editing
  // anything: PROMPTFORGE_BIND=0.0.0.0 npm start.
  if (process.env.PROMPTFORGE_BIND) {
    (config.server ??= {}).bind = process.env.PROMPTFORGE_BIND;
    applied.push(`bind=${config.server.bind}`);
  }
  // Port override so a test run can stand up its own server without
  // colliding with the one the user already has open on 8090.
  if (process.env.PROMPTFORGE_PORT) {
    (config.server ??= {}).port = Number(process.env.PROMPTFORGE_PORT);
    applied.push(`port=${config.server.port}`);
  }
  // PROMPTFORGE_MODEL_DEFAULTS=h3=some-model,wan=other - llm.model_defaults
  // from the environment, so a test can pin a target without a local file.
  if (process.env.PROMPTFORGE_MODEL_DEFAULTS) {
    const llm = (config.llm ??= {});
    llm.model_defaults = { ...(llm.model_defaults ?? {}) };
    for (const pair of process.env.PROMPTFORGE_MODEL_DEFAULTS.split(',')) {
      const at = pair.indexOf('=');
      if (at > 0) llm.model_defaults[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    applied.push(`model_defaults=${Object.keys(llm.model_defaults).join('+')}`);
  }
  // PROMPTFORGE_TLS=1 turns the HTTPS listener on - the container sets it,
  // since a compose file cannot reach into server.local.yaml.
  if (process.env.PROMPTFORGE_TLS) {
    ((config.server ??= {}).tls ??= {}).enabled = !['0', 'off', 'false'].includes(process.env.PROMPTFORGE_TLS);
    applied.push(`tls=${config.server.tls.enabled}`);
  }
  // PROMPTFORGE_AUTH=off drops back to the pre-auth header user model. The
  // suites that predate accounts (smoke, test-library) run that way, so
  // adding login did not require rewriting tests that were never about it.
  if (process.env.PROMPTFORGE_AUTH) {
    (config.auth ??= {}).enabled = !/^(off|false|0|no)$/i.test(process.env.PROMPTFORGE_AUTH);
    applied.push(`auth=${config.auth.enabled ? 'on' : 'off'}`);
  }
  // Which models can see pictures, comma-separated. For the test suites:
  // without it, a box whose server.local.yaml lists its own vision models
  // makes the suites' stub model blind, and the edit tests fail there only.
  if (process.env.PROMPTFORGE_VISION_MODELS !== undefined) {
    (config.reference_vision ??= {}).vision_models = process.env.PROMPTFORGE_VISION_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
    applied.push(`vision_models=${config.reference_vision.vision_models.join('|')}`);
  }
  // The whole data directory, subtree included — accounts, the queue, model
  // requests, the run counter, training. Without this a test run rewrites the
  // real one.
  //
  // It moves the subtree because config names every path under `data/`
  // literally rather than joining it against `paths.data`, so rewriting
  // `paths.data` alone moved nothing anyone actually writes. See
  // server/paths.mjs — that bug is why the usage panel spent two days
  // reporting the test suite as its heaviest user.
  //
  // Applied BEFORE the two specific overrides below, so naming one of those
  // still wins.
  if (process.env.PROMPTFORGE_DATA_DIR) {
    const { moved } = rebaseDataPaths(
      (config.paths ??= {}),
      process.env.PROMPTFORGE_DATA_DIR,
      ROOT
    );
    // The moved keys by name. "data_dir=/tmp/x" on a box writing to the wrong
    // place is the start of an investigation; the list is the end of one.
    applied.push(
      `data_dir=${config.paths.data}${moved.length ? ` (+${moved.join(', ')})` : ''}`
    );
  }
  // So an auth test run writes accounts into a throwaway directory instead of
  // into the real data/users/ beside people's saved prompts.
  if (process.env.PROMPTFORGE_USERS_DIR) {
    (config.paths ??= {}).users = process.env.PROMPTFORGE_USERS_DIR;
    applied.push(`users_dir=${config.paths.users}`);
  }
  // Same reasoning for model requests: they are box-wide rather than per-user,
  // so a test run that submitted one would otherwise leave it sitting in the
  // owner's real list.
  if (process.env.PROMPTFORGE_REQUESTS_DIR) {
    (config.paths ??= {}).requests = process.env.PROMPTFORGE_REQUESTS_DIR;
    applied.push(`requests_dir=${config.paths.requests}`);
  }
  // Rendering on, against the ComfyUI at this URL — a stub in the render
  // suite. Never starts one (no dir), and turns the feature on only here.
  if (process.env.PROMPTFORGE_COMFYUI) {
    config.comfyui = { ...(config.comfyui ?? {}), enabled: true, url: process.env.PROMPTFORGE_COMFYUI, dir: '' };
    applied.push(`comfyui=${config.comfyui.url}`);
  }
  // Search off, so a test suite never reaches the network. The suites must run
  // on a box with no internet and give the same answer either way.
  if (process.env.PROMPTFORGE_SEARCH) {
    (config.search ??= {}).enabled = !/^(off|false|0|no)$/i.test(process.env.PROMPTFORGE_SEARCH);
    applied.push(`search=${config.search.enabled ? 'on' : 'off'}`);
  }
  // Tool calling on or off for the whole box, because the question of whether
  // it beats a bigger prompt file is decided by running the same briefs both
  // ways — and switching that with a config edit between arms is how a
  // measurement gets attributed to the wrong run.
  // Which house rules this box runs on. `v2` is the lean rewrite from 30 Aug
  // 2026 — same contract, 804 words against 1,090, and it opens with the job
  // instead of the prohibitions. Anything else is taken as a path, so a third
  // variant needs no code change.
  //
  // The shipped file stays the default and stays untouched. Reverting is this
  // variable going away, or one line in config/server.yaml.
  if (process.env.PROMPTFORGE_HOUSE_RULES) {
    const want = process.env.PROMPTFORGE_HOUSE_RULES;
    const rel =
      want === 'v2'
        ? 'prompts/_shared/house-rules-v2.md'
        : want === 'v1' || want === 'og'
          ? 'prompts/_shared/house-rules.md'
          : want;
    (config.prompts ??= {}).shared_prefix = rel;
    applied.push(`house_rules=${rel}`);
  }
  // Swap a model's system prompt file without editing config/models.yaml.
  //
  //   PROMPTFORGE_PROMPTS="illustrious=prompts/image/illustrious-min.md"
  //
  // Comma-separated `key=path` pairs. Added 2 Sep 2026 for the same reason
  // the house-rules switch exists: the question "how much of this file is
  // load-bearing" can only be answered by running the model against a shorter
  // one, and that must not mean editing the tracked registry on a live box.
  //
  // Applied to the raw config here rather than to the loaded registry, so
  // registry.mjs still validates the substitute the same way — a min file
  // whose segments disagree with models.yaml fails at boot, loudly, instead
  // of halfway through a measurement.
  if (process.env.PROMPTFORGE_PROMPTS) {
    for (const pair of process.env.PROMPTFORGE_PROMPTS.split(',')) {
      const [key, ...rest] = pair.split('=');
      const path = rest.join('=').trim();
      if (!key?.trim() || !path) continue;
      promptOverrides.set(key.trim(), path);
      applied.push(`prompt[${key.trim()}]=${path}`);
    }
  }
  // The global generation timeout. Only h3 overrides it in config/models.yaml,
  // and 120s is right for a deployment — a request that has hung should fail
  // rather than hold the card. It is wrong for reading output: a 27B at ~9
  // tokens a second on the P40 hits it mid-prompt on anima, and a truncated
  // answer is exactly the thing that cannot be judged.
  if (process.env.PROMPTFORGE_LLM_TIMEOUT) {
    (config.llm ??= {}).timeout_ms = Number(process.env.PROMPTFORGE_LLM_TIMEOUT);
    applied.push(`llm_timeout=${config.llm.timeout_ms}`);
  }
  if (process.env.PROMPTFORGE_CANDIDATES) {
    (config.candidates ??= {}).enabled = !/^(off|false|0|no)$/i.test(
      process.env.PROMPTFORGE_CANDIDATES
    );
    applied.push(`candidates=${config.candidates.enabled ? 'on' : 'off'}`);
  }
  if (process.env.PROMPTFORGE_TOOLS) {
    (config.tools ??= {}).enabled = !/^(off|false|0|no)$/i.test(process.env.PROMPTFORGE_TOOLS);
    applied.push(`tools=${config.tools.enabled ? 'on' : 'off'}`);
  }
  // The look-first reference pass, off. Same shape as the two above and there
  // for the same reason: it is a whole extra generation, so "what does this
  // actually cost" has to be answerable by running the same brief twice on
  // the same box rather than by editing config between the two runs.
  //
  // Off means the pictures go with the compile call, which is what this did
  // before 8 Sep 2026 — a working path, not a broken one.
  if (/^(off|false|0|no)$/i.test(process.env.PROMPTFORGE_REFERENCE_BLUEPRINT ?? '')) {
    (config.prompts ??= {}).reference_blueprint = '';
    applied.push('reference_blueprint=off');
  }
  if (applied.length) console.log(`[config] env overrides: ${applied.join(', ')}`);
  return config;
}

const config = applyFeatureChoices(applyNetworkChoice(applyEnvOverrides(loadServerConfig())));

/**
 * Rendering and LoRA training as switched on from the setup wizard or the
 * Setup panel (4 Oct 2026), from data/comfyui.json and data/training.json.
 * Below server.local.yaml, and PROMPTFORGE_COMFYUI (the render suite's stub)
 * outranks the saved ComfyUI choice. See server/featuresetup.mjs.
 */
function applyFeatureChoices(cfg) {
  const setup = createFeatureSetup({ rootDir: ROOT, dataDir: cfg.paths?.data ?? 'data' });
  return setup.apply(cfg, process.env.PROMPTFORGE_COMFYUI ? [...localServerKeys, 'comfyui'] : localServerKeys);
}
const featureSetup = createFeatureSetup({ rootDir: ROOT, dataDir: config.paths?.data ?? 'data' });
// Where each optional feature is set, for the Setup panel: here, or by hand.
function featureSource(block) {
  if (block === 'comfyui' && process.env.PROMPTFORGE_COMFYUI) return 'environment';
  if (localServerKeys.some((k) => k === block || k.startsWith(`${block}.`))) return 'local_config';
  return featureSetup.exists(block) ? 'setting' : 'default';
}

/**
 * "Let other devices connect" - the one setup question that decides who can
 * reach this install (22 Sep 2026). Saved to data/network.json by the owner's
 * switch; applied here, at boot, because a listener cannot change its address
 * while running. Where it sits: server.yaml < this < server.local.yaml < env.
 * So the P40, whose local file sets bind, and a container, whose compose file
 * sets PROMPTFORGE_BIND, are never moved by it.
 */
function networkChoiceFile(cfg) {
  return path.resolve(ROOT, cfg.paths?.data ?? 'data', 'network.json');
}
function bindSource() {
  if (process.env.PROMPTFORGE_BIND) return 'environment';
  if (localBindConfigured) return 'local_config';
  return existsSync(networkChoiceFile(config)) ? 'setting' : 'default';
}
function applyNetworkChoice(cfg) {
  if (process.env.PROMPTFORGE_BIND || localBindConfigured) return cfg;
  try {
    const file = networkChoiceFile(cfg);
    if (!existsSync(file)) return cfg;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof saved.allow_remote === 'boolean') {
      (cfg.server ??= {}).bind = saved.allow_remote ? '0.0.0.0' : '127.0.0.1';
      console.log(`[config] data/network.json: other devices ${saved.allow_remote ? 'may' : 'may not'} connect`);
    }
  } catch (err) {
    console.warn(`[config] ignoring data/network.json: ${err.message}`);
  }
  return cfg;
}

let registry;
try {
  registry = loadRegistry(ROOT, { prompts: promptOverrides });
} catch (err) {
  // Loud, naming the offending key. A broken registry must never boot into a
  // half-working dropdown.
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}

// llm.model_defaults: a per-machine default_llm_model per target. Which models
// exist is a property of the box, so the pin h3 needs on the P40 lives in that
// box's server.local.yaml rather than in the shared registry - where it named
// a model no other install has (PR #1 deleted it for that reason).
for (const [id, name] of Object.entries(config.llm?.model_defaults ?? {})) {
  const entry = registry.get(id);
  if (!entry) console.warn(`[config] llm.model_defaults.${id}: no such target in models.yaml — ignored`);
  else if (name) entry.default_llm_model = String(name);
}

const prompts = createPromptStore(ROOT, config, registry);

let llm;
try {
  // Every generation's measured speed goes to the metrics (and so to Grafana
  // when monitoring is on). `metrics` is created further down; the hook only
  // runs once requests arrive.
  llm = createLLM(config, {
    onUsage: (model, usage) => {
      const speed = speedOf(usage);
      if (speed) metrics.recordSpeed(model, speed);
    },
  });
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}

// Set just below; the queue reaches it through this binding.
let idleOffload = null;

// Render from PromptForge (docs/render-plan.md). Off unless comfyui.enabled.
// `let`, not const: switching rendering on from the setup wizard builds it
// again (handleAdminComfySetup), so the first connect needs no restart.
let comfy = createComfy(config, { rootDir: ROOT, dataDir: config.paths?.data ?? 'data' });

/** The configured ComfyUI's port: comfy.freeIfIdle answers for that one, freeOtherComfyUIs for the rest. */
const comfyPort = () => {
  try {
    const u = new URL(config.comfyui?.url ?? 'http://127.0.0.1:8188');
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return 8188;
  }
};

/** Free every idle ComfyUI holding the card before an LLM loads, and log what it did. */
async function freeComfyUIsForLoad(why) {
  if (comfy.enabled && (await comfy.freeIfIdle())) console.log(`[${why}] freed ComfyUI's models for an LLM load`);
  const other = await freeOtherComfyUIs({ exceptPort: comfyPort() }).catch(() => ({ freed: [], busy: [] }));
  for (const h of other.freed) console.log(`[${why}] freed ${describeHolder(h)} for an LLM load`);
  for (const h of other.busy) console.log(`[${why}] ${describeHolder(h)} is busy; left alone`);
}

/** An LLM error's message, plus what holds the GPU when a model could not load. */
async function llmErrorMessage(err) {
  const why = await explainLoadFailure(err.verbatim ?? err.message).catch(() => null);
  return why ? `${err.message} ${why}` : err.message;
}
// The owner's catalogue of model files and LoRA corrections (stage 2).
const renderModels = createRenderModels(ROOT, config.paths?.data ?? 'data');
// Everyone's own workflows and presets (stage 3).
const userRender = createUserRender(ROOT, config);

const inferenceQueue = createQueue({
  concurrency: config.llm?.num_parallel ?? 1,
  name: 'inference',
  onActivity: () => idleOffload?.touch(),
  // ComfyUI keeps its last model on the card after a render, so the next
  // render is fast. Beside a resident LLM that is measured to fit; what does
  // not fit is the LLM LOADING into a card ComfyUI is holding. So before any
  // LLM job, when nothing is resident (it is about to load), ComfyUI lets go.
  //
  // Not before an edit either: an edit mostly is ComfyUI, and runEdit frees
  // it itself when its writer has an LLM to load. Freeing here threw the
  // editor out before every edit, so each one ran cold (measured 4 Oct 2026:
  // 65 s a time with the 4-step LoRA, 26 s warm).
  //
  // Any idle ComfyUI, not just one this server holds or the configured one:
  // see freeIfIdle and server/gpu-holders.mjs.
  beforeStart: async (ticket) => {
    if (ticket.kind === 'render' || ticket.kind === 'edit') return;
    const resident = (await llm.resident().catch(() => null)) ?? [];
    if (!resident.length) await freeComfyUIsForLoad('render');
  },
});

// Unload after the keep_alive time idle, on llama-swap. Ollama applies
// keep_alive itself on every request, so this is llama.cpp only — see
// createIdleOffload for why PromptForge has to own the clock there.
//
// llm.offload_exempt names models this clock must leave alone, by name prefix.
// A coding agent on the owner's PC talks to llama-swap directly, so a long job
// on an already-loaded model is invisible here and the clock would unload it
// mid-job. An exempt model carries its own llama-swap ttl instead, which counts
// llama-swap's own traffic and so sees that agent.
const offloadExempt = config.llm?.offload_exempt ?? [];
idleOffload = createIdleOffload({
  getKeepAlive: () => llm.getKeepAlive(),
  isBusy: () => inferenceQueue.stats().depth > 0,
  unloadAll: () => llm.unloadAll({ skip: (m) => offloadExempt.some((p) => String(m).startsWith(p)) }),
  snapshot: () => llm.runningStates(),
});
if (llm.backend === 'llamacpp') {
  setInterval(() => {
    idleOffload.tick().catch((err) => console.error('[offload] idle tick failed:', err));
  }, 5000);
}

// A fresh install starts with the same tag data the P40 runs on: the Danbooru
// tag list (pulled 7 Sep 2026), the character table, and the paraphrase
// lexicon that Anima v4/v5 checks tags against. The lexicon was built against
// that exact tag list, so they ship as a matched set in data/seed/ and are
// copied into place only where nothing exists yet. A box with its own copies
// (the P40, refreshed by update-tags) is never touched, and the live files
// stay gitignored so a refresh never shows up as a change.
for (const [seed, target] of [
  ['tags.sqlite', config.tags?.db_path ?? 'data/tags/tags.sqlite'],
  ['character_traits.sqlite', config.traits?.table_path ?? 'data/tags/character_traits.sqlite'],
  ['danbooru-visual-paraphrases.json', config.lexicon?.path ?? 'data/tags/danbooru-visual-paraphrases.json'],
  ['character_series.json', 'data/tags/character_series.json'],
]) {
  const from = path.join(ROOT, 'data', 'seed', seed);
  const to = path.resolve(ROOT, target);
  if (existsSync(to) || !existsSync(from)) continue;
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`[seed] ${target} copied from data/seed/ — first start on this install`);
  } catch (err) {
    console.warn(`[seed] could not copy ${seed}: ${err.message}`);
  }
}

// Missing tag database is a warning, never a boot failure.
const tags = createTagStore(ROOT, config);

// Who else is in a series, for Describe - see server/charcast.mjs.
const charCast = createCharCast({
  rootDir: ROOT,
  seriesPath: 'data/tags/character_series.json',
  tablePath: config.traits?.table_path ?? 'data/tags/character_traits.sqlite',
});

// The tag database as something the model can call, rather than something the
// prompt file has to describe. Built from the same store, so a database that
// failed to open means no tools offered — see server/tools.mjs.
// The owner's paraphrase lexicon: "beauty mark" is `mole`. Reviewed phrases
// only, each target checked against this same database on first use. See
// server/lexicon.mjs and `lexicon` in config/server.yaml.
const lexicon = createLexicon(ROOT, config.lexicon ?? {}, tags);
const lexiconFor = (model) => config.lexicon?.enabled === true && model.lexicon === true;

// A user's text-modifier vocabulary, which the third pass never remaps on a
// one-list prompt. Read once, from his own document.
const modifierWords = loadModifierVocabulary(ROOT, config.lexicon?.modifier_vocabulary);
if (config.lexicon?.modifier_vocabulary && !modifierWords.size) {
  console.warn(`[lexicon] no text modifiers read from ${config.lexicon.modifier_vocabulary}`);
}

/**
 * The third pass over one positive prompt — see server/tagpass.mjs.
 *
 * Booru models only. The label split and join happens for any of them, so a
 * labelled prompt never reaches anyone with its labels in; the lexicon's
 * replacements only where the model has it on. Logged whenever it changes
 * something, so a model that keeps writing the same fake tag is visible.
 */
function thirdPass(model, text, { brief = '', spared = [] } = {}) {
  if (!model.tag_style) return text;
  const result = tagPass(text, {
    known: tags.loaded ? (t) => tags.postCount(t) > 0 : null,
    resolve: lexiconFor(model) ? (p, o) => lexicon.resolve(p, o) : null,
    allowed: [
      ...(config.lexicon?.always_valid ?? []),
      ...Object.values(model.quality_presets ?? {}).flat(),
      ...Object.values(model.styles ?? {}).flat(),
    ],
    spared,
    modifiers: modifierWords,
    variant: model.tag_style,
    context: brief,
  });
  const parts = [];
  if (result.replaced.length) parts.push(`replaced ${result.replaced.join(', ')}`);
  if (result.dropped.length) parts.push(`removed unverified ${result.dropped.join(', ')}`);
  if (result.moved.length) parts.push(`moved to modifiers ${result.moved.join(', ')}`);
  if (parts.length) console.log(`[lexicon] ${model.key}: ${parts.join('; ')}`);
  return result.text;
}

const toolbox = createToolbox(tags, {
  limit: config.tools?.result_limit ?? 15,
  maxQueries: config.tools?.max_queries_per_call ?? 24,
  lexicon,
});
// Reference documents a model may open mid-generation. Same progressive
// disclosure a Codex skill gets: an index in the tool description, the
// document only when asked. See server/guidance.mjs.
const guidance = createGuidance(ROOT);

// The same database, read the other way round: from the brief, before the
// first token, with no model in the loop. See server/candidates.mjs for why
// both exist and what each one cannot do.
const candidates = createCandidateFinder(tags, config.candidates ?? {});

// Keyframe readings, kept between generations so a re-roll does not pay for
// the same picture twice. Process-local and bounded — see the header of
// server/keyframes.mjs.
//
// **Emptied by POST /api/prompts/reload**, and that is not housekeeping. A
// reading is the output of director-keyframe.md, which ships as a draft
// nobody has judged yet and is expected to be rewritten a few times. A cache
// that survived the reload would answer the next run with readings from the
// old instruction, and the person comparing two prompts would be measuring
// the wrong one — the exact trap scripts/lib/system-prompt.mjs exists to
// close on the other side of the app.
const keyframeCache = createKeyframeCache();
// h3's reference picture readings, the same kind of cache for the same reason.
const pictureCache = createKeyframeCache();

// The reference image cross-check. Built after the tag store because every tag
// the model adds is verified against it, and reads its instructions through
// prompts.referenceVision() on each call rather than capturing them here — so
// POST /api/prompts/reload changes the pass without a restart.
const visionTags = createVisionTags({
  // Its own base url, falling back to the LLM's. These are the same backend on
  // an Ollama-only box and the fallback keeps that a no-op — but this pass
  // calls Ollama's NATIVE /api/chat with an image attached, which llama.cpp
  // does not serve. So the moment llm.backend moves to llamacpp for prompt
  // generation, vision has to keep pointing at Ollama or Tab 3's cross-check
  // starts 404ing. Set reference_vision.base_url in server.local.yaml when the
  // two diverge; leave it unset otherwise.
  baseUrl:
    config.reference_vision?.base_url ?? config.llm?.base_url ?? 'http://127.0.0.1:11434/v1',
  // Which request shape carries the picture. `auto` follows this, which is
  // right whenever vision and generation share a server — and since 8 Sep 2026
  // on the P40 they do again, through llama-server's own --mmproj.
  backend: config.llm?.backend ?? 'ollama',
  timeoutMs: config.llm?.timeout_ms,
  numCtx: config.llm?.context_length,
  tagStore: tags,
  getPrompt: () => prompts.referenceVision(),
  // The other arm — the model reads the picture and no tagger runs. Same
  // reason this is a function: POST /api/prompts/reload changes it without a
  // restart.
  getDescribePrompt: () => prompts.referenceTags(),
  settings: config.reference_vision ?? {},
});

// The one way this whole feature dies quietly, said out loud at boot.
//
// A picture has to reach a server that can decode it. Two ways to get that
// wrong, and neither throws — the route falls back to the taggers and the only
// symptom is that choosing the LLM never seems to do anything:
//
//   ollama transport, no ollama    the /api/chat this posts to does not exist
//   openai transport, no projector llama-server answers, but blind
//
// The second cannot be detected from here — it is a llama-swap start flag —
// which is exactly why reference_vision.vision_models exists and why an empty
// one on a non-ollama backend is worth a line at boot.
if (visionTags.describeEnabled) {
  const visionBackend = config.reference_vision?.transport
    ?? ((config.llm?.backend ?? 'ollama') === 'ollama' ? 'ollama' : 'openai');
  const declared = config.reference_vision?.vision_models;
  if (visionBackend === 'openai' && declared === undefined) {
    // Absent, not empty. An empty list is a deliberate "none of them" and
    // needs no warning; absent means the gate falls back to asking /api/show,
    // which the OpenAI path does not serve — so every model reads as "did not
    // say", every one gets tried, and a blind one spends a real call to
    // return nothing.
    console.warn(
      '[vision-tags] images go to the OpenAI path and reference_vision.vision_models is not set — ' +
        'nothing here knows which llama-swap entries were started with --mmproj, so blind models will be tried anyway.'
    );
  }
}

// The sheets are this box's own measurements, kept in the data dir and out of
// git - see the note in server/benchmarks.mjs.
const benchmarks = createBenchmarks(ROOT, { dir: path.join(config.paths?.data ?? 'data', 'benchmarks') });
const traits = createTraitStore(ROOT, config);
const storage = createStorage(ROOT, config);
// The shared image library — a picture and the prompt that made it. Nothing
// downstream of generation depends on it: it hands the browser an image and a
// block of text, and the existing reference card and brief do the rest.
const sharedImages = createSharedImages(ROOT, config);
// A proxy to a real TrainFlow instance, wired only via config/server.local.yaml
// on the box - see server/training.mjs. Disabled (backend stays "stub") on
// every install that hasn't set training.backend: "trainflow" locally.
// `let` for the same reason as comfy: connecting TrainFlow from the setup
// wizard rebuilds it (handleAdminTrainingSetup), no restart.
let training = createTraining(ROOT, config);
// Where a checkpoint or a LoRA lives, pasted in by hand once and shared by
// every pin that names that weight. See server/weightlinks.mjs for why this
// cannot be looked up automatically.
const weightLinks = createWeightLinks(ROOT, config);
const modelRequests = createRequestStore(ROOT, config);
// Per-model run counters, for the owner's "which of these can I delete"
// question. Written on every completed inference; read only by the admin
// panel. See server/usage.mjs — nothing downstream depends on it.
const usageStats = createUsageStore(ROOT, config);
// Brief randomizer. Spawns scripts/randomizer.py per call — no LLM, no queue,
// no GPU. See server/randomizer.mjs.
const randomizer = createRandomizer(ROOT, config);
// CPU, RAM and VRAM for the strip across the top. Read on its own fast poll,
// never fatal — see server/sysmon.mjs.
const sysmon = createSysmon(config);

// The owner's "Run benchmark" button. Writes its sheet into the same folder
// the Benchmarks tab reads. See server/benchrun.mjs.
const benchRunner = createBenchRunner({
  llm,
  queue: inferenceQueue,
  sysmon,
  speedOf,
  benchDir: path.resolve(ROOT, config.paths?.data ?? 'data', 'benchmarks'),
  owner: () => auth.ownerName || config.owner_username || 'owner',
});

// Settings a person changed through the UI, which outrank config/server.yaml
// and survive a restart. Applied here rather than inside createLLM so the
// backend has one owner of the value and this file decides where it came from.
// Which commit this process booted from, so it can notice when the working
// tree has moved on without it. See server/version.mjs for why the stale
// process is the right one to do the noticing.
const version = createVersionWatch(ROOT);

const runtime = createRuntimeSettings(ROOT, config);
llm.setKeepAlive(runtime.keepAlive());

// Matches the separator server/prompts.mjs composes with, so the runtime
// block reads as another section rather than a different kind of seam.
const PROMPT_SEPARATOR = String.fromCharCode(10, 10) + '---' + String.fromCharCode(10, 10);

// Web search for chat. Enabled by config; every failure path inside it returns
// an empty result set with a reason, so a chat turn never fails because a
// search did.
const search = createSearch(config);

// Image taggers. Separate file because the weights are machine-specific paths
// and server.yaml should stay portable. Missing config or missing weights are
// both warnings — Tab 3 reports itself unavailable rather than taking the
// server down.
const taggerSetup = createTaggerSetup({ rootDir: ROOT, dataDir: config.paths?.data ?? 'data' });
let taggerConfig = loadTaggerConfig();
// `let`, not const: the Setup panel rebuilds it after finding or downloading
// a tagger. Sessions load on first use, so a rebuild costs nothing and needs
// no restart. Nothing captures the old store - every use is per request.
let taggers = createTaggerStore(taggerConfig, { rootDir: ROOT });
function reloadTaggers() {
  taggerConfig = loadTaggerConfig();
  taggers = createTaggerStore(taggerConfig, { rootDir: ROOT });
}

const auth = createAuth(ROOT, config);

// Prometheus-format metrics for the monitoring stack. No auth on its endpoint
// because Prometheus scrapes it and has no session — same call as /health.
const metrics = createMetrics();

/**
 * Whoever is asking.
 *
 * With auth on this is the signed session and nothing else — the router has
 * already refused anyone without one, so `req.user` is always an approved
 * account by the time a handler runs.
 *
 * With auth off it falls back to the pre-accounts header, which is what the
 * suites written before this existed still use. That path is dev-only: the
 * header is trivially forged, which is exactly why it stopped being the
 * mechanism in the first place.
 */
const whoIs = (req) =>
  req.user?.username ??
  safeUsername(req.headers['x-promptforge-user'], config.owner_username ?? 'owner');

const isOwner = (req) =>
  auth.enabled
    ? Boolean(req.user?.is_owner)
    : req.headers['x-promptforge-user'] === config.owner_username;

// The admin routes the owner can hand to a named account, and the grant each
// one needs. Everything under /api/admin/ that is absent from this map is the
// owner's alone — which is the correct direction for a route added later to
// fail in. See GRANTS in server/auth.mjs for why offload is the only entry.
const ADMIN_GRANTS = {
  '/api/admin/models/unload': 'offload',
};
// Whole subtrees a grant opens (26 Sep 2026): every Tab 2 route needs `train`.
const ADMIN_GRANT_PREFIXES = [['/api/admin/training/', 'train']];
const grantFor = (pathname) =>
  ADMIN_GRANTS[pathname] ?? ADMIN_GRANT_PREFIXES.find(([p]) => pathname.startsWith(p))?.[1] ?? null;

// Tab 2's pages and its WebSocket are not under /api/admin/, so they ask this
// directly: the owner, or an account holding `train`.
const mayTrain = (req) => isOwner(req) || auth.can(req.user, 'train');

// Render routes are under /api/render/, not /api/admin/, so they ask this:
// the owner, or an account holding `render`. Checked on every one of them.
const mayRender = (req) => isOwner(req) || auth.can(req.user, 'render');

// LoRA captions (/api/caption): the owner, or an account holding `caption`.
const mayCaption = (req) => isOwner(req) || auth.can(req.user, 'caption');

// With auth disabled there are no accounts to hold a grant, so this answers
// false and the isOwner header path is the whole of the check.
const mayAdmin = (req, pathname) =>
  isOwner(req) || (grantFor(pathname) ? auth.can(req.user, grantFor(pathname)) : false);

// ───────────────────────────── http helpers ─────────────────────────────

// The only file /api/docs/h3-director will serve. A constant rather than
// anything derived from a request, which is what makes that route incapable
// of traversal in the first place.
const DIRECTOR_DOC = path.join(ROOT, 'docs', 'minimax_h3_director.md');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error(`Request body exceeds ${Math.round(limitBytes / 1024)}KB.`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Request body is not valid JSON.');
    err.statusCode = 400;
    throw err;
  }
}

/** Open an SSE stream using the one event shape shared by every streaming endpoint. */
function openSSE(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  // res rather than req, for the reason the abort wirings give: on a client
  // disconnect only `res` emits 'close'. This flag guards the keep-alive
  // write below, so with req it stayed false forever and the interval went on
  // writing to a dead socket every 15 seconds.
  res.on('close', () => {
    closed = true;
  });
  // A write that lands after the socket died is reported as an 'error' event,
  // and an 'error' nobody listens for is thrown — which the process cannot
  // survive. The stream is over either way; treat it as closed.
  res.on('error', () => {
    closed = true;
  });

  // Comment frame every 15s so intermediaries do not reap an idle stream
  // while a request sits in the queue.
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15000);

  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(keepAlive);
      // Set here, not left to the 'close' event: that arrives later, and a
      // send() in between would write after end.
      if (!closed) {
        closed = true;
        res.end();
      }
    },
  };
}

// Grafana reverse proxy (PR #3) — the owner's Monitoring
// button opens the dashboard through here. Owner-only; the check is at the
// route. Follow-up 22 Sep 2026:
//   - bodies pass through as bytes. They were read as text, which corrupts
//     every font and image Grafana serves.
//   - Grafana's own cookies go through both ways, so signing in to Grafana to
//     edit a dashboard works; PromptForge's session cookie and any
//     Authorization header never reach it.
//   - an absolute redirect is turned back into a path, because Grafana's
//     root_url names localhost and the owner may not be on localhost.
async function handleGrafanaProxy(req, res, url) {
  const grafanaUrl = getGrafanaUrl();
  if (!grafanaUrl) {
    return sendJSON(res, 503, { error: 'grafana_unconfigured', message: 'Monitoring is not set up on this server.' });
  }
  try {
    const target = new URL(`${url.pathname.replace(/^\/grafana/, '') || '/'}${url.search}`, grafanaUrl);
    const headers = { host: target.host };
    for (const h of ['accept', 'accept-language', 'content-type', 'x-grafana-org-id', 'x-grafana-device-id']) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    const cookies = String(req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
    if (cookies.length) headers.cookie = cookies.join('; ');

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });

    const out = {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store',
    };
    const location = upstream.headers.get('location');
    if (location) out.location = location.replace(/^https?:\/\/[^/]+(?=\/grafana\/)/, '');
    const setCookie = upstream.headers.getSetCookie?.() ?? [];
    if (setCookie.length) out['set-cookie'] = setCookie;
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn(`[grafana-proxy] ${url.pathname}: ${err.message}`);
    if (res.headersSent) return res.end();
    return sendJSON(res, 502, { error: 'grafana_unreachable', message: 'Monitoring is set up but Grafana is not answering.' });
  }
}

/**
 * TrainFlow reverse proxy — the owner's Tab 2 iframe. Owner-only; the check
 * is at the route, exactly as Grafana's is.
 *
 * Why a proxy and not our own form: the owner asked for TrainFlow's actual UI
 * inside PromptForge, not a reimplementation of its fields. TrainFlow binds to
 * 127.0.0.1 on the box, so this is the only way to it from off the machine,
 * and the owner gate here is the only thing in front of it.
 *
 * Three things make this more than a path rewrite, all of them because
 * TrainFlow's frontend addresses its server from the site root:
 *   - its one api() helper fetches "/api/...", which would otherwise hit
 *     PromptForge's own /api/ and get a PromptForge answer;
 *   - it opens a WebSocket at "/ws", which carries the training log, the
 *     running state and the sample gallery - there is no polling fallback for
 *     any of them, so without it the embedded UI reads "offline" with an
 *     empty log forever. The upgrade is relayed in attachTrainflowUpgrade().
 *   - sample images come back from the server as "/samples/<token>/<name>"
 *     (util.go), inside JSON and inside WS frames.
 * Rather than rewrite its JS - fragile, and it is the DaSiWa node pack's file - the
 * document gets a shim that prefixes those three at the source. Everything
 * else about TrainFlow's UI is untouched and unaware it is being embedded.
 */
// Dataset prep and training calls are long by nature; this is a ceiling for a
// genuinely wedged request, not a limit on how long work may take.
const TRAINFLOW_TIMEOUT_MS = 20 * 60 * 1000;

const TRAINFLOW_SHIM = `<script>
(() => {
  const P = '/trainflow';
  const abs = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith(P) ? P + u : u);
  const f = window.fetch;
  window.fetch = (input, init) => f(typeof input === 'string' ? abs(input) : input, init);
  const WS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    return new WS(String(url).replace(/^(wss?:\\/\\/[^/]+)(\\/)/, (m, host, slash) => host + P + slash), protocols);
  };
  window.WebSocket.prototype = WS.prototype;
  // CONNECTING/OPEN/CLOSING/CLOSED live on the constructor, and a wrapper
  // that loses them breaks any readyState comparison written the normal way.
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...d,
    set(v) { d.set.call(this, abs(v)); },
  });
})();
</script>`;

async function handleTrainflowProxy(req, res, url) {
  if (!training.baseUrl) {
    return sendJSON(res, 503, { error: 'training_unconfigured', message: 'Training is not set up on this server.' });
  }
  try {
    const target = new URL(`${url.pathname.replace(/^\/trainflow/, '') || '/'}${url.search}`, training.baseUrl);
    const headers = { host: target.host };
    for (const h of ['accept', 'accept-language', 'content-type']) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      // Not 30s. TrainFlow's own work happens behind these calls - tagging a
      // dataset, caching latents, starting a run - and a request that takes
      // minutes is normal rather than stuck. A short timeout aborted the job
      // partway and surfaced as a button that did nothing.
      signal: AbortSignal.timeout(TRAINFLOW_TIMEOUT_MS),
    });

    const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const out = { 'content-type': type, 'cache-control': 'no-store' };
    const location = upstream.headers.get('location');
    if (location) out.location = location.replace(/^https?:\/\/[^/]+/, '/trainflow');

    // Only the document is rewritten, and only two things in it: <script src>
    // and <link href> are fetched by the browser itself, so no shim can reach
    // them - they have to resolve relative to /trainflow/ instead. Making them
    // relative is enough because the iframe's URL carries the trailing slash.
    if (type.includes('text/html')) {
      const html = (await upstream.text())
        .replace(/\b(src|href)="\/(?!\/)/g, '$1="')
        .replace(/<head([^>]*)>/i, `<head$1>${TRAINFLOW_SHIM}`);
      res.writeHead(upstream.status, out);
      return res.end(html);
    }
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn(`[trainflow-proxy] ${url.pathname}: ${err.message}`);
    if (res.headersSent) return res.end();
    return sendJSON(res, 502, { error: 'training_unreachable', message: 'Training is set up but TrainFlow is not answering.' });
  }
}

function serveStatic(req, res, urlPath) {
  const webRoot = path.join(ROOT, config.paths?.web ?? 'web');
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(webRoot, rel);

  // Never serve outside web/.
  //
  // The trailing separator is the whole point. `decodeURIComponent` above
  // turns `%2e%2e%2f` into `../` *after* `new URL()` has normalised the
  // pathname, so a percent-encoded traversal does reach `path.resolve` and
  // does escape webRoot. A bare `startsWith(webRoot)` then waves through any
  // sibling whose name merely begins with "web" — `web-secret/keys.txt`
  // resolves outside web/ and passes a prefix test against `.../web`.
  //
  // No such sibling exists today, which is the only reason this was never a
  // hole. That is luck, not a guard: static files are deliberately ungated so
  // the login page can render, making this the one unauthenticated file read
  // in the app. Comparing against webRoot + separator makes containment a
  // property of the path rather than of what happens to sit next to it.
  const root = path.resolve(webRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendJSON(res, 403, { error: 'forbidden' });
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return sendJSON(res, 404, { error: 'not_found', path: urlPath });
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  // A file removed between the stat above and this read (a deploy mid-request)
  // makes the stream emit 'error', and an unheard one is thrown. End the
  // response instead; the headers are already out, so there is nothing else
  // to say.
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res);
}

// ───────────────────────── generation request shaping ─────────────────────

const CONTROL_LABELS = {
  quality_preset: 'Preset',
  source_tag: 'Source',
  style: 'Style',
  aspect_ratio: 'Aspect',
  creativity: 'Creativity',
  // "Mode" everywhere: the h3 template labels this control Mode, and its
  // SKILL.md tells the model to read "the user's Mode control". h3 is the
  // only model that sends it. Calling it Workflow here made the injected
  // line disagree with both.
  mode: 'Mode',
  duration: 'Duration',
  shots: 'Shots',
  quality_mode: 'Quality',
  model_size: 'Model size',
  frame_count: 'Frames',
  audio: 'Audio',
};

function titleCase(v) {
  return String(v).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}


/**
 * Build the user message. The prompt files' worked examples show a brief in
 * quotes followed by a middot-joined control line, so that is the shape they
 * were written against.
 */
/**
 * A control the person set that cannot be honoured as typed.
 *
 * Distinct from the registry and LLM errors because the cause is neither the
 * config nor the backend — it is one field in this request, and the message
 * names the field and the limit so the fix is obvious without a log.
 */
class ControlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ControlError';
  }
}

/**
 * Canon for the characters a brief names, as a block for the user turn.
 *
 * The failure this exists to stop is measured and specific: the LLM states a
 * character's hair colour from memory and is confidently wrong. server/
 * traits.mjs has derived the real answer from danbooru since 21 Aug, and until
 * now only `GET /api/traits` could reach it — so it helped people who clicked
 * trait chips and nobody who just typed a brief.
 *
 * Every step degrades to an empty string, which reproduces the old behaviour
 * exactly: no tag database, no character found, danbooru unreachable, or the
 * feature switched off all mean "generate as before".
 */
async function characterCanon(model, brief, controls = {}) {
  if (config.characters?.enabled === false) return '';
  // The person picked traits by hand; theirs win and a second opinion in the
  // same prompt would only argue with them.
  if (Array.isArray(controls.tags) && controls.tags.length) return '';
  if (!tags.loaded) return '';

  let found;
  try {
    found = resolveCharacters(brief, tags, {
      minPostCount: config.characters?.min_post_count ?? 50,
      minSoloPostCount: config.characters?.min_solo_post_count ?? 500,
      maxCharacters: config.characters?.max_characters ?? 3,
    });
  } catch (err) {
    console.warn(`[characters] resolve failed: ${err.message}`);
    return '';
  }

  // The group's own list, for characters danbooru does not know (Powder the
  // VTuber has no tag at all). Read on every generation, so an edit to the
  // file takes effect without a restart. A name danbooru resolved is never
  // matched here.
  let custom = [];
  try {
    const { config: list, error } = loadConfig(ROOT, 'custom-characters');
    if (error && !/not found$/.test(error)) console.warn(`[characters] custom-characters.yaml: ${error}`);
    custom = findCustomCharacters(brief, list?.characters ?? [], tags, found.resolved.map((r) => r.name));
    // Nor is it also reported as an unconfirmed danbooru name.
    const mine = new Set(custom.map((c) => c.matched.toLowerCase()));
    found.ambiguous = found.ambiguous.filter((a) => !mine.has(String(a.name).toLowerCase()));
    for (const c of custom) console.log(`[characters] ${model.key}: ${c.name} from the custom list — ${c.traits.length} traits`);
  } catch (err) {
    console.warn(`[characters] custom list failed: ${err.message}`);
  }
  const customText = customCharacterBlock(custom, model.tag_style === 'underscore');

  if (!found.resolved.length && !found.ambiguous.length) return customText;

  const entries = [];
  for (const hit of found.resolved) {
    try {
      const out = await traits.lookup(hit.tag, tags, {});
      // Only what describes her. danbooru's ranking is a tally over posts, so
      // it happily promotes what the character was DOING in them: Frieren's
      // top traits include `holding`, `holding_staff` and `closed_mouth`, and
      // those were reaching the model as canon under a brief that said
      // "drinking coffee". Reported 27 Aug 2026 with the output attached.
      //
      // Filtered here rather than in traits.mjs on purpose. Ranking is what
      // that file does and it does it well; and `GET /api/traits` feeds a
      // panel of clickable chips, where a person may legitimately want the
      // staff. So the ranking keeps everything and the PROMPT takes the
      // appearance half — which is also why no cached row needs rewriting.
      const { kept: about, dropped } = splitAppearance(out.traits ?? [], (t) => t.tag);
      // Her clothes are not sent as canon. Ever.
      //
      // Reported 8 Sep 2026 with the output attached: a brief asking for Seia
      // in "une robe simple seulement et rien d'autre" came back wearing her
      // canonical detached sleeves. That morning's fix had been a house rule
      // telling the model a stated outfit replaces the canonical one, and it
      // could not have worked — this block hands the garment over labelled
      // "facts, not suggestions", so the model was being asked to disobey us
      // in order to obey the user. The owner's rule and the right one: user
      // input overrides the lookup.
      //
      // NOT conditional on the brief mentioning clothes, because that test
      // cannot be written honestly. Detecting "the brief names an outfit"
      // needs a garment vocabulary in the language the brief is written in,
      // and a user writes his in French — the one person who reported this
      // would never have triggered it. So the lookup stops having an opinion
      // about clothing, in every language at once.
      //
      // What it costs: a brief that says nothing about clothes no longer gets
      // her canonical outfit as tags. On a booru model the character tag
      // renders it anyway — that is what `seia_(blue_archive)` is FOR — and
      // the traits panel still offers every garment as a chip, which makes
      // pinning the canonical outfit a deliberate act rather than a default.
      //
      // isGarment keeps what it cannot place, so Seia keeps her halo and her
      // fox ears and Frieren keeps `elf`, `pointy_ears` and her earrings.
      // Props go the same way, and for the same reason — reported the same
      // night: a brief came back holding a dagger nobody asked for. What a
      // character usually carries is per-scene, not a fact about how she
      // looks. `holding_staff` has been caught since August by the action
      // rule; `staff` on its own was not, and danbooru tags both.
      //
      // Costume ears go with the costume: Asuna's `rabbit_ears` are her bunny
      // suit's. Judged over the whole list — see withoutCostumeBody.
      const { kept: body, worn: costume } = withoutCostumeBody(about, (t) => t.tag);
      const worn = [...body.filter((t) => isGarment(t.tag) || isProp(t.tag)), ...costume];
      const kept = body.filter((t) => !isGarment(t.tag) && !isProp(t.tag));
      if (kept.length) {
        entries.push({ tag: hit.tag, traits: kept.map((t) => t.tag) });
        console.log(
          `[characters] ${model.key}: ${hit.tag} via ${hit.via} — ${kept.length} traits` +
            (worn.length ? `, ${worn.length} withheld as clothing or props (${worn.map((t) => t.tag).join(', ')})` : '') +
            (dropped.length ? `, ${dropped.length} not about her (${dropped.map((t) => t.tag).join(', ')})` : '') +
            (out.cached ? ' (cached)' : '')
        );
      } else {
        // Resolved to a real tag but nothing usable came back — either
        // danbooru gave us nothing, or everything it gave us was about the
        // pose and the room. Both are an unconfirmed character rather than a
        // confirmed featureless one, so it joins the "do not invent" list
        // rather than vanishing. Sending the furniture instead would be worse
        // than sending nothing: it reads as a description of her.
        found.ambiguous.push({ name: hit.name, candidates: [hit.tag] });
        const why = dropped.length
          ? `${dropped.length} found, none of them about her`
          : (out.reason ?? 'unknown');
        console.warn(`[characters] ${hit.tag}: no traits — ${why}`);
      }
    } catch (err) {
      found.ambiguous.push({ name: hit.name, candidates: [hit.tag] });
      console.warn(`[characters] ${hit.tag}: lookup failed — ${err.message}`);
    }
  }

  return [characterBlock(entries, found.ambiguous, model.tag_style === 'underscore'), customText]
    .filter(Boolean).join('\n\n');
}

function buildUserMessage(model, brief, controls = {}, characterText = '', standing = '', candidateText = '', omit = [], { carriesImage = false, referenceAnalysis = '', attachedLabels = [], keyframeReadings = new Map(), pictureLines = [], labelledLines = null } = {}) {
  const lines = [`Brief: "${String(brief).trim()}"`];

  const parts = [];
  // A style pasted in code goes out as its own line below, not as a setting.
  // See server/style.mjs.
  const styleBlock = pastedStyle(model, controls);
  for (const [key, label] of Object.entries(CONTROL_LABELS)) {
    // Shots has a default with no control behind it: FL2VA is one shot on
    // Auto, and a request that left the control out entirely is Auto.
    const value = key === 'shots' && controls[key] == null && model.shot_counts ? 'Auto' : controls[key];
    // false is a choice, not an absent control - see the quality preset below.
    if (value == null || value === '' || value === false) continue;
    // A style literally named "None" means "impose no style", so it is
    // suppressed rather than sent as `Style: None` - which the model would
    // read as a style called None. Same intent as the None quality preset.
    if (key === 'style' && value === 'None') continue;
    if (key === 'style' && styleBlock) continue;
    // A quality preset of "none" is handled below as an explicit instruction,
    // not as a setting. Passing it through here as well would put "Preset:
    // None" in front of the model, which reads as "no constraint" rather than
    // "no quality tags" — and a model given no constraint adds its own ladder.
    if (key === 'quality_preset' && String(value).toLowerCase() === 'none') continue;
    // "N/A" on the aspect selector means no ratio has been decided, so no
    // Aspect line goes out at all. Passing it through would put the literal
    // string "N/A" in front of the model as though it were a value, which is
    // the same mistake as sending a style called None. Added 27 Aug 2026.
    if (key === 'aspect_ratio' && value === 'N/A') continue;
    // A preset is a LIST OF TAGS, and until 27 Aug 2026 only its name was
    // sent — so "Preset: Masterpiece" reached the model and the model wrote
    // whatever ladder it remembered. Every prompt file in prompts/image says
    // some version of "the user's preset supplies the exact ladder, the
    // registry copy is authoritative", and nothing made that true: the
    // registry copy went to the frontend and stopped there.
    //
    // Reported as a score-tag question — the owner's answer was "the score
    // should come from the quality preset" — and this is the whole of it.
    // Anima's Masterpiece carries `score_9, score_8, score_7` because the
    // owner put them there on 22 Aug; if he takes them out, they stop
    // appearing, which is what a registry being authoritative means. It also
    // ends the guessing on every other model at the same time.
    //
    // Only the four tag models declare presets, so this never fires on a
    // prose model, and no model is named here to decide it.
    if (key === 'quality_preset') {
      const ladder = model.quality_presets?.[value];
      parts.push(
        Array.isArray(ladder) && ladder.length
          ? `${label}: ${titleCase(value)} — use exactly these quality tags and no others, at the front of the prompt: ${ladder.join(', ')}`
          : `${label}: ${titleCase(value)}`
      );
      continue;
    }
    // A style is a LIST OF TAGS on the models that declare it as a map, and a
    // bare label on the ones that still declare it as a list.
    //
    // This is the quality-preset bug above, one control over, and it survived
    // that fix by four days short of a fortnight: only the style's NAME
    // travelled, so "Style: Painterly" reached the model and the model wrote
    // whatever it remembered painterly meaning. Reported by a user as the style
    // prompts not working. The control was firing the whole time — it just
    // carried nothing.
    //
    // Worded differently from the quality ladder on purpose. Quality tags are
    // a fixed block that goes at the front and admits nothing else; style tags
    // are direction that belongs in the tag section among everything else, so
    // this says "include" rather than "use exactly these and no others".
    //
    // `styles` as a plain array falls through to the bare label, titleCased,
    // which is byte-for-byte what every model did before this.
    //
    // **The instruction is worded per dialect, and that is the whole reason
    // this is not one string.** A style payload on a tag model is tags and
    // belongs in the tag list; the same payload on a prose model is a look to
    // write about, and telling Krea2 to "include these tags" would put comma
    // separated fragments into a natural-language prompt — the one failure
    // this project's non-negotiables name outright. Gated on `tag_style`,
    // which is present on exactly the two booru models and absent on the four
    // prose ones, so this is registry-driven and names no model.
    if (key === 'style') {
      const terms = Array.isArray(model.styles) ? null : model.styles?.[value];
      parts.push(
        Array.isArray(terms) && terms.length
          ? model.tag_style
            ? `${label}: ${value} — include these tags: ${terms.join(', ')}`
            : `${label}: ${value} — carry this look through the description: ${terms.join(', ')}`
          : `${label}: ${titleCase(value)}`
      );
      continue;
    }
    // A number picked on h3's Shots control. See server/shots.mjs.
    if (key === 'shots') {
      const line = shotsLine(controls);
      if (line) parts.push(line);
      continue;
    }
    if (key === 'duration') parts.push(`${label}: ${value} sec`);
    // In ltx.md's own words, "Generate audio" and "Silent" (it was "on" /
    // "off"). The instruction that makes Silent stick is its own line below.
    else if (key === 'audio') parts.push(`${label}: ${value ? 'Generate audio' : 'Silent'}`);
    else parts.push(`${label}: ${titleCase(value)}`);
  }
  // Labelled as settings, and told plainly not to write them into the prompt.
  //
  // Reported 22 Aug: changing the aspect ratio sometimes put the ratio into
  // the output - "2:3 portrait" arriving as a tag. These lines read as content
  // to a model because they sit in the user turn looking like everything else
  // in it. Aspect and creativity are instructions to the person's image
  // generator and to the writing, not things a prompt should contain, so the
  // line now says so once rather than hoping the model infers it.
  if (parts.length) {
    lines.push(`Settings (context for how to write, never text to include): ${parts.join(' · ')}`);
  }
  if (styleBlock) lines.push(styleInstruction(controls.style ?? model.default_style, styleBlock));
  // The canvas a layout's boxes are measured on, and any boxes the person
  // drew. See server/layout.mjs.
  lines.push(...layoutLines(model, controls));

  // Detail. The rule text is config, not code - see defaults.detail_levels in
  // config/models.yaml, which also explains why only the two notches at each
  // end are allowed to say they override the model's own format rules.
  //
  // Sent as its own line rather than folded into the Settings list above,
  // because it is an instruction about how to write and that list is
  // explicitly labelled as context that must never reach the output. Putting
  // a sentence like "specify every visually useful aspect" in there and then
  // telling the model to ignore it is a contradiction the 8B loses.
  // How far past the brief the model may go. Sits with the detail rule
  // because the two are the pair of axes the controls are built around:
  // creativity is how much may be invented, detail is how much gets written
  // down. Before this, creativity reached the model as a bare word.
  const creativity = creativityFor(model, controls);
  if (creativity?.rule) {
    lines.push(`Creativity - ${creativity.label}. ${creativity.rule}`);
    // A video model with a picture is animating THAT picture. Owner, 18 Sep
    // 2026: "when it comes to the video models it HAS TO use the input image
    // as a reference". Measured the same day, h3 at Wild invented the alley,
    // the steam, a mannequin in a red dress and the hair - fine with no
    // picture, a redesign of the frame with one. So the picture is pinned in
    // code at every notch rather than hoped for from ten rule texts.
    if (videoHasPicture(model, controls)) {
      lines.push(
        'A reference picture is attached. What it supplies, in the role it was given, stays exactly as the picture shows it at every Creativity setting. Creativity decides only what happens - the action, the camera, the cuts and the sound - never what is already in the picture.'
      );
    }
  }

  const detail = detailFor(model, controls);
  if (detail) {
    lines.push(`Detail level ${detail.level} of ${detail.of} - ${detail.label}. ${detail.rule}`);
  }

  // Audio off, as an instruction of its own. In the Settings list alone it was
  // context, and the model wrote sound into 12 of 12 LTX prompts with audio
  // off (2 Oct 2026) - the same trap detail and lighting were moved out of.
  if (controls.audio === false) {
    lines.push('Audio is off: this clip is silent. Write no sound at all - no noises, voices, music or ambience, and do not describe silence or quiet either. This overrides any rule about weaving in sound, including the detail level\'s.');
  }

  // Lighting, and only when somebody asked for it — see lightingFor.
  //
  // The standing rule goes out with the level rather than living in
  // house-rules, so it costs nothing on the prompts that do not use this and
  // never states a rule about a control that was not touched. Same call that
  // moved the Reasoning instructions out of house-rules on 5 Sep, and the
  // owner's again here.
  //
  // Its own line for the same reason detail has one: it is an instruction
  // about the picture, and the Settings list above is explicitly labelled as
  // context that must never reach the output. `lighting` is deliberately
  // absent from CONTROL_LABELS so it cannot appear in both.
  const lighting = lightingFor(model, controls);
  if (lighting) {
    const rule = model.lighting_rule ?? registry.defaults?.lighting_rule ?? '';
    lines.push(
      `Lighting level ${lighting.level} of ${lighting.of} - ${lighting.label}. ${lighting.rule}` +
        (rule ? ` ${rule}` : '')
    );
  }

  // Nothing is said here about segments that were switched off.
  //
  // There used to be a "Do NOT write ..." line, and it was the only
  // instruction in this file that contradicted the model's own prompt file.
  // The owner's call on 5 Sep 2026 replaced it: the system prompt is composed
  // from one block per segment, so a segment that is off is simply never
  // described and its example never shown. Nothing to override, because
  // nothing unwanted is said. See prompts.segmentTail.

  // An explicit length, when the person set one. Off by default, and when it
  // is off nothing is sent — every dialect measurement in this project was
  // taken with no length line at all, and a default here would silently
  // invalidate all of them.
  //
  // Placed AFTER the detail line and told to win, because the two can
  // contradict: the top detail notch says it "overrides any maximum length
  // this model's format normally expects", and a person who then typed 40
  // words meant the 40. Typing a number is the more deliberate act, so it
  // takes precedence.
  //
  // For tokens the model is given the rough word equivalent as well. It
  // cannot count its own tokens, and asking it to try is the h3 trap — SKILL
  // .md said "count it" about a character budget and the model spent 12,450
  // tokens of thinking counting, with nothing left for the answer. The real
  // enforcement is num_predict; this line only aims it.
  // The person's own standing instruction, from their account. Off unless
  // they wrote one; see custom_instruction in server/preferences.mjs for why
  // it lives in the user turn rather than in the system prompt.
  //
  // Placed here, with the other "how to write" lines, and told explicitly
  // that it cannot change the segment contract. Everything downstream — the
  // parser, the failure table, every dialect assertion — is built on the
  // segments this model declares, and a person typing "answer in one
  // paragraph" into a box in their settings must not be able to break that
  // for themselves in a way that reads as the app being broken.
  if (standing) {
    lines.push(
      `Standing instruction from this user, which applies to every prompt they ` +
        `ask for: "${standing}". Follow it where it does not conflict with this ` +
        `model's format. It never changes which segments you emit, their ` +
        `labels, or their order.`
    );
  }

  const length = lengthFor(controls);
  if (length) {
    lines.push(
      length.unit === 'words'
        ? `Length: approximately ${length.value} words. This takes precedence over the detail level above and over any length or tag count this model's format normally expects.`
        : `Length: your output will be cut off at ${length.value} tokens, roughly ${Math.round(length.value * 0.75)} words. Finish inside that. This takes precedence over the detail level above and over any length or tag count this model's format normally expects.`
    );
  }

  // The absence of a quality preset, chosen deliberately. Without this a model
  // given no guidance adds its own quality ladder - which is correct default
  // behaviour and exactly what "None" is asking it not to do.
  //
  // TWO spellings reach here and both mean the same thing. The UI injects a
  // "None" option with an empty value, which collectControls sends as `false`.
  // But a model whose REGISTRY declares a preset called `none` suppresses that
  // injected option — the registry's own wins where it exists — and then the
  // string "none" arrives instead. sdxl has declared one since it was written,
  // so its None has never emitted this instruction; illustrious, pony and
  // anima gained one on 27 Aug 2026 and inherited the same gap, which is how
  // it was spotted: Anima with the preset on None returned "masterpiece, best
  // quality, score_9, score_8, absurdres, newest".
  const noQuality =
    controls.quality_preset === false ||
    String(controls.quality_preset ?? '').toLowerCase() === 'none';
  if (noQuality) {
    lines.push('Quality preset: none. Add no quality, score or aesthetic tags of your own.');
  }

  // Tags the user picked from the database. They are already in this model's
  // syntax and carry their weights, so they must survive into the output —
  // house-rules is explicit that the user's intent wins.
  if (Array.isArray(controls.tags) && controls.tags.length) {
    lines.push(`Required tags (keep all of these, exactly as written): ${controls.tags.join(', ')}`);
  }

  // Text the person wants in the positive prompt exactly as typed - a LoRA
  // trigger word, an artist tag, a phrase that is known to work. Same contract
  // as the picked tags and stated the same way, because the failure mode is
  // the same one: a model that "improves" a trigger word has destroyed it.
  if (controls.positive) {
    lines.push(`Must appear in the positive prompt, exactly as written: ${controls.positive}`);
  }

  if (controls.negative) lines.push(`Negative additions: ${controls.negative}`);

  // Image-to-video. Stated as a fact, not as an instruction: wan.md already
  // says what to do about a first frame — don't re-describe it, spend the
  // words on motion and camera — and repeating that here would put the same
  // rule in two places that can drift apart. The description is short by
  // design; it exists so the subject layer can name what carries forward.
  //
  // `carriesImage` means the pictures for THIS model's reference lane are
  // attached to the same message. The three lanes are mutually exclusive by
  // template — an image model has image_references, wan has the frame pair,
  // h3 has the Director rows — so one flag covers all three, and the block
  // that is present is the one whose wording it changes.
  if (controls.i2v_reference) {
    if (carriesImage) {
      // The tagger's list is deliberately NOT repeated here. It is an
      // auto-injected guess at a picture the model is now looking at, and
      // a model handed both reads the list instead of the frame — which is
      // the whole reason the pictures started travelling. It comes back
      // below, when nothing can see it.
      lines.push(
        'First frame: the user supplied a reference image, and it is attached to this message. Look at it. What is in it is what the video opens on — describe the subject from the picture, not from the brief.'
      );
    } else {
      lines.push('First frame: the user supplied a reference image.');
      if (controls.i2v_reference.description) {
        lines.push(`You cannot see it. A tagger read it as: ${controls.i2v_reference.description}`);
      }
    }
  }

  // Wan also takes a first/last pair. Saying outright that the second image is
  // an END STATE is the load-bearing part: described as just another
  // reference, two images read as two subjects and both land in the subject
  // layer, which is the opposite of the one continuous action wan.md asks for.
  if (controls.i2v_last_reference) {
    lines.push(
      carriesImage
        // Which picture is which is load-bearing and cannot be left to
        // position alone: two attached photographs with no stated order are
        // two subjects, and reversing them describes the clip backwards.
        ? 'Last frame: the user supplied the ending image, attached second — the first frame is the first picture, this is the second. Look at both and describe the motion that carries the first into the last.'
        : 'Last frame: the user supplied the ending image. Describe the motion that carries the first frame into it.'
    );
    if (!carriesImage && controls.i2v_last_reference.description) {
      lines.push(`You cannot see it. A tagger read it as: ${controls.i2v_last_reference.description}`);
    }
  }

  // LTX Director: the timeline. The node concatenates global + every segment
  // into one string before the encoder sees it, which is why no timecode is
  // asked for in the output — see server/director.mjs for the quoted source.
  lines.push(...directorLines(model, controls));

  // The keyframe readings, numbered by the segment each belongs to. After the
  // timeline lines rather than inside them: the timeline is the person's
  // skeleton and these are what somebody saw in their pictures, and a reading
  // interleaved with the beats reads as more of the brief.
  lines.push(...keyframeLines(directorKeyframes(model, controls), keyframeReadings));

  // Label class per reference, not `<Picture N>` for everything — see
  // server/references.mjs, which follows the Director node's own rules.
  if (Array.isArray(controls.references) && controls.references.length) {
    // The mode picks which limits apply. It has already been resolved by
    // handleGenerate, so "Auto detect" never reaches here and the warnings
    // name a mode the person can actually act on.
    const { lines: refLines, warnings } = formatReferences(controls.references, controls.mode);
    if (labelledLines) {
      // Picture labels: the cast block stands in for every picture line, and only
      // video and audio keep their usual ones. See server/picture-labels.mjs.
      const others = refLines.filter((l) => !l.startsWith('- <Picture'));
      if (others.length) {
        lines.push('');
        lines.push('References:');
        lines.push(...others);
      }
      lines.push(...labelledLines);
    } else {
      lines.push('');
      lines.push('References:');
      lines.push(...refLines);
      // h3's per-picture readings, when they ran: what each labelled picture shows.
      lines.push(...pictureLines);
    }

    // The pictures, named by the label they were just given. These lines say
    // what each file's JOB is — frame anchor, style only, structure only —
    // which is the Director's contract and is not a description of anything.
    // A model that has only read them knows a <Subject 1> exists and has no
    // idea whose coat it is.
    //
    // The labels come from the caller rather than from `images` here, because
    // the caller is the side that knows which pictures actually went: one
    // over the ceiling, or one that arrived malformed, is a line here naming
    // a photograph that is not attached.
    if (carriesImage && attachedLabels.length) {
      lines.push('');
      lines.push(
        attachedLabels.length === 1
          ? `The picture for ${attachedLabels[0]} is attached to this message. Look at it — the line above says what it is FOR, the picture says what is in it.`
          : `The pictures for ${attachedLabels.join(', ')} are attached to this message, each one right after its label. Look at them — the lines above say what each one is FOR, the pictures say what is in them.`
      );
    }
    for (const w of warnings) console.warn(`[references] ${w}`);
  }

  // Reference images on the image models. A different formatter and a
  // different control key, deliberately: `references` above is the Director's
  // contract and answers to that node's label classes, while these answer to
  // nothing but the image prompt files. Merging them would mean one of the
  // two citing a convention with no reader — see server/imagerefs.mjs.
  // Image models only. The pictures were always gated by type (see
  // referenceImageParts vs videoReferenceParts), but these lines were not, so
  // a browser that switched anima -> h3 with cards still in memory put anima's
  // reference notes into h3's prompt. Fixed on the client 11 Sep 2026; gated
  // here as well so a stale tab cannot do it either.
  if (model.type !== 'video' &&
      Array.isArray(controls.image_references) && controls.image_references.length) {
    const analysed = Boolean(String(referenceAnalysis ?? '').trim());
    const { lines: refLines, warnings } = formatImageReferences(
      controls.image_references,
      registry.defaults ?? {},
      model,
      // A read picture is a carried picture as far as this formatter is
      // concerned: its one use of the flag is the "nothing reached the model"
      // warning, and something did.
      { carriesImage: carriesImage || analysed }
    );
    if (refLines.length) {
      lines.push('');
      lines.push(
        analysed
          // Neither of the two below. The pictures are not attached and the
          // model is not working blind — somebody already looked, and the
          // reading is further down this message. Saying "look at them" to a
          // model with nothing to look at is the same failure as telling a
          // model that can see that it cannot, one call later.
          ? 'Reference pictures the user attached. You are not being shown them — they have already been read for you, and that reading is below. These notes say what each picture is FOR and how closely to follow it:'
          : carriesImage
          // The pictures are attached to this message, in the order these
          // lines are numbered. Saying so is load-bearing twice over: it tells
          // the model the numbering is a correspondence rather than a label,
          // and it tells it that the notes ANNOTATE the picture rather than
          // replacing it — a model told only "reference 1: character" will
          // describe the note instead of looking.
          ? 'Reference images the user attached, in the order they are numbered below. Look at them. These notes say what each picture is FOR and how closely to follow it, which is the part you cannot see by looking — a photograph does not say it was attached for the lighting:'
          : 'Reference images the user attached. You cannot see the pictures — only these notes reached you, so do not describe them beyond what is written here:'
      );
      lines.push(...refLines);
    }
    for (const w of warnings) console.warn(`[image-references] ${w}`);

    // The reading itself, immediately under the notes it annotates rather
    // than at the end of the message. The notes say what each picture is FOR
    // and the reading says what is IN it, and they are numbered against each
    // other — putting the character canon or the candidate tags between them
    // would break a correspondence the model has to hold in its head.
    //
    // The rule goes first. It is the part that stops the model asking for the
    // picture, and a rule after the evidence is a rule the model has already
    // had a chance to disobey.
    if (analysed) {
      lines.push('');
      lines.push(BLUEPRINT_RULE);
      lines.push('');
      lines.push(String(referenceAnalysis).trim());
    }
  }

  // Canonical character appearance, looked up on this machine — see
  // server/character.mjs for why it resolves at all and what it refuses to
  // resolve. Built by the caller because it needs a danbooru round trip on a
  // cache miss and this function is synchronous.
  //
  // Placed after the reference images, but the precedence between the two is
  // stated in the text rather than implied by the order. Both answer the same
  // question — what does this person look like — and where they disagree the
  // person's own attached picture must win, because they chose it. Which
  // position a model weights more heavily is not something measured here, and
  // a rule that matters should not rest on an assumption about that.
  if (characterText) {
    lines.push('');
    lines.push(characterText);
  }

  // Real tags for what the brief describes: the candidates finder and the
  // paraphrase lexicon. Passed in since 30 Aug 2026 and never pushed until
  // 12 Sep, so neither list had ever reached a model - found wiring the
  // lexicon in.
  if (candidateText) {
    lines.push('');
    lines.push(candidateText);
  }

  return lines.join('\n');
}

/**
 * Resolve the detail slider to the level's label and rule text.
 *
 * Out-of-range or absent values fall back to the model's default rather than
 * failing: the control is new, and a saved library entry or a client that has
 * not reloaded will not carry it.
 */
/**
 * The creativity preset's rule text, or null when it has none.
 *
 * Presets without a `rule` are not an error — a model may override
 * `creativity_presets` in config/models.yaml with sampler values only, and
 * did for the whole life of this control before 30 Aug 2026. No rule means the
 * line is simply not sent, which is exactly how it behaved then.
 */
function creativityFor(model, controls) {
  const preset = controls?.creativity ?? model.default_creativity ?? 'balanced';
  const entry = (model.creativity_presets ?? {})[preset];
  if (!entry?.rule) return null;
  return { preset, label: titleCase(preset), rule: entry.rule };
}

/**
 * Whether a video generation carries a picture it has to stay true to: wan's
 * first or last frame, an image in h3's Director references (a motion or
 * voice file supplies no picture), or an LTX Director keyframe.
 */
function videoHasPicture(model, controls = {}) {
  if (model?.type !== 'video') return false;
  if (controls.i2v_reference || controls.i2v_last_reference) return true;
  const refs = Array.isArray(controls.references) ? controls.references : [];
  if (refs.some((r) => r && labelsFor(r)[0] === 'Picture')) return true;
  return directorKeyframes(model, controls).length > 0;
}

function detailFor(model, controls) {
  const table = model.detail_levels ?? {};
  const fallback = model.default_detail ?? 5;
  const raw = Number(controls?.detail);
  const level = Number.isFinite(raw) && table[raw] ? raw : fallback;
  const entry = table[level];
  if (!entry?.rule) return null;
  // `of` is counted, not written down. The ladder was five notches until
  // 4 Sep 2026 and is ten now; a model told "level 5 of 5" when 5 is the
  // middle notch would treat the middle as the ceiling.
  const of = Object.keys(table).filter((k) => Number.isFinite(Number(k))).length;
  return { level, of, label: entry.label ?? String(level), rule: entry.rule };
}

/**
 * The lighting level, or null when it is off or the model does not offer one.
 *
 * A user's scale, added 8 Sep 2026. Deliberately unlike detailFor above in
 * one way: **there is no fallback to a default with a rule**. Level 0 carries
 * no `rule`, level 0 is the default, and `!entry?.rule` returns null — so a
 * person who never touches the slider sends nothing and gets exactly the
 * prompt this app produced before the control existed. A ladder that started
 * at its neutral middle would have changed every prompt for everyone on the
 * day it shipped.
 *
 * The same line also handles the three video models, which declare
 * `lighting_levels: {}` to opt out: an empty table resolves no entry, so
 * nothing is injected and no code here names a model.
 */
function lightingFor(model, controls) {
  const table = model.lighting_levels ?? {};
  const fallback = model.default_lighting ?? 0;
  const raw = Number(controls?.lighting);
  const level = Number.isFinite(raw) && table[raw] ? raw : fallback;
  const entry = table[level];
  if (!entry?.rule) return null;
  // Counted the same way detail's is, and for the same reason — except the
  // ladder starts at 0, so the top notch is one less than the key count.
  const of = Object.keys(table).filter((k) => Number.isFinite(Number(k))).length - 1;
  return { level, of, label: entry.label ?? String(level), rule: entry.rule };
}

/**
 * The manual length control, or null when the person did not set one.
 *
 * Replaced the word counter that used to sit under the brief, which scored
 * the person's INPUT against `model.word_target` — the target for the model's
 * OUTPUT — and painted a normal-length brief red against a rule that did not
 * exist. `word_target` still feeds the tips line and `npm run dialect`; what
 * went is the counter, on the owner's call, 26 Aug 2026.
 *
 * Deliberately strict rather than forgiving. Everything else in this file
 * falls back to a default on a bad control, because those controls have
 * defaults; this one's default is OFF, so a value that cannot be read must be
 * refused loudly rather than quietly becoming no limit at all. A person who
 * typed 500 and got no limit would have no way to tell.
 *
 * Returns { unit, value } or null. Throws ControlError on a value that was
 * clearly meant as a limit and cannot be honoured.
 */
const LENGTH_MIN = 10;
const LENGTH_MAX = 4000;

// Tokens per word, the same ratio buildUserMessage quotes back to the model.
const TOKENS_PER_WORD = 1 / 0.75;

// How far above a word request the hard ceiling sits.
//
// Not padding for its own sake: the word count describes ONE segment, while
// num_predict caps the WHOLE response — which also carries a negative prompt
// and a reasoning segment, together about as long again as the prompt itself
// in every output measured. 3x leaves room for all of them and then some.
//
// **A guess, chosen to be generous.** The failure it prevents is a hang; the
// failure it could cause is a clipped reasoning segment on an answer that was
// already three times longer than asked for.
const WORD_LIMIT_HEADROOM = 3;

/**
 * The hard token ceiling for one generation, or undefined for none.
 *
 * A TOKEN limit is exact. The person asked to be cut off at N tokens and the
 * user turn says so in as many words.
 *
 * A WORD limit is not, and that stays true: buildUserMessage asks for
 * "approximately N words" and leaves the model to finish its segments, because
 * truncating mid-sentence would break the segment contract to enforce
 * something that was only ever approximate.
 *
 * **But "not a cut-off" was implemented as "no ceiling at all", and that is
 * what hangs the server.** Measured 30 Aug 2026: illustrious asked for 250
 * words returned no usable prompt at all — a runaway tag list that ran until
 * the 120s timeout, from `wet_boots, rainboots, rubber_boots` through
 * `skincare_routine, cosmetics, vanity`, carrying five hair colours and two
 * eye colours at once. The model had stopped describing the brief and started
 * reciting its vocabulary. On the words path nothing could stop it, because
 * num_predict was only ever sent for the tokens path.
 *
 * So the ceiling sits far above the request: a real answer never reaches it,
 * and a runaway hits it in seconds instead of hanging for two minutes.
 */
function tokenBudget(maxLength) {
  if (!maxLength) return undefined;
  if (maxLength.unit === 'tokens') return maxLength.value;
  return Math.round(maxLength.value * TOKENS_PER_WORD * WORD_LIMIT_HEADROOM);
}

function lengthFor(controls) {
  const raw = controls?.max_length;
  if (raw == null || raw === '' || raw === false) return null;

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ControlError('max_length must be {unit, value}.');
  }
  const unit = String(raw.unit ?? '').toLowerCase();
  if (unit !== 'words' && unit !== 'tokens') {
    throw new ControlError('max_length unit must be "words" or "tokens".');
  }
  const value = Number(raw.value);
  if (!Number.isInteger(value)) {
    throw new ControlError(`max_length value must be a whole number of ${unit}.`);
  }
  if (value < LENGTH_MIN || value > LENGTH_MAX) {
    throw new ControlError(
      `max_length must be between ${LENGTH_MIN} and ${LENGTH_MAX} ${unit}; got ${value}.`
    );
  }
  return { unit, value };
}

function samplingFor(model, controls) {
  const preset = controls?.creativity ?? model.default_creativity ?? 'balanced';
  const table = model.creativity_presets ?? {};
  return table[preset] ?? table.balanced ?? {};
}

// ─────────────────────────────── routes ───────────────────────────────

// How long to keep waiting on a backend that says it is still loading, and
// how often to re-ask. The ceiling is deliberately below the 120s global
// request timeout so a genuinely stuck load still surfaces as an error
// rather than hanging until the socket dies.
const MODEL_LOADING_RETRY_MS = 3000;
const MODEL_LOADING_MAX_WAIT_MS = 90000;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * A tool call's arguments in the shape the backend will render.
 *
 * llm.mjs normalises what comes *in* to a JSON string, because that is the
 * OpenAI wire shape and one shape is easier to consume than two. Sending it
 * back is where the two diverge: Ollama's chat template treats `arguments` as
 * an object and walks its keys, so handing it a string produces
 *
 *   HTTP 400 — Value looks like object, but can't find closing '}' symbol
 *
 * on the round *after* the tool ran, which reads like the tool broke and is
 * actually the template refusing to render the model's own previous turn.
 * Measured against `qwen3.8-27b-heretic` on the P40, 30 Aug 2026, after three
 * perfectly good searches.
 *
 * Unparseable arguments become an empty object rather than throwing: the tool
 * has already answered, and losing the round to a malformed echo of a call
 * that worked would be the wrong failure.
 */
function toolArgsForBackend(raw) {
  if ((config.llm?.backend ?? 'ollama') !== 'ollama') return raw;
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The tools this generation may offer, or null for none.
 *
 * Four gates, and every one of them fails to null — which is the behaviour of
 * the day before tools existed, and the arm of the experiment that OBLITERATED
 * runs in:
 *
 *   1. `tools.enabled` in config/server.yaml, or PROMPTFORGE_TOOLS.
 *   2. The registry entry opting in. Only the booru dialects want a tag
 *      search; asking krea2 to look up `thigh_boots` before writing a
 *      paragraph of prose is a round trip spent on nothing.
 *   3. The tag database being open. server/tools.mjs returns no definitions
 *      without it, because a tool that always answers "unavailable" is worse
 *      than no tool.
 *   4. **The backend reporting the capability.** Checked 30 Aug 2026:
 *      `qwen3.8-27b-heretic`, `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL` and
 *      `huihui_ai/qwen3.5-abliterated:9b` all report `tools`;
 *      `hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M` does not. Sending a
 *      tools array to a model without the capability makes Ollama refuse the
 *      whole request, so this gate is what stops the feature breaking the one
 *      model that cannot use it.
 *
 * Unknown counts as no, the same call refineWithVision makes about vision: if
 * /api/tags could not be read we do not know, and guessing costs a failed
 * generation rather than a missing feature.
 */
async function toolsFor(model, llmModel) {
  if (config.tools?.enabled !== true) return null;
  if (model.tools !== true) return null;
  // Two tools, offered independently. A model with a tag database and no
  // guidance documents gets one; a prose model with documents and no tag
  // style gets the other. Bailing when the tag search alone is unavailable
  // would have hidden the guidance tool behind a database it never needed.
  const defs = [
    ...toolbox.definitions({ variant: model.tag_style ?? 'underscore' }),
    ...guidance.definitions(model),
  ];
  if (!defs.length) return null;
  return (await backendTakesTools(llmModel)) ? defs : null;
}

/** Gate 4 of toolsFor, shared with chat's write_prompt tool. */
async function backendTakesTools(llmModel) {
  const name = llmModel ?? llm.model;
  const rows = await llm.catalog();
  // Only ollama reports capabilities. Other backends either report no catalog
  // or, since llama-swap arrived, a catalog whose capability fields are all
  // null — which means "unknown", not "no". Reading that silence as absence
  // would switch tools off on every model the moment the backend changed, so
  // trust the config here. llama.cpp and vLLM both take an OpenAI tools array.
  if (rows == null || llm.backend !== 'ollama') return true;
  const tagged = (s) => (String(s).includes(':') ? String(s) : `${s}:latest`);
  const row = rows.find((r) => tagged(r.model) === tagged(name));
  return Boolean(row?.capabilities?.includes('tools'));
}

/**
 * Chat's write_prompt tool definition, or null. Off with
 * `chat.prompt_tool: false` in config, and off for a backend model that
 * cannot take tools. See server/chat-prompt-tool.mjs.
 */
async function chatPromptTool(llmModel) {
  if (config.chat?.prompt_tool === false) return null;
  const def = promptToolFor(registry.keys().map((k) => registry.get(k)));
  if (!def) return null;
  return (await backendTakesTools(llmModel)) ? def : null;
}

/**
 * Chat's render_picture tool definition, or null: off unless rendering is set
 * up, this person may render, and the chat model takes tools. Off with
 * `chat.render_tool: false`. Only models with a render workflow are offered.
 */
async function chatRenderTool(llmModel, req) {
  if (config.chat?.render_tool === false || !comfy.enabled || !mayRender(req)) return null;
  const def = renderToolFor(registry.all().filter((m) => m.render?.workflow));
  if (!def) return null;
  return (await backendTakesTools(llmModel)) ? def : null;
}

/**
 * Chat's edit_picture tool definition, or null: off unless editing is set
 * up, this person may render, and the chat model takes tools. Off with
 * `chat.edit_tool: false`.
 */
async function chatEditTool(llmModel, req) {
  if (config.chat?.edit_tool === false || !edit || !mayRender(req)) return null;
  return (await backendTakesTools(llmModel)) ? editToolFor(edit.label) : null;
}

/**
 * The picture chat's edit_picture works on: the newest one in the
 * conversation, whether an edit chat made (kept on disk with it) or pictures
 * the person sent (held in memory; all of one message's, the first being the
 * one edited). Returns { pictures: [{ type, bytes }] } or { error }.
 */
function latestChatPictures(user, chat, held) {
  for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
    const m = chat.messages[i];
    if (m.edit?.picture) {
      const file = storage.chatPicturePath(user, chat.id, m.edit.picture);
      if (file) return { pictures: [{ type: 'image/png', bytes: readFileSync(file) }] };
    }
    if (m.pictures) {
      const urls = held?.get(i);
      if (!urls?.length) {
        return { error: 'The picture sent here is no longer held (sent pictures are kept in memory for two hours, and not across a restart). Attach it again.' };
      }
      return { pictures: urls.map(fromDataUrl).filter(Boolean).slice(0, edit.maxPictures) };
    }
  }
  return { error: 'There is no picture in this conversation to edit yet. Attach one.' };
}

/**
 * The prompt and the negative to render, from a finished generation's
 * segments: the first segment that is neither the negative nor an
 * explanation, and the negative the model wrote, if any. The same rule the
 * Render button follows in the browser (renderTexts in web/app.js).
 */
function renderTextsFrom(model, segments = []) {
  const meta = new Set(model.meta_segments ?? []);
  const neg = segments.find((s) => /^negative prompt$/i.test(s.label));
  const pos = segments.find((s) => s !== neg && !meta.has(s.label) && String(s.body ?? '').trim());
  return { positive: String(pos?.body ?? '').trim(), negative: String(neg?.body ?? '').trim() };
}

/**
 * Settings for a render chat asked for: the model's starter workflow at its
 * first preset, a fresh seed, no LoRAs. Chat has no pop-out to pick from, so
 * it takes the defaults the Render button opens on — except the size, when
 * the person named one, which follows the pop-out's own rules: an aspect
 * alone is the workflow's pixel count reshaped, a resolution is the short
 * side, and a resolution alone keeps the workflow's shape.
 */
function chatRenderSettings(model, ask = {}) {
  const setup = renderSetup(model);
  if (setup.error) return { error: setup.error };
  const p = setup.presets[0] ?? {};
  const d = setup.defaults;
  const { aspect, tier } = renderSizeArgs(ask, RESOLUTION_TIERS);
  const shape = aspect ?? `${d.width}:${d.height}`;
  const size = (tier ? sizeFor(shape, tier) : aspect ? nativeSizeFor(aspect, d.width, d.height) : null)
    ?? { width: d.width, height: d.height };
  return {
    settings: {
      steps: p.steps ?? d.steps,
      cfg: p.cfg ?? d.cfg,
      sampler: p.sampler ?? d.sampler,
      scheduler: p.scheduler ?? d.scheduler,
      model_file: p.model_file ?? d.model_file,
      text_encoder: d.text_encoder,
      vae: d.vae,
      width: size.width,
      height: size.height,
      seed: Math.floor(Math.random() * 2 ** 32),
      loras: [],
    },
  };
}

/**
 * One render for chat: handleRender's POST itself, in process, with the
 * chat person's identity — so the permission, the queue, the VRAM check and
 * where the picture is kept are exactly the Render button's. Same stand-in
 * response as runPromptTool. The caller must have released chat's own queue
 * ticket first.
 *
 * @returns the done payload, or { error } in words the person can read.
 */
async function runRenderTool(req, body, { onEvent, signal } = {}) {
  const fakeReq = Readable.from([Buffer.from(JSON.stringify(body))]);
  fakeReq.headers = req.headers;
  fakeReq.user = req.user;
  fakeReq.method = 'POST';
  const fakeRes = new EventEmitter();
  let buffer = '';
  let result = null;
  fakeRes.writeHead = () => fakeRes;
  fakeRes.flushHeaders = () => {};
  fakeRes.write = (chunk) => {
    buffer += String(chunk);
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (event === 'done') result = payload;
      else if (event === 'error') result = { error: payload.message ?? 'The render failed.' };
      else onEvent?.(event, payload);
    }
    return true;
  };
  fakeRes.end = (text) => {
    if (text && !result) {
      try { result = { error: JSON.parse(String(text)).message ?? 'The render was refused.' }; } catch { /* not JSON */ }
    }
    fakeRes.emit('finish');
    fakeRes.emit('close');
  };
  signal?.addEventListener('abort', () => fakeRes.emit('close'), { once: true });
  await handleRender(fakeReq, fakeRes, '/api/render', new URL('http://local/api/render'));
  return result ?? { error: 'The render returned nothing.' };
}

/**
 * What chat should know about this turn that its prompt file cannot: which
 * cards the box has (read live, so it never goes stale the way a written-in
 * "Tesla P40" did) and whether web search ran. Both measured 2 Oct 2026:
 * chat told a person their card was the P40 a fortnight after it left, and
 * with search off it wrote "Searching for..." and then guessed.
 */
async function chatContext(body) {
  const lines = [];
  const cards = await sysmon.hardware().catch(() => []);
  if (cards.length) {
    const list = cards.map((c) =>
      `${c.name}${c.architecture ? ` (${c.architecture}${c.compute ? `, compute ${c.compute}` : ''})` : ''}, ${c.vram_gb} GB`);
    lines.push(`The ${cards.length === 1 ? 'GPU' : 'GPUs'} in this server, read live from nvidia-smi just now: ${list.join('; ')}. This is the authority on the hardware; where anything else describes it differently, this wins.`);
  }
  if (!config.search?.enabled) {
    lines.push('Web search is not available on this server. You cannot look anything up; when an answer needs current information, say so.');
  } else if (body.search === true) {
    lines.push('Web search ran for this message; its results are in front of the question.');
  } else {
    lines.push('Web search did not run for this message: the Search button was off, and you cannot search on your own. Never say you are searching. When an answer needs current information, say so and suggest asking again with Search on.');
  }
  return lines.join('\n');
}

/**
 * The second pass, run on a result the person is already looking at.
 *
 * Asked for 31 Aug 2026 and designed as something that fires automatically on
 * a failed check. Built 4 Sep as a BUTTON instead, which is the owner's shape
 * and a better one: "you look at the first one, if it's good enough or gets
 * your mind in the state to edit it yourself then great, and if you don't like
 * it you can just hit it with a second pass." A pre-flight toggle asks for a
 * decision at the one moment nobody can make it.
 *
 * **Not Refine.** Refine appends an instruction to the brief and regenerates
 * from scratch; the model never sees what it wrote. This hands the draft back
 * to the model with the brief beside it and asks for an edit. Refine is for
 * "make it colder"; this is for "that is not your best work".
 *
 * Takes the segments from the client rather than re-reading a stored result,
 * because what is on screen is what the person is judging - they may have
 * loaded it out of session history, or undone back to it.
 */
/**
 * `{ simple_prompt }` for a `done` event, or nothing. Spread into the payload,
 * so a model without `simple_prompt` sends exactly what it sent before.
 */
/**
 * The system tail for Refine. Held in code rather than prompts/: it is the
 * mechanics of an edit, not a model's dialect, and the dialect rules are
 * still the system prompt in front of it.
 */
const REFINE_INSTRUCTION =
  'The person has read the prompt you wrote and wants one change. Make that change and only that change. ' +
  'Every segment, shot and line the request does not touch comes back exactly as it is, word for word. ' +
  'Where the change has to reach into something else - a later cut that moves, a timing that shifts - change only what it must. ' +
  'Return the whole prompt in the same segment format.';

function simpleField(model, controls, segments) {
  const text = simplePrompt(model, controls ?? {}, segments);
  return text ? { simple_prompt: text } : {};
}

/**
 * Find people: boxes round everyone in one picture, for the picture card's
 * people boxes (server/people-boxes.mjs). Asked of the model that reads this
 * model's pictures, so the boxes come from the same eyes as the reading.
 * Measured 13 Oct 2026: r4 boxed a five-girl band in 7s and a piggyback in
 * 5s, both right; Q4_K_P and Q6_K_P gave the same boxes, slower.
 */
async function handlePeople(req, res) {
  let body;
  try {
    body = await readBody(req, GENERATE_BODY_LIMIT);
  } catch (err) {
    return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
  }
  const target = registry.get(body.model);
  if (!target) return sendJSON(res, 400, { error: 'unknown_model', message: `Unknown model "${body.model}".` });
  const image = typeof body.image === 'string' && SENDABLE_IMAGE.test(body.image) ? body.image : null;
  if (!image) return sendJSON(res, 400, { error: 'no_image', message: 'Send the picture as a data URL.' });
  // A model named for boxing wins: on a 27B writer Find people took 103s, on
  // the 4B 2-4s. See people_boxes in config/server.yaml.
  const named = String(config.people_boxes?.model ?? '').trim();
  const model = named || (chooseModel(target, storage.getPrefs(whoIs(req))) ?? llm.model);
  if (!model) return sendJSON(res, 503, { error: 'no_model', message: 'No model is selected.' });
  if ((await visionTags.canSee(model)) === false) {
    return sendJSON(res, 503, { error: 'no_vision', message: `${model} cannot see pictures, so it cannot find people. Add the boxes yourself with Add character.` });
  }

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model, kind: 'people' });
  const started = Date.now();
  try {
    await ticket.started;
    usageStats.record(model);
    let text = '';
    for await (const ev of llm.stream({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: FIND_PEOPLE_PROMPT }] }],
      model,
      temperature: 0,
      thinking: false,
      maxTokens: 1500,
      signal: abort.signal,
    })) {
      if (ev.type === 'token') text += ev.text ?? '';
    }
    const people = parsePeople(text, await pictureSize(image).catch(() => null));
    console.log(`[people] ${target.key}: ${people.length} found by ${model} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (!people.length) console.warn(`[people] ${target.key}: no boxes in the answer, began: ${JSON.stringify(text.slice(0, 200))}`);
    return sendJSON(res, 200, { people, model, ms: Date.now() - started });
  } catch (err) {
    if (abort.signal.aborted) return undefined;
    return sendJSON(res, 502, { error: err instanceof LLMError ? err.code : 'failed', message: `Finding people failed (${err.message}). Add the boxes yourself with Add character.` });
  } finally {
    ticket.release();
  }
}

/**
 * POST /api/cast — one character's card on the Cast list, read from all
 * their pictures (each from their people box, where they have one). Or,
 * with `subject` ("place", "style", "pose@N"), the card of the place, the
 * style or the pose in <Picture N>, read from its own pictures.
 *
 * Same body as a generation (model, brief, controls) plus `character`, the
 * number to read; `redo` reads again rather than answering from the cache.
 * The reader is the same one Generate runs for that character, with the same
 * message, so a card says what Generate would have read. Read by
 * people_boxes.model when it names one: about a second a person on the 4B,
 * where a 27B takes a minute and more. Answers { number, text, model, ms },
 * the look only: Retention's kept list is made from the card's text.
 */
async function handleCast(req, res) {
  let body;
  try {
    body = await readBody(req, GENERATE_BODY_LIMIT);
  } catch (err) {
    return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
  }
  const target = registry.get(body?.model);
  if (!target || target.type !== 'video') return sendJSON(res, 400, { error: 'bad_model', message: 'The Cast list is for h3 references.' });
  const system = prompts.pictureDescription();
  if (!system) return sendJSON(res, 503, { error: 'describe_off', message: 'Picture descriptions are switched off on this server.' });
  // A character by number, or since 14 Oct 2026 the place, the style or the
  // pose in a picture: `subject` "place", "style" or "pose@N".
  const subject = typeof body.subject === 'string' ? body.subject : null;
  const number = Number(body.character);
  if (!subject && (!Number.isInteger(number) || number < 1)) return sendJSON(res, 400, { error: 'bad_character', message: 'Say which character to read.' });
  const what = !subject ? `Character ${number}` : subject === 'place' ? 'the place' : subject === 'style' ? 'the style' : 'the pose';
  const brief = foldShotBriefs(String(body.brief ?? ''), body.controls ?? {});
  const controls = resolveAutoControls(applyPictureLabels({ ...(body.controls ?? {}), picture_labels: true }));
  const cast = labelledCast(controls.references ?? []);
  const found = subject ? sceneUnit(cast, describeUnits(cast), subject) : castUnit(cast, describeUnits(cast), number);
  if (!found || !found.unit.refs.some((r) => r?.image)) {
    return sendJSON(res, 404, { error: 'not_shown', message: subject
      ? `No picture shows ${what} to read. Write its description yourself.`
      : `No picture shows Character ${number} so that they can be read on their own. Write their description yourself.` });
  }
  const named = String(config.people_boxes?.model ?? '').trim();
  const llmModel = named || (chooseModel(target, storage.getPrefs(whoIs(req))) ?? llm.model);
  if (!llmModel) return sendJSON(res, 503, { error: 'no_model', message: 'No model is selected.' });
  if ((await visionTags.canSee(llmModel)) === false) {
    return sendJSON(res, 503, { error: 'no_vision', message: `${llmModel} cannot see pictures. Write the description yourself.` });
  }

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model: llmModel, kind: 'cast' });
  const started = Date.now();
  const warnings = [];
  try {
    await ticket.started;
    usageStats.record(llmModel);
    // The role carries the message's hash, as at Generate, so the two share the cache.
    const describe = (u) => describeMessage(u, brief);
    const asked = (u) => createHash('sha256').update(system).update('\0').update(describe(u)).digest('hex').slice(0, 8);
    const [unit] = await withCrops([{ ...found.unit, role: `${found.unit.role}:${asked(found.unit)}` }]);
    const read = await readPictures({
      model: target,
      llmModel,
      units: [unit],
      system,
      signal: abort.signal,
      sse: { send: (ev, data) => { if (ev === 'warning') warnings.push(data.message); } },
      message: describe,
      maxTokens: 240,
      useGiven: false,
      keyOf: (u) => u.tag,
      force: body.redo === true,
      temperature: body.redo === true ? 0.5 : PICTURE_TEMPERATURE,
    });
    const text = castLook(read.get(unit.tag), found);
    console.log(`[cast] ${target.key}: ${what} read by ${llmModel} in ${((Date.now() - started) / 1000).toFixed(1)}s, ${text.length} chars`);
    if (!text) {
      return sendJSON(res, 502, { error: 'no_reading', message: warnings[0] ?? `${llmModel} did not come back with a description. Press ${subject ? 'Scan picture' : 'Scan people'} on its picture to try again, or write it yourself.` });
    }
    return sendJSON(res, 200, { number: subject ? null : number, subject, text, model: llmModel, ms: Date.now() - started });
  } catch (err) {
    if (abort.signal.aborted) return undefined;
    return sendJSON(res, 502, { error: err instanceof LLMError ? err.code : 'failed', message: `Reading ${what} failed (${err.message}).` });
  } finally {
    ticket.release();
  }
}

async function handleRevise(req, res) {
  let body;
  try {
    body = await readBody(req, GENERATE_BODY_LIMIT);
  } catch (err) {
    return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
  }

  const model = registry.get(body.model);
  if (!model) {
    return sendJSON(res, 400, { error: 'unknown_model', message: `Unknown model "${body.model}".` });
  }
  body.brief = foldShotBriefs(body.brief, body.controls ?? {});
  // Refine: the person names one change. Same call as the second pass, with
  // their request in place of second-pass.md - the model sees its draft and
  // edits it. Refine used to append the request to the brief and regenerate,
  // which is how "change shot 4" came back as a whole new prompt.
  const refineWith = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  // Continue story: the NEXT part, written as a fresh draft whose brief is the
  // part already made plus what happens next (`instruction`, when given).
  // Not an edit of the draft: handed back as the model's own answer, the
  // h3-tuned 4B returned it word for word every time (12 Oct 2026), the same
  // thing Forge's continuity hit. As a brief it is something to build on.
  const continuing = body.continue === true;
  const instruction = continuing ? '' : refineWith ? REFINE_INSTRUCTION : prompts.secondPass();
  if (!continuing && !instruction) {
    return sendJSON(res, 503, {
      error: 'second_pass_unavailable',
      message: 'The second-pass instruction file is not loaded on this server.',
    });
  }
  const given = Array.isArray(body.segments) ? body.segments : [];
  if (!given.length) {
    return sendJSON(res, 400, { error: 'no_segments', message: 'Nothing to revise.' });
  }

  // Meta segments are the model's own commentary about its work - Reasoning,
  // What changed. Revising those would be asking it to re-justify rather than
  // re-write. `segments` minus `meta_segments` from the registry, never the
  // literal label "Positive prompt": only six of the ten models emit that, and
  // Krea2, Flux and LTX all call it something else.
  const metaLabels = new Set(model.meta_segments ?? []);
  const revisable = given.filter((seg) => seg?.label && !metaLabels.has(seg.label));
  if (!revisable.length) {
    return sendJSON(res, 400, {
      error: 'nothing_revisable',
      message: 'Every segment in that result is commentary rather than prompt.',
    });
  }

  const controls = resolveAutoControls(applyPictureLabels({ ...body.controls }));
  const system = prompts.get(model.key, controls.mode);
  if (!system) {
    return sendJSON(res, 500, { error: 'prompt_unavailable', message: `No system prompt for ${model.key}.` });
  }
  const goneWriter = await writerNotInstalled(model, req);
  if (goneWriter) return sendJSON(res, 400, goneWriter);

  const sse = openSSE(req, res);
  const abort = new AbortController();
  // **res, not req.** Measured 5 Sep 2026 on the P40: when the client goes
  // away mid-generation, `res` emits 'close' and `req` does not — the request
  // stream has already ended, because its body was read in full before the
  // handler ever started. So this listener never fired, abort() was never
  // called, the upstream generation ran to completion on the GPU, and the
  // handler never reached the finally that releases the queue ticket.
  //
  // Reported as cancelling doing nothing: the person pressed Stop, then queued
  // behind their own abandoned job and waited out the rest of it.
  //
  // Firing on a NORMAL finish too is harmless — abort() after the work is done
  // is a no-op, and the ticket has already been released by then.
  res.on('close', () => abort.abort());

  try {
    sse.send('status', { state: 'revising' });

    // A pasted style comes off the draft and goes back on after, so the
    // revision neither rewrites it nor doubles it. See server/style.mjs.
    const styleBlock = pastedStyle(model, controls);
    const draft = revisable
      .map((seg) => `===SEGMENT: ${seg.label}===\n${stripStyle(String(seg.body ?? ''), styleBlock).trim()}`)
      .join('\n\n');

    // Everything the FIRST pass was given, or the revision is judging the
    // draft against a brief that never justified half of it.
    //
    // The bug this fixes, found before it bit: buildUserMessage takes six
    // arguments and this was passing three. So the second pass saw the brief
    // and the controls, but not the character canon, the standing instruction
    // or the candidate tags - and roughly half the tags in a character prompt
    // come from canon the server injected. second-pass.md tells the model to
    // cut "a detail that arrived with the vocabulary rather than from the
    // person", which is a precise description of canonical tags when you
    // cannot see the canon. It was set up to strip exactly the tags that make
    // a character prompt good, and to be confident about it.
    //
    // The lookup is a second call, and a cheap one: a hit is a sqlite read
    // against a 30-day cache, and the first pass warmed it seconds ago.
    const prefs = storage.getPrefs(whoIs(req));
    const characterText = await characterCanon(model, body.brief ?? '', controls);
    const candidateText = [
      config.candidates?.enabled === true && model.tag_style
        ? candidates.block(body.brief ?? '', { variant: model.tag_style })
        : '',
      lexiconFor(model) ? lexicon.block(body.brief ?? '', { variant: model.tag_style }) : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const llmModel = chooseModel(model, prefs);
    usageStats.record(llmModel ?? llm.model);
    metrics.incGenerations(llmModel ?? llm.model);

    // The pictures again, on the same terms as the first pass. Not an
    // optimisation to skip: the second pass is told to cut "a detail that
    // arrived with the vocabulary rather than from the person", and a
    // revision that cannot see the reference cannot tell a detail that came
    // off the picture from one the model invented. That is the same shape of
    // bug as the missing arguments this call site already carries a note
    // about — the reviser judging the draft on less than the draft was
    // written from.
    //
    // Same lane split as the first pass. A revision of a video prompt that
    // cannot see the frame is the exact failure this paragraph is about, one
    // model type over.
    const refImages =
      model.type === 'video'
        ? videoReferenceParts(controls ?? {}, registry.defaults ?? {})
        : referenceImageParts(controls?.image_references ?? [], registry.defaults ?? {});
    const canLook =
      refImages.parts.length > 0 && (await visionTags.canSee(llmModel ?? llm.model)) !== false;

    // The reading the draft was written from, handed back by the client with
    // the segments it is asking about. Same argument as `segments` itself —
    // what is on screen is what the person is judging, and the reading that
    // produced it is part of that, not something to re-derive.
    //
    // This is also a user's rule about not stacking model passes on a visual
    // request. His case was a text-only pass that never saw the picture and
    // replaced a described pose with "the pose in the reference"; a pass
    // holding the reading cannot make that mistake, and re-reading the
    // pictures here would be a third call to arrive at what we already have.
    //
    // Absent — an older result, or a generation where the read did not
    // happen — falls back to the pictures, which is what this did before.
    //
    // And only with proof it still matches the current pictures (PR 7): a
    // reading's length is not that proof. Removing a Character card and
    // keeping a Pose card handed back the removed subject's reading, and the
    // reading being present kept the remaining picture off the call.
    const analysis = reusableReferenceAnalysis(model, body.brief, controls, registry.defaults ?? {});
    const carriesImage = canLook && !analysis;

    // The part so far is its longest prompt segment: the shots in h3, the one
    // paragraph in Wan and LTX. Definitions and summaries come back from the
    // pictures and the dialect rules on their own.
    const storyLabel = revisable.reduce((a, b) => (String(b.body ?? '').length > String(a.body ?? '').length ? b : a)).label;
    const storySoFar = String(revisable.find((seg) => seg.label === storyLabel)?.body ?? '').trim();
    // Only how the last part OPENED (who, where, the look) and how it ENDED,
    // as prose without shot markers or cut times. Handed the whole part, the
    // 4B and both 27Bs copied its shots back - with markers it read as a
    // template, and without them still as a story to retell (12 Oct 2026).
    const hadShots = /\[Shot \d+\]/.test(storySoFar);
    const blocks = (hadShots ? storySoFar.split(/\[Shot \d+\]/) : storySoFar.split(/\n\s*\n/))
      .map((b) => b.replace(/\bAt \d{1,2}:\d{2}(?:\.\d+)?,\s*/g, '').trim())
      .filter(Boolean);
    const storyContext = blocks.length > 1
      ? `It opened like this:\n${blocks[0]}\n\nAnd it ended like this:\n${blocks[blocks.length - 1]}`
      : `It went like this:\n${blocks[0] ?? ''}`;
    const userText = buildUserMessage(
      model,
      continuing
        ? `The next part of a video. The part before it is already made. ${storyContext}\n\n` +
          'Write the part that comes after it. It starts where that one ended, with the same people, the same place and the same look, and shows: ' +
          (refineWith || 'what happens next - new action that moves the story on.') +
          (hadShots ? '\n\nThis part is its own clip: its shots number from 1 and its time starts at 00:00.' : '')
        : body.brief ?? '',
      controls,
      characterText,
      prefs.custom_instruction ?? '',
      candidateText,
      omitFor(model, prefs, registry.defaults),
      { carriesImage, referenceAnalysis: analysis, attachedLabels: refImages.labels ?? [] }
    );

    let text = '';
    for await (const ev of llm.stream({
      // The model's own dialect rules again, with the revision instruction
      // last - the ordering rule composition already follows, where the more
      // specific instruction gets the final word.
      system: continuing ? system : `${system}\n\n---\n\n${instruction}`,
      messages: [
        {
          role: 'user',
          content: carriesImage ? [{ type: 'text', text: userText }, ...labelledImageParts(refImages)] : userText,
        },
        ...(continuing ? [] : [
          { role: 'assistant', content: draft },
          { role: 'user', content: refineWith ? `Change this: ${refineWith}` : 'Revise it.' },
        ]),
      ],
      // Lower than a draft's. This is an edit, and the sampling that makes a
      // first attempt interesting makes a revision drift off the brief. A
      // continuation is not an edit: it is new writing, sampled like a draft.
      ...(continuing
        ? (({ temperature, top_p }) => ({ temperature, top_p }))(samplingFor(model, controls))
        : { temperature: 0.3 }),
      thinking: false,
      model: llmModel,
      timeoutMs: model.timeout_ms,
      contextLength: model.context_length,
      signal: abort.signal,
      mock: { model, brief: body.brief ?? '' },
    })) {
      if (ev.type === 'token') {
        text += ev.text ?? '';
        sse.send('token', { text: ev.text ?? '' });
      }
    }

    // Expect the model's WHOLE contract. Its system prompt tells it to emit
    // every segment and it does; asking for a subset made a correct answer
    // look like a violation on the first run of this.
    let parsed;
    try {
      // The draft it was given already excludes anything this account switched
      // off, so those labels are not in `given` — but the model's own prompt
      // file still lists them, and a second pass that helpfully adds the
      // Reasoning back would otherwise fail the whole revision as an unknown
      // segment. Allowed and dropped, exactly as in the first pass.
      parsed = parseSegments(text, given.map((seg) => seg.label), {
        discard: omitFor(model, prefs, registry.defaults),
        aliases: Object.fromEntries(Object.entries(model.segment_fields ?? {}).map(([label, field]) => [field, label])),
      });
    } catch (err) {
      // What came back instead, briefly: without it a failure here cannot be
      // told apart from a refusal, a prose answer or a truncated one.
      console.warn(`[${continuing ? 'continue' : refineWith ? 'refine' : 'second-pass'}] ${model.key}: unparseable, began: ${JSON.stringify(text.slice(0, 300))}`);
      sse.send('error', {
        code: 'unparseable',
        message: `The model's answer did not follow the segment format (${err.message}). Your prompt is unchanged - try again.`,
      });
      return sse.end();
    }

    // Only swap in a segment that came back with content, and never a meta
    // one. A revision returning half the segments must not blank the other
    // half - the draft is a real answer and a partial rewrite is not.
    const out = given.map((seg) => {
      // A continuation's commentary is about the new part; the old part's
      // Reasoning would describe something else.
      if (continuing && metaLabels.has(seg.label)) {
        const next = parsed.segments.find((r) => r.label === seg.label)?.body;
        return { ...seg, body: typeof next === 'string' ? next.trim() : '' };
      }
      if (metaLabels.has(seg.label)) return seg;
      const next = parsed.segments.find((r) => r.label === seg.label)?.body;
      return typeof next === 'string' && next.trim() ? { ...seg, body: next.trim() } : seg;
    });
    // The third pass, as on a first generation: a revision can write a fake
    // tag as easily as a draft can. Only on what was actually rewritten.
    for (const [i, seg] of out.entries()) {
      if (seg.label !== 'Positive prompt' || seg.body === given[i].body) continue;
      seg.body = thirdPass(model, seg.body, {
        brief: body.brief ?? '',
        spared: [controls.positive ?? '', ...(Array.isArray(controls.tags) ? controls.tags : [])],
      });
    }

    pasteStyle(model, controls, out);

    // A rewrite can put a cut past the end too. See server/shots.mjs.
    {
      const moved = repairCutTimes(controls, out);
      if (moved.length) console.log(`[shots] ${model.key}: moved cut ${moved.map(([a, b]) => `${a} -> ${b}`).join(', ')}`);
    }

    const changed = out.filter((seg, i) => seg.body !== given[i].body).length;
    // The failure a continuation can have that an edit cannot: handing the
    // old part back. Advisory only, and measured on the story segment alone:
    // definitions and sound are meant to carry over, and counting them hid a
    // part whose shots were a straight copy.
    if (continuing) {
      const words = (text) => new Set(String(text ?? '').toLowerCase().match(/[a-z']+/g) ?? []);
      const a = words(storySoFar), b = words(out.find((seg) => seg.label === storyLabel)?.body);
      const shared = [...b].filter((w) => a.has(w)).length;
      if (shared / Math.max(1, new Set([...a, ...b]).size) > 0.75) {
        sse.send('warning', { message: 'This part reads almost the same as the last one. Say what happens next in the box and continue again.' });
      }
      // "The next part of a video" reads to the model as MiniMax's video
      // continuation task, which means editing a source <Video N>. With no
      // video attached it is a new clip, so the task type says so.
      const summary = out.find((seg) => seg.label === 'Summary');
      const hasVideo = (controls.references ?? []).some((ref) => ref?.kind === 'video');
      if (summary && !hasVideo) {
        summary.body = summary.body
          .replace(/\[video continuation \+ /g, '[')
          .replace(/ \+ video continuation\]/g, ']')
          .replace(/\[video continuation\]/g, '[reference generation]');
      }
    }
    console.log(`[${continuing ? 'continue' : refineWith ? 'refine' : 'second-pass'}] ${model.key}: ${changed} of ${revisable.length} segment(s) rewritten`);

    if (controls.mode === 'REF2VA') {
      const definitions = out.find((seg) => seg.label === 'Subject definitions')?.body;
      for (const message of groupWarnings(definitions, controls.references)) sse.send('warning', { message });
      for (const message of referenceGroundingWarnings(definitions, controls.references, controls.mode)) sse.send('warning', { message });
    }
    // Reassembled from the revision, never carried over: the Simple prompt is
    // the segments wrapped, so the old one would be the old draft. The mode was
    // resolved from "Auto detect" at the top of this handler.
    //
    // The reading goes back explicitly, empty when it was refused, so the page
    // cannot carry a rejected one forward into the next revision.
    sse.send('done', {
      segments: out,
      changed,
      reference_analysis: analysis,
      reference_analysis_identity: analysis
        ? referenceAnalysisIdentity(model, body.brief, controls.image_references ?? [], registry.defaults ?? {})
        : '',
      ...simpleField(model, controls, out),
    });
    sse.end();
  } catch (err) {
    // The draft stands, always. A failed second pass loses an improvement,
    // never the result the person already had.
    console.warn(`[second-pass] ${model.key}: failed — ${err.message}`);
    sse.send('error', { code: 'revise_failed', message: `${err.message}. Your prompt is unchanged.` });
    sse.end();
  }
}

// ───────────────────────────── render ─────────────────────────────
//
// Render from PromptForge, stage 1 of docs/render-plan.md: the finished
// prompt goes to ComfyUI through the model's own workflow, progress streams
// back over SSE, and the picture is kept on the server for keep_hours,
// readable only by whoever made it.

/**
 * A model's render setup: its workflow, mapped, with defaults and presets.
 * Read per request, so editing a workflow file needs no restart. Returns
 * { error } when the model has none or it does not map.
 *
 * With `workflowId`, one of `user`'s own uploads (stage 3) replaces the
 * starter. The model's catalogue still decides which model files can be
 * picked (agreed 3 Oct): an upload naming a file the owner never added gets
 * the starter's file instead.
 */
function renderSetup(model, { user = null, workflowId = null } = {}) {
  const r = model?.render;
  if (!r?.workflow) return { error: `${model?.label ?? 'That model'} has no render workflow.` };
  let starter;
  try {
    starter = JSON.parse(readFileSync(path.resolve(ROOT, r.workflow), 'utf8'));
  } catch (err) {
    return { error: `The ${model.label} workflow could not be read: ${err.message}` };
  }
  const starterMap = mapWorkflow(starter);
  if (starterMap.error) return { error: `${model.label} workflow: ${starterMap.error}` };
  const starterFile = workflowDefaults(starter, starterMap).model_file;

  let wf = starter;
  // The editable copy only decorates the PNG. A missing one costs the
  // "reopens in ComfyUI" part and nothing else.
  let ui = null;
  let ownWorkflow = null;
  if (workflowId) {
    ownWorkflow = userRender.read(user).workflows.find((w) => w.id === workflowId && w.models.includes(model.key)) ?? null;
    const files = ownWorkflow ? userRender.workflowFiles(user, workflowId) : null;
    if (!files?.api) return { error: 'That workflow is not one of yours for this model.' };
    wf = files.api;
    ui = files.ui ?? null;
  } else {
    try {
      if (r.ui_workflow) ui = JSON.parse(readFileSync(path.resolve(ROOT, r.ui_workflow), 'utf8'));
    } catch {
      ui = null;
    }
  }
  const map = workflowId ? mapWorkflow(wf) : starterMap;
  if (map.error) return { error: `Your workflow: ${map.error}` };
  const defaults = workflowDefaults(wf, map);
  // The basic negative is the model's own negative_defaults (agreed 3 Oct),
  // the workflow's only when the model has none; a model without a negative
  // sends an empty one, as its starter workflow does.
  defaults.negative = model.has_negative ? (model.negative_defaults ?? defaults.negative) : '';
  const presets = (r.presets ?? []).filter((p) => p?.name);
  const unique = (list) => [...new Set(list.filter(Boolean))];
  const catalogue = renderModels.read();

  // Model files: the workflow's own, any a preset names, and every file the
  // owner added for this model (agreed 3 Oct: only those, never the whole
  // folder, which mixes every model on the box).
  const modelFiles = unique([
    starterFile,
    ...presets.map((p) => p.model_file),
    ...Object.entries(catalogue.files).filter(([, e]) => e.model === model.key).map(([f]) => f),
  ]);
  if (ownWorkflow && !modelFiles.includes(defaults.model_file)) defaults.model_file = starterFile;
  // Each file's own preset: what the owner set, over a model preset naming
  // that file. Most specific wins (render-plan.md, Presets).
  const FILE_FIELDS = ['steps', 'cfg', 'sampler', 'scheduler', 'prefix', 'negative'];
  const filePresets = Object.fromEntries(
    modelFiles.map((f) => {
      const fromModel = presets.find((p) => p.model_file === f) ?? {};
      const own = catalogue.files[f] ?? {};
      return [f, Object.fromEntries(FILE_FIELDS.flatMap((k) => (own[k] ?? fromModel[k]) !== undefined ? [[k, own[k] ?? fromModel[k]]] : []))];
    })
  );
  // Text encoders and VAEs are few: everything installed, workflow's first.
  const textEncoders = map.textEncoder ? unique([defaults.text_encoder, ...comfy.installed('text_encoders')]) : [];
  const vaes = map.vae ? unique([defaults.vae, ...comfy.installed('vae')]) : [];
  // LoRAs: every installed one, each marked whether it is for this model —
  // the owner's word first, else what the file says it was trained on.
  const loras = map.lora
    ? comfy.installed('loras').map((file) => {
        const info = comfy.loraInfo(file);
        const own = catalogue.loras[file] ?? {};
        return {
          file,
          matches: Array.isArray(own.models) ? own.models.includes(model.key) : loraMatches(info, r.lora_match),
          triggers: own.triggers ?? String(info.trigger ?? '').split(',').map((t) => t.trim()).filter(Boolean),
          architecture: info.architecture,
        };
      })
    : [];
  return {
    wf,
    ui,
    map,
    defaults,
    presets,
    modelFiles,
    filePresets,
    textEncoders,
    vaes,
    loras,
    ownWorkflow,
    vramGb: Number(r.vram_gb) || comfy.defaultVramGb,
  };
}

/**
 * /api/admin/render — the owner's catalogue. Owner only: absent from
 * ADMIN_GRANTS, so the blanket /api/admin/ gate refuses everyone else.
 *
 *   GET    /api/admin/render            everything the panel shows
 *   PUT    /api/admin/render/files      { file, model, steps?, cfg?, sampler?, scheduler?, prefix?, negative? }
 *   DELETE /api/admin/render/files      { file }
 *   PUT    /api/admin/render/loras      { file, models?, triggers? }
 *   PUT    /api/admin/render/approve    { user, id, approve }  (refuse deletes it)
 */
async function handleAdminRender(req, res, pathname) {
  if (!comfy.enabled) {
    return sendJSON(res, 404, { error: 'render_disabled', message: 'Rendering is not set up on this server.' });
  }
  // Models that can render, and the folder their workflow's loader reads.
  // A function, because after a write the setups must be read again.
  const renderableNow = () =>
    registry.all().flatMap((m) => {
      const s = m.render?.workflow ? renderSetup(m) : null;
      return s && !s.error ? [{ model: m, setup: s }] : [];
    });
  const renderable = renderableNow();
  const ctx = (folder) => ({
    modelKeys: renderable.map((r) => r.model.key),
    samplers: comfy.lists.samplers,
    schedulers: comfy.lists.schedulers,
    installed: comfy.installed(folder),
  });
  const reply = () => {
    const catalogue = renderModels.read();
    const renderable = renderableNow();
    return sendJSON(res, 200, {
      models: renderable.map(({ model, setup }) => ({
        key: model.key,
        label: model.label,
        folder: setup.map.loaderFolder,
        workflow_file: setup.defaults.model_file,
        files: setup.modelFiles.map((file) => ({ file, ...setup.filePresets[file], own: Boolean(catalogue.files[file]) })),
        has_negative: model.has_negative,
      })),
      // What could be added, per loader folder.
      installed: Object.fromEntries(
        [...new Set(renderable.map((r) => r.setup.map.loaderFolder).filter(Boolean))].map((f) => [f, comfy.installed(f)])
      ),
      loras: comfy.installed('loras').map((file) => {
        const info = comfy.loraInfo(file);
        const own = catalogue.loras[file] ?? {};
        return {
          file,
          architecture: info.architecture,
          file_triggers: String(info.trigger ?? '').split(',').map((t) => t.trim()).filter(Boolean),
          // Which models it shows for now, whoever decided.
          models: renderable.filter(({ model, setup }) => setup.loras.find((l) => l.file === file)?.matches).map(({ model }) => model.key),
          own,
        };
      }),
      samplers: comfy.lists.samplers,
      schedulers: comfy.lists.schedulers,
      // Uploads waiting for the owner, with the node types they use — the
      // thing to look at before saying yes.
      pending: userRender.pending().map(({ user, id, name, models, node_types, created_at }) => ({ user, id, name, models, node_types, created_at })),
    });
  };

  if (req.method === 'GET' && pathname === '/api/admin/render') return reply();

  try {
    const body = await readBody(req, 64 * 1024);
    if (pathname === '/api/admin/render/files' && req.method === 'PUT') {
      const target = renderable.find((r) => r.model.key === body.model);
      if (!target) return sendJSON(res, 400, { error: 'unknown_model', message: `Unknown model "${body.model}".` });
      renderModels.setFile(body.file, body, ctx(target.setup.map.loaderFolder));
      return reply();
    }
    if (pathname === '/api/admin/render/files' && req.method === 'DELETE') {
      renderModels.removeFile(String(body.file ?? ''));
      return reply();
    }
    if (pathname === '/api/admin/render/loras' && req.method === 'PUT') {
      renderModels.setLora(body.file, body, ctx('loras'));
      return reply();
    }
    // Approve lets it run; refuse deletes it, so it stops waiting and the
    // person sees it gone from their list.
    if (pathname === '/api/admin/render/approve' && req.method === 'PUT') {
      const user = safeUsername(body.user, null);
      if (!user) return sendJSON(res, 400, { error: 'bad_request', message: 'Which account?' });
      if (body.approve) userRender.setApproved(user, String(body.id), true);
      else userRender.removeWorkflow(user, String(body.id));
      console.log(`[render] owner ${body.approve ? 'approved' : 'refused'} workflow ${body.id} from ${user}`);
      return reply();
    }
  } catch (err) {
    return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
  }
  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

async function handleRender(req, res, pathname, url) {
  if (!comfy.enabled) {
    return sendJSON(res, 404, { error: 'render_disabled', message: 'Rendering is not set up on this server.' });
  }
  const who = whoIs(req);

  // The picture. Only to whoever made it — prompts are unsaved on purpose,
  // and a picture carries its prompt in the PNG. Before the grant check: it
  // is your own picture, and an <img> cannot send anything but the cookie.
  const image = /^\/api\/render\/(r_[a-f0-9]{24})(?:\.png)?$/.exec(pathname);
  if (req.method === 'GET' && image) {
    const rec = comfy.readRender(image[1]);
    if (!rec || rec.user !== who) return sendJSON(res, 404, { error: 'not_found', message: 'That render is gone (they are kept for a day).' });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
    return createReadStream(rec.file).on('error', () => res.destroy()).pipe(res);
  }

  if (!mayRender(req)) {
    return sendJSON(res, 403, {
      error: 'forbidden',
      message: 'That needs the "render" permission, which the owner grants per account.',
    });
  }

  // What the Render panel and its settings pop-out are built from.
  if (req.method === 'GET' && pathname === '/api/render/options') {
    const model = registry.get(url.searchParams.get('model'));
    if (!model) return sendJSON(res, 400, { error: 'unknown_model', message: 'Unknown model.' });
    // A workflow of yours that has since been deleted falls back to the
    // starter rather than hiding the whole section.
    const mine = userRender.read(who);
    const asked = url.searchParams.get('workflow') || null;
    const workflowId = asked && mine.workflows.some((w) => w.id === asked && w.models.includes(model.key)) ? asked : null;
    const setup = renderSetup(model, { user: who, workflowId });
    if (setup.error) return sendJSON(res, 200, { available: false, message: setup.error });
    const running = await comfy.up();
    // Fresh from ComfyUI when it is up; the cached lists when it is asleep,
    // rather than waking it to fill two dropdowns.
    const lists = running ? await comfy.refreshLists() : comfy.lists;
    const withDefault = (list, v) => (list.length ? (list.includes(v) ? list : [v, ...list]) : [v]);
    return sendJSON(res, 200, {
      available: true,
      model: model.key,
      workflow: setup.ownWorkflow?.name ?? path.basename(model.render.workflow, '.json'),
      // The Workflow dropdown: the starter, then this person's own for this
      // model. One waiting for the owner is listed but cannot run yet.
      workflow_id: workflowId,
      workflows: [
        { id: null, name: `Starter: ${path.basename(model.render.workflow, '.json')}`, approved: true },
        ...mine.workflows
          .filter((w) => w.models.includes(model.key))
          .map((w) => ({ id: w.id, name: w.name, approved: w.approved })),
      ],
      runnable: setup.ownWorkflow ? setup.ownWorkflow.approved : true,
      my_presets: mine.presets.filter((p) => p.model === model.key),
      has_negative: model.has_negative,
      defaults: setup.defaults,
      presets: setup.presets,
      model_files: setup.modelFiles.map((file) => ({ file, ...setup.filePresets[file] })),
      text_encoders: setup.textEncoders,
      vaes: setup.vaes,
      // Null when the workflow has no Power Lora Loader: no LoRA section.
      loras: setup.map.lora ? setup.loras : null,
      max_loras: MAX_LORAS,
      tag_model: Boolean(model.tag_style),
      samplers: withDefault(lists.samplers, setup.defaults.sampler),
      schedulers: withDefault(lists.schedulers, setup.defaults.scheduler),
      caps: comfy.caps,
      tiers: RESOLUTION_TIERS,
      // Width and height per aspect and tier, worked out here so the client
      // holds no second copy of the rounding rule. Null for N/A: the
      // workflow's own size.
      sizes: Object.fromEntries(
        (model.aspect_ratios ?? []).map((a) => [
          a,
          {
            native: nativeSizeFor(a, setup.defaults.width, setup.defaults.height),
            ...Object.fromEntries(RESOLUTION_TIERS.map((t) => [t, sizeFor(a, t)])),
          },
        ])
      ),
      running,
    });
  }

  // Our starter workflow for a model, as a template to build your own on
  // (owner's ask, 5 Oct 2026: start from something that works, and do not
  // make it elaborate). The ComfyUI-layout copy when the model ships one,
  // else the API file — ComfyUI opens either.
  if (req.method === 'GET' && pathname === '/api/render/starter') {
    const model = registry.get(url.searchParams.get('model'));
    const r = model?.render;
    if (!r?.workflow) return sendJSON(res, 404, { error: 'not_found', message: 'That model has no render workflow.' });
    let text = null;
    for (const rel of [r.ui_workflow, r.workflow].filter(Boolean)) {
      try {
        text = readFileSync(path.resolve(ROOT, rel), 'utf8');
        break;
      } catch {
        /* try the next */
      }
    }
    if (!text) return sendJSON(res, 404, { error: 'not_found', message: `The ${model.label} workflow could not be read.` });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="promptforge-${model.key}.json"`,
      'cache-control': 'no-store',
    });
    return res.end(text);
  }

  // Pin: onto the pinboard with its prompt, where it is kept like any pin.
  const pin = /^\/api\/render\/(r_[a-f0-9]{24})\/pin$/.exec(pathname);
  if (req.method === 'POST' && pin) {
    const rec = comfy.readRender(pin[1]);
    if (!rec || rec.user !== who) return sendJSON(res, 404, { error: 'not_found', message: 'That render is gone (they are kept for a day).' });
    const body = await readBody(req, 64 * 1024).catch(() => ({}));
    const stamp = new Date(rec.created_at).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    try {
      const entry = sharedImages.save({
        username: who,
        name: body.name || `${rec.model}-render-${stamp}`,
        bytes: readFileSync(rec.file),
        contentType: 'image/png',
        text: rec.positive,
        brief: String(body.brief ?? ''),
        model: rec.model,
      });
      return sendJSON(res, 201, entry);
    } catch (err) {
      return sendJSON(res, err.statusCode ?? 400, { error: 'pin_failed', message: err.message });
    }
  }

  // Your own workflows (stage 3). Private: every route here reads and writes
  // only the caller's own folder.
  const renderable = () => registry.all().filter((m) => m.render?.workflow).map((m) => m.key);
  if (req.method === 'POST' && pathname === '/api/render/workflows') {
    try {
      const body = await readBody(req, 8 * 1024 * 1024);
      const entry = userRender.addWorkflow(
        who,
        // The owner's own uploads run straight away; everyone else's wait.
        { name: body.name, models: body.models, api: body.api, ui: body.ui, approved: isOwner(req) },
        { modelKeys: renderable() }
      );
      if (!entry.approved) console.log(`[render] ${who} uploaded workflow "${entry.name}", waiting for approval`);
      return sendJSON(res, 201, entry);
    } catch (err) {
      return sendJSON(res, err.statusCode ?? 400, { error: 'bad_workflow', message: err.message });
    }
  }
  const delWorkflow = /^\/api\/render\/workflows\/(w_[a-f0-9]{16})$/.exec(pathname);
  if (req.method === 'DELETE' && delWorkflow) {
    try {
      userRender.removeWorkflow(who, delWorkflow[1]);
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      return sendJSON(res, err.statusCode ?? 400, { error: 'not_found', message: err.message });
    }
  }
  // Your own presets: steps, CFG, sampler, scheduler and file, by name.
  if (pathname === '/api/render/presets' && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      const body = await readBody(req, 16 * 1024);
      if (req.method === 'DELETE') {
        userRender.removePreset(who, body.model, body.name);
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 201, userRender.savePreset(who, body, { modelKeys: renderable() }));
    } catch (err) {
      return sendJSON(res, err.statusCode ?? 400, { error: 'bad_preset', message: err.message });
    }
  }

  // Clearing the session history takes this person's renders with it.
  if (req.method === 'DELETE' && pathname === '/api/render') {
    return sendJSON(res, 200, { deleted: comfy.forgetUser(who) });
  }

  if (req.method === 'POST' && pathname === '/api/render') {
    let body;
    try {
      body = await readBody(req, 256 * 1024);
    } catch (err) {
      return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
    }
    const model = registry.get(body.model);
    if (!model) return sendJSON(res, 400, { error: 'unknown_model', message: 'Unknown model.' });
    const setup = renderSetup(model, { user: who, workflowId: body.workflow || null });
    if (setup.error) return sendJSON(res, 400, { error: 'no_workflow', message: setup.error });
    // A workflow is a program ComfyUI runs; one somebody else uploaded runs
    // only once the owner has looked at it (agreed 3 Oct 2026).
    if (setup.ownWorkflow && !setup.ownWorkflow.approved) {
      return sendJSON(res, 403, { error: 'awaiting_approval', message: 'That workflow is waiting for the owner to approve it.' });
    }
    const prompt = String(body.positive ?? '').trim();
    if (!prompt) return sendJSON(res, 400, { error: 'empty_prompt', message: 'Generate a prompt first.' });
    const checked = validateSettings(body.settings, {
      caps: comfy.caps,
      samplers: comfy.lists.samplers,
      schedulers: comfy.lists.schedulers,
      modelFiles: setup.modelFiles,
      textEncoders: setup.textEncoders,
      vaes: setup.vaes,
      loras: setup.loras.map((l) => l.file),
    });
    if (!checked.ok) return sendJSON(res, 400, { error: 'bad_settings', message: checked.message });
    // The text, assembled here so every caller gets the same rule: the model
    // file's prefix, then the triggers of the LoRAs switched on, then the
    // prompt. Negative: the one the model wrote, else the file's own, else the
    // model's basic one (a file's negative replaces the basic, agreed 3 Oct).
    const filePreset = setup.filePresets[checked.settings.model_file ?? setup.defaults.model_file] ?? {};
    const positive = composePositive({
      prompt,
      prefix: filePreset.prefix,
      triggers: checked.settings.loras.flatMap((l) => setup.loras.find((x) => x.file === l.file)?.triggers ?? []),
      tagModel: Boolean(model.tag_style),
    });
    // The Render panel sends the negative as the person left it in its box
    // (4 Oct 2026, owner: auto-filled with a good one, then theirs to change),
    // and that is used exactly, empty included. Without one — chat — the same
    // rule that fills the box applies here.
    const negative = !model.has_negative
      ? ''
      : typeof body.negative === 'string'
        ? body.negative.trim().slice(0, 4000)
        : String(body.negative_segment ?? '').trim() || filePreset.negative || setup.defaults.negative;

    const sse = openSSE(req, res);
    const abort = new AbortController();
    // res, not req: see handleGenerate. A closed tab cancels the render.
    res.on('close', () => abort.abort());
    const ticket = inferenceQueue.enqueue({ user: who, model: model.key, kind: 'render' });
    ticket.onPosition((position) => {
      if (position > 0) sse.send('queued', { position });
    });

    let unloaded = false;
    try {
      await ticket.started;
      if (sse.closed) return;

      if (!(await comfy.up())) {
        sse.send('status', { state: 'starting' });
        await comfy.start();
        await comfy.refreshLists();
      }
      // Measured 3 Oct: the default LLM and an image model share the card.
      // Unload only when this render would not fit beside what is there.
      if ((await comfy.roomFor(setup.vramGb)) === false) {
        sse.send('status', { state: 'freeing_llm' });
        const out = await llm.unloadAll();
        unloaded = out.unloaded?.length > 0;
        if (unloaded) console.log(`[render] unloaded ${out.unloaded.join(', ')} to make room`);
      }

      const filled = fillWorkflow(setup.wf, setup.ui, setup.map, { positive, negative, settings: checked.settings });
      console.log(`[render] ${who}: ${model.key} ${checked.settings.width}x${checked.settings.height} ${checked.settings.steps} steps`);
      const rec = await comfy.run(
        { api: filled.api, ui: filled.ui, user: who, model: model.key, settings: checked.settings, positive, negative },
        { onEvent: (name, data) => sse.send(name, data), signal: abort.signal }
      );
      sse.send('done', {
        id: rec.id,
        url: `/api/render/${rec.id}.png`,
        model: rec.model,
        settings: rec.settings,
        positive,
        negative,
        ms: rec.ms,
        llm_unloaded: unloaded,
      });
    } catch (err) {
      if (!err.code) console.error('[render] failed:', err);
      sse.send('error', { code: err.code ?? 'render_failed', message: err.message });
    } finally {
      // The LLM was unloaded for this render, so the next prompt generation
      // has to load it again: ComfyUI lets go of the card first.
      if (unloaded) await comfy.free();
      ticket.release();
      sse.end();
    }
    return;
  }

  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

// ───────────────────────────── picture edits ─────────────────────────────
//
// The Edit tab and chat's edit_picture tool (4 Oct 2026): a picture and an
// instruction in, Qwen Image 2.1's edit out. Same "render" permission as the
// Render button, the owner's call. See server/imageedit.mjs.

// `let`: switching rendering on from the setup wizard turns editing on too
// (handleAdminComfySetup), since an edit is a render.
let edit = editSettings(config);

/**
 * The pictures an edit was sent, as [{ type, data }] with base64 data, the
 * first being the one edited. Returns { pictures: [{ type, bytes }] } or
 * { error } in words the person can read.
 */
function editPictures(parts) {
  if (!Array.isArray(parts) || !parts.length) return { error: 'Add the picture to edit first.' };
  if (parts.length > edit.maxPictures) return { error: `Up to ${edit.maxPictures} pictures per edit.` };
  const maxMb = taggers.info().limits.max_image_mb ?? 20;
  const pictures = [];
  for (const p of parts) {
    const type = String(p?.type ?? '').toLowerCase();
    // What ComfyUI's LoadImage reads. The page converts anything else.
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
      return { error: `${type || 'That file'} is not a picture this can edit. PNG, JPEG or WebP.` };
    }
    const bytes = Buffer.from(String(p?.data ?? ''), 'base64');
    if (!bytes.length || bytes.length > maxMb * 1024 * 1024) return { error: `Each picture must be under ${maxMb} MB.` };
    pictures.push({ type, bytes });
  }
  return { pictures };
}

/**
 * The instruction as Qwen will read it, written by an LLM that can see the
 * pictures, under prompts/edit/qwen-image-2.1.md. Throws with a code.
 */
async function writeEditPrompt({ instruction, pictures, marked, llmModel, signal }) {
  const system = editSystemPrompt(ROOT, config, edit);
  if (!system) {
    throw Object.assign(new Error(`The edit prompt file (${edit.systemPrompt}) is missing on the server.`), { code: 'prompt_unavailable' });
  }
  const model = llmModel ?? llm.model;
  if ((await visionTags.canSee(model)) === false) {
    throw Object.assign(new Error(`${model} cannot see pictures, so it cannot write the edit. Pick a model marked vision, or send your words as they are.`), { code: 'no_vision' });
  }
  const images = [];
  for (const p of pictures) {
    const readable = await visionBytes(p.bytes, p.type);
    images.push(`data:${readable === p.bytes ? p.type : 'image/png'};base64,${readable.toString('base64')}`);
  }
  const out = [];
  for await (const ev of llm.stream({
    system,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: editUserText({ instruction, count: pictures.length, marked }) },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    }],
    model: llmModel ?? undefined,
    // Low: this is a rewrite of what the person said, not a creative brief.
    temperature: 0.4,
    thinking: false,
    signal,
    mock: { model: { key: 'edit', label: edit.label, segments: [EDIT_SEGMENT] }, brief: instruction },
  })) {
    if (ev.type === 'token') out.push(ev.text);
  }
  let parsed;
  try {
    parsed = parseSegments(out.join(''), [EDIT_SEGMENT]);
  } catch (err) {
    if (!(err instanceof SegmentParseError)) throw err;
    throw Object.assign(new Error(`The writer did not answer in the edit format. ${err.message} Try again, or send your words as they are.`), { code: 'unparseable' });
  }
  if (parsed.refused) throw Object.assign(new Error('The writer declined this edit.'), { code: 'refused' });
  const prompt = cleanEditPrompt(parsed.segments[0]?.body);
  if (!prompt || /^N\/A$/i.test(prompt)) throw Object.assign(new Error('The writer returned an empty instruction. Try again.'), { code: 'unparseable' });
  return prompt;
}

/**
 * One edit, start to finish: the writer, unless the person's words go as
 * they are, then ComfyUI. One queue ticket covers both, so nothing else takes
 * the card between them.
 *
 * `onEvent(name, data)` gets queued, status { state }, prompt { text }, and
 * the render's own node, progress and preview. Resolves { record, prompt,
 * llm_unloaded }; throws an Error carrying `code`.
 */
/** The Speed presets this server can run now: one whose LoRA is not installed is left out. */
function editPresetsNow() {
  return editPresets(edit, comfy.installed('loras'));
}

/**
 * The edit workflow, the files it names, and the files the pickers may
 * offer. Read per request, like render setups: dropping a new file into
 * ComfyUI's folder shows up without a restart.
 */
function editSetup() {
  const wf = JSON.parse(readFileSync(path.resolve(ROOT, edit.workflow), 'utf8'));
  const defaults = editWorkflowFiles(wf);
  const choices = editFileChoices(edit, defaults, {
    model: comfy.installed('diffusion_models'),
    text_encoder: comfy.installed('text_encoders'),
    vae: comfy.installed('vae'),
  });
  return { wf, defaults, choices };
}

/** Each picker's files with their sizes in GB, for the dropdowns: { model: [{ file, gb }], ... }. */
const EDIT_FOLDERS = { model: 'diffusion_models', text_encoder: 'text_encoders', vae: 'vae' };
function editFileSizes(choices) {
  return Object.fromEntries(
    Object.entries(choices).map(([slot, files]) => [slot, files.map((file) => ({ file, gb: comfy.sizeOf(EDIT_FOLDERS[slot], file) }))])
  );
}

/** The files an edit asked for, each checked against what is on offer. Returns { files } or { error }. */
function editFilesFrom(raw) {
  const { choices } = editSetup();
  const files = {};
  for (const slot of ['model', 'text_encoder', 'vae']) {
    const v = raw?.[slot];
    if (v == null || v === '') continue;
    if (!choices[slot].includes(String(v))) return { error: `${v} is not one of the installed ${slot.replace('_', ' ')} files for editing.` };
    files[slot] = String(v);
  }
  return { files };
}

async function runEdit({ user, instruction, pictures, marked = false, llmModel = null, asWritten = false, seed = null, preset = null, files = {} }, { onEvent = () => {}, signal } = {}) {
  // No preset named (chat, or an old page): the first that can run.
  preset ??= editPresetsNow()[0];
  const ticket = inferenceQueue.enqueue({ user, model: 'edit', kind: 'edit' });
  ticket.onPosition((position) => {
    if (position > 0) onEvent('queued', { position });
  });
  const uploaded = [];
  let unloaded = false;
  try {
    await ticket.started;
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'cancelled' });
    let prompt = cleanEditPrompt(instruction);
    if (!asWritten) {
      // The queue frees ComfyUI before an LLM loads only when no LLM is
      // resident; a switch from one resident LLM to another is a load too.
      // Measured 4 Oct 2026: after an edit with the 4B, Gemma 31B could not
      // start beside the editor ComfyUI was still holding (HTTP 500).
      const want = llmModel ?? llm.model;
      {
        const resident = (await llm.resident().catch(() => null)) ?? [];
        if (!resident.some((r) => r.model === want)) await freeComfyUIsForLoad('edit');
      }
      onEvent('status', { state: 'writing' });
      prompt = await writeEditPrompt({ instruction, pictures, marked, llmModel, signal });
    }
    onEvent('prompt', { text: prompt });
    if (!(await comfy.up())) {
      onEvent('status', { state: 'starting' });
      await comfy.start();
      await comfy.refreshLists();
    }
    if ((await comfy.roomFor(edit.vramGb)) === false) {
      onEvent('status', { state: 'freeing_llm' });
      const out = await llm.unloadAll();
      unloaded = out.unloaded?.length > 0;
      if (unloaded) console.log(`[edit] unloaded ${out.unloaded.join(', ')} to make room`);
    }
    for (const p of pictures) uploaded.push(await comfy.upload(p.bytes, p.type));
    const { wf, defaults } = editSetup();
    const settings = {
      preset: preset.name,
      steps: preset.steps,
      lora: preset.lora,
      resolution: edit.resolution,
      seed: Number.isInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2 ** 32),
      pictures: pictures.length,
      ...defaults,
      ...files,
    };
    const api = fillEditWorkflow(wf, {
      prompt,
      images: uploaded,
      seed: settings.seed,
      steps: settings.steps,
      resolution: settings.resolution,
      lora: settings.lora,
      files: { model: settings.model, text_encoder: settings.text_encoder, vae: settings.vae },
    });
    console.log(`[edit] ${user}: ${pictures.length} picture(s), ${settings.preset}`);
    const record = await comfy.run(
      { api, ui: null, user, model: 'edit', settings, positive: prompt, negative: '' },
      { onEvent, signal }
    );
    return { record, prompt, llm_unloaded: unloaded };
  } finally {
    // The person's photos leave ComfyUI's input folder as soon as it is done.
    for (const name of uploaded) comfy.removeInput(name);
    if (unloaded) await comfy.free();
    ticket.release();
  }
}

/**
 * /api/edit — the Edit tab.
 *
 *   GET  /api/edit/options   what the tab is built from
 *   POST /api/edit           SSE: { instruction, pictures: [{ type, data }],
 *                            marked?, llm_model?, as_written?, seed? }
 *
 * The picture comes back as a render: /api/render/<id>.png, kept
 * keep_hours, pinnable like any render.
 */
async function handleEdit(req, res, pathname) {
  if (!edit) return sendJSON(res, 404, { error: 'edit_disabled', message: 'Editing is not set up on this server.' });
  if (!mayRender(req)) {
    return sendJSON(res, 403, { error: 'forbidden', message: 'Editing needs the "render" permission, which the owner grants per account.' });
  }
  const who = whoIs(req);

  if (req.method === 'GET' && pathname === '/api/edit/options') {
    let setup;
    try {
      setup = editSetup();
    } catch (err) {
      return sendJSON(res, 200, { available: false, message: `The edit workflow could not be read: ${err.message}` });
    }
    return sendJSON(res, 200, {
      available: true,
      label: edit.label,
      max_pictures: edit.maxPictures,
      steps: edit.steps,
      resolution: edit.resolution,
      keep_hours: Number(config.comfyui?.keep_hours) || 24,
      default_llm: llm.model,
      // The Speed choices that can run here, the default first.
      presets: editPresetsNow().map(({ name, steps, lora }) => ({ name, steps, lora: Boolean(lora) })),
      // The pickers: installed files only, the workflow's own first, each
      // with its size so the lighter choice is plain.
      files: editFileSizes(setup.choices),
      defaults: setup.defaults,
      about: edit.about,
      vram_gb: edit.vramGb,
    });
  }

  // The editor's workflow as a file, to open in ComfyUI (it reads this API
  // format directly) and use there. The shipped file, untouched.
  if (req.method === 'GET' && pathname === '/api/edit/workflow') {
    let text;
    try {
      text = readFileSync(path.resolve(ROOT, edit.workflow), 'utf8');
    } catch (err) {
      return sendJSON(res, 404, { error: 'not_found', message: `The edit workflow could not be read: ${err.message}` });
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="promptforge-qwen-image-edit.json"',
      'cache-control': 'no-store',
    });
    return res.end(text);
  }

  if (req.method === 'POST' && pathname === '/api/edit') {
    let body;
    try {
      body = await readBody(req, (edit.maxPictures * 30 + 1) * 1024 * 1024);
    } catch (err) {
      return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
    }
    const instruction = String(body.instruction ?? '').trim();
    if (!instruction) return sendJSON(res, 400, { error: 'empty_instruction', message: 'Say what to change first.' });
    const got = editPictures(body.pictures);
    if (got.error) return sendJSON(res, 400, { error: 'bad_pictures', message: got.error });
    const picked = await resolveChatModel(body.llm_model);
    if (picked.error) return sendJSON(res, 400, picked.error);
    const presets = editPresetsNow();
    const preset = body.preset == null ? presets[0] : presets.find((p) => p.name === body.preset);
    if (!preset) return sendJSON(res, 400, { error: 'bad_preset', message: `"${body.preset}" is not a speed this server can run.` });
    const chosen = editFilesFrom(body.files);
    if (chosen.error) return sendJSON(res, 400, { error: 'bad_files', message: chosen.error });

    const sse = openSSE(req, res);
    const abort = new AbortController();
    // res, not req: see handleGenerate.
    res.on('close', () => abort.abort());
    try {
      const out = await runEdit(
        {
          user: who,
          instruction,
          pictures: got.pictures,
          marked: body.marked === true,
          llmModel: picked.model,
          asWritten: body.as_written === true,
          seed: Number.isInteger(body.seed) ? body.seed : null,
          preset,
          files: chosen.files,
        },
        { onEvent: (name, data) => sse.send(name, data), signal: abort.signal }
      );
      sse.send('done', {
        id: out.record.id,
        url: `/api/render/${out.record.id}.png`,
        prompt: out.prompt,
        settings: out.record.settings,
        ms: out.record.ms,
        llm_unloaded: out.llm_unloaded,
      });
    } catch (err) {
      if (!err.code) console.error('[edit] failed:', err);
      sse.send('error', { code: err.code ?? 'edit_failed', message: err.message });
    } finally {
      sse.end();
    }
    return;
  }

  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readBody(req, GENERATE_BODY_LIMIT);
  } catch (err) {
    return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
  }

  const model = registry.get(body.model);
  if (!model) {
    return sendJSON(res, 400, {
      error: 'unknown_model',
      message: `Unknown model "${body.model}". Known: ${registry.keys().join(', ')}`,
    });
  }
  body.brief = foldShotBriefs(body.brief, body.controls ?? {});
  if (!body.brief) {
    return sendJSON(res, 400, { error: 'empty_brief', message: 'A brief is required.' });
  }

  // h3's "Auto detect" is settled here, not by the model.
  //
  // It is the default mode, and it was the only entry in
  // `reference_files_by_mode` that had to carry BOTH official guides — so the
  // gating that landed 3 Sep saved nothing on the path almost every
  // generation takes. The rule SKILL.md states is entirely mechanical and
  // reads only the request, so server/references.mjs computes it and the run
  // proceeds as though the person had picked the mode themselves: one guide,
  // and a Mode line that names a real mode instead of asking for one.
  //
  // Both consumers move together on purpose. `prompts.get` picks which guide
  // loads and buildUserMessage writes the `Mode:` setting, and a prompt
  // carrying the T2VA guide under a heading that says "Auto detect" is worse
  // than either half alone.
  // Picture labels become the roles and groups everything below
  // already reads, before Auto detect looks at them (First/Last frame decide
  // the mode). Normal mode passes through unchanged.
  if (body.controls) body.controls = applyPictureLabels(body.controls);
  if (body.controls?.mode) {
    const resolved = resolveAutoControls(body.controls);
    if (resolved.mode !== body.controls.mode) {
      console.log(`[mode] ${model.key}: Auto detect resolved to ${resolved.mode}`);
      body.controls = resolved;
    }
  }

  // The system prompt, or the one this person wrote instead of it.
  //
  // A self-written block REPLACES the shipped file — owner's call, 28 Aug
  // 2026 — so this is not a merge. house-rules.md still goes in front of it,
  // because that is the output contract the parser is built on; everything
  // else about the model's dialect is now whatever they wrote.
  //
  // Every step degrades to the shipped prompt: no preference, an id that no
  // longer resolves, a block deleted by its author, or the feature never
  // touched all mean the same thing as before this existed. The active block
  // is named in the log line, because when output stops parsing the first
  // question is which instructions produced it.
  //
  // Since 26 Sep 2026 a model can have a group default block. No preference
  // means that default; the preference "base" means the shipped prompt on
  // purpose; a block since archived falls back to the default like a deleted
  // one does.
  const activeBlockId = storage.getPrefs(whoIs(req)).system_prompts?.[model.key];
  let activeBlock = activeBlockId && activeBlockId !== 'base' ? storage.getSystemPrompt(activeBlockId) : null;
  if (activeBlock?.archived) activeBlock = null;
  if (!activeBlock && activeBlockId !== 'base') activeBlock = storage.defaultSystemPrompt(model.key);
  // The mode reaches the prompt store because h3's reference guides are gated
  // on it: a T2VA generation has no use for the Full-reference guide and paid
  // ~5,500 tokens for it on every run until 3 Sep 2026. A user's own system
  // prompt block replaces the model's file and its references wholesale, so
  // that path takes no mode — same as it takes no reference files.
  // What this account actually wants written, resolved before the prompt is
  // composed because the prompt now depends on it.
  //
  // **From expectedSegments, not from model.segments.** For every model but
  // one those are the same list. LTX Director is the exception: its contract
  // is per-request — `Global prompt`, one `Segment N` per timeline block, then
  // the meta segments — and reading the registry here is what broke Director
  // mode from 23 Aug 2026 until 9 Sep. The parser has always read the expanded
  // list; the system prompt was built from the static one, so the model was
  // told to emit `Enhanced paragraph`, did exactly that, and every run died on
  // `unknown_segment` naming a contract nothing had ever shown it. One list per
  // request, and both halves read it.
  // Labelled REF2VA has its own contract and prompt block, looked up under
  // promptMode(); every other check still reads the real mode, REF2VA.
  const contractControls = { ...(body.controls ?? {}), mode: promptMode(body.controls ?? {}) };
  const expected = expectedSegments(model, contractControls);
  const omitted = omitFor(model, storage.getPrefs(whoIs(req)), registry.defaults);
  const wanted = expected.filter((l) => !omitted.includes(l));

  // The segment half is APPENDED rather than composed in, which is the whole
  // reason this is affordable: the base prompt stays byte-identical for every
  // person, so the prefix cache still covers it and only this tail differs.
  //
  // A user's own block is left alone. It replaces the model's file and its
  // references wholesale — it declares its own segments in its own words, and
  // bolting a generated contract onto the end of somebody's hand-written
  // prompt would be the same override this change exists to remove.
  const system = activeBlock
    ? prompts.compose(activeBlock.body)
    : [prompts.get(model.key, contractControls.mode), prompts.segmentTail(model, wanted)]
        .filter(Boolean)
        .join(String.fromCharCode(10, 10) + '---' + String.fromCharCode(10, 10));
  if (activeBlock) {
    console.log(
      `[prompts] ${model.key}: using "${activeBlock.title}" by ${activeBlock.author} ` +
        `instead of the shipped prompt`
    );
  }
  if (!system) {
    return sendJSON(res, 500, {
      error: 'prompt_unavailable',
      message: `System prompt for ${model.key} is not loaded.`,
    });
  }

  // Before the SSE stream opens, so a bad length is a plain 400 naming the
  // limit rather than an error event inside a stream the client has already
  // started rendering into.
  let maxLength;
  try {
    maxLength = lengthFor(body.controls);
  } catch (err) {
    if (!(err instanceof ControlError)) throw err;
    return sendJSON(res, 400, { error: 'bad_control', message: err.message });
  }

  // Director mode with nothing on the timeline. directorBlocks answers [] for
  // exactly this, the case its own comment calls a user error, and nothing
  // refused it: the model was told to write "all 0 segments", wrote a Segment 1
  // anyway, and the run died on unknown_segment every time (11 Oct 2026).
  if (directorBlocks(model, body.controls)?.length === 0) {
    return sendJSON(res, 400, {
      error: 'bad_control',
      message: 'Director mode needs at least one segment on the timeline. Add one, or switch to Paragraph.',
    });
  }
  const goneWriter = await writerNotInstalled(model, req);
  if (goneWriter) return sendJSON(res, 400, goneWriter);

  const sse = openSSE(req, res);
  const abort = new AbortController();
  // **res, not req.** Measured 5 Sep 2026 on the P40: when the client goes
  // away mid-generation, `res` emits 'close' and `req` does not — the request
  // stream has already ended, because its body was read in full before the
  // handler ever started. So this listener never fired, abort() was never
  // called, the upstream generation ran to completion on the GPU, and the
  // handler never reached the finally that releases the queue ticket.
  //
  // Reported as cancelling doing nothing: the person pressed Stop, then queued
  // behind their own abandoned job and waited out the rest of it.
  //
  // Firing on a NORMAL finish too is harmless — abort() after the work is done
  // is a no-op, and the ticket has already been released by then.
  res.on('close', () => abort.abort());

  // Who and what, so the active users panel can say "Friendo is generating an
  // h3 prompt" rather than "1 running". Descriptive only.
  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model: model.key });
  ticket.onPosition((position) => {
    if (position > 0) sse.send('queued', { position });
  });

  const id = `gen_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const collected = [];
  let usage = null;

  try {
    await ticket.started;
    if (sse.closed) return;

    // Canonical appearance for whoever the brief names, before generation
    // starts. Awaited rather than raced: the whole point is that the model
    // does not answer from memory, and a lookup that lands after the first
    // token has already lost. A cache hit is a sqlite read; a miss is one
    // danbooru request and then cached for 30 days.
    //
    // Announced first, because this sits between "queued" and the first token
    // and the progress bar would otherwise hold the previous phase with
    // nothing explaining the pause — a second on a cache hit, and up to the
    // 15s traits timeout on a cold miss.
    sse.send('status', { state: 'character_lookup' });
    const characterText = await characterCanon(model, body.brief, body.controls);

    // Free next to a generation — a map read against an index built once — so
    // it is not announced as a phase the way the character lookup is.
    const candidateText = [
      config.candidates?.enabled === true && model.tag_style
        ? candidates.block(body.brief, { variant: model.tag_style })
        : '',
      lexiconFor(model) ? lexicon.block(body.brief, { variant: model.tag_style }) : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    sse.send('status', { state: 'generating', model: model.key });

    // What the person switched off. Filtered against optionalSegments, so a
    // request to drop the Positive prompt is ignored rather than obeyed.
    // Discarded labels stay ALLOWED — the model's own prompt file lists them
    // under "Segments to emit" and it will often write one anyway, and failing
    // a run because the model was too obedient would be worse than no switch.
    // `expected` and `omitted` are the ones the system prompt was composed
    // from, deliberately reused rather than recomputed. Deriving the same two
    // lists twice from the same inputs is how they came to disagree in the
    // first place — see the note above `const expected`.
    const plan = segmentPlan(model, omitted, expected);
    if (plan.discard.length) {
      console.log(`[segments] ${model.key}: not asking for ${plan.discard.join(', ')}`);
    }
    // Segments this mode has no field for — h3's three REF2VA-only sections in
    // a base mode. Never asked for, so never required; tolerated and dropped if
    // the model writes one anyway, exactly like a switched-off segment.
    const outsideMode = segmentsOutsideMode(model, contractControls);
    // The real list goes to the browser before the first token, so the
    // progress bar counts against what this request returns rather than
    // against every segment the model could ever have.
    // `labels`, not `segments`: several readers treat any payload carrying a
    // `segments` array as the finished segment objects, and this is a list of
    // names.
    sse.send('contract', { labels: plan.required });
    const stream = new SegmentStream(plan.required, {
      discard: [...new Set([...plan.discard, ...outsideMode])],
      onSegment: (seg) => sse.send('segment', seg),
      // Lets a missing-segment error distinguish content the model never wrote
      // from content it wrote into the wrong segment. Explanation only —
      // nothing is recovered from it.
      fields: model.segment_fields ?? {},
    });

    const { temperature, top_p } = samplingFor(model, body.controls);

    // Registry override first, then the person's own choice, then the
    // configured default — see chooseModel. The registry wins because a
    // target that declares its own LLM does so on measured grounds.
    const llmModel = chooseModel(model, storage.getPrefs(whoIs(req)));
    // Counted here rather than on the done event: this is the point the model
    // is committed to, and a generation that failed or was cancelled still
    // spun the weights up and still says somebody reaches for this model.
    // `?? llm.model` because chooseModel answers undefined for "let the
    // backend decide", and a row named undefined would tell nobody anything.
    usageStats.record(llmModel ?? llm.model);
    metrics.incGenerations(llmModel ?? llm.model);
    // Wall time of this generation for the monitoring dashboard's latency
    // panel, which read a number nothing ever recorded until 22 Sep 2026.
    const generationStarted = Date.now();

    // Null on every model that cannot or should not have them, which is the
    // arm of the comparison that runs on the prompt file alone. See toolsFor.
    const tools = await toolsFor(model, llmModel);

    // How to use the search, present only on the requests that actually got
    // it. Appended rather than composed into the cached prompt because whether
    // a generation has tools is decided per request — it turns on the person's
    // chosen LLM, and telling a model with no tool support to go and search
    // would be an instruction it cannot follow.
    //
    // Last, after the model's own file, which is the same rule the rest of
    // composition follows: the more specific instruction gets the final word.
    // Only the guides for tools actually offered. A model shown how to open
    // a document it was never given the tool for is being taught a dead end,
    // which is the same mistake as describing a tag search to a model that
    // cannot call one.
    const offeredNames = new Set((tools ?? []).map((t) => t.function?.name));
    const toolGuide = [
      offeredNames.has('search_tags') ? prompts.tagSearch() : null,
      offeredNames.has('read_guidance') ? prompts.guidance() : null,
    ]
      .filter(Boolean)
      .join('\n\n---\n\n') || null;
    const systemForRun = toolGuide ? `${system}

---

${toolGuide}` : system;

    // The conversation, which is one turn long until a tool is called. Tool
    // results ride in it as `tool` messages rather than being spliced into the
    // brief: what the person typed is what gets stored and shown, and a wall
    // of tag rows inside it would be indistinguishable from something they
    // asked for.
    //
    // The reference pictures, if this model can look at them. Resolved before
    // the message is built because it changes the WORDING as well as the
    // payload — see the carriesImage branch in buildUserMessage. Telling a
    // model it cannot see a picture that is attached to the same message is
    // the failure that branch exists to prevent.
    //
    // `canSee` only stops on an explicit false, for the reason written on
    // refineWithVision: null is a backend that did not answer, and a model
    // that genuinely cannot see costs one failed call rather than a feature
    // that silently never runs.
    //
    // Which lane the pictures come off depends on the model. The image models
    // carry roles and fidelities that get grouped and annotated; the video
    // models carry wan's frame pair or the Director's rows, which are a
    // different contract and a different formatter. Same gate, same warnings,
    // same payload shape — see videoReferenceParts for why they are not one
    // list.
    const refImages =
      model.type === 'video'
        ? videoReferenceParts(body.controls ?? {}, registry.defaults ?? {})
        : referenceImageParts(body.controls?.image_references ?? [], registry.defaults ?? {});
    const lookModel = llmModel ?? llm.model;
    const canLook = refImages.parts.length > 0 && (await visionTags.canSee(lookModel)) !== false;
    if (refImages.dropped) {
      sse.send('warning', {
        message: `${refImages.dropped} reference picture${refImages.dropped === 1 ? '' : 's'} could not be sent to the model. Its notes still travel.`,
      });
    }
    // h3 picture labels: the person's labels stand in for looking. No picture is
    // scanned and none goes to the writer — H3 itself sees them in the
    // Director, so the prompt only has to say who is in which picture. That
    // keeps a small writer's context to the guide and the brief, and lets a
    // model with no vision write it. See server/picture-labels.mjs.
    const labelledRun = usesLabels(body.controls) && body.controls?.mode === 'REF2VA';
    if (refImages.parts.length && !canLook && !labelledRun) {
      // Said out loud rather than degrading quietly. The person attached a
      // picture expecting it to be looked at, and a prompt written from the
      // notes alone is a different and worse thing that looks identical.
      sse.send('warning', {
        message: `${lookModel} cannot see images, so it is working from your notes${model.type === 'video' ? '' : ' and picked tags'} only.`,
      });
    }

    // ── Look first, write second ──────────────────────────────────────────
    //
    // A user's workflow, generalised to every image model on 8 Sep 2026. One
    // call reads the pictures under their roles and writes a factual
    // blueprint; the pictures then come OFF the wire and this generation is
    // compiled from that text.
    //
    // Image models only. The video models have their own reference machinery
    // — the Director's label classes, server/references.mjs — which is a
    // contract with the DaSiWa node, not a thing to quietly re-route.
    //
    // Announced before it starts, because it is a whole extra generation on a
    // box that decodes at 9-18 tok/s and an unexplained minute of silence
    // before the first token reads as a hang.
    let blueprint = '';
    if (canLook && model.type === 'image' && prompts.referenceBlueprint()) {
      sse.send('status', { state: 'reading_references' });
      const read = await runReferenceBlueprint({
        model,
        llmModel,
        refImages,
        brief: body.brief,
        signal: abort.signal,
      });
      blueprint = read.text;
      if (!blueprint && read.reason !== 'mock backend') {
        // Not an error: the pictures go up with the compile call instead,
        // which is the path this app used before the pass existed. Said out
        // loud anyway — the two paths produce different prompts, and which
        // one ran is not otherwise visible from the output.
        sse.send('warning', {
          message: `The reference read did not happen (${read.reason}), so the pictures are going straight to the prompt writer instead.`,
        });
      }
    }
    // ── h3 REF2VA: each picture read on its own ──────────────────────────
    //
    // See server/picture-readings.mjs. Only with two or more pictures: one
    // picture has nothing to be confused with. In "text" mode the pictures
    // then stay off the writer call; in "both" they go too, labelled.
    let pictureUnits = [];
    let pictureReadings = new Map();
    if (canLook && !labelledRun && model.type === 'video' && body.controls?.mode === 'REF2VA' && prompts.referencePicture()) {
      const units = readingUnits(body.controls.references ?? [], 'REF2VA');
      if (units.reduce((n, u) => n + u.refs.length, 0) >= 2) {
        pictureUnits = units;
        pictureReadings = await readPictures({
          model,
          llmModel,
          units,
          system: prompts.referencePicture(),
          signal: abort.signal,
          sse,
        });
        if (pictureReadings.size) {
          // What the prompt was written from, to the person (show-me-the-output).
          sse.send('picture_readings', {
            readings: [...pictureReadings].map(([labels, text]) => ({ labels, text })),
          });
        }
      }
    }
    const readAll = pictureUnits.length > 0 && pictureReadings.size === pictureUnits.length;
    const textOnly = readAll && (config.prompts?.reference_picture_mode ?? 'text') !== 'both';
    const cast = labelledRun ? labelledCast(body.controls.references ?? []) : null;

    // Picture labels: each subject and frame described in two sentences by a
    // reader that sees only its own pictures, for Retention analysis (the H3
    // Forge's "As the pictures show"). The writer still gets no pictures.
    // Cached by content, so a re-roll does not look again.
    const labelDescriptions = new Map();
    // The Cast list's cards are used as written, whether or not anything here
    // can see: until 14 Oct 2026 they were applied only inside the check
    // below, so a writer that cannot see lost every card.
    const given = givenCast(body.controls);
    if (cast) for (const [tag, entry] of castDescriptions(cast, given)) labelDescriptions.set(tag, entry);
    if (cast && canLook && prompts.pictureDescription()) {
      // The instruction's own hash rides in the role, which is in the cache key:
      // an edited instruction must not be answered from descriptions written
      // under the old one.
      // The message too: a reworded message must not be answered from the
      // cache of the old one (a fix to "describe only the one in front" did
      // nothing until the old reading was gone, 6 Oct 2026).
      // The brief rides in the message, so a changed brief is a fresh read.
      const describe = (u) => describeMessage(u, body.brief);
      const asked = (u) => createHash('sha256').update(prompts.pictureDescription()).update('\0').update(describe(u)).digest('hex').slice(0, 8);
      // Only what has no card is read.
      const units = await withCrops(unitsToRead(describeUnits(cast), cast, given).map((u) => ({ ...u, role: `${u.role}:${asked(u)}` })));
      if (units.length) {
        const read = await readPictures({
          model,
          llmModel,
          units,
          system: prompts.pictureDescription(),
          signal: abort.signal,
          sse,
          message: describe,
          // Two sentences and the Kept line (6 Oct 2026); 160 was the sentences alone.
          maxTokens: 240,
          // A Scan reading is a paragraph about the whole picture, not these two sentences.
          useGiven: false,
          // Two people in one picture share its label; their readings must not.
          keyOf: (u) => u.tag,
        });
        for (const u of units) {
          const text = read.get(u.tag);
          if (text) labelDescriptions.set(u.tag, text);
        }
        if (labelDescriptions.size) {
          sse.send('picture_readings', {
            readings: units.filter((u) => labelDescriptions.has(u.tag)).map((u) => ({ labels: `${u.tag} (${u.labels.join(', ')})`, text: labelDescriptions.get(u.tag) })),
          });
        }
      }
    }

    // The pictures travel only when nothing read them. Sending both would put
    // the model back in the position the split exists to get it out of —
    // reading the image again, against a text reading of the same image, with
    // no way to say which wins. (h3's per-picture readings are the exception
    // in "both" mode, where the readings exist to anchor the labels.)
    const carriesImage = canLook && !blueprint && !textOnly && !labelledRun;

    // ── The Director's keyframes ──────────────────────────────────────────
    //
    // Its own lane, and not the video-reference one above. wan's frame pair
    // and h3's Director rows are pictures attached to the compile call; these
    // are read one at a time and cached, because a timeline holds eight of
    // them and one picture already costs wan 95 seconds of prefill. The
    // argument in full is in the header of server/keyframes.mjs.
    //
    // Gated on the same canSee check as every other picture, asked of the
    // model that will actually be handed them.
    let keyframeReadings = new Map();
    {
      const framed = directorKeyframes(model, body.controls ?? {});
      const keyframeSystem = prompts.directorKeyframe();
      if (framed.length && !keyframeSystem) {
        // Config says the reader is off, but the browser sent pictures
        // anyway — a stale tab, since the upload is hidden when it is off.
        sse.send('warning', {
          message: 'Keyframe reading is switched off on this server, so the pictures on your timeline were not looked at.',
        });
      } else if (framed.length && (await visionTags.canSee(lookModel)) === false) {
        sse.send('warning', {
          message: `${lookModel} cannot see images, so the ${framed.length === 1 ? 'keyframe' : 'keyframes'} on your timeline could not be read. The prompt is coming from your own lines.`,
        });
      } else if (framed.length) {
        keyframeReadings = await readKeyframes({
          model,
          llmModel,
          blocks: framed,
          brief: body.brief,
          system: keyframeSystem,
          signal: abort.signal,
          sse,
        });
        // The readings, to the person, in full — the input half of
        // [[show-me-the-output]], same as the blueprint pass. This is what the
        // prompt was actually written from, and a segment that came out wrong
        // is either a bad reading or a bad compile, which nobody can tell
        // apart without seeing this.
        //
        // Its own event rather than folded into `done`, so it is on screen
        // while the prompt is still streaming.
        if (keyframeReadings.size) {
          sse.send('keyframe_readings', {
            readings: [...keyframeReadings].map(([index, text]) => ({ index, text })),
          });
        }
      }
    }

    const userText = buildUserMessage(
      model,
      cast
        ? labelledBrief(body.brief, cast)
        : usesLabels(body.controls) && ['I2VA', 'FL2VA', 'L2VA'].includes(body.controls?.mode)
          ? framedBrief(body.brief, labelledCast(body.controls.references ?? []))
          : body.brief,
      body.controls,
      characterText,
      storage.getPrefs(whoIs(req)).custom_instruction ?? '',
      candidateText,
      omitFor(model, storage.getPrefs(whoIs(req)), registry.defaults),
      {
        carriesImage,
        referenceAnalysis: blueprint,
        attachedLabels: refImages.labels ?? [],
        keyframeReadings,
        // A frame mode has no Subject definitions: the Cast list's cards reach the writer here.
        pictureLines: [
          ...readingLines(pictureUnits, pictureReadings),
          ...(usesLabels(body.controls) && ['I2VA', 'FL2VA', 'L2VA'].includes(body.controls?.mode)
            ? framedCastLines(labelledCast(body.controls.references ?? []), characterCards(givenCast(body.controls))) : []),
        ],
        labelledLines: cast ? labelledLines(cast, labelDescriptions) : null,
      }
    );
    const convo = [
      {
        role: 'user',
        content: carriesImage ? [{ type: 'text', text: userText }, ...labelledImageParts(refImages)] : userText,
      },
    ];

    // The reading, to the person, in full. It is the input half of
    // [[show-me-the-output]]: this is what the prompt was actually written
    // from, and a pose that came out wrong is either a bad read or a bad
    // compile, which nobody can tell apart without seeing this.
    //
    // Sent as its own event rather than folded into `done`, so it is on
    // screen while the prompt is still streaming.
    if (blueprint) sse.send('reference_analysis', { text: blueprint });

    // What was actually sent, when someone asks. Off unless
    // PROMPTFORGE_DEBUG_PROMPT is set, and it prints to the server log rather
    // than travelling to the client — this is thousands of words and it is for
    // whoever is tuning the prompt files, not for the person generating.
    //
    // It exists because the owner asked "what was the prompt you gave it" on
    // 30 Aug 2026 and there was no way to answer without reconstructing
    // buildUserMessage by hand, which is exactly the kind of answer that is
    // subtly wrong. See [[show-me-the-output]] — the same rule applies to the
    // input.
    if (process.env.PROMPTFORGE_DEBUG_PROMPT) {
      const rule = '─'.repeat(70);
      console.log(`\n${rule}\nSYSTEM PROMPT (${systemForRun.length} chars)\n${rule}\n${systemForRun}`);
      // content is an array when the pictures ride along, and printing that
      // raw would dump megabytes of base64 into the log. The text is what
      // anyone tuning a prompt file came for; the pictures are counted, not
      // shown.
      const sentText = Array.isArray(convo[0].content)
        ? `${convo[0].content.find((p) => p.type === 'text')?.text ?? ''}\n\n[+ ${
            convo[0].content.filter((p) => p.type === 'image_url').length
          } reference picture(s) attached to this turn]`
        : convo[0].content;
      console.log(`\n${rule}\nUSER TURN\n${rule}\n${sentText}\n${rule}\n`);
    }

    // Bounded, because each round is a whole generation on a 27B and an
    // unbounded loop is a model that searches the tag database until the
    // request times out. Hitting either ceiling is not an error — the tools
    // simply stop being offered and the model writes with what it has.
    const maxRounds = config.tools?.max_rounds ?? 6;
    const maxCalls = config.tools?.max_calls ?? 24;
    const toolLog = [];
    let rounds = 0;
    // What is offered THIS round, which is `tools` until the budget runs out
    // and null after. Separate from `tools` because `tools` still has to say
    // whether this generation was ever a tool run at all — the parser branch
    // and the done event both turn on that, and both must stay true after the
    // last search has been spent.
    let offered = tools;

    // The failure table requires that a still-loading model queues rather
    // than fails. Loading a 27B off disk takes tens of seconds, and treating
    // that as an error puts a red box in front of the user for something
    // that resolves itself. Retry until the model answers or the budget runs
    // out — only ever before the first token, because a mid-stream failure
    // is a real failure and restarting it would duplicate output.
    let waitedMs = 0;
    for (;;) {
      // Accumulated by index, because the OpenAI-compatible path streams a
      // call's name and arguments across several frames while Ollama's native
      // path sends each one whole. Keying on index is correct for both.
      const pending = new Map();
      const roundText = [];
      try {
        for await (const ev of llm.stream({
          system: systemForRun,
          messages: convo,
          ...(offered ? { tools: offered } : {}),
          temperature,
          top_p,
          thinking: body.controls?.thinking ?? model.thinking,
          model: llmModel,
          timeoutMs: model.timeout_ms,
          contextLength: model.context_length,
          maxTokens: tokenBudget(maxLength),
          signal: abort.signal,
          mock: { model, brief: body.brief, refuse: body.__mock_refuse === true },
        })) {
          if (ev.type === 'token') {
            // Streamed live even in a round that turns out to be a tool call,
            // because holding every token back until the round ends would
            // leave a 27B generation blank for a minute. In practice a tool
            // round emits no content at all — the model answers with calls and
            // nothing else — so this is a live stream of the real answer. The
            // buffer below is what decides whether the text is *parsed*.
            //
            // With no tools in play there is no round that could be discarded,
            // so the parser is fed per token exactly as it always was and the
            // segment panels fill in as they arrive. Nine of ten models and
            // every model on a backend without tool support take this branch.
            sse.send('token', { text: ev.text });
            if (tools) {
              roundText.push(ev.text);
            } else {
              collected.push(ev.text);
              stream.push(ev.text);
            }
          } else if (ev.type === 'tool_call') {
            const cur = pending.get(ev.index) ?? { id: null, name: '', arguments: '' };
            pending.set(ev.index, {
              id: ev.id ?? cur.id,
              name: cur.name + (ev.name ?? ''),
              arguments: cur.arguments + (ev.arguments ?? ''),
            });
          } else if (ev.type === 'usage') {
            usage = ev.usage;
          }
        }

        const calls = [...pending.values()].filter((c) => c.name);
        if (offered && calls.length) {
          rounds += 1;
          // The model's own turn has to go back in before its results, or the
          // backend has tool output answering nothing.
          convo.push({
            role: 'assistant',
            content: roundText.join(''),
            tool_calls: calls.map((c) => ({
              ...(c.id ? { id: c.id } : {}),
              type: 'function',
              function: { name: c.name, arguments: toolArgsForBackend(c.arguments) },
            })),
          });
          for (const call of calls) {
            // Routed by name. An unknown name reaches the tag search, which
            // answers rather than throwing — the same degradation everything
            // in this loop relies on.
            const out =
              call.name === 'read_guidance'
                ? guidance.run(model, call.arguments)
                : toolbox.run(call.name, call.arguments, {
                    variant: model.tag_style ?? 'underscore',
                    paraphrases: lexiconFor(model),
                  });
            toolLog.push({ name: call.name, arguments: call.arguments, ok: out.ok });
            // Logged as well as streamed. The SSE `tool` event tells the person
            // watching; this tells anyone reading the journal afterwards, which
            // is the only way to answer "is the model actually opening that
            // document" once the tab is closed. Asked on 4 Sep 2026 about
            // `visual-direction` and unanswerable — a thin modifier run looks
            // identical whether the model read the vocabulary and ignored it or
            // never opened it at all, and those need opposite fixes.
            // The failure reason travels too. "read_guidance (failed)" three
            // times told us a tool was broken and nothing about why, and the
            // cause turned out to be in the first eight words of the content
            // it was already returning.
            console.log(
              `[tools] ${model.key}: ${call.name}` +
                (out.document ? ` → ${out.document}` : '') +
                (out.queries?.length ? ` → ${out.queries.join(', ')}` : '') +
                (out.ok ? '' : ` (failed: ${String(out.content ?? '').slice(0, 120)})`)
            );
            sse.send('tool', {
              name: call.name,
              queries: out.queries ?? [],
              // Which document was opened, so the panel can say "read
              // visual-direction" rather than just "used a tool".
              ...(out.document ? { document: out.document } : {}),
              ok: out.ok,
            });
            convo.push({
              role: 'tool',
              content: out.content,
              tool_name: call.name,
              ...(call.id ? { tool_call_id: call.id } : {}),
            });
          }
          // The budget is checked AFTER the results go back, never before.
          // Refusing to answer a search the model already made leaves it
          // waiting on a tool result that never comes, and what it does then
          // is emit nothing at all — measured 30 Aug 2026, a run that made
          // twelve good searches and returned no segments because the twelfth
          // was silently dropped.
          //
          // Running out means the tools stop being offered and the model is
          // told so in as many words. A model that has lost a capability
          // mid-conversation and is not told keeps trying to use it.
          if (rounds >= maxRounds || toolLog.length >= maxCalls) {
            offered = null;
            convo.push({
              role: 'user',
              content:
                'You have used all the tag searches available for this prompt. ' +
                'Do not call search_tags again. Write the finished prompt now, ' +
                'in the exact segment format your instructions specify, using ' +
                'the tags you have already confirmed.',
            });
          }
          sse.send('status', { state: 'generating', model: model.key });
          continue;
        }

        // Not a tool round: this is the answer. On the tool path it is parsed
        // in one push rather than per token — the segment events land together
        // instead of filling in, which is the cost of never handing the parser
        // a tool round's stray text.
        if (tools) {
          const text = roundText.join('');
          collected.push(text);
          stream.push(text);
        }
        break;
      } catch (err) {
        const retryable =
          err instanceof LLMError &&
          err.code === ERR.MODEL_LOADING &&
          collected.length === 0 &&
          // On the tool path `collected` stays empty until the last round, so
          // it cannot on its own say whether anything was generated. Without
          // this a mid-round failure would look retryable and the retry would
          // duplicate the text already sent.
          roundText.length === 0 &&
          rounds === 0 &&
          !sse.closed &&
          !abort.signal.aborted &&
          waitedMs < MODEL_LOADING_MAX_WAIT_MS;
        if (!retryable) throw err;

        sse.send('status', { state: 'model_loading', waited_ms: waitedMs });
        await sleep(MODEL_LOADING_RETRY_MS, abort.signal);
        waitedMs += MODEL_LOADING_RETRY_MS;
      }
    }

    const result = stream.end();

    // Two mechanical defects, cleaned before the panel ever sees them: a tag
    // repeated in the negative, and a tag the user asked FOR appearing in the
    // negative. Both are rules the prompt files already state — see
    // server/negative.mjs for the real output that prompted this. Nothing
    // about length or tag choice is touched; that is judgement, and judgement
    // lives in prompts/.
    // The aspect ratio, when it leaked out of the controls and into the
    // prompt. Measured: "2:3 Portrait" arriving as a `2:3_portrait` tag. The
    // control line now says these are settings rather than content, which
    // helps and does not suffice - same split as the negative cleanup, where
    // rules the prompt files already state get enforced mechanically.
    // Repeated commas are noise, not emphasis. From circlestone-labs'
    // community guide for Anima (civitai article 30800): "In DiT models, the
    // TE tokenizer turns these constructions into garbage tokens ... You are
    // literally forcing the text encoder to go blind right in the middle of
    // your prompt. Strictly use ONE comma and ONE space."
    //
    // In code rather than in a prompt file, because it is a character
    // substitution with a decidable rule — the same argument server/parens.mjs
    // settled, where teaching it in prose scored 1 of 3. Safe on prose
    // dialects too: nobody wants ",,," in a Krea2 paragraph either.
    for (const seg of result.segments) {
      const tidied = seg.body
        .replace(/[ 	]*,(?:[ 	]*,)+/g, ',')
        // Not before a closing quote or a digit: `"Wait," she says` and
        // `1,000` are already right, and a space there split LTX dialogue
        // into `"You're late, " his voice` (20 Oct 2026).
        .replace(/,(?=[^\s"'”’\d])/g, ', ')
        .replace(/[ 	]{2,}/g, ' ')
        .replace(/\s+,/g, ',');
      if (tidied !== seg.body) seg.body = tidied;
    }

    // The seams between LTX Director's pieces, which only exist because the
    // node joins them and the model cannot see the joined result. Same
    // argument as the comma tidy above: a character-level rule with one
    // decidable answer, against a join whose exact shape is quoted in
    // server/director.mjs. It changes the first and last characters of a
    // fragment and reads none of the prose.
    //
    // After the comma tidy, so a fragment that arrives as ", , crouched" has
    // already been reduced to one comma before this strips it.
    {
      const fixed = fixDirectorSeams(model, body.controls ?? {}, result.segments);
      if (fixed.length) {
        console.log(`[director] ${model.key}: fixed the join punctuation on ${fixed.join(', ')}`);
      }
    }

    // A score only when the brief asked for music. See server/music.mjs.
    if (musicOnlyWhenAsked(model, body.brief, result.segments)) {
      console.log(`[music] ${model.key}: the brief asked for no music, so Music is N/A`);
    }

    // Cuts that cannot play are moved, then the number of shots picked is
    // checked: the model can still miss it. See server/shots.mjs.
    {
      const moved = repairCutTimes(body.controls ?? {}, result.segments);
      if (moved.length) console.log(`[shots] ${model.key}: moved cut ${moved.map(([a, b]) => `${a} -> ${b}`).join(', ')}`);
      const message = shotCountWarning(body.controls ?? {}, result.segments);
      if (message) sse.send('warning', { message });
    }

    // Layout JSON: fixed fields, boxes inside the canvas. See server/layout.mjs.
    {
      const message = tidyLayout(model, body.controls, result.segments);
      if (message) sse.send('warning', { message });
    }

    // "N/A" is not a ratio, so there is nothing that could have leaked and
    // nothing to strip. Running the stripper on it would build match patterns
    // out of the letters N and A, which is exactly the kind of thing
    // server/aspect.mjs warns against — it must never edit what the person
    // wrote.
    if (body.controls?.aspect_ratio && body.controls.aspect_ratio !== 'N/A') {
      for (const seg of result.segments) {
        if (!/^(Positive prompt|Enhanced prompt|Enhanced paragraph)$/.test(seg.label)) continue;
        const { body: cleaned, removed } = stripAspect(seg.body, body.controls.aspect_ratio, {
          // Never touch what the person typed themselves.
          protectedText: [
            body.controls.positive ?? '',
            ...(Array.isArray(body.controls.tags) ? body.controls.tags : []),
            body.brief ?? '',
          ],
        });
        if (removed.length) {
          seg.body = cleaned;
          console.log(`[aspect] removed leaked ratio from ${model.key}: ${removed.join(', ')}`);
        }
      }
    }

    // Spaces, not underscores, on a model whose tag_style says so: the model
    // writes `best_quality` from habit whatever it is told. First, so every
    // later pass reads the tags as they will be shown. See server/tagspacing.mjs.
    if (model.tag_style === 'space') {
      for (const seg of result.segments) {
        if (seg.label !== 'Positive prompt' && seg.label !== 'Negative prompt') continue;
        const { text: spaced, changed } = spaceUnderscores(seg.body, [
          body.controls?.positive ?? '',
          body.controls?.negative ?? '',
          ...(Array.isArray(body.controls?.tags) ? body.controls.tags : []),
        ]);
        if (changed) {
          seg.body = spaced;
          console.log(`[spacing] ${model.key}: ${changed} tag(s) respelled with spaces in ${seg.label}`);
        }
      }
    }

    // The third pass: every tag checked against the database and a user's
    // lexicon, and a labelled Anima v5 prompt joined into its one line. Before
    // cleanPositive, which does not know the labels. The brief is context for
    // the lexicon but NOT spared: a fake tag is as dead in Anima when the
    // person's own sentence suggested it.
    for (const seg of result.segments) {
      if (seg.label !== 'Positive prompt') continue;
      seg.body = thirdPass(model, seg.body, {
        brief: body.brief ?? '',
        spared: [
          body.controls?.positive ?? '',
          ...(Array.isArray(body.controls?.tags) ? body.controls.tags : []),
        ],
      });
    }

    // Before the negative pass, because cleanNegative compares against the
    // positive and should be reading the tidied one.
    for (const seg of result.segments) {
      if (seg.label !== 'Positive prompt') continue;
      const cleaned = cleanPositive(seg.body, {
        // Same gate as the negative: booru models only, and skipped entirely
        // when the tag database is not loaded, which is normal on a fresh
        // checkout. Without it the invented-tag check is simply not run and
        // deduplication still happens.
        known: model.tag_style && tags.loaded ? (t) => tags.postCount(t) > 0 : null,
        protected: [
          body.controls?.positive ?? '',
          ...(Array.isArray(body.controls?.tags) ? body.controls.tags : []),
          body.brief ?? '',
        ],
      });
      const { duplicates, invented } = cleaned.removed;
      if (duplicates.length || invented.length) {
        seg.body = cleaned.cleaned;
        // Logged rather than silent, for the same reason the negative is: a
        // model doing this constantly is a prompt-file signal and should be
        // visible without anyone diffing output by hand.
        const parts = [];
        if (duplicates.length) parts.push(`${duplicates.length} duplicate(s)`);
        if (invented.length) parts.push(`invented ${invented.join(', ')}`);
        console.log(`[positive] ${model.key}: removed ${parts.join(', ')}`);
      }
    }

    for (const seg of result.segments) {
      if (seg.label !== 'Negative prompt') continue;
      const positives = [
        result.segments.find((s2) => s2.label === 'Positive prompt')?.body ?? '',
        ...(Array.isArray(body.controls?.tags) ? body.controls.tags : []),
      ];
      const cleaned = cleanNegative(seg.body, positives, {
        // Only booru models: their negative is a tag lookup, so a tag the
        // database has never heard of cannot steer them. Prose negatives are
        // not tag lists and must not be filtered against danbooru. Skipped
        // entirely when the tag database is not loaded, which is a normal
        // state on a fresh checkout.
        known: model.tag_style && tags.loaded ? (t) => tags.postCount(t) > 0 : null,
        // Config and user input are never second-guessed.
        protected: [model.negative_defaults ?? '', body.controls?.negative ?? ''],
      });
      const { duplicates, contradictions } = cleaned.removed;
      const { unknown } = cleaned.noted;
      if (duplicates.length || contradictions.length) {
        // Logged rather than silent: if a model starts doing this constantly
        // that is a prompt-file signal, and it should be visible without
        // anyone diffing output by hand.
        const parts = [];
        if (duplicates.length) parts.push(`${duplicates.length} duplicate(s)`);
        if (contradictions.length) {
          parts.push(`${contradictions.length} contradicting the positive (${contradictions.join(', ')})`);
        }
        console.warn(`[negative] ${model.key}: dropped ${parts.join('; ')}`);
      }
      // Separate line and a different verb, because these were KEPT. Reported
      // because a model inventing a lot of vocabulary at once is worth seeing;
      // not removed, because danbooru's label set is not the vocabulary of what
      // a community checkpoint understands. See server/negative.mjs.
      if (unknown.length) {
        console.log(
          `[negative] ${model.key}: kept ${unknown.length} not in danbooru (${unknown.join(', ')})`
        );
      }

      // And put back the registry defaults the model left out. cleanNegative
      // removes; this adds, and the asymmetry is deliberate — see
      // server/negative.mjs. Measured on the 9B: pony dropped score_6/5/4
      // entirely on 6 of 6 runs, and rewriting pony.md's wording only moved
      // that to 2 of 6. It is a constant sitting in config; asking a small
      // model to transcribe it is a job it can only lose at.
      const restored = ensureDefaults(cleaned.text, model.negative_defaults ?? '', positives);
      if (restored.added.length) {
        console.warn(
          `[negative] ${model.key}: restored ${restored.added.length} registry default(s) (${restored.added.join(', ')})`
        );
      }
      seg.body = restored.text;

      // Then cut the model's own additions back to the configured allowance.
      // The registry defaults always survive; this only bounds what was
      // invented on top of them. See capExtras in server/negative.mjs for the
      // 1,652-character negative that produced this setting.
      const allowance = model.negative_extra_max ?? config.negative?.extra_max ?? 0;
      const capped = capExtras(seg.body, model.negative_defaults ?? '', allowance);
      if (capped.dropped.length) {
        console.warn(
          `[negative] ${model.key}: dropped ${capped.dropped.length} tag(s) past the allowance of ${allowance}`
        );
      }
      seg.body = capped.text;
    }

    // Literal parentheses, escaped so the generator does not read a series
    // name as a weight. `makima (chainsaw man)` parses as an emphasis
    // expression that lost its number, and the series steers nothing.
    //
    // Gated on `weight_range`, which is present on exactly the four models
    // where parentheses mean weighting and absent on the six where they do
    // not — so this is registry-driven, names no model, and cannot drift out
    // of step with the thing it depends on. A model that gains weighting
    // gains this with it.
    //
    // **Last, and that ordering is load-bearing.** cleanNegative filters the
    // negative against the danbooru tag database, and `makima \(chainsaw
    // man\)` is in no database — escaping first would have made every
    // disambiguated tag look unknown and deleted it. Everything upstream
    // reasons about tags; this is the step that turns them into generator
    // syntax, so nothing may reason about them afterwards.
    //
    // Both prompts, because a character tag is as likely to be negated as
    // asked for. See server/parens.mjs for why this is not left to the
    // prompt file.
    if (model.weight_range) {
      for (const seg of result.segments) {
        if (!/^(Positive prompt|Negative prompt)$/.test(seg.label)) continue;
        const { text, escaped } = escapeLiteralParens(seg.body);
        if (escaped.length) {
          seg.body = text;
          console.log(
            `[parens] ${model.key}: escaped ${escaped.length} literal ` +
              `${escaped.length === 1 ? 'pair' : 'pairs'} (${escaped.join(', ')})`
          );
        }
      }
    }

    // The chosen style, word for word, last - after every pass that edits
    // text, so none of them touches it. See server/style.mjs.
    if (!result.refused && pasteStyle(model, body.controls ?? {}, result.segments)) {
      console.log(`[style] ${model.key}: pasted "${body.controls?.style}" onto the prompt`);
    }

    // What the model looked up, on the done event as well as the live `tool`
    // events — a harness reading only the final frame still has to be able to
    // say whether an arm actually used its tools, and "the tool was offered"
    // and "the model called it" are very different results.
    const toolsUsed = tools ? { offered: true, rounds, calls: toolLog } : { offered: false };

    // Pointers back at a picture the image generator will never see. The one
    // defect of this pipeline that is obvious to a person and invisible to
    // the model that wrote it — "same pose as the reference" is a note about
    // a prompt, not a prompt.
    //
    // Warned, never rewritten. Editing generated prose with a regex is making
    // a judgement about a sentence it cannot read, and the fix when this
    // fires is in prompts/, not here.
    if (blueprint) {
      const leaks = referenceLabelLeaks(
        result.segments.filter((s) => !new Set(model.meta_segments ?? []).has(s.label)).map((s) => s.body).join('\n')
      );
      if (leaks.length) {
        console.warn(`[blueprint] ${model.key}: prompt points back at the picture — ${leaks.join(', ')}`);
        sse.send('warning', {
          message: `The prompt refers back to your reference (${leaks.join(', ')}). Your image generator cannot see it — edit those out or run a second pass.`,
        });
      }
    }

    // Picture labels: Subject definitions and Retention analysis written in code,
    // from the labels, the readings and the shots the model just wrote.
    if (cast && !result.refused) {
      const written = labelledSegments(model, cast, result.segments, labelDescriptions);
      result.segments = written.segments;
      const description = result.segments.find((s) => s.label === 'Detailed description');
      // A medium the reader saw in a picture is not a guess either.
      if (description) description.body = keepReferenceLook(description.body, [body.brief, ...[...labelDescriptions.values()].map((d) => (typeof d === 'object' ? d.look : d))].join('\n'));
      for (const message of written.warnings) sse.send('warning', { message });
    }

    // A subject or style picture the definitions never cite. Checked after the
    // labelled definitions are composed, so it judges what is on screen.
    if (body.controls?.mode === 'REF2VA' && !result.refused) {
      const definitions = result.segments.find((s) => s.label === 'Subject definitions')?.body;
      for (const message of referenceGroundingWarnings(definitions, body.controls.references, body.controls.mode)) {
        sse.send('warning', { message });
      }
    }
    if (body.controls?.mode === 'REF2VA' && !cast) {
      const definitions = result.segments.find((s) => s.label === 'Subject definitions')?.body;
      for (const message of groupWarnings(definitions, body.controls.references)) {
        sse.send('warning', { message });
      }
    }

    metrics.recordLatency(Date.now() - generationStarted);

    if (result.refused) {
      sse.send('done', { id, refused: true, segments: result.segments, usage, tools: toolsUsed });
    } else {
      const joined = result.segments.map((s) => s.body).join('');
      const overLimit =
        model.max_output_chars && joined.length > model.max_output_chars
          ? { limit: model.max_output_chars, actual: joined.length }
          : null;
      sse.send('done', {
        id,
        model: model.key,
        segments: result.segments,
        usage,
        over_limit: overLimit,
        tools: toolsUsed,
        // Repeated from the live event above so the client can keep it with
        // the result rather than with the stream. The second pass needs it:
        // it is the only way that pass can judge the draft against the
        // reference without either looking at the pictures again or running
        // the read a second time.
        // With the identity of the pictures it was read from, so a revision
        // can tell whether it still describes the current selection.
        ...(blueprint ? {
          reference_analysis: blueprint,
          reference_analysis_identity: referenceAnalysisIdentity(model, body.brief, body.controls?.image_references ?? [], registry.defaults ?? {}),
        } : {}),
        // The whole prompt as the Director's Simple mode needs it, for models
        // that declare `simple_prompt`. Built from the CLEANED segments, after
        // every step above, so it can never disagree with what the panel shows.
        ...simpleField(model, body.controls, result.segments),
      });
    }
  } catch (err) {
    // Partial output is kept — the panel keeps what streamed and offers retry.
    const partial = collected.join('');

    if (err instanceof SegmentParseError) {
      // A token ceiling is a guillotine: it stops generation mid-token, so
      // the segments after the cut simply never arrive and the parser reports
      // them missing. Left unexplained that reads as "the model ignored its
      // format", which sends the next person to the prompt file for a problem
      // that lives in a number box. `usage.truncated` is the backend saying
      // done_reason was "length", so this is reported rather than guessed.
      const cutOff = usage?.truncated && maxLength?.unit === 'tokens';
      sse.send('error', {
        code: err.code,
        message: cutOff
          ? `Your ${maxLength.value}-token limit cut the output off before the model finished. ${err.message} Raise the limit or switch it to words.`
          : err.message,
        expected: err.expected,
        found: err.found,
        // Non-empty when the content arrived inside another segment rather
        // than not at all — a format slip the next attempt usually gets right.
        misplaced: err.misplaced,
        truncated_by_limit: cutOff ? maxLength.value : null,
        partial,
      });
    } else if (err instanceof LLMError) {
      sse.send('error', {
        code: err.code,
        message: await llmErrorMessage(err),
        // GPU OOM reaches the user unmodified — the backend's own text names
        // the knob to turn.
        verbatim: err.verbatim,
        partial,
      });
    } else {
      sse.send('error', { code: 'internal', message: err.message, partial });
    }
  } finally {
    ticket.release();
    sse.end();
  }
}

/**
 * Which model answers this turn.
 *
 * The selector is populated from what the backend has actually pulled, so a
 * name that is not installed means either a stale page or a hand-written
 * request. Both deserve the same answer — named, before a conversation is
 * created and before anyone waits in the queue — rather than a 30-second wait
 * ending in the backend's own 404.
 *
 * Absent means "no opinion", and the backend applies its configured default.
 * That is deliberately not the same as sending the configured name: one place
 * decides what the default is, which is the same rule chooseModel() follows
 * for prompt writing.
 *
 * A backend that cannot list what it holds — anything but Ollama — is trusted
 * rather than second-guessed. It loads one model at start, so the selector has
 * nothing to offer and this never fires.
 */
async function resolveChatModel(wanted) {
  const name = String(wanted ?? '').trim();
  if (!name) return { model: null };
  const installed = (await llm.health())?.installed ?? [];
  if (installed.length && !installed.includes(name)) {
    return {
      error: {
        error: ERR.MODEL_NOT_INSTALLED,
        message: `${name} is not installed. Pick another model, or ask the owner to pull it.`,
      },
    };
  }
  return { model: name };
}

/**
 * The prompt writer this person chose under "Written by", when it is no longer
 * installed. Chat has always checked this (resolveChatModel above); generate
 * and refine did not, and a preference saved before the model was deleted -
 * six went on 30 Sep 2026 - ended every generation on "HTTP 404" and
 * llama-swap's raw JSON. Only the person's own choice is checked: a registry
 * pin or the configured default missing is the owner's problem and keeps the
 * backend's own error.
 */
async function writerNotInstalled(model, req) {
  const prefs = storage.getPrefs(whoIs(req));
  const chosen = chooseModel(model, prefs);
  if (!chosen || model.llm_model || chosen !== String(prefs.prompt_llm ?? '').trim()) return null;
  const { error } = await resolveChatModel(chosen);
  return error
    ? { ...error, message: `${chosen}, picked under Written by, is not installed any more. Pick another model there, or ask the owner to pull it.` }
    : null;
}

/** Pictures one chat message may carry. */
const CHAT_MAX_PICTURES = 4;

/**
 * One real generation for chat's write_prompt tool: handleGenerate itself,
 * called in process with the chat person's own identity, so every step the
 * model's tab runs (character lookup, tools, cleanup, their switched-off
 * segments) runs here too. Its SSE goes into a stand-in response and is read
 * back as events. See server/chat-prompt-tool.mjs.
 *
 * Takes its own queue ticket like any generation, so the caller must have
 * released the chat's ticket first or this waits behind it forever.
 *
 * @returns { segments } on success, { refused, segments } on a refusal, or
 *          { error } in words the person can read.
 */
async function runPromptTool(req, model, brief, { onQueued, signal } = {}) {
  const fakeReq = Readable.from([Buffer.from(JSON.stringify({ model: model.key, brief, controls: {} }))]);
  fakeReq.headers = req.headers;
  fakeReq.user = req.user;
  fakeReq.method = 'POST';
  const fakeRes = new EventEmitter();
  let buffer = '';
  let result = null;
  fakeRes.writeHead = () => fakeRes;
  fakeRes.flushHeaders = () => {};
  fakeRes.write = (chunk) => {
    buffer += String(chunk);
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      if (event === 'queued') onQueued?.(payload.position);
      else if (event === 'done') result = payload.refused ? { refused: true, segments: payload.segments ?? [] } : { segments: payload.segments ?? [] };
      else if (event === 'error') result = { error: payload.message ?? 'The prompt writer failed.' };
    }
    return true;
  };
  // A refusal before streaming starts (a bad model, a full queue) is a plain
  // JSON reply through sendJSON, which ends with the body.
  fakeRes.end = (body) => {
    if (body && !result) {
      try { result = { error: JSON.parse(String(body)).message ?? 'The prompt writer refused the request.' }; } catch { /* not JSON */ }
    }
    fakeRes.emit('finish');
    fakeRes.emit('close');
  };
  // The chat closing stops the generation, the way closing a tab does.
  signal?.addEventListener('abort', () => fakeRes.emit('close'), { once: true });
  await handleGenerate(fakeReq, fakeRes);
  return result ?? { error: 'The prompt writer returned nothing.' };
}

/**
 * POST /api/chat — a turn of conversation, streamed.
 *
 * Body: { id?, message, model?, pictures?: [{ type, data (base64) }] }.
 * Pictures are held in memory only - see server/chatpictures.mjs - and the
 * message may be empty when it carries one. Without an id a new conversation is created
 * and its id comes back on the first SSE event, so the client never has to
 * guess or poll for it.
 *
 * Shares the inference queue with prompt generation, because they share one
 * GPU. That is also why the ticket carries kind: 'chat' — the active users
 * panel should say "Chatting" rather than "Generating" for a conversation.
 *
 * Web search is absent, not stubbed. The spec has Qwen deciding via native
 * tool calling against a local SearXNG, which needs Docker — out of scope, and
 * `search.enabled` is false. The seam is the `searched` and `citations` fields
 * the stored message schema already carries.
 */
async function handleChat(req, res) {
  let body;
  try {
    // Room for up to CHAT_MAX_PICTURES pictures as base64. The page shrinks
    // them before sending, so a real request is well under this.
    body = await readBody(req, 24 * 1024 * 1024);
  } catch (err) {
    return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
  }

  const text = String(body.message ?? '').trim();
  const pictureParts = Array.isArray(body.pictures) ? body.pictures : [];
  if (!text && !pictureParts.length) {
    return sendJSON(res, 400, { error: 'empty_message', message: 'Say something first.' });
  }
  if (pictureParts.length > CHAT_MAX_PICTURES) {
    return sendJSON(res, 400, {
      error: 'too_many_pictures',
      message: `Up to ${CHAT_MAX_PICTURES} pictures per message.`,
    });
  }

  const user = whoIs(req);
  // Composed per request, not at boot. The prompt store caches, and this
  // server is meant to run for weeks - a date baked in at startup would be
  // wrong by more than the model's own guess inside a fortnight.
  const base = prompts.chat();
  const system = base ? [base, runtimeContext(), await chatContext(body)].filter(Boolean).join(PROMPT_SEPARATOR) : null;
  if (!system) {
    return sendJSON(res, 500, {
      error: 'prompt_unavailable',
      message: 'The chat system prompt is not loaded.',
    });
  }

  // Checked before anything is written or queued: an unusable model must not
  // cost a conversation file and a place in the line first.
  const picked = await resolveChatModel(body.model);
  if (picked.error) return sendJSON(res, 400, picked.error);

  // Pictures: checked and decoded here, before a conversation file exists,
  // and never written anywhere - see server/chatpictures.mjs.
  const pictures = [];
  if (pictureParts.length) {
    const model = picked.model ?? llm.model;
    if ((await visionTags.canSee(model)) === false) {
      return sendJSON(res, 400, {
        error: 'no_vision',
        message: `${model} cannot see pictures. Pick a model marked vision.`,
      });
    }
    const limits = taggers.info().limits;
    for (const part of pictureParts) {
      const type = String(part?.type ?? '').toLowerCase();
      if (!limits.allowed_image_types.includes(type)) {
        return sendJSON(res, 415, { error: 'unsupported_type', message: `${type || 'That file'} is not a picture this can read.` });
      }
      const buf = Buffer.from(String(part?.data ?? ''), 'base64');
      if (!buf.length || buf.length > (limits.max_image_mb ?? 20) * 1024 * 1024) {
        return sendJSON(res, 413, { error: 'too_large', message: `Each picture must be under ${limits.max_image_mb ?? 20} MB.` });
      }
      const readable = await visionBytes(buf, type);
      const sent = readable === buf ? type : 'image/png';
      pictures.push(`data:${sent};base64,${readable.toString('base64')}`);
    }
  }

  // Existing conversation or a new one. A bad id is a 404 rather than a
  // silent new conversation, or a client bug quietly scatters orphans.
  let chat;
  if (body.id) {
    chat = storage.getChat(user, body.id);
    if (!chat) {
      return sendJSON(res, 404, { error: 'not_found', message: `No conversation ${body.id}` });
    }
  } else {
    chat = storage.createChat(user, { model: picked.model ?? llm.model });
  }

  // Persisted before a single token is generated. If the box dies mid-answer,
  // what the person said survives — losing their question as well as the
  // answer would be the worse half of that failure.
  //
  // The model rides along so a switch mid-conversation is recorded even if the
  // answer then fails: reopening it has to reselect what was actually last
  // asked for, not what it was opened with.
  chat = storage.appendMessage(user, chat.id, {
    role: 'user',
    content: text,
    ...(picked.model ? { model: picked.model } : {}),
    // A count only. The pictures themselves stay in memory.
    ...(pictures.length ? { pictures: pictures.length } : {}),
  });
  if (pictures.length) chatPictures.hold(user, chat.id, chat.messages.length - 1, pictures);

  const sse = openSSE(req, res);
  const abort = new AbortController();
  // **res, not req.** Measured 5 Sep 2026 on the P40: when the client goes
  // away mid-generation, `res` emits 'close' and `req` does not — the request
  // stream has already ended, because its body was read in full before the
  // handler ever started. So this listener never fired, abort() was never
  // called, the upstream generation ran to completion on the GPU, and the
  // handler never reached the finally that releases the queue ticket.
  //
  // Reported as cancelling doing nothing: the person pressed Stop, then queued
  // behind their own abandoned job and waited out the rest of it.
  //
  // Firing on a NORMAL finish too is harmless — abort() after the work is done
  // is a no-op, and the ticket has already been released by then.
  res.on('close', () => abort.abort());

  sse.send('chat', { id: chat.id, title: chat.title });

  const ticket = inferenceQueue.enqueue({ user, model: picked.model ?? llm.model, kind: 'chat' });
  ticket.onPosition((position) => {
    if (position > 0) sse.send('queued', { position });
  });

  const collected = [];
  let usage = null;

  try {
    await ticket.started;
    if (sse.closed) return;

    // ── web search, when the button is on ──
    //
    // Before the answer starts, not during it. The spec has the model deciding
    // via tool calling; the owner asked for an explicit toggle, so the search
    // is a plain step here and the person always knows whether it happened.
    //
    // A failed search is not a failed turn. `searched` records what was asked
    // and what came back either way, so a stored conversation says plainly
    // whether its answer had sources behind it.
    let searchContext = null;
    let searched = null;
    let citations = [];
    if (body.search === true) {
      sse.send('searching', { query: text });
      const found = await search.run(text);
      searched = { query: found.query, results: found.results.length, detail: found.detail ?? null };
      citations = found.results.map((r) => ({ n: r.n, url: r.url, title: r.title, domain: r.domain }));
      searchContext = search.asContext(found);
      sse.send('searched', {
        query: found.query,
        ok: found.ok,
        detail: found.detail ?? null,
        results: citations,
      });
    }

    sse.send('status', { state: 'generating' });
    usageStats.record(picked.model ?? llm.model);
    metrics.incGenerations(picked.model ?? llm.model);

    // The whole conversation, not just the latest turn — that is what makes
    // it a conversation. The context cap in config/server.yaml is what stops
    // this growing without bound; nothing here trims, because a silent trim
    // that drops the message someone is referring to is worse than an honest
    // context error.
    //
    // A picture is replayed with the message it came with for as long as it is
    // held, so a follow-up question can still look at it. One no longer held
    // (a restart, or two idle hours), or a switch to a model that cannot see,
    // leaves a note in its place rather than the model guessing.
    const held = chatPictures.forChat(user, chat.id);
    const sees = held ? (await visionTags.canSee(picked.model ?? llm.model)) !== false : false;
    // write_prompt: a prompt for one of the app's models, from that model's
    // own writer. See server/chat-prompt-tool.mjs and runPromptTool.
    const promptTool = await chatPromptTool(picked.model ?? llm.model);
    // render_picture: the same, then a render. See runRenderTool.
    const renderTool = await chatRenderTool(picked.model ?? llm.model, req);
    // edit_picture: the latest picture here, changed. See runEdit.
    const editTool = await chatEditTool(picked.model ?? llm.model, req);
    const chatTools = [promptTool, renderTool, editTool].filter(Boolean);
    const history = chat.messages.flatMap((m, i) => {
      // A reply the tool wrote goes back as the tool call and its result.
      // Replayed as plain assistant text, it taught the model to write the
      // next prompt itself and copy the "written by the Krea2 prompt writer"
      // line onto it (2 Oct 2026) - a false label on its own work.
      if (m.tool && chatTools.some((t) => t.function.name === m.tool.name)) {
        const callId = `call_${i}`;
        return [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: callId, type: 'function', function: { name: m.tool.name, arguments: toolArgsForBackend(JSON.stringify(m.tool.name === 'edit_picture' ? { instruction: m.tool.brief } : { model: m.tool.model, brief: m.tool.brief })) } }],
          },
          { role: 'tool', content: m.content, tool_name: m.tool.name, tool_call_id: callId },
        ];
      }
      const pics = held?.get(i);
      if (pics?.length && sees) {
        return {
          role: m.role,
          content: [
            { type: 'text', text: m.content || 'Here is a picture.' },
            ...pics.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        };
      }
      if (m.pictures) {
        const why = pics?.length ? 'this model cannot see them' : 'they are no longer held';
        return {
          role: m.role,
          content: `${m.content}\n\n[${m.pictures} picture(s) were attached here, but ${why}.]`.trim(),
        };
      }
      return { role: m.role, content: m.content };
    });

    // Results ride in front of the latest question as a system turn rather
    // than being pasted into the person's own message: what they typed is what
    // gets stored and replayed, and a wall of search results inside it would
    // be replayed on every later turn as though they had written it.
    //
    // NOT as a system turn, which is what this was until 26 Sep 2026: Qwen's
    // chat template refuses any system message that is not the first one
    // ("System message must be at the beginning"), so every searched question
    // on llama.cpp died with a Jinja 500. The results now ride in front of
    // the latest question in THIS request only - the stored message is still
    // exactly what the person typed, so nothing is replayed on later turns.
    if (searchContext) {
      const last = history[history.length - 1];
      const lead = `${searchContext}\n\nThe question:\n`;
      history[history.length - 1] = {
        ...last,
        content: Array.isArray(last.content)
          ? [{ type: 'text', text: lead }, ...last.content]
          : `${lead}${last.content}`,
      };
    }

    const calls = new Map();
    for await (const ev of llm.stream({
      system,
      messages: history,
      ...(chatTools.length ? { tools: chatTools } : {}),
      model: picked.model ?? undefined,
      temperature: storage.getPrefs(user).chat_temperature,
      // Chat is the one surface where thinking earns its cost: the answer is
      // prose rather than a format contract, so a model reasoning first tends
      // to be worth the wait. config/server.yaml sets the default.
      thinking: config.llm?.chat_thinking ?? false,
      signal: abort.signal,
      mock: { chat: true, message: text },
    })) {
      if (ev.type === 'token') {
        collected.push(ev.text);
        sse.send('token', { text: ev.text });
      } else if (ev.type === 'tool_call') {
        // Accumulated by index: the OpenAI path streams a call in pieces.
        const cur = calls.get(ev.index) ?? { name: '', arguments: '' };
        calls.set(ev.index, { name: cur.name + (ev.name ?? ''), arguments: cur.arguments + (ev.arguments ?? '') });
      } else if (ev.type === 'usage') {
        usage = ev.usage;
      }
    }

    const call = [...calls.values()].find((c) => c.name === 'write_prompt');
    const renderCall = renderTool ? [...calls.values()].find((c) => c.name === 'render_picture') : null;
    let toolUsed = null;
    let rendered = null;
    let edited = null;
    const editCall = editTool && !call && !renderCall ? [...calls.values()].find((c) => c.name === 'edit_picture') : null;
    if (editCall) {
      const args = editToolArgs(editCall.arguments);
      const lead = collected.join('');
      let failure = args.error ?? null;
      const source = failure ? null : latestChatPictures(user, chat, held);
      if (source?.error) failure = source.error;
      if (!failure) {
        console.log(`[chat] edit_picture: ${args.instruction.slice(0, 80)}`);
        // The edit takes its own place in the line; this turn gives up its own.
        ticket.release();
        sse.send('status', { state: 'editing' });
        try {
          // The chat model already looked at the picture to ask for this; it
          // writes Qwen's instruction too when it can see, and otherwise the
          // request goes as it was asked.
          const seesPictures = (await visionTags.canSee(picked.model ?? llm.model)) !== false;
          const out = await runEdit(
            { user, instruction: args.instruction, pictures: source.pictures, llmModel: picked.model, asWritten: !seesPictures },
            {
              signal: abort.signal,
              onEvent: (event, data) => {
                if (event === 'queued' && data.position > 0) sse.send('queued', { position: data.position });
                else if (event === 'status') sse.send('status', { state: `edit_${data.state}` });
                else if (event === 'progress') sse.send('render_progress', data);
                else if (event === 'node') sse.send('render_node', data);
              },
            }
          );
          // Kept with the conversation, on its rules, rather than as a render
          // that goes in a day (the owner's call, 4 Oct 2026).
          const rec = comfy.readRender(out.record.id);
          const picture = storage.saveChatPicture(user, chat.id, readFileSync(rec.file));
          comfy.dropRender(out.record.id);
          edited = { picture, url: `/api/chat/${chat.id}/pictures/${picture}.png`, prompt: out.prompt, ms: out.record.ms, settings: out.record.settings };
          toolUsed = { name: 'edit_picture', brief: args.instruction, prompt: out.prompt };
          sse.send('edit', edited);
        } catch (err) {
          if (!err.code) console.error('[chat] edit failed:', err);
          failure = `The edit did not finish: ${err.message}`;
        }
      }
      const reply = failure
        ? [lead.trim(), failure].filter(Boolean).join('\n\n')
        : editReply(edit.label, edited.prompt, edited.ms, lead);
      const rest = reply.startsWith(lead) ? reply.slice(lead.length) : `\n\n${reply}`;
      collected.push(rest);
      sse.send('token', { text: rest });
    }
    if (renderCall && !call) {
      const models = registry.all().filter((m) => m.render?.workflow);
      const args = renderToolArgs(renderCall.arguments, models);
      const lead = collected.join('');
      let reply;
      if (args.error) {
        reply = [lead.trim(), args.error].filter(Boolean).join('\n\n');
      } else {
        const asked = [args.aspect, args.resolution].filter(Boolean).join(' @ ');
        console.log(`[chat] render_picture -> ${args.model.key}${args.same ? ' (same prompt)' : ''}${asked ? ` [${asked}]` : ''}: ${args.brief.slice(0, 80)}`);
        ticket.release();
        // "Render that": the prompt chat last wrote for this model, as it was.
        const previous = args.same
          ? [...chat.messages].reverse().find((m) => m.tool?.model === args.model.key && m.tool.positive)
          : null;
        let segments = null;
        let texts = previous ? { positive: previous.tool.positive, negative: previous.tool.negative ?? '' } : null;
        let failure = null;
        if (!texts) {
          sse.send('status', { state: 'writing_prompt', model: args.model.name });
          const out = await runPromptTool(req, args.model, args.brief, {
            signal: abort.signal,
            onQueued: (position) => { if (position > 0) sse.send('queued', { position }); },
          });
          if (out.error) failure = `The ${args.model.name} prompt writer could not write this one: ${out.error}`;
          else if (out.refused) failure = `The ${args.model.name} prompt writer declined this one.`;
          else {
            segments = out.segments;
            texts = renderTextsFrom(args.model, segments);
          }
        }
        const plan = texts ? chatRenderSettings(args.model, args) : null;
        if (!failure && plan?.error) failure = plan.error;
        if (!failure && texts) {
          sse.send('status', { state: 'rendering', model: args.model.name });
          const out = await runRenderTool(
            req,
            { model: args.model.key, positive: texts.positive, negative_segment: texts.negative, settings: plan.settings },
            {
              signal: abort.signal,
              onEvent: (event, data) => {
                if (event === 'queued' && data.position > 0) sse.send('queued', { position: data.position });
                else if (event === 'status') sse.send('status', { state: `render_${data.state}`, model: args.model.name });
                else if (event === 'progress') sse.send('render_progress', data);
                else if (event === 'node') sse.send('render_node', data);
              },
            }
          );
          if (out.error) failure = `The render did not finish: ${out.error}`;
          else rendered = out;
        }
        if (failure) {
          reply = [lead.trim(), failure].filter(Boolean).join('\n\n');
        } else {
          const shownSegments = segments ?? [{ label: 'Prompt', body: texts.positive }];
          reply = renderReply(args.model, shownSegments, rendered, lead);
          toolUsed = { name: 'render_picture', model: args.model.key, brief: args.brief, positive: texts.positive, negative: texts.negative };
          sse.send('render', { ...rendered, model: args.model.key, brief: args.brief, segments: shownSegments });
        }
      }
      const rest = reply.startsWith(lead) ? reply.slice(lead.length) : `\n\n${reply}`;
      collected.push(rest);
      sse.send('token', { text: rest });
    }
    if (call) {
      const models = registry.keys().map((k) => registry.get(k));
      const args = promptToolArgs(call.arguments, models);
      const lead = collected.join('');
      let reply;
      if (args.error) {
        reply = [lead.trim(), args.error].filter(Boolean).join('\n\n');
      } else {
        console.log(`[chat] write_prompt -> ${args.model.key}: ${args.brief.slice(0, 80)}`);
        sse.send('status', { state: 'writing_prompt', model: args.model.name });
        // The generation takes its own place in the line, so this chat turn
        // gives up its own first or the two would wait on each other forever.
        ticket.release();
        const out = await runPromptTool(req, args.model, args.brief, {
          signal: abort.signal,
          onQueued: (position) => { if (position > 0) sse.send('queued', { position }); },
        });
        reply = out.error
          ? [lead.trim(), `The ${args.model.name} prompt writer could not write this one: ${out.error}`].filter(Boolean).join('\n\n')
          : out.refused
            ? [lead.trim(), `The ${args.model.name} prompt writer declined this one.`].filter(Boolean).join('\n\n')
            : promptReply(args.model, out.segments, lead);
        // The prompt itself is kept with the tool record, so "render that"
        // on a later turn draws exactly this one rather than a rewrite.
        if (!out.error && !out.refused) {
          toolUsed = { name: 'write_prompt', model: args.model.key, brief: args.brief, ...renderTextsFrom(args.model, out.segments) };
        }
      }
      // What streamed already stays on screen; the rest follows as one piece.
      const rest = reply.startsWith(lead) ? reply.slice(lead.length) : `\n\n${reply}`;
      collected.push(rest);
      sse.send('token', { text: rest });
    }

    const answer = collected.join('');
    const saved = storage.appendMessage(user, chat.id, {
      role: 'assistant',
      content: answer,
      searched,
      // Only the citations the answer actually used. A stored list of five
      // sources under an answer that referenced two would misrepresent it
      // every time the conversation is reopened.
      citations: citations.filter((c) => answer.includes(`[${c.n}]`)),
      ...(toolUsed ? { tool: toolUsed } : {}),
      // The picture stays on the server for keep_hours like any render; the
      // conversation keeps the link, which says so when it has expired.
      ...(rendered ? { render: { id: rendered.id, url: rendered.url, model: rendered.model, settings: rendered.settings, ms: rendered.ms } } : {}),
      // The edited picture, kept with the conversation as long as it is.
      ...(edited ? { edit: edited } : {}),
    });
    sse.send('done', {
      id: chat.id,
      title: saved.title,
      content: answer,
      citations: saved.messages.at(-1).citations ?? [],
      usage,
    });
  } catch (err) {
    // Same contract as generation: whatever arrived is kept, and the client
    // decides whether to show it. An assistant message is NOT saved on
    // failure — a half-answer in the history would be replayed as context on
    // every later turn as though the model had meant it.
    const partial = collected.join('');
    if (err instanceof LLMError) {
      sse.send('error', { code: err.code, message: await llmErrorMessage(err), verbatim: err.verbatim, partial });
    } else {
      sse.send('error', { code: 'internal', message: err.message, partial });
    }
  } finally {
    ticket.release();
    sse.end();
  }
}

/**
 * The reference pictures themselves, as OpenAI content parts — or none.
 *
 * The point of the whole feature, and it did not work until 8 Sep 2026: the
 * model writing the prompt looks at the picture, instead of reading a tag
 * list somebody else made from it.
 *
 * **The browser downscales before sending.** These arrive as data URIs in the
 * control payload rather than as a second upload, because the analyze route
 * already had the bytes once and making the person wait through a second
 * round trip at generate time would be the slower half of a feature whose
 * cost is already image prefill. The cap below is a backstop, not the
 * mechanism — see the canvas resize in web/app.js.
 *
 * Order matters and is the same order formatImageReferences numbers its
 * lines in, which is what makes "Reference 2" mean anything.
 *
 * **It was not, until 8 Sep 2026.** This iterated the array as the browser
 * sent it — upload order — while the lines were grouped by registry role
 * order. Attach a pose and then a character and the notes call the character
 * Reference 1 while the pictures put the pose there, so every annotation
 * lands on the wrong photograph. Silent, and worst on exactly the case the
 * roles exist for. Both sides now go through orderReferences.
 *
 * @returns { parts, sent, dropped } — parts in registry role order, the
 *          references those parts came from at the SAME indices (which is
 *          what the blueprint pass numbers its blocks from), and the count
 *          that did not fit, so the caller can say so rather than silently
 *          sending fewer pictures than the person attached.
 */
/**
 * Only what the browser is supposed to have produced. A data URI is the one
 * shape this accepts: a remote URL here would have llama-server fetching
 * something off the network on our behalf, which is not a thing this app does
 * and not a thing a reference card can ask for.
 */
const SENDABLE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function referenceImageParts(references = [], defaults = {}) {
  const max = defaults.max_image_references ?? 6;
  const parts = [];
  const sent = [];
  const ordered = orderReferences(references, defaults);
  let dropped = 0;
  for (const ref of ordered) {
    const url = typeof ref?.image === 'string' ? ref.image : null;
    if (!url) continue;
    if (parts.length >= max) { dropped += 1; continue; }
    if (!SENDABLE_IMAGE.test(url)) {
      console.warn('[image-references] a reference image was not a base64 data URI and was dropped');
      dropped += 1;
      continue;
    }
    parts.push({ type: 'image_url', image_url: { url } });
    sent.push(ref);
  }
  return { parts, sent, dropped };
}

/**
 * The same thing for the video models, whose references live on two other
 * control keys entirely.
 *
 * **Added 9 Sep 2026, and it is the same defect twice.** The image models
 * stopped working from a tag dump on 8 Sep — "the whole point was that the
 * llm sees the reference image, not the tagger auto inject" — and the video
 * models were still doing exactly that a day later. wan's first and last
 * frames were run through the tagger and reached the model as a comma list;
 * h3's references reached it as role, keep, drop and length, which describes
 * a file's job in the Director's pipeline and not one thing about what is in
 * the photograph. Neither model had ever been shown a picture.
 *
 * Two sources rather than one because they are two different contracts, and
 * merging them is the mistake server/imagerefs.mjs was split out to avoid:
 *
 *   i2v_reference / i2v_last_reference  wan's frame pair. Ordered first then
 *                                       last, because that is a direction of
 *                                       travel and not a list.
 *   references[]                        h3's Director rows, in the order
 *                                       formatReferences numbers them, each
 *                                       named by the label it was given.
 *
 * The labels come back with the parts so the message can say WHICH line each
 * attached picture belongs to. Without that, four pictures under a list of
 * five references is a correspondence the model has to guess at, and the one
 * it guesses wrong is the one that matters.
 *
 * Capped at the same `max_image_references` as the image lane. The Director
 * itself allows 9 images in REF2VA and this ceiling is lower on purpose: nine
 * projector passes is prefill paid on a Pascal card on every re-roll, and the
 * lines for the references past the cap still travel.
 *
 * @returns { parts, labels, dropped } — labels parallel to parts.
 */
function videoReferenceParts(controls = {}, defaults = {}) {
  const max = defaults.max_image_references ?? 6;
  const parts = [];
  const labels = [];
  let dropped = 0;

  const add = (url, label) => {
    if (typeof url !== 'string' || !url) return;
    if (parts.length >= max) { dropped += 1; return; }
    if (!SENDABLE_IMAGE.test(url)) {
      console.warn('[video-references] a reference image was not a base64 data URI and was dropped');
      dropped += 1;
      return;
    }
    parts.push({ type: 'image_url', image_url: { url } });
    labels.push(label);
  };

  add(controls.i2v_reference?.image, 'the first frame');
  add(controls.i2v_last_reference?.image, 'the last frame');

  if (Array.isArray(controls.references) && controls.references.length) {
    // Recomputed rather than threaded through from buildUserMessage: this is
    // a pure function of the same rows, it runs once per generation, and the
    // alternative is a second argument that has to be kept in step by hand.
    const { images } = formatReferences(controls.references, controls.mode);
    for (const { ref, label } of images) add(ref?.image, label);
  }

  return { parts, labels, dropped };
}

/**
 * The attached pictures as message parts, each one behind its own label.
 *
 * `parts` stays pictures only, because its length is the picture count
 * everywhere else. Labels ride only here, at the moment the message is built:
 * "in that order" in the text was not enough. With five pictures and a brief
 * that names none, the 8B and both 27Bs swapped <Picture 2> and <Picture 4>
 * on every run (29 Sep 2026, a user's own references). A picture with no label
 * (the image lane has none) goes as it did before.
 */
function labelledImageParts({ parts = [], labels = [] } = {}) {
  return parts.flatMap((part, i) => (labels[i] ? [{ type: 'text', text: `${labels[i]}:` }, part] : [part]));
}

/**
 * Read the pictures under their roles, before anybody writes a prompt.
 *
 * The first of the two calls — see server/refblueprint.mjs for the argument
 * and prompts/_shared/reference-blueprint.md for what the analyst is told.
 * Its output is text, it is never parsed, and it goes into the compile call
 * in place of the pictures.
 *
 * **Every failure here falls back to the old path**, which is the pictures
 * riding along with the compile call. That path works — it is what this app
 * did on 8 Sep 2026 — so there is no failure of this pass that is worth
 * turning into a failure of the generation. The caller says out loud when it
 * happened; it does not stop.
 *
 * @returns { text, reason } — text empty when the caller should fall back,
 *          and reason saying why, for the log and for the user.
 */
async function runReferenceBlueprint({ model, llmModel, refImages, brief, signal }) {
  const system = prompts.referenceBlueprint();
  if (!system) return { text: '', reason: 'no instruction file on this server' };
  // The mock backend cannot see anything, and mockStream answers every prompt
  // with canned segments — a "blueprint" of ===SEGMENT: blocks would be worse
  // than no blueprint, because blueprintUsable would accept it.
  if (llm.backend === 'mock') return { text: '', reason: 'mock backend' };

  const userText = buildBlueprintMessage(
    // The references whose pictures are actually going up, in the order they
    // are going up in. Not the raw control array: one that was dropped for
    // being over the ceiling or malformed would shift every number after it.
    refImages.sent,
    brief,
    registry.defaults ?? {},
    (role) => ROLE_CARRIES_CHARACTER.has(role)
  );

  const started = Date.now();
  let text = '';
  try {
    for await (const ev of llm.stream({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }, ...labelledImageParts(refImages)] }],
      temperature: BLUEPRINT_TEMPERATURE,
      // Extraction, and thinking on an extraction task buys a longer wait for
      // a reconsidered list of what is in a photograph.
      thinking: false,
      model: llmModel,
      timeoutMs: model.timeout_ms,
      contextLength: model.context_length,
      maxTokens: blueprintBudget(refImages.parts.length),
      signal,
    })) {
      if (ev.type === 'token') text += ev.text ?? '';
    }
  } catch (err) {
    // Including an abort: if the person pressed Stop during the read, the
    // compile call is about to be aborted too and this reason never shows.
    return { text: '', reason: `the read failed (${err.message})` };
  }

  const ms = Date.now() - started;
  // The 27B wraps the whole reading in a ```text fence, copying the schema in
  // the prompt file. Taken off here rather than asked for in the prompt — see
  // stripFence.
  text = stripFence(text);
  if (!blueprintUsable(text)) {
    console.warn(`[blueprint] ${model.key}: unusable read in ${(ms / 1000).toFixed(1)}s — ${JSON.stringify(text.slice(0, 120))}`);
    return { text: '', reason: 'the model did not come back with a usable reading' };
  }
  console.log(`[blueprint] ${model.key}: ${refImages.parts.length} picture(s) read in ${(ms / 1000).toFixed(1)}s, ${text.length} chars`);
  return { text: text.trim(), reason: null };
}

/**
 * Every keyframe on the timeline, read once each.
 *
 * The readings are cached by picture hash, so a re-roll, a moved boundary or
 * a reworded beat costs nothing — see the header of server/keyframes.mjs for
 * why this lane describes where wan and h3 attach.
 *
 * **Serially, not in parallel.** The queue runs at concurrency 1 and there is
 * one GPU; firing eight vision calls at once would not make them finish
 * sooner and would make the progress line meaningless. Each is announced as
 * it starts, because eight of these is minutes of silence otherwise.
 *
 * A failure on one picture is a segment with no keyframe annotation, not a
 * failed generation. The person still gets a prompt built from their own
 * lines, which is what Director mode did before this existed.
 *
 * @returns {Promise<Map<number,string>>} segment index -> reading
 */
async function readKeyframes({ model, llmModel, blocks, brief, system, signal, sse }) {
  const readings = new Map();
  if (llm.backend === 'mock') return readings;

  for (const [i, block] of blocks.entries()) {
    const hash = keyframeHash(block.image);
    const cached = keyframeCache.get(hash);
    if (cached) {
      readings.set(block.index, cached);
      console.log(`[keyframe] ${model.key}: segment ${block.index} already read (${hash})`);
      continue;
    }

    sse.send('status', { state: 'reading_keyframes', done: i, total: blocks.length });

    const started = Date.now();
    let text = '';
    try {
      for await (const ev of llm.stream({
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: keyframeMessage(block, { brief }) },
              { type: 'image_url', image_url: { url: block.image } },
            ],
          },
        ],
        temperature: KEYFRAME_TEMPERATURE,
        thinking: false,
        model: llmModel,
        timeoutMs: model.timeout_ms,
        contextLength: model.context_length,
        maxTokens: KEYFRAME_BUDGET,
        signal,
      })) {
        if (ev.type === 'token') text += ev.text ?? '';
      }
    } catch (err) {
      // An abort included: the compile call is about to be aborted too, and
      // this warning never reaches anyone.
      console.warn(`[keyframe] ${model.key}: segment ${block.index} failed — ${err.message}`);
      sse.send('warning', {
        message: `The keyframe on segment ${block.index} could not be read (${err.message}). That segment is working from your own line only.`,
      });
      continue;
    }

    const reading = usableReading(stripFence(text));
    const ms = ((Date.now() - started) / 1000).toFixed(1);
    if (!reading) {
      console.warn(`[keyframe] ${model.key}: segment ${block.index} unusable in ${ms}s — ${JSON.stringify(text.slice(0, 120))}`);
      sse.send('warning', {
        message: `${llmModel ?? llm.model} did not come back with a reading for segment ${block.index}'s keyframe. That segment is working from your own line only.`,
      });
      continue;
    }
    console.log(`[keyframe] ${model.key}: segment ${block.index} read in ${ms}s, ${reading.length} chars (${hash})`);
    keyframeCache.set(hash, reading);
    readings.set(block.index, reading);
  }
  return readings;
}

/**
 * h3 REF2VA: read each reference picture (or subject group) on its own.
 * See server/picture-readings.mjs. Returns Map(labels -> reading); a unit that
 * fails is left out with a warning, and the writer still has its row line.
 */
/**
 * Units whose pictures are read from a people box get that crop as their
 * picture. A crop that cannot be cut (not a data URL) leaves the whole
 * picture, which is what was read before boxes existed.
 */
async function withCrops(units) {
  return Promise.all(units.map(async (u) => {
    if (!(u.crops ?? []).some(Boolean)) return u;
    const refs = await Promise.all(u.refs.map(async (r, i) => {
      const box = u.crops[i];
      if (!box || !r?.image) return r;
      try {
        return { ...r, image: await cropImage(r.image, box) };
      } catch (err) {
        console.warn(`[people] ${u.tag}: crop failed, reading the whole picture - ${err.message}`);
        return r;
      }
    }));
    return { ...u, refs };
  }));
}

async function readPictures({ model, llmModel, units, system, signal, sse, force = false, temperature = PICTURE_TEMPERATURE, onReading = () => {}, message = readingMessage, maxTokens = PICTURE_BUDGET, useGiven = true, keyOf = (u) => u.labels.join(', ') }) {
  const readings = new Map();
  if (llm.backend === 'mock') return readings;

  for (const [i, unit] of units.entries()) {
    const key = keyOf(unit);
    const hash = readingHash(unit);

    // A description the page already has — scanned earlier, or written by
    // the person — is used as it is. `force` is a rescan, which ignores both
    // it and the cache.
    const given = force || !useGiven ? null : givenReading(unit);
    const cached = force ? null : given ?? pictureCache.get(hash);
    if (cached) {
      readings.set(key, cached);
      onReading(key, cached);
      console.log(`[pictures] ${model.key}: ${key} ${given ? 'described by the page' : 'already read'} (${hash})`);
      continue;
    }

    sse.send('status', { state: 'reading_references', done: i, total: units.length });

    const started = Date.now();
    let text = '';
    try {
      for await (const ev of llm.stream({
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: message(unit) },
              ...unit.refs.map((r) => ({ type: 'image_url', image_url: { url: r.image } })),
            ],
          },
        ],
        temperature,
        thinking: false,
        model: llmModel,
        timeoutMs: model.timeout_ms,
        contextLength: model.context_length,
        // A unit may need more room than the rest: a picture of several
        // characters read as a group describes each of them.
        maxTokens: unit.maxTokens ?? maxTokens,
        signal,
      })) {
        if (ev.type === 'token') text += ev.text ?? '';
      }
    } catch (err) {
      console.warn(`[pictures] ${model.key}: ${key} failed — ${err.message}`);
      sse.send('warning', { message: `${key} could not be looked at on its own (${err.message}).` });
      continue;
    }

    const reading = usableReading(stripFence(text));
    const ms = ((Date.now() - started) / 1000).toFixed(1);
    if (!reading) {
      console.warn(`[pictures] ${model.key}: ${key} unusable in ${ms}s — ${JSON.stringify(text.slice(0, 120))}`);
      sse.send('warning', { message: `${llmModel ?? llm.model} did not come back with a reading for ${key}.` });
      continue;
    }
    console.log(`[pictures] ${model.key}: ${key} read in ${ms}s, ${reading.length} chars (${hash})`);
    pictureCache.set(hash, reading);
    readings.set(key, reading);
    onReading(key, reading);
  }
  return readings;
}

/**
 * POST /api/references/scan — look at h3 reference pictures ahead of Generate.
 *
 * Same body as a generation (model + controls); the pictures are read the way
 * Generate would read them and each description streams back as `reading`.
 * Pictures that already carry a description are skipped, so pressing Scan
 * again only looks at what is new. `pictures: [n]` narrows it to the units
 * holding those picture numbers, and `force` rescans them, a little looser
 * than a first scan so a rescan can actually come back different.
 */
async function handleReferenceScan(req, res) {
  let body;
  try {
    body = await readBody(req, GENERATE_BODY_LIMIT);
  } catch (err) {
    return sendJSON(res, err.statusCode === 413 ? 413 : 400, { error: 'bad_request', message: err.message });
  }
  const model = registry.get(body?.model);
  if (!model || model.type !== 'video') {
    return sendJSON(res, 400, { error: 'bad_model', message: 'Scanning pictures is for h3 references.' });
  }
  const system = prompts.referencePicture();
  if (!system) {
    return sendJSON(res, 503, { error: 'scan_off', message: 'Picture scanning is switched off on this server.' });
  }
  const units = readingUnits(applyPictureLabels(body.controls ?? {}).references ?? [], 'REF2VA');
  const only = Array.isArray(body.pictures) ? new Set(body.pictures.map(Number)) : null;
  const chosen = only
    ? units.filter((u) => u.labels.some((l) => only.has(Number(l.match(/\d+/)[0]))))
    : units;
  if (!chosen.length) {
    return sendJSON(res, 400, { error: 'no_pictures', message: 'There are no pictures to scan.' });
  }
  const llmModel = chooseModel(model, storage.getPrefs(whoIs(req)));
  if ((await visionTags.canSee(llmModel ?? llm.model)) === false) {
    return sendJSON(res, 503, {
      error: 'no_vision',
      message: `${llmModel ?? llm.model} cannot see images. Pick one marked vision in Written by.`,
    });
  }

  const sse = openSSE(req, res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model: llmModel ?? llm.model, kind: 'scan' });
  ticket.onPosition((position) => {
    if (position > 0) sse.send('queued', { position });
  });
  try {
    await ticket.started;
    if (sse.closed) return;
    const force = Boolean(body.force);
    const readings = await readPictures({
      model,
      llmModel,
      units: chosen,
      system,
      signal: abort.signal,
      sse,
      force,
      temperature: force ? 0.6 : PICTURE_TEMPERATURE,
      onReading: (labels, text) => sse.send('reading', { labels, text }),
    });
    sse.send('done', { read: readings.size, total: chosen.length });
  } catch (err) {
    if (!abort.signal.aborted) {
      sse.send('error', { error: err instanceof LLMError ? err.code : 'failed', message: err.message });
    }
  } finally {
    ticket.release();
    sse.end();
  }
}

/**
 * Body ceiling for the two routes that generate a prompt.
 *
 * readBody's 2MB default was the right size for a control payload and is the
 * wrong one now that the reference pictures ride along in it. Six downscaled
 * JPEGs base64 to roughly 2MB together, so this is headroom rather than a
 * target — the browser resizes before sending and the real cap on how many
 * pictures travel is max_image_references.
 */
const GENERATE_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * Raw bytes, for uploads. readBody JSON-parses and caps at 2MB, which is the
 * right shape for control payloads and the wrong one for a 20MB PNG.
 */
async function readRawBody(req, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error('too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The vision cross-check for one analyze result, or null when it does not apply.
 *
 * Which model gets asked is the person's own `prompt_llm`, not a separate
 * captioner — the same model that will write the prompt is the one that looks
 * at the reference. That is the whole reason this is cheap: no second set of
 * weights, nothing extra resident, and a config edit moves both at once.
 *
 * **`vision !== true` skips, so unknown is treated as no.** capabilitiesFor()
 * reports null when /api/show could not be read, and sending an image to a
 * model that might not be able to see it is not a guess worth making — it
 * costs a slow round trip to get back something unparseable.
 */
async function refineWithVision(req, buf, contentType, result) {
  if (!visionTags.enabled) return null;
  const model = chooseModel(undefined, storage.getPrefs(whoIs(req))) ?? llm.model;
  if (!model) return null;
  try {
    // Asked of the vision backend itself — see visionTags.canSee. This used to
    // consult llm.catalog(), which polls whichever backend GENERATES prompts,
    // and on 1 Sep 2026 that became llama.cpp while the picture still goes to
    // Ollama. llama-swap reports null capabilities, `null !== true` read as
    // "cannot see", and this pass stopped running entirely for three days
    // without one line in the log to say so.
    //
    // Only an explicit `false` stops it now. `null` is "the backend did not
    // say", and the right response to not knowing is to try: refine() already
    // answers null on every failure, so a model that genuinely cannot see
    // costs one failed call and the tagger's list stands.
    if ((await visionTags.canSee(model)) === false) return null;
    // Counted like a generation. This one goes to Ollama rather than the
    // prompt backend, and it is real load on a real model — a 27B kept purely
    // because reference analysis leans on it should not read as unused.
    usageStats.record(model);
    metrics.incGenerations(model);
    // The picture has to be in a format the vision model can actually read,
    // and until 7 Sep 2026 the raw upload went straight out.
    //
    // `image/webp` is in `allowed_image_types` and always has been. The
    // TAGGER survives it because decode() falls back to ffmpeg when jimp
    // refuses — and jimp refuses outright, "Mime type image/webp does not
    // support decoding". This pass had no such fallback, so a webp reached
    // Ollama as bytes it could not decode, the model answered the single
    // word UNAVAILABLE exactly as reference-vision.md instructs it to, and
    // parseDecision correctly returned null. Every layer behaved, and the
    // net effect was that the vision pass silently never ran on a webp
    // while looking identical to a model that had nothing to add.
    //
    // Found by running an actual .webp screenshot through it. Three earlier
    // runs used .jpg and all three passed.
    const readable = await visionBytes(buf, contentType);
    const out = await visionTags.refine(readable, { model, general: result.general });
    if (!out) return null;
    return {
      ...result,
      general: out.tags,
      // Reported rather than silent. What the pass changed is the only way to
      // judge whether the confidence floor in config is the right one, and
      // this project's rule is that an unmeasured number stays visible until
      // it is measured.
      vision: {
        model: out.model,
        added: out.added,
        dropped: out.dropped,
        rejected: out.rejected,
        refused: out.refused,
        took_ms: out.took_ms,
      },
    };
  } catch (err) {
    console.warn(`[vision-tags] ${err.message}`);
    return null;
  }
}

/** Content types a vision model reads directly. Everything else is transcoded. */
const VISION_NATIVE = new Set(['image/png', 'image/jpeg', 'image/jpg']);
const VISION_EXT = { 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' };

/**
 * The same bytes in a format a vision model can read.
 *
 * Returns the original on anything already readable, and on any conversion
 * failure — a missing ffmpeg must cost the vision pass and nothing else, the
 * same contract every other step here keeps.
 */
async function visionBytes(buf, contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!type || VISION_NATIVE.has(type)) return buf;
  const converted = await transcodeImage(buf, { suffix: VISION_EXT[type] ?? '' });
  if (!converted.ok) {
    console.warn(`[vision-tags] could not convert ${type} for the vision model: ${converted.message}`);
    return buf;
  }
  return converted.bytes;
}

/**
 * Read one reference image with the LLM instead of the taggers.
 *
 * The other arm of `reference_analysis` — see server/visiontags.mjs. Returns
 * the tagger-shaped result on success, or a REASON on failure, and the reason
 * is the point: this arm can fail in four ways that all look identical from
 * the outside, and the card says which one happened rather than quietly
 * showing tagger output under a preference that says LLM.
 *
 * Never throws. The caller falls back to the taggers on anything but success.
 */
async function readReferenceWithLLM(req, buf, contentType) {
  if (!visionTags.describeEnabled) {
    return { ok: false, reason: 'the LLM reader is switched off on this server' };
  }
  // The model the person writes prompts with, not a separate captioner —
  // the owner's call, 7 Sep 2026. Same three-source rule as generation, so
  // "the one that's selected" means the one in the picker.
  const model = chooseModel(undefined, storage.getPrefs(whoIs(req))) ?? llm.model;
  if (!model) return { ok: false, reason: 'no model is selected' };

  try {
    // Asked of the backend that will be shown the picture, which is not
    // necessarily the one generating prompts — see visionTags.canSee, and
    // reference_vision.base_url in config/server.yaml. Three answers: false
    // is a model that cannot see, null is a backend that did not say.
    const seen = await visionTags.canSee(model);
    if (seen === false) {
      return { ok: false, reason: `${model} cannot see images` };
    }
    // Counted like a generation. This is real load on a real model, and one
    // kept purely because people read references with it should not read as
    // unused in the admin panel.
    usageStats.record(model);
    metrics.incGenerations(model);
    // webp reaches a vision model as bytes it cannot decode unless this
    // converts it first — the trap documented on refineWithVision, and it
    // costs this arm the entire reference rather than one cross-check.
    const readable = await visionBytes(buf, contentType);
    const out = await visionTags.describe(readable, { model });
    if (!out.ok) {
      // describe() names what went wrong. The one thing it cannot know is
      // that /api/show 404'd on the way in — `seen === null` — and on this
      // box that has a common cause worth naming: llama-swap serves models
      // Ollama has never heard of, and the picker offers them.
      return {
        ok: false,
        reason:
          seen === null && /could not be reached/.test(out.reason)
            ? `${out.reason} — the vision backend may not have that model`
            : out.reason,
      };
    }
    return {
      ok: true,
      result: {
        tagger: 'llm',
        model: out.model,
        // Ratings are the tagger's explicit/questionable/general call. The
        // model was not asked for one and inventing a field it did not answer
        // would be worse than the empty list the frontend already handles.
        ratings: [],
        character: out.character,
        general: out.general,
        // Reported for the same reason the cross-check reports its own: what
        // the tag check threw away is the only evidence for whether the
        // instruction file is working, and this project's rule is that the
        // number stays visible until it is measured.
        llm: { model: out.model, rejected: out.rejected, took_ms: out.took_ms },
      },
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * POST /api/analyze — tag one image.
 *
 * The image is the raw request body, with the tagger and thresholds in the
 * query string. The spec's endpoint list says "tagger selection in body",
 * but base64-in-JSON would inflate a 20MB upload to 27MB and then ask
 * JSON.parse to chew through it. Raw bytes plus query params is the boring
 * version and costs no dependency.
 */
async function handleAnalyze(req, res, url) {
  const limits = taggers.info().limits;
  const maxMb = limits.max_image_mb;

  let buf;
  try {
    // Read one megabyte past the limit so an oversized upload is rejected
    // with the real limit named rather than a generic socket error.
    buf = await readRawBody(req, (maxMb + 1) * 1024 * 1024);
  } catch {
    return sendJSON(res, 413, {
      error: 'image_too_large',
      message: `Image exceeds the ${maxMb} MB limit.`,
    });
  }

  const check = taggers.validateUpload({
    bytes: buf.length,
    contentType: req.headers['content-type'],
  });
  if (!check.ok) {
    const status = check.code === 'unsupported_type' ? 415 : check.code === 'image_too_large' ? 413 : 400;
    return sendJSON(res, status, { error: check.code, message: check.message });
  }

  const num = (name) => {
    const raw = url.searchParams.get(name);
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
  };

  try {
    // tagger=all: the reference taggers together (animetimm leading, WD EVA02
    // adding what it lacks), merged by server/tagmerge.mjs the same way a
    // reference picture is. Added to Tab 3 on 22 Sep 2026: on two test
    // pictures WD was sure of restrained, demon_girl, fangs and gradient_hair
    // where animetimm alone missed them.
    const tagger = url.searchParams.get('tagger') ?? undefined;
    const opts = {
      generalThreshold: num('general_threshold'),
      characterThreshold: num('character_threshold'),
      // So the ffmpeg fallback can name the input format rather than making
      // ffmpeg sniff it — see decode() in server/taggers.mjs.
      contentType: req.headers['content-type'],
    };
    const result = tagger === 'all'
      ? await taggers.analyzeForReference(buf, opts)
      : await taggers.analyze(buf, { tagger, ...opts });
    // Then, when the person's own model can see, show it the picture and let
    // it settle the list. Additive and never blocking: refineWithVision
    // answers null for every failure — disabled, sightless model, timeout,
    // unparseable reply — and the tagger's result goes out unchanged, which
    // is what this endpoint did before 29 Aug 2026.
    const refined = await refineWithVision(req, buf, req.headers['content-type'], result);
    return sendJSON(res, 200, refined ?? result);
  } catch (err) {
    if (err.code === 'tagger_unavailable') {
      return sendJSON(res, 503, { error: 'tagger_unavailable', message: err.message });
    }
    // A corrupt or truncated image lands here. Name it rather than 500ing.
    return sendJSON(res, 422, {
      error: 'analysis_failed',
      message: `Could not analyse the image: ${err.message}`,
    });
  }
}

/**
 * Describe an H3 reference — still, video, or audio clip.
 *
 * Deliberately NOT folded into /api/analyze. That endpoint is Tab 3's image
 * analysis and its allowlist is stills; teaching it video would mean Tab 3
 * silently accepting a file it has no feature for. Two endpoints, two
 * allowlists, and the one place they overlap — tagging pixels — is a call
 * into the same tagger.
 *
 * What comes back depends on what went in:
 *
 *   image  the tagger's own result, exactly as Tab 3 gets it
 *   video  ffmpeg samples frames from inside the clip, the tagger reads them,
 *          and the tags are merged; plus duration and whether it has sound
 *   audio  metadata only. Nothing on this box listens to audio, and saying so
 *          beats inventing traits for it
 *
 * Every failure path returns 200 with `described: false` and a reason rather
 * than an error status. The row is usable by hand the moment it appears — the
 * description is a convenience, and a red error on an upload that worked would
 * be a lie about what happened.
 */
/**
 * The read-back behind the Analyze button. Streams prose, parses nothing.
 *
 * The model that will write the prompt looks at the picture and says what it
 * sees, what matches the role it was given, what it intends to ignore and
 * where it is unsure. The person reads that and fixes the role, the fidelity
 * or the note before spending a generation — which is the whole point of it,
 * and the reason it is not another way to produce tags.
 *
 * **Parameterised by the same three controls generation uses.** Role,
 * fidelity and note come off the card and go into the question. A read-back
 * generated under one role and displayed beside another confirms nothing, so
 * the browser drops it the moment any of the three changes — see the
 * invalidation in web/app.js. This side has no way to enforce that and does
 * not try; it echoes all three back in the `started` event so the panel can
 * label what it is showing.
 *
 * Queued like a generation, because it is one: same card, same weights, and
 * an unqueued read-back would land on top of somebody's prompt.
 */
async function handleReferenceReadback(req, res, url) {
  const limits = taggers.info().limits;
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!limits.allowed_image_types.includes(contentType)) {
    return sendJSON(res, 415, {
      error: 'unsupported_type',
      message: `${contentType || 'that file'} cannot be read. Accepted: ${limits.allowed_image_types.join(', ')}`,
    });
  }

  const instructions = prompts.referenceAnalysis();
  if (!instructions) {
    return sendJSON(res, 503, {
      error: 'no_instructions',
      message: 'The reading instructions are not on this box, so Analyze is switched off.',
    });
  }

  let buf;
  try {
    buf = await readRawBody(req, (limits.max_image_mb ?? 20) * 1024 * 1024);
  } catch (err) {
    return sendJSON(res, err.statusCode === 413 ? 413 : 400, {
      error: err.statusCode === 413 ? 'too_large' : 'unreadable',
      message: err.statusCode === 413 ? `Over the ${limits.max_image_mb} MB limit.` : 'Could not read the upload.',
    });
  }

  const model = chooseModel(undefined, storage.getPrefs(whoIs(req))) ?? llm.model;
  if (!model) {
    return sendJSON(res, 503, { error: 'no_model', message: 'No model is selected.' });
  }
  // Only an explicit `false` stops it, for the reason written on
  // refineWithVision: `null` is a backend that did not answer, and the right
  // response to not knowing is to try and let the failure be specific.
  if ((await visionTags.canSee(model)) === false) {
    return sendJSON(res, 503, {
      error: 'no_vision',
      message: `${model} cannot see images. Pick one that can, or say what to take from it in the note.`,
    });
  }

  const roles = registry.defaults?.image_reference_roles ?? {};
  const fidelities = registry.defaults?.reference_fidelity ?? {};
  const roleKey = roles[url.searchParams.get('role')]
    ? url.searchParams.get('role')
    : (registry.defaults?.default_image_reference_role ?? Object.keys(roles)[0]);
  const fidelityKey = fidelities[url.searchParams.get('fidelity')]
    ? url.searchParams.get('fidelity')
    : (registry.defaults?.default_reference_fidelity ?? Object.keys(fidelities)[0]);
  const note = String(url.searchParams.get('note') ?? '').trim().slice(0, 2000);

  const role = roles[roleKey] ?? {};
  const fidelity = fidelities[fidelityKey] ?? {};

  // The role's own label and rule, straight off the registry, so a reworded
  // role rewords this question without a code edit — the same property
  // server/imagerefs.mjs relies on for the lines it writes.
  const question = [
    `This picture is a ${(role.label ?? roleKey).toUpperCase()} reference.`,
    role.rule ? `What that role covers: ${role.rule}` : null,
    `How closely the user wants it followed: ${fidelity.label ?? fidelityKey}${fidelity.rule ? ` — ${fidelity.rule}` : ''}`,
    note ? `\nWhat they said to take from it, in their own words:\n"${note}"` : null,
    '\nRead it back to them.',
  ].filter(Boolean).join('\n');

  let readable;
  try {
    // Same conversion the other two arms make. A webp reaches a vision model
    // as bytes it cannot decode, and the failure looks like a model with
    // nothing to say — see the note on refineWithVision.
    readable = await visionBytes(buf, contentType);
  } catch (err) {
    return sendJSON(res, 422, {
      error: 'unreadable_image',
      message: `Could not convert that picture for the model (${err.message}).`,
    });
  }

  const sse = openSSE(req, res);
  const abort = new AbortController();
  // res, not req — the disconnect trap documented on the chat route. Without
  // it a cancelled read-back keeps the card busy and the queue blocked.
  res.on('close', () => abort.abort());

  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model, kind: 'reference_readback' });
  ticket.onPosition((position) => {
    if (position > 0) sse.send('queued', { position });
  });

  try {
    await ticket.started;
    if (sse.closed) return;

    sse.send('started', { model, role: roleKey, fidelity: fidelityKey, note });
    usageStats.record(model);
    metrics.incGenerations(model);

    for await (const ev of llm.stream({
      system: instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${readable.toString('base64')}` },
            },
          ],
        },
      ],
      model,
      // A reading task, not a writing one — the same 0.2 the other two arms
      // use, and the creativity presets have no business here.
      temperature: 0.2,
      // Off, and not optional. Measured on the P40 8 Sep 2026 on the
      // non-streaming arm: left on, the whole token budget went to
      // reasoning_content and the reply came back empty in 74s.
      thinking: false,
      signal: abort.signal,
    })) {
      if (ev.type === 'token') sse.send('token', { text: ev.text });
      else if (ev.type === 'usage') sse.send('usage', ev.usage);
    }
    sse.send('done', {});
  } catch (err) {
    if (!abort.signal.aborted) {
      sse.send('error', {
        error: err instanceof LLMError ? err.code : 'failed',
        message: err.message,
      });
    }
  } finally {
    ticket.release();
    sse.end();
  }
}

/**
 * POST /api/analyze/describe — Image Analysis' "Describe it" (22 Sep 2026).
 *
 * The owner wanted tags AND natural language from one picture, either or
 * both. Tags come from the CPU taggers as before; this is the words, from the
 * vision model people already write prompts with - not ToriiGate, which was
 * tried in this tab on 21 Aug and named Frieren "Leafa". The tagger's tags are
 * passed in (?tags=a,b,c) so the model can also say what they missed or got
 * wrong. Same shape as handleReferenceReadback: raw image body, queued like a
 * generation, streamed as SSE. Instructions: prompts/analysis/describe.md.
 */
async function handleAnalyzeDescribe(req, res, url) {
  const limits = taggers.info().limits;
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!limits.allowed_image_types.includes(contentType)) {
    return sendJSON(res, 415, {
      error: 'unsupported_type',
      message: `${contentType || 'that file'} cannot be read. Accepted: ${limits.allowed_image_types.join(', ')}`,
    });
  }

  let instructions = null;
  try {
    instructions = readFileSync(path.join(ROOT, 'prompts', 'analysis', 'describe.md'), 'utf8').trim();
  } catch { /* reported below */ }
  if (!instructions) {
    return sendJSON(res, 503, {
      error: 'no_instructions',
      message: 'prompts/analysis/describe.md is missing, so Describe is switched off.',
    });
  }

  let buf;
  try {
    buf = await readRawBody(req, (limits.max_image_mb ?? 20) * 1024 * 1024);
  } catch (err) {
    return sendJSON(res, err.statusCode === 413 ? 413 : 400, {
      error: err.statusCode === 413 ? 'too_large' : 'unreadable',
      message: err.statusCode === 413 ? `Over the ${limits.max_image_mb} MB limit.` : 'Could not read the upload.',
    });
  }

  // The tab's own picker (26 Sep 2026), so models can be compared on one
  // picture without changing the model that writes prompts. Absent means
  // "whatever writes my prompts", which is how it worked before.
  let model;
  const wanted = url.searchParams.get('model');
  if (wanted) {
    const picked = await resolveChatModel(wanted);
    if (picked.error) return sendJSON(res, 400, picked.error);
    model = picked.model;
  } else {
    model = chooseModel(undefined, storage.getPrefs(whoIs(req))) ?? llm.model;
  }
  if (!model) {
    return sendJSON(res, 503, { error: 'no_model', message: 'No model is selected.' });
  }
  if ((await visionTags.canSee(model)) === false) {
    return sendJSON(res, 503, {
      error: 'no_vision',
      message: `${model} cannot see images. Pick one marked vision.`,
    });
  }
  // Sampling from the tab, clamped; absent keeps the old 0.2 and no penalty.
  const numberParam = (name, lo, hi, fallback) => {
    const v = Number(url.searchParams.get(name));
    return url.searchParams.has(name) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  const describeTemperature = numberParam('temperature', 0, 1.5, 0.2);
  const describePenalty = numberParam('presence_penalty', 0, 2, 0);

  // NOT called `tags`: that name is the tag database, and shadowing it made
  // the check at the end quietly pass every invented tag. Caught on the P40.
  const tagList = String(url.searchParams.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 200);
  // The cast of any series the tagger recognised a character from, so the
  // model can name the others by eye rather than from memory. Prototyped on
  // the P40 22 Sep 2026: without it the model described Aura and could not
  // name her; with it, it named her with the exact tag.
  const cast = charCast.castFor(tagList);
  const castBlock = cast.length
    ? cast.map((s) => [
        `Characters from ${s.series}, with how they usually look:`,
        ...s.cast.map((c) => `- ${c.tag}: ${c.look.join(', ')}`),
      ].join('\n')).join('\n\n') +
      '\n\nIf anyone in the picture is one of these characters, name them with that exact tag. ' +
      'Go by what you can see; do not pick one just because it is on the list.\n\n'
    : '';
  const question = tagList.length
    ? `The tagger found these tags:\n${tagList.join(', ')}\n\n${castBlock}Describe the picture.`
    : 'No tags were found for this picture. Describe it, and list the main tags it should have under Missed.';

  let readable;
  try {
    readable = await visionBytes(buf, contentType);
  } catch (err) {
    return sendJSON(res, 422, {
      error: 'unreadable_image',
      message: `Could not convert that picture for the model (${err.message}).`,
    });
  }

  const sse = openSSE(req, res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model, kind: 'describe' });
  ticket.onPosition((position) => {
    if (position > 0) sse.send('queued', { position });
  });

  try {
    await ticket.started;
    if (sse.closed) return;
    sse.send('started', { model, cast: cast.map((s) => ({ series: s.series, characters: s.cast.length })) });
    let written = '';
    usageStats.record(model);
    metrics.incGenerations(model);

    for await (const ev of llm.stream({
      system: instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${readable.toString('base64')}` } },
          ],
        },
      ],
      model,
      // A reading task: low temperature, thinking off (it spent the whole
      // budget reasoning on the read-back route, measured 8 Sep 2026).
      // Both adjustable from the tab since 26 Sep 2026: at 0.2 with no
      // penalty the 4B vision models repeat whole sentences, and Qwen's own
      // advice for Qwen3-VL is 0.7 with a presence penalty of 1.5.
      temperature: describeTemperature,
      ...(describePenalty ? { presence_penalty: describePenalty } : {}),
      thinking: false,
      signal: abort.signal,
    })) {
      if (ev.type === 'token') { written += ev.text; sse.send('token', { text: ev.text }); }
      else if (ev.type === 'usage') sse.send('usage', ev.usage);
    }
    // Every tag it suggested, checked against the tag database before anyone
    // copies it. The model invents plausible ones - `scale_tail`, `glossy_skin`
    // - and a tag danbooru does not have is a tag the image model was never
    // trained on. Checked here rather than given to the model as a tool: the
    // database is right here, and a tool round costs another whole pass.
    const missedBlock =
      /(?:^|\n)\s*-?\s*Missed:(.*(?:\n(?!\s*-?\s*(?:Doubtful|Description|Characters):).*)*)/i.exec(written)?.[1] ?? '';
    // Backticked tags when it marked them - its explanations in brackets
    // are prose, not tags - else the plain comma list.
    const candidates = /`/.test(missedBlock)
      ? [...missedBlock.matchAll(/`([^`]+)`/g)].map((m) => m[1])
      : missedBlock.split(/[,\n]/);
    const suggested = [...new Set(
      candidates
        .map((s) => s.trim().toLowerCase().replace(/^[-*\s]+/, '').replace(/\s+/g, '_'))
        .filter((s) => /^[a-z0-9][a-z0-9_()'.-]{1,60}$/.test(s))
    )];
    const unknown = suggested.filter((t) => tags.loaded && tags.postCount(t) === 0);
    sse.send('done', { suggested, unknown });
  } catch (err) {
    if (!abort.signal.aborted) {
      sse.send('error', { error: err instanceof LLMError ? err.code : 'failed', message: err.message });
    }
  } finally {
    ticket.release();
    sse.end();
  }
}

/**
 * POST /api/caption — one LoRA training caption (17 Oct 2026).
 *
 * Same shape as Describe above: raw image body, options in the query string,
 * queued like a generation, streamed as SSE. The style (config/captions.yaml)
 * names the instruction file under prompts/captions/; the trigger word,
 * "Don't include" and tag spelling are applied in server/captions.mjs after
 * the model answers, so they hold whatever the model did. `done` carries the
 * finished caption; `token` events are the raw reply, for the progress view.
 */
// The MOSS Layout Studio's Rewrite: one section of the layout rewritten with
// the whole scene as context, answered as the studio's own engine answered —
// JSON { text }. The instruction is the studio's, in the file the registry
// names. See server/layout.mjs.
async function handleMossAssist(req, res) {
  const model = registry.all().find((m) => m.layout_rewrite_prompt);
  if (!model) return sendJSON(res, 404, { error: 'not_found', message: 'No model has a Layout Studio.' });
  let body;
  try {
    body = await readBody(req, 2 * 1024 * 1024);
  } catch {
    return sendJSON(res, 400, { error: 'unreadable', message: 'Could not read the request.' });
  }
  let messages;
  try {
    messages = rewriteMessages(readFileSync(path.join(ROOT, model.layout_rewrite_prompt), 'utf8'), body);
  } catch (err) {
    return sendJSON(res, 400, { error: 'bad_request', message: err.message });
  }
  const llmModel = chooseModel(model, storage.getPrefs(whoIs(req))) ?? llm.model;
  if (!llmModel) return sendJSON(res, 503, { error: 'no_model', message: 'No model is selected.' });

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model: llmModel, kind: 'layout-rewrite' });
  try {
    await ticket.started;
    usageStats.record(llmModel);
    metrics.incGenerations(llmModel);
    let text = '';
    for await (const ev of llm.stream({
      system: messages.system,
      messages: [{ role: 'user', content: messages.user }],
      model: llmModel,
      // The studio's own settings.
      temperature: 0.25,
      maxTokens: 1200,
      thinking: false,
      signal: abort.signal,
    })) {
      if (ev.type === 'token') text += ev.text;
    }
    text = text.trim();
    if (!text) return sendJSON(res, 502, { error: 'empty', message: 'The model returned an empty prompt.' });
    return sendJSON(res, 200, { text });
  } catch (err) {
    if (abort.signal.aborted) return;
    return sendJSON(res, 502, { error: err instanceof LLMError ? err.code : 'failed', message: err.message });
  } finally {
    ticket.release();
  }
}

async function handleCaption(req, res, url) {
  // First, before the upload is read: a refused request should not get to
  // send twenty megabytes.
  if (!mayCaption(req)) {
    return sendJSON(res, 403, {
      error: 'forbidden',
      message: 'That needs the "caption" permission, which the owner grants per account.',
    });
  }
  const limits = taggers.info().limits;
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!limits.allowed_image_types.includes(contentType)) {
    return sendJSON(res, 415, {
      error: 'unsupported_type',
      message: `${contentType || 'that file'} cannot be read. Accepted: ${limits.allowed_image_types.join(', ')}`,
    });
  }

  let style;
  try {
    style = loadCaptionStyles(ROOT).find((s) => s.id === url.searchParams.get('style'));
  } catch (err) {
    return sendJSON(res, 500, { error: 'caption_styles', message: `config/captions.yaml could not be read: ${err.message}` });
  }
  if (!style) return sendJSON(res, 400, { error: 'unknown_style', message: 'Pick a caption style.' });

  // What the LoRA is for (18 Oct 2026): the trigger word carries what the type
  // names, and the type's own instruction file says what to leave out. An
  // unknown or missing type falls back to the first one in config.
  const loraTypes = loadLoraTypes(ROOT);
  const loraType = loraTypes.find((t) => t.id === url.searchParams.get('type')) ?? loraTypes[0] ?? null;
  const type = loraType?.id ?? 'character';

  const instructions = captionInstructions(ROOT, style, loraType?.id);
  if (!instructions) {
    return sendJSON(res, 503, {
      error: 'no_instructions',
      message: `prompts/${style.prompt} is missing, so ${style.label} captions are switched off.`,
    });
  }

  let buf;
  try {
    buf = await readRawBody(req, (limits.max_image_mb ?? 20) * 1024 * 1024);
  } catch (err) {
    return sendJSON(res, err.statusCode === 413 ? 413 : 400, {
      error: err.statusCode === 413 ? 'too_large' : 'unreadable',
      message: err.statusCode === 413 ? `Over the ${limits.max_image_mb} MB limit.` : 'Could not read the upload.',
    });
  }

  // The view's own "Written by"; absent means whatever writes my prompts.
  let model;
  const wanted = url.searchParams.get('model');
  if (wanted) {
    const picked = await resolveChatModel(wanted);
    if (picked.error) return sendJSON(res, 400, picked.error);
    model = picked.model;
  } else {
    model = chooseModel(undefined, storage.getPrefs(whoIs(req))) ?? llm.model;
  }
  if (!model) return sendJSON(res, 503, { error: 'no_model', message: 'No model is selected.' });
  if ((await visionTags.canSee(model)) === false) {
    return sendJSON(res, 503, { error: 'no_vision', message: `${model} cannot see images. Pick one marked vision.` });
  }

  const trigger = String(url.searchParams.get('trigger') ?? '').trim().slice(0, 100);
  const exclude = parseExclude(url.searchParams.get('exclude'));
  const tagList = String(url.searchParams.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 200);
  const length = url.searchParams.get('length') ?? undefined;

  let readable;
  try {
    readable = await visionBytes(buf, contentType);
  } catch (err) {
    return sendJSON(res, 422, { error: 'unreadable_image', message: `Could not convert that picture for the model (${err.message}).` });
  }

  const sse = openSSE(req, res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const ticket = inferenceQueue.enqueue({ user: whoIs(req), model, kind: 'caption' });
  ticket.onPosition((position) => {
    if (position > 0) sse.send('queued', { position });
  });

  try {
    await ticket.started;
    if (sse.closed) return;
    sse.send('started', { model, style: style.id });
    let written = '';
    usageStats.record(model);
    metrics.incGenerations(model);
    for await (const ev of llm.stream({
      system: instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: captionRequest(style, { tags: tagList, exclude, trigger, typeLabel: loraType?.label }) },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${readable.toString('base64')}` } },
          ],
        },
      ],
      model,
      // A reading task, like Describe: low temperature, thinking off. MOSS's
      // guide recommends thinking ON for its recaptioner; not done here yet,
      // because it multiplies the time per picture and that is the owner's call.
      temperature: 0.3,
      presence_penalty: 0.5,
      thinking: false,
      signal: abort.signal,
    })) {
      if (ev.type === 'token') { written += ev.text; sse.send('token', { text: ev.text }); }
      else if (ev.type === 'usage') sse.send('usage', ev.usage);
    }
    let finished;
    try {
      finished = finishCaption(style, written, {
        trigger, exclude, length, type,
        resolve: tags.loaded ? (t) => closestTag(t, { postCount: tags.postCount, aliasTarget: tags.aliasTarget }) : null,
      });
    } catch (err) {
      sse.send('error', { error: err.code ?? 'unparseable', message: err.message, raw: written });
      return;
    }
    // Tags danbooru has never seen, reported rather than removed: a rare
    // real tag and an invented one look the same from here.
    const meta = new Set((style.meta_tags ?? []).map((t) => t.toLowerCase()));
    const unknown = (finished.tags ?? []).filter((t) =>
      !t.startsWith('@') && !meta.has(t) && tags.loaded && tags.postCount(t.replace(/ /g, '_')) === 0);
    sse.send('done', { ...finished, unknown, model });
  } catch (err) {
    if (!abort.signal.aborted) {
      sse.send('error', { error: err instanceof LLMError ? err.code : 'failed', message: err.message });
    }
  } finally {
    ticket.release();
    sse.end();
  }
}

async function handleReferenceAnalysis(req, res, url) {
  const limits = taggers.info().limits;
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

  const lane = limits.allowed_image_types.includes(contentType)
    ? 'image'
    : limits.allowed_video_types.includes(contentType)
      ? 'video'
      : limits.allowed_audio_types.includes(contentType)
        ? 'audio'
        : null;

  if (!lane) {
    const every = [
      ...limits.allowed_image_types,
      ...limits.allowed_video_types,
      ...limits.allowed_audio_types,
    ];
    return sendJSON(res, 415, {
      error: 'unsupported_type',
      message: `${contentType || 'That file'} is not accepted. Allowed: ${every.join(', ')}.`,
    });
  }

  const maxMb =
    lane === 'image' ? limits.max_image_mb : lane === 'video' ? limits.max_video_mb : limits.max_audio_mb;

  let buf;
  try {
    buf = await readRawBody(req, (maxMb + 1) * 1024 * 1024);
  } catch {
    return sendJSON(res, 413, {
      error: 'file_too_large',
      message: `That ${lane} exceeds the ${maxMb} MB limit.`,
    });
  }
  if (buf.length > maxMb * 1024 * 1024) {
    return sendJSON(res, 413, {
      error: 'file_too_large',
      message: `That ${lane} is ${(buf.length / 1048576).toFixed(1)} MB. The limit is ${maxMb} MB.`,
    });
  }
  if (!buf.length) {
    return sendJSON(res, 400, { error: 'empty_file', message: 'No data was received.' });
  }

  // `type` is passed only on the still path. Sampled video frames arrive here
  // as JPEG regardless of the container they came out of, so handing them the
  // request's `video/mp4` would tell the ffmpeg fallback in decode() to write
  // `.mp4` on a JPEG — harmless today, since jimp reads JPEG and the fallback
  // never runs, but wrong in a way that would be maddening to find later.
  // analyzeForReference, not analyze: a reference image is read by every
  // tagger in config's `reference_taggers` and merged, at that file's lower
  // floor. The argument for both is there — the role filter throws away every
  // class the role cannot use before the model sees any of it, so recall is
  // nearly free here in a way it is not on Tab 3.
  //
  // An explicit ?tagger= still wins, so the picker keeps working and a
  // single-tagger answer stays one query string away.
  const picked = url.searchParams.get('tagger');
  const tag = async (bytes, type) =>
    picked
      ? taggers.analyze(bytes, { tagger: picked, ...(type ? { contentType: type } : {}) })
      : taggers.analyzeForReference(bytes, { ...(type ? { contentType: type } : {}) });

  try {
    if (lane === 'image') {
      // Who reads this picture — the CPU taggers, or the model this person
      // writes prompts with. One or the other, never both: they produce the
      // same shape of list from the same image, and merging them is the
      // cross-check, which is a different feature with its own switch.
      //
      // The choice is the person's because it is a judgement about the
      // picture in front of them. The taggers know a fixed vocabulary very
      // well and cannot see — animetimm is the only thing on this box that
      // identified Frieren — while a model that can see finds the layer no
      // tagger scores: light direction, framing, surface state. Measured 7
      // Sep 2026 on a Hinata photograph, the tagger pair returned two pose
      // tags and zero lighting tags, so three of the six roles had nothing
      // to work with; dropping the floor 7.6x did not fix it, because the
      // tags are not under the line — the tagger does not see that layer.
      //
      // What the LLM costs is the reason it is not the default: 19-56s warm
      // and 137s cold of GPU time on the P40, competing with prompt
      // generation for the card, against about four seconds of a CPU that is
      // otherwise idle.
      //
      // An explicit ?tagger= still wins over both, so the probe scripts and
      // the picker keep working.
      const wanted =
        url.searchParams.get('read_by') ??
        storage.getPrefs(whoIs(req))?.reference_analysis ??
        'taggers';

      let fallback = null;
      if (!picked && wanted === 'llm') {
        const read = await readReferenceWithLLM(req, buf, contentType);
        if (read.ok) {
          return sendJSON(res, 200, { kind: 'image', described: true, read_by: 'llm', ...read.result });
        }
        // Falls back rather than failing — a reference card with tags on it
        // beats an error — but the card SAYS the taggers read it and why.
        // Silently serving tagger output under a preference that says LLM is
        // the failure this whole route has been bitten by twice.
        fallback = read.reason;
        console.warn(`[reference] LLM read fell back to the taggers: ${read.reason}`);
      }

      const result = await tag(buf, contentType);
      return sendJSON(res, 200, {
        kind: 'image',
        described: true,
        read_by: 'taggers',
        ...(fallback ? { fell_back_from: 'llm', fallback_reason: fallback } : {}),
        ...result,
      });
    }

    const suffix = EXT_FOR_TYPE[contentType] ?? '';
    const probe = await probeMedia(buf, { suffix });

    if (lane === 'audio') {
      return sendJSON(res, 200, {
        kind: 'audio',
        described: false,
        // Not a failure. There is no audio model on this box and the official
        // guide's audio roles — timbre, delivery, beat, ambience — are
        // judgements a tagger would not make anyway.
        reason: probe.ok
          ? 'Audio is not described automatically. Say what it is being referenced for.'
          : probe.message,
        duration_seconds: probe.ok ? probe.duration_seconds : null,
      });
    }

    // video
    if (!probe.ok) {
      return sendJSON(res, 200, { kind: 'video', described: false, reason: probe.message });
    }
    if (!probe.has_video) {
      // An .mp4 carrying only an audio stream is a real thing people upload.
      // Treat it as what it is rather than failing to find frames in it.
      return sendJSON(res, 200, {
        kind: 'video',
        described: false,
        reason: 'That file has no video stream — it is audio in a video container.',
        duration_seconds: probe.duration_seconds,
        has_audio: probe.has_audio,
        has_video: false,
      });
    }

    const sampled = await sampleFrames(buf, {
      count: REFERENCE_FRAME_SAMPLES,
      duration: probe.duration_seconds,
      suffix,
    });
    if (!sampled.ok) {
      return sendJSON(res, 200, {
        kind: 'video',
        described: false,
        reason: sampled.message,
        duration_seconds: probe.duration_seconds,
        has_audio: probe.has_audio,
        has_video: true,
      });
    }

    // Tag every frame and merge, keeping each tag's best confidence. A tag
    // that appears in one frame of three is still in the clip — this is a
    // reference, not a classification, and the person edits the list anyway.
    // Merging on max rather than mean is what makes a brief action visible.
    const best = new Map();
    let taggerName = null;
    for (const frame of sampled.frames) {
      let result;
      try {
        result = await tag(frame.bytes);
      } catch (err) {
        // One unreadable frame must not lose the other two.
        if (err.code === 'tagger_unavailable') throw err;
        continue;
      }
      taggerName = result.model ?? taggerName;
      for (const group of ['character', 'general']) {
        for (const t of result[group] ?? []) {
          const prev = best.get(t.tag);
          if (!prev || t.confidence > prev.confidence) best.set(t.tag, { ...t, group });
        }
      }
    }

    const merged = [...best.values()].sort((a, b) => b.confidence - a.confidence);
    return sendJSON(res, 200, {
      kind: 'video',
      described: Boolean(merged.length),
      reason: merged.length ? null : 'Nothing was detected in the sampled frames.',
      model: taggerName,
      character: merged.filter((t) => t.group === 'character'),
      general: merged.filter((t) => t.group === 'general'),
      duration_seconds: probe.duration_seconds,
      has_audio: probe.has_audio,
      has_video: true,
      sampled_at: sampled.frames.map((f) => f.at_seconds),
    });
  } catch (err) {
    if (err.code === 'tagger_unavailable') {
      return sendJSON(res, 503, { error: 'tagger_unavailable', message: err.message });
    }
    return sendJSON(res, 422, {
      error: 'analysis_failed',
      message: `Could not read that ${lane}: ${err.message}`,
    });
  }
}

// How many frames to pull out of a video reference. Three is enough to catch
// a change of shot in a short clip without spending three times the CPU on a
// tagger that already takes a second or two per image, on a box that is also
// holding an LLM.
const REFERENCE_FRAME_SAMPLES = 3;

// ffprobe and ffmpeg both sniff content, but a container extension makes them
// far more reliable about it — a headerless .webm written as `input` with no
// suffix is a common way to get "invalid data found".
const EXT_FOR_TYPE = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/flac': '.flac',
};

async function handleStatus(res, req) {
  // Both are cheap and neither throws. `resident` is what is actually in VRAM
  // right now, which is a different question from health()'s "is the
  // configured model installed" — and on a box five people share, with h3
  // overriding to a 27B that cannot sit alongside the 8B, it is the question
  // people actually have.
  const [health, resident, catalog, media] = await Promise.all([
    llm.health(),
    llm.resident(),
    // Sizes for the chat model selector. Cached inside llm.mjs for a minute,
    // so five people polling every 10s do not become 30 requests a minute at
    // Ollama for a list that changes when somebody runs a pull.
    llm.catalog(),
    // Cached after the first call, so this is free on the 10s poll.
    mediaTools(),
  ]);
  // Hide models the owner does not want offered in the pickers — other tools'
  // models sharing this Ollama (an embedding model, a Discord bot's model).
  // config.llm.hidden_models is a list of name prefixes; a model is hidden if
  // its name starts with any of them, so "eleanor" catches "eleanor:latest".
  // Cosmetic and per-machine: it shapes the Chat and "Written by" selectors,
  // which both read this payload. The configured model is never hidden.
  const hidden = config.llm?.hidden_models ?? [];
  const isHidden = (name) =>
    name !== llm.model && hidden.some((h) => String(name).startsWith(h));
  const shownHealth = {
    ...health,
    installed: (health.installed ?? []).filter((n) => !isHidden(n)),
  };
  // llama-swap reports no time left, so on that backend the countdown is
  // PromptForge's own idle clock, the one that will actually do the unload.
  // Null when nothing is scheduled ("Never unload"), which the topbar shows as
  // held or hides.
  const idleLeft = llm.backend === 'llamacpp' ? idleOffload.secondsLeft() : null;
  const shownResident = (resident ?? [])
    .filter((r) => !isHidden(r.model))
    .map((r) => (idleLeft == null ? r : { ...r, expires_in_seconds: Math.round(idleLeft) }));
  const shownCatalog = catalog ? catalog.filter((c) => !isHidden(c.model)) : catalog;

  sendJSON(res, 200, {
    ok: health.ok,
    llm: { ...shownHealth, resident: shownResident, catalog: shownCatalog },
    queue: inferenceQueue.stats(),
    prompts: prompts.info(),
    tags: tags.info(),
    taggers: taggers.info(),
    models: registry.keys().length,
    auth: auth.info(),
    // Folded into status rather than given its own route: the frontend already
    // polls this every 10s, and that same poll is what keeps a person counted
    // as present. A second endpoint would be a second timer for no gain.
    presence: auth.enabled
      ? { online: auth.onlineUsers(), you: req?.user?.username ?? null }
      : { online: [], you: null },
    // What ComfyUI is making right now, for the On the GPU panel — a render
    // from here or anything started in ComfyUI directly. Null with rendering
    // off. A PromptForge render's model key becomes its label here.
    // Workflows waiting for the owner's approval, counted for the owner only,
    // so the Render section can say so instead of the uploads sitting unseen
    // in Render models.
    render_pending: comfy.enabled && isOwner(req) ? userRender.pending().length : 0,
    comfyui: await (async () => {
      const a = await comfy.activity().catch(() => null);
      if (!a?.busy || a.busy.source !== 'promptforge') return a;
      const label = a.busy.model === 'edit' && edit ? `${edit.label} edit` : registry.get(a.busy.model)?.label;
      return { ...a, busy: { ...a.busy, model: label ?? a.busy.model } };
    })(),
    training: { backend: config.training?.backend ?? 'stub', enabled: training.enabled },
    search: { enabled: Boolean(config.search?.enabled) },
    // Who may read a reference image on this box. `options` is the same
    // constant the validator enforces, so the control cannot offer a value
    // that silently will not save — the reasoning the temperature band below
    // spells out. `llm_available` is separate and is about this server rather
    // than about the setting: the instruction file has to be on disk and
    // reference_vision.describe.enabled has to be on, and when it is not the
    // panel says so instead of offering a choice that does nothing.
    reference_analysis: {
      options: REFERENCE_ANALYSIS,
      llm_available: visionTags.describeEnabled,
    },
    // Whether the LTX Director may take keyframes. Served for the same reason
    // reference_analysis.llm_available is: the reader's instruction file has
    // to be on disk, and when it is not the upload is hidden rather than
    // offered as a control that silently does nothing.
    director_keyframes: { enabled: Boolean(prompts.directorKeyframe()) },
    // Served so the slider's bounds come from the same constant the validator
    // enforces. A frontend that picked its own range would offer values the
    // server drops, and the setting would appear not to save.
    chat: { temperature_range: CHAT_TEMPERATURE_RANGE },
    // Served for the same reason the range above is: the textarea and the
    // validator must not disagree about the number.
    custom_instruction_max: CUSTOM_INSTRUCTION_MAX,
    // The languages the interface can be drawn in, from the same constant the
    // validator enforces — same reasoning as the temperature band above. A
    // frontend offering a language the server rejects would look like the
    // setting not saving.
    languages: LANGUAGES,
    // How the app may look, per person. Served from the same constants the
    // validator enforces, so a selector cannot offer a theme that silently
    // will not save — the same reasoning as the chat temperature band.
    appearance: { themes: THEMES, fonts: FONTS, text_sizes: TEXT_SIZES },
    // Whether this process is older than the code on disk. Cheap - two small
    // file reads - and it is the difference between "restart it" as a guess
    // and as a fact.
    version: version.info(),
    // How long a model stays in VRAM after a request, and the options the
    // control offers. Served rather than written into the frontend so the
    // labels and the validator cannot drift apart, which is the same reasoning
    // as the chat temperature band.
    keep_alive: {
      value: llm.getKeepAlive(),
      label: keepAliveLabel(llm.getKeepAlive()),
      overridden: runtime.isOverridden(),
      presets: KEEP_ALIVE_PRESETS,
    },
    // H3 video references are described by sampling frames with ffmpeg. When
    // it is missing the upload still works and the traits are typed by hand,
    // so the panel needs to say which of those two it is doing.
    media,
    // The stream control's options, so the labels the person reads and the
    // keys formatReferences honours cannot drift apart. Same reasoning as the
    // chat temperature band above.
    references: {
      // The loosest set, kept under its old name for the panel's default copy
      // before a model is chosen. mode_limits is what the h3 panel reads once
      // there is a mode: the Director's caps differ per mode and applying
      // REF2VA's to all of them told people a video was fine in T2VA.
      lane_limits: LANE_LIMITS,
      mode_limits: MODE_LIMITS,
      clip_seconds: CLIP_SECONDS,
      total_seconds: TOTAL_SECONDS,
      // `emits` rides along now: the Director panel's identity badges have to
      // know that a video set to V+A produces BOTH a <Video N> and an <Audio N>,
      // and that is the fact labelsFor() reads. Sent rather than assumed, for
      // the same reason the labels themselves are.
      stream_modes: Object.entries(STREAM_MODES).map(([key, m]) => ({
        key,
        label: m.label,
        emits: m.emits,
      })),
      // role -> label class, so a tile's badge says what the prompt will say.
      role_labels: ROLE_LABEL,
      // Where the Director documentation is, or null when it has not been
      // fetched. Checked per poll rather than at boot so installing it does
      // not need a restart - same reasoning as the ffmpeg report above.
      director_doc: existsSync(DIRECTOR_DOC) ? '/api/docs/h3-director' : null,
    },
    // Whether the second-pass toggle can do anything. Gated on the
    // instruction file being loaded rather than on a registry flag: the
    // feature is one prompt file and applies to every model the same way, and
    // a switch that silently does nothing is worse than no switch.
    second_pass: Boolean(prompts.secondPass()),
    uptime_seconds: Math.round(process.uptime()),
  });
}


// ───────────────────────────── auth routes ─────────────────────────────

/**
 * Whether this request arrived over TLS.
 *
 * Direct http on the tailnet it is not, and a Secure cookie would simply never
 * be sent — which is why the flag was absent outright until now. Behind
 * `tailscale serve`, which is what config/server.yaml recommends for the real
 * deployment, the app is proxied on plain http from 127.0.0.1 while the
 * browser is on https, and `x-forwarded-proto` is the only thing that says so.
 *
 * Trusted because nothing but the local proxy can reach this process: `bind`
 * is 127.0.0.1 and the tailnet is the boundary. A header like this must never
 * be trusted on a socket the internet can open — the day anything is exposed
 * beyond the tailnet, this is one of the things that has to change with it.
 */
function isSecureRequest(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https' || Boolean(req?.socket?.encrypted);
}

/**
 * One cookie definition for both setting and clearing.
 *
 * Split apart, the two drifted: a clear that omits an attribute the set used
 * writes a *different* cookie rather than removing the one that exists, and
 * the session survives a sign-out. Same attributes, one place.
 */
function sessionCookie(req, value, maxAgeSeconds) {
  return (
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}` +
    (isSecureRequest(req) ? '; Secure' : '')
  );
}

function setSessionCookie(res, token, req) {
  res.setHeader('set-cookie', [sessionCookie(req, token, auth.sessionMaxAgeSeconds)]);
}

function clearSessionCookie(res, req) {
  res.setHeader('set-cookie', [sessionCookie(req, '', 0)]);
}

/** Everything under /api/auth/. Reachable without a session, by definition. */
async function handleAuth(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    if (!auth.enabled) {
      // With auth off there is nobody to be: the frontend uses this to know
      // it must not draw a login wall.
      return sendJSON(res, 200, { auth_enabled: false, authenticated: true, user: null });
    }
    const session = auth.identify(req);
    return sendJSON(res, 200, {
      auth_enabled: true,
      authenticated: Boolean(session),
      // Tells the very first visitor that registering the owner name claims
      // the box, rather than leaving them staring at a gate nobody can open.
      owner_registered: auth.ownerExists(),
      // The owner is the only account with a password, so the form reveals a
      // password box only when the typed name matches this. Not a secret —
      // it is already visible in config and in the admin list — and the
      // server enforces the password regardless of what the form shows.
      owner: auth.ownerName || null,
      user: session ? auth.publicAccount(session.account) : null,
    });
  }

  if (!auth.enabled) {
    return sendJSON(res, 404, {
      error: 'auth_disabled',
      message: 'Accounts are disabled on this server.',
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await readBody(req, 64 * 1024);
    const account = await auth.register({
      username: body.username,
      password: body.password,
      display_name: body.display_name,
      referral: body.referral,
    });
    // Approved only in the bootstrap case where this call claimed the owner
    // account; everyone else is pending and gets no session.
    if (account.status === 'approved') {
      const { token } = await auth.login({ username: body.username, password: body.password });
      setSessionCookie(res, token, req);
    }
    return sendJSON(res, 201, { user: account });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req, 64 * 1024);
    const { account, token } = await auth.login({
      username: body.username,
      password: body.password,
    });
    setSessionCookie(res, token, req);
    return sendJSON(res, 200, { user: account });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const session = auth.identify(req);
    if (session) auth.logout(session.token);
    clearSessionCookie(res, req);
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

/**
 * /api/admin/tags/update — owner only, enforced by the caller.
 *
 * Runs scripts/update-tags.mjs as a child process rather than importing it.
 * Two reasons, both practical: node:sqlite is synchronous, so ~180,000
 * inserts plus an index build and a VACUUM would block the event loop and
 * freeze the app for everyone while it ran; and the script already exists,
 * is the documented command, and stays the single definition of what an
 * import means.
 *
 * The store's handle is closed for the duration. The script renames a freshly
 * built database over the live file, and Windows refuses to rename over an
 * open handle. Searches degrade to a message in the suggestion list while it
 * is shut — the same path a missing database already takes.
 */
let tagUpdateRunning = false;

async function handleAdminTagsUpdate(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  }
  if (tagUpdateRunning) {
    return sendJSON(res, 409, {
      error: 'already_running',
      message: 'A tag update is already running.',
    });
  }

  tagUpdateRunning = true;
  tags.close('tag database is being updated — try again in a moment');

  const started = Date.now();
  const script = path.join(ROOT, 'scripts', 'update-tags.mjs');
  const lines = [];

  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: ROOT });
      const take = (buf) => {
        // Split on newline and trim, rather than a regex: CRLF is handled by
        // the trim, and this line has no escapes to get mangled.
        for (const line of String(buf).split(String.fromCharCode(10))) {
          if (line.trim()) lines.push(line.trim());
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', reject);
      child.on('close', resolve);
    });

    // Reopen whatever is on disk now: the new database on success, and the
    // untouched old one on failure, since the script only ever replaces it
    // after everything has succeeded.
    const info = tags.reload();

    if (code !== 0) {
      return sendJSON(res, 502, {
        error: 'update_failed',
        message: lines[lines.length - 1] ?? `update-tags exited ${code}`,
        took_ms: Date.now() - started,
        log: lines,
        tags: info,
      });
    }

    return sendJSON(res, 200, {
      ok: true,
      took_ms: Date.now() - started,
      log: lines,
      tags: info,
    });
  } catch (err) {
    tags.reload();
    return sendJSON(res, 500, {
      error: 'update_failed',
      message: err.message,
      took_ms: Date.now() - started,
      log: lines,
    });
  } finally {
    tagUpdateRunning = false;
  }
}
/**
 * /api/admin/queue/move — owner only, enforced by the caller.
 *
 * Five people share one GPU and one FIFO line. Most of the time first-come is
 * exactly right, and the queue is deliberately not a priority system — but
 * "someone is three deep behind a 27B h3 generation and needs one quick
 * prompt" is a real situation on this box, and the alternative to a control
 * is asking people to stop working.
 *
 * **Owner-gated on purpose.** It is not a fairness mechanism, it is an
 * override, and an override everyone holds is just a race to click first.
 * The gate is the blanket `/api/admin/` check above, which is server-side and
 * cannot be reached by hiding a button — the same rule the rest of the admin
 * surface follows.
 *
 * Reordering never touches a running job, and never cancels anything. The
 * worst it can do is make someone wait one place longer, which the queue
 * already tells them about through the position events they are subscribed
 * to.
 */
async function handleAdminQueueMove(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'POST only.' });
  }
  const body = await readBody(req, 4 * 1024);
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return sendJSON(res, 400, { error: 'bad_id', message: 'A numeric job id is required.' });
  }

  const result = inferenceQueue.move(id, String(body.direction ?? 'up'));
  if (!result.ok) {
    // 409 for a job that moved on under them, 400 for a direction that does
    // not exist. The first is a race and the panel just refreshes; the second
    // is a caller bug.
    const status = result.code === 'bad_direction' ? 400 : 409;
    return sendJSON(res, status, { error: result.code, message: result.message });
  }
  // The new line comes back with the result, so the panel repaints from the
  // authoritative order rather than guessing what its own click did.
  return sendJSON(res, 200, { ...result, queue: inferenceQueue.stats() });
}

/**
 * /api/admin/models/keep-alive — owner only, enforced by the caller.
 *
 * Body: { value }. Accepts a preset, a bare number of minutes, or anything
 * Ollama's duration syntax covers - see parseKeepAlive, which is where the
 * "what a person is likely to type" work lives.
 *
 * Owner-gated because it is a decision about a shared card, not a personal
 * preference: setting it to "never unload" on a box that also runs ComfyUI
 * takes the GPU away from everyone else's image generation.
 *
 * Takes effect on the next request and persists across restarts. It does NOT
 * change what is loaded right now - Ollama applies keep_alive when it serves a
 * request, so shortening it does not evict anything already resident. Offload
 * is the button for that, and the panel says so.
 */
async function handleAdminKeepAlive(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'POST only.' });
  }
  const body = await readBody(req, 4 * 1024).catch(() => ({}));
  const parsed = parseKeepAlive(body.value);
  if (!parsed.ok) {
    return sendJSON(res, 400, { error: 'bad_value', message: parsed.message });
  }
  runtime.setKeepAlive(parsed.value);
  llm.setKeepAlive(parsed.value);
  console.log(`[llm] keep_alive set to ${parsed.value} (${parsed.label}) by ${whoIs(req)}`);
  return sendJSON(res, 200, { value: parsed.value, label: parsed.label });
}

/**
 * /api/admin/models/backend — owner only, enforced by the caller.
 *
 * Body: { backend?, base_url? }. Either or both may be provided; omitted
 * fields keep their current values. Switches the LLM backend live without a
 * restart. The model catalog cache is invalidated so the next poll sees the
 * new backend's models.
 */
async function handleAdminBackend(req, res) {
  const info = () => {
    const i = llm.getBackendInfo();
    return { ...i, setup_needed: !i.saved && !localLlmConfigured };
  };
  if (req.method === 'GET') {
    return sendJSON(res, 200, info());
  }
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET or POST only.' });
  }
  const body = await readBody(req, 4 * 1024).catch(() => ({}));
  const current = llm.getBackendInfo();
  const newBackend = body.backend || current.backend;
  const newBaseUrl = body.base_url || current.base_url;

  // The setup page's "Test connection": list what that server serves without
  // switching to it, so a typo never takes generation down for everyone.
  if (body.test) {
    return sendJSON(res, 200, await probeModels(newBackend, newBaseUrl));
  }

  if (!body.backend && !body.base_url && !body.model) {
    return sendJSON(res, 200, info());
  }

  const err = llm.setBackend(newBackend, newBaseUrl, body.model || null);
  if (err) {
    return sendJSON(res, 400, { error: 'bad_value', message: err });
  }

  console.log(`[llm] backend switched to ${newBackend} at ${newBaseUrl} by ${whoIs(req)}`);
  // Generation follows at once. A few things are decided once at boot from
  // the backend TYPE - the llama-swap idle-offload clock, the vision
  // cross-check's default server - so a change of type wants a restart.
  const restart = newBackend !== current.backend;
  return sendJSON(res, 200, { ...info(), restart_recommended: restart });
}

/**
 * /api/admin/benchmark — owner only, enforced by the caller.
 *
 *   GET            the run in progress (or the last one) and the models on
 *                  offer - the same list the "Written by" picker shows
 *   POST .../run   { models: [...] } start one; runs in the background
 *   POST .../cancel stop after the current generation
 */
async function handleAdminBenchmark(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/admin/benchmark') {
    const hidden = config.llm?.hidden_models ?? [];
    const catalog = (await llm.catalog().catch(() => null)) ?? [];
    const models = catalog
      .map((c) => c.model)
      .filter((m) => m === llm.model || !hidden.some((h) => String(m).startsWith(h)));
    return sendJSON(res, 200, { ...benchRunner.status(), available: models, default_model: llm.model });
  }
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET, or POST to /run or /cancel.' });
  }
  if (pathname === '/api/admin/benchmark/run') {
    const body = await readBody(req, 16 * 1024).catch(() => ({}));
    const started = benchRunner.start(Array.isArray(body.models) ? body.models : []);
    if (!started.ok) return sendJSON(res, 409, { error: 'not_started', message: started.message });
    console.log(`[benchmark] started by ${whoIs(req)} on ${body.models.length} model(s)`);
    return sendJSON(res, 200, benchRunner.status());
  }
  if (pathname === '/api/admin/benchmark/cancel') return sendJSON(res, 200, benchRunner.cancel());
  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

/**
 * /api/admin/training — the owner, or an account holding the `train` grant
 * (26 Sep 2026), enforced by the caller through ADMIN_GRANT_PREFIXES.
 *
 *   GET             /api/admin/training/status - { running, logs, images } from TrainFlow
 *   POST            /api/admin/training/start  - forwards the Settings body as-is
 *   POST            /api/admin/training/stop
 */
async function handleAdminTraining(req, res, pathname, url) {
  if (req.method === 'GET' && pathname === '/api/admin/training/status') {
    const result = await training.status();
    if (!result.ok) return sendJSON(res, result.status, { error: 'training_unavailable', message: result.message });
    return sendJSON(res, 200, result.data);
  }
  // Dataset uploads. TrainFlow has no upload route of its own - only path
  // fields naming files that are already on the box - so without this the
  // only way to get a training set there is scp, which is no answer for
  // someone working in a browser.
  if (req.method === 'GET' && pathname === '/api/admin/training/layout') {
    const result = training.layout();
    return sendJSON(res, result.status, result.data);
  }
  if (req.method === 'GET' && pathname === '/api/admin/training/output') {
    const result = training.listOutput(url.searchParams.get('slot'));
    return sendJSON(res, result.status, result.ok ? result.data : { error: 'not_found', message: result.message });
  }
  // Streamed, not buffered: a LoRA is hundreds of megabytes and reading one
  // into memory to hand it over would be a needless spike on a shared box.
  if (req.method === 'GET' && pathname === '/api/admin/training/download') {
    const target = training.outputFilePath(url.searchParams.get('slot'), url.searchParams.get('file'));
    if (!target) return sendJSON(res, 404, { error: 'not_found', message: 'No such file in that output slot.' });
    const st = statSync(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `attachment; filename="${path.basename(target).replace(/"/g, '')}"`,
      'cache-control': 'no-store',
    });
    return createReadStream(target)
      .on('error', () => res.destroy())
      .pipe(res);
  }
  if (req.method === 'GET' && pathname === '/api/admin/training/datasets') {
    const result = training.listDatasets();
    return sendJSON(res, result.status, result.ok ? result.data : { error: 'bad_request', message: result.message });
  }
  if (req.method === 'GET' && pathname === '/api/admin/training/dataset') {
    const result = training.listDataset(url.searchParams.get('name'));
    return sendJSON(res, result.status, result.ok ? result.data : { error: 'bad_request', message: result.message });
  }
  if (req.method === 'PUT' && pathname === '/api/admin/training/dataset') {
    const maxMb = config.training?.max_upload_mb ?? 64;
    let buf;
    try {
      buf = await readRawBody(req, maxMb * 1024 * 1024);
    } catch (err) {
      return sendJSON(res, err.statusCode === 413 ? 413 : 400, {
        error: 'upload_failed',
        message: err.statusCode === 413 ? `Over the ${maxMb} MB per-file limit.` : 'Could not read the upload.',
      });
    }
    const result = training.saveDatasetFile(url.searchParams.get('name'), url.searchParams.get('file'), buf);
    return sendJSON(res, result.status, result.ok ? result.data : { error: 'upload_failed', message: result.message });
  }

  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET .../status, or POST to /start or /stop.' });
  }
  if (pathname === '/api/admin/training/start') {
    const body = await readBody(req, 64 * 1024).catch(() => ({}));
    const result = await training.start(body);
    if (!result.ok) return sendJSON(res, result.status, { error: 'training_start_failed', message: result.message });
    console.log(`[training] start requested by ${whoIs(req)}: ${result.data?.message ?? ''}`);
    return sendJSON(res, 200, result.data);
  }
  if (pathname === '/api/admin/training/stop') {
    const result = await training.stop();
    if (!result.ok) return sendJSON(res, result.status, { error: 'training_stop_failed', message: result.message });
    console.log(`[training] stop requested by ${whoIs(req)}`);
    return sendJSON(res, 200, result.data);
  }
  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

/**
 * /api/admin/taggers — owner only, enforced by the caller.
 *
 *   GET                     each tagger: found or missing, where, who set it
 *   POST .../scan {folder}  search a folder for the files by name; save and
 *                           load whatever complete set turns up
 *   POST .../download {key} fetch a public WD tagger into taggers/ (runs in
 *                           the background; GET reports progress)
 */
async function handleAdminTaggers(req, res, pathname) {
  const reply = (extra = {}) => sendJSON(res, 200, { ...taggerSetup.status(taggerConfig, localTaggerKeys), ...extra });
  if (req.method === 'GET' && pathname === '/api/admin/taggers') return reply();
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET, or POST to /scan or /download.' });
  }
  const body = await readBody(req, 4 * 1024).catch(() => ({}));

  if (pathname === '/api/admin/taggers/scan') {
    const folder = String(body.folder ?? '').trim().replace(/^["']|["']$/g, '');
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
      return sendJSON(res, 400, { error: 'bad_folder', message: `"${folder}" is not a folder on this machine.` });
    }
    const { found, searched, capped } = taggerSetup.scan(folder, taggerConfig);
    // A tagger taggers.local.yaml pins is reported but never overwritten.
    const usable = Object.fromEntries(
      Object.entries(found).filter(([k]) => !localTaggerKeys.some((x) => x.startsWith(`taggers.${k}.`)))
    );
    if (Object.keys(usable).length) {
      taggerSetup.save(usable);
      reloadTaggers();
      console.log(`[taggers] found in ${folder}: ${Object.keys(usable).join(', ')} — set by ${whoIs(req)}`);
    }
    return reply({ scan: { folder, found: Object.keys(found), searched, capped } });
  }

  if (pathname === '/api/admin/taggers/download') {
    const key = String(body.key ?? '');
    if (localTaggerKeys.some((x) => x.startsWith(`taggers.${key}.`))) {
      return sendJSON(res, 409, { error: 'managed_elsewhere', message: 'That tagger is set in config/taggers.local.yaml on this machine.' });
    }
    const started = taggerSetup.startDownload(key, taggerConfig, () => {
      reloadTaggers();
      console.log(`[taggers] ${key} downloaded into taggers/`);
    });
    if (!started.ok) return sendJSON(res, 400, { error: 'bad_value', message: started.message });
    return reply();
  }

  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

/**
 * /api/admin/network — owner only, enforced by the caller.
 *
 * The "Let other devices connect" switch. GET says what is running, what is
 * saved for the next start, who decides (the switch, server.local.yaml, or
 * the environment - a container), and the addresses other devices would use.
 * POST { allow_remote } saves the choice; it takes effect at the next start.
 */
async function handleAdminNetwork(req, res) {
  const running = !['127.0.0.1', 'localhost', '::1'].includes(bind);
  const source = bindSource();
  const file = networkChoiceFile(config);
  let saved = running;
  try {
    if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')).allow_remote === true;
  } catch { /* unreadable: report the running state */ }

  if (req.method === 'POST') {
    if (source === 'environment' || source === 'local_config') {
      return sendJSON(res, 409, {
        error: 'managed_elsewhere',
        message: source === 'environment'
          ? 'This is set by the container (PROMPTFORGE_BIND in compose.yaml), not here.'
          : 'This is set in config/server.local.yaml on this machine, not here.',
      });
    }
    const body = await readBody(req, 1024).catch(() => ({}));
    if (typeof body.allow_remote !== 'boolean') {
      return sendJSON(res, 400, { error: 'bad_value', message: 'allow_remote must be true or false.' });
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ allow_remote: body.allow_remote }, null, 2));
    saved = body.allow_remote;
    console.log(`[network] other devices ${saved ? 'may' : 'may not'} connect after the next start — set by ${whoIs(req)}`);
  } else if (req.method !== 'GET') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET or POST only.' });
  }

  return sendJSON(res, 200, {
    allow_remote: running,
    saved,
    restart_needed: saved !== running,
    source,
    in_container: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
    port,
    addresses: running ? lanAddresses(port) : [],
  });
}

/**
 * /api/admin/setup/comfyui — owner only, enforced by the caller. Rendering
 * from the setup wizard and the Setup panel: GET says where it stands; POST
 * { folder } finds ComfyUI and its Python in one pasted folder, { url } uses a
 * ComfyUI that is already running, { enabled: false } switches rendering off.
 *
 * Switching it ON from off rebuilds the client at once - nothing can be
 * running or held yet. Any other change waits for a restart, because a
 * ComfyUI this server started has to be stopped by the client that started it.
 */
async function handleAdminComfySetup(req, res) {
  const source = featureSource('comfyui');
  const reply = async () => {
    const saved = source === 'setting' ? featureSetup.read('comfyui') : null;
    const now = config.comfyui ?? {};
    const restartNeeded = Boolean(saved) && (
      Boolean(saved.enabled) !== comfy.enabled ||
      (saved.enabled && ((saved.dir || '') !== (now.dir || '') || (saved.url || '') !== (now.url || '')))
    );
    return sendJSON(res, 200, {
      enabled: comfy.enabled,
      running: comfy.enabled ? await comfy.up() : false,
      dir: now.dir || '',
      url: now.url || '',
      saved: saved ? { enabled: Boolean(saved.enabled), dir: saved.dir || '', url: saved.url || '' } : null,
      source,
      restart_needed: restartNeeded,
      in_container: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
      installer_url: 'https://github.com/darksidewalker/dasiwa-comfyui-installer',
    });
  };
  if (req.method === 'GET') return reply();
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET or POST only.' });
  if (source === 'environment' || source === 'local_config') {
    return sendJSON(res, 409, { error: 'managed_elsewhere', message: 'Rendering is set in config/server.local.yaml on this machine, not here.' });
  }
  const body = await readBody(req, 4 * 1024).catch(() => ({}));
  let choice;
  if (body.enabled === false) {
    choice = { enabled: false };
  } else if (body.folder !== undefined) {
    const found = findComfy(body.folder);
    if (found.error) return sendJSON(res, 400, { error: 'not_found', message: found.error });
    choice = { enabled: true, dir: found.dir, python: found.python, url: 'http://127.0.0.1:8188' };
  } else if (body.url !== undefined) {
    const url = cleanUrl(body.url);
    if (!url) return sendJSON(res, 400, { error: 'bad_value', message: 'Enter an address like http://127.0.0.1:8188.' });
    const up = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
    if (!up) {
      return sendJSON(res, 400, {
        error: 'unreachable',
        message: `No ComfyUI answering at ${url}. Is it running? On another machine or outside this container it needs --listen.`,
      });
    }
    choice = { enabled: true, dir: '', python: '', url };
  } else {
    return sendJSON(res, 400, { error: 'bad_value', message: 'Send a folder, an address, or enabled: false.' });
  }
  featureSetup.write('comfyui', choice);
  console.log(`[setup] rendering ${choice.enabled ? `on (${choice.dir || choice.url})` : 'off'} — set by ${whoIs(req)}`);
  if (choice.enabled && !comfy.enabled) {
    config.comfyui = { ...(config.comfyui ?? {}), ...choice };
    comfy = createComfy(config, { rootDir: ROOT, dataDir: config.paths?.data ?? 'data' });
    edit = editSettings(config);
  }
  return reply();
}

/**
 * /api/admin/setup/training — owner only, enforced by the caller. LoRA
 * training through TrainFlow: POST { url } tests the address and connects it,
 * { enabled: false } disconnects. Rebuilt at once either way: the training
 * client holds no process, only an address the proxy reads per request.
 */
async function handleAdminTrainingSetup(req, res) {
  const source = featureSource('training');
  const reply = () => sendJSON(res, 200, {
    enabled: training.enabled,
    url: training.baseUrl || '',
    source,
    in_container: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
    project_url: 'https://github.com/darksidewalker/DaSiWa-TrainFlow',
  });
  if (req.method === 'GET') return reply();
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET or POST only.' });
  if (source === 'local_config') {
    return sendJSON(res, 409, { error: 'managed_elsewhere', message: 'LoRA training is set in config/server.local.yaml on this machine, not here.' });
  }
  const body = await readBody(req, 4 * 1024).catch(() => ({}));
  let choice;
  if (body.enabled === false) {
    choice = { backend: 'stub' };
  } else {
    const url = cleanUrl(body.url);
    if (!url) return sendJSON(res, 400, { error: 'bad_value', message: 'Enter an address like http://127.0.0.1:8900.' });
    const up = await fetch(url, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
    if (!up) return sendJSON(res, 400, { error: 'unreachable', message: `Nothing answering at ${url}. Is TrainFlow running?` });
    choice = { backend: 'trainflow', base_url: url };
  }
  featureSetup.write('training', choice);
  config.training = { ...(config.training ?? {}), ...choice };
  training = createTraining(ROOT, config);
  try {
    training.ensureLayout();
  } catch (err) {
    console.warn(`[training] could not create the dataset/output folders: ${err.message}`);
  }
  console.log(`[setup] LoRA training ${training.enabled ? `on (${training.baseUrl})` : 'off'} — set by ${whoIs(req)}`);
  return reply();
}

/**
 * The addresses another device would type, one per real network. Container
 * bridges, WSL and link-local addresses are left out: nobody can reach them
 * from another machine. 100.64.0.0/10 is the range NetBird and Tailscale hand
 * out, so it is labelled as the friends' address.
 */
function lanAddresses(p) {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)|vEthernet|WSL/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const [x, y] = a.address.split('.').map(Number);
      const mesh = x === 100 && y >= 64 && y <= 127;
      out.push({
        url: `http://${a.address}:${p}`,
        label: mesh ? 'Friends on your NetBird / Tailscale' : 'Other devices on your home network',
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * /api/admin/models/unload — owner only, enforced by the caller.
 *
 * Body: { model } for one, or { all: true } for everything resident.
 *
 * keep_alive is 15m on this box because ComfyUI shares the card, so "give me
 * the GPU back now" otherwise means waiting a quarter of an hour.
 *
 * The only admin route that is not owner-only. It still is by default — an
 * override everyone holds is a race to click first — but the owner can hand
 * it to a named account from the accounts panel, because a friend waiting on
 * the GPU has a real reason to press this and the owner is not always at a
 * keyboard. ADMIN_GRANTS is the map; auth's GRANTS is why it is the only one.
 *
 * Deliberately does NOT check the queue first. A model can be unloaded while a
 * generation is running - Ollama finishes the request it is serving and drops
 * the model after - and refusing on a busy card would make the button useless
 * exactly when it is wanted. The confirm in the UI carries that warning.
 */
async function handleAdminUnload(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'method_not_allowed', message: 'POST only.' });
  }
  const body = await readBody(req, 4 * 1024).catch(() => ({}));

  if (body.all === true) {
    const result = await llm.unloadAll();
    return sendJSON(res, result.ok ? 200 : 502, result);
  }

  const name = String(body.model ?? '').trim();
  if (!name) {
    return sendJSON(res, 400, { error: 'no_model', message: 'Name a model, or pass all: true.' });
  }
  const result = await llm.unload(name);
  // 502 rather than 500: the failure is the backend refusing, not this server
  // breaking, and the detail comes back verbatim so the panel can say why.
  return sendJSON(res, result.ok ? 200 : 502, result);
}

/**
 * /api/admin/requests — owner only, enforced by the caller.
 *
 * Three verbs, deliberately the same three the accounts panel has: approve,
 * deny, remove. Approve and deny settle a pending request; remove clears a
 * settled one out of the list, and refuses on a pending one, because a request
 * that vanished without an answer is indistinguishable from one the app lost.
 *
 * **Approving pulls nothing.** The spec has approval "triggering a pull", and
 * that belongs to Tab 6's installed-models surface, which is out of scope —
 * a modal that quietly starts a 17GB download onto a box five people share is
 * not the smaller version of that feature. The response carries the command to
 * run instead, and the panel shows it.
 */
async function handleAdminRequests(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/admin/requests') {
    return sendJSON(res, 200, { requests: modelRequests.list() });
  }

  const m = pathname.match(/^\/api\/admin\/requests\/([^/]+)\/([a-z]+)$/);
  if (req.method === 'POST' && m) {
    const id = decodeURIComponent(m[1]);
    const verb = m[2];
    if (verb === 'remove') {
      return modelRequests.remove(id)
        ? sendJSON(res, 200, { deleted: id })
        : sendJSON(res, 404, { error: 'not_found', message: `No request ${id}` });
    }
    const body = await readBody(req, 4 * 1024).catch(() => ({}));
    const request = modelRequests.decide(id, verb, whoIs(req), body.note);
    return sendJSON(res, 200, {
      request,
      // Named here rather than built in the frontend: the backend knows what
      // it is, and an ollama command shown on a llama.cpp box would be a
      // confident instruction that does not work.
      pull_command:
        request.status === 'approved' && llm.backend === 'ollama'
          ? `ollama pull ${request.tag}`
          : null,
    });
  }

  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

/**
 * /api/admin/usage — owner only, enforced by the caller.
 *
 * The counters, with the backend's own catalogue merged in so a model nobody
 * has ever picked shows a zero instead of being absent. That row is the whole
 * feature: an installed 17GB model with no runs is the one to delete.
 *
 * The catalogue is best-effort. `llm.catalog()` returns its last good answer
 * or null when the backend is unreachable, and a stats panel that refuses to
 * render because a poll timed out would be worse than one showing counts
 * alone — so a failure here costs the never-used rows and nothing else.
 *
 * Only what the backend is serving, unless `?all=1`. The counts include every
 * run of the test suites, which drive the real server under fixture names —
 * see the note on summary(). `all=1` is how those rows are reached to be
 * cleared, so the filter never traps a count the owner wants gone.
 *
 * POST /api/admin/usage/forget with { model } clears one row, for after the
 * weights are actually gone.
 */
async function handleAdminUsage(req, res, pathname, url) {
  if (req.method === 'GET' && pathname === '/api/admin/usage') {
    const installed = await llm.catalog().catch(() => null);
    return sendJSON(
      res,
      200,
      usageStats.summary({
        installed: installed ?? [],
        onlyInstalled: url?.searchParams.get('all') !== '1',
      })
    );
  }
  if (req.method === 'POST' && pathname === '/api/admin/usage/forget') {
    const body = await readBody(req, 4 * 1024).catch(() => ({}));
    const name = String(body.model ?? '').trim();
    if (!name) {
      return sendJSON(res, 400, { error: 'no_model', message: 'Which model?' });
    }
    return usageStats.forget(name)
      ? sendJSON(res, 200, { forgotten: name })
      : sendJSON(res, 404, { error: 'not_found', message: `No counter for ${name}` });
  }
  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

/** /api/admin/users — owner only, enforced by the caller. */
async function handleAdminUsers(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    return sendJSON(res, 200, {
      owner: auth.ownerName,
      users: auth.listAccounts().map((a) => auth.publicAccount(a)),
    });
  }

  // /api/admin/users/{username}/{action}
  const m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/([a-z]+)$/);
  if (req.method === 'POST' && m) {
    const name = decodeURIComponent(m[1]);
    // Destructive, and separated from decide() for that reason: this deletes
    // the account directory, which is also where that person's saved prompt
    // library lives. The UI says so before calling it.
    if (m[2] === 'remove') {
      return sendJSON(res, 200, auth.removeAccount(name));
    }
    // The generated password is in this response and nowhere else — it is
    // never stored, and there is no second chance to read it.
    if (m[2] === 'reset') {
      return sendJSON(res, 200, await auth.resetPassword(name, whoIs(req)));
    }
    // Body: { grant, on }. Handing out permissions is never itself delegable
    // — /api/admin/users is absent from ADMIN_GRANTS, so reaching this line
    // means the caller is the owner.
    if (m[2] === 'grant') {
      const body = await readBody(req, 4 * 1024).catch(() => ({}));
      const grant = String(body.grant ?? '').trim();
      const on = body.on !== false;
      const user = auth.setGrant(name, grant, on, whoIs(req));
      console.log(`[auth] ${on ? 'granted' : 'revoked'} ${grant} for ${name} by ${whoIs(req)}`);
      return sendJSON(res, 200, { user });
    }
    return sendJSON(res, 200, { user: auth.decide(name, m[2], whoIs(req)) });
  }

  return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
}

const MAINTENANCE_FILE = path.resolve(config.paths?.data ?? 'data', 'maintenance.txt');

/** The notice while the app is closed, or null when it is open. */
function maintenanceNotice() {
  try {
    return readFileSync(MAINTENANCE_FILE, 'utf8').trim() || 'PromptForge is closed for maintenance.';
  } catch {
    return null;
  }
}

function maintenancePage(notice) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>PromptForge - closed</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15171c;color:#e6e6e6;
font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:32rem;text-align:center}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#a8adb8;margin:0}</style></head>
<body><main><h1>${esc(notice.split('\n')[0])}</h1><p>${esc(notice.split('\n').slice(1).join(' ') || 'Check back later.')}</p></main></body></html>`;
}

async function handleRequest(req, res) {
  // Parsed under its own guard. This sat bare above the try until 11 Sep
  // 2026, and `new URL` throws on a Host header it cannot read — so one
  // request carrying `Host: [bad` became an unhandled rejection and Node
  // exited, taking every generation in flight with it. Reproduced on a
  // throwaway server that day. The Host is only used as a base for parsing
  // the path, so a bad one is a bad request, not a reason to stop.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return sendJSON(res, 400, { error: 'bad_request', message: 'Unreadable request URL or Host header.' });
  }
  const { pathname } = url;

  // Count every request for Prometheus, before the route dispatch.
  metrics.incRequests(req.method, pathname);

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return sendJSON(res, 200, { ok: true, service: 'promptforge', version: '2.0.0' });
    }

    // Closed for maintenance while data/maintenance.txt exists, 27 Sep 2026:
    // the owner asked for the app to be shut with a notice while the GPU is
    // busy overnight, reopening by itself when it is done, and for a
    // switch in the admin panel (POST /api/admin/maintenance). The file's text
    // is the notice; an overnight script can write and remove it too. Checked
    // per request, so neither direction needs a restart. /health stays up
    // above, so monitoring does not read this as an outage.
    //
    // The owner is let through, or there would be no way back to the switch.
    // What is closed is the page and the API: sign-in stays open, and so do
    // the static assets and /?owner, so a signed-out owner can still reach
    // the login screen. Anyone else signing in that way meets the API refusal.
    const notice = maintenanceNotice();
    const closedPath =
      (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) ||
      ((pathname === '/' || pathname === '/index.html') && !url.searchParams.has('owner'));
    const ownerHere = () => (auth.enabled ? Boolean(auth.identify(req)?.account?.is_owner) : isOwner(req));
    if (notice && closedPath && !ownerHere()) {
      if (pathname.startsWith('/api/')) {
        return sendJSON(res, 503, { error: 'maintenance', message: notice });
      }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '3600', 'cache-control': 'no-store' });
      return res.end(maintenancePage(notice));
    }

    // Sign-in, registration and "who am I" are the only API routes reachable
    // without a session — everything else below the gate needs one.
    if (pathname.startsWith('/api/auth/')) {
      return await handleAuth(req, res, pathname);
    }

    // ── the gate ──
    //
    // The owner asked for the whole app behind login, so this is a blanket
    // refusal on /api/ rather than a check bolted onto the handful of routes
    // that touch user data. A route added later is gated by default, which is
    // the correct direction for that mistake to fail in.
    //
    // Static files are deliberately NOT gated: the login screen is served by
    // the same index.html as the app, and it cannot render without its own
    // CSS and JS. The API is the boundary, not the asset list.
    if (auth.enabled && pathname.startsWith('/api/')) {
      const session = auth.identify(req);
      if (!session) {
        return sendJSON(res, 401, {
          error: 'unauthenticated',
          message: 'Sign in to use PromptForge.',
        });
      }
      req.user = session.account;
    }

    // Grafana, passed through for the OWNER only (22 Sep 2026, the owner's
    // call: monitoring is admin information). Not under /api/, so the gate
    // above does not cover it and it checks the session itself. Grafana runs
    // with anonymous view-only access, which is safe only because this is the
    // one way to it from off the machine - compose binds its own port to
    // 127.0.0.1.
    // TrainFlow, on the same terms as Grafana below: not under /api/, because
    // it serves raw HTML/CSS/JS rather than JSON, so the admin gate does not
    // cover it and the session is checked here. The owner, or an account
    // holding the `train` grant (26 Sep 2026) - see mayTrain. TrainFlow takes
    // any path on the box, so grant it only once TrainFlow runs as a user that
    // cannot reach anything else.
    if (pathname === '/trainflow' || pathname.startsWith('/trainflow/')) {
      if (auth.enabled) {
        const session = auth.identify(req);
        if (!session) return sendJSON(res, 401, { error: 'unauthenticated', message: 'Sign in to use PromptForge.' });
        req.user = session.account;
      }
      if (!mayTrain(req)) {
        return sendJSON(res, 403, { error: 'forbidden', message: 'LoRA training needs the "train" permission, which the owner grants per account.' });
      }
      // The iframe's src carries the trailing slash so that the document's
      // relative src/href resolve inside /trainflow/; a bare /trainflow typed
      // by hand would otherwise resolve them against the site root.
      if (pathname === '/trainflow') {
        res.writeHead(302, { location: '/trainflow/' });
        return res.end();
      }
      return await handleTrainflowProxy(req, res, url);
    }

    if (pathname === '/grafana' || pathname.startsWith('/grafana/')) {
      if (auth.enabled) {
        const session = auth.identify(req);
        if (!session) return sendJSON(res, 401, { error: 'unauthenticated', message: 'Sign in to use PromptForge.' });
        req.user = session.account;
      }
      if (!isOwner(req)) {
        return sendJSON(res, 403, { error: 'forbidden', message: 'Monitoring is for the owner of this server.' });
      }
      return await handleGrafanaProxy(req, res, url);
    }

    // Everything about your own account. Deliberately not under /api/auth/,
    // which is exempt from the gate above — these all require a session.
    if (pathname === '/api/account' && (req.method === 'GET' || req.method === 'POST')) {
      const who = whoIs(req);
      if (req.method === 'POST') {
        const body = await readBody(req, 64 * 1024);
        if (body.display_name !== undefined && auth.enabled) {
          auth.updateDisplayName(who, body.display_name);
        }
        if (body.preferences && typeof body.preferences === 'object') {
          storage.setPrefs(
            who,
            // Live, so a preference naming a model or tagger that has since
            // been removed from config is refused rather than stored.
            await validatePreferences(body.preferences, { registry, taggers, llm })
          );
        }
      }
      return sendJSON(res, 200, {
        user: auth.enabled ? auth.publicAccount(auth.readAccount(who)) : { username: who },
        preferences: storage.getPrefs(who),
      });
    }

    if (req.method === 'POST' && pathname === '/api/account/password') {
      if (!auth.enabled) {
        return sendJSON(res, 404, {
          error: 'auth_disabled',
          message: 'Accounts are disabled on this server.',
        });
      }
      const body = await readBody(req, 64 * 1024);
      const { user, token } = await auth.changePassword(whoIs(req), {
        current_password: body.current_password,
        new_password: body.new_password,
      });
      setSessionCookie(res, token, req);
      return sendJSON(res, 200, { user });
    }

    if (pathname.startsWith('/api/admin/')) {
      if (!mayAdmin(req, pathname)) {
        const needed = grantFor(pathname);
        return sendJSON(res, 403, {
          error: 'forbidden',
          // Naming the permission matters: "restricted to the owner" is a
          // dead end, "you have not been given this" is something the person
          // can act on by asking.
          message: needed
            ? `That needs the "${needed}" permission, which the owner grants per account.`
            : 'The admin surface is restricted to the owner.',
        });
      }
      if (pathname.startsWith('/api/admin/users')) {
        return await handleAdminUsers(req, res, pathname);
      }
      // The maintenance switch. Owner-only: absent from ADMIN_GRANTS.
      if (pathname === '/api/admin/maintenance') {
        if (req.method === 'POST') {
          const body = await readBody(req, 4 * 1024);
          if (body.on) writeFileSync(MAINTENANCE_FILE, `${String(body.message ?? '').trim() || 'Currently training model'}\n`);
          else rmSync(MAINTENANCE_FILE, { force: true });
        }
        return sendJSON(res, 200, { on: maintenanceNotice() != null, message: maintenanceNotice() });
      }
      if (pathname === '/api/admin/tags/update') {
        return await handleAdminTagsUpdate(req, res);
      }
      if (pathname === '/api/admin/queue/move') {
        return await handleAdminQueueMove(req, res);
      }
      if (pathname.startsWith('/api/admin/requests')) {
        return await handleAdminRequests(req, res, pathname);
      }
      if (pathname.startsWith('/api/admin/usage')) {
        return await handleAdminUsage(req, res, pathname, url);
      }
      if (pathname === '/api/admin/models/unload') {
        return await handleAdminUnload(req, res);
      }
      if (pathname === '/api/admin/models/keep-alive') {
        return await handleAdminKeepAlive(req, res);
      }
      if (pathname === '/api/admin/benchmark' || pathname.startsWith('/api/admin/benchmark/')) {
        return await handleAdminBenchmark(req, res, pathname);
      }
      if (pathname.startsWith('/api/admin/training/')) {
        return await handleAdminTraining(req, res, pathname, url);
      }
      if (pathname === '/api/admin/taggers' || pathname.startsWith('/api/admin/taggers/')) {
        return await handleAdminTaggers(req, res, pathname);
      }
      if (pathname === '/api/admin/network') {
        return await handleAdminNetwork(req, res);
      }
      if (pathname === '/api/admin/setup/comfyui') {
        return await handleAdminComfySetup(req, res);
      }
      if (pathname === '/api/admin/setup/training') {
        return await handleAdminTrainingSetup(req, res);
      }
      if (pathname === '/api/admin/models/backend') {
        return await handleAdminBackend(req, res);
      }
      if (pathname === '/api/admin/render' || pathname.startsWith('/api/admin/render/')) {
        return await handleAdminRender(req, res, pathname);
      }
      return sendJSON(res, 404, { error: 'not_found', message: `No route for ${pathname}` });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      return await handleStatus(res, req);
    }
    if (req.method === 'GET' && pathname === '/api/models') {
      return sendJSON(res, 200, registry.toPublic());
    }

    // Host usage for the strip across the top. Its own route rather than a
    // field on /api/status, because it wants a 2s cadence and the status poll
    // wants 10s — folding them together would mean either a sluggish readout
    // or five times the backend polling for everything else.
    if (req.method === 'GET' && pathname === '/api/system') {
      const reading = await sysmon.read();
      return sendJSON(res, 200, reading ?? { disabled: true });
    }

    // The brief randomizer. Signed-in, not owner-gated — it is a writing aid,
    // and it reads a config file and a tag database that everyone's
    // autocomplete already reads.
    if (req.method === 'GET' && pathname === '/api/randomizer/categories') {
      const out = await randomizer.categories();
      return sendJSON(res, out.ok ? 200 : 503, out);
    }
    if (req.method === 'POST' && pathname === '/api/randomizer/roll') {
      const body = await readBody(req, 8 * 1024).catch(() => ({}));
      const out = await randomizer.roll(body.categories, {
        seed: Number.isInteger(body.seed) ? body.seed : null,
        // Chosen, not drawn — see CAST_WOMEN in scripts/randomizer.py.
        women: Number(body.women) || 0,
        men: Number(body.men) || 0,
        // Picks the categories as well as the terms — see SURPRISE_PLAN.
        surprise: body.surprise === true,
        limits: body.limits && typeof body.limits === 'object' ? body.limits : null,
        howMany: Number(body.count) || 0,
      });
      // 400 on a bad ask, 503 when the script itself could not run — the panel
      // says "fix your selection" for one and "tell the owner" for the other.
      return sendJSON(res, out.ok ? 200 : /categor/i.test(out.message ?? '') ? 400 : 503, out);
    }
    // What ComfyUI wrote inside the picture - prompt, checkpoint, LoRAs,
    // seed, sampler - for Image Analysis, the same reader the pinboard uses
    // (server/comfymeta.mjs). Sent the ORIGINAL file: a crop is re-encoded,
    // and re-encoding is exactly what strips this. { found: false } for any
    // picture without it, which is most of them and not an error.
    if (req.method === 'POST' && pathname === '/api/analyze/meta') {
      const limits = taggers.info().limits;
      let buf;
      try {
        buf = await readRawBody(req, (limits.max_image_mb ?? 20) * 1024 * 1024);
      } catch {
        return sendJSON(res, 413, { error: 'too_large', message: `Over the ${limits.max_image_mb} MB limit.` });
      }
      const meta = readComfyMetadata(buf);
      return sendJSON(res, 200, meta ? { found: true, ...meta } : { found: false });
    }
    if (req.method === 'POST' && pathname === '/api/analyze/describe') {
      return await handleAnalyzeDescribe(req, res, url);
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      return await handleAnalyze(req, res, url);
    }
    if (req.method === 'POST' && pathname === '/api/references/analyze') {
      return await handleReferenceAnalysis(req, res, url);
    }
    // The read-back. Streams prose for a person to check, and shares nothing
    // with the route above but the upload shape — that one produces tags.
    if (req.method === 'POST' && pathname === '/api/references/readback') {
      return await handleReferenceReadback(req, res, url);
    }
    // Not owner-gated: anyone about to use the app has a reason to warm it,
    // and it costs a model load that the next generate would have paid anyway.
    //
    // Resolved through chooseModel, the same three-source rule generate
    // follows, because warming anything else is worse than not warming. This
    // route used to call warmup() bare, which loaded llm.model — the
    // deployment default — no matter which model was selected. On a box whose
    // default is a 9B and whose picker is usually on a 27B, pressing Warm up
    // loaded the wrong model and took VRAM the right one then had to fight
    // for. The button reported success, so nothing said otherwise.
    //
    // context_length rides along for the same reason: num_ctx is set at load
    // time, so warming h3 at the global context would make the first real
    // request reload it anyway.
    if (req.method === 'POST' && pathname === '/api/warmup') {
      const body = await readBody(req, 4 * 1024).catch(() => ({}));
      const entry = body?.model ? registry.get(body.model) : null;
      const warmed = await llm.warmup({
        model: chooseModel(entry, storage.getPrefs(whoIs(req))),
        contextLength: entry?.context_length,
      });
      // A warm-up loads a model outside the queue, so it restarts the idle
      // clock itself; otherwise a model warmed after a long idle would be
      // unloaded on the very next tick.
      idleOffload?.touch();
      return sendJSON(res, 200, warmed);
    }
    if (req.method === 'GET' && pathname === '/api/taggers') {
      return sendJSON(res, 200, taggers.info());
    }
    // The Caption view's Style dropdown. Read per request rather than at boot:
    // it is a few lines, and an edit to the file shows without a restart.
    if (req.method === 'GET' && pathname === '/api/caption/styles') {
      try {
        return sendJSON(res, 200, { styles: publicStyles(loadCaptionStyles(ROOT)), types: publicLoraTypes(loadLoraTypes(ROOT)) });
      } catch (err) {
        return sendJSON(res, 500, { error: 'caption_styles', message: `config/captions.yaml could not be read: ${err.message}` });
      }
    }
    if (req.method === 'POST' && pathname === '/api/caption') {
      return await handleCaption(req, res, url);
    }
    if (req.method === 'POST' && pathname === '/api/moss/assist') {
      return await handleMossAssist(req, res);
    }
    if (pathname === '/api/render' || pathname.startsWith('/api/render/')) {
      return await handleRender(req, res, pathname, url);
    }
    if (pathname === '/api/edit' || pathname.startsWith('/api/edit/')) {
      return await handleEdit(req, res, pathname);
    }

    if (req.method === 'POST' && pathname === '/api/generate') {
      return await handleGenerate(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/references/scan') {
      return await handleReferenceScan(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/tags/search') {
      const q = url.searchParams.get('q') ?? '';
      // Variant follows the model's tag_style: Illustrious wants underscores,
      // Pony, SDXL and Anima want the spaced form. `space` is served out of
      // the underscore rows — see the note in tags.mjs for why it must not
      // come from the dash list.
      //
      // **A model with no tag_style gets `space`, not `dash`.** It used to get
      // dash, on the reasoning that "models with no tag_style are the prose
      // ones, which have no tag field to autocomplete into" — true until
      // 22 Aug 2026, when the tag builder went onto every image model. Krea2
      // and Flux declare no tag_style, so the old fallback would have served
      // them the dash list the project deliberately moved off on 20 Aug, and
      // the spelling would have disagreed with tagForModel(), which spaces
      // underscores for exactly these models. Tab 3 and the tag search
      // agreeing on spelling is a property with tests behind it.
      const modelKey = url.searchParams.get('model');
      const model = modelKey ? registry.get(modelKey) : null;
      const variant =
        url.searchParams.get('variant') ??
        (model?.tag_style === 'underscore' ? 'underscore' : model ? 'space' : undefined);
      const categoryParam = url.searchParams.get('category');
      const out = tags.search(q, {
        ...(variant ? { variant } : {}),
        category: categoryParam != null && categoryParam !== '' ? Number(categoryParam) : null,
        limit: Math.min(Number(url.searchParams.get('limit')) || 20, 100),
      });
      return sendJSON(res, out.ok ? 200 : 503, out);
    }
    // Character traits, derived from danbooru rather than from the model's
    // memory — see server/traits.mjs for why that distinction is load-bearing.
    // A miss costs one request upstream; everything after is served from cache.
    //
    // Tag style follows the model, like every other tag this app hands out:
    // Illustrious gets purple_hair, Pony and SDXL get purple hair. `raw` keeps
    // the underscore form, because that is the cache key and the danbooru
    // spelling, and the frontend needs it to de-duplicate against pills.
    if (req.method === 'GET' && pathname === '/api/traits') {
      const character = url.searchParams.get('character') ?? '';
      const modelKey = url.searchParams.get('model');
      const model = modelKey ? registry.get(modelKey) : null;
      const out = await traits.lookup(character, tags, {
        refresh: url.searchParams.get('refresh') === '1',
      });
      const underscored = model?.tag_style === 'underscore';
      return sendJSON(res, 200, {
        ...out,
        traits: out.traits.map((t) => ({
          ...t,
          tag: underscored ? t.tag : t.tag.replace(/_/g, ' '),
          raw: t.tag,
        })),
        // Candidates for a name that found nothing — `makima` against
        // `makima_(chainsaw_man)`. Spelled for the model like the traits are,
        // and carrying the raw form, because that is what a follow-up lookup
        // has to be keyed on.
        suggestions: (out.suggestions ?? []).map((s) => ({
          ...s,
          tag: underscored ? s.tag : s.tag.replace(/_/g, ' '),
          raw: s.tag,
        })),
      });
    }

    if (req.method === 'GET' && pathname === '/api/tags/info') {
      return sendJSON(res, 200, tags.info());
    }

    // ── chat ──
    if (pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }
    if (pathname === '/api/chat/history' && req.method === 'GET') {
      const user = whoIs(req);
      return sendJSON(res, 200, {
        user,
        chats: storage.listChats(user),
        // The client shows the policy rather than making people find out by
        // losing something. 0 means the sweep is off.
        retention_days: config.chats?.retention_days ?? 0,
        // Whether to offer the Search button at all, and what it would use.
        search: search.info(),
      });
    }
    // ── model requests ──
    //
    // Anyone can ask; only the owner decides, on /api/admin/requests below.
    // The list here is your own requests and nobody else's — it exists so the
    // form can tell you what happened to the last thing you asked for, which
    // is the difference between a feature and a suggestion box with no lid.
    if (pathname === '/api/model-requests') {
      const user = whoIs(req);
      if (req.method === 'GET') {
        return sendJSON(res, 200, {
          requests: modelRequests.listFor(user),
          // Everything already pulled, so the form can say "you have that
          // one" instead of routing a pointless request to the owner.
          installed: (await llm.health())?.installed ?? [],
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req, 8 * 1024);
        // Throws with a statusCode for a bad tag, a bad link or a duplicate;
        // the outer handler turns those into answers rather than crashes.
        return sendJSON(res, 201, { request: modelRequests.create(user, body) });
      }
      return sendJSON(res, 405, { error: 'method_not_allowed', message: 'GET or POST.' });
    }

    // Rename and pin (26 Sep 2026), from the sidebar's right-click menu. Same
    // shape as lock below: POST, a tiny body, the person's own chats only.
    {
      const m = pathname.match(/^\/api\/chat\/([^/]+)\/(rename|pin)$/);
      if (m && req.method === 'POST') {
        const user = whoIs(req);
        try {
          const body = await readBody(req, 4 * 1024);
          const chat = m[2] === 'rename'
            ? storage.renameChat(user, m[1], body.title)
            : storage.setChatPinned(user, m[1], body.pinned !== false);
          return sendJSON(res, 200, { id: chat.id, title: chat.title, pinned: Boolean(chat.pinned) });
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: `${m[2]}_failed`, message: err.message });
        }
      }
    }

    // Lock or unlock, which is the exemption from the retention sweep.
    // POST rather than PATCH to match everything else here.
    {
      const lock = pathname.match(/^\/api\/chat\/([^/]+)\/lock$/);
      if (lock && req.method === 'POST') {
        const user = whoIs(req);
        try {
          const body = await readBody(req, 4 * 1024);
          const chat = storage.setChatLocked(user, lock[1], body.locked !== false);
          return sendJSON(res, 200, { id: chat.id, locked: chat.locked });
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, {
            error: 'lock_failed',
            message: err.message,
          });
        }
      }
    }
    // A picture a conversation made (an edit), to whoever's conversation it is.
    {
      const pic = pathname.match(/^\/api\/chat\/([^/]+)\/pictures\/(p_[a-f0-9]{24})\.png$/);
      if (pic && req.method === 'GET') {
        const file = storage.chatPicturePath(whoIs(req), pic[1], pic[2]);
        if (!file) return sendJSON(res, 404, { error: 'not_found', message: 'That picture is gone with its conversation.' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' });
        return createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }
    }
    if (pathname.startsWith('/api/chat/')) {
      const user = whoIs(req);
      const id = pathname.slice('/api/chat/'.length);
      if (req.method === 'GET') {
        const chat = storage.getChat(user, id);
        return chat
          ? sendJSON(res, 200, chat)
          : sendJSON(res, 404, { error: 'not_found', message: `No conversation ${id}` });
      }
      if (req.method === 'DELETE') {
        try {
          chatPictures.drop(user, id);
          return storage.deleteChat(user, id)
            ? sendJSON(res, 200, { deleted: id })
            : sendJSON(res, 404, { error: 'not_found', message: `No conversation ${id}` });
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 500, { error: 'delete_failed', message: err.message });
        }
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }

    // ── shared notes on the installed LLMs ──
    //
    // Not per-user, unlike the library directly below. Everyone reads the
    // same board and everyone may post to it, because the point is that a
    // note about what a model is good at reaches the other four.
    //
    // Deletion is narrower than posting: your own note, or anything if you
    // are the owner. Same shape as every other destructive route here.
    // Editing (11 Sep 2026) follows the delete rule, not the posting one.
    if (pathname === '/api/llm-notes' || pathname.startsWith('/api/llm-notes/')) {
      const user = whoIs(req);

      if (req.method === 'GET' && pathname === '/api/llm-notes') {
        return sendJSON(res, 200, { notes: storage.listLlmNotes() });
      }

      if (req.method === 'POST' && pathname === '/api/llm-notes') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
        }
        try {
          const entry = storage.addLlmNote(body.model, user, body.text);
          return sendJSON(res, 200, { model: String(body.model), entry });
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'note_failed', message: err.message });
        }
      }

      if (req.method === 'PATCH' && pathname.startsWith('/api/llm-notes/')) {
        // Same address as DELETE below: /api/llm-notes/<note id>?model=<tag>.
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'bad_request', message: err.message });
        }
        const id = pathname.slice('/api/llm-notes/'.length);
        const model = url.searchParams.get('model') ?? '';
        const result = storage.editLlmNote(model, id, body.text, {
          requester: user,
          isOwner: isOwner(req),
        });
        if (result.ok) return sendJSON(res, 200, { model, entry: result.entry });
        if (result.code === 400) {
          return sendJSON(res, 400, { error: 'note_failed', message: result.message });
        }
        return result.code === 403
          ? sendJSON(res, 403, {
              error: 'not_yours',
              message: 'You can only edit your own notes.',
            })
          : sendJSON(res, 404, { error: 'not_found', message: `No note ${id}` });
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/llm-notes/')) {
        // /api/llm-notes/<note id>?model=<tag>. The model rides in the query
        // rather than the path because a tag like
        // hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL contains slashes, and
        // splitting a path on them would cut it in three.
        const id = pathname.slice('/api/llm-notes/'.length);
        const model = url.searchParams.get('model') ?? '';
        const result = storage.deleteLlmNote(model, id, {
          requester: user,
          isOwner: isOwner(req),
        });
        if (result.ok) return sendJSON(res, 200, { deleted: id });
        return result.code === 403
          ? sendJSON(res, 403, {
              error: 'not_yours',
              message: 'You can only delete your own notes.',
            })
          : sendJSON(res, 404, { error: 'not_found', message: `No note ${id}` });
      }

      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    // ── prompt library, per user ──
    if (pathname === '/api/library' || pathname.startsWith('/api/library/')) {
      const user = whoIs(req);
      const id = pathname.startsWith('/api/library/') ? pathname.slice('/api/library/'.length) : null;

      if (req.method === 'GET' && !id) {
        return sendJSON(res, 200, { user, entries: storage.listLibrary(user) });
      }
      if (req.method === 'GET' && id) {
        const entry = storage.getLibraryEntry(user, id);
        return entry
          ? sendJSON(res, 200, entry)
          : sendJSON(res, 404, { error: 'not_found', message: `No library entry ${id}` });
      }
      if (req.method === 'POST' && !id) {
        try {
          return sendJSON(res, 201, storage.saveLibraryEntry(user, await readBody(req)));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'save_failed', message: err.message });
        }
      }
      if (req.method === 'DELETE' && id) {
        try {
          return storage.deleteLibraryEntry(user, id)
            ? sendJSON(res, 200, { deleted: id })
            : sendJSON(res, 404, { error: 'not_found', message: `No library entry ${id}` });
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 500, { error: 'delete_failed', message: err.message });
        }
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    // ── system prompts people write themselves ──
    //
    // Readable and writable by anyone signed in: a block is visible to the
    // group as soon as it exists, which is the point of it. Editing is the
    // author's alone — the owner is deliberately not exempted, because
    // rewriting the instructions somebody is generating against is not
    // housekeeping. Deleting follows the usual author-or-owner rule.
    if (pathname === '/api/system-prompts' || pathname.startsWith('/api/system-prompts/')) {
      const user = whoIs(req);
      const rest = pathname.startsWith('/api/system-prompts/')
        ? pathname.slice('/api/system-prompts/'.length)
        : '';
      const [id, action] = rest.split('/');

      if (req.method === 'GET' && !id) {
        // ?shipped=<model> hands back the prompt this repo ships for that
        // model, composed exactly as a generation would see it. It is what
        // makes "start from the shipped prompt" possible, and it is the
        // honest way to write a replacement: read the thing you are replacing.
        const shipped = url.searchParams.get('shipped');
        if (shipped) {
          const body = prompts.get(shipped);
          return body
            ? sendJSON(res, 200, { model: shipped, body })
            : sendJSON(res, 404, { error: 'not_found', message: `No prompt for ${shipped}` });
        }
        return sendJSON(res, 200, { user, entries: storage.listSystemPrompts() });
      }
      if (req.method === 'GET' && id) {
        const found = storage.getSystemPrompt(id);
        return found
          ? sendJSON(res, 200, found)
          : sendJSON(res, 404, { error: 'not_found', message: `No system prompt ${id}` });
      }
      if (req.method === 'POST' && !id) {
        try {
          const body = await readBody(req);
          // Registry keys only, and at least one. `model` singular is still
          // accepted so an older client — or a hand-rolled request written
          // against yesterday's shape — does not silently save a block that
          // is for no model at all.
          const known = new Set(registry.keys());
          const asked = Array.isArray(body.models)
            ? body.models
            : body.model ? [body.model] : [];
          const models = [...new Set(asked.filter((k) => known.has(k)))];
          if (!models.length) {
            return sendJSON(res, 400, {
              error: 'unknown_model',
              message: `Name at least one model this prompt is for. Known: ${registry.keys().join(', ')}`,
            });
          }
          return sendJSON(res, 201, storage.saveSystemPrompt(user, { ...body, models }));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'save_failed', message: err.message });
        }
      }
      // Default and archive (26 Sep 2026): housekeeping on the group's list,
      // so the owner's alone. Body: { archived?: bool } or
      // { default_for: <model key>, default: bool }.
      if (req.method === 'POST' && id && action === 'flags') {
        if (!isOwner(req)) {
          return sendJSON(res, 403, { error: 'forbidden', message: 'Only the owner sets the default or archives prompts.' });
        }
        try {
          const body = await readBody(req, 4 * 1024);
          const defaultFor = body.default_for ? String(body.default_for) : null;
          if (defaultFor && !registry.keys().includes(defaultFor)) {
            return sendJSON(res, 400, { error: 'unknown_model', message: `No model ${defaultFor}.` });
          }
          return sendJSON(res, 200, storage.setSystemPromptFlags(id, {
            archived: typeof body.archived === 'boolean' ? body.archived : undefined,
            defaultFor,
            isDefault: body.default !== false,
          }));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'flags_failed', message: err.message });
        }
      }
      if (req.method === 'POST' && id && action === 'copy') {
        try {
          return sendJSON(res, 201, storage.copySystemPrompt(user, id));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'copy_failed', message: err.message });
        }
      }
      if (req.method === 'DELETE' && id) {
        const out = storage.deleteSystemPrompt(id, { requester: user, isOwner: isOwner(req) });
        if (out.ok) return sendJSON(res, 200, { deleted: id });
        return out.code === 403
          ? sendJSON(res, 403, {
              error: 'forbidden',
              message: 'Only the person who wrote it, or the owner, can delete it.',
            })
          : sendJSON(res, 404, { error: 'not_found', message: `No system prompt ${id}` });
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }
    if (req.method === 'POST' && pathname === '/api/prompts/reload') {
      // Owner-gated like every mutating admin route.
      if (!isOwner(req)) {
        return sendJSON(res, 403, {
          error: 'forbidden',
          message: 'Prompt reload is restricted to the owner.',
        });
      }
      // The keyframe readings go with them. They are the output of
      // director-keyframe.md, so a reload that left them in place would
      // answer the next run with readings from the instruction that was just
      // replaced — see the note on keyframeCache.
      const cleared = keyframeCache.clear() + pictureCache.clear();
      const result = prompts.reload();
      if (cleared) console.log(`[keyframe] dropped ${cleared} cached reading(s) on reload`);
      return sendJSON(res, 200, { ...result, keyframes_cleared: cleared });
    }
    // The Director documentation, read off this box.
    //
    // The h3 panel's ? button used to point at GitHub. Owner's call, 4 Sep
    // 2026: nothing in the UI should send anyone off the tailnet. This is one
    // named file, resolved from a constant rather than from the URL, so there
    // is no path to traverse.
    //
    // Absent is the normal state until someone runs `npm run fetch-h3-refs`.
    // The panel hides the button when the settings payload says it is not
    // here, so this 404 is a fallback rather than something a person can click
    // into. Third-party and gitignored, like the MiniMax guides are meant to
    // be: pulled locally to read, not redistributed.
    // The benchmark sheets. Two routes: the index, and one rendered sheet.
    //
    // The id never reaches the filesystem — server/benchmarks.mjs looks it up
    // in a constant table — which is what makes this incapable of traversal,
    // the same argument DIRECTOR_DOC makes below. A docs/ scan would have
    // served the handoffs and the security plan too.
    // ── the shared image library ──────────────────────────────────────────
    //
    // A picture and the prompt that made it, uploaded by anybody and visible
    // to everybody the moment it lands — the same no-publish-step deal as
    // system prompt blocks above. See server/sharedimages.mjs.
    //
    // The upload is JSON with a data URI rather than raw bytes like
    // /api/analyze, because an entry is a PAIR: sending the picture and its
    // prompt in one request means there is no state where the image arrived
    // and the prompt did not. The 33% base64 inflation buys that, and
    // generation already ships reference pictures this way.
    //
    // Note what is NOT here: no downscale. /api/analyze takes a 1024px JPEG
    // because every pixel past that is prefill nobody pays for twice, and
    // this is the opposite case — the library holds the picture somebody
    // actually made, and the folder is meant to be usable as a training
    // dataset directly.
    if (pathname === '/api/shared-images' || pathname.startsWith('/api/shared-images/')) {
      const user = whoIs(req);
      const rest = pathname.startsWith('/api/shared-images/')
        ? pathname.slice('/api/shared-images/'.length)
        : '';
      const [name, action] = rest.split('/');
      const limits = taggers.info().limits;
      const maxMb = limits.max_image_mb ?? 20;

      // Which model made the picture, as a registry key or nothing at all.
      //
      // Image models only — the board holds pictures, and "which model made
      // this" is not a question h3 or ltx answers. Taken from the registry
      // rather than a list written here, for the reason CLAUDE.md gives about
      // the frontend: adding a model is meant to be one registry entry and
      // one prompt file, and a second place that names them is a second place
      // to forget.
      //
      // An unknown key is dropped rather than refused. Somebody's picture
      // should not bounce because a model was renamed under them, and the
      // field is optional in the first place.
      const modelKeyOrNull = (v) => {
        const key = String(v ?? '').trim();
        return key && registry.byType('image').some((m) => m.key === key) ? key : null;
      };

      // Whether this person may change a given entry. Computed here because
      // it needs the owner gate, which the store deliberately knows nothing
      // about — and sent per row so the browser never has to work out the
      // rule for itself and get it subtly different.
      const withRights = (entry) => ({
        ...entry,
        can_edit: isOwner(req) || (entry.author !== null && entry.author === user),
      });

      if (req.method === 'GET' && !name) {
        // `dir` is deliberately not forwarded. info() reports it for the boot
        // log, and the browser has no use for an absolute path on the server
        // — this project already took one document out of its history for
        // describing the deployment.
        const { accepted_types, text_max } = sharedImages.info();
        return sendJSON(res, 200, {
          user,
          limits: { max_image_mb: maxMb, accepted_types, text_max },
          entries: sharedImages.list().map(withRights),
        });
      }

      // The picture itself. Streamed rather than base64'd into the listing:
      // a grid of thirty entries would otherwise be one enormous JSON body,
      // and <img src> is what the browser is good at.
      if (req.method === 'GET' && name && action === 'file') {
        const found = sharedImages.fileFor(name);
        if (!found) return sendJSON(res, 404, { error: 'not_found', message: `No shared image ${name}` });
        res.writeHead(200, {
          'content-type': found.type,
          // The bytes at a given name never change — updateText rewrites the
          // .txt beside it and nothing rewrites the picture — so this is
          // cacheable. Deleting and re-uploading produces a new name.
          'cache-control': 'private, max-age=3600',
        });
        return createReadStream(found.file)
          .on('error', () => res.destroy())
          .pipe(res);
      }

      if (req.method === 'GET' && name) {
        const found = sharedImages.get(name);
        return found
          ? sendJSON(res, 200, withRights(found))
          : sendJSON(res, 404, { error: 'not_found', message: `No shared image ${name}` });
      }

      // Read a file's ComfyUI data WITHOUT storing anything, so the upload
      // form can fill itself in the way Civitai's does — pick the picture,
      // the prompt and the settings appear, you edit them and then save.
      //
      // The browser sends only the front of the file. ComfyUI's text chunks
      // sit before the pixels, so a slice is enough, and asking somebody to
      // upload 20MB twice — once to look, once to keep — for six numbers is
      // the round trip this avoids.
      if (req.method === 'POST' && name === 'inspect') {
        try {
          const body = await readBody(req, 4 * 1024 * 1024);
          const match = /^data:([a-z0-9/+.-]+);base64,(.*)$/is.exec(String(body.image ?? ''));
          if (!match) return sendJSON(res, 400, { error: 'no_image', message: 'Nothing to read.' });
          // Null for most pictures, and that is not an error — a JPEG or a
          // screenshot simply has nothing in it. 200 either way.
          return sendJSON(res, 200, {
            comfy: readComfyMetadata(Buffer.from(match[2], 'base64')),
          });
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, { error: 'unreadable', message: err.message });
        }
      }

      if (req.method === 'POST' && !name) {
        try {
          // Headroom for base64 over the image cap, plus the prompt text.
          const body = await readBody(req, Math.ceil(maxMb * 1.4 * 1024 * 1024) + 64 * 1024);
          const match = /^data:([a-z0-9/+.-]+);base64,(.*)$/is.exec(String(body.image ?? ''));
          if (!match) {
            return sendJSON(res, 400, {
              error: 'no_image',
              message: 'Pick an image to go with it.',
            });
          }
          const bytes = Buffer.from(match[2], 'base64');
          if (bytes.length > maxMb * 1024 * 1024) {
            return sendJSON(res, 413, {
              error: 'too_large',
              message: `${(bytes.length / 1048576).toFixed(1)} MB, and the limit is ${maxMb} MB.`,
            });
          }
          return sendJSON(res, 201, withRights(sharedImages.save({
            username: user,
            name: body.name,
            text: body.text,
            brief: body.brief,
            model: modelKeyOrNull(body.model),
            contentType: match[1],
            bytes,
          })));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, {
            error: 'save_failed',
            message: err.statusCode === 413 ? `Over the ${maxMb} MB limit.` : err.message,
          });
        }
      }

      // Editing is gated exactly like deleting: what somebody pinned is
      // theirs. It was open to everyone when this shipped and the owner
      // reversed that on 20 Sep 2026 — see updateText in
      // server/sharedimages.mjs. Nothing is lost by it, because taking a pin
      // into the builder copies its prompt into your own brief.
      if (req.method === 'PATCH' && name) {
        try {
          const body = await readBody(req);
          return sendJSON(res, 200, sharedImages.update(
            name,
            { text: body.text, brief: body.brief, model: modelKeyOrNull(body.model) },
            { requester: user, isOwner: isOwner(req) }
          ));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, {
            error: err.statusCode === 403 ? 'forbidden' : 'save_failed',
            message: err.message,
          });
        }
      }

      if (req.method === 'DELETE' && name) {
        const out = sharedImages.remove(name, { requester: user, isOwner: isOwner(req) });
        if (out.ok) return sendJSON(res, 200, { deleted: name });
        return out.code === 403
          ? sendJSON(res, 403, {
              error: 'forbidden',
              message: 'Only the person who uploaded it, or the owner, can remove it.',
            })
          : sendJSON(res, 404, { error: 'not_found', message: `No shared image ${name}` });
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }

    // Where the weights live. Keyed on the weight's name rather than on any
    // pin, so a link added today serves every picture that already named it.
    if (pathname === '/api/weight-links' || pathname.startsWith('/api/weight-links/')) {
      const user = whoIs(req);
      const name = pathname.startsWith('/api/weight-links/')
        ? decodeURIComponent(pathname.slice('/api/weight-links/'.length))
        : '';

      if (req.method === 'GET' && !name) {
        return sendJSON(res, 200, { user, links: weightLinks.list() });
      }
      if (req.method === 'PUT' && name) {
        try {
          const body = await readBody(req);
          return sendJSON(res, 200, weightLinks.set(name, body.url, {
            requester: user,
            isOwner: isOwner(req),
          }));
        } catch (err) {
          return sendJSON(res, err.statusCode ?? 400, {
            error: err.statusCode === 403 ? 'forbidden' : 'save_failed',
            message: err.message,
          });
        }
      }
      if (req.method === 'DELETE' && name) {
        const out = weightLinks.remove(name, { requester: user, isOwner: isOwner(req) });
        if (out.ok) return sendJSON(res, 200, { deleted: name });
        return out.code === 403
          ? sendJSON(res, 403, {
              error: 'forbidden',
              message: 'Only the person who added it, or the owner, can remove it.',
            })
          : sendJSON(res, 404, { error: 'not_found', message: `No link for ${name}` });
      }
      return sendJSON(res, 405, { error: 'method_not_allowed' });
    }

    if (req.method === 'GET' && pathname === '/api/benchmarks') {
      return sendJSON(res, 200, { sheets: benchmarks.list() });
    }
    if (req.method === 'GET' && pathname.startsWith('/api/benchmarks/')) {
      const html = benchmarks.render(pathname.slice('/api/benchmarks/'.length));
      if (!html) {
        return sendJSON(res, 404, {
          error: 'not_found',
          message: 'No benchmark sheet by that name on this box.',
        });
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/api/docs/h3-director') {
      if (!existsSync(DIRECTOR_DOC)) {
        return sendJSON(res, 404, {
          error: 'not_found',
          message: 'The Director documentation is not on this box. Run: npm run fetch-h3-refs',
        });
      }
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache',
      });
      return createReadStream(DIRECTOR_DOC).pipe(res);
    }
    if (req.method === 'POST' && pathname === '/api/people') {
      return await handlePeople(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/cast') {
      return await handleCast(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/revise') {
      // Awaited like every other handler here. A bare `return promise` inside
      // an async try hands its rejection straight past the catch below, and
      // Node exits on an unhandled rejection. This was the only one left.
      return await handleRevise(req, res);
    }
    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { error: 'not_found', message: `No route for ${req.method} ${pathname}` });
    }
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }
    return sendJSON(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    // An error carrying a statusCode was thrown deliberately — a rejected
    // registration, a bad password, a body over the limit. Those are answers,
    // not crashes, and logging them as unhandled buries the real ones.
    if (err.statusCode && !res.headersSent) {
      return sendJSON(res, err.statusCode, {
        error: err.code ?? 'request_failed',
        message: err.message,
      });
    }
    console.error(`[server] unhandled on ${req.method} ${pathname}:`, err);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal', message: err.message });
    else res.end();
  }
}

const server = http.createServer(handleRequest);

/**
 * Relay the TrainFlow WebSocket. handleTrainflowProxy covers everything
 * fetch() can carry; this covers the one thing it cannot, and the embedded UI
 * is dead without it - /ws is the only source of the training log, the
 * running state, the hardware panel and the sample gallery (routes.go:235,
 * and the message handler in TrainFlow's app.js has no polling fallback).
 *
 * Nothing here speaks the WebSocket protocol. It repeats the client's
 * handshake upstream, hands the client whatever upstream answered, and then
 * the two sockets are just pipes - so no dependency, and frame semantics stay
 * TrainFlow's business. Gated exactly like the HTTP route: an upgrade carries
 * cookies, so the session is checked the same way, and the owner check is
 * repeated rather than assumed, because this path never touches
 * handleRequest.
 */
function attachTrainflowUpgrade(srv) {
  srv.on('upgrade', (req, socket, head) => {
    // First, before anything can go wrong. A raw socket with no 'error'
    // listener *throws* the event, and uncaughtException is deliberately left
    // at Node's default here, so one client going away at the wrong moment
    // would take the whole server down with it - every in-flight generation
    // on a box five people share. A disconnect mid-handshake is ordinary, and
    // the refusal paths below end sockets that nobody is listening to yet.
    socket.on('error', () => socket.destroy());

    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/trainflow/ws') return socket.destroy();

    const deny = (line) => socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
    if (auth.enabled) {
      const session = auth.identify(req);
      if (!session) return deny('401 Unauthorized');
      req.user = session.account;
    }
    if (!mayTrain(req)) return deny('403 Forbidden');
    if (!training.baseUrl) return deny('503 Service Unavailable');

    const target = new URL('/ws', training.baseUrl);
    // PromptForge's own cookies are not TrainFlow's business, and it has no
    // accounts to read them with.
    const { cookie, ...rest } = req.headers;
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: { ...rest, host: target.host },
    });

    upstream.on('upgrade', (ures, usocket, uhead) => {
      // Bytes that arrived glued to the handshake on either side are pushed
      // back in front of their own stream, so the pipes carry them in order.
      if (uhead?.length) usocket.unshift(uhead);
      if (head?.length) socket.unshift(head);
      socket.setNoDelay(true);
      usocket.setNoDelay(true);
      const headerLines = [];
      for (let i = 0; i < ures.rawHeaders.length; i += 2) {
        headerLines.push(`${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}`);
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      // Either end going away takes the other with it; an unheard 'error' on
      // a raw socket is thrown, and the net above should not be catching
      // something this ordinary.
      usocket.on('error', () => socket.destroy());
      socket.on('error', () => usocket.destroy());
      usocket.pipe(socket).pipe(usocket);
    });

    upstream.on('error', (err) => {
      console.warn(`[trainflow-proxy] ws: ${err.message}`);
      deny('502 Bad Gateway');
    });
    // TrainFlow answered the upgrade with an ordinary response, so there is
    // no socket to pipe - pass the status on rather than hanging the client.
    upstream.on('response', (ures) => deny(`${ures.statusCode} ${ures.statusMessage ?? ''}`.trim()));
    upstream.end();
  });
}

attachTrainflowUpgrade(server);

// A rejection nobody handled is logged and survived, not fatal. Node's default
// is to exit, which on a box five people share turns one stray promise into
// every in-flight generation lost and a five-second outage. The request-level
// catch above is the real handling; this is the net under it, so a miss shows
// up in the journal as a bug to fix rather than as a restart nobody explains.
// uncaughtException is deliberately left at the default: after one of those
// the process state cannot be trusted, and systemd's restart is correct.
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection (kept running):', err);
});

const bind = config.server?.bind ?? '127.0.0.1';
const port = config.server?.port ?? 8090;
const tlsPort = config.server?.tls?.port ?? 8443;

server.listen(port, bind, () => {
  const info = prompts.info();
  console.log(`PromptForge listening on http://${bind}:${port}`);
  const v = version.info();
  if (v.boot_commit) console.log(`  commit      : ${v.boot_commit}`);
  console.log(`  llm backend : ${llm.backend}${llm.backend === 'mock' ? ' (no model is being called)' : ` — ${llm.model}`}`);
  console.log(`  models      : ${registry.keys().length} (${registry.keys().join(', ')})`);
  console.log(`  prompts     : ${info.count} loaded, house rules ${info.shared_prefix_loaded ? 'on' : 'MISSING'}`);
  console.log(`  queue       : concurrency ${inferenceQueue.concurrency}`);
  const days = config.chats?.retention_days ?? 0;
  console.log(
    `  chats       : ${days > 0 ? `kept ${days} days after the last message, locked ones forever` : 'kept forever'}`
  );
  if (info.warnings.length) {
    console.log(`  warnings    : ${info.warnings.length}`);
    for (const w of info.warnings) console.log(`      - ${w}`);
  }
  startChatSweep();
});

// HTTPS listener on a second port, OFF unless server.tls.enabled. Shares the
// exact same request handler as HTTP, so both ports serve identical content.
// Certificates are loaded from config (server.tls.cert / server.tls.key) or
// generated self-signed EC P-256 certs in data/certs/ if none exist.
//
// Opt-in, and 8443 rather than 443, because it arrived always-on (PR #1): a
// service running as a normal user cannot open a port below 1024, and the
// unhandled EACCES took the whole app down with it. A box behind NetBird or
// Tailscale already has an encrypted link and needs none of this.
// Prometheus metrics (PR #3) on their OWN port, off unless
// PROMPTFORGE_METRICS_PORT is set. They were at /api/metrics on the app port
// with no login - model names, user counts and traffic readable by anyone who
// could reach PromptForge, friends on the mesh included. A separate port that
// compose never publishes is reachable by Prometheus on the compose network
// and by nothing else, with no token to manage.
let metricsServer = null;
const metricsPort = Number(process.env.PROMPTFORGE_METRICS_PORT || 0);
if (metricsPort) {
  metricsServer = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || !/^\/metrics\/?(\?|$)/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found\n');
    }
    let sysData = null;
    try { sysData = await sysmon.read(); } catch { /* sysmon off */ }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(metrics.render(
      () => inferenceQueue.stats().depth,
      () => llm.getBackendInfo(),
      () => sysData,
      () => auth.listAccounts().length
    ));
  });
  metricsServer.on('error', (err) => {
    console.error(`[metrics] could not listen on ${bind}:${metricsPort} — ${err.code ?? err.message}. The app is unaffected.`);
    metricsServer = null;
  });
  metricsServer.listen(metricsPort, bind, () => {
    console.log(`[metrics] Prometheus metrics on http://${bind}:${metricsPort}/metrics`);
  });
}

let httpsServer = null;
if (config.server?.tls?.enabled) {
  const tlsCreds = loadTlsCredentials(config);
  if (tlsCreds) {
    httpsServer = https.createServer(tlsCreds, handleRequest);
    attachTrainflowUpgrade(httpsServer);
    // A listener that cannot bind costs HTTPS, never the HTTP app.
    httpsServer.on('error', (err) => {
      console.error(`[certs] HTTPS could not listen on ${bind}:${tlsPort} — ${err.code ?? err.message}. HTTP is unaffected.`);
      httpsServer = null;
    });
    httpsServer.listen(tlsPort, bind, () => {
      console.log(`PromptForge HTTPS listening on https://${bind}:${tlsPort}`);
    });
  } else {
    console.log('[certs] no TLS credentials available — HTTPS disabled');
  }
}

/**
 * Delete conversations nobody has added to in `chats.retention_days`.
 *
 * Runs once at start and then on a timer, because this box is not on all the
 * time — a sweep that only ran on an interval would never fire on a machine
 * that is up for an hour a day.
 *
 * Every deletion is logged with its title and age. Silently removing someone's
 * history is the one behaviour this feature must not have: if a conversation
 * someone wanted is gone, the log is what says when and why.
 */
function startChatSweep() {
  const days = Number(config.chats?.retention_days ?? 0);
  if (!Number.isFinite(days) || days <= 0) return;

  const run = () => {
    try {
      const swept = storage.sweepAllChats(days);
      for (const c of swept) {
        const age = Math.round((Date.now() - Date.parse(c.updated_at)) / 86400000);
        console.log(`[chats] deleted ${c.user}/${c.id} after ${age} days idle — "${c.title}"`);
      }
      if (swept.length) console.log(`[chats] swept ${swept.length} conversation(s)`);
    } catch (err) {
      // A failed sweep must never take the server down with it. Worst case
      // the files stay another cycle.
      console.warn(`[chats] sweep failed: ${err.message}`);
    }
  };

  run();
  const hours = Number(config.chats?.sweep_hours ?? 24);
  const every = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000;
  // unref so a pending sweep never holds the process open at shutdown.
  setInterval(run, every).unref();
}

/**
 * Uploaded datasets and finished LoRA output age out on the same schedule the
 * chats do. See server/training.mjs for why age is the newest file inside
 * rather than the folder's own timestamp - an upload in progress or a run
 * still writing must not be swept out from under itself.
 */
function startTrainingSweep() {
  const run = () => {
    try {
      const removed = training.sweep();
      for (const d of removed.datasets) console.log(`[training] deleted dataset "${d}" after ${training.retentionDays} days idle`);
      for (const o of removed.outputs) console.log(`[training] emptied ${o} after ${training.retentionDays} days idle`);
    } catch (err) {
      console.warn(`[training] sweep failed: ${err.message}`);
    }
  };
  try {
    training.ensureLayout();
  } catch (err) {
    console.warn(`[training] could not create the dataset/output folders: ${err.message}`);
  }
  run();
  const hours = Number(config.chats?.sweep_hours ?? 24);
  setInterval(run, (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600 * 1000).unref();
}
startTrainingSweep();

// Windows has no SIGUSR1 or SIGHUP. SIGINT and SIGTERM only.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down.`);
    server.close(() => process.exit(0));
    httpsServer?.close();
    metricsServer?.close();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
