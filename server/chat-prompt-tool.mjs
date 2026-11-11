// Chat's write_prompt tool: a prompt for one of the app's models, written by
// that model's own prompt writer.
//
// 2 Oct 2026, the owner's idea. Asked in chat for "a Krea2 prompt", the chat
// model wrote booru tags ("krea2, 1girl, sailor, ... masterpiece") - chat knows
// none of the dialects this app exists for. Teaching chat ten dialects would be
// a second, worse copy of prompts/. Instead chat gets one tool, and a call to it
// runs the real generation for that model (handleGenerate, in process), so the
// answer is exactly what that model's tab would have written.
//
// The prompt reaches the person verbatim, written into the reply by code. The
// chat model is not given a second turn to present it, because a model that
// "tidies" a Krea2 prompt turns it back into tags.
//
// Every model in the registry is offered, by key; adding a model to
// config/models.yaml adds it here with no code change.

/**
 * The words code writes into a chat reply, per interface language (11 Nov
 * 2026: a French chat came back with English labels around a French answer).
 * Only these few lines: the prompt itself stays as its writer wrote it,
 * because the image and video models read English.
 */
const CHAT_TEXT = {
  en: {
    written: (n) => `${n} prompt, written by the ${n} prompt writer:`,
    reopen: (n) => `To change its settings or write it again, open the ${n} tab.`,
    couldNot: (n, e) => `The ${n} prompt writer could not write this one: ${e}`,
    declined: (n) => `The ${n} prompt writer declined this one.`,
    whichModel: (list) => `Which model should this prompt be for? I can write one for ${list}.`,
    whichRender: (list) => `Which model should this picture be made with? I can render with ${list}.`,
    noBrief: (n) => `No description was given for the ${n} prompt.`,
    badFormat: (n, list) => `${n} has no format by that name. Its formats: ${list}.`,
    unreadable: 'The prompt request was not readable.',
    rendered: (n) => `Rendered with ${n}`,
    renderFailed: (e) => `The render did not finish: ${e}`,
    edited: (n) => `Edited with ${n}. The instruction it was given:`,
    editFailed: (e) => `The edit did not finish: ${e}`,
    whatToChange: 'What should change in the picture?',
  },
  fr: {
    written: (n) => `Prompt ${n}, écrit par le rédacteur de prompts ${n} :`,
    reopen: (n) => `Pour changer ses réglages ou le réécrire, ouvrez l’onglet ${n}.`,
    couldNot: (n, e) => `Le rédacteur de prompts ${n} n’a pas pu écrire celui-ci : ${e}`,
    declined: (n) => `Le rédacteur de prompts ${n} a refusé celui-ci.`,
    whichModel: (list) => `Pour quel modèle faut-il écrire ce prompt ? Je peux en écrire pour ${list}.`,
    whichRender: (list) => `Avec quel modèle faut-il faire cette image ? Je peux faire le rendu avec ${list}.`,
    noBrief: (n) => `Aucune description n’a été donnée pour le prompt ${n}.`,
    badFormat: (n, list) => `${n} n’a pas de format de ce nom. Ses formats : ${list}.`,
    unreadable: 'La demande de prompt était illisible.',
    rendered: (n) => `Rendu avec ${n}`,
    renderFailed: (e) => `Le rendu n’a pas abouti : ${e}`,
    edited: (n) => `Modifié avec ${n}. L’instruction donnée :`,
    editFailed: (e) => `La modification n’a pas abouti : ${e}`,
    whatToChange: 'Que faut-il changer dans l’image ?',
  },
  de: {
    written: (n) => `${n}-Prompt, geschrieben vom ${n}-Promptschreiber:`,
    reopen: (n) => `Um die Einstellungen zu ändern oder ihn neu zu schreiben, öffne den Tab ${n}.`,
    couldNot: (n, e) => `Der ${n}-Promptschreiber konnte diesen nicht schreiben: ${e}`,
    declined: (n) => `Der ${n}-Promptschreiber hat diesen abgelehnt.`,
    whichModel: (list) => `Für welches Modell soll dieser Prompt sein? Ich kann einen schreiben für ${list}.`,
    whichRender: (list) => `Mit welchem Modell soll dieses Bild entstehen? Ich kann rendern mit ${list}.`,
    noBrief: (n) => `Für den ${n}-Prompt wurde keine Beschreibung angegeben.`,
    badFormat: (n, list) => `${n} hat kein Format mit diesem Namen. Seine Formate: ${list}.`,
    unreadable: 'Die Prompt-Anfrage war nicht lesbar.',
    rendered: (n) => `Gerendert mit ${n}`,
    renderFailed: (e) => `Das Rendern wurde nicht fertig: ${e}`,
    edited: (n) => `Bearbeitet mit ${n}. Die Anweisung dafür:`,
    editFailed: (e) => `Die Bearbeitung wurde nicht fertig: ${e}`,
    whatToChange: 'Was soll sich am Bild ändern?',
  },
};

