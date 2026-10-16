// Both ways a model looks at a reference image.
//
//   node scripts/test-visiontags.mjs
//
// No server, no model, no GPU. The network call is stubbed, so what is under
// test is the part that decides what reaches a prompt: the two output
// contracts' parsers, the confidence floor that stops a model overruling a
// confident tagger, and the tag database check that stops an invented tag
// through.
//
// The bug this exists to keep fixed is the silent one. The cross-check
// returns null on every failure path, and null means "the tagger's list
// stands" — correct behaviour, and indistinguishable from the feature being
// switched off. A parser that quietly stopped matching would look exactly
// like a working app.

import { createVisionTags, parseDecision, parseTagReading } from '../server/visiontags.mjs';

let passed = 0;
const failures = [];

function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── the parser ───────────────────────────────────────────────

{
  const d = parseDecision('KEEP: 1girl, blue_hair\nDROP: lace\nADD: backlighting');
  check('reads all three lines', eq(d?.keep, ['1girl', 'blue_hair']) && eq(d?.drop, ['lace']) && eq(d?.add, ['backlighting']));
}

check(
  'the word none is an empty list, not a tag called none',
  eq(parseDecision('KEEP: 1girl\nDROP: none\nADD: none')?.drop, [])
);

check(
  'a missing KEEP line fails closed',
  parseDecision('DROP: everything\nADD: nothing') === null,
  'a reply that ignored the format must not read as "drop all tags"'
);

check('UNAVAILABLE is not a tag list', parseDecision('UNAVAILABLE') === null);
check('empty output fails closed', parseDecision('') === null);

check(
  'prose around the contract does not break it',
  eq(parseDecision('Sure! Here you go:\nKEEP: 1girl\nDROP: none\nADD: none')?.keep, ['1girl'])
);

check(
  'spaces become underscores, case is normalised',
  eq(parseDecision('KEEP: Long Hair, BLUE_HAIR\nDROP: none\nADD: none')?.keep, ['long_hair', 'blue_hair'])
);

// ── the guards ───────────────────────────────────────────────

/** A tag database that knows a handful of tags and nothing else.
 *
 *  Categories are danbooru's codes — 0 general, 1 artist, 4 character, 5 meta
 *  — because the LLM-only arm sorts on them: a character has to reach the
 *  character line whichever line the model wrote it on, and an artist name is
 *  not a description of the picture. */
const CATS = {
  backlighting: 0,
  wet: 0,
  from_above: 0,
  ancient_tag: 0,
  frieren: 4,
  '1girl': 0,
  elf: 0,
  some_artist: 1,
  highres: 5,
};
const fakeStore = {
  loaded: true,
  exactRows: (t) => (t in CATS ? [{ tag: t, category: CATS[t] }] : []),
  isDeprecated: (t) => t === 'ancient_tag',
  postCount: (t) => (t === 'wet' ? 3 : 5000),
};

function stubReply(content) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content } }) });
}

const build = (settings) =>
  createVisionTags({
    baseUrl: 'http://x/v1',
    tagStore: fakeStore,
    getPrompt: () => 'instructions',
    getDescribePrompt: () => 'read it',
    settings,
    warn: () => {},
  });

const general = [
  { tag: 'long_hair', confidence: 0.97 },
  { tag: 'lace', confidence: 0.41 },
  { tag: '1girl', confidence: 0.99 },
];
const image = Buffer.from('not really a png');

{
  stubReply('KEEP: 1girl\nDROP: lace, long_hair\nADD: none');
  const out = await build({}).refine(image, { model: 'm', general });
  check('a low-confidence tag can be dropped', eq(out?.dropped, ['lace']));
  check(
    'a confident tag is refused, and the refusal is reported',
    eq(out?.refused, ['long_hair']),
    'the floor is a guess and cannot be judged if it is invisible'
  );
  check('refused tags survive into the output', out?.tags.some((t) => t.tag === 'long_hair'));
}

