/**
 * Chat's auto-summary (9 Nov 2026).
 *
 * Every chat turn sends the whole conversation, and the prompts chat writes
 * are long, so a working session fills the model's context in a few dozen
 * turns. Near that ceiling the older part of the conversation is summarised
 * by the model itself, and from then on the model is sent:
 *
 *   system prompt + "Earlier in this conversation" (the summary, plus the
 *   latest prompt written for each model, word for word) + the recent
 *   messages exactly as they were said.
 *
 * The stored messages are never touched: the page shows all of them, and
 * the summary is a separate record on the conversation (chat.compacted).
 *
 * Why the prompts go in word for word, by code rather than through the
 * summary: "make that one darker" needs the actual prompt, and a summary of
 * a prompt is a different prompt.
 *
 * **The person decides when (11 Nov 2026, the owner's call).** It no longer
 * runs on its own: past COMPACT_AT the page asks, with three answers — keep
 * chatting, compact this chat, or continue in a new chat that starts from a
 * summary of this one. contextReport below is what the page's meter shows,
 * counted exactly the way planReplay counts, so the meter's mark and the
 * question arrive together.
 *
 * Token counts are estimated from characters, deliberately on the high side
 * (3 characters a token; English prose runs nearer 4, tag lists nearer 3).
 * Over-counting means summarising a little early, which costs one pass;
 * under-counting means a context error, which costs the turn.
 */

// Ask the person when the estimate passes this share of the context...
export const COMPACT_AT = 0.7;
// ...and past this share "keep chatting" is no longer offered: the reply
// itself needs room, and the next turn would fail with a context error.
export const FULL_AT = 0.95;
// ...and cut so that afterwards the whole request is about this share, the
// rest of the context being the room the conversation has to grow back into.
// Without a target like this, a long system prompt left so little room that
// a summary folded two messages and the next turn summarised again (found
// testing, 9 Nov 2026).
export const TARGET_AFTER = 0.4;
// What the new summary itself is reckoned to cost.
const SUMMARY_ALLOWANCE = 800;
// Not worth a summary pass unless it folds at least this share of the context.
const MIN_FOLD = 0.1;
// Always keep at least this many recent messages, however long they are.
const KEEP_MIN_MESSAGES = 4;
// A picture costs roughly this many tokens to a vision model.
const PICTURE_TOKENS = 1200;
// How many models' latest prompts are carried word for word.
const MAX_CARRIED_PROMPTS = 4;

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3);
}

function messageTokens(m, picturesSent) {
  return estimateTokens(m.content) + 8 + (picturesSent ? (m.pictures ?? 0) * PICTURE_TOKENS : 0);
}

/**
 * Where the replay starts, and whether to summarise first.
 *
 * @param chat        the stored conversation
 * @param systemText  the system prompt as it will be sent, summary block included
 * @param contextTokens  the model's context size
 * @param heldPictures  Map of message index -> pictures still held, or null
 * @returns { from, compact: null | { upto } }
 */
export function planReplay(chat, { systemText, contextTokens, heldPictures = null }) {
  const messages = chat.messages ?? [];
  const from = Math.min(chat.compacted?.upto ?? 0, messages.length);
  let total = estimateTokens(systemText);
  for (let i = from; i < messages.length; i += 1) total += messageTokens(messages[i], heldPictures?.has(i));
  if (total <= contextTokens * COMPACT_AT) return { from, compact: null };

  // Walk back from the end until the recent share is full, then move the cut
  // forward to a message the person wrote, so the replay opens on their turn.
  const budget = contextTokens * TARGET_AFTER - estimateTokens(systemText) - SUMMARY_ALLOWANCE;
  let kept = 0;
  let cut = messages.length;
  while (cut > from) {
    const next = messageTokens(messages[cut - 1], heldPictures?.has(cut - 1));
    if (messages.length - cut >= KEEP_MIN_MESSAGES && kept + next > budget) break;
    kept += next;
    cut -= 1;
  }
  while (cut < messages.length && messages[cut].role !== 'user') cut += 1;
  // Nothing old enough to summarise: the recent messages alone are the bulk.
  // Sent as it is; if it does not fit, the context error says so honestly.
  if (cut <= from || cut >= messages.length) return { from, compact: null };
  let folded = 0;
  for (let i = from; i < cut; i += 1) folded += messageTokens(messages[i], heldPictures?.has(i));
  if (folded < contextTokens * MIN_FOLD) return { from, compact: null };
  return { from, compact: { upto: cut } };
}

/**
 * How full the context is, for the page's meter, counted exactly as
 * planReplay counts: the same system text, the same per-message estimate,
 * the same pictures. `pending` is a message not stored yet (the one being
 * sent), so the question can be asked before it is.
 *
 * @param systemText  as planReplay gets it: base, summary block, tools allowance
 * @param parts       { instructions, summary, tools } texts, for the breakdown
 * @returns { limit, used, compact_at, full_at, parts, summarized }
 */