/** The reply words for a language, English for one with no table. */
export function chatText(lang) {
  return CHAT_TEXT[lang] ?? CHAT_TEXT.en;
}

/** The language names the chat model is told to answer in. */
const LANGUAGE_NAMES = { fr: 'French', de: 'German' };

/**
 * The line that tells the chat model which language to answer in, from the
 * person's interface language, or '' for English (the prompts' own
 * language, and then nothing is added).
 */
export function chatLanguageLine(lang) {
  const name = LANGUAGE_NAMES[lang];
  if (!name) return '';
  return `The person has set PromptForge to ${name}. Write your replies in ${name}, all of them, ` +
    'including questions and lists. A prompt the tools return stays exactly as it was written.';
}

/**
 * The format and detail properties shared by write_prompt and render_picture.
 * Without them chat always wrote in the tab's default format and detail:
 * MOSS was Natural language only, and an I2VA prompt sent back for a change
 * came back as Auto detect / REF2VA (a user's report, 10 Nov 2026).
 */
function formatAndDetail(models) {
  const withModes = models.filter((m) => Array.isArray(m.modes) && m.modes.length);
  const formats = withModes.map((m) => `${m.name}: ${m.modes.join(', ')}`).join('; ');
  return {
    ...(withModes.length ? {
      format: {
        type: 'string',
        description:
          `The format to write in, for a model that has more than one (${formats}). ` +
          'Use the one the person asked for. When changing an existing prompt, use the format that ' +
          'prompt is in. Leave out to use the model\'s default.',
      },
    } : {}),
    detail: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description:
        'How long and detailed the prompt should be, 1 (short, bare) to 10 (long, everything ' +
        'described). Set it when the person asks for a short or a long prompt; leave out otherwise.',
    },
  };
}

/** The tool definition for the chat request, or null when there are no models. */
export function promptToolFor(models = []) {
  if (!models.length) return null;
  const list = models.map((m) => `${m.key} = ${m.name}${m.format_label ? ` (${m.format_label})` : ''}`).join('; ');
  return {
    type: 'function',
    function: {
      name: 'write_prompt',
      description:
        'Write a finished prompt for one of PromptForge\'s image or video models, using that ' +
        'model\'s own prompt writer, which knows its exact format. Call it whenever the person ' +
        'asks for a prompt for one of these models, or asks to change one (one it wrote, or one ' +
        'they paste in), instead of writing or editing the prompt yourself. ' +
        `${WHICH_MODEL} Models: ${list}.`,
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: models.map((m) => m.key), description: 'Which model the prompt is for. Leave out when they have not said.' },
          brief: {
            type: 'string',
            description:
              'What the picture or clip should show, in the person\'s own words, with everything ' +
              'they asked for (subject, style, mood, characters, setting). Do not write the prompt here. ' +
              'To change an existing prompt, put that whole prompt here followed by the change they asked for.',
          },
          ...formatAndDetail(models),
        },
        required: ['brief'],
      },
    },
  };
}

/**
 * Who asks "which model?" — the app, not the chat model (11 Nov 2026). Asked
 * to ask, the 27B began in French and finished the question in English on
 * every run, however the language line was worded, and sometimes skipped the
 * question and picked a model itself. Called without a model, the tool answers
 * with chatText's whichModel, in the person's language, every time.
 */
const WHICH_MODEL =
  'If they have not said which model, call it with model left out: the app asks them which one. ' +
  'Never choose a model for them.';

/**
 * The call's arguments as { model, brief, mode, detail }, or { error } in
 * words the person can read. Arguments arrive as a JSON string on some
 * backends and an object on others (see guidance-never-opened in the project
 * notes). mode and detail are null when not asked for.
 */
