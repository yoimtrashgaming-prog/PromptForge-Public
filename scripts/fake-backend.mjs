// A deliberately broken Ollama-shaped backend, so the failure table can be
// looked at in a real browser rather than only asserted over HTTP.
//
// scripts/test-failures.mjs has an equivalent stub inline, but it drives the
// API directly and tears itself down. This one just sits there, so you can
// point the app at it and click Generate:
//
//   FAKE_MODE=oom node scripts/fake-backend.mjs
//   PROMPTFORGE_AUTH=off PROMPTFORGE_PORT=8098 \
//     PROMPTFORGE_LLM_BASE_URL=http://127.0.0.1:8199/v1 npm start
//
// Modes:
//   oom      500 with a CUDA out-of-memory message — must reach the panel
//            verbatim, because that message names the knob to turn
//   partial  streams one complete segment then cuts the socket — the answer
//            that arrived must survive as kept partial output
//   hostile  emits a segment label containing markup. The unknown_segment
//            error quotes that label straight into its message, so this is
//            the path e4f1dd6 hardened: it must reach the panel as visible
//            text and create no elements.
//   slow     streams a valid answer one segment at a time over ~20s, so the
//            active users panel can be watched holding a job: whose it is,
//            what model, and the seconds counting up. Nothing else in this
//            project produces a generation slow enough to look at without a
//            GPU.
//
// It also answers /api/ps with a fabricated resident model, which is what the
// panel reads for "On the GPU". Ollama reports nothing resident until it has
// loaded something, so a fake backend that answered honestly would leave that
// block permanently empty and untestable. FAKE_RESIDENT=none turns it off, to
// check the empty state instead.
//
// Dev tool. Needs no GPU and no model, which is the point: these rows are
// otherwise only reachable by breaking the real backend.
import http from 'node:http';

const PORT = Number(process.env.FAKE_PORT || 8199);
const MODEL = process.env.FAKE_MODEL || 'qwen3:8b';
const MODE = process.env.FAKE_MODE || 'oom';

http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Two, so the chat selector has a loaded one and a cold one to group.
    return res.end(JSON.stringify({ data: [{ id: MODEL }, { id: 'fake-cold:27b' }] }));
  }
  // What the chat model selector reads for sizes. Two models so the selector
  // has something to group: one resident, one not. Without this the selector
  // is a single row against a fake backend and the "this will load a model"
  // note has nothing to say.
  if (req.url.startsWith('/api/tags')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      models: [
        { name: MODEL, size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
        { name: 'fake-cold:27b', size: 17_000_000_000, details: { parameter_size: '27B', quantization_level: 'Q3_K_XL' } },
      ],
    }));
  }
  // What the panel reads for "On the GPU". Deliberately a partial offload:
  // size_vram below size is the case worth seeing, since it is the difference
  // between fast and unusably slow and nothing else in the app says so.
  if (req.url.startsWith('/api/ps')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (process.env.FAKE_RESIDENT === 'none') return res.end(JSON.stringify({ models: [] }));
    return res.end(JSON.stringify({
      models: [{
        name: MODEL,
        size: 14_000_000_000,
        size_vram: 9_000_000_000,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }],
    }));
  }

  if (req.url.startsWith('/api/chat')) {
    req.resume();
    req.on('end', () => {
      if (MODE === 'oom') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'CUDA error: out of memory trying to allocate 2.00 GiB on device 0',
        }));
      }
      if (MODE === 'hostile') {
        // A label the parser will reject, carrying markup that must never be
        // parsed as HTML on the way to the error message.
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({
          message: { content: '===SEGMENT: <img src=x onerror="window.__XSS=1">===' + String.fromCharCode(10) + 'body' + String.fromCharCode(10) },
          done: false,
        }) + String.fromCharCode(10));
        res.end(JSON.stringify({ message: { content: '' }, done: true }) + String.fromCharCode(10));
        return;
      }
      if (MODE === 'slow') {
        // A valid three-segment illustrious answer, paced out. The panel polls
        // every 10s, so this has to outlast a poll to be worth watching.
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const chunks = [
          '===SEGMENT: Positive prompt===\nmasterpiece, best_quality, 1girl, solo, rain\n\n',
          '===SEGMENT: Negative prompt===\nworst_quality, lowres, blurry\n\n',
          '===SEGMENT: Reasoning===\nHeld the tag order and kept the negative short.\n',
        ];
        let i = 0;
        const tick = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(tick);
            return res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
          }
          res.write(JSON.stringify({ message: { content: chunks[i++] }, done: false }) + '\n');
        }, 7000);
        return;
      }

      // partial: stream one complete segment, then cut the socket mid-answer.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({
        message: { content: '===SEGMENT: Positive prompt===\n1girl, solo, rain\n\n===SEGMENT: Neg' },
        done: false,
      }) + '\n');
      setTimeout(() => res.socket.destroy(), 250);
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log('fake backend on ' + PORT + ' mode=' + MODE));