{
  stubReply('KEEP: 1girl\nDROP: none\nADD: backlighting, rain_slicked_concrete, ancient_tag, wet');
  const out = await build({}).refine(image, { model: 'm', general });
  check('a real, used tag is added', eq(out?.added, ['backlighting']));
  check(
    'an invented tag never reaches the prompt',
    out?.rejected.some((r) => r.tag === 'rain_slicked_concrete' && r.why === 'not a danbooru tag'),
    'the whole point of the cross-reference'
  );
  check('a deprecated tag is rejected', out?.rejected.some((r) => r.tag === 'ancient_tag' && r.why === 'deprecated'));
  check('a real but unused tag is rejected', out?.rejected.some((r) => r.tag === 'wet' && r.why === 'too rare'));
  check('added tags carry no invented confidence', out?.tags.find((t) => t.tag === 'backlighting')?.confidence === null);
}

{
  stubReply('KEEP: 1girl\nDROP: none\nADD: backlighting, from_above');
  const out = await build({ max_added: 1 }).refine(image, { model: 'm', general });
  check('max_added is a ceiling', out?.added.length === 1);
}

{
  stubReply('KEEP: 1girl\nDROP: none\nADD: backlighting');
  const out = await build({ enabled: false }).refine(image, { model: 'm', general });
  check('disabled means the tagger list stands', out === null);
}

{
  stubReply('I had a look and the picture seems fine to me.');
  const out = await build({}).refine(image, { model: 'm', general });
  check('an unparseable reply changes nothing', out === null);
}

{
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const out = await build({}).refine(image, { model: 'm', general });
  check('a backend error changes nothing', out === null);
}

{
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  const out = await build({}).refine(image, { model: 'm', general });
  check('a thrown request changes nothing', out === null);
}

{
  stubReply('KEEP: 1girl\nDROP: none\nADD: backlighting');
  const out = await build({}).refine(image, { model: 'm', general: [] });
  check('nothing to settle means no call', out === null);
}

{
  stubReply('KEEP: 1girl\nDROP: none\nADD: backlighting');
  const noStore = createVisionTags({
    baseUrl: 'http://x/v1',
    tagStore: { loaded: false },
    getPrompt: () => 'instructions',
    settings: {},
    warn: () => {},
  });
  const out = await noStore.refine(image, { model: 'm', general });
  check(
    'no tag database means nothing is added',
    out?.added.length === 0 && out?.rejected[0]?.why === 'no tag database',
    'unverifiable is not the same as fine'
  );
}

// ── the other arm: the model reads the picture, no tagger ────
//
// The stakes are different here, which is why this half answers `{ ok,
// reason }` rather than null. refine() returning null leaves the tagger's
// list standing and that is a good answer; describe() failing leaves nothing
// at all, so the route falls back to the taggers and puts the reason on the
// card. Two things under test: that only tags the database recognised get
// through, and that each way of failing says which one it was.

{
  const d = parseTagReading('CHARACTER: frieren\nTAGS: 1girl, white_hair');
  check('reads both lines', eq(d?.character, ['frieren']) && eq(d?.tags, ['1girl', 'white_hair']));
}

check(
  'no character is an empty list, not a failure',
  eq(parseTagReading('CHARACTER: none\nTAGS: 1girl')?.character, []) &&
    eq(parseTagReading('CHARACTER: none\nTAGS: 1girl')?.tags, ['1girl'])
);

check(
  'a missing TAGS line fails closed',
  parseTagReading('CHARACTER: frieren') === null,
  'no tagger result underneath means an empty read must be distinguishable from a broken one'
);

check('UNAVAILABLE is not a reading', parseTagReading('UNAVAILABLE') === null);
check('empty output fails closed', parseTagReading('') === null);

check(
  'prose around the contract does not break it',
  eq(parseTagReading('Here you go:\nCHARACTER: none\nTAGS: 1girl, Blue Hair')?.tags, ['1girl', 'blue_hair'])
);

{
  stubReply('CHARACTER: frieren\nTAGS: 1girl, backlighting, rain_slicked_concrete, ancient_tag, wet');
  const out = await build({}).describe(image, { model: 'm' });
  check('a good reading says so', out?.ok === true);
  check('the character reaches the character list', eq(out?.character.map((t) => t.tag), ['frieren']));
  check('verified tags reach the general list', eq(out?.general.map((t) => t.tag), ['1girl', 'backlighting']));
  check(
    'an invented tag never reaches the prompt',
    out?.rejected.some((r) => r.tag === 'rain_slicked_concrete' && r.why === 'not a danbooru tag'),
    'the model is writing the whole list here, so this guard is the only one there is'
  );
  check('a deprecated tag is rejected', out?.rejected.some((r) => r.tag === 'ancient_tag' && r.why === 'deprecated'));
  check('a real but unused tag is rejected', out?.rejected.some((r) => r.tag === 'wet' && r.why === 'too rare'));
  check('nothing carries an invented confidence', out?.general.every((t) => t.confidence === null));
}

