'use strict';

// answer.js — pull the human-facing prose reply out of a coding agent's terminal.
//
// A herdr pane holds a full-screen TUI, not a log: every frame repaints a
// spinner, a token counter, an input box and a status bar, and the model's
// actual sentences are buried between tool invocations, unified diffs and
// shell output. Posting that raw into Discord is unreadable. This module finds
// the most recent assistant *message* and returns it as markdown-ready prose.
//
// The approach is three passes:
//   1. normalise   — ANSI/control stripping, tab expansion, CRLF, footer trim
//   2. segment     — split the transcript into blocks (assistant / tool / user
//                    / chrome) using the marker glyph each agent prints in the
//                    left gutter, then classify each block
//   3. render      — un-wrap the terminal's hard wrapping and drop in-block
//                    noise, yielding markdown
//
// Per-agent differences live in the PROFILES table below; unknown agents get a
// generic profile that tries every known layout and keeps whichever segments
// best, falling back to a purely heuristic sweep.
//
// Nothing here throws: every exported function is wrapped and degrades to an
// empty result on garbage input.

// ---------------------------------------------------------------------------
// low-level text hygiene
// ---------------------------------------------------------------------------

// CSI/SGR and friends. Kept deliberately broad — terminal captures occasionally
// carry partial sequences.
const ANSI_CSI =
  /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;
// OSC ... BEL|ST (window titles, hyperlinks).
const ANSI_OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
// Leftover control bytes, minus \t \n \r which are handled structurally.
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Zero-width / bidi junk some TUIs emit around glyphs.
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\ufeff]/g;

function stripAnsi(s) {
  if (typeof s !== 'string' || !s) return '';
  return s.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(CTRL, '').replace(INVISIBLE, '');
}

// Terminal cells are one column wide for our purposes; the only thing that
// really matters is that tabs don't skew indent detection.
function expandTabs(s) {
  return s.replace(/\t/g, '    ');
}

function toLines(text) {
  if (typeof text !== 'string' || !text) return [];
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => expandTabs(l).replace(/[  ]+$/, ''));
}

function indentOf(line) {
  const m = /^[  ]*/.exec(line);
  return m ? m[0].length : 0;
}

// ---------------------------------------------------------------------------
// chrome — the furniture every frame repaints
// ---------------------------------------------------------------------------

// Box drawing (U+2500–U+257F), block elements (U+2580–U+259F) and ASCII rules.
const RULE_ONLY = /^[\s─-╿▀-▟_=~—–-]+$/;
// An input box whose prompt glyph stands alone.
const EMPTY_PROMPT = /^[❯>»›◇▸]\s*$/;
// Spinner / "Worked for" / thinking-verb lines. These glyphs are never used as
// a content bullet by any of the agents we support.
const STATUS_GLYPH =
  /^[✻✳✽✢✶✷✸✹✺◐◑◒◓◔◕⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧⣾⣽⣻⢿⡿⣟⣯⣷]\s/;
// The recap widget claude rotates under a finished turn.
const RECAP = /^※\s|\(disable recaps in \/config\)/;
// Status bars / hint bars, both agents.
const STATUS_BAR =
  /(esc to interrupt|shift\+tab to cycle|bypass permissions on|auto mode on|accept edits on|plan mode on|← for agents|ctrl\+t to (?:hide|view)|ctrl\+p commands|ctrl\+o to (?:expand|see)|to view transcript|\/ps to view|\/stop to close|↓ to manage|↓ to expand|newline$)/i;
