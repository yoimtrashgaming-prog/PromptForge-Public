// Prometheus-format metrics endpoint for PromptForge.
// Exposes LLM backend status, request rates, queue depth, system metrics
// (CPU/RAM, and VRAM per GPU), and user counts at GET /metrics on its own
// port, PROMPTFORGE_METRICS_PORT (see server.mjs), in the standard
// Prometheus exposition format. Designed to be scraped by a Prometheus
// server running alongside this container (compose.yaml, the `monitoring`
// profile).
//
// From PR #3. Follow-up 22 Sep 2026:
//   - request paths are counted by ROUTE, not by raw URL. Every distinct URL
//     used to become its own counter held forever, so ids, filenames and a
//     port scan's junk grew the process without bound.
//   - GPU metrics are one line per installed card, labelled by index and
//     name, so any number of cards is reported as-is; the single
//     `sys.gpu.vram_used_bytes` field this read does not exist.
//   - generations are labelled by the model that ran, which the callers now pass.
//   - generation latency is recorded (handleGenerate); the dashboard panel for
//     it read a number nothing wrote.
//
// This is NOT an OpenAI-compatible endpoint — it returns text/plain with
// metric lines like:
//   promptforge_http_requests_total{method="GET",route="/api/generate"} 42
//   promptforge_llm_queue_depth 0
//   promptforge_cpu_percent 3.2

