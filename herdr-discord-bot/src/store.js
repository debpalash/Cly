// store.js — tiny JSON-file-backed persistent key/value store.
//
// Purpose: remember how herdr entities map onto Discord entities across bot
// restarts (workspace -> channel, agent pane -> thread), plus a small bag of
// misc state (e.g. the last status we announced for a pane).
//
// Design notes:
//   * Writes are ATOMIC: we write a temp file in the same directory and then
//     rename() over the target, so a crash mid-write can never leave a
//     half-written mapping.json behind.
//   * Writes are DEBOUNCED (default 500ms): status polling can touch the store
//     many times a second; we coalesce that into at most one disk write per
//     window. close() always flushes anything still pending.
//   * A missing or corrupt file is never fatal — we start fresh (and move the
//     corrupt file aside once, so it can be inspected instead of silently lost).
//   * No npm dependencies; node builtins only.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'mapping.json');
const DEFAULT_DEBOUNCE_MS = 500;
const SCHEMA_VERSION = 1;

function emptyData() {
  return {
    version: SCHEMA_VERSION,
    // herdr workspace_id -> Discord channel id
    workspaceChannels: Object.create(null),
    // herdr pane_id -> Discord thread id
    agentThreads: Object.create(null),
    // free-form small state (last-seen status per pane, etc.)
    meta: Object.create(null),
  };
}

// Accept whatever is on disk but guarantee the shape callers rely on.
function normalizeData(raw) {
  const data = emptyData();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return data;

  const copyStrings = (src, dest) => {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' && v) dest[k] = v;
    }
  };

  copyStrings(raw.workspaceChannels, data.workspaceChannels);
  copyStrings(raw.agentThreads, data.agentThreads);

  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    for (const [k, v] of Object.entries(raw.meta)) {
      if (v !== undefined) data.meta[k] = v;
    }
  }
  return data;
}

function isString(v) {
  return typeof v === 'string' && v.length > 0;
}

