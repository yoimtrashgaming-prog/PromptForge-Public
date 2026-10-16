// The inference queue, and the bookkeeping the active users panel reads.
//
//   node scripts/test-queue.mjs
//
// No server, no model. The queue is four lines of state and easy to get wrong
// in a way nothing else notices: a ticket that is not removed from the running
// set leaves someone shown as "generating" forever, and a counter that drifts
// stalls the queue for everybody. Both are silent.

import { createQueue } from '../server/queue.mjs';

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

// ── attribution ──────────────────────────────────────────────
{
  const q = createQueue({ concurrency: 1, name: 'test' });
  const a = q.enqueue({ user: 'friendo', model: 'h3' });
  const b = q.enqueue({ user: 'alex', model: 'illustrious' });
  await a.started;

  const stats = q.stats();
  const running = stats.jobs.filter((j) => j.state === 'running');
  const waiting = stats.jobs.filter((j) => j.state === 'waiting');

  check('the running job is reported with its user', running[0]?.user === 'friendo', JSON.stringify(running));
  check('...and the model it is generating for', running[0]?.model === 'h3', JSON.stringify(running));
  check('the queued job is reported too', waiting[0]?.user === 'alex', JSON.stringify(waiting));
  check('running comes before waiting', stats.jobs[0]?.state === 'running', JSON.stringify(stats.jobs));
  check('counts still agree with the jobs list',
    stats.running === running.length && stats.waiting === waiting.length,
    JSON.stringify(stats));
  check('every job carries an age', stats.jobs.every((j) => typeof j.seconds === 'number'));

  // The leak that would leave someone "generating" forever in the panel.
  a.release();
  await b.started;
  const after = q.stats();
  check('a released job leaves the list', !after.jobs.some((j) => j.user === 'friendo'),
    JSON.stringify(after.jobs));
  check('and the one behind it is now running',
    after.jobs.find((j) => j.user === 'alex')?.state === 'running', JSON.stringify(after.jobs));

  b.release();
  const empty = q.stats();
  check('releasing everything empties the list', empty.jobs.length === 0, JSON.stringify(empty.jobs));
  check('and zeroes the counters', empty.running === 0 && empty.waiting === 0 && empty.depth === 0,
    JSON.stringify(empty));
}

// ── chat shares the queue ────────────────────────────────────
{
  const q = createQueue({ concurrency: 1, name: 'test' });
  const a = q.enqueue({ user: 'friendo', model: 'h3', kind: 'prompt' });
  const b = q.enqueue({ user: 'alex', kind: 'chat' });
  await a.started;
  const jobs = q.stats().jobs;
  // Chat and prompt generation share one GPU and therefore one queue. The
  // panel has to be able to tell them apart, or a conversation reads as a
  // prompt nobody asked for.
  check('a prompt job says so', jobs.find((j) => j.user === 'friendo')?.kind === 'prompt');
  check('a chat job says so', jobs.find((j) => j.user === 'alex')?.kind === 'chat');
  check('and a chat job need not name a model',
    jobs.find((j) => j.user === 'alex')?.model === null);
  // Nothing passed at all still has to be describable.
  const c = q.enqueue();
  check('kind defaults to prompt', q.stats().jobs.at(-1).kind === 'prompt');
  a.release(); b.release(); c.release();
}

// ── cancelled before it ever ran ─────────────────────────────
{
  const q = createQueue({ concurrency: 1, name: 'test' });
  const a = q.enqueue({ user: 'one', model: 'pony' });
  const b = q.enqueue({ user: 'two', model: 'pony' });
  await a.started;
  // Someone closes the tab while queued. The ticket is released without ever
  // having started, which is a different path through release().
  b.release();
  const stats = q.stats();
  check('a job cancelled while queued disappears', !stats.jobs.some((j) => j.user === 'two'),
    JSON.stringify(stats.jobs));
  check('and does not decrement the running count',
    stats.running === 1, JSON.stringify(stats));
  a.release();
  check('after which the queue is idle', q.stats().depth === 0);
}

// ── anonymous work ───────────────────────────────────────────
{
  const q = createQueue({ concurrency: 1, name: 'test' });
  const t = q.enqueue();
  await t.started;
  const stats = q.stats();
  // Kept, not filtered: a job with no account is still holding the GPU, and
  // dropping it would make the panel disagree with the depth beside it.
  check('a job with no user attached is still listed', stats.jobs.length === 1, JSON.stringify(stats.jobs));
  check('...with a null user rather than a made-up one', stats.jobs[0].user === null);
  t.release();
}

// ── concurrency above one ────────────────────────────────────
{
  const q = createQueue({ concurrency: 2, name: 'test' });
  const a = q.enqueue({ user: 'a' });
  const b = q.enqueue({ user: 'b' });
  const c = q.enqueue({ user: 'c' });
  await Promise.all([a.started, b.started]);
  const stats = q.stats();
  check('two run at once when concurrency allows',
    stats.jobs.filter((j) => j.state === 'running').length === 2, JSON.stringify(stats.jobs));
  check('and the third waits', stats.jobs.find((j) => j.user === 'c')?.state === 'waiting');
  a.release(); b.release(); c.release();
}

