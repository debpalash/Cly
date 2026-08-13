// Extended wrapper around the `herdr` CLI — the surface `src/herdr.js` does not
// cover: workspaces, tabs, panes, sessions, worktrees, notifications, and
// creating brand-new agents from scratch.
//
// Same conventions as src/herdr.js:
//   * every invocation goes through execFile with an argv ARRAY — no shell
//     string is ever built from caller/Discord input, so nothing can inject.
//   * runHerdr / runHerdrJson are the only two entry points to the binary.
//   * every export returns normalized camelCase plain objects, never raw CLI
//     JSON, so callers never touch snake_case or the {id, result} envelope.

const { execFile } = require('node:child_process');
const path = require('node:path');

const HERDR_BIN = process.env.HERDR_BIN || 'herdr';
const EXEC_TIMEOUT_MS = Number(process.env.HERDR_TIMEOUT_MS || 15000);
// `agent start` blocks until herdr detects the agent is ready for input; its
// own default is 30s, so the exec timeout has to be comfortably larger.
const AGENT_START_TIMEOUT_MS = Number(
  process.env.HERDR_AGENT_START_TIMEOUT_MS || 60000,
);

// Agent kinds `herdr agent start --kind` accepts (from `herdr agent`).
const AGENT_KINDS = Object.freeze([
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'maki',
]);

// herdr enforces this on agent names: [a-z][a-z0-9_-]{0,31}
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- CLI plumbing ----------------------------------------------------------

// herdr reports server errors as JSON on stderr with exit status 1, e.g.
//   {"error":{"code":"agent_not_found","message":"..."},"id":"cli:agent:get"}
// Turn that into a readable Error instead of leaking the raw envelope.
function describeFailure(args, stderr, fallback) {
  const raw = (stderr || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.error && parsed.error.message) {
        const code = parsed.error.code ? ` (${parsed.error.code})` : '';
        return `herdr ${args.join(' ')} failed: ${parsed.error.message}${code}`;
      }
    } catch {
      /* not JSON — fall through to the raw text */
    }
    return `herdr ${args.join(' ')} failed: ${raw}`;
  }
  return `herdr ${args.join(' ')} failed: ${fallback}`;
}

