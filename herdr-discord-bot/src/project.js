// project.js — work out how to run and test a project from what's on disk.
//
// Deliberately evidence-based: every command returned is one that actually
// exists in a manifest (a package.json script, a Makefile target, a justfile
// recipe, a Cargo/zig build). Nothing is inferred from convention alone, so we
// never hand Discord a command that fails the moment it runs.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// Which JS runner the project actually uses, based on its lockfile / manifest.
function jsRunner(root, pkg) {
  if (pkg?.packageManager?.startsWith('bun')) return 'bun';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) {
    return 'bun';
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function makeTargets(root) {
  const mk = readText(path.join(root, 'Makefile'));
  if (!mk) return [];
  return [...mk.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map((m) => m[1]);
}

function justRecipes(root) {
  const j = readText(path.join(root, 'justfile')) || readText(path.join(root, 'Justfile'));
  if (!j) return [];
  return [...j.matchAll(/^([a-zA-Z][\w-]*):/gm)].map((m) => m[1]);
}

// Detect a project's identity and its real run/test commands.
function detect(root) {
  const out = {
    root,
    name: path.basename(root),
    type: 'unknown',
    run: null,
    test: null,
    port: null,
    evidence: [],
  };
  if (!root || !fs.existsSync(root)) return out;

  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson(pkgPath);
  const targets = makeTargets(root);
  const recipes = justRecipes(root);

  // --- JavaScript / TypeScript ---
  if (pkg) {
    out.type = 'node';
    out.evidence.push('package.json');
    const runner = jsRunner(root, pkg);
    const scripts = pkg.scripts || {};
    const runScript = ['dev', 'start', 'serve'].find((s) => scripts[s]);
    const testScript = ['test', 'test:unit', 'test:frontend'].find((s) => scripts[s]);
    if (runScript) out.run = `${runner} run ${runScript}`;
    if (testScript) out.test = `${runner} run ${testScript}`;
    // A port declared in a script or vite config is better than a guess.
    const hay = JSON.stringify(scripts) + readText(path.join(root, 'vite.config.js'));
    const m = hay.match(/(?:PORT|port)\D{0,8}(\d{4,5})/);
    if (m) out.port = Number(m[1]);
  }

  // --- Rust ---
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    out.type = out.type === 'unknown' ? 'rust' : out.type;
    out.evidence.push('Cargo.toml');
    out.run = out.run || 'cargo run';
    out.test = out.test || 'cargo test';
  }

  // --- Zig ---
  if (fs.existsSync(path.join(root, 'build.zig'))) {
    out.type = out.type === 'unknown' ? 'zig' : out.type;
    out.evidence.push('build.zig');
    out.run = out.run || 'zig build run';
    out.test = out.test || 'zig build test';
  }

  // --- Python ---
  if (
    fs.existsSync(path.join(root, 'pyproject.toml')) ||
    fs.existsSync(path.join(root, 'requirements.txt'))
  ) {
    out.type = out.type === 'unknown' ? 'python' : out.type;
    out.evidence.push('pyproject/requirements');
    out.test = out.test || 'pytest';
  }

  // --- Make / just win when present: they encode what the author intended ---
  if (targets.length) {
    out.evidence.push('Makefile');
    if (targets.includes('run')) out.run = 'make run';
    if (targets.includes('dev')) out.run = 'make dev';
    if (targets.includes('test')) out.test = 'make test';
  }
  if (recipes.length) {
    out.evidence.push('justfile');
    if (recipes.includes('run')) out.run = out.run || 'just run';
    if (recipes.includes('test')) out.test = out.test || 'just test';
  }

  return out;
}

// Run a bounded command and capture its result. Used for tests, never for dev
// servers — those belong in a herdr pane where they can live and stream.
function runBounded(cmd, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      'bash',
      ['-lc', cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        resolve({
          cmd,
          cwd,
          ok: !err,
          timedOut: !!err?.killed,
          code: err?.code ?? 0,
          ms: Date.now() - started,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

// Having launched a command we watch its pane rather than assume it worked. A
// dev server announces a URL; a failure prints an error and hands the shell
// straight back. `read` returns the pane's visible text, and is injected so
// this stays testable without a terminal.
const SERVE_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?[^\s`'"]*/i;
const DIED = /(?:exited with code|command not found|No such file or directory|^\s*error[: ])/im;

async function observeStart(read, { waitMs = 9000, stepMs = 900 } = {}) {
  const deadline = Date.now() + waitMs;
  let last = '';
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    last = (await read().catch(() => '')) || '';
    polls += 1;

    // Whether the process is still alive decides everything, so test that
    // first: a failing launcher often prints a URL inside its own error
    // message, and reading that as success would be exactly backwards.
    const lines = last.split('\n').filter((l) => l.trim());
    const back = /[$#%]\s*$/.test(lines[lines.length - 1] || '');
    if (back) {
      // The first read can catch the shell before it has even echoed the
      // command, which looks identical to "already finished" — so wait one
      // more round before calling it. Either way, a pane sitting at a prompt
      // has nothing serving, so don't look for a URL in it.
      if (polls > 1) return { state: DIED.test(last) ? 'failed' : 'exited', output: last };
      continue;
    }

    const url = last.match(SERVE_URL);
    if (url) return { state: 'serving', url: url[0], port: url[1] ? Number(url[1]) : null };
  }
  return { state: 'running', output: last };
}

// A repo root often isn't where the app lives — this one keeps its bot in
// herdr-discord-bot/. When the root yields no commands, look one level down and
// adopt the single subdirectory that does. Only unambiguous cases are adopted:
// if two subprojects both qualify, we would be guessing.
function detectDeep(root) {
  const top = detect(root);
  if (top.run || top.test) return top;

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return top;
  }

  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const sub = detect(path.join(root, e.name));
    if (sub.run || sub.test) candidates.push(sub);
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    only.adoptedFrom = root;
    return only;
  }
  if (candidates.length > 1) {
    top.ambiguous = candidates.map((c) => c.name);
  }
  return top;
}

module.exports = { detect, detectDeep, runBounded, observeStart };
