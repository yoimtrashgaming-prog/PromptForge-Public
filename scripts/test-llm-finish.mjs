// The llama.cpp / vLLM stream reports why it stopped — server/llm.mjs.
//
// A Length limit in tokens is a guillotine, and the generate route explains a
// missing segment as "your N-token limit cut the output off" only when
// usage.truncated says the backend stopped on length. Until 11 Oct 2026 only
// the Ollama path set it, so on llama.cpp - the backend this box runs - a
// 120-token limit reached the panel as "The model omitted required segments".
//
// A stub OpenAI-shaped server, no model, no GPU.

import http from 'node:http';
import { createLLM, LLMError, ERR } from '../server/llm.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// How each scenario ends: llama.cpp puts finish_reason on the last content
// chunk and timings beside it; some servers send usage in a chunk of its own.
const SCENARIOS = {
  length: [
    { choices: [{ delta: { content: '===SEGMENT: Positive prompt===\nmasterpiece, ' } }] },
    { choices: [{ delta: { content: '1girl' }, finish_reason: 'length' }], timings: { predicted_n: 120 } },
    '[DONE]',
  ],
  stop: [
    { choices: [{ delta: { content: 'done' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { completion_tokens: 12 } },
    '[DONE]',
  ],
  nodone: [
    { choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] },
  ],
};

let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'done' }, done: true }) + '\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of SCENARIOS[body.model]) {
      res.write(`data: ${frame === '[DONE]' ? frame : JSON.stringify(frame)}\n\n`);
    }
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const llm = createLLM({ llm: { backend: 'llamacpp', base_url: base, model: 'length' }, paths: { data: '/nonexistent-promptforge-test' } });

async function run(model) {
  const events = [];
  for await (const ev of llm.stream({ model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 120 })) events.push(ev);
  return events;
}

console.log('\nllama.cpp finish reason\n');

const cut = await run('length');
const cutUsage = cut.filter((e) => e.type === 'usage');
check('a stream cut off by max_tokens reports truncated', cutUsage.length === 1 && cutUsage[0].usage.truncated === true,
  JSON.stringify(cutUsage));
check('...with the finish reason named', cutUsage[0]?.usage.done_reason === 'length');
check('...and llama.cpp\'s timings kept beside it', cutUsage[0]?.usage.timings?.predicted_n === 120);
check('the tokens still arrive', cut.filter((e) => e.type === 'token').map((e) => e.text).join('').endsWith('1girl'));

const stop = await run('stop');
const stopUsage = stop.filter((e) => e.type === 'usage');
check('a normal finish is not truncated, and usage is sent once', stopUsage.length === 1 && stopUsage[0].usage.truncated === false,
  JSON.stringify(stopUsage));
check('...with usage from its own chunk kept', stopUsage[0]?.usage.completion_tokens === 12);

const nodone = await run('nodone');
check('a stream that closes without [DONE] still reports it', nodone.some((e) => e.type === 'usage' && e.usage.truncated === true),
  JSON.stringify(nodone));

// A queued read may be cancelled before it reaches llm.stream. Async
// generators are lazy, so also abort after creating one but before consuming it.
for (const backend of ['ollama', 'llamacpp', 'vllm', 'mock']) {
  let usages = 0;
  const client = createLLM({ llm: { backend, base_url: base, model: 'stop' }, paths: { data: '/nonexistent-promptforge-test' } },
    { onUsage: () => { usages++; } });
  const opts = { messages: [{ role: 'user', content: 'hi' }], mock: { chat: true, message: 'hi' } };
  if (backend !== 'mock') {
    const normal = [];
    for await (const ev of client.stream(opts)) normal.push(ev);
    check(`${backend}: ordinary streams still deliver tokens`, normal.some((ev) => ev.type === 'token' && ev.text === 'done'));
  }
  for (const lazy of [false, true]) {
    const abort = new AbortController();
    if (!lazy) abort.abort();
    const stream = client.stream({ ...opts, signal: abort.signal });
    if (lazy) abort.abort();
    const before = requests;
    const usageBefore = usages;
    const events = [];
    let error;
    try {
      for await (const ev of stream) events.push(ev);
    } catch (err) { error = err; }
    const name = `${backend}: ${lazy ? 'aborted before consumption' : 'already aborted'}`;
    check(`${name} reports cancellation`, error instanceof LLMError && error.code === ERR.CANCELLED, error?.message);
    check(`${name} sends no inference request`, requests === before);
    check(`${name} emits no tokens or usage`, events.length === 0 && usages === usageBefore);
  }
}

server.close();
console.log(`\n${fail ? `${fail} FAILED, ${pass} passed` : `ALL PASSED (${pass})`}`);
process.exit(fail ? 1 : 0);
