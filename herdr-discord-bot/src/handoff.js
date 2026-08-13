// handoff.js — move work from one agent (and provider) to another.
//
// A note on "zero-token" handoff: it isn't achievable. Every provider ingests
// history in its own format, and none of them will accept another's cached
// state, so the receiving agent necessarily re-reads whatever context it is
// given. What IS achievable is making that context small: instead of replaying
// a 50k-token transcript, hand over a structured brief — goal, state, decisions,
// files, next step — which costs one to two thousand tokens and carries the
// facts a fresh agent actually needs.
//
// The lossy part is judgement, not facts: the brief says what was decided, not
// every alternative that was considered and discarded.

const herdr = require('./herdr');
const { extractAnswer } = require('./answer');
const { execFile } = require('node:child_process');

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 8000 }, (err, stdout) =>
      resolve(err ? '' : String(stdout || '').trim()),
    );
  });
}

// Build a provider-neutral brief from what can be observed about an agent:
// its own last message, plus the actual state of its working tree.
async function buildBrief(paneId, { note } = {}) {
  const agent = await herdr.getAgent(paneId);
  const terminal = await herdr.readAgent(paneId, 160).catch(() => '');
  const { answer } = extractAnswer(terminal, { agent: agent.agent });

  const cwd = agent.cwd;
  const [branch, status, recent, diffstat] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['status', '--porcelain'], cwd),
    git(['log', '--oneline', '-8'], cwd),
    git(['diff', '--stat', 'HEAD'], cwd),
  ]);

  const changed = status
    .split('\n')
    .filter(Boolean)
    .slice(0, 25)
    .map((l) => `  ${l}`)
    .join('\n');

  const sections = [
    `# Handoff brief`,
    ``,
    `You are taking over work in progress from another agent (${agent.agent}).`,
    `Continue the task; do not restart it.`,
    ``,
    `## Task`,
    agent.title || '(no title recorded)',
    ``,
    `## Working directory`,
    `${cwd}${branch ? ` (branch ${branch})` : ''}`,
  ];

  if (recent) sections.push(``, `## Recent commits`, recent);
  if (changed) sections.push(``, `## Uncommitted changes`, changed);
  else sections.push(``, `## Uncommitted changes`, '  (working tree clean)');
  if (diffstat) sections.push(``, `## Diff against HEAD`, diffstat.split('\n').slice(-12).join('\n'));

  if (answer) {
    sections.push(
      ``,
      `## Where the previous agent left off (its own words)`,
      answer.split('\n').slice(0, 40).join('\n'),
    );
  }
  if (note) sections.push(``, `## Operator note`, note);

  sections.push(
    ``,
    `## What to do`,
    `Re-read the files named above before changing them — the brief is a summary,`,
    `not a substitute for the code. Then continue the task.`,
  );

  const text = sections.join('\n');
  return {
    text,
    agent,
    // Rough token estimate so the cost of the handoff is visible, not implied.
    approxTokens: Math.ceil(text.length / 4),
  };
}

module.exports = { buildBrief };
