// format.js — presentation helpers: herdr agent state -> Discord surfaces.
//
// Everything here is a pure function. No I/O, no state, no side effects, so it
// can be unit-tested without a Discord client or a running herdr.
//
// Agent object shape (see herdr.js normalizeAgent):
//   { paneId, agent, status, cwd, title, focused, workspaceId, tabId, sessionValue }

const { EmbedBuilder } = require('discord.js');

// ---- Discord hard limits ---------------------------------------------------
const MAX_MESSAGE = 2000; // message content
const MAX_EMBED_DESC = 4000; // embed description (4096 real; 4000 per spec)
const MAX_EMBED_TITLE = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_THREAD_NAME = 100;

const STATUS_EMOJI = {
  idle: '🟢',
  working: '🟡',
  blocked: '🔴',
  done: '✅',
  unknown: '⚪',
};

// Discord embed colors as ints.
const STATUS_COLOR = {
  idle: 0x5865f2, // blurple
  working: 0xfaa61a, // amber
  blocked: 0xed4245, // red
  done: 0x57f287, // green
  unknown: 0x99aab5, // grey
};

// Sort order for lists: the things that might need a human come first.
const STATUS_RANK = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

const UNKNOWN = 'unknown';

function normStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS_EMOJI, s) ? s : UNKNOWN;
}

function statusEmoji(status) {
  return STATUS_EMOJI[normStatus(status)];
}

function statusColor(status) {
  return STATUS_COLOR[normStatus(status)];
}

function statusRank(status) {
  return STATUS_RANK[normStatus(status)];
}

