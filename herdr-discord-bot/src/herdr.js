// Thin, safe wrapper around the `herdr` CLI.
// Everything is invoked via execFile with an argv array — no shell string is
// ever constructed from user input, so Discord text cannot inject commands.

const { execFile } = require('node:child_process');

const HERDR_BIN = process.env.HERDR_BIN || 'herdr';
const EXEC_TIMEOUT_MS = Number(process.env.HERDR_TIMEOUT_MS || 15000);

function runHerdr(args) {
  return new Promise((resolve, reject) => {
    execFile(
      HERDR_BIN,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && stderr.trim()) || err.message;
          reject(new Error(`herdr ${args.join(' ')} failed: ${msg}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function runHerdrJson(args) {
  const out = await runHerdr(args);
  const trimmed = out.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Some subcommands print plain text; return it raw for callers that want it.
    return { _raw: out };
  }
}

// ---- High-level operations -------------------------------------------------

async function listAgents() {
  const data = await runHerdrJson(['agent', 'list']);
  const agents = data?.result?.agents || [];
  return agents.map(normalizeAgent);
}

async function getAgent(target) {
  const data = await runHerdrJson(['agent', 'get', target]);
  const a = data?.result?.agent;
  if (!a) throw new Error(`No agent found for target "${target}"`);
  return normalizeAgent(a);
}

async function readAgent(target, lines = 40) {
  const out = await runHerdr([
    'agent',
    'read',
    target,
    '--lines',
    String(lines),
    '--format',
    'text',
  ]);
  return out;
}

// Send raw key presses (e.g. 'esc', 'enter', 'y') to an agent. Used to answer
// approval prompts and to interrupt a running turn.
async function sendKeys(target, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  await runHerdr(['agent', 'send-keys', target, ...list.map(String)]);
  return true;
}

async function promptAgent(target, text) {
  // No --wait here: keep the Discord interaction fast; caller can poll status.
  await runHerdr(['agent', 'prompt', target, text]);
  return true;
}

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
  };
}

// Resolve a user-supplied target to a concrete pane_id.
// Accepts: an exact pane_id (e.g. "wR:p2"), or a case-insensitive substring of
// the agent title or cwd. Throws a helpful error on no/ambiguous match.
async function resolveTarget(input) {
  const agents = await listAgents();
  const q = String(input).trim();

  const exact = agents.find((a) => a.paneId === q);
  if (exact) return exact;

  const lc = q.toLowerCase();
  const matches = agents.filter(
    (a) =>
      a.paneId.toLowerCase() === lc ||
      a.title.toLowerCase().includes(lc) ||
      a.cwd.toLowerCase().includes(lc),
  );

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No agent matches "${input}". Use \`/agents\` to see valid pane IDs.`,
    );
  }
  const list = matches
    .slice(0, 10)
    .map((a) => `\`${a.paneId}\` — ${a.title || a.cwd}`)
    .join('\n');
  throw new Error(
    `"${input}" is ambiguous (${matches.length} matches):\n${list}\nUse an exact pane ID.`,
  );
}

module.exports = {
  listAgents,
  getAgent,
  readAgent,
  promptAgent,
  sendKeys,
  resolveTarget,
};
