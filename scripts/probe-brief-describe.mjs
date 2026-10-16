// Does the picture reader use the brief? Runs the describe step the way the
// server does — same instruction, same message, thinking off, temperature
// 0.2 — once with no brief and once with one, and prints both in full.
//
//   node scripts/probe-brief-describe.mjs <image> <character|place> <brief words…>   (PROBE_MODEL= to pick a model)
//
// Needs llama-swap on 127.0.0.1:8099. Run it on the Z440.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { applyPictureLabels, labelledCast, describeUnits, describeMessage } from '../server/picture-labels.mjs';

// The brief is the rest of the words: the sync script splits quoted arguments.
const [image, kind = 'character', ...words] = process.argv.slice(2);
const brief = words.join(' ');
const model = process.env.PROBE_MODEL || 'hf.co/HauhauCS/Qwen3.8-27B-Uncensored-Aggressive:Q4_K_P';
if (!image) { console.error('usage: probe-brief-describe.mjs <image> <character|place> <brief words…>'); process.exit(1); }
const mime = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[extname(image).toLowerCase()];
const url = `data:${mime};base64,${readFileSync(image).toString('base64')}`;
const system = readFileSync(new URL('../prompts/_shared/picture-description.md', import.meta.url), 'utf8').trim();

const label = kind === 'place' ? 'place' : 'character-1';
const refs = applyPictureLabels({ picture_labels: true, mode: 'REF2VA', references: [{ kind: 'image', picture_label: label, picture_kinds: [kind], ...(kind === 'character' ? { who: [1] } : {}), image: url }] }).references;
const [unit] = describeUnits(labelledCast(refs));

async function read(b) {
  const res = await fetch('http://127.0.0.1:8099/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 240,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text: describeMessage(unit, b) }, { type: 'image_url', image_url: { url } }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()).choices[0].message.content.trim();
}

for (const b of ['', brief]) {
  console.log(`\n── ${b ? `brief: ${b}` : 'no brief'} ──`);
  console.log(JSON.stringify(await read(b)));
}