// Strip newlines, tabs and other control characters; collapse runs of spaces.
function sanitize(text) {
  return String(text == null ? '' : text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function basename(p) {
  const clean = String(p || '').replace(/[/\\]+$/, '');
  if (!clean) return '';
  const parts = clean.split(/[/\\]/);
  return parts[parts.length - 1] || clean;
}

// Truncate to `max` graceful-ly, appending an ellipsis when we cut.
function clamp(text, max, ellipsis = '…') {
  const s = String(text == null ? '' : text);
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= ellipsis.length) return s.slice(0, max);
  return s.slice(0, max - ellipsis.length).trimEnd() + ellipsis;
}

// Human-friendly name for an agent: its terminal title, else the cwd basename,
// else the pane id.
function agentLabel(agent) {
  const a = agent || {};
  const title = sanitize(a.title);
  if (title) return title;
  const base = sanitize(basename(a.cwd));
  if (base) return base;
  return sanitize(a.paneId) || 'agent';
}

// Neutralize ``` so untrusted terminal output can't escape a code fence.
// A zero-width space between the backticks keeps the text visually identical.
function defuseFences(text) {
  return String(text == null ? '' : text).replace(/`{3,}/g, (run) =>
    '`​'.repeat(run.length - 1) + '`',
  );
}

/**
 * Wrap text in a fenced code block that always fits in one Discord message.
 * Keeps the TAIL of long output — for terminal dumps the end is what matters.
 * @param {string} text
 * @param {string} [lang] syntax highlight hint (sanitized)
 * @returns {string} at most MAX_MESSAGE characters
 */
function codeBlock(text, lang = '') {
  const language = String(lang || '')
    .replace(/[^a-zA-Z0-9+#._-]/g, '')
    .slice(0, 20);
  const open = '```' + language + '\n';
  const close = '\n```';
  const budget = MAX_MESSAGE - open.length - close.length;

  // Defuse BEFORE clamping: defusing grows the string, so clamping afterwards
  // is what actually guarantees the length limit.
  let body = defuseFences(text);

  if (body.length > budget) {
    const marker = '…';
    body = body.slice(-(budget - marker.length));
    // A tail cut can land inside a defused run; drop leading backticks so the
    // truncated head can never read as fence syntax.
    body = marker + body.replace(/^`+/, '');
  }
  return open + body + close;
}

/**
 * Rich embed for a single agent.
 * @param {object} agent
 * @returns {import('discord.js').EmbedBuilder}
 */
function agentEmbed(agent) {
  const a = agent || {};
  const status = normStatus(a.status);
  const title = sanitize(a.title) || sanitize(a.paneId) || 'agent';

  const embed = new EmbedBuilder()
    .setTitle(clamp(`${STATUS_EMOJI[status]} ${title}`, MAX_EMBED_TITLE))
    .setColor(STATUS_COLOR[status])
    .addFields(
      {
        name: 'Pane',
        value: clamp('`' + (sanitize(a.paneId) || '—') + '`', MAX_FIELD_VALUE),
        inline: true,
      },
      { name: 'Agent', value: clamp(sanitize(a.agent) || '—', MAX_FIELD_VALUE), inline: true },
      { name: 'Status', value: `${STATUS_EMOJI[status]} ${status}`, inline: true },
      { name: 'CWD', value: clamp(sanitize(a.cwd) || '—', MAX_FIELD_VALUE) },
    );

  const footer = [];
  if (a.workspaceId) footer.push(`ws ${sanitize(a.workspaceId)}`);
  if (a.tabId) footer.push(`tab ${sanitize(a.tabId)}`);
  if (a.focused) footer.push('focused');
  if (footer.length) embed.setFooter({ text: clamp(footer.join(' · '), 2048) });

  return embed;
}

/** blocked -> working -> done -> idle -> unknown, then by pane id. */
function sortAgents(agents) {
  return (Array.isArray(agents) ? agents.slice() : []).sort((a, b) => {
    const d = statusRank(a && a.status) - statusRank(b && b.status);
    if (d !== 0) return d;
    return String((a && a.paneId) || '').localeCompare(String((b && b.paneId) || ''));
  });
}

/** One description line: `🟡 \`wR:p2\` **claude** · working · Fix dictation` */
function agentLine(agent) {
  const a = agent || {};
  const status = normStatus(a.status);
  const pane = sanitize(a.paneId) || '?';
  const name = sanitize(a.agent) || 'agent';
  return `${STATUS_EMOJI[status]} \`${pane}\` **${name}** · ${status} · ${agentLabel(a)}`;
}

/**
 * One embed summarizing many agents.
 * @param {object[]} agents
 * @returns {import('discord.js').EmbedBuilder}
 */
function agentListEmbed(agents) {
  const list = sortAgents(agents);

  // Build up to the description cap without cutting a line in half.
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const a of list) {
    const line = clamp(agentLine(a), 300);
    const cost = line.length + (lines.length ? 1 : 0);
    if (used + cost > MAX_EMBED_DESC - 24) {
      dropped = list.length - lines.length;
      break;
    }
    lines.push(line);
    used += cost;
  }
  if (dropped > 0) lines.push(`…and ${dropped} more`);

  const description = lines.length ? lines.join('\n') : '_No agents are running._';
  // Color the summary by the most urgent status present.
  const top = list.length ? normStatus(list[0].status) : UNKNOWN;

  return new EmbedBuilder()
    .setTitle(`herdr agents (${list.length})`)
    .setDescription(clamp(description, MAX_EMBED_DESC))
    .setColor(list.length ? STATUS_COLOR[top] : STATUS_COLOR.unknown)
    .setFooter({ text: 'Target commands by pane ID, e.g. /read wR:p2' });
}

/**
 * Stable, Discord-safe thread name for an agent, e.g. `🟡 wR:p2 · Fix dictation`.
 * @param {object} agent
 * @returns {string} 1..100 chars, no newlines or control characters
 */
function threadName(agent) {
  const a = agent || {};
  const emoji = STATUS_EMOJI[normStatus(a.status)];
  const pane = sanitize(a.paneId);
  const label = agentLabel(a);

  const head = pane ? `${emoji} ${pane}` : emoji;
  if (!label || label === pane) return clamp(head, MAX_THREAD_NAME) || 'agent';

  const room = MAX_THREAD_NAME - head.length - 3; // " · "
  if (room < 4) return clamp(head, MAX_THREAD_NAME);
  return `${head} · ${clamp(label, room)}`;
}

/**
 * One-line sentence describing a status transition.
 * e.g. `🟡 → ✅ **done** (was working)`; without a prev status, `✅ **done**`.
 * @param {object} agent
 * @param {string} [prevStatus]
 * @returns {string}
 */
function statusLine(agent, prevStatus) {
  const a = agent || {};
  const now = normStatus(a.status);
  const nowEmoji = STATUS_EMOJI[now];

  if (prevStatus === undefined || prevStatus === null || prevStatus === '') {
    return `${nowEmoji} **${now}**`;
  }
  const prev = normStatus(prevStatus);
  if (prev === now) return `${nowEmoji} **${now}** (unchanged)`;
  return `${STATUS_EMOJI[prev]} → ${nowEmoji} **${now}** (was ${prev})`;
}

module.exports = {
  // constants
  STATUS_EMOJI,
  STATUS_COLOR,
  STATUS_RANK,
  MAX_MESSAGE,
  MAX_EMBED_DESC,
  MAX_THREAD_NAME,
  // helpers
  statusEmoji,
  statusColor,
  statusRank,
  sortAgents,
  agentLabel,
  agentLine,
  defuseFences,
  clamp,
  // renderers
  codeBlock,
  agentEmbed,
  agentListEmbed,
  threadName,
  statusLine,
};