class Store {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file]        path to the JSON file
   * @param {number} [opts.debounceMs]  coalescing window for writes
   */
  constructor(opts = {}) {
    this.file = opts.file || process.env.HERDR_BOT_STORE || DEFAULT_FILE;
    this.debounceMs = Number.isFinite(opts.debounceMs)
      ? Math.max(0, opts.debounceMs)
      : DEFAULT_DEBOUNCE_MS;

    this.data = emptyData();
    this.loaded = false;

    this._timer = null;
    this._dirty = false;
    // Serializes overlapping save() calls so two writers can't interleave.
    this._chain = Promise.resolve();
  }

  // ---- persistence --------------------------------------------------------

  /**
   * Read the file into memory. Safe to call more than once. Never throws for
   * "file missing" or "file is garbage" — those just yield an empty store.
   * @returns {Promise<object>} the in-memory data
   */
  async load() {
    let text;
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] could not read ${this.file}: ${err.message} — starting fresh`);
      }
      this.data = emptyData();
      this.loaded = true;
      return this.data;
    }

    if (!text.trim()) {
      // Zero-length file: an interrupted write, not corruption worth keeping.
      this.data = emptyData();
      this.loaded = true;
      return this.data;
    }

    try {
      this.data = normalizeData(JSON.parse(text));
    } catch (err) {
      console.warn(`[store] ${this.file} is corrupt (${err.message}) — starting fresh`);
      await this._quarantine(text);
      this.data = emptyData();
    }
    this.loaded = true;
    return this.data;
  }

  /** Synchronous sibling of load(), for use before the event loop is running. */
  loadSync() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] could not read ${this.file}: ${err.message} — starting fresh`);
      }
      this.data = emptyData();
      this.loaded = true;
      return this.data;
    }
    try {
      this.data = text.trim() ? normalizeData(JSON.parse(text)) : emptyData();
    } catch (err) {
      console.warn(`[store] ${this.file} is corrupt (${err.message}) — starting fresh`);
      this.data = emptyData();
    }
    this.loaded = true;
    return this.data;
  }

  /** Write immediately and atomically, cancelling any pending debounced save. */
  save() {
    this._clearTimer();
    this._dirty = false;
    const payload = JSON.stringify(this.data, null, 2) + '\n';
    this._chain = this._chain
      .then(() => this._atomicWrite(payload))
      .catch((err) => {
        console.error(`[store] save failed: ${err.message}`);
      });
    return this._chain;
  }

  /** Blocking atomic write — for process-exit handlers where async is useless. */
  saveSync() {
    this._clearTimer();
    this._dirty = false;
    const payload = JSON.stringify(this.data, null, 2) + '\n';
    const dir = path.dirname(this.file);
    const tmp = this._tmpPath();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      console.error(`[store] saveSync failed: ${err.message}`);
    }
  }

  /** Flush any pending debounced write. Resolves once the disk is up to date. */
  async flush() {
    if (this._dirty || this._timer) return this.save();
    return this._chain;
  }

  /** Stop the debounce timer and flush. Call this on shutdown. */
  async close() {
    const pending = this._dirty || this._timer !== null;
    this._clearTimer();
    if (pending) await this.save();
    else await this._chain;
    return true;
  }

  // ---- workspace -> channel ----------------------------------------------

  /** @returns {string|null} Discord channel id for a herdr workspace */
  getChannelForWorkspace(workspaceId) {
    if (!isString(workspaceId)) return null;
    return this.data.workspaceChannels[workspaceId] || null;
  }

  setChannelForWorkspace(workspaceId, channelId) {
    if (!isString(workspaceId)) return false;
    if (!isString(channelId)) {
      if (this.data.workspaceChannels[workspaceId] === undefined) return false;
      delete this.data.workspaceChannels[workspaceId];
      this._touch();
      return true;
    }
    if (this.data.workspaceChannels[workspaceId] === channelId) return false;
    this.data.workspaceChannels[workspaceId] = channelId;
    this._touch();
    return true;
  }

  // ---- agent pane -> thread ----------------------------------------------

  /** @returns {string|null} Discord thread id for a herdr pane id */
  getThreadForAgent(paneId) {
    if (!isString(paneId)) return null;
    return this.data.agentThreads[paneId] || null;
  }

  setThreadForAgent(paneId, threadId) {
    if (!isString(paneId)) return false;
    if (!isString(threadId)) return this.deleteThreadForAgent(paneId);
    if (this.data.agentThreads[paneId] === threadId) return false;
    this.data.agentThreads[paneId] = threadId;
    this._touch();
    return true;
  }

  deleteThreadForAgent(paneId) {
    if (!isString(paneId)) return false;
    if (this.data.agentThreads[paneId] === undefined) return false;
    delete this.data.agentThreads[paneId];
    this._touch();
    return true;
  }

  /** @returns {Array<{paneId: string, threadId: string}>} */
  allAgentThreads() {
    return Object.entries(this.data.agentThreads).map(([paneId, threadId]) => ({
      paneId,
      threadId,
    }));
  }

  /** @returns {Array<{workspaceId: string, channelId: string}>} */
  allWorkspaceChannels() {
    return Object.entries(this.data.workspaceChannels).map(([workspaceId, channelId]) => ({
      workspaceId,
      channelId,
    }));
  }

  // ---- misc state ---------------------------------------------------------

  getMeta(key, fallback = undefined) {
    if (!isString(key)) return fallback;
    const v = this.data.meta[key];
    return v === undefined ? fallback : v;
  }

  setMeta(key, value) {
    if (!isString(key)) return false;
    if (value === undefined) {
      if (this.data.meta[key] === undefined) return false;
      delete this.data.meta[key];
      this._touch();
      return true;
    }
    if (this.data.meta[key] === value) return false;
    this.data.meta[key] = value;
    this._touch();
    return true;
  }

  deleteMeta(key) {
    return this.setMeta(key, undefined);
  }

  /** Wipe everything (useful for tests / `/reset`). */
  clear() {
    this.data = emptyData();
    this._touch();
  }

  // ---- internals ----------------------------------------------------------

  _touch() {
    this._dirty = true;
    if (this.debounceMs === 0) {
      this.save();
      return;
    }
    if (this._timer) return; // already coalescing into the pending write
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.save();
    }, this.debounceMs);
    // Never keep the process alive just for a pending save.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _tmpPath() {
    const rand = Math.random().toString(36).slice(2, 8);
    return path.join(
      path.dirname(this.file),
      `.${path.basename(this.file)}.${process.pid}.${rand}.tmp`,
    );
  }

  async _atomicWrite(payload) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this._tmpPath();
    try {
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.writeFile(payload, 'utf8');
        // Best-effort durability; not supported everywhere, never fatal.
        await fh.sync().catch(() => {});
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, this.file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // Keep a copy of an unparseable file so the data isn't silently destroyed.
  async _quarantine(text) {
    try {
      await fsp.writeFile(`${this.file}.corrupt`, text, 'utf8');
    } catch {
      /* best effort only */
    }
  }
}

// Shared instance for the bot process. Callers still have to await load().
const store = new Store();

module.exports = { Store, store, DEFAULT_FILE, SCHEMA_VERSION };
