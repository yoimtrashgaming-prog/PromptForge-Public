// In-process FIFO inference queue.
//
// Ollama serialises requests unless OLLAMA_NUM_PARALLEL is raised, and each
// parallel slot costs VRAM. On a card with no headroom, num_parallel: 1 is
// correct — so instead of letting a second user's request appear frozen, we
// queue it and tell them where they are.
//
// A request that is not first in line gets an immediate `queued` event with
// its position, and further `queued` events as the line moves. After
// migration, raising num_parallel means the queue simply never fills.

// `onActivity` is called whenever a job arrives or leaves, finished or
// cancelled. The idle-unload clock in server/keepalive.mjs restarts on it.
//
// `beforeStart(ticket)` runs when a ticket reaches the front, before its
// `started` resolves; the work waits for it. Renders use it to give the GPU
// back to the LLM (server/comfyui.mjs). Its failure never stalls the line.
export function createQueue({ concurrency = 1, name = 'inference', onActivity = null, beforeStart = null } = {}) {
  const ping = () => {
    try {
      onActivity?.();
    } catch {
      /* a broken listener must not stall the queue */
    }
  };
  const waiting = [];   // tickets not yet started, in FIFO order
  // Tickets currently running. The waiting array drops a ticket the moment it
  // starts, so without this there is no record of who is actually working —
  // only a count. The active users panel needs the names.
  const active = new Set();
  let running = 0;
  let nextId = 1;

  function positions() {
    // 1-based: position 1 means "next to run", which is what "2 ahead of
    // you" in the UI counts from.
    waiting.forEach((t, i) => {
      const pos = i + 1;
      if (t.position !== pos) {
        t.position = pos;
        t.listeners.forEach((fn) => {
          try {
            fn(pos);
          } catch {
            /* a broken listener must not stall the queue */
          }
        });
      }
    });
  }

  function pump() {
    while (running < concurrency && waiting.length) {
      const ticket = waiting.shift();
      running += 1;
      ticket.position = 0;
      ticket.started_at = Date.now();
      active.add(ticket);
      if (beforeStart) {
        Promise.resolve()
          .then(() => beforeStart(ticket))
          .catch(() => {})
          .then(ticket.resolve);
      } else {
        ticket.resolve();
      }
    }
    positions();
  }

  return {
    name,
    concurrency,

    /**
     * Take a place in line. Returns a ticket:
     *   ticket.position   current position, 0 once running
     *   ticket.onPosition(fn)  called whenever the position changes
     *   ticket.started    promise resolving when it is this request's turn
     *   ticket.release()  MUST be called when the work finishes or fails
     */
    /**
     * `about` is who and what, for the active users panel: five people share
     * one GPU, and "someone is generating" is much less useful than "Friendo
     * is generating an h3 prompt". Purely descriptive — nothing in the queue
     * behaves differently because of it.
     */
    enqueue(about = {}) {
      const ticket = {
        id: nextId++,
        position: waiting.length + (running >= concurrency ? 1 : 0),
        listeners: [],
        released: false,
        user: about.user ?? null,
        model: about.model ?? null,
        // What kind of work, so the panel can say "Chatting" rather than
        // "Generating" for a conversation. Chat and prompt generation share
        // one GPU and one queue, so they have to share this list too.
        kind: about.kind ?? 'prompt',
        queued_at: Date.now(),
        started_at: null,
      };

      ticket.started = new Promise((resolve) => {
        ticket.resolve = resolve;
      });

      ticket.onPosition = (fn) => {
        ticket.listeners.push(fn);
        return ticket;
      };

      ticket.release = () => {
        if (ticket.released) return;
        ticket.released = true;
        ping();
        const idx = waiting.indexOf(ticket);
        if (idx !== -1) {
          // Cancelled before it ever ran.
          waiting.splice(idx, 1);
          positions();
          return;
        }
        active.delete(ticket);
        running = Math.max(0, running - 1);
        pump();
      };

      waiting.push(ticket);
      ping();
      // Defer so the caller can attach onPosition before the first fire.
      queueMicrotask(pump);
      return ticket;
    },

    /**
     * Move a waiting ticket. Owner-only at the route; the queue itself has no
     * concept of who is asking.
     *
     * Returns { ok, code, from, to } rather than throwing. Every failure here
     * is a race the owner cannot avoid — they clicked on a list that was
     * accurate when it rendered — so "that job already started" is an outcome
     * to report, not an exception.
     *
     * A running ticket is never movable. It is on the GPU; changing its place
     * in a line it has already left would do nothing, and showing a control
     * that does nothing is worse than showing none.
     */
    move(id, direction) {
      const idx = waiting.findIndex((t) => t.id === id);
      if (idx === -1) {
        // Either it started while the panel was open, or it finished, or it
        // was never real. The caller cannot tell these apart and does not
        // need to — in all three cases the line it was looking at is stale.
        const isRunning = [...active].some((t) => t.id === id);
        return {
          ok: false,
          code: isRunning ? 'already_running' : 'not_waiting',
          message: isRunning
            ? 'That job is already running and cannot be moved.'
            : 'That job is no longer waiting.',
        };
      }

      const to =
        direction === 'front' ? 0
        : direction === 'up' ? idx - 1
        : direction === 'down' ? idx + 1
        : null;

      if (to === null) {
        return { ok: false, code: 'bad_direction', message: `Unknown direction "${direction}".` };
      }
      // Clamping rather than erroring: the first job in line has no "up", and
      // a disabled button that reports failure when clicked anyway is noise.
      // Nothing moved is a successful no-op, and `from === to` says so.
      const clamped = Math.max(0, Math.min(waiting.length - 1, to));

      waiting.splice(clamped, 0, waiting.splice(idx, 1)[0]);
      // Fires every listener whose place changed, so the people behind see
      // their new position immediately rather than at the next poll. That is
      // the whole point of doing this in the queue rather than in the route.
      positions();
      return { ok: true, from: idx + 1, to: clamped + 1 };
    },

    stats() {
      const now = Date.now();
      const describe = (t, state) => ({
        // Exposed so the admin panel has something to address a job by.
        // Opaque and per-process: it identifies a place in this line, not a
        // person or a piece of work, and it is meaningless after a restart.
        id: t.id,
        user: t.user,
        model: t.model,
        kind: t.kind,
        state,
        seconds: Math.round((now - (state === 'running' ? t.started_at ?? now : t.queued_at)) / 1000),
      });
      return {
        running,
        waiting: waiting.length,
        depth: running + waiting.length,
        concurrency,
        // Running first, then the line behind it in order. Anonymous entries
        // are kept rather than filtered: a job with no user attached is still
        // occupying the GPU, and hiding it would make the panel disagree with
        // the depth beside it.
        jobs: [
          ...[...active].map((t) => describe(t, 'running')),
          ...waiting.map((t) => describe(t, 'waiting')),
        ],
      };
    },
  };
}
