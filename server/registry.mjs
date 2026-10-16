// Model registry — loads and validates config/models.yaml.
//
// The spec's rule: a missing prompt file, an unknown template name or a
// duplicate key fails loudly at boot with the offending key named, rather
// than silently producing a broken dropdown. This module is where that
// happens, so nothing downstream has to defend against a malformed entry.
//
// It also cross-checks each model's `segments` list against the "Segments to
// emit" list in that model's own prompt file. Those two drifting apart is the
// failure that produces a parse error at generation time rather than at boot,
// which is much harder to diagnose.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { optionalSegments } from './segments.mjs';
import YAML from 'yaml';

export const TEMPLATES = [
  'booru',
  'hybrid',
  'natural-language',
  'video-h3',
  'video-wan',
  'video-ltx',
  'video-cog',
];

const TYPES = ['image', 'video'];

// House-rules mandates this segment for policy refusals, but no model lists
// it. Every model implicitly accepts it, and on its own it satisfies the
// output contract — see server/segments.mjs.
export const REFUSAL_SEGMENT = 'Refused';

class RegistryError extends Error {
  constructor(problems) {
    super(
      `config/models.yaml failed validation:\n` +
        problems.map((p) => `  - ${p}`).join('\n')
    );
    this.name = 'RegistryError';
    this.problems = problems;
  }
}

/**
 * Pull the ordered segment list out of a prompt file's "Segments to emit"
 * section. Every prompt file declares one as a numbered list of backticked
 * labels; that declaration is the product, so the registry has to agree
 * with it rather than the other way round.
 * Returns null when the file has no such section (the chat prompt).
 */
