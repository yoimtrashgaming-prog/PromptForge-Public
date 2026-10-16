// System prompt loading and composition.
//
// The prompt files are the product. This module's job is to load them
// correctly, not to author or edit them. Composition order per model:
//
//   1. prompts/_shared/house-rules.md   (prompts.shared_prefix)
//   2. any reference files that exist, in registry order
//   3. the model's own prompt file
//
// House rules go first, matching what house-rules itself states: "Model-
// specific instructions follow this block and always take precedence on
// matters of format." The model's own file goes last so that precedence is
// positional as well as stated — see the note at the push site below.
//
// Missing reference files degrade rather than crash — a warning naming the
// file, and a note appended so the model can say in its Reasoning segment
// that it worked without the official guides.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SEPARATOR = '\n\n---\n\n';

/**
 * What the model cannot know: what day it is.
 *
 * A language model's sense of "now" is its training cutoff, so chat answers
 * "what day is it" with a confident wrong date - observed 22 Aug 2026, when
 * it said April 5, 2024 - and, worse, answers "the newest Illustrious
 * version" the same way without noticing it is guessing. On a box whose whole
 * subject is model versions that ship monthly, that is the difference between
 * a useful answer and a plausible one.
 *
 * Composed at REQUEST time, never cached. The prompt store caches at boot and
 * this server is meant to run for weeks, so a date baked in at startup would
 * be wrong by more than the model's own guess within a fortnight.
 *
 * Appended last, so it gets the final word - the same composition rule that
 * moved a model's own file after its reference material.
 *
 * `now` is injectable so this is testable without waiting a day.
 */
// A blank line, built rather than escaped. Escapes in this file have been
// eaten by a tooling round trip more than once; this cannot be.
const BLANK = String.fromCharCode(10, 10);

export function runtimeContext(now = new Date()) {
  // Long form with the weekday: "22/08/2026" is ambiguous across the group's
  // locales and a model will read it either way.
  const date = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  // Whatever the box is set to. Named rather than assumed UTC, because the
  // times people ask about are the ones on their own clocks.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local time';
  return (
    `## Right now${BLANK}` +
    `Today is ${date}. The time on this machine is ${time} (${zone}).${BLANK}` +
    'Your training data is older than this. Anything you recall as "the ' +
    'latest" version of a model, tool or site may have been superseded - say ' +
    'so rather than answering from memory, and use the Search button for ' +
    'anything that turns on current fact.'
  );
}