// "(1m 50s · ↓ 6.0k tokens)" style counters wherever they appear.
const TOKEN_COUNTER = /\(\s*\d+(?:\.\d+)?\s*[hms].*?(?:tokens?|esc)\b/i;
// codex's own footer + exec bookkeeping.
const CODEX_EXEC_STATUS = /^(?:status|file changes|token usage|context left):\s/i;
const CODEX_APPROVAL = /^✔\s+You approved\b/;
const CODEX_WORKED = /^─\s+Worked for\b/;
const CODEX_MODEL_BAR = /^[\w.\-]+\s.*·\s*~?\/[^\s]*/;
// "… +52 lines (ctrl + t to view transcript)"
const TRUNCATION = /^…\s*\+\d+\s+lines?\b/;
// Welcome / login boxes.
const BOX_EDGE = /^[╭╰╮╯┌└┐┘]/;
const BOX_ROW = /^│.*[│╮╯]\s*$/;
// Rotating tips, claude.
const TIP = /^(?:⎿\s+)?Tip:\s/i;

/**
 * True when a line is pure TUI furniture — something that repaints every frame
 * and carries no transcript content. Superset of the original Sync.isChrome.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isChrome(line) {
  if (typeof line !== 'string') return true;
  const s = line.trim();
  if (!s) return true;
  if (RULE_ONLY.test(s)) return true; // rules / box drawing / block glyphs
  if (EMPTY_PROMPT.test(s)) return true; // bare input prompt
  if (BOX_EDGE.test(s) || BOX_ROW.test(s)) return true; // welcome box
  if (STATUS_BAR.test(s)) return true; // status / hint bar
  if (STATUS_GLYPH.test(s)) return true; // spinner, "Worked for 9m 54s"
  if (RECAP.test(s)) return true; // recap widget
  if (TOKEN_COUNTER.test(s)) return true; // token/elapsed counter
  if (TIP.test(s)) return true; // rotating tips
  if (TRUNCATION.test(s)) return true; // "… +52 lines"
  if (CODEX_EXEC_STATUS.test(s)) return true; // "status: Completed · exit 0"
  if (CODEX_APPROVAL.test(s)) return true; // "✔ You approved codex to run …"
  if (CODEX_WORKED.test(s)) return true; // "─ Worked for 11m 11s ─────"
  if (/^■\s+Conversation interrupted/.test(s)) return true;
  if (/^to report the issue\.$/.test(s)) return true; // wrapped tail of the above
  if (/^↳\s/.test(s)) return true; // "↳ Interacted with background terminal"
  if (/^\+\s*Thought:\s/.test(s)) return true; // opencode thinking timer
  if (/^▣\s/.test(s)) return true; // opencode turn footer "▣ Build · model · 12.7s"
  return false;
}

/**
 * Drop every chrome line. Order-preserving, allocation-light, never throws.
 *
 * @param {string[]|string} lines
 * @returns {string[]}
 */
function stripChrome(lines) {
  try {
    const arr = Array.isArray(lines) ? lines : toLines(lines);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      if (typeof l !== 'string') continue;
      if (!isChrome(l)) out.push(l);
    }
    return out;
  } catch {
    return [];
  }
}