{
  stubReply('CHARACTER: none\nTAGS: 1girl, frieren, some_artist, highres');
  const out = await build({}).describe(image, { model: 'm' });
  check(
    'a character named in the TAGS line is still a character',
    eq(out?.character.map((t) => t.tag), ['frieren']) && !out?.general.some((t) => t.tag === 'frieren'),
    'server/imagerefs.mjs strips the recognised character out of the tag list, and can only do that for a name it was told about'
  );
  check('an artist name is not a description of the picture', out?.rejected.some((r) => r.tag === 'some_artist' && r.why === 'artist name'));
  check('a meta tag describes the file, not the image', out?.rejected.some((r) => r.tag === 'highres' && r.why === 'meta tag'));
}

{
  stubReply('CHARACTER: elf\nTAGS: 1girl');
  const out = await build({}).describe(image, { model: 'm' });
  check(
    'a general tag on the CHARACTER line is refused',
    eq(out?.character, []) && out?.rejected.some((r) => r.tag === 'elf' && r.why === 'not a character tag'),
    'that field is the strongest claim a reference carries — a word like elf wearing it leaves the real subject unnamed'
  );
}

{
  stubReply('CHARACTER: none\nTAGS: 1girl, backlighting, from_above');
  const out = await build({ describe: { max_tags: 2 } }).describe(image, { model: 'm' });
  check('max_tags is a ceiling', out?.general.length === 2);
}

{
  stubReply('CHARACTER: none\nTAGS: 1girl');
  const off = build({ describe: { enabled: false } });
  check('the arm can be switched off in config', (await off.describe(image, { model: 'm' }))?.ok === false);
  check('and the panel can be told', off.describeEnabled === false);
}

{
  stubReply('CHARACTER: none\nTAGS: 1girl');
  const noFile = createVisionTags({
    baseUrl: 'http://x/v1',
    tagStore: fakeStore,
    getPrompt: () => 'instructions',
    getDescribePrompt: () => null,
    settings: {},
    warn: () => {},
  });
  check('no instruction file means the arm is not on offer', noFile.describeEnabled === false);
  check('and it produces nothing rather than improvising', (await noFile.describe(image, { model: 'm' }))?.ok === false);
}

{
  stubReply('It looks like a lovely picture of a forest.');
  const out = await build({}).describe(image, { model: 'm' });
  check('an unparseable reply produces nothing', out?.ok === false);
  check('...and says the format was wrong', /expected format/.test(out?.reason ?? ''));
}

{
  // Measured on the P40, 7 Sep 2026: the base 27B answers a picture this
  // group would attach with exactly this, in 30.8s, while the decensored one
  // reads it in 86s. Calling that a format bug would send someone to the
  // parser when the fix is to pick a different model.
  stubReply("I'm unable to complete this request as I can't process or tag images containing explicit sexual content.");
  const out = await build({}).describe(image, { model: 'm' });
  check('a refusal is reported as a refusal, not as bad formatting',
    out?.ok === false && /declined/.test(out?.reason ?? ''),
    out?.reason);
}

{
  stubReply('CHARACTER: none\nTAGS: rain_slicked_concrete, elven_hair');
  check(
    'a reading where nothing survived the tag check is a failure, not an empty list',
    (await build({}).describe(image, { model: 'm' }))?.ok === false,
    'the route falls back to the taggers on a failure — an empty result would go to the card as a reference with no tags'
  );
}

{
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const out = await build({}).describe(image, { model: 'm' });
  check('a backend error produces nothing', out?.ok === false);
  check('...and reads as unreachable, which is what the route qualifies',
    /could not be reached/.test(out?.reason ?? ''), out?.reason);
}

{
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  check('a thrown request produces nothing', (await build({}).describe(image, { model: 'm' }))?.ok === false);
}

