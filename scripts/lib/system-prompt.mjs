// Compose a model's system prompt exactly as the server does.
//
// Every probe under scripts/ used to build this by hand:
//
//   house-rules.md + '\n\n---\n\n' + the model's own prompt file
//
// which is not what the app sends. `server/prompts.mjs` also appends each
// model's `reference_files`, and for h3 that is two official MiniMax guides —
// 16,397 characters assembled by hand against 56,100 actually sent. Three
// separate scripts carried that bug and every H3 measurement taken through
// them was of a prompt the app has never sent.
//
// So: no restating. The prompt comes from the same store the server uses, and
// anything added to `config/models.yaml` lands in the probes automatically.
//
// Returns the composed prompt plus the provenance a probe should print, so a
// run that measured the wrong thing says so in its own output instead of
// looking like a result.

import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../../server/registry.mjs';
import { createPromptStore } from '../../server/prompts.mjs';

export function composeSystemPrompt(rootDir, modelKey, mode) {
  const cfg = YAML.parse(
    readFileSync(path.join(rootDir, 'config/server.yaml'), 'utf8')
  );

  // Warnings are swallowed: a probe reports provenance itself, below, and the
  // registry's own warnings would otherwise print once per script run and
  // train the reader to ignore them.
  const registry = loadRegistry(rootDir, { warn: () => {} });
  const store = createPromptStore(rootDir, cfg, registry, { warn: () => {} });
  store.reload();

  const system = store.get(modelKey, mode);
  if (!system) {
    throw new Error(
      `no system prompt for "${modelKey}" — check config/models.yaml`
    );
  }

  // Which reference files the returned prompt ACTUALLY carries.
  //
  // Reading `model.reference_files` alone stopped being that answer on 3 Sep
  // 2026, when h3's guides moved to `reference_files_by_mode`: the flat list
  // went empty and a probe would have reported "0 reference file(s)" over a
  // prompt carrying two. That is precisely the miscount this file exists to
  // prevent — see the header — so it is derived the same way prompts.mjs
  // composes, and from the same fields.
  //
  // With no mode, the union of every mode's files, matching the base entry.
  // With a mode this model gates on, that mode's files alone.
  const model = registry.get(modelKey) ?? {};
  const byMode = model.reference_files_by_mode ?? {};
  const missingByMode = model.missing_reference_files_by_mode ?? {};
  const gated = mode != null && Object.hasOwn(byMode, mode);

  const uniq = (xs) => [...new Set(xs)];
  const referenceFiles = uniq([
    ...(model.reference_files ?? []),
    ...(gated ? byMode[mode] : Object.values(byMode).flat()),
  ]);
  const missingReferences = uniq([
    ...(model.missing_reference_files ?? []),
    ...(gated ? missingByMode[mode] ?? [] : Object.values(missingByMode).flat()),
  ]);

  return {
    system,
    config: cfg,
    referenceFiles,
    missingReferences,
    // Named so a probe's header can say which variant it measured. null means
    // the base prompt, which is what every probe measured before gating.
    mode: gated ? mode : null,
  };
}

// One line naming what was actually composed. Print it in every probe header:
// a run showing far fewer characters than the app sends, or zero reference
// files where the registry lists some, is measuring the wrong prompt and its
// numbers should be discarded rather than argued with.
export function describeSystemPrompt({ system, referenceFiles, missingReferences, mode }) {
  return (
    `system prompt: ${system.length} chars, ` +
    `${referenceFiles.length} reference file(s)` +
    // Named when the prompt is a gated variant, because two runs of the same
    // model can now legitimately differ in size and a header that did not say
    // which mode it composed would make that look like drift.
    (mode ? `, mode "${mode}"` : '') +
    (missingReferences.length ? ` — MISSING: ${missingReferences.join(', ')}` : '')
  );
}