// The status bar is the last line of the live frame; anything at or after it
// (background-task panel, model picker hints) is furniture. Trim it so those
// rows can never be mistaken for the newest assistant text.
function trimFooter(lines) {
  let cut = -1;
  const from = Math.max(0, lines.length - 25);
  for (let i = lines.length - 1; i >= from; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    if (STATUS_BAR.test(s) || CODEX_MODEL_BAR.test(s)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { lines, footerFound: false };
  // Also swallow the input box that sits directly above the status bar.
  let end = cut;
  while (end > 0) {
    const s = lines[end - 1].trim();
    if (!s || RULE_ONLY.test(s) || EMPTY_PROMPT.test(s)) {
      end--;
      continue;
    }
    break;
  }
  return { lines: lines.slice(0, end), footerFound: true };
}

// ---------------------------------------------------------------------------
// per-agent profiles
// ---------------------------------------------------------------------------

// A collapsed tool receipt claude prints between messages:
//   "Ran 1 shell command"
//   "Searched for 2 patterns, read 2 files, ran 6 shell commands"
//   "Made 1 scratchpad edit +70, listed 2 directories, ran 7 shell commands"
const RECEIPT_VERB =
  '(?:ran|read|searched|listed|made|wrote|edited|created|deleted|fetched|explored|updated|viewed|launched|killed|added|removed|checked|globbed|grepped|browsed)';
const RECEIPT_CLAUSE = new RegExp(
  `^${RECEIPT_VERB}(?: for| to| up| out| through)? \\d+[\\w+.\\- ]*$`,
  'i'
);
function isToolReceipt(s) {
  if (!/\d/.test(s)) return false;
  if (!/^[A-Z]/.test(s)) return false;
  if (s.length > 160) return false;
  const parts = s.split(/,\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (!RECEIPT_CLAUSE.test(parts[i].trim())) return false;
  }
  return true;
}

// claude renders a tool invocation as "● Verb(argument)" or as a plain-English
// title whose result is nested under a "⎿" elbow.
const CLAUDE_CALL = /^[A-Z][A-Za-z0-9_]*\(/;
const CLAUDE_SYSTEM =
  /^(?:User declined|User rejected|Interrupted by user|API Error|Request interrupted|Compacted|Referenced file|No \(tell Claude|Backgrounded agent|Allowed by auto mode)/;
// A one-line gerund title with no sentence punctuation is a tool label whose
// result has not landed yet ("● Checking script wiring").
const CLAUDE_GERUND_TITLE = /^[A-Z][a-z]+ing\b[^.!?:]*$/;

// codex prints tool calls with the same bullet as prose, so the vocabulary
// matters. Each of these is a rendered tool card or a system notice.
const CODEX_TOOL_HEAD = new RegExp(
  [
    '^Ran\\b',
    '^Explored$',
    '^Explored\\b',
    '^Read (?:\\d+ files?|\\S+)$',
    '^Searched (?:the web|for)\\b',
    '^Listed\\b',
    '^Viewed\\b',
    '^Wrote \\S+$',
    '^Edited \\d+ files?\\b',
    '^Edited \\S+ \\(\\+\\d+',
    '^Applied patch\\b',
    '^Proposed\\b',
    '^Updated Plan$',
    '^Called \\S+\\(',
    '^Waited for\\b',
    '^Waiting for\\b',
    '^Working \\(',
    '^Thinking\\b',
    '^Model changed to\\b',
    '^Context (?:compacted|left)\\b',
    '^Token usage:',
    '^Interacted with background terminal\\b',
  ].join('|')
);

const PROFILES = {
  claude: {
    name: 'claude',
    // "● " in the left gutter. Allow a small indent: herdr re-wraps deep
    // scrollback and can shift the whole frame right by a column or two.
    head: /^([ ]{0,2})●\s(.*)$/,
    user: /^([ ]{0,2})❯(?:\s(.*))?$/,
    // A nested tool result. Its presence anywhere in a block proves the block
    // is a tool card, not a message.
    elbow: /^⎿/,
    turnEnd: /^[✻✳✽]\s|^※\s/,
    isToolHead(s) {
      return CLAUDE_CALL.test(s) || CLAUDE_SYSTEM.test(s);
    },
    isToolTitle(s, bodyLines) {
      return bodyLines.length === 0 && s.length <= 70 && CLAUDE_GERUND_TITLE.test(s);
    },
  },
  codex: {
    name: 'codex',
    head: /^([ ]{0,2})•\s(.*)$/,
    user: /^([ ]{0,2})[›»](?:\s(.*))?$/,
    // "│ " continuation and "└ " result gutters mark a tool card.
    elbow: /^[│└⋮├]/,
    turnEnd: /^─{5,}|^─\s+Worked for\b/,
    isToolHead(s) {
      return CODEX_TOOL_HEAD.test(s);
    },
    isToolTitle() {
      return false;
    },
  },
  opencode: {
    name: 'opencode',
    // opencode has no per-message bullet: the user turn sits inside a "┃"
    // rail and the assistant's prose is a plain indented run underneath.
    head: null,
    user: /^[ ]{0,4}┃/,
    elbow: /^[│└├⎿]/,
    turnEnd: /^[ ]*▣\s/,
    bodyIndent: 5,
    isToolHead(s) {
      return /^(?:▣|◆|◇|⊙|⏺)\s/.test(s) || /^\+\s*Thought:/.test(s);
    },
    isToolTitle() {
      return false;
    },
  },
};

const AGENT_ALIASES = {
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  cc: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  opencode: 'opencode',
  oc: 'opencode',
};

function resolveProfile(agent) {
  if (typeof agent !== 'string') return null;
  const key = AGENT_ALIASES[agent.trim().toLowerCase()];
  return key ? PROFILES[key] : null;
}

// ---------------------------------------------------------------------------
// segmentation
// ---------------------------------------------------------------------------

/**
 * Split normalised lines into blocks. A block starts at a gutter marker in
 * column 0-2 and runs until the next marker; indented and blank lines belong
 * to whatever block is open.
 *
 * @returns {{kind:'assistant'|'tool'|'user'|'chrome', head:string, body:string[], marked:boolean}[]}
 */
function segment(lines, profile) {
  const blocks = [];
  let cur = null;

  const push = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  const open = (kind, head, marked, indent) => {
    push();
    cur = { kind, head, body: [], marked, indent };
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();
    const ind = indentOf(raw);

    // Chrome never opens or extends a block, with one exception: a turn-end
    // marker closes the block that precedes it.
    if (isChrome(raw)) {
      if (s && cur && profile.turnEnd && profile.turnEnd.test(s)) {
        cur.turnEnded = true;
        push();
      } else if (s && !RULE_ONLY.test(s)) {
        // Real chrome (status bar, recap) also ends whatever came before.
        push();
      } else if (!s && cur) {
        cur.body.push('');
      }
      continue;
    }

    if (profile.user && profile.user.test(raw)) {
      const m = profile.user.exec(raw);
      open('user', (m && m[2]) || '', true, ind);
      continue;
    }

    if (profile.head) {
      const m = profile.head.exec(raw);
      if (m) {
        open('assistant', m[2] || '', true, m[1].length);
        continue;
      }
    }

    // A structurally indented line continues the open block.
    if (cur && (ind > cur.indent || (profile.head === null && ind >= (profile.bodyIndent || 2)))) {
      cur.body.push(raw);
      continue;
    }
    if (cur && ind >= 2 && ind > cur.indent - 1 && profile.head) {
      cur.body.push(raw);
      continue;
    }

    // Column-0 text with no marker. For markerless layouts (opencode) that
    // means chrome; elsewhere it is a wrapped continuation of a notice.
    if (profile.head === null && ind >= (profile.bodyIndent || 5)) {
      if (!cur || cur.kind !== 'assistant') open('assistant', raw.trim(), false, ind);
      else cur.body.push(raw);
      continue;
    }
    if (cur) {
      cur.body.push(raw);
      continue;
    }
    // Nothing open: this is the top of the capture window, mid-message.
    open('assistant', s, false, ind);
  }
  push();

  // Classify.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'assistant') continue;
    const bodyText = b.body.filter((l) => l.trim());
    const hasElbow = bodyText.some((l) => profile.elbow && profile.elbow.test(l.trim()));
    if (hasElbow || profile.isToolHead(b.head) || profile.isToolTitle(b.head, bodyText)) {
      b.kind = 'tool';
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const LIST_MARKER = /^(?:[-*+•▪◦·]\s|\d+[.)]\s|#{1,6}\s|>\s|\|.*\||```|⎮)/;
const QUOTE_RAIL = /^▎\s?/; // claude renders markdown blockquotes with "▎"

// Lines that are tool debris even inside an otherwise prose block.
function isBlockNoise(s, profile) {
  if (!s) return false;
  if (profile.elbow && profile.elbow.test(s)) return true;
  if (TRUNCATION.test(s)) return true;
  if (isToolReceipt(s)) return true;
  if (/^\$\s/.test(s)) return true; // echoed shell command
  if (/^⋮$/.test(s)) return true; // diff gap marker
  if (/^\d+\s+[+-]\s/.test(s)) return true; // numbered diff row
  if (/^[◼◻■□]\s/.test(s)) return true; // todo checkboxes
  return false;
}

/**
 * Undo the terminal's hard wrapping and emit markdown.
 *
 * The terminal wraps at a fixed width, so a line that reaches (near) that width
 * was almost certainly continued on the next line. Short lines ended on their
 * own. List/heading/quote markers always start a fresh line regardless.
 */
function renderBlock(block, profile, wrapWidth) {
  const raw = [block.head === undefined ? '' : block.head].concat(block.body);
  // The head arrives already stripped of its bullet, so give it the same
  // effective indent as the body for the de-wrap comparison.
  const headIndent = block.indent + 2;

  const kept = [];
  for (let i = 0; i < raw.length; i++) {
    const line = i === 0 ? ' '.repeat(headIndent) + raw[0] : raw[i];
    const s = line.trim();
    if (!s) {
      kept.push(null); // paragraph break
      continue;
    }
    if (isChrome(line) || isBlockNoise(s, profile)) continue;
    kept.push({ indent: indentOf(line), text: s });
  }
  while (kept.length && kept[0] === null) kept.shift();
  while (kept.length && kept[kept.length - 1] === null) kept.pop();
  if (!kept.length) return '';

  // Normalise to the block's own left margin so nested markdown survives.
  let base = Infinity;
  for (const k of kept) if (k && k.indent < base) base = k.indent;
  if (!isFinite(base)) base = 0;

  const threshold = Math.max(40, wrapWidth - 14);
  const out = [];
  let buf = null;
  let bufIndent = 0;
  let prevLen = 0;

  const flush = () => {
    if (buf !== null) out.push(' '.repeat(bufIndent) + buf);
    buf = null;
  };

  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    if (k === null) {
      flush();
      if (out.length && out[out.length - 1] !== '') out.push('');
      prevLen = 0;
      continue;
    }
    const rel = Math.max(0, k.indent - base);
    let text = k.text;
    let quoted = false;
    if (QUOTE_RAIL.test(text)) {
      text = '> ' + text.replace(QUOTE_RAIL, '');
      quoted = true;
    }
    const startsNew =
      buf === null ||
      quoted ||
      LIST_MARKER.test(text) ||
      prevLen < threshold ||
      rel > bufIndent + 3;

    if (startsNew) {
      flush();
      buf = text;
      bufIndent = rel;
    } else {
      // Paths and hyphenates wrap mid-token; rejoin those without a space.
      buf += /[/\-—]$/.test(buf) ? text : ' ' + text;
    }
    prevLen = k.indent + k.text.length;
  }
  flush();

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

// A block has to look like a sentence, not a widget label, to count as prose.
function looksLikeProse(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.split(/\s+/).length < 2) return false;
  return true;
}

function wrapWidthOf(lines) {
  let w = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].length > w) w = lines[i].length;
  return w || 100;
}

// Whole-capture guard: herdr hands back a JSON error object when a pane cannot
// be read. That is not a transcript.
function isHerdrError(lines) {
  const solid = lines.filter((l) => l.trim());
  if (solid.length !== 1) return false;
  const s = solid[0].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  try {
    const o = JSON.parse(s);
    return !!(o && (o.error || o.id));
  } catch {
    return false;
  }
}

// Shared front half of every read: normalise the capture, pick the layout that
// explains it best, and split it into blocks. Returns null when the text is not
// a transcript at all.
function prepare(text, opts) {
  let lines = toLines(text);
  if (!lines.length || !lines.some((l) => l.trim())) return null;
  if (isHerdrError(lines)) return null;

  const wrapWidth = wrapWidthOf(lines);
  const trimmed = trimFooter(lines);
  lines = trimmed.lines;
  if (!lines.length) return null;

  const explicit = resolveProfile(opts && opts.agent);
  const candidates = explicit
    ? [explicit]
    : [PROFILES.claude, PROFILES.codex, PROFILES.opencode];

  let best = null;
  for (const profile of candidates) {
    const blocks = segment(lines, profile);
    let marked = 0;
    let prose = 0;
    for (const b of blocks) {
      if (b.marked && (b.kind === 'assistant' || b.kind === 'tool' || b.kind === 'user')) marked++;
      if (b.kind === 'assistant') prose++;
    }
    const score = marked * 2 + prose;
    if (!best || score > best.score) best = { profile, blocks, score, prose };
  }
  if (!best) return null;
  return { ...best, lines, wrapWidth, explicit };
}

function analyse(text, opts) {
  const empty = { answer: '', confidence: 'low', kind: 'unknown', profile: 'none' };
  const prep = prepare(text, opts);
  if (!prep) return empty;
  const { lines, wrapWidth, explicit } = prep;
  const best = prep;

  if (!explicit && best.score === 0) {
    const loose = looseFallback(lines, wrapWidth);
    return loose || empty;
  }

  const { profile, blocks } = best;

  // Walk back for the newest assistant block that renders to real prose.
  let idx = -1;
  let answer = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind !== 'assistant') continue;
    const rendered = renderBlock(blocks[i], profile, wrapWidth);
    if (looksLikeProse(rendered)) {
      idx = i;
      answer = rendered;
      break;
    }
  }

  if (idx < 0) {
    const sawTool = blocks.some((b) => b.kind === 'tool');
    const loose = looseFallback(lines, wrapWidth);
    if (loose && loose.answer) return { ...loose, profile: profile.name };
    return {
      answer: '',
      confidence: 'low',
      kind: sawTool ? 'tool' : 'unknown',
      profile: profile.name,
    };
  }

  // Confidence: the turn has to be over and this has to be the last thing the
  // agent said. A tool card after it means the model is still mid-turn, and an
  // unmarked block means the capture window cut the message's opening off.
  let toolAfter = false;
  for (let i = idx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'tool' || blocks[i].kind === 'assistant') toolAfter = true;
  }
  // A live frame always has a footer, including while the model is still
  // working. Only an explicit turn-end marker proves this is its final reply.
  const turnEnded = !!blocks[idx].turnEnded;
  const confidence =
    blocks[idx].marked && !toolAfter && turnEnded && answer.length >= 20 ? 'high' : 'low';

  return { answer, confidence, kind: 'prose', profile: profile.name, blocks, idx };
}

