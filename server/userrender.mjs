// Per-user render things: uploaded workflows and saved presets.
//
// Stage 3 of docs/render-plan.md, kept small on purpose (owner, 3 Oct 2026:
// "we arent mapping all of comfyui into promptforge"):
//   - an upload is a ComfyUI Export (API) file, optionally with the normal
//     save of the same graph for the PNG; it serves one or more models;
//   - nodes are found the same way as for the starters (mapWorkflow), so
//     there is no mapping screen — a workflow that does not map is refused;
//   - a workflow uploaded by anyone but the owner waits for the owner's
//     approval before it can run, because a workflow is a program ComfyUI
//     runs on the server and some node packs can touch files;
//   - presets are named, private, per model.
//
// Lives under the user's own folder (data/users/<name>/render/), so it goes
// wherever their account goes.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mapWorkflow } from './comfyui.mjs';

const NAME_MAX = 80;
const MAX_WORKFLOWS = 30;
const MAX_PRESETS = 40;
const MAX_NODES = 400;

function fail(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

const cleanName = (v, what) => {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw fail(400, `Give the ${what} a name.`);
  if (n.length > NAME_MAX) throw fail(400, `Names are capped at ${NAME_MAX} characters.`);
  return n;
};

/**
 * Check an uploaded API workflow. Returns the node types it uses. The two
 * shapes people upload by mistake are named, because "not a workflow" helps
 * nobody: the normal save has a `nodes` array, the API export does not.
 */
export function checkApiWorkflow(api) {
  if (!api || typeof api !== 'object' || Array.isArray(api)) throw fail(400, 'That is not a ComfyUI workflow.');
  if (Array.isArray(api.nodes)) {
    throw fail(400, 'That is the normal ComfyUI save. Export it with "Export (API)" from the Workflow menu and upload that one.');
  }
  const nodes = Object.values(api);
  if (!nodes.length || nodes.some((n) => !n || typeof n.class_type !== 'string' || typeof n.inputs !== 'object')) {
    throw fail(400, 'That is not a ComfyUI API workflow: every node needs a class_type and inputs.');
  }
  if (nodes.length > MAX_NODES) throw fail(400, `At most ${MAX_NODES} nodes.`);
  if (nodes.some((n) => n.class_type === 'SamplerCustomAdvanced')) {
    throw fail(400, 'Workflows with a split sampler (SamplerCustomAdvanced) are not supported yet. Use one with a plain KSampler.');
  }
  const map = mapWorkflow(api);
  if (map.error) throw fail(400, map.error);
  return [...new Set(nodes.map((n) => n.class_type))].sort();
}

export function createUserRender(rootDir, config) {
  const usersDir = path.resolve(rootDir, config.paths?.users ?? 'data/users');
  const dirFor = (user) => path.join(usersDir, user, 'render');
  const indexFile = (user) => path.join(dirFor(user), 'index.json');

  function read(user) {
    try {
      const j = JSON.parse(readFileSync(indexFile(user), 'utf8'));
      return { workflows: j.workflows ?? [], presets: j.presets ?? [] };
    } catch {
      return { workflows: [], presets: [] };
    }
  }

  function write(user, data) {
    mkdirSync(dirFor(user), { recursive: true });
    const tmp = `${indexFile(user)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, indexFile(user));
  }

  const idOk = (id) => /^w_[a-f0-9]{16}$/.test(String(id));

  return {
    read,

    /** The graph itself, or null. Only the owner of the record ever reads it through here. */
    workflowFiles(user, id) {
      if (!idOk(id)) return null;
      try {
        return JSON.parse(readFileSync(path.join(dirFor(user), `${id}.json`), 'utf8'));
      } catch {
        return null;
      }
    },

    addWorkflow(user, { name, models, api, ui, approved }, { modelKeys }) {
      const data = read(user);
      if (data.workflows.length >= MAX_WORKFLOWS) throw fail(400, `At most ${MAX_WORKFLOWS} workflows each. Delete one first.`);
      const list = [...new Set(Array.isArray(models) ? models : [models])].filter(Boolean);
      if (!list.length) throw fail(400, 'Pick which model the workflow is for.');
      for (const m of list) if (!modelKeys.includes(m)) throw fail(400, `Unknown model "${m}".`);
      const nodeTypes = checkApiWorkflow(api);
      if (ui !== undefined && ui !== null && !Array.isArray(ui?.nodes)) {
        throw fail(400, 'The second file should be the normal ComfyUI save (the one with "nodes"). Leave it out if you do not have it.');
      }
      const id = `w_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      mkdirSync(dirFor(user), { recursive: true });
      writeFileSync(path.join(dirFor(user), `${id}.json`), JSON.stringify({ api, ui: ui ?? null }));
      const entry = {
        id,
        name: cleanName(name, 'workflow'),
        models: list,
        node_types: nodeTypes,
        approved: Boolean(approved),
        created_at: new Date().toISOString(),
      };
      data.workflows.push(entry);
      write(user, data);
      return entry;
    },

    removeWorkflow(user, id) {
      const data = read(user);
      if (!data.workflows.some((w) => w.id === id)) throw fail(404, 'No such workflow.');
      data.workflows = data.workflows.filter((w) => w.id !== id);
      write(user, data);
      if (idOk(id)) rmSync(path.join(dirFor(user), `${id}.json`), { force: true });
    },

    setApproved(user, id, approved) {
      const data = read(user);
      const w = data.workflows.find((x) => x.id === id);
      if (!w) throw fail(404, 'No such workflow.');
      w.approved = Boolean(approved);
      w.approved_at = new Date().toISOString();
      write(user, data);
      return w;
    },

    /** Every workflow waiting for the owner, across accounts. */
    pending() {
      if (!existsSync(usersDir)) return [];
      return readdirSync(usersDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) => read(d.name).workflows.filter((w) => !w.approved).map((w) => ({ user: d.name, ...w })));
    },

    savePreset(user, raw, { modelKeys }) {
      const data = read(user);
      const name = cleanName(raw?.name, 'preset');
      if (!modelKeys.includes(raw?.model)) throw fail(400, `Unknown model "${raw?.model}".`);
      const preset = { name, model: raw.model };
      for (const k of ['steps', 'cfg']) {
        const n = Number(raw[k]);
        if (!Number.isFinite(n)) throw fail(400, `The preset needs ${k}.`);
        preset[k] = n;
      }
      for (const k of ['sampler', 'scheduler', 'model_file']) if (raw[k]) preset[k] = String(raw[k]);
      // Same name for the same model replaces: saving again is how you update one.
      data.presets = data.presets.filter((p) => !(p.model === preset.model && p.name === name));
      if (data.presets.length >= MAX_PRESETS) throw fail(400, `At most ${MAX_PRESETS} presets each. Delete one first.`);
      data.presets.push(preset);
      write(user, data);
      return preset;
    },

    removePreset(user, model, name) {
      const data = read(user);
      const before = data.presets.length;
      data.presets = data.presets.filter((p) => !(p.model === model && p.name === name));
      if (data.presets.length === before) throw fail(404, 'No such preset.');
      write(user, data);
    },
  };
}