// ── reordering (owner-only at the route) ────────────────
//
// The queue itself has no idea who is asking. The gate is the blanket
// /api/admin/ owner check in server.mjs, covered in test-auth.

{
  const q = createQueue({ concurrency: 1, name: "test" });
  const running = q.enqueue({ user: "running" });
  await running.started;
  const a = q.enqueue({ user: "a" });
  const b = q.enqueue({ user: "b" });
  const c = q.enqueue({ user: "c" });
  await null;

  const line = () => q.stats().jobs.filter((j) => j.state === "waiting").map((j) => j.user);
  check("the line starts in the order people joined",
    JSON.stringify(line()) === JSON.stringify(["a", "b", "c"]), JSON.stringify(line()));

  const up = q.move(c.id, "up");
  check("moving up reports where it went", up.ok && up.from === 3 && up.to === 2, JSON.stringify(up));
  check("...and the line follows",
    JSON.stringify(line()) === JSON.stringify(["a", "c", "b"]), JSON.stringify(line()));

  const front = q.move(b.id, "front");
  check("moving to the front puts it first",
    front.ok && JSON.stringify(line()) === JSON.stringify(["b", "a", "c"]), JSON.stringify(line()));

  const down = q.move(b.id, "down");
  check("moving down works too",
    down.ok && JSON.stringify(line()) === JSON.stringify(["a", "b", "c"]), JSON.stringify(line()));

  // Clamping, not erroring: the first job has no "up".
  const top = q.move(a.id, "up");
  check("moving the first job up is a successful no-op",
    top.ok && top.from === 1 && top.to === 1, JSON.stringify(top));
  const bottom = q.move(c.id, "down");
  check("...and so is moving the last one down",
    bottom.ok && bottom.from === 3 && bottom.to === 3, JSON.stringify(bottom));
  check("neither disturbed the order",
    JSON.stringify(line()) === JSON.stringify(["a", "b", "c"]), JSON.stringify(line()));

  check("an unknown direction is refused",
    q.move(a.id, "sideways").code === "bad_direction");

  // The running job is on the GPU. Its place in a line it already left is
  // not a thing that can be changed.
  const onGpu = q.move(running.id, "front");
  check("a running job cannot be moved",
    !onGpu.ok && onGpu.code === "already_running", JSON.stringify(onGpu));
  check("...and says so in words the panel can show", /already running/.test(onGpu.message));

  check("a job that never existed is not_waiting",
    q.move(99999, "up").code === "not_waiting");

  running.release(); a.release(); b.release(); c.release();
}

{
  // The people behind a moved job have to hear about it, or the position
  // they were told is silently wrong until the next poll.
  const q = createQueue({ concurrency: 1, name: "test" });
  const hog = q.enqueue({ user: "hog" });
  await hog.started;
  const a = q.enqueue({ user: "a" });
  const b = q.enqueue({ user: "b" });
  const heard = [];
  a.onPosition((p) => heard.push(["a", p]));
  b.onPosition((p) => heard.push(["b", p]));
  await null;
  heard.length = 0;

  q.move(b.id, "front");
  check("the promoted job is told its new position",
    heard.some(([u, p]) => u === "b" && p === 1), JSON.stringify(heard));
  check("...and so is the one it went past",
    heard.some(([u, p]) => u === "a" && p === 2), JSON.stringify(heard));

  hog.release(); a.release(); b.release();
}

{
  // Reordering must not break the thing the queue exists for: what runs next.
  const q = createQueue({ concurrency: 1, name: "test" });
  const first = q.enqueue({ user: "first" });
  await first.started;
  const a = q.enqueue({ user: "a" });
  const b = q.enqueue({ user: "b" });
  await null;
  q.move(b.id, "front");
  first.release();
  await b.started;
  check("the promoted job is the one that actually runs next",
    q.stats().jobs.find((j) => j.state === "running")?.user === "b",
    JSON.stringify(q.stats().jobs));
  a.release(); b.release();
}

{
  // A released ticket must leave the line, or promoting it resurrects a job
  // nobody is waiting on.
  const q = createQueue({ concurrency: 1, name: "test" });
  const hog = q.enqueue({ user: "hog" });
  await hog.started;
  const gone = q.enqueue({ user: "gone" });
  await null;
  gone.release();
  check("a cancelled job cannot be promoted",
    q.move(gone.id, "front").code === "not_waiting");
  hog.release();
}

{
  const q = createQueue({ concurrency: 1, name: "test" });
  const t = q.enqueue({ user: "someone" });
  await t.started;
  check("stats expose an id for the panel to address a job by",
    Number.isInteger(q.stats().jobs[0]?.id), JSON.stringify(q.stats().jobs[0]));
  t.release();
}

if (failures.length) {
  console.log(`
${failures.length} FAILED:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL PASSED (${passed})`);