// Last resort for layouts we do not recognise: strip chrome, throw away
// anything that smells like tool output, and keep the final run of sentences.
function looseFallback(lines, wrapWidth) {
  const cleaned = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (isChrome(raw)) {
      cleaned.push('');
      continue;
    }
    if (
      isBlockNoise(s, PROFILES.codex) ||
      /^[●•]?\s*(?:Ran|Read|Explored|Searched|Listed|Edited|Wrote|Called|Viewed|Applied patch|Updated Plan)\b/.test(
        s
      ) ||
      /^[+-]{1,3}\s|^@@ /.test(s) ||
      /^\s*\d+\s*[+|]/.test(raw)
    ) {
      cleaned.push('');
      continue;
    }
    cleaned.push(raw.replace(/^([ ]{0,2})[●•]\s/, '$1  '));
  }

  // Take the last contiguous run of non-blank lines that reads like sentences.
  let end = cleaned.length;
  while (end > 0 && !cleaned[end - 1].trim()) end--;
  if (!end) return null;
  let start = end;
  while (start > 0 && cleaned[start - 1].trim()) start--;

  const block = { head: undefined, body: cleaned.slice(start, end), indent: 0 };
  const answer = renderBlock(block, PROFILES.codex, wrapWidth);
  if (!looksLikeProse(answer)) return null;
  const words = answer.split(/\s+/).length;
  if (words < 4) return null;
  return { answer, confidence: 'low', kind: 'prose', profile: 'generic' };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Extract the human-facing reply from a captured agent terminal.
 *
 * @param {string} text  raw pane text (ANSI tolerated)
 * @param {{agent?: string}} [opts]
 * @returns {{answer: string, confidence: 'high'|'low', kind: 'prose'|'tool'|'unknown'}}
 *   `answer` is markdown-ready prose, '' when nothing prose-like was found.
 *   `kind` is 'prose' when an answer was recovered, 'tool' when the newest
 *   activity is a tool card with no readable prose behind it, 'unknown'
 *   otherwise. `confidence` is 'high' only when the recovered text is a
 *   complete, finished, most-recent assistant message.
 */
