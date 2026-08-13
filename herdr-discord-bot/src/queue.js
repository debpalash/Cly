// queue.js — hold prompts aimed at a busy agent until it is free again.
//
// Typing at an agent that is mid-task used to interleave your text with its
// own work, which at best is ignored and at worst derails it. Queue instead,
// and hand the prompt over the moment the agent settles.
//
// State lives in the store so a restart does not lose what you asked for. Each
// entry keeps the message it came from, so the eventual answer can reply to the
// question rather than arriving as an orphan.

const KEY = 'promptQueue';
const MAX_PER_AGENT = 20;

class Queue {
  constructor({ store, log = console } = {}) {
    this.store = store;
    this.log = log;
    this.map = new Map();
    this.#load();
  }

  #load() {
    try {
      const saved = this.store?.getMeta?.(KEY) || {};
      for (const [paneId, items] of Object.entries(saved)) {
        if (Array.isArray(items) && items.length) this.map.set(paneId, items.slice(0, MAX_PER_AGENT));
      }
    } catch (e) {
      this.log.error?.(`[queue] could not restore: ${e.message}`);
    }
  }

  #persist() {
    if (!this.store?.setMeta) return;
    const out = {};
    for (const [paneId, items] of this.map) if (items.length) out[paneId] = items;
    try {
      this.store.setMeta(KEY, out);
    } catch (e) {
      this.log.error?.(`[queue] could not persist: ${e.message}`);
    }
  }

  // Returns this entry's position in line (1 = next up).
  push(paneId, entry) {
    const items = this.map.get(paneId) || [];
    if (items.length >= MAX_PER_AGENT) {
      throw new Error(`queue for ${paneId} is full (${MAX_PER_AGENT})`);
    }
    items.push({ ...entry, at: Date.now() });
    this.map.set(paneId, items);
    this.#persist();
    return items.length;
  }

  shift(paneId) {
    const items = this.map.get(paneId);
    if (!items?.length) return null;
    const next = items.shift();
    if (items.length) this.map.set(paneId, items);
    else this.map.delete(paneId);
    this.#persist();
    return next;
  }

  list(paneId) {
    return [...(this.map.get(paneId) || [])];
  }

  size(paneId) {
    return this.map.get(paneId)?.length || 0;
  }

  clear(paneId) {
    const n = this.size(paneId);
    this.map.delete(paneId);
    this.#persist();
    return n;
  }

  // Drop everything for an agent that no longer exists.
  forget(paneId) {
    if (this.map.delete(paneId)) this.#persist();
  }
}

module.exports = { Queue, MAX_PER_AGENT };