// Routes are the first two segments of the path: /api/system-prompts/abc123
// counts as /api/system-prompts. Static files and the Grafana pass-through
// fold into one bucket each. Anything else is `other`, so the label set stays
// the size of the route table however many URLs arrive.
function routeOf(pathname) {
  if (pathname.startsWith('/grafana/')) return '/grafana';
  if (pathname === '/health') return pathname;
  const [, api, first, second] = pathname.split('/');
  if (api !== 'api' || !/^[a-z-]{1,32}$/.test(first ?? '')) return api === 'api' ? 'other' : 'static';
  // A second segment is kept only when it is a fixed lowercase word (admin/
  // models, auth/login) - never an id, a username or a filename.
  return /^[a-z-]{1,24}$/.test(second ?? '') ? `/api/${first}/${second}` : `/api/${first}`;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function createMetrics() {
  const requestCounters = new Map(); // "METHOD route" -> count
  const generationCounters = new Map(); // model -> count
  const speedTotals = new Map(); // model -> { ct, ds, pt, ps, last }
  const latencySamples = []; // last LATENCY_WINDOW generation times, ms
  const LATENCY_WINDOW = 100;

  return {
    /** Record an HTTP request for the metrics endpoint. */
    incRequests(method, pathname) {
      const key = `${METHODS.has(method) ? method : 'OTHER'} ${routeOf(pathname)}`;
      requestCounters.set(key, (requestCounters.get(key) ?? 0) + 1);
    },

    /** Record an LLM generation for a model. */
    incGenerations(model) {
      const key = model ? String(model) : 'default';
      generationCounters.set(key, (generationCounters.get(key) ?? 0) + 1);
    },

    /**
     * One generation's measured speed (speedOf in llm.mjs). Kept as running
     * totals of tokens and seconds per model, which is what makes an honest
     * average: Grafana divides the two over whatever range it is showing, so
     * a long generation counts for more than a short one, as it should.
     */
    recordSpeed(model, s) {
      const key = model ? String(model) : 'default';
      const row = speedTotals.get(key) ?? { ct: 0, ds: 0, pt: 0, ps: 0, last: null };
      row.ct += s.completion_tokens;
      row.ds += s.decode_seconds;
      row.pt += s.prompt_tokens;
      row.ps += s.prompt_seconds;
      row.last = s.decode_seconds > 0 ? s.completion_tokens / s.decode_seconds : row.last;
      speedTotals.set(key, row);
    },

    /** Record how long one prompt generation took, in milliseconds. */
    recordLatency(ms) {
      latencySamples.push(ms);
      if (latencySamples.length > LATENCY_WINDOW) latencySamples.shift();
    },

    /** Render all metrics in Prometheus exposition format. */
    render(getQueueDepth, getBackendInfo, getSysmonData, getUserCount) {
      const lines = [];

      // HTTP request counters
      lines.push('# HELP promptforge_http_requests_total Total HTTP requests by method and route.');
      lines.push('# TYPE promptforge_http_requests_total counter');
      for (const [key, count] of requestCounters.entries()) {
        const [method, route] = key.split(' ');
        lines.push(`promptforge_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}"} ${count}`);
      }

      // Generation counters per model
      lines.push('# HELP promptforge_generations_total Total LLM generations by model.');
      lines.push('# TYPE promptforge_generations_total counter');
      for (const [model, count] of generationCounters.entries()) {
        lines.push(`promptforge_generations_total{model="${escapeLabel(model)}"} ${count}`);
      }

      // Measured speed per model. Averages come from dividing the counters,
      // e.g. rate(completion_tokens) / rate(decode_seconds).
      const speedRows = [...speedTotals.entries()];
      const speedMetric = (name, type, help, pick) => {
        const rows = speedRows.filter(([, r]) => Number.isFinite(pick(r)) && pick(r) !== null);
        if (!rows.length) return;
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} ${type}`);
        for (const [model, r] of rows) lines.push(`${name}{model="${escapeLabel(model)}"} ${Math.round(pick(r) * 1000) / 1000}`);
      };
      speedMetric('promptforge_llm_completion_tokens_total', 'counter', 'Tokens written, per model.', (r) => r.ct);
      speedMetric('promptforge_llm_decode_seconds_total', 'counter', 'Seconds spent writing, per model, as the LLM server measured it.', (r) => r.ds);
      speedMetric('promptforge_llm_prompt_tokens_total', 'counter', 'Prompt tokens read, per model (llama.cpp only).', (r) => r.pt);
      speedMetric('promptforge_llm_prompt_seconds_total', 'counter', 'Seconds spent reading prompts, per model (llama.cpp only).', (r) => r.ps);
      speedMetric('promptforge_llm_decode_tokens_per_second', 'gauge', 'Writing speed of the most recent generation, per model.', (r) => r.last);

      // Latency, averaged over the recent window. Absent until the first
      // generation, so the panel says "no data" rather than a false zero.
      if (latencySamples.length > 0) {
        const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
        lines.push('# HELP promptforge_generation_latency_ms_avg Average prompt generation time in milliseconds, last 100.');
        lines.push('# TYPE promptforge_generation_latency_ms_avg gauge');
        lines.push(`promptforge_generation_latency_ms_avg ${Math.round(avg * 10) / 10}`);
      }

      // Queue depth
      try {
        const depth = getQueueDepth();
        lines.push('# HELP promptforge_llm_queue_depth Current LLM inference queue depth.');
        lines.push('# TYPE promptforge_llm_queue_depth gauge');
        lines.push(`promptforge_llm_queue_depth ${depth}`);
      } catch { /* queue not available */ }

      // Backend info
      try {
        const info = getBackendInfo();
        lines.push('# HELP promptforge_llm_backend_info LLM backend status (1=active).');
        lines.push('# TYPE promptforge_llm_backend_info gauge');
        if (info) {
          lines.push(`promptforge_llm_backend_info{backend="${escapeLabel(info.backend)}",model="${escapeLabel(info.model ?? '')}"} 1`);
        }
      } catch { /* backend info not available */ }

      // System metrics — server/sysmon.mjs shape: { cpu, memory, gpu: [cards] | null }
      try {
        const sys = getSysmonData();
        if (sys?.cpu?.percent != null) {
          lines.push('# HELP promptforge_cpu_percent CPU usage percentage.');
          lines.push('# TYPE promptforge_cpu_percent gauge');
          lines.push(`promptforge_cpu_percent ${sys.cpu.percent}`);
        }
        if (sys?.memory?.used != null) {
          lines.push('# HELP promptforge_ram_used_bytes RAM used in bytes.');
          lines.push('# TYPE promptforge_ram_used_bytes gauge');
          lines.push(`promptforge_ram_used_bytes ${sys.memory.used}`);
          lines.push('# HELP promptforge_ram_total_bytes RAM installed in bytes.');
          lines.push('# TYPE promptforge_ram_total_bytes gauge');
          lines.push(`promptforge_ram_total_bytes ${sys.memory.total}`);
        }
        const cards = Array.isArray(sys?.gpu) ? sys.gpu : [];
        const gpuMetric = (name, help, pick) => {
          const rows = cards.filter((g) => Number.isFinite(pick(g)));
          if (!rows.length) return;
          lines.push(`# HELP ${name} ${help}`);
          lines.push(`# TYPE ${name} gauge`);
          for (const g of rows) {
            lines.push(`${name}{gpu="${g.index}",name="${escapeLabel(g.name)}"} ${pick(g)}`);
          }
        };
        gpuMetric('promptforge_vram_used_bytes', 'VRAM used in bytes, per GPU.', (g) => g.used);
        gpuMetric('promptforge_vram_total_bytes', 'VRAM installed in bytes, per GPU.', (g) => g.total);
        gpuMetric('promptforge_gpu_utilization_percent', 'GPU utilisation percentage, per GPU.', (g) => g.utilization);
        gpuMetric('promptforge_gpu_temperature_celsius', 'GPU temperature, per GPU.', (g) => g.temperature ?? NaN);
      } catch { /* sysmon not available */ }

      // User count
      try {
        const users = getUserCount();
        lines.push('# HELP promptforge_users_total Total registered users.');
        lines.push('# TYPE promptforge_users_total gauge');
        lines.push(`promptforge_users_total ${users}`);
      } catch { /* user count not available */ }

      return lines.join('\n') + '\n';
    },
  };
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export { routeOf };
