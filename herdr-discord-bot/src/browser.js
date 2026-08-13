// browser.js — drive a throwaway headless Chromium over CDP to test local apps.
//
// Deliberately does NOT touch the user's real browser profile: every run gets a
// fresh --user-data-dir under the system temp dir, and the browser is killed
// afterwards. Uses only `ws`, which discord.js already depends on, so there is
// no puppeteer/playwright requirement.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');

const CANDIDATES = [
  process.env.BROWSER_BIN,
  'brave-browser-nightly',
  'brave-browser',
  'chromium',
  'chromium-browser',
  'google-chrome',
].filter(Boolean);

function which(bin) {
  return new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function findBrowser() {
  for (const c of CANDIDATES) {
    if (c.startsWith('/') && fs.existsSync(c)) return c;
    const p = await which(c);
    if (p) return p;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForEndpoint(port, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('browser did not expose a debugging endpoint in time');
}

// Minimal CDP client: one websocket, request/response by id, plus event taps.
class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, { perMessageDeflate: false });
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

// Launch headless, run `fn(cdp)`, then always tear the browser down.
async function withBrowser(fn, { headless = true } = {}) {
  const bin = await findBrowser();
  if (!bin) throw new Error('no Chromium-family browser found on this machine');

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrbot-browser-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--window-size=1280,900',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');

  const proc = spawn(bin, args, { stdio: 'ignore', detached: false });
  let cdp = null;
  try {
    await waitForEndpoint(port);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let page = targets.find((t) => t.type === 'page');
    if (!page) {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
      });
      page = await created.json();
    }
    cdp = await new CDP(page.webSocketDebuggerUrl).connect();
    return await fn(cdp);
  } finally {
    cdp?.close();
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
      fs.rm(profile, { recursive: true, force: true }, () => {});
    }, 1500);
  }
}

// Screenshot a URL, collecting console errors and failed requests along the way
// — a blank page with a stack trace is far more useful than a blank page.
async function capture(url, { fullPage = true, waitMs = 1200 } = {}) {
  return withBrowser(async (cdp) => {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => {});
    await cdp.send('Network.enable').catch(() => {});

    const started = Date.now();
    await cdp.send('Page.navigate', { url });

    // Wait for load, but never hang forever on a slow or broken page.
    await new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, 12000);
      const poll = setInterval(() => {
        if (cdp.events.some((e) => e.method === 'Page.loadEventFired')) {
          clearInterval(poll);
          clearTimeout(timer);
          done();
        }
      }, 100);
    });
    await new Promise((r) => setTimeout(r, waitMs)); // let the app paint

    const title = await cdp
      .send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
      .then((r) => r.result?.value)
      .catch(() => null);

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    });

    const consoleErrors = cdp.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
      .map((e) => e.params.entry.text)
      .slice(0, 10);
    const failed = cdp.events
      .filter((e) => e.method === 'Network.loadingFailed')
      .map((e) => e.params?.errorText)
      .filter(Boolean)
      .slice(0, 10);

    return {
      url,
      title,
      png: Buffer.from(shot.data, 'base64'),
      ms: Date.now() - started,
      consoleErrors,
      failedRequests: failed,
    };
  });
}

// --- driving a page, not just photographing it ------------------------------
//
// A step is one verb and its argument, written the way you would say it:
//
//   goto <url>            navigate mid-flow
//   click <text|css>      visible text first, CSS selector as a fallback
//   type <css> <text>     focus that field and type (selector = first token)
//   wait <ms|text>        a number sleeps; anything else waits for that text
//   expect <text>         fail the step unless the page shows it
//
// Steps run in order and stop at the first failure, because every later step
// was written assuming the earlier ones worked.

const STEP_TIMEOUT_MS = 10000;

function parseSteps(text) {
  return String(text || '')
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const m = raw.match(/^(\w+)\s*(.*)$/s);
      return { raw, verb: (m?.[1] || '').toLowerCase(), arg: (m?.[2] || '').trim() };
    });
}

// Serialised into the page: find by visible text, then by CSS. Text wins
// because that is how a person describes a button they can see.
const FIND_FN = `function(needle){
  var all = Array.from(document.querySelectorAll('button,a,[role="button"],input,textarea,select,label,summary'));
  var hit = all.find(function(el){
    var t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    return t && t.toLowerCase().indexOf(needle.toLowerCase()) >= 0;
  });
  if(!hit){ try { hit = document.querySelector(needle); } catch(e) { hit = null; } }
  if(!hit) return null;
  hit.scrollIntoView({block:'center'});
  var r = hit.getBoundingClientRect();
  return {x: r.left + r.width/2, y: r.top + r.height/2, tag: hit.tagName.toLowerCase(),
          label: (hit.innerText || hit.value || '').trim().slice(0,40)};
}`;

