// github.js — read-only GitHub surface via the `gh` CLI.
//
// gh is already installed and authenticated on this machine (account debpalash,
// scopes: repo, read:org, gist), so the bot shells out to it rather than
// managing its own token. As everywhere else, commands are invoked with an argv
// array — no shell string is ever built from user input.
//
// Note: the token has no `workflow` scope, so runs can be read but not
// dispatched or re-run.

const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const GH_BIN = process.env.GH_BIN || 'gh';
const TIMEOUT_MS = Number(process.env.GH_TIMEOUT_MS || 20000);

function gh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      GH_BIN,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd: cwd || undefined },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && stderr.trim()) || err.message;
          reject(new Error(msg.split('\n')[0]));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function ghJson(args, cwd) {
  const out = await gh(args, cwd);
  const t = out.trim();
  if (!t) return [];
  try {
    return JSON.parse(t);
  } catch {
    return [];
  }
}

// ---- repo resolution -------------------------------------------------------

// Map a working directory to its "owner/name" slug. Agents carry a cwd, so a
// workspace channel can be tied to whatever repo its agents are working in.
const repoCache = new Map();

async function repoForDir(dir) {
  if (!dir) return null;
  if (repoCache.has(dir)) return repoCache.get(dir);

  // Walk up to the git root so a subdirectory still resolves.
  let d = dir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }

  let slug = null;
  try {
    const info = await ghJson(['repo', 'view', '--json', 'nameWithOwner'], d);
    slug = info?.nameWithOwner || null;
  } catch {
    slug = null; // not a GitHub repo, or no remote
  }
  repoCache.set(dir, slug);
  return slug;
}

// ---- queries ---------------------------------------------------------------

async function listPRs(repo, { state = 'open', limit = 10 } = {}) {
  const rows = await ghJson([
    'pr', 'list', '-R', repo, '--state', state, '--limit', String(limit),
    '--json', 'number,title,state,author,isDraft,url,headRefName,reviewDecision,updatedAt,additions,deletions',
  ]);
  return (rows || []).map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: !!p.isDraft,
    author: p.author?.login || '?',
    url: p.url,
    branch: p.headRefName,
    review: p.reviewDecision || null,
    updatedAt: p.updatedAt,
    additions: p.additions,
    deletions: p.deletions,
  }));
}

async function listIssues(repo, { state = 'open', limit = 10 } = {}) {
  const rows = await ghJson([
    'issue', 'list', '-R', repo, '--state', state, '--limit', String(limit),
    '--json', 'number,title,state,author,url,labels,updatedAt',
  ]);
  return (rows || []).map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.author?.login || '?',
    url: i.url,
    labels: (i.labels || []).map((l) => l.name),
    updatedAt: i.updatedAt,
  }));
}

async function listRuns(repo, { limit = 10, branch } = {}) {
  const args = [
    'run', 'list', '-R', repo, '--limit', String(limit),
    '--json', 'databaseId,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url',
  ];
  if (branch) args.push('--branch', branch);
  const rows = await ghJson(args);
  return (rows || []).map((r) => ({
    id: r.databaseId,
    title: r.displayTitle,
    status: r.status, // queued | in_progress | completed
    conclusion: r.conclusion, // success | failure | cancelled | null
    workflow: r.workflowName,
    branch: r.headBranch,
    event: r.event,
    createdAt: r.createdAt,
    url: r.url,
  }));
}

// A compact health summary for one repo — what a channel header should show.
async function repoSummary(repo) {
  const [prs, runs] = await Promise.all([
    listPRs(repo, { state: 'open', limit: 30 }).catch(() => []),
    listRuns(repo, { limit: 10 }).catch(() => []),
  ]);
  const latest = runs[0] || null;
  const failing = runs.filter((r) => r.conclusion === 'failure').length;
  return {
    repo,
    openPRs: prs.length,
    drafts: prs.filter((p) => p.draft).length,
    latestRun: latest,
    recentFailures: failing,
  };
}

// ---- presentation ----------------------------------------------------------

const RUN_EMOJI = {
  success: '✅',
  failure: '❌',
  cancelled: '⚪',
  skipped: '⚪',
  timed_out: '⌛',
  in_progress: '🟡',
  queued: '⏳',
};

function runEmoji(run) {
  if (!run) return '⚪';
  if (run.status !== 'completed') return RUN_EMOJI[run.status] || '🟡';
  return RUN_EMOJI[run.conclusion] || '⚪';
}

// Bug reports quote URLs, and truncating one mid-string leaves Discord
// auto-linking a fragment that goes nowhere. Reduce any URL in a title to its
// host so the line stays readable and every link on screen is real.
function titleLine(title, max = 70) {
  const flat = String(title || '').replace(/https?:\/\/([^\s/]+)\S*/g, (_, host) => `\`${host}\``);
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max).trimEnd();
  // Don't leave a code span hanging open — Discord would swallow the rest.
  if ((cut.match(/`/g) || []).length % 2) cut += '`';
  return cut + '…';
}

function prLine(p) {
  const mark = p.draft ? '📝' : p.review === 'APPROVED' ? '✅' : '🔵';
  return `${mark} [#${p.number}](${p.url}) ${titleLine(p.title)} · _${p.author}_`;
}

function runLine(r) {
  return `${runEmoji(r)} [${r.workflow}](${r.url}) · \`${r.branch}\` · ${
    r.conclusion || r.status
  }`;
}

async function isAvailable() {
  try {
    await gh(['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  gh,
  ghJson,
  repoForDir,
  listPRs,
  listIssues,
  listRuns,
  repoSummary,
  prLine,
  titleLine,
  runLine,
  runEmoji,
  isAvailable,
};