function runHerdr(args, { timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      HERDR_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(describeFailure(args, stderr, err.message)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function runHerdrJson(args, opts) {
  const out = await runHerdr(args, opts);
  const trimmed = out.trim();
  if (!trimmed) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Some subcommands print plain text; return it raw for callers that want it.
    return { _raw: out };
  }
  // Belt and braces: a few paths can print an error envelope on stdout.
  if (parsed && parsed.error) {
    const { code, message } = parsed.error;
    throw new Error(
      `herdr ${args.join(' ')} failed: ${message || 'unknown error'}${
        code ? ` (${code})` : ''
      }`,
    );
  }
  return parsed;
}

// ---- Argument validation ---------------------------------------------------
// execFile already makes shell injection impossible; these checks exist so a
// bad Discord argument fails fast with a useful message instead of confusing
// the CLI's own parser (e.g. a value that starts with `--`).

function requireString(value, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new Error(`${label} is required`);
  if (s.startsWith('-')) throw new Error(`${label} may not start with "-"`);
  if (/[\0\n\r]/.test(s)) throw new Error(`${label} contains invalid characters`);
  return s;
}

function requireAbsolutePath(value, label) {
  const s = requireString(value, label);
  if (!path.isAbsolute(s)) throw new Error(`${label} must be an absolute path`);
  return s;
}

function optionalAbsolutePath(value, label) {
  if (value == null || value === '') return null;
  return requireAbsolutePath(value, label);
}

function requireOneOf(value, allowed, label) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!allowed.includes(s)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return s;
}

// `--env KEY=VALUE`, repeatable. Accepts an object or an array of "K=V".
function envArgs(env) {
  if (!env) return [];
  const pairs = Array.isArray(env)
    ? env.map((e) => {
        const i = String(e).indexOf('=');
        if (i < 1) throw new Error(`env entry "${e}" must be KEY=VALUE`);
        return [String(e).slice(0, i), String(e).slice(i + 1)];
      })
    : Object.entries(env);

  const out = [];
  for (const [key, value] of pairs) {
    const k = String(key);
    if (!ENV_KEY_RE.test(k)) throw new Error(`Invalid env var name "${k}"`);
    const v = String(value == null ? '' : value);
    if (/[\0\n\r]/.test(v)) {
      throw new Error(`env var "${k}" contains invalid characters`);
    }
    out.push('--env', `${k}=${v}`);
  }
  return out;
}

function focusArgs(focus) {
  return focus ? ['--focus'] : ['--no-focus'];
}

// ---- Normalizers -----------------------------------------------------------

// Superset of the shape src/herdr.js#normalizeAgent produces — identical key
// names for the overlapping fields, so the two are interchangeable downstream.
function normalizeAgent(a) {
  if (!a) return null;
  return {
    paneId: a.pane_id,
    name: a.name || null,
    agent: a.agent,
    status: a.agent_status,
    cwd: a.cwd,
    foregroundCwd: a.foreground_cwd,
    title: a.terminal_title_stripped || a.terminal_title || '',
    focused: !!a.focused,
    workspaceId: a.workspace_id,
    tabId: a.tab_id,
    terminalId: a.terminal_id,
    sessionValue: a.agent_session?.value,
    interactiveReady: a.interactive_ready ?? null,
    stateChangeSeq: a.state_change_seq ?? null,
    revision: a.revision ?? null,
  };
}

function normalizeWorkspace(w) {
  if (!w) return null;
  return {
    workspaceId: w.workspace_id,
    label: w.label || '',
    number: w.number ?? null,
    activeTabId: w.active_tab_id || null,
    tabCount: w.tab_count ?? 0,
    paneCount: w.pane_count ?? 0,
    agentStatus: w.agent_status || 'unknown',
    focused: !!w.focused,
    // Present only on workspaces backed by a git worktree/checkout.
    worktree: w.worktree
      ? {
          checkoutPath: w.worktree.checkout_path,
          repoName: w.worktree.repo_name,
          repoRoot: w.worktree.repo_root,
          isLinked: !!w.worktree.is_linked_worktree,
        }
      : null,
  };
}

function normalizeTab(t) {
  if (!t) return null;
  return {
    tabId: t.tab_id,
    workspaceId: t.workspace_id,
    label: t.label || '',
    number: t.number ?? null,
    paneCount: t.pane_count ?? 0,
    agentStatus: t.agent_status || 'unknown',
    focused: !!t.focused,
  };
}

function normalizePane(p) {
  if (!p) return null;
  return {
    paneId: p.pane_id,
    tabId: p.tab_id,
    workspaceId: p.workspace_id,
    cwd: p.cwd,
    foregroundCwd: p.foreground_cwd,
    agent: p.agent || null,
    agentStatus: p.agent_status || 'unknown',
    title: p.terminal_title_stripped || p.terminal_title || '',
    focused: !!p.focused,
    terminalId: p.terminal_id,
    sessionValue: p.agent_session?.value,
    revision: p.revision ?? null,
  };
}

function normalizeSession(s) {
  if (!s) return null;
  return {
    name: s.name,
    isDefault: !!s.default,
    running: !!s.running,
    sessionDir: s.session_dir || null,
    socketPath: s.socket_path || null,
  };
}

// `repo` carries the shared source block so each entry is self-describing.
function normalizeWorktree(w, repo) {
  if (!w) return null;
  return {
    path: w.path,
    branch: w.branch || null,
    label: w.label || '',
    isBare: !!w.is_bare,
    isDetached: !!w.is_detached,
    isLinked: !!w.is_linked_worktree,
    isPrunable: !!w.is_prunable,
    openWorkspaceId: w.open_workspace_id || null,
    repoName: repo?.repo_name || null,
    repoRoot: repo?.repo_root || null,
  };
}

function normalizeRule(r) {
  if (!r) return null;
  return {
    id: r.id,
    state: r.state,
    region: r.region,
    priority: r.priority ?? null,
    matched: !!r.matched,
  };
}

// ---- Read-only listings ----------------------------------------------------

async function listWorkspaces() {
  const data = await runHerdrJson(['workspace', 'list']);
  return (data?.result?.workspaces || []).map(normalizeWorkspace);
}

async function getWorkspace(workspaceId) {
  const id = requireString(workspaceId, 'workspaceId');
  const data = await runHerdrJson(['workspace', 'get', id]);
  const w = data?.result?.workspace;
  if (!w) throw new Error(`No workspace found for "${workspaceId}"`);
  return normalizeWorkspace(w);
}

// `herdr session list --json` returns a bare {sessions:[...]}, not the usual
// {id, result} envelope.
async function listSessions() {
  const data = await runHerdrJson(['session', 'list', '--json']);
  return (data?.sessions || []).map(normalizeSession);
}

async function listTabs(workspaceId) {
  const args = ['tab', 'list'];
  if (workspaceId) args.push('--workspace', requireString(workspaceId, 'workspaceId'));
  const data = await runHerdrJson(args);
  return (data?.result?.tabs || []).map(normalizeTab);
}

async function getTab(tabId) {
  const id = requireString(tabId, 'tabId');
  const data = await runHerdrJson(['tab', 'get', id]);
  const t = data?.result?.tab;
  if (!t) throw new Error(`No tab found for "${tabId}"`);
  return normalizeTab(t);
}

async function listPanes(workspaceId) {
  const args = ['pane', 'list'];
  if (workspaceId) args.push('--workspace', requireString(workspaceId, 'workspaceId'));
  const data = await runHerdrJson(args);
  return (data?.result?.panes || []).map(normalizePane);
}

async function getPane(paneId) {
  const id = requireString(paneId, 'paneId');
  const data = await runHerdrJson(['pane', 'get', id]);
  const p = data?.result?.pane;
  if (!p) throw new Error(`No pane found for "${paneId}"`);
  return normalizePane(p);
}

// Scoped by workspace OR cwd; with neither, herdr uses the focused workspace.
// Throws `not_git_worktree` if the target isn't inside a git work tree.
async function listWorktrees({ workspaceId, cwd } = {}) {
  const args = ['worktree', 'list'];
  if (workspaceId) args.push('--workspace', requireString(workspaceId, 'workspaceId'));
  else if (cwd) args.push('--cwd', requireAbsolutePath(cwd, 'cwd'));
  const data = await runHerdrJson(args);
  const repo = data?.result?.source;
  return (data?.result?.worktrees || []).map((w) => normalizeWorktree(w, repo));
}

// ---- Layout creation -------------------------------------------------------

async function createWorkspace({ cwd, label, env, focus = false } = {}) {
  const args = ['workspace', 'create'];
  const dir = optionalAbsolutePath(cwd, 'cwd');
  if (dir) args.push('--cwd', dir);
  if (label) args.push('--label', requireString(label, 'label'));
  args.push(...envArgs(env), ...focusArgs(focus));

  const data = await runHerdrJson(args);
  const r = data?.result;
  if (!r?.root_pane) throw new Error('herdr workspace create returned no pane');
  return {
    workspace: normalizeWorkspace(r.workspace),
    tab: normalizeTab(r.tab),
    pane: normalizePane(r.root_pane),
  };
}

async function createTab({ workspaceId, cwd, label, env, focus = false } = {}) {
  const args = ['tab', 'create'];
  if (workspaceId) args.push('--workspace', requireString(workspaceId, 'workspaceId'));
  const dir = optionalAbsolutePath(cwd, 'cwd');
  if (dir) args.push('--cwd', dir);
  if (label) args.push('--label', requireString(label, 'label'));
  args.push(...envArgs(env), ...focusArgs(focus));

  const data = await runHerdrJson(args);
  const r = data?.result;
  if (!r?.root_pane) throw new Error('herdr tab create returned no pane');
  return { tab: normalizeTab(r.tab), pane: normalizePane(r.root_pane) };
}

async function splitPane({
  paneId,
  direction = 'right',
  cwd,
  ratio,
  env,
  focus = false,
} = {}) {
  const id = requireString(paneId, 'paneId');
  const dir = requireOneOf(direction, ['right', 'down'], 'direction');
  const args = ['pane', 'split', '--pane', id, '--direction', dir];
  const wd = optionalAbsolutePath(cwd, 'cwd');
  if (wd) args.push('--cwd', wd);
  if (ratio != null) {
    const n = Number(ratio);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) {
      throw new Error('ratio must be a number strictly between 0 and 1');
    }
    args.push('--ratio', String(n));
  }
  args.push(...envArgs(env), ...focusArgs(focus));

  const data = await runHerdrJson(args);
  const p = data?.result?.pane;
  if (!p) throw new Error('herdr pane split returned no pane');
  return normalizePane(p);
}

