// Pictures sent in chat, held in memory and never written to disk (26 Sep 2026).
//
// The owner's ask: upload a picture into chat "not downloaded but set to view
// via RAM like the analyze is". Image Analysis never stores what it reads, and
// chat should not either — but a conversation is saved to disk, so the
// picture has to live somewhere else. It lives here, keyed by conversation and
// by the index of the message it was sent with, so every later turn replays it
// in the same place (which also keeps llama.cpp's prompt cache valid).
//
// Forgotten after IDLE_MS without use, when the conversation is deleted, when
// more than MAX_CHATS conversations hold pictures, and on every restart. The
// stored message keeps only a count, so a reopened conversation can say a
// picture was there without having it.

const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_CHATS = 40;

/** `${user}\0${chatId}` -> { at, byIndex: Map<messageIndex, string[] data URLs> } */
const held = new Map();

function sweep(now = Date.now()) {
  for (const [key, entry] of held) {
    if (now - entry.at > IDLE_MS) held.delete(key);
  }
  // Map iterates in insertion order and touch() re-inserts, so the first
  // keys are the least recently used.
  while (held.size > MAX_CHATS) held.delete(held.keys().next().value);
}

function touch(key, entry) {
  entry.at = Date.now();
  held.delete(key);
  held.set(key, entry);
}

/** Hold the pictures sent with message `index` of this conversation. */
export function hold(user, chatId, index, dataUrls) {
  if (!dataUrls?.length) return;
  const key = `${user}\0${chatId}`;
  const entry = held.get(key) ?? { at: 0, byIndex: new Map() };
  entry.byIndex.set(index, dataUrls);
  touch(key, entry);
  sweep();
}

/** The pictures still held for a conversation, by message index; null if none. */
export function forChat(user, chatId) {
  sweep();
  const key = `${user}\0${chatId}`;
  const entry = held.get(key);
  if (!entry) return null;
  touch(key, entry);
  return entry.byIndex;
}

/** Forget a conversation's pictures, when the conversation itself goes. */
export function drop(user, chatId) {
  held.delete(`${user}\0${chatId}`);
}