export function contextReport(chat, { systemText, parts = {}, contextTokens, heldPictures = null, pending = null }) {
  const stored = chat?.messages ?? [];
  const messages = pending ? [...stored, pending] : stored;
  const from = Math.min(chat?.compacted?.upto ?? 0, stored.length);
  let conversation = 0;
  let pictures = 0;
  for (let i = from; i < messages.length; i += 1) {
    const m = messages[i];
    const sent = pending && i === messages.length - 1 ? true : Boolean(heldPictures?.has(i));
    conversation += messageTokens(m, false);
    if (sent) pictures += (m.pictures ?? 0) * PICTURE_TOKENS;
  }
  return {
    limit: contextTokens,
    used: estimateTokens(systemText) + conversation + pictures,
    compact_at: COMPACT_AT,
    full_at: FULL_AT,
    parts: {
      instructions: estimateTokens(parts.instructions),
      summary: estimateTokens(parts.summary),
      tools: estimateTokens(parts.tools),
      conversation,
      pictures,
    },
    summarized: from,
  };
}

/**
 * The latest prompt per model written before `upto`, word for word, skipping
 * models with a later prompt in `skip`. Shared by the in-place summary and a
 * new chat continued from this one, which has none of these messages.
 */
export function carriedPrompts(chat, upto, modelName = (k) => k, skip = new Set()) {
  const messages = chat.messages ?? [];
  const carried = [];
  const seen = new Set();
  for (let i = Math.min(upto, messages.length) - 1; i >= 0 && carried.length < MAX_CARRIED_PROMPTS; i -= 1) {
    const m = messages[i];
    const key = m.tool?.model;
    if (!key || seen.has(key) || skip.has(key)) continue;
    if (m.tool.name !== 'write_prompt' && m.tool.name !== 'render_picture') continue;
    seen.add(key);
    carried.push(`### ${modelName(key)}\n\nThe brief: ${m.tool.brief}\n\n${String(m.content ?? '').trim()}`);
  }
  return carried.reverse();
}

/**
 * What the summariser is asked to read: the previous summary, if there is
 * one, then the messages being folded in, as a plain transcript.
 */
export function summaryRequest(chat, upto, modelName = (k) => k) {
  const messages = chat.messages ?? [];
  const start = Math.min(chat.compacted?.upto ?? 0, upto);
  const lines = [];
  if (chat.compacted?.summary) {
    lines.push('## Your summary of the conversation before this point', '', chat.compacted.summary.trim(), '');
    lines.push('## What was said after that', '');
  } else {
    lines.push('## The conversation so far', '');
  }
  for (let i = start; i < upto; i += 1) {
    const m = messages[i];
    const who = m.role === 'user' ? 'Person' : 'You';
    let text = String(m.content ?? '').trim();
    if (m.tool?.name === 'write_prompt' || m.tool?.name === 'render_picture') {
      // The prompt itself is carried word for word elsewhere; here it only
      // needs to be known that it happened and what it was for.
      text = `[You wrote a ${modelName(m.tool.model)} prompt${m.tool.name === 'render_picture' ? ' and rendered it' : ''}. The brief: ${m.tool.brief}]`;
    } else if (m.tool?.name === 'edit_picture') {
      text = `[You edited the picture. The instruction: ${m.tool.brief}]`;
    }
    if (m.pictures) text = `${text}\n[${m.pictures} picture(s) attached]`.trim();
    lines.push(`${who}: ${text}`, '');
  }
  return lines.join('\n').trim();
}

/**
 * The block appended to the system prompt once a conversation has a summary.
 * Prompts written before the cut go in word for word: the latest per model,
 * unless a later one for that model is still in the recent messages.
 */
export function summaryBlock(chat, modelName = (k) => k) {
  const c = chat.compacted;
  if (!c?.summary) return '';
  const messages = chat.messages ?? [];
  const recentModels = new Set(
    messages.slice(c.upto).filter((m) => m.tool?.model).map((m) => m.tool.model)
  );
  // A chat continued from another carries the old chat's prompts with its
  // summary, because none of those messages are in it; later ones here win.
  const own = carriedPrompts(chat, c.upto, modelName, recentModels);
  const ownModels = new Set(own.map((p) => p.split('\n')[0]));
  const inherited = (Array.isArray(c.carried) ? c.carried : []).filter((p) => !ownModels.has(String(p).split('\n')[0]));
  const carried = [...inherited, ...own];
  const parts = c.from_title
    ? [
      '## The conversation this one continues',
      `This chat continues an earlier one ("${c.from_title}"), which got too long. This is your own summary of it; the messages after it are exactly as they were said.`,
      c.summary.trim(),
    ]
    : [
      '## Earlier in this conversation',
      'The start of this conversation was summarised to make room. This is your own summary of it; the messages after it are exactly as they were said.',
      c.summary.trim(),
    ];
  if (carried.length) {
    parts.push(
      '## Prompts you wrote earlier, word for word',
      'The latest one for each model, as the person last saw it. When they refer back to one, this is the one they mean.',
      ...carried
    );
  }
  return parts.join('\n\n');
}