export function createPromptStore(rootDir, config, registry, { warn = console.warn } = {}) {
  let cache = new Map();
  let sharedPrefix = '';
  let loadedAt = null;
  const warnings = [];

  function readIfPresent(rel) {
    const abs = path.join(rootDir, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  }

  function load() {
    cache = new Map();
    warnings.length = 0;

    const sharedRel = config.prompts?.shared_prefix;
    if (sharedRel) {
      const text = readIfPresent(sharedRel);
      if (text == null) {
        // Not fatal, but loud: without house rules the output contract and
        // the content rules are both gone.
        const msg = `shared prefix not found: ${sharedRel} — models will run without house rules`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
        sharedPrefix = '';
      } else {
        sharedPrefix = text.trim();
      }
    }

    for (const model of registry.all()) {
      const own = readIfPresent(model.system_prompt);
      if (own == null) {
        // registry.mjs already fails the boot on this; belt and braces.
        const msg = `${model.key}: system prompt missing at ${model.system_prompt}`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
        continue;
      }

      // Reference files are read ONCE here, not once per composed variant.
      // A model that gates its references by mode composes several times
      // below, and re-reading would repeat every "vanished since boot"
      // warning once per mode.
      const refText = new Map();
      const allRefs = [
        ...(model.reference_files ?? []),
        ...Object.values(model.reference_files_by_mode ?? {}).flat(),
      ];
      for (const rel of allRefs) {
        if (refText.has(rel)) continue;
        const text = readIfPresent(rel);
        if (text == null) {
          const msg = `${model.key}: reference file vanished since boot — ${rel}`;
          warn(`[prompts] ${msg}`);
          warnings.push(msg);
          continue;
        }
        refText.set(rel, `# Reference: ${path.basename(rel)}\n\n${text.trim()}`);
      }

      // One composition, given a set of reference files and the missing ones
      // that belong with them. Called once for the base entry and once per
      // gated mode, so the missing-file WARNINGS are emitted outside it —
      // inside, they would repeat per mode.
      // Mode blocks, read once like the references. Keyed by path because two
      // modes can share one — every h3 base mode uses the same file.
      const modeBlocks = model.mode_blocks ?? {};
      const blockText = new Map();
      for (const rel of new Set(Object.values(modeBlocks).flat())) {
        const text = readIfPresent(rel);
        if (text == null) {
          const msg = `${model.key}: mode block vanished since boot — ${rel}`;
          warn(`[prompts] ${msg}`);
          warnings.push(msg);
          continue;
        }
        blockText.set(rel, text.trim());
      }

      const composeFor = (refs, missing, blocks = []) => {
        const parts = [];
        if (sharedPrefix) parts.push(sharedPrefix);

        for (const rel of refs) {
          const block = refText.get(rel);
          if (block) parts.push(block);
        }

        if (missing.length) {
          parts.push(
            `# Note on reference material\n\n` +
              `The following reference documents were not available on this server:\n` +
              missing.map((m) => `- ${path.basename(m)}`).join('\n') +
              `\n\nWork from your own instructions. Note in your final segment that ` +
              `you worked without the official reference guides, so the user knows ` +
              `the output may not match the published field names exactly.`
          );
        }

        // The model's own prompt file goes LAST, after the reference material.
        //
        // It used to sit directly after the house rules, which put h3's 39,703
        // characters of third-party guide between SKILL.md and the answer — and
        // made the final line of a 56,100-character prompt a worked example
        // ending `non_diegetic_music: N/A`. SKILL.md is the file that defines
        // the ===SEGMENT: contract this app parses; the guides are reference.
        // Reference material should not get the last word over the contract.
        //
        // Consistent with house-rules.md's own claim that model-specific
        // instructions "always take precedence on matters of format" — they
        // still follow the house rules, just no longer ahead of the references.
        parts.push(own.trim());

        // What belongs to this mode alone goes after the model's own file, for
        // the same reason the file goes after the references: the instruction
        // specific to what is being written gets the last word. For h3 that is
        // the difference between a base mode's three fields and REF2VA's six.
        for (const rel of blocks) {
          const text = blockText.get(rel);
          if (text) parts.push(text);
        }

        return parts.join(SEPARATOR);
      };

      const missing = model.missing_reference_files ?? [];
      for (const rel of missing) {
        const msg = `${model.key}: reference file not present — ${rel}`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      }

      const byMode = model.reference_files_by_mode ?? {};
      const missingByMode = model.missing_reference_files_by_mode ?? {};
      const uniq = (xs) => [...new Set(xs)];
      // The fallbacks below take every mode's material, but only the modes the
      // picker offers. A key like h3's "REF2VA labelled" is a variant asked for by
      // name, and its block contradicts plain REF2VA's: carrying both in the
      // fallback would tell the model two different jobs.
      const offered = (map) =>
        Object.entries(map)
          .filter(([mode]) => !Array.isArray(model.modes) || model.modes.includes(mode))
          .flatMap(([, v]) => v);

      // The BASE entry takes the UNION of every mode's files, not none of them.
      //
      // A request that arrives with no mode, or with a mode this registry does
      // not know, then composes exactly what it composed before gating existed.
      // The fallback degrades to the old behaviour and never to a prompt whose
      // official guides have silently gone missing — which is the failure that
      // would be hardest to notice, because the model would simply write
      // worse rather than error.
      //
      // For the nine models with no gating this is byte-for-byte what it
      // always did: both spreads are empty and the loop below never runs.
      cache.set(
        model.key,
        composeFor(
          uniq([...(model.reference_files ?? []), ...Object.values(byMode).flat()]),
          uniq([...missing, ...Object.values(missingByMode).flat()]),
          // Same rule for mode blocks: the fallback carries all of them.
          uniq(offered(modeBlocks))
        )
      );

      // One entry per gated mode, keyed `model::Mode`. The mode is the display
      // string straight from the registry — "Full reference", "Auto detect" —
      // because that is what the control sends and what get() looks up.
      //
      // A mode is gated if it has reference files OR a mode block. A mode with
      // only one of the two takes the ungated answer for the other: every
      // reference file, or every block — more material, never less.
      for (const mode of new Set([...Object.keys(byMode), ...Object.keys(modeBlocks)])) {
        const rels = Object.hasOwn(byMode, mode) ? byMode[mode] : Object.values(byMode).flat();
        const gone = Object.hasOwn(byMode, mode)
          ? missingByMode[mode] ?? []
          : Object.values(missingByMode).flat();
        const blocks = Object.hasOwn(modeBlocks, mode)
          ? modeBlocks[mode]
          : offered(modeBlocks);
        cache.set(
          `${model.key}::${mode}`,
          composeFor(
            uniq([...(model.reference_files ?? []), ...rels]),
            uniq([...missing, ...gone]),
            uniq(blocks)
          )
        );
      }
    }

    // The chat prompt stands alone. **It used to take the same shared prefix
    // as the models, and that was wrong** — owner's call, 22 Aug 2026.
    //
    // house-rules.md is mostly an output contract: five references to
    // `===SEGMENT:` including a worked example, and the rule that nothing may
    // precede the first segment line. chat/default.md then says "The segment
    // format does not apply here. Write normally." Composition order put the
    // correction last, which is right, and the 8B obeyed it — but the 1.7B
    // followed the worked example instead and answered chat in segments, with
    // a Negative prompt reciting the house content rules back at the reader.
    //
    // Chat and prompt assistance are different surfaces that happen to share a
    // box and a list of installed LLMs. Nothing else about them is shared, and
    // a format contract for one leaking into the other was the whole bug.
    //
    // The content rules chat needs it carries itself: chat/default.md has its
    // own `## Content` section covering the same ground. Dropping the prefix
    // does not drop those, which was checked before this changed.
    //
    // prompts.chat_shared_prefix can name a file if a prefix is ever wanted
    // here again. Empty by default, and deliberately NOT shared_prefix.
    const chatOwn = readIfPresent('prompts/chat/default.md');
    if (chatOwn == null) {
      const msg = 'chat prompt missing at prompts/chat/default.md';
      warn(`[prompts] ${msg}`);
      warnings.push(msg);
    } else {
      const chatPrefixRel = config.prompts?.chat_shared_prefix;
      const chatPrefix = chatPrefixRel ? readIfPresent(chatPrefixRel) : null;
      if (chatPrefixRel && chatPrefix == null) {
        const msg = `chat prefix not found: ${chatPrefixRel} — chat runs without it`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      }
      cache.set(
        '__chat__',
        [chatPrefix?.trim(), chatOwn.trim()].filter(Boolean).join(SEPARATOR)
      );
    }

    // The reference vision cross-check (server/visiontags.mjs). Cached under a
    // reserved key like chat is, so POST /api/prompts/reload picks it up too —
    // this one is expected to be tuned by hand more than most, because what a
    // vision pass is worth adding is a judgement and judgement lives in
    // prompts/.
    //
    // Absent is not an error. Without it the cross-check turns itself off and
    // the tagger's output stands, which is what this app did before 29 Aug
    // 2026 and is always a safe answer.
    // How to use the tag search, when there is a tag search to use.
    //
    // Cached under a reserved key so POST /api/prompts/reload picks it up, and
    // appended by the generate route rather than composed in here — it must be
    // present only on the requests that actually got tools, or a model with no
    // tool support is told to call something it does not have.
    //
    // Absent is not an error. Without it the tool is still offered and the
    // model works out what to do from the schema alone, which is what happened
    // on 30 Aug 2026 before this file existed: 14 to 18 searches a generation,
    // and the misses were all concepts it never thought to look up.
    const toolRel = config.prompts?.tag_search;
    if (toolRel) {
      const text = readIfPresent(toolRel);
      if (text == null) {
        const msg = `tag search instructions not found: ${toolRel} — the tool runs unexplained`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__tag_search__', text.trim());
      }
    }

    // The same for read_guidance. Absent is not an error here either: the
    // tool still works from its schema, which lists every document and what
    // each covers, and the schema is what stops the model inventing a name.
    const guidanceRel = config.prompts?.guidance;
    if (guidanceRel) {
      const text = readIfPresent(guidanceRel);
      if (text == null) {
        const msg = `guidance instructions not found: ${guidanceRel} — the tool runs unexplained`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__guidance__', text.trim());
      }
    }

    // The second-pass instruction. Absent means the toggle cannot do anything,
    // which is why the control is gated on this being loaded rather than on
    // the registry alone - offering a switch that silently does nothing is
    // worse than not offering it.
    const secondRel = config.prompts?.second_pass;
    if (secondRel) {
      const text = readIfPresent(secondRel);
      if (text == null) {
        const msg = `second-pass instructions not found: ${secondRel} — the toggle is hidden`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__second_pass__', text.trim());
      }
    }

    const visionRel = config.prompts?.reference_vision;
    if (visionRel) {
      const text = readIfPresent(visionRel);
      if (text == null) {
        const msg = `reference vision prompt not found: ${visionRel} — the tagger cross-check is off`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__reference_vision__', text.trim());
      }
    }

    // The other arm of the reference read: the model tags the picture itself
    // and no tagger runs. Missing means the LLM option is not offered — the
    // account panel gates on it for the same reason the second-pass toggle
    // gates on its file above.
    const refTagsRel = config.prompts?.reference_tags;
    if (refTagsRel) {
      const text = readIfPresent(refTagsRel);
      if (text == null) {
        const msg = `reference tagging prompt not found: ${refTagsRel} — references can only be read by the taggers`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__reference_tags__', text.trim());
      }
    }

    // The read-back. Not either arm of the tag read above: this one produces
    // prose for a person to check, and nothing parses it. Missing means the
    // Analyze button is not offered — same gate, same reason.
    const refAnalysisRel = config.prompts?.reference_analysis;
    if (refAnalysisRel) {
      const text = readIfPresent(refAnalysisRel);
      if (text == null) {
        const msg = `reference analysis prompt not found: ${refAnalysisRel} — the Analyze button is off`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__reference_analysis__', text.trim());
      }
    }

    // The role-isolated blueprint pass that runs before compilation. Absent
    // is not an error and not a degradation: without it the pictures ride
    // along with the compile call, which is what generation did before this
    // pass existed and still works. See config/server.yaml for the argument.
    const blueprintRel = config.prompts?.reference_blueprint;
    if (blueprintRel) {
      const text = readIfPresent(blueprintRel);
      if (text == null) {
        const msg = `reference blueprint prompt not found: ${blueprintRel} — the pictures go straight to the prompt writer instead`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__reference_blueprint__', text.trim());
      }
    }

    // How to read one keyframe off the LTX Director's timeline. Absent is a
    // real configuration and not a degradation: with no reader the timeline
    // is text-only, which is what Director mode was before 10 Sep 2026, and
    // the frontend hides the upload rather than offering a control that
    // silently does nothing.
    const keyframeRel = config.prompts?.director_keyframe;
    if (keyframeRel) {
      const text = readIfPresent(keyframeRel);
      if (text == null) {
        const msg = `director keyframe prompt not found: ${keyframeRel} — the Director's keyframe uploads are off`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__director_keyframe__', text.trim());
      }
    }

    // How to read one h3 reference picture. Absent means off: the pictures go
    // with the prompt call, as they did before 29 Sep 2026.
    const pictureRel = config.prompts?.reference_picture;
    if (pictureRel) {
      const text = readIfPresent(pictureRel);
      if (text == null) {
        const msg = `reference picture prompt not found: ${pictureRel} — h3 pictures go straight to the prompt writer`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__reference_picture__', text.trim());
      }
    }

    // Two sentences per labelled h3 picture, for Retention analysis (5 Oct
    // 2026, the H3 Forge's "As the pictures show"). Absent means off.
    const describeRel = config.prompts?.picture_description;
    if (describeRel) {
      const text = readIfPresent(describeRel);
      if (text == null) {
        const msg = `picture description prompt not found: ${describeRel} — labelled h3 retention goes without descriptions`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__picture_description__', text.trim());
      }
    }

    // Per-segment blocks, cached by "<model>::<label>". Loaded here with
    // everything else so a missing file is one warning at boot rather than a
    // surprise mid-generation.
    for (const model of registry.all()) {
      for (const [label, rel] of Object.entries(model.segment_blocks ?? {})) {
        const text = readIfPresent(rel);
        if (text == null) {
          const msg = `${model.key}: segment block missing for "${label}" — ${rel}`;
          warn(`[prompts] ${msg}`);
          warnings.push(msg);
          continue;
        }
        cache.set(`__segment__${model.key}::${label}`, text.trim());
      }
    }

    const metaRel = config.prompts?.meta_segment;
    if (metaRel) {
      const text = readIfPresent(metaRel);
      if (text == null) {
        const msg = `meta segment prompt not found: ${metaRel} — explaining segments go undescribed`;
        warn(`[prompts] ${msg}`);
        warnings.push(msg);
      } else {
        cache.set('__meta_segment__', text.trim());
      }
    }

    loadedAt = new Date().toISOString();
    return { count: cache.size, warnings: [...warnings], loaded_at: loadedAt };
  }

  load();

  return {
    /**
     * Composed system prompt for a model key, or null.
     *
     * `mode` picks a variant on a model whose reference files are gated by
     * mode — today only h3. An absent mode, or one this registry has never
     * heard of, falls through to the base entry, which carries every mode's
     * references. So the worst case of a bad mode string is the prompt that
     * shipped before gating existed, not a prompt missing its guides.
     */
    get: (key, mode) =>
      (mode != null && cache.get(`${key}::${mode}`)) || cache.get(key) || null,
    /**
     * The segment half of a system prompt: the contract, then one block per
     * segment being asked for.
     *
     * The owner's design, 5 Sep 2026, and it replaces telling the model to
     * write a segment and then telling it not to. Nothing is overridden here
     * because nothing unwanted is ever said — a segment that is switched off
     * is simply not described, and its example is not shown.
     *
     * **Appended, never interleaved.** That is what keeps the base prompt
     * byte-identical for everyone: the shared prefix runs to the end of the
     * model's own file and only this tail differs per person, so the prefix
     * cache still holds. Composing the segment content INTO the file would
     * move the divergence to the top and cost a full prefill each.
     *
     * The contract list is generated from `active` rather than written in the
     * prompt file. It used to be both — the file listed its segments and
     * config/models.yaml declared them — which is one duplication too many
     * for a list the parser enforces exactly.
     *
     * A model with no blocks gets the list alone, which is what every model
     * that has not been split yet already had.
     */
    segmentTail(model, active) {
      const labels = (active ?? model?.segments ?? []).filter(Boolean);
      if (!labels.length) return '';
      const parts = [
        '## Segments to emit\n\n' +
          labels.map((l, i) => `${i + 1}. \`${l}\``).join('\n'),
      ];
      // The shared guidance for an explaining segment goes in front of the
      // first one this model has, so it reads as an introduction to that block
      // rather than as a footnote after it. Once, even on wan, which has two.
      const meta = new Set(model?.meta_segments ?? []);
      let metaDone = false;
      for (const label of labels) {
        if (meta.has(label) && !metaDone) {
          const shared = cache.get('__meta_segment__');
          if (shared) parts.push(shared);
          metaDone = true;
        }
        const block = cache.get(`__segment__${model.key}::${label}`);
        if (block) parts.push(block);
      }
      return parts.join(SEPARATOR);
    },

    chat: () => cache.get('__chat__') ?? null,

    /** Instructions for the reference image cross-check, or null when absent. */
    referenceVision: () => cache.get('__reference_vision__') ?? null,

    /** Instructions for reading a reference image with no tagger, or null. */
    referenceTags: () => cache.get('__reference_tags__') ?? null,

    /** How to read a reference back to the person before generating, or null.
     *  Prose, unparsed — see the file for why it is not the tag contract. */
    referenceAnalysis: () => cache.get('__reference_analysis__') ?? null,

    /** The role-isolated read that runs ahead of compilation, or null when
     *  the file is not on this box — in which case the pictures travel with
     *  the compile call instead. */
    referenceBlueprint: () => cache.get('__reference_blueprint__') ?? null,

    /** How to read one LTX Director keyframe, or null when it is switched off. */
    directorKeyframe: () => cache.get('__director_keyframe__') ?? null,

    /** How to read one h3 reference picture, or null when it is switched off. */
    referencePicture: () => cache.get('__reference_picture__') ?? null,
    pictureDescription: () => cache.get('__picture_description__') ?? null,

    /** How to use the tag search, appended only when tools were offered. */
    tagSearch: () => cache.get('__tag_search__') ?? null,

    /** How to use read_guidance, appended only when that tool was offered. */
    guidance: () => cache.get('__guidance__') ?? null,

    /** The revision instruction, or null when the file is not on this box. */
    secondPass: () => cache.get('__second_pass__') ?? null,

    /**
     * A system prompt someone wrote themselves, in place of the model's file.
     *
     * Asked for on 28 Aug 2026: "the system prompt that would allow users to
     * inject into a model like how we do", and the owner's call was that a
     * user's block REPLACES the model's own file rather than being appended
     * to it. So this composes house rules plus their text, and nothing else —
     * not the model's `.md`, and not its reference files, because a
     * replacement that quietly kept 39,703 characters of h3 guide would not
     * be the thing they asked for.
     *
     * **The house rules stay, and that is deliberate.** They are mostly the
     * output contract — the `===SEGMENT:` format this app's parser is built
     * on — so keeping them is what stops a hand-written block from producing
     * something unparseable on its first run. Whoever writes a block still
     * owns which segments they emit; house-rules only tells them the shape.
     *
     * The model's shipped prompt is untouched and one click away: this
     * composes on demand and writes nothing into the cache.
     */
    compose: (body) =>
      [sharedPrefix, String(body ?? '').trim()].filter(Boolean).join(SEPARATOR),
    reload: load,
    info: () => ({
      loaded_at: loadedAt,
      count: cache.size,
      keys: [...cache.keys()],
      warnings: [...warnings],
      shared_prefix_loaded: Boolean(sharedPrefix),
    }),
  };
}