// ---- Creating an agent from scratch ---------------------------------------

// A pane herdr has only just created can still be settling its shell, and
// `agent start` reports that as `agent_pane_busy`. That is a race, not a
// refusal, so retry it briefly. Any other failure is returned untouched.
const PANE_BUSY = /agent_pane_busy|not an available shell/i;

async function retryWhilePaneBusy(fn, { attempts = 6, waitMs = 750 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!PANE_BUSY.test(err.message || '')) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// herdr requires the name to be unique among *live* agents.
async function generateAgentName(agentType) {
  let taken = new Set();
  try {
    const data = await runHerdrJson(['agent', 'list']);
    taken = new Set(
      (data?.result?.agents || []).map((a) => a.name).filter(Boolean),
    );
  } catch {
    // If the listing fails, fall back to raw randomness.
  }
  for (let i = 0; i < 20; i += 1) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const candidate = `${agentType}-${suffix}`.slice(0, 32);
    if (AGENT_NAME_RE.test(candidate) && !taken.has(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique agent name');
}

/**
 * Create a brand-new agent from scratch: make a terminal location, then start
 * an agent in it. `herdr agent start` never creates layout itself, so this is
 * always a two-step sequence.
 *
 * Placement is chosen from the arguments:
 *   paneId given      -> split that pane           (`pane split`)
 *   workspaceId given -> new tab in that workspace (`tab create`)
 *   neither           -> brand-new workspace       (`workspace create`)
 *
 * The new-workspace default is deliberate: it is the only option that cannot
 * shrink or disturb a pane someone else is working in.
 *
 * If `agent start` fails, the layout created here is rolled back so a failed
 * attempt never leaves an orphan pane or workspace behind.
 *
 * @returns {Promise<object>} { agent, paneId, tabId, workspaceId, name,
 *   placement, argv, created } where `created` records what to clean up.
 */
async function newAgent({
  agentType,
  cwd,
  workspaceId,
  paneId,
  name,
  label,
  direction = 'right',
  ratio,
  env,
  agentArgs,
  focus = false,
  timeoutMs = AGENT_START_TIMEOUT_MS,
} = {}) {
  const kind = requireOneOf(agentType, AGENT_KINDS, 'agentType');
  const dir = optionalAbsolutePath(cwd, 'cwd');

  let agentName;
  if (name) {
    agentName = String(name).trim();
    if (!AGENT_NAME_RE.test(agentName)) {
      throw new Error(
        `Invalid agent name "${name}": must match [a-z][a-z0-9_-]{0,31}`,
      );
    }
  } else {
    agentName = await generateAgentName(kind);
  }

  const startupTimeout = Math.max(1000, Number(timeoutMs) || AGENT_START_TIMEOUT_MS);
  const paneLabel = label || (dir ? path.basename(dir) : kind);

  // --- Step 1: create the terminal location.
  let placement;
  let pane;
  const created = { workspaceId: null, tabId: null, paneId: null };

  if (paneId) {
    placement = 'split';
    pane = await splitPane({ paneId, direction, cwd: dir, ratio, env, focus });
    created.paneId = pane.paneId;
  } else if (workspaceId) {
    placement = 'tab';
    const res = await createTab({
      workspaceId,
      cwd: dir,
      label: paneLabel,
      env,
      focus,
    });
    pane = res.pane;
    created.tabId = res.tab?.tabId || pane.tabId;
    created.paneId = pane.paneId;
  } else {
    placement = 'workspace';
    const res = await createWorkspace({ cwd: dir, label: paneLabel, env, focus });
    pane = res.pane;
    created.workspaceId = res.workspace?.workspaceId || pane.workspaceId;
    created.tabId = res.tab?.tabId || pane.tabId;
    created.paneId = pane.paneId;
  }

  // --- Step 2: start the agent in that pane, rolling back the layout on error.
  const args = [
    'agent',
    'start',
    agentName,
    '--kind',
    kind,
    '--pane',
    pane.paneId,
    '--timeout',
    String(startupTimeout),
  ];
  if (Array.isArray(agentArgs) && agentArgs.length) {
    args.push('--', ...agentArgs.map((a) => String(a)));
  }

  let data;
  try {
    // `agent start` blocks until the agent is interactive; give exec headroom
    // beyond herdr's own startup timeout so we surface herdr's error, not ours.
    //
    // `workspace create` returns once the pane exists, which is a moment before
    // its shell is ready to be handed to an agent. Starting straight after
    // therefore loses a race now and then — herdr answers `agent_pane_busy` for
    // a pane it has only just made. Wait it out rather than tearing down a
    // perfectly good workspace.
    data = await retryWhilePaneBusy(() =>
      runHerdrJson(args, { timeoutMs: startupTimeout + 15000 }),
    );
  } catch (err) {
    await rollback(created);
    throw err;
  }

  const a = data?.result?.agent;
  if (!a) {
    await rollback(created);
    throw new Error('herdr agent start returned no agent');
  }

  return {
    agent: normalizeAgent(a),
    name: agentName,
    paneId: a.pane_id,
    tabId: a.tab_id,
    workspaceId: a.workspace_id,
    placement,
    argv: data?.result?.argv || [],
    created,
  };
}

// Best-effort teardown of layout newAgent created; never masks the real error.
async function rollback(created) {
  try {
    if (created.workspaceId) await closeWorkspace(created.workspaceId);
    else if (created.tabId) await closeTab(created.tabId);
    else if (created.paneId) await closePane(created.paneId);
  } catch {
    /* ignore — the caller is already handling a failure */
  }
}

// ---- Teardown --------------------------------------------------------------

async function closePane(paneId) {
  const id = requireString(paneId, 'paneId');
  await runHerdrJson(['pane', 'close', id]);
  return true;
}

async function closeTab(tabId) {
  const id = requireString(tabId, 'tabId');
  await runHerdrJson(['tab', 'close', id]);
  return true;
}

async function closeWorkspace(workspaceId) {
  const id = requireString(workspaceId, 'workspaceId');
  await runHerdrJson(['workspace', 'close', id]);
  return true;
}

// ---- Focus -----------------------------------------------------------------

// Focusing also marks an agent's tab "seen", which collapses `done` back to
// `idle` — that is herdr's behaviour, not a bug here.
async function focusAgent(target) {
  const t = requireString(target, 'target');
  const data = await runHerdrJson(['agent', 'focus', t]);
  const a = data?.result?.agent;
  if (!a) throw new Error(`No agent found for target "${target}"`);
  return normalizeAgent(a);
}

async function focusWorkspace(workspaceId) {
  const id = requireString(workspaceId, 'workspaceId');
  const data = await runHerdrJson(['workspace', 'focus', id]);
  return normalizeWorkspace(data?.result?.workspace);
}

async function focusTab(tabId) {
  const id = requireString(tabId, 'tabId');
  const data = await runHerdrJson(['tab', 'focus', id]);
  return normalizeTab(data?.result?.tab);
}

// ---- Agent introspection ---------------------------------------------------

// Why herdr classified an agent the way it did. Read-only: does NOT mark the
// agent as seen. Raw `evaluated_rules` evidence blobs are dropped; only the
// matched rule keeps a short preview, which is what is useful in chat.
async function explainAgent(target) {
  const t = requireString(target, 'target');
  // `agent explain` returns a bare object, not the {id, result} envelope.
  const d = await runHerdrJson(['agent', 'explain', t, '--format', 'json']);
  const rules = Array.isArray(d.evaluated_rules) ? d.evaluated_rules : [];
  const matched = rules.find((r) => r.matched) || null;
  // `matched_rule` is the winning rule but carries no `matched` flag of its own.
  const winner = d.matched_rule ? { ...d.matched_rule, matched: true } : matched;
  return {
    agent: d.agent || null,
    state: d.state || 'unknown',
    matchedRule: normalizeRule(winner),
    evidence: matched?.evidence?.region_preview || null,
    manifestSource: d.manifest_source || null,
    manifestVersion: d.manifest_version || null,
    visibleIdle: !!d.visible_idle,
    visibleWorking: !!d.visible_working,
    visibleBlocker: !!d.visible_blocker,
    screenDetectionSkipped: !!d.screen_detection_skipped,
    fallbackReason: d.fallback_reason || null,
    warning: d.warning || null,
    rules: rules.map(normalizeRule),
  };
}

async function renameAgent(target, name) {
  const t = requireString(target, 'target');
  const n = String(name == null ? '' : name).trim();
  if (!AGENT_NAME_RE.test(n)) {
    throw new Error(`Invalid agent name "${name}": must match [a-z][a-z0-9_-]{0,31}`);
  }
  const data = await runHerdrJson(['agent', 'rename', t, n]);
  return normalizeAgent(data?.result?.agent);
}

// Block until the agent settles. With no `until`, herdr waits for the first
// settled idle/done/blocked state.
async function waitAgent(target, { until, timeoutMs = 120000 } = {}) {
  const t = requireString(target, 'target');
  const args = ['agent', 'wait', t];
  const states = until ? (Array.isArray(until) ? until : [until]) : [];
  for (const s of states) {
    args.push('--until', requireOneOf(s, ['idle', 'working', 'blocked', 'done', 'unknown'], 'until'));
  }
  const ms = Math.max(1000, Number(timeoutMs) || 120000);
  args.push('--timeout', String(ms));
  const data = await runHerdrJson(args, { timeoutMs: ms + 15000 });
  return normalizeAgent(data?.result?.agent);
}

// ---- Raw pane I/O ----------------------------------------------------------

// Atomically sends command text plus Enter to a (non-agent) pane.
async function runInPane(paneId, command) {
  const id = requireString(paneId, 'paneId');
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) throw new Error('command is required');
  await runHerdrJson(['pane', 'run', id, cmd]);
  return true;
}

// Sends text WITHOUT Enter.
async function sendTextToPane(paneId, text) {
  const id = requireString(paneId, 'paneId');
  await runHerdrJson(['pane', 'send-text', id, String(text == null ? '' : text)]);
  return true;
}

async function readPane(paneId, { lines = 40, source = 'recent-unwrapped' } = {}) {
  const id = requireString(paneId, 'paneId');
  const src = requireOneOf(
    source,
    ['visible', 'recent', 'recent-unwrapped'],
    'source',
  );
  const n = Math.max(1, Math.min(5000, Number(lines) || 40));
  return runHerdr([
    'pane', 'read', id,
    '--source', src,
    '--lines', String(n),
    '--format', 'text',
  ]);
}

// ---- Worktrees -------------------------------------------------------------

// Creates a new git worktree AND opens it as a herdr workspace, under
// ~/.herdr/worktrees/<repo>/<branch>.
// Heads up: when scoped with `cwd` and the source repo is not already open,
// herdr ALSO opens a workspace for the source checkout. Two workspaces can
// therefore appear from one call; `removeWorktree` only reclaims the new one.
async function createWorktree({
  workspaceId,
  cwd,
  branch,
  base,
  targetPath,
  label,
  focus = false,
} = {}) {
  const args = ['worktree', 'create'];
  if (workspaceId) args.push('--workspace', requireString(workspaceId, 'workspaceId'));
  else if (cwd) args.push('--cwd', requireAbsolutePath(cwd, 'cwd'));
  if (branch) args.push('--branch', requireString(branch, 'branch'));
  if (base) args.push('--base', requireString(base, 'base'));
  if (targetPath) args.push('--path', requireAbsolutePath(targetPath, 'targetPath'));
  if (label) args.push('--label', requireString(label, 'label'));
  args.push(...focusArgs(focus));

  const data = await runHerdrJson(args);
  return normalizeWorktreeResult(data?.result);
}

// Opens an EXISTING worktree (by path or branch) as a herdr workspace.
async function openWorktree({
  workspaceId,
  cwd,
  targetPath,
  branch,
  label,
  focus = false,
} = {}) {
  if (!targetPath && !branch) {
    throw new Error('openWorktree requires either targetPath or branch');
  }
  const args = ['worktree', 'open'];
  if (workspaceId) args.push('--workspace', requireString(workspaceId, 'workspaceId'));
  else if (cwd) args.push('--cwd', requireAbsolutePath(cwd, 'cwd'));
  if (targetPath) args.push('--path', requireAbsolutePath(targetPath, 'targetPath'));
  else args.push('--branch', requireString(branch, 'branch'));
  if (label) args.push('--label', requireString(label, 'label'));
  args.push(...focusArgs(focus));

  const data = await runHerdrJson(args);
  return normalizeWorktreeResult(data?.result);
}

// Removes the git worktree backing a workspace and closes that workspace.
async function removeWorktree(workspaceId, { force = false } = {}) {
  const id = requireString(workspaceId, 'workspaceId');
  const args = ['worktree', 'remove', '--workspace', id];
  if (force) args.push('--force');
  const data = await runHerdrJson(args);
  return normalizeWorktreeResult(data?.result);
}

// Covers all three worktree responses:
//   create/open -> {type, worktree, workspace (with nested worktree), tab, root_pane}
//   remove      -> {type, path, workspace_id, forced}
function normalizeWorktreeResult(r) {
  if (!r) return {};
  const repo = r.source || r.workspace?.worktree || null;
  const workspace = normalizeWorkspace(r.workspace);
  return {
    type: r.type || null,
    path: r.path || r.worktree?.path || null,
    branch: r.branch || r.worktree?.branch || null,
    workspaceId: r.workspace_id || workspace?.workspaceId || null,
    forced: r.forced ?? null,
    workspace,
    tab: normalizeTab(r.tab),
    pane: normalizePane(r.root_pane || r.pane),
    worktree: r.worktree ? normalizeWorktree(r.worktree, repo) : null,
  };
}

// ---- Notifications ---------------------------------------------------------

// herdr only exposes SENDING a desktop/UI notification — there is no list or
// history subcommand, so nothing to read back.
async function notify(title, { body, position, sound } = {}) {
  const t = requireString(title, 'title');
  const args = ['notification', 'show', t];
  if (body) args.push('--body', String(body));
  if (position) {
    args.push(
      '--position',
      requireOneOf(
        position,
        ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        'position',
      ),
    );
  }
  if (sound) {
    args.push('--sound', requireOneOf(sound, ['none', 'done', 'request'], 'sound'));
  }
  await runHerdrJson(args);
  return true;
}

// ---- Integrations ----------------------------------------------------------

// `herdr integration status` prints text lines, not JSON:
//   "claude: current (v7) (/home/ubuntu/.claude/hooks/herdr-agent-state.sh)"
async function listIntegrations() {
  const out = await runHerdr(['integration', 'status']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (!m) return { name: line, status: 'unknown', installed: false, path: null };
      const name = m[1].trim();
      const rest = m[2].trim();
      const pathMatch = rest.match(/\(([^()]*\/[^()]*)\)\s*$/);
      const version = rest.match(/\(v(\d+)\)/);
      const status = rest.split(' ')[0];
      return {
        name,
        status,
        installed: !/^not\b/i.test(rest),
        version: version ? Number(version[1]) : null,
        path: pathMatch ? pathMatch[1] : null,
      };
    });
}

module.exports = {
  // listings
  listWorkspaces,
  listSessions,
  listTabs,
  listWorktrees,
  listPanes,
  listIntegrations,
  getWorkspace,
  getTab,
  getPane,
  // creation
  newAgent,
  createWorkspace,
  createTab,
  splitPane,
  createWorktree,
  openWorktree,
  // teardown
  closePane,
  closeTab,
  closeWorkspace,
  removeWorktree,
  // focus
  focusAgent,
  focusWorkspace,
  focusTab,
  // agent introspection / control
  explainAgent,
  renameAgent,
  waitAgent,
  // raw pane I/O
  runInPane,
  sendTextToPane,
  readPane,
  // misc
  notify,
  AGENT_KINDS,
};
