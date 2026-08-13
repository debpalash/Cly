// Real-time herdr event source.
//
// herdr's socket API (protocol 19) exposes a native subscription mechanism:
//
//   method: "events.subscribe"
//   params: { subscriptions: [ { type: "pane.updated" }, ... ] }
//
// The transport is newline-delimited JSON over the unix socket at
// ~/.config/herdr/herdr.sock. A connection that issues `events.subscribe`
// becomes a *dedicated* event stream: the server answers once with
// {"result":{"type":"subscription_started"}} and then pushes event envelopes
// forever. Sending any other request on that same connection makes the server
// drop it, so this module keeps the stream socket for nothing else.
//
// Event envelopes look like:
//   {"event":"pane_updated","data":{"type":"pane_updated","pane":{...PaneInfo}}}
// PaneInfo carries agent, agent_status, cwd, terminal_title*, workspace_id,
// tab_id and a monotonic `revision` that bumps whenever new terminal output is
// rendered — so one global `pane.updated` subscription covers both "an agent
// changed state" and "new output appeared".
//
// A `herdr agent list` poll is kept as a fallback (used when the socket is
// unavailable) and as a slow reconcile while the stream is live.
//
// Everything shells out via execFile with an argv array — no shell string is
// ever constructed, so nothing here is injectable.

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HERDR_BIN = process.env.HERDR_BIN || 'herdr';
const EXEC_TIMEOUT_MS = Number(process.env.HERDR_TIMEOUT_MS || 15000);

// Global (no pane_id required) subscriptions that together describe the agent
// population and its state. `pane.agent_status_changed` and
// `pane.output_matched` exist too but both require a concrete pane_id, so they
// are unusable for watching every agent at once.
const STREAM_SUBSCRIPTIONS = [
  { type: 'pane.created' },
  { type: 'pane.updated' },
  { type: 'pane.closed' },
  { type: 'pane.exited' },
  { type: 'pane.agent_detected' },
];

const MAX_STREAM_BUFFER = 4 * 1024 * 1024;

function defaultSocketPath() {
  if (process.env.HERDR_SOCK) return process.env.HERDR_SOCK;
  if (process.env.HERDR_SOCKET) return process.env.HERDR_SOCKET;
  const cfgHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(cfgHome, 'herdr', 'herdr.sock');
}

// Same field names as src/herdr.js `normalizeAgent`, plus `revision` (used to
// detect new terminal output).
function normalizeAgent(a) {
  return {
    paneId: a.pane_id,
    agent: a.agent,
    status: a.agent_status,
    cwd: a.cwd,
    title: a.terminal_title_stripped || a.terminal_title || '',
    focused: !!a.focused,
    workspaceId: a.workspace_id,
    tabId: a.tab_id,
    sessionValue: a.agent_session?.value,
    revision: a.revision,
  };
}

function runHerdrJson(args) {
  return new Promise((resolve, reject) => {
    execFile(
      HERDR_BIN,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && String(stderr).trim()) || err.message;
          reject(new Error(`herdr ${args.join(' ')} failed: ${msg}`));
          return;
        }
        const trimmed = String(stdout).trim();
        if (!trimmed) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          reject(new Error(`herdr ${args.join(' ')} returned non-JSON output`));
        }
      },
    );
  });
}

/**
 * @param {object} [opts]
 * @param {number} [opts.pollMs=4000]      Poll interval while the stream is down.
 * @param {number} [opts.reconcileMs=30000] Slow reconcile poll while streaming.
 * @param {number} [opts.outputThrottleMs=1000] Min gap between `agent-output`
 *   emissions for a single pane. 0 disables throttling.
 * @param {boolean} [opts.emitInitial=false] Emit `agent-added` for agents that
 *   already exist at start().
 * @param {boolean} [opts.useStream=true]  Set false to force polling only.
 * @param {number} [opts.readyTimeoutMs=2000] How long start() waits for the
 *   subscription handshake before resolving anyway.
 * @param {string}  [opts.socketPath]      Override the herdr socket path.
 *
 * @returns {EventEmitter & {start:Function, stop:Function, getAgents:Function, isStreaming:Function}}
 *
 * Events:
 *   'ready'         { agents, streaming }        once, after the first snapshot
 *   'agent-added'   agent
 *   'agent-removed' agent
 *   'agent-status'  { ...agent, prevStatus }
 *   'agent-output'  { ...agent, prevRevision }   new terminal output rendered
 *   'stream-open'   { socketPath }
 *   'stream-closed' { reason }
 *   'error'         Error
 */