function extractAnswer(text, opts) {
  try {
    const r = analyse(text, opts || {});
    return { answer: r.answer || '', confidence: r.confidence, kind: r.kind };
  } catch {
    return { answer: '', confidence: 'low', kind: 'unknown' };
  }
}

/**
 * The most recent assistant turn, as plain markdown. Same extraction as
 * `extractAnswer` without the confidence signalling.
 *
 * @param {string} text
 * @param {{agent?: string}} [opts]
 * @returns {string}
 */
function lastAssistantBlock(text, opts) {
  try {
    const r = analyse(text, opts || {});
    return r.answer || '';
  } catch {
    return '';
  }
}

const TOOL_LABEL_MAX = 90;

// A tool card, reduced to the one line a human would read: "Ran npm test",
// "Read(src/index.js)". The body is the tool's own output and belongs in the
// raw transcript, not in a narration.
function toolLabel(block) {
  let head = String(block.head === undefined ? '' : block.head).trim();
  if (!head) {
    head = (block.body || []).map((s) => String(s).trim()).find(Boolean) || '';
  }
  head = head.replace(/\s+/g, ' ');
  if (!head) return '';
  return head.length > TOOL_LABEL_MAX ? `${head.slice(0, TOOL_LABEL_MAX - 1)}…` : head;
}

