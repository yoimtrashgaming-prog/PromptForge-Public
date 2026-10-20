// MiniMax's H3 prompt-writing guides, fetched on the owner's say-so (20 Oct 2026).
//
// The guides are MiniMax's, under the MiniMax H3 Community License, which
// counts its documentation as part of H3 and does not cover the United
// States, the EU, the UK or South Korea. So PromptForge never ships them, and
// since 20 Oct 2026 it never fetches them silently either: the setup wizard
// (and the Setup panel) shows what they are, links the licence and the
// guides, and downloads them only when the owner agrees. Until then H3 runs
// in its reduced mode and its page says so.
//
// The agreement is saved to data/h3-guides.json. data/ is the volume a
// container keeps, so scripts/docker-start.sh can fetch them again into a
// fresh container, which does not keep prompts/, without asking twice.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const LICENCE_URL = 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE';
export const GUIDE_URLS = [
  'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md',
  'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md',
];

const REFS = 'prompts/video/h3/references';
// The two downloads, and the file the slicer writes, which says it has run.
const NEEDED = ['h3-base-official.md', 'h3-reference-official.md', 'h3-core.md'];

export function createH3Guides({ rootDir, dataDir = 'data' }) {
  const file = path.resolve(rootDir, dataDir, 'h3-guides.json');
  return {
    /** The saved agreement, or null when nobody has agreed. */
    accepted() {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        return saved?.accepted ? saved : null;
      } catch {
        return null;
      }
    },
    accept(by) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ accepted: true, at: new Date().toISOString(), by }, null, 2) + '\n');
    },
    /** True when both guides are downloaded and sliced on this machine. */
    installed() {
      return NEEDED.every((f) => existsSync(path.resolve(rootDir, REFS, f)));
    },
  };
}

/** Whether a registry entry is running without some of its reference files. */
export function referencesMissing(model) {
  return (
    (model?.missing_reference_files?.length ?? 0) > 0 ||
    Object.values(model?.missing_reference_files_by_mode ?? {}).some((l) => l.length > 0)
  );
}