function createHerdrEvents(opts = {}) {
  const {
    pollMs = 4000,
    reconcileMs = 30000,
    outputThrottleMs = 1000,
    emitInitial = false,
    useStream = true,
    readyTimeoutMs = 2000,
    socketPath = defaultSocketPath(),
  } = opts;

  const emitter = new EventEmitter();

  /** @type {Map<string, ReturnType<typeof normalizeAgent>>} */
  const agents = new Map();
  /** @type {Map<string, number>} */
  const lastOutputAt = new Map();

  let running = false;
  let primed = false;
  let streaming = false;
  let sock = null;
  let sockBuf = '';
  let pollTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let pollInFlight = false;
  let readySettle = null;

  // Resolves once the first subscribe attempt has either succeeded or failed,
  // so the 'ready' payload reports the real transport.
  function settleReady() {
    if (!readySettle) return;
    const fn = readySettle;
    readySettle = null;
    fn();
  }

  function emitError(err) {
    const e = err instanceof Error ? err : new Error(String(err));
    // A stray 'error' with no listener would throw and kill the host process,
    // which is the wrong failure mode for a long-running bot.
    if (emitter.listenerCount('error') > 0) emitter.emit('error', e);
    else console.error('[herdr-events]', e.message);
  }

  // ---- diffing ------------------------------------------------------------

  function emitOutput(next, prevRevision) {
    if (!primed) return;
    if (outputThrottleMs > 0) {
      const now = Date.now();
      const last = lastOutputAt.get(next.paneId) || 0;
      if (now - last < outputThrottleMs) return;
      lastOutputAt.set(next.paneId, now);
    }
    emitter.emit('agent-output', { ...next, prevRevision });
  }

  // Apply one pane's state. Panes without a recognized agent are treated as
  // "not an agent" and drop out of the set.
  function applyPane(raw) {
    if (!raw || !raw.pane_id) return;
    const next = normalizeAgent(raw);
    const prev = agents.get(next.paneId);

    if (!next.agent) {
      if (prev) {
        agents.delete(next.paneId);
        lastOutputAt.delete(next.paneId);
        if (primed) emitter.emit('agent-removed', prev);
      }
      return;
    }

    agents.set(next.paneId, next);

    if (!prev) {
      if (primed || emitInitial) emitter.emit('agent-added', next);
      return;
    }
    if (prev.status !== next.status) {
      emitter.emit('agent-status', { ...next, prevStatus: prev.status });
    }
    if (
      typeof next.revision === 'number' &&
      typeof prev.revision === 'number' &&
      next.revision > prev.revision
    ) {
      emitOutput(next, prev.revision);
    }
  }

  function removePane(paneId) {
    const prev = agents.get(paneId);
    if (!prev) return;
    agents.delete(paneId);
    lastOutputAt.delete(paneId);
    if (primed) emitter.emit('agent-removed', prev);
  }

  // Apply an authoritative full list (`herdr agent list`).
  function applyFullList(list) {
    const seen = new Set();
    for (const raw of list) {
      seen.add(raw.pane_id);
      applyPane(raw);
    }
    for (const paneId of [...agents.keys()]) {
      if (!seen.has(paneId)) removePane(paneId);
    }
  }

  async function snapshot() {
    const data = await runHerdrJson(['agent', 'list']);
    return data?.result?.agents || [];
  }

  // ---- polling ------------------------------------------------------------

  function schedulePoll() {
    if (!running) return;
    clearTimeout(pollTimer);
    const delay = streaming ? reconcileMs : pollMs;
    if (!Number.isFinite(delay) || delay <= 0) return;
    pollTimer = setTimeout(pollOnce, delay);
  }

  async function pollOnce() {
    if (!running || pollInFlight) return;
    pollInFlight = true;
    try {
      applyFullList(await snapshot());
    } catch (err) {
      emitError(err);
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  // ---- stream -------------------------------------------------------------

  function handleEnvelope(msg) {
    if (msg.error) {
      emitError(new Error(`herdr events.subscribe: ${msg.error.message}`));
      return;
    }
    if (msg.id !== undefined && msg.result) {
      if (msg.result.type === 'subscription_started') {
        streaming = true;
        reconnectAttempt = 0;
        settleReady();
        emitter.emit('stream-open', { socketPath });
        // Close the gap between the priming snapshot and the first event.
        pollOnce();
      }
      return;
    }

    const data = msg.data;
    if (!data) return;
    switch (msg.event) {
      case 'pane_created':
      case 'pane_updated':
        applyPane(data.pane);
        break;
      case 'pane_closed':
      case 'pane_exited':
        removePane(data.pane_id);
        break;
      case 'pane_agent_detected':
        // Carries no PaneInfo; `released: true` means the agent went away.
        if (data.released) removePane(data.pane_id);
        break;
      default:
        break;
    }
  }

  function teardownSocket() {
    if (!sock) return;
    const s = sock;
    sock = null;
    sockBuf = '';
    s.removeAllListeners();
    s.destroy();
  }

  function onStreamDown(reason) {
    if (!running) return;
    const wasStreaming = streaming;
    streaming = false;
    teardownSocket();
    settleReady();
    if (wasStreaming) emitter.emit('stream-closed', { reason });
    schedulePoll(); // fall back to the fast poll interval
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectStream();
    }, delay);
  }

  function connectStream() {
    if (!running || sock) return;
    let s;
    try {
      s = net.createConnection({ path: socketPath });
    } catch (err) {
      emitError(err);
      scheduleReconnect();
      return;
    }
    sock = s;
    sockBuf = '';
    s.setEncoding('utf8');

    s.on('connect', () => {
      if (sock !== s) return;
      try {
        s.setNoDelay(true);
      } catch {
        /* not a TCP socket; ignore */
      }
      // Exactly one request on this connection, ever.
      s.write(
        `${JSON.stringify({
          id: 'herdr-events:subscribe',
          method: 'events.subscribe',
          params: { subscriptions: STREAM_SUBSCRIPTIONS },
        })}\n`,
      );
    });

    s.on('data', (chunk) => {
      if (sock !== s) return;
      sockBuf += chunk;
      if (sockBuf.length > MAX_STREAM_BUFFER) {
        sockBuf = '';
        emitError(new Error('herdr event stream buffer overflow; resetting'));
        onStreamDown('overflow');
        return;
      }
      let nl;
      while ((nl = sockBuf.indexOf('\n')) !== -1) {
        const line = sockBuf.slice(0, nl).trim();
        sockBuf = sockBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          emitError(new Error('herdr event stream sent unparseable JSON'));
          continue;
        }
        try {
          handleEnvelope(msg);
        } catch (err) {
          emitError(err);
        }
      }
    });

    s.on('error', (err) => {
      if (sock !== s) return;
      if (streaming || reconnectAttempt === 0) emitError(err);
      onStreamDown(err.message);
    });

    s.on('close', () => {
      if (sock !== s) return;
      onStreamDown('closed');
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  async function start() {
    if (running) return emitter;
    running = true;
    reconnectAttempt = 0;

    try {
      applyFullList(await snapshot());
    } catch (err) {
      emitError(err);
    }
    if (!running) return emitter;
    primed = true;

    if (useStream) {
      await new Promise((resolve) => {
        const timer = setTimeout(settleReady, readyTimeoutMs);
        readySettle = () => {
          clearTimeout(timer);
          resolve();
        };
        connectStream();
      });
      if (!running) return emitter;
    }
    schedulePoll();
    emitter.emit('ready', { agents: [...agents.values()], streaming });
    return emitter;
  }

  function stop() {
    running = false;
    streaming = false;
    primed = false;
    clearTimeout(pollTimer);
    clearTimeout(reconnectTimer);
    pollTimer = null;
    reconnectTimer = null;
    teardownSocket();
    settleReady();
    agents.clear();
    lastOutputAt.clear();
  }

  emitter.start = start;
  emitter.stop = stop;
  emitter.getAgents = () => [...agents.values()];
  emitter.isStreaming = () => streaming;
  emitter.socketPath = socketPath;

  return emitter;
}

module.exports = { createHerdrEvents, normalizeAgent };