export function promptToolArgs(raw, models = [], lang = 'en') {
  const t = chatText(lang);
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw || '{}'); } catch { return { error: t.unreadable }; }
  }
  const key = String(args?.model ?? '').trim().toLowerCase();
  const model = models.find((m) => m.key.toLowerCase() === key || m.name.toLowerCase() === key);
  // Asked for "a prompt for a sunset" with no model named, the chat model
  // called this with model "sunset" (2 Oct 2026). The useful answer to an
  // unknown or missing model is the question it should have asked.
  if (!model) return { error: t.whichModel(models.map((m) => m.name).join(', ')) };
  const brief = String(args?.brief ?? '').trim();
  if (!brief) return { error: t.noBrief(model.name) };

  // A format the model does not have is said out loud rather than quietly
  // replaced by the default, which is the bug this argument exists to fix.
  let mode = null;
  const askedFormat = String(args?.format ?? '').trim();
  if (askedFormat && Array.isArray(model.modes) && model.modes.length) {
    mode = model.modes.find((m) => m.toLowerCase() === askedFormat.toLowerCase()) ?? null;
    if (!mode) return { error: t.badFormat(model.name, model.modes.join(', ')) };
  }
  const n = Math.round(Number(args?.detail));
  const detail = Number.isFinite(n) && args?.detail !== null && args?.detail !== '' ? Math.min(10, Math.max(1, n)) : null;
  return { model, brief, mode, detail };
}

/**
 * Chat's render_picture tool (4 Oct 2026, the owner's "all-in-one UI"): the
 * prompt is written by the model's own writer, exactly as write_prompt does,
 * and then rendered in ComfyUI through the same route as the Render button —
 * same permission, queue, workflow and presets. Only models that can render
 * are offered, and only to someone allowed to.
 *
 * `same_prompt` renders the prompt chat just wrote for that model instead of
 * writing a new one, for "render that". Without it, "render that" would
 * rewrite the prompt and draw something the person never read.
 */
export function renderToolFor(models = []) {
  if (!models.length) return null;
  const list = models.map((m) => `${m.key} = ${m.name}`).join('; ');
  return {
    type: 'function',
    function: {
      name: 'render_picture',
      description:
        'Make a picture: writes the prompt with that model\'s own prompt writer and renders it ' +
        'on this server. Call it when the person asks you to make, draw, render or generate an ' +
        'image (not just a prompt). If they want the prompt you just wrote rendered as it is, ' +
        `set same_prompt to true. ${WHICH_MODEL} Models: ${list}.`,
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: models.map((m) => m.key), description: 'Which model draws it. Leave out when they have not said.' },
          brief: {
            type: 'string',
            description:
              'What the picture should show, in the person\'s own words, with everything they asked ' +
              'for. Do not write the prompt here.',
          },
          same_prompt: {
            type: 'boolean',
            description: 'True to render the prompt you most recently wrote for this model, unchanged.',
          },
          aspect: {
            type: 'string',
            description:
              'The aspect ratio they asked for, as width:height, e.g. "1:1", "16:9", "2:3". ' +
              'Leave out if they did not say.',
          },
          resolution: {
            type: 'string',
            description:
              'The resolution they asked for, e.g. "1080p", "720p", or a size like "1920x1080". ' +
              'Leave out if they did not say.',
          },
          ...formatAndDetail(models),
        },
        required: ['brief'],
      },
    },
  };
}

/**
 * The size a render call asked for, as { aspect: "W:H" | null, tier: short
 * side | null }. Before 5 Oct 2026 the tool had no size fields at all, so
 * "1:1 at around 1080p" was dropped and the workflow's 832×1216 drawn.
 *
 * Lenient on purpose — a model writes these however it likes: "1:1",
 * "1x1", "square", "1080p", "1080", "1920x1080". A pixel size gives both
 * the ratio and the short side. The tier snaps to the nearest one the
 * Resolution control offers, so chat can never ask for a size the pop-out
 * could not.
 */
export function renderSizeArgs(args = {}, tiers = []) {
  let aspect = null;
  let tier = null;
  const pair = (s) => {
    const m = /(\d+)\s*[:x×*\/]\s*(\d+)/i.exec(String(s ?? ''));
    return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? [Number(m[1]), Number(m[2])] : null;
  };
  const rawAspect = String(args?.aspect ?? '').trim();
  const rawRes = String(args?.resolution ?? '').trim();
  const a = pair(rawAspect);
  if (a) aspect = `${a[0]}:${a[1]}`;
  else if (/\bsquare\b/i.test(rawAspect)) aspect = '1:1';

  let short = null;
  const r = pair(rawRes);
  if (r && Math.min(...r) >= 256) {
    // A pixel size: its own ratio unless one was named, and its short side.
    if (!aspect) aspect = `${r[0]}:${r[1]}`;
    short = Math.min(...r);
  } else {
    const n = /(\d{3,4})\s*p?\b/i.exec(rawRes);
    if (n) short = Number(n[1]);
    else if (/\b4k\b/i.test(rawRes)) short = 2160;
    else if (/\b2k\b/i.test(rawRes)) short = 1440;
  }
  if (short && tiers.length) {
    tier = tiers.reduce((best, t) => (Math.abs(t - short) < Math.abs(best - short) ? t : best), tiers[0]);
  }
  return { aspect, tier };
}