export function parseDeclaredSegments(markdown) {
  // Lazy match up to the next ## heading, or end of input. Note `$(?![\s\S])`
  // rather than `\Z` — JavaScript has no \Z, it would match a literal "Z".
  const section = markdown.match(
    /^##+[ \t]*Segments to emit[ \t]*$([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/im
  );
  if (!section) return null;

  const labels = [...section[1].matchAll(/^\s*\d+\.\s*`([^`]+)`\s*$/gm)].map(
    (m) => m[1].trim()
  );
  return labels.length ? labels : null;
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * `prompts` swaps a model's system_prompt path before anything is validated,
 * so a substitute file is checked exactly as the tracked one is: it must
 * exist, and its declared segments must still match models.yaml. A shorter
 * variant that quietly drops a segment fails at boot rather than halfway
 * through a measurement. Set by PROMPTFORGE_PROMPTS — see server.mjs.
 */
export function loadRegistry(rootDir, { warn = console.warn, prompts = new Map() } = {}) {
  const file = path.join(rootDir, 'config', 'models.yaml');
  if (!existsSync(file)) {
    throw new RegistryError([`config/models.yaml not found at ${file}`]);
  }

  let doc;
  try {
    // uniqueKeys makes a duplicated model key a parse error rather than a
    // silent last-one-wins overwrite.
    doc = YAML.parse(readFileSync(file, 'utf8'), { uniqueKeys: true });
  } catch (err) {
    throw new RegistryError([`YAML parse failed — ${err.message}`]);
  }

  if (!doc || typeof doc !== 'object' || !doc.models) {
    throw new RegistryError(['no top-level `models:` mapping']);
  }

  const defaults = doc.defaults ?? {};
  const problems = [];
  const models = new Map();

  for (const [key, entry] of Object.entries(doc.models)) {
    // A PROMPTFORGE_PROMPTS override is applied here, before any validation,
    // so the substitute is checked exactly as the tracked file would be.
    const raw = prompts.has(key) && entry && typeof entry === 'object'
      ? { ...entry, system_prompt: prompts.get(key) }
      : entry;
    const at = (msg) => problems.push(`${key}: ${msg}`);

    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      at('key must be lowercase alphanumeric with underscores — it appears in URLs, filenames and saved user data');
    }
    if (!raw || typeof raw !== 'object') {
      at('entry is not a mapping');
      continue;
    }

    for (const field of ['name', 'label', 'type', 'template', 'system_prompt']) {
      if (!raw[field]) at(`missing required field \`${field}\``);
    }

    if (raw.type && !TYPES.includes(raw.type)) {
      at(`unknown type "${raw.type}" — expected one of ${TYPES.join(', ')}`);
    }

    // Template must be both a known name and an actual file, or the
    // "adding a model needs no code changes" promise quietly breaks.
    if (raw.template) {
      if (!TEMPLATES.includes(raw.template)) {
        at(`unknown template "${raw.template}" — expected one of ${TEMPLATES.join(', ')}`);
      } else {
        const tpl = path.join(rootDir, 'web', 'templates', `${raw.template}.html`);
        if (!existsSync(tpl)) {
          at(`template file not found: web/templates/${raw.template}.html`);
        }
      }
    }

    // System prompt must exist, and its declared segments must match ours.
    let promptText = null;
    if (raw.system_prompt) {
      const p = path.join(rootDir, raw.system_prompt);
      if (!existsSync(p)) {
        at(`system prompt not found: ${raw.system_prompt}`);
      } else {
        promptText = readFileSync(p, 'utf8');
      }
    }

    const segments = raw.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      at('missing `segments` — the ordered list of ===SEGMENT: labels this model emits');
    } else if (segments.some((s) => typeof s !== 'string' || !s.trim())) {
      at('`segments` must be a list of non-empty strings');
    } else if (segments.includes(REFUSAL_SEGMENT)) {
      at(`must not list "${REFUSAL_SEGMENT}" — it is accepted from every model automatically`);
    } else if (promptText) {
      // The prompt file used to carry its own "Segments to emit" list and this
      // held the two to agreeing. That list is generated from `segments` now —
      // see prompts.segmentTail — so there is nothing left to disagree with.
      // A file still carrying one is a leftover that will contradict the
      // generated contract the moment somebody switches a segment off.
      const declared = parseDeclaredSegments(promptText);
      if (declared) {
        at(
          `${raw.system_prompt} still lists its own "Segments to emit".\n` +
            `      The contract is generated from \`segments\` in this file now, so a\n` +
            `      list in the prompt would contradict it when a segment is switched\n` +
            `      off. Remove the list; move each segment's instructions into a\n` +
            `      segment_blocks file.\n` +
            `      found: ${JSON.stringify(declared)}`
        );
      }
    }

    // Blocks must name segments this model actually has, and exist on disk.
    // Either failure is silent otherwise: a block for a segment that is never
    // asked for is simply never appended, and looks like it is working.
    if (raw.segment_blocks != null) {
      if (typeof raw.segment_blocks !== 'object' || Array.isArray(raw.segment_blocks)) {
        at('`segment_blocks` must be a map of segment label to file path');
      } else {
        for (const [label, rel] of Object.entries(raw.segment_blocks)) {
          if (!segments.includes(label)) {
            at(`segment_blocks names "${label}", which is not one of its segments`);
          }
          if (typeof rel !== 'string' || !rel.trim()) {
            at(`segment_blocks["${label}"] must be a file path`);
          } else if (!existsSync(path.join(rootDir, rel))) {
            at(`segment_blocks["${label}"] not found — ${rel}`);
          }
        }
      }
    }

    // The keys a per-mode map may use: the modes the picker offers, plus
    // `mode_variants` — keys the server asks for by name and never offers,
    // like h3's "REF2VA labelled" (server/picture-labels.mjs promptMode).
    const modeKeys = [
      ...(Array.isArray(raw.modes) ? raw.modes : []),
      ...(Array.isArray(raw.mode_variants) ? raw.mode_variants : []),
    ];

    // A per-mode contract must be a subset of `segments`, in the same order.
    // The parser enforces order, so a list that reorders them would fail every
    // run in that mode; and a label outside `segments` has no block and no
    // UI label, which is the silent half of the same mistake.
    if (raw.segments_by_mode != null) {
      if (typeof raw.segments_by_mode !== 'object' || Array.isArray(raw.segments_by_mode)) {
        at('`segments_by_mode` must be a map of mode to a list of segment labels');
      } else {
        for (const [mode, list] of Object.entries(raw.segments_by_mode)) {
          if (!modeKeys.includes(mode)) {
            at(`segments_by_mode names mode "${mode}", which is not one of its modes`);
          }
          if (!Array.isArray(list) || list.length === 0) {
            at(`segments_by_mode["${mode}"] must be a non-empty list`);
            continue;
          }
          const stray = list.filter((l) => !Array.isArray(segments) || !segments.includes(l));
          if (stray.length) {
            at(`segments_by_mode["${mode}"] names ${stray.map((l) => `"${l}"`).join(', ')}, not in its segments`);
          } else if (Array.isArray(segments)) {
            const order = list.map((l) => segments.indexOf(l));
            if (order.some((n, i) => i > 0 && n <= order[i - 1])) {
              at(`segments_by_mode["${mode}"] is out of order against \`segments\``);
            }
          }
        }
      }
    }

    // Mode blocks, like segment blocks, must name something real and exist on
    // disk. A block that is never found is a mode silently missing half its
    // instructions, and it would read as the model getting worse.
    if (raw.mode_blocks != null) {
      if (typeof raw.mode_blocks !== 'object' || Array.isArray(raw.mode_blocks)) {
        at('`mode_blocks` must be a map of mode to a file path or list of paths');
      } else {
        for (const [mode, value] of Object.entries(raw.mode_blocks)) {
          if (!modeKeys.includes(mode)) {
            at(`mode_blocks names mode "${mode}", which is not one of its modes`);
          }
          const rels = Array.isArray(value) ? value : [value];
          for (const rel of rels) {
            if (typeof rel !== 'string' || !rel.trim()) {
              at(`mode_blocks["${mode}"] must be a file path or a list of them`);
            } else if (!existsSync(path.join(rootDir, rel))) {
              at(`mode_blocks["${mode}"] not found — ${rel}`);
            }
          }
        }
      }
    }

    // segment_fields maps a segment's UI label to its official field name,
    // for models whose prompt file writes bodies prefixed with the field
    // name rather than the label (see h3's "Music" / non_diegetic_music).
    // Every key must be one of this model's own segments, or the frontend's
    // copy-strip logic would be keying off a label that can't ever appear.
    if (raw.segment_fields != null) {
      if (typeof raw.segment_fields !== 'object' || Array.isArray(raw.segment_fields)) {
        at('`segment_fields` must be a mapping of segment label to field name');
      } else {
        for (const segLabel of Object.keys(raw.segment_fields)) {
          if (!Array.isArray(segments) || !segments.includes(segLabel)) {
            at(`segment_fields key "${segLabel}" is not in \`segments\``);
          }
        }
      }
    }

    // meta_segments names the segments that explain the prompt rather than
    // being part of it, so Copy all can leave them out. Same subset rule as
    // segment_fields, and for the same reason: a label that can never appear
    // would silently exclude nothing, which is the failure mode you only
    // notice by pasting a paragraph of reasoning into a prompt box.
    if (raw.meta_segments != null) {
      if (!Array.isArray(raw.meta_segments)) {
        at('`meta_segments` must be a list of segment labels');
      } else {
        for (const segLabel of raw.meta_segments) {
          if (!Array.isArray(segments) || !segments.includes(segLabel)) {
            at(`meta_segments entry "${segLabel}" is not in \`segments\``);
          }
        }
        if (Array.isArray(segments) && raw.meta_segments.length >= segments.length) {
          at('`meta_segments` cannot cover every segment — Copy all would produce nothing');
        }
      }
    }

    // Negative-prompt consistency. krea2, flux, ltx, cog and h3 have no
    // negative segment, and their templates must not render the field.
    const hasNegSegment = Array.isArray(segments) && segments.includes('Negative prompt');
    const hasNegative = raw.has_negative ?? hasNegSegment;
    if (hasNegSegment && !raw.negative_defaults) {
      at('emits a "Negative prompt" segment but has no `negative_defaults`');
    }
    if (!hasNegSegment && raw.negative_defaults) {
      at('has `negative_defaults` but emits no "Negative prompt" segment');
    }

    if (raw.word_target) {
      const { min, max } = raw.word_target;
      if (!(Number.isFinite(min) && Number.isFinite(max) && min < max)) {
        at('`word_target` needs numeric min < max');
      }
    }

    // A per-model context override forces an Ollama reload when it differs
    // from the resident model's, so a typo here costs 8 seconds on every
    // switch rather than failing loudly. Catch the obvious mistakes.
    if (raw.context_length != null) {
      if (!Number.isInteger(raw.context_length) || raw.context_length < 2048) {
        at(`\`context_length\` must be an integer >= 2048, got ${raw.context_length}`);
      } else if (raw.context_length > 131072) {
        warn(`[registry] ${key}: context_length ${raw.context_length} is very large — check it fits in VRAM`);
      }
    }

    // Reference files degrade rather than fail — a missing official H3 guide
    // must not take the tab down. See prompts/video/h3/references/README.md.
    //
    // `optional_reference_files` load after the required ones, so they still
    // take precedence in the composed prompt, but their absence is the normal
    // state and is not reported as missing. Without that split, h3's optional
    // house-conventions file — which the README says to write yourself, and
    // which therefore does not exist on a fresh checkout — made every H3
    // generation close with "work from your own instructions... you worked
    // without the official reference guides" while both official guides were
    // present. Measured: it fired on 100% of runs.
    const referenceFiles = [];
    const missingRequired = [];
    for (const rel of raw.reference_files ?? []) {
      if (existsSync(path.join(rootDir, rel))) {
        referenceFiles.push(rel);
      } else {
        warn(`[registry] ${key}: reference file missing, continuing without it — ${rel}`);
        missingRequired.push(rel);
      }
    }
    for (const rel of raw.optional_reference_files ?? []) {
      if (existsSync(path.join(rootDir, rel))) {
        referenceFiles.push(rel);
      }
      // Silent when absent: that is the documented default, and warning about
      // it every boot teaches the reader to ignore reference warnings.
    }

    // Reference files that load only in certain modes.
    //
    // h3 is the only model with these, and the split needs no editing of a
    // third-party document because it falls on a file boundary already:
    // h3-base-official.md is titled "Video Prompt Writing Guide (T2VA / I2VA /
    // FL2VA / L2VA)" and h3-reference-official.md is the Full reference guide.
    // Before 3 Sep 2026 both loaded on every generation, so a T2VA prompt
    // carried ~5,500 tokens of instructions for a mode it was not in.
    //
    // Missing files are tracked PER MODE rather than folded into
    // missingRequired. Sharing that list would make the "worked without the
    // official guides" note fire in modes whose own guide is present — the
    // same over-firing the optional_reference_files split above exists to
    // prevent, and the reason that note was measured at 100% of runs.
    const referenceFilesByMode = {};
    const missingByMode = {};
    for (const [mode, rels] of Object.entries(raw.reference_files_by_mode ?? {})) {
      const kept = [];
      const gone = [];
      for (const rel of rels ?? []) {
        if (existsSync(path.join(rootDir, rel))) {
          kept.push(rel);
        } else {
          warn(
            `[registry] ${key}: reference file missing for mode "${mode}", ` +
              `continuing without it — ${rel}`
          );
          gone.push(rel);
        }
      }
      referenceFilesByMode[mode] = kept;
      missingByMode[mode] = gone;
    }

    models.set(key, {
      ...raw,
      key,
      has_negative: hasNegative,
      creativity_presets: raw.creativity_presets ?? defaults.creativity_presets,
      default_creativity: raw.default_creativity ?? defaults.default_creativity,
      // Detail rides the same per-model-override-then-default path as
      // creativity. No model overrides it today; the door is open because a
      // format with a hard tag ceiling may eventually want its own wording.
      // Which segments a person may switch off, computed once here so the
      // frontend never has to re-derive it. server/segments.mjs owns the rule;
      // duplicating it in app.js is how the two would come to disagree about
      // whether wan's Layer breakdown is optional.
      segment_blocks: raw.segment_blocks ?? {},
      // Always lists, so the prompt store never has to ask which shape it got.
      mode_blocks: Object.fromEntries(
        Object.entries(raw.mode_blocks ?? {}).map(([mode, v]) => [mode, Array.isArray(v) ? v : [v]])
      ),
      optional_segments: optionalSegments({
        segments: raw.segments,
        meta_segments: raw.meta_segments,
        has_negative: hasNegative,
      }),
      detail_levels: raw.detail_levels ?? defaults.detail_levels,
      default_detail: raw.default_detail ?? defaults.default_detail,
      // `??` and not `||`, which is what makes the opt-out work: the three
      // video models declare `lighting_levels: {}`, an empty object is not
      // nullish, and it therefore survives instead of falling through to the
      // defaults. Type-gating it here the way image_aspect_ratios is gated
      // below would work too, but it would put the decision in code — this way
      // switching lighting on for a video model is deleting one config line.
      lighting_levels: raw.lighting_levels ?? defaults.lighting_levels,
      default_lighting: raw.default_lighting ?? defaults.default_lighting,
      lighting_rule: raw.lighting_rule ?? defaults.lighting_rule,
      aspect_ratios:
        raw.aspect_ratios ??
        (raw.type === 'image' ? defaults.image_aspect_ratios : undefined),
      default_aspect_ratio:
        raw.default_aspect_ratio ??
        (raw.type === 'image' ? defaults.default_image_aspect_ratio : undefined),
      reference_files: referenceFiles,
      missing_reference_files: missingRequired,
      reference_files_by_mode: referenceFilesByMode,
      missing_reference_files_by_mode: missingByMode,
    });
  }

  if (models.size === 0) problems.push('registry contains no models');
  if (problems.length) throw new RegistryError(problems);

  return {
    defaults,
    get: (key) => models.get(key),
    has: (key) => models.has(key),
    keys: () => [...models.keys()],
    all: () => [...models.values()],
    byType: (type) => [...models.values()].filter((m) => m.type === type),
    /** The payload GET /api/models returns. Frontend builds everything from this. */
    toPublic() {
      return {
        defaults: {
          creativity_presets: defaults.creativity_presets ?? null,
          default_creativity: defaults.default_creativity ?? null,
          // Detail is the second slider axis. Sent to the client so the notch
          // labels come from config rather than being spelled out in app.js -
          // same rule as every other control.
          detail_levels: defaults.detail_levels ?? null,
          default_detail: defaults.default_detail ?? null,
          // Lighting is the third axis. Same reasoning as detail above: the
          // notch count and every notch label are config, so the slider is
          // built from this rather than spelled out in app.js.
          //
          // `lighting_rule` is NOT sent. It is the standing instruction that
          // rides along with whichever level is chosen, it never appears in
          // the UI, and the frontend has no business holding a copy of a rule
          // only the server injects — the same line drawn around system_prompt
          // below.
          lighting_levels: defaults.lighting_levels ?? null,
          default_lighting: defaults.default_lighting ?? null,
          // Whether the switchable segments start on or off. The builder needs
          // the same answer the server resolves with, or a checkbox would show
          // a state the generation does not use.
          optional_segments_default: defaults.optional_segments_default ?? 'on',
          // Reference images on the image models: what a picture is for, and
          // how hard to follow it. Both selectors are built from these, so
          // the wording stays the owner's — the same rule as every other
          // control in this block. The `rule` text on each is what actually
          // reaches the model; the frontend only ever shows `label`.
          image_reference_roles: defaults.image_reference_roles ?? null,
          default_image_reference_role: defaults.default_image_reference_role ?? null,
          reference_fidelity: defaults.reference_fidelity ?? null,
          default_reference_fidelity: defaults.default_reference_fidelity ?? null,
          max_image_references: defaults.max_image_references ?? null,
        },
        // system_prompt and the reference-file bookkeeping stay server-side:
        // they are the product, and the frontend has no business rendering
        // them.
        //
        // **llm_model used to be stripped here too, and that was wrong.** The
        // reasoning was that which LLM answers is a deployment decision — true
        // — but two surfaces need to know that a target pins one: the account
        // panel, whose note names the pinned targets so a personal preference
        // is not silently ignored, and Tab 1's "Written by" control, which
        // must disable rather than offer a choice that would be overridden.
        // The account panel's note filtered on this field and therefore
        // matched nothing from the day it shipped, which is how the omission
        // was found on 21 Aug 2026.
        //
        // It is not privileged information: /api/status already serves every
        // installed model name to every signed-in user, and the chat selector
        // lists them. Exposing the pin does not weaken the non-negotiable it
        // was protecting — the frontend still derives behaviour from what a
        // model IS, and this is one of the things it is.
        models: [...models.values()].map(
          ({
            missing_reference_files,
            reference_files,
            // The per-mode lists are the same product, sliced — they stay
            // server-side for the same reason the flat lists do.
            missing_reference_files_by_mode,
            reference_files_by_mode,
            // Prompt file paths, per mode. The product, same as system_prompt.
            mode_blocks,
            system_prompt,
            // The standing lighting instruction. Only buildUserMessage ever
            // uses it, nothing renders it, and it reached the client purely
            // because the defaults merge puts it on every model — caught in a
            // browser on 8 Sep 2026 by checking whether the payload contained
            // it, one minute after a comment above was written claiming it did
            // not. The per-notch `rule` strings still go out: the slider's
            // format warning is derived from them.
            lighting_rule,
            // Workflow paths and presets are served by /api/render/options,
            // to people allowed to render. The client only needs to know
            // that a model can.
            render,
            ...m
          }) => ({ ...m, can_render: Boolean(render?.workflow) })
        ),
      };
    },
  };
}

export { RegistryError };
