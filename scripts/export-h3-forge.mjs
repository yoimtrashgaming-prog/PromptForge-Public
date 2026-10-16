#!/usr/bin/env node
// Export PromptForge's h3 prompting as one JSON bundle for the DaSiWa H3
// Director node's Forge overlay.
//
// The node has no copy of our prompt files to drift: everything it sends the
// LLM that is TEXT comes from here, composed by the same prompt store the
// server uses. Only the user-message assembly is ported to Python, and it
// reads its sentences from this bundle too.
//
// What is deliberately different from a PromptForge generation:
//   - no tools. search_tags and read_guidance need this server; the node runs
//     on whatever local model the person has, prompt-only.
//   - no Reasoning segment. It explains the output to a PromptForge user and
//     has no field in the node.
//
//   node scripts/export-h3-forge.mjs [out.json]
//
// Re-run after any change to prompts/video/h3, house rules, or h3's entry in
// config/models.yaml.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { loadRegistry } from '../server/registry.mjs';
import { createPromptStore } from '../server/prompts.mjs';
import { MODE_LIMITS } from '../server/references.mjs';
import { PICTURE_TEMPERATURE, PICTURE_BUDGET } from '../server/picture-readings.mjs';
import { MUSIC_WORDS } from '../server/music.mjs';
import { LABELLED_PROMPT_MODE } from '../server/picture-labels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? path.join(ROOT, 'h3_forge.json');

const { config, error } = loadConfig(ROOT, 'server');
if (!config) throw new Error(error);
const registry = loadRegistry(ROOT);
const prompts = createPromptStore(ROOT, config, registry);
const model = registry.get('h3');
if (!model) throw new Error('h3 is not in the registry');

const SEP = '\n\n---\n\n';
const meta = new Set(model.meta_segments ?? []);
// "REF2VA labelled" is REF2VA with labelled pictures (server/picture-labels.mjs): its
// own prompt block and a contract without Retention analysis, which the node
// writes in code.
const MODES = ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'REF2VA', LABELLED_PROMPT_MODE];
// The node still looks it up as "REF2VA easy" (EASY_MODE in nodes/h3_forge.py),
// the name it had here until 2 Oct 2026. Rename both together or neither.
const BUNDLE_KEY = { [LABELLED_PROMPT_MODE]: 'REF2VA easy' };

const modes = {};
for (const mode of MODES) {
  const segments = (model.segments_by_mode?.[mode] ?? model.segments).filter((l) => !meta.has(l));
  const system = [prompts.get('h3', mode), prompts.segmentTail(model, segments)].filter(Boolean).join(SEP);
  modes[BUNDLE_KEY[mode] ?? mode] = { segments, system };
}

const bundle = {
  source: 'PromptForge',
  exported_at: new Date().toISOString(),
  max_output_chars: model.max_output_chars ?? 7000,
  context_length: model.context_length ?? 16384,
  durations: model.durations,
  // The Shots control (server/shots.mjs): "Auto" sends nothing, a number is
  // an instruction the node then checks and whose late cuts it moves.
  shot_counts: model.shot_counts ?? ['Auto'],
  default_shots: model.default_shots ?? 'Auto',
  default_detail: model.default_detail ?? registry.defaults?.default_detail ?? 5,
  default_creativity: model.default_creativity ?? 'balanced',
  detail_levels: model.detail_levels ?? registry.defaults?.detail_levels ?? {},
  creativity_presets: model.creativity_presets ?? registry.defaults?.creativity_presets ?? {},
  segment_fields: model.segment_fields ?? {},
  mode_limits: MODE_LIMITS,
  modes,
  // A score only when the brief asks for music (server/music.mjs). The node
  // sets Music to N/A when this pattern finds nothing in the idea. Null turns
  // the rule off.
  music_words: model.music_only_when_asked ? MUSIC_WORDS.source : null,
  // REF2VA's per-picture scan (server/picture-readings.mjs). Absent when the
  // reader is switched off here, and the node then sends the pictures straight
  // to the writer as it did before.
  ...(prompts.referencePicture()
    ? {
        picture_reader: {
          system: prompts.referencePicture(),
          temperature: PICTURE_TEMPERATURE,
          // A rescan runs looser, so it can come back different.
          rescan_temperature: 0.6,
          max_tokens: PICTURE_BUDGET,
        },
      }
    : {}),
  // The Cast list's reader (prompts/_shared/picture-description.md): one
  // character described from their pictures, for their card in the panel.
  // The node writes the message itself (nodes/h3_cast.py, describe_message).
  ...(prompts.pictureDescription() ? { picture_description: prompts.pictureDescription() } : {}),
};

writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
for (const [m, { system, segments }] of Object.entries(modes)) {
  console.log(`${m.padEnd(11)} ${system.length.toLocaleString()} chars  [${segments.join(', ')}]`);
}
console.log(`wrote ${out}`);