/** render_picture's arguments as { model, brief, same }, or { error }. */
export function renderToolArgs(raw, models = [], lang = 'en') {
  const base = promptToolArgs(raw, models, lang);
  if (base.error) {
    // "Which model should this prompt be for" reads oddly for a picture.
    const t = chatText(lang);
    const list = models.map((m) => m.name).join(', ');
    return { error: base.error === t.whichModel(list) ? t.whichRender(list) : base.error };
  }
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw || '{}'); } catch { args = {}; }
  }
  return {
    ...base,
    same: args?.same_prompt === true || args?.same_prompt === 'true',
    aspect: args?.aspect ?? null,
    resolution: args?.resolution ?? null,
  };
}

/**
 * Chat's edit_picture tool (4 Oct 2026): change the latest picture in the
 * conversation — one the person sent, or the last edit — with the image
 * editor. The server picks the picture; the model only says what to change,
 * in the person's words, and the edit's own writer turns that into what the
 * editor reads.
 */
export function editToolFor(label) {
  return {
    type: 'function',
    function: {
      name: 'edit_picture',
      description:
        `Edit a picture with ${label}: change, add, remove, recolour or restyle something in it. ` +
        'It works on the latest picture in this conversation, whether the person sent it or it is ' +
        'an edit you made, so "now make it night" edits the last result. Call it when the person ' +
        'asks for a change to a picture. The edited picture is shown to them.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'What to change, in the person\'s own words, with everything they asked for.',
          },
        },
        required: ['instruction'],
      },
    },
  };
}

/** edit_picture's arguments as { instruction }, or { error }. */
export function editToolArgs(raw, lang = 'en') {
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw || '{}'); } catch { args = {}; }
  }
  const instruction = String(args?.instruction ?? '').trim();
  return instruction ? { instruction } : { error: chatText(lang).whatToChange };
}

/** The reply an edit carries: the instruction the editor was given, so the picture is never shown without what made it. */
export function editReply(label, prompt, ms, lead = '', lang = 'en') {
  return [
    lead.trim(),
    chatText(lang).edited(label),
    prompt,
    ms ? `${(ms / 1000).toFixed(1)} s` : null,
  ].filter(Boolean).join('\n\n');
}

/**
 * The text a render reply carries: the prompt that was drawn, so the picture
 * is never shown without what made it, and one line saying how it was made.
 */
export function renderReply(model, segments, render, lead = '', lang = 'en') {
  const s = render.settings ?? {};
  const how = [
    chatText(lang).rendered(model.name),
    s.model_file ? s.model_file.replace(/\.safetensors$/, '') : null,
    s.steps ? `${s.steps} steps` : null,
    s.width ? `${s.width}×${s.height}` : null,
    s.seed !== undefined ? `seed ${s.seed}` : null,
    render.ms ? `${(render.ms / 1000).toFixed(1)} s` : null,
  ].filter(Boolean).join(' · ');
  return [lead.trim(), promptReply(model, segments, '', lang).split('\n\n').slice(0, -1).join('\n\n'), how].filter(Boolean).join('\n\n');
}

/**
 * The reply text for a finished generation: each segment that is part of the
 * prompt, labelled, as written. Meta segments (reasoning, notes) stay in the
 * model's own tab.
 */
export function promptReply(model, segments = [], lead = '', lang = 'en') {
  const t = chatText(lang);
  const meta = new Set(model.meta_segments ?? []);
  const shown = segments.filter((s) => s.body?.trim() && !meta.has(s.label) && !/^N\/A$/i.test(s.body.trim()));
  const body = shown.length === 1
    ? shown[0].body.trim()
    : shown.map((s) => `${s.label}:\n${s.body.trim()}`).join('\n\n');
  return [
    lead.trim(),
    t.written(model.name),
    body,
    t.reopen(model.name),
  ].filter(Boolean).join('\n\n');
}