{
  stubReply('CHARACTER: none\nTAGS: 1girl');
  const noStore = createVisionTags({
    baseUrl: 'http://x/v1',
    tagStore: { loaded: false },
    getPrompt: () => 'instructions',
    getDescribePrompt: () => 'read it',
    settings: {},
    warn: () => {},
  });
  check(
    'no tag database means no reading at all',
    (await noStore.describe(image, { model: 'm' }))?.ok === false,
    'unverifiable is not the same as fine — on this arm there is nothing else holding the list up'
  );
}

// ── the two transports ───────────────────────────────────────
//
// A picture reaches ollama and llama.cpp in different shapes, and getting
// either wrong fails the same quiet way: the server answers, nothing throws,
// and the model simply never saw the image. What is asserted here is the
// shape of the request, because that is the part no downstream check covers.

/** Capture the request instead of answering it. */
function captureRequest(reply = 'CHARACTER: none\nTAGS: 1girl') {
  const seen = {};
  globalThis.fetch = async (url, opts) => {
    seen.url = String(url);
    seen.body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        // Both shapes, so one stub serves either transport and a parser that
        // read the wrong field would show up as an empty reading.
        message: { content: reply },
        choices: [{ message: { content: reply } }],
      }),
    };
  };
  return seen;
}

{
  const seen = captureRequest();
  const out = await createVisionTags({
    baseUrl: 'http://x:8099/v1',
    backend: 'llamacpp',
    tagStore: fakeStore,
    getPrompt: () => 'instructions',
    getDescribePrompt: () => 'read it',
    settings: {},
    warn: () => {},
  }).describe(image, { model: 'm' });

  check('llamacpp posts to the OpenAI path', seen.url === 'http://x:8099/v1/chat/completions', seen.url);
  check('the image rides as an image_url data uri',
    seen.body?.messages?.[1]?.content?.[1]?.type === 'image_url' &&
      /^data:image\/png;base64,/.test(seen.body.messages[1].content[1].image_url.url));
  check(
    'thinking is off through the chat template',
    seen.body?.chat_template_kwargs?.enable_thinking === false,
    'measured 8 Sep 2026: with it on, the reply came back empty at the token ceiling in 74s'
  );
  check('and the OpenAI reply shape is the one read', out?.ok === true);
}

{
  const seen = captureRequest();
  await createVisionTags({
    baseUrl: 'http://x:11434/v1',
    backend: 'ollama',
    tagStore: fakeStore,
    getPrompt: () => 'instructions',
    getDescribePrompt: () => 'read it',
    settings: {},
    warn: () => {},
  }).describe(image, { model: 'm' });

  check('ollama still posts to the native path', seen.url === 'http://x:11434/api/chat', seen.url);
  check('the image rides in the images array', Array.isArray(seen.body?.messages?.[1]?.images));
  check('thinking is off the ollama way', seen.body?.think === false);
}

{
  const seen = captureRequest();
  await createVisionTags({
    baseUrl: 'http://x:11434/v1',
    backend: 'llamacpp',
    tagStore: fakeStore,
    getPrompt: () => 'instructions',
    getDescribePrompt: () => 'read it',
    settings: { transport: 'ollama' },
    warn: () => {},
  }).describe(image, { model: 'm' });
  check(
    'an explicit transport overrides the backend, for a box where they diverge',
    seen.url === 'http://x:11434/api/chat',
    seen.url
  );
}

// ── who is allowed to read ───────────────────────────────────
//
// On llama.cpp vision is a start flag, not a capability any endpoint reports.
// The declared list is the only truth, and it has to be exhaustive — this is
// the one place in this module where "not listed" is a real no rather than an
// "it did not say".

{
  const v = createVisionTags({
    baseUrl: 'http://x:8099/v1',
    backend: 'llamacpp',
    tagStore: fakeStore,
    getPrompt: () => 'instructions',
    getDescribePrompt: () => 'read it',
    settings: { vision_models: ['sees:latest'] },
    warn: () => {},
  });
  globalThis.fetch = async () => { throw new Error('/api/show must not be asked'); };
  check('a declared model can see', (await v.canSee('sees:latest')) === true);
  check(
    'an undeclared one is a real no, not an unknown',
    (await v.canSee('blind:latest')) === false,
    'the list names every entry started with --mmproj, so absence is a fact'
  );
}

// ── report ───────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} FAILED:`);
  for (const f of failures) console.log(`    FAIL  ${f}`);
  console.log('');
  console.log(`${failures.length} of ${passed + failures.length} FAILED`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