/**
 * Everything the agent has said and done in this capture, in order — the
 * running commentary behind a turn rather than only its conclusion.
 *
 * The last item is flagged: mid-turn it is very likely still being written, so
 * a caller streaming these should hold it back until something follows it.
 *
 * @param {string} text  raw pane text (ANSI tolerated)
 * @param {{agent?: string}} [opts]
 * @returns {{items: {kind:'assistant'|'tool', text:string, last:boolean}[], profile:string}}
 */
function narrate(text, opts) {
  try {
    const prep = prepare(text, opts || {});
    if (!prep || !prep.blocks) return { items: [], profile: 'none' };
    const { profile, blocks, wrapWidth } = prep;

    const items = [];
    for (const b of blocks) {
      if (b.kind === 'assistant') {
        // The window starts mid-block when the top has scrolled away, and what
        // is left carries no marker to say whose words they were. Often they
        // are the human's own prompt, wrapped and indented exactly like a
        // reply. Never open a narration with one.
        if (!items.length && !b.marked) continue;
        const rendered = renderBlock(b, profile, wrapWidth);
        if (looksLikeProse(rendered)) items.push({ kind: 'assistant', text: rendered, last: false });
        // Newer claude builds do not draw a card per call: they fold the work
        // into a receipt line inside the message ("Read 1 file", "Made 3 edits
        // +6"). renderBlock drops those as debris, which is right for an
        // answer and wrong for a narration — it is the only evidence of what
        // the agent did. They sit after the prose they follow, so emit them
        // in that order.
        for (const raw of b.body || []) {
          const s = String(raw).trim();
          if (s && isToolReceipt(s)) items.push({ kind: 'tool', text: s, last: false });
        }
      } else if (b.kind === 'tool') {
        const label = toolLabel(b);
        if (label) items.push({ kind: 'tool', text: label, last: false });
      } else if (b.kind === 'user') {
        // Not for posting — the prompt is already in the thread — but a caller
        // catching up mid-run needs to know where the current turn began.
        const asked = renderBlock(b, profile, wrapWidth);
        if (asked) items.push({ kind: 'user', text: asked, last: false });
      }
    }
    if (items.length) items[items.length - 1].last = true;
    return { items, profile: profile.name };
  } catch {
    return { items: [], profile: 'none' };
  }
}

module.exports = {
  extractAnswer,
  lastAssistantBlock,
  narrate,
  stripChrome,
  isChrome,
  // exported for tests / callers that want to reuse the primitives
  stripAnsi,
  toLines,
};