async function pageText(cdp) {
  const r = await cdp
    .send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    })
    .catch(() => null);
  return r?.result?.value || '';
}

async function runStep(cdp, { verb, arg }) {
  if (verb === 'goto') {
    await cdp.send('Page.navigate', { url: arg });
    await new Promise((r) => setTimeout(r, 1500));
    return `at ${arg}`;
  }

  if (verb === 'wait') {
    const ms = Number(arg);
    if (Number.isFinite(ms) && ms > 0) {
      await new Promise((r) => setTimeout(r, Math.min(ms, STEP_TIMEOUT_MS)));
      return `waited ${ms}ms`;
    }
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await pageText(cdp)).toLowerCase().includes(arg.toLowerCase())) return `saw "${arg}"`;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`"${arg}" never appeared`);
  }

  if (verb === 'expect') {
    const text = await pageText(cdp);
    if (!text.toLowerCase().includes(arg.toLowerCase())) {
      throw new Error(`page does not show "${arg}"`);
    }
    return `found "${arg}"`;
  }

  if (verb === 'click') {
    const found = await cdp
      .send('Runtime.evaluate', {
        expression: `(${FIND_FN})(${JSON.stringify(arg)})`,
        returnByValue: true,
      })
      .then((r) => r.result?.value);
    if (!found) throw new Error(`nothing matching "${arg}"`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: found.x,
        y: found.y,
        button: 'left',
        clickCount: 1,
      });
    }
    await new Promise((r) => setTimeout(r, 600));
    return `clicked ${found.tag}${found.label ? ` "${found.label}"` : ''}`;
  }

  if (verb === 'type') {
    const [selector, ...rest] = arg.split(/\s+/);
    const value = rest.join(' ');
    const ok = await cdp
      .send('Runtime.evaluate', {
        expression: `(function(){
          var el = null;
          try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}
          if(!el) return false;
          el.scrollIntoView({block:'center'});
          el.focus();
          return true;
        })()`,
        returnByValue: true,
      })
      .then((r) => r.result?.value);
    if (!ok) throw new Error(`no field matching "${selector}"`);
    // insertText goes through the same path as a real keystroke, so framework
    // inputs see the change; setting .value directly would not fire anything.
    await cdp.send('Input.insertText', { text: value });
    await new Promise((r) => setTimeout(r, 300));
    return `typed into ${selector}`;
  }

  throw new Error(`unknown step "${verb}"`);
}

// Walk a URL through a list of steps and report what each one did.
async function drive(url, stepText, { waitMs = 1500 } = {}) {
  const steps = parseSteps(stepText);
  if (!steps.length) throw new Error('no steps to run');

  return withBrowser(async (cdp) => {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => {});
    await cdp.send('Network.enable').catch(() => {});

    const started = Date.now();
    await cdp.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, waitMs));

    const results = [];
    for (const step of steps) {
      const at = Date.now();
      try {
        const detail = await runStep(cdp, step);
        results.push({ raw: step.raw, ok: true, detail, ms: Date.now() - at });
      } catch (e) {
        results.push({ raw: step.raw, ok: false, detail: e.message, ms: Date.now() - at });
        break; // later steps assumed this one worked
      }
    }

    const title = await cdp
      .send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
      .then((r) => r.result?.value)
      .catch(() => null);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });

    return {
      url,
      title,
      ok: results.every((r) => r.ok),
      steps: results,
      png: Buffer.from(shot.data, 'base64'),
      ms: Date.now() - started,
      consoleErrors: cdp.events
        .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
        .map((e) => e.params.entry.text)
        .slice(0, 10),
      failedRequests: cdp.events
        .filter((e) => e.method === 'Network.loadingFailed')
        .map((e) => e.params?.errorText)
        .filter(Boolean)
        .slice(0, 10),
    };
  });
}

// Which local ports are actually serving HTTP right now.
function listeningPorts() {
  return new Promise((resolve) => {
    execFile('ss', ['-ltnp'], (err, stdout) => {
      if (err) return resolve([]);
      const ports = new Set();
      for (const line of stdout.split('\n').slice(1)) {
        const m = line.match(/127\.0\.0\.1:(\d+)|0\.0\.0\.0:(\d+)|\*:(\d+)/);
        if (m) {
          const p = Number(m[1] || m[2] || m[3]);
          if (p && p > 1024) ports.add(p);
        }
      }
      resolve([...ports].sort((a, b) => a - b));
    });
  });
}

module.exports = { capture, drive, parseSteps, withBrowser, findBrowser, listeningPorts, CDP };
