// Who else is on the GPU: parsing nvidia-smi and ss, naming the holders,
// freeing idle ComfyUIs on other ports, and the sentence a failed load gets.
//
//   node scripts/test-gpu-holders.mjs
//
// No GPU, no ComfyUI: the commands' output and fetch are stand-ins.

import {
  parseComputeApps, parseListeners, kindOf, describeHolder, freeOtherComfyUIs, isLoadFailure, explainLoadFailure,
} from '../server/gpu-holders.mjs';

let passed = 0;
const failures = [];
function check(what, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
}
const eq = (what, got, want) => check(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

eq('compute apps parse', parseComputeApps('1085648, 14396\n1087726, 22926\n\n[Not Supported], 3\n'), [{ pid: 1085648, mib: 14396 }, { pid: 1087726, mib: 22926 }]);
eq('nothing on the card, nothing parsed', parseComputeApps(''), []);

const ss = [
  'LISTEN 0      128        127.0.0.1:8191       0.0.0.0:*    users:(("python",pid=1085648,fd=48))',
  'LISTEN 0      511          0.0.0.0:8090       0.0.0.0:*    users:(("MainThread",pid=863109,fd=26))',
  'LISTEN 0      4096       127.0.0.1:8099       0.0.0.0:*    users:(("llama-swap",pid=1380,fd=7))',
  'LISTEN 0      4096           [::1]:8188          [::]:*    users:(("python",pid=42,fd=9))',
].join('\n');
const ports = parseListeners(ss);
eq('listeners by pid', [ports.get(1085648), ports.get(1380), ports.get(42)], [[8191], [8099], [8188]]);

eq('kinds', [
  kindOf('venv/bin/python main.py --base-directory /mnt/ssd/scratch/ctxcomfy-fix --listen 127.0.0.1 --port 8191 /mnt/ssd/comfyui'),
  kindOf('/home/x/llama.cpp/build-v100/bin/llama-server --port 5804'),
  kindOf('python train.py'),
], ['comfyui', 'llm', 'other']);

const comfyHolder = { pid: 1085648, mib: 14396, cmd: 'python main.py --base-directory /x/comfy', kind: 'comfyui', ports: [8191] };
eq('a ComfyUI is named by its port and size', describeHolder(comfyHolder), 'a ComfyUI on port 8191 (14.1 GB)');
eq('anything else by its program and pid', describeHolder({ pid: 7, mib: 3072, cmd: '/usr/bin/python3 train.py', kind: 'other', ports: [] }), 'python3, process 7 (3.0 GB)');

// freeing: a stand-in fetch that answers per port
async function freeing(holders, queues) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${url}`);
    const port = Number(new URL(url).port);
    if (url.endsWith('/queue')) {
      if (!(port in queues)) throw new Error('refused');
      return { json: async () => queues[port] };
    }
    return { json: async () => ({}) };
  };
  const result = await freeOtherComfyUIs({ exceptPort: 8188, holders, fetchImpl });
  return { result, calls };
}
{
  const idle = { queue_running: [], queue_pending: [] };
  const busy = { queue_running: [['x']], queue_pending: [] };
  const own = { ...comfyHolder, pid: 42, ports: [8188] };
  const other = { ...comfyHolder, pid: 9, ports: [8191] };
  const working = { ...comfyHolder, pid: 10, ports: [8192] };
  const model = { pid: 11, mib: 20000, cmd: 'llama-server', kind: 'llm', ports: [5804] };
  const { result, calls } = await freeing([own, other, working, model], { 8188: idle, 8191: idle, 8192: busy });
  eq('an idle ComfyUI on another port is freed', result.freed.map((h) => h.pid), [9]);
  eq('a working one is left alone', result.busy.map((h) => h.pid), [10]);
  check('the configured one is not touched here (freeIfIdle has it)', !calls.some((c) => c.includes(':8188')), calls.join(', '));
  check('a llama.cpp model is never asked', !calls.some((c) => c.includes(':5804')), calls.join(', '));
  check('free is a POST to /free', calls.includes('POST http://127.0.0.1:8191/free'), calls.join(', '));
  const gone = await freeing([{ ...comfyHolder, ports: [8193] }], {});
  eq('one that does not answer is left alone', [gone.result.freed.length, gone.result.busy.length], [0, 0]);
}

// the failed load
check('llama-swap\'s load failure is recognised', isLoadFailure('{"src":"llama-swap","error":{"message":"unspecific error: upstream command exited prematurely"}}'));
check('a CUDA out-of-memory is recognised', isLoadFailure('CUDA error: out of memory'));
check('an ordinary error is not', !isLoadFailure('HTTP 400 bad request'));
{
  const holders = [comfyHolder, { pid: 11, mib: 20000, cmd: 'llama-server', kind: 'llm', ports: [5804] }, { pid: 12, mib: 100, cmd: 'Xorg', kind: 'other', ports: [] }];
  const why = await explainLoadFailure('upstream command exited prematurely', { holders });
  check('the explanation names the ComfyUI', why?.includes('held by a ComfyUI on port 8191 (14.1 GB)'), why);
  check('...and not PromptForge\'s own model or a tiny holder', !why?.includes('llama.cpp') && !why?.includes('Xorg'), why);
  eq('no load failure, no explanation', await explainLoadFailure('HTTP 400', { holders }), null);
  eq('nobody else on the card, no explanation', await explainLoadFailure('exited prematurely', { holders: [holders[1]] }), null);
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
