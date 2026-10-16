// Chat's write_prompt tool: the definition, the arguments, the reply text,
// and the GPU architecture names chat is told.
//
//   node scripts/test-chat-prompt-tool.mjs
//
// No server, no model.

import { promptToolFor, promptToolArgs, promptReply, renderToolFor, renderToolArgs, renderSizeArgs, renderReply } from '../server/chat-prompt-tool.mjs';
import { architectureOf } from '../server/sysmon.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

const MODELS = [
  { key: 'krea2', name: 'Krea2', format_label: 'Natural language format', meta_segments: ['What changed'] },
  { key: 'wan', name: 'Wan 2.2', format_label: 'Four-layer natural language', meta_segments: ['Layer breakdown', 'Reasoning'] },
];

// ── the definition ───────────────────────────────────────────
const def = promptToolFor(MODELS);
check('named write_prompt', def.function.name === 'write_prompt');
check('every model is offered by key', JSON.stringify(def.function.parameters.properties.model.enum) === '["krea2","wan"]');
check('the description names each model and its format', /krea2 = Krea2 \(Natural language format\)/.test(def.function.description));
check('model and brief are required', JSON.stringify(def.function.parameters.required) === '["model","brief"]');
check('no models, no tool', promptToolFor([]) === null);

// ── the arguments ────────────────────────────────────────────
check('JSON-string arguments are read', promptToolArgs('{"model":"krea2","brief":"a sailor"}', MODELS).model?.key === 'krea2');
check('object arguments are read', promptToolArgs({ model: 'wan', brief: 'a car' }, MODELS).model?.key === 'wan');
check('the model may be given by name', promptToolArgs({ model: 'Krea2', brief: 'x' }, MODELS).model?.key === 'krea2');
check('an unknown model asks which one, naming them', promptToolArgs({ model: 'sunset', brief: 'x' }, MODELS).error === 'Which model should this prompt be for? I can write one for Krea2, Wan 2.2.');
check('a missing model asks too', /^Which model/.test(promptToolArgs({ brief: 'x' }, MODELS).error ?? ''));
check('an empty brief is an error', /No description/.test(promptToolArgs({ model: 'krea2', brief: ' ' }, MODELS).error ?? ''));
check('unreadable JSON is an error, not a throw', /not readable/.test(promptToolArgs('{oops', MODELS).error ?? ''));

// ── the reply ────────────────────────────────────────────────
const one = promptReply(MODELS[0], [{ label: 'Enhanced prompt', body: 'A sailor in a storm.' }, { label: 'What changed', body: 'notes' }]);
check('a single segment is shown bare, as written', one.includes('\n\nA sailor in a storm.\n\n'), one);
check('meta segments stay out', !one.includes('notes'), one);
check('it says which writer wrote it', one.startsWith('Krea2 prompt, written by the Krea2 prompt writer:'), one);
check('it points at the tab', /open the Krea2 tab/.test(one));
const two = promptReply(MODELS[1], [{ label: 'Positive prompt', body: 'A car drifts.' }, { label: 'Negative prompt', body: 'blur' }, { label: 'Reasoning', body: 'why' }]);
check('several segments are labelled', two.includes('Positive prompt:\nA car drifts.') && two.includes('Negative prompt:\nblur'), two);
check('N/A segments are left out', !promptReply(MODELS[1], [{ label: 'Positive prompt', body: 'x' }, { label: 'Negative prompt', body: 'N/A' }]).includes('Negative'));
check('what the chat model said first comes first', promptReply(MODELS[0], [{ label: 'Enhanced prompt', body: 'p' }], 'Here you go.').startsWith('Here you go.\n\nKrea2 prompt'));

// ── render_picture ───────────────────────────────────────────
const rdef = renderToolFor(MODELS.slice(0, 1));
check('render_picture is named and offers only the models given', rdef.function.name === 'render_picture' && JSON.stringify(rdef.function.parameters.properties.model.enum) === '["krea2"]');
check('...says to ask when no model was named', /ask them first/.test(rdef.function.description));
check('no renderable models, no tool', renderToolFor([]) === null);
check('same_prompt is read as a boolean', renderToolArgs({ model: 'krea2', brief: 'x', same_prompt: true }, MODELS).same === true);
check('...and as the string a backend may send', renderToolArgs('{"model":"krea2","brief":"x","same_prompt":"true"}', MODELS).same === true);
check('...off when absent', renderToolArgs({ model: 'krea2', brief: 'x' }, MODELS).same === false);
check('an unknown model asks which to render with', /render with Krea2/.test(renderToolArgs({ model: 'nope', brief: 'x' }, MODELS).error ?? ''));
const rr = renderReply(MODELS[0], [{ label: 'Enhanced prompt', body: 'A sailor.' }], { settings: { steps: 8, width: 832, height: 1216, seed: 5, model_file: 'krea2_turbo.safetensors' }, ms: 16800 }, 'Here it is.');
check('the render reply carries the prompt that was drawn', rr.includes('A sailor.'), rr);
check('...and how it was made', rr.endsWith('Rendered with Krea2 · krea2_turbo · 8 steps · 832×1216 · seed 5 · 16.8 s'), rr);
check('...not the "open the tab" line meant for a prompt alone', !/open the Krea2 tab/.test(rr));
check('...after what the chat model said', rr.startsWith('Here it is.'));

// ── render size (5 Oct: "1:1 at around 1080p" drew 832x1216) ──
const T = [480, 720, 1080, 1440];
const sz = (a) => JSON.stringify(renderSizeArgs(a, T));
check('the tool offers aspect and resolution', 'aspect' in rdef.function.parameters.properties && 'resolution' in rdef.function.parameters.properties);
check('renderToolArgs passes them through', renderToolArgs('{"model":"krea2","brief":"x","aspect":"1:1","resolution":"1080p"}', MODELS).aspect === '1:1');
check('1:1 at 1080p', sz({ aspect: '1:1', resolution: '1080p' }) === '{"aspect":"1:1","tier":1080}', sz({ aspect: '1:1', resolution: '1080p' }));
check('square is 1:1', sz({ aspect: 'square' }) === '{"aspect":"1:1","tier":null}');
check('1x1 is 1:1', sz({ aspect: '1x1' }) === '{"aspect":"1:1","tier":null}');
check('a pixel size gives ratio and short side', sz({ resolution: '1920x1080' }) === '{"aspect":"1920:1080","tier":1080}', sz({ resolution: '1920x1080' }));
check('a named aspect beats a pixel size', sz({ aspect: '1:1', resolution: '1920x1080' }) === '{"aspect":"1:1","tier":1080}');
check('a tier snaps to the nearest offered', sz({ resolution: '1024' }) === '{"aspect":null,"tier":1080}');
check('4k snaps to the top tier', sz({ resolution: '4K' }) === '{"aspect":null,"tier":1440}');
check('nothing asked, nothing set', sz({}) === '{"aspect":null,"tier":null}');

// ── architecture names ───────────────────────────────────────
check('7.0 is Volta (this box\'s V100)', architectureOf('7.0') === 'Volta');
check('6.1 is Pascal (the P40)', architectureOf('6.1') === 'Pascal');
check('8.6 is Ampere (a 3080 Ti)', architectureOf('8.6') === 'Ampere');
check('8.9 is Ada Lovelace', architectureOf('8.9') === 'Ada Lovelace');
check('12.0 is Blackwell', architectureOf('12.0') === 'Blackwell');
check('nothing known, no name', architectureOf(undefined) === null && architectureOf('[N/A]') === null);

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
