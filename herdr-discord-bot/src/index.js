// herdr-discord-bot — control your herdr agents from Discord.
//
// Security model (read this):
//   * Only the single OWNER_ID user may run any command. Everyone else is
//     refused with an ephemeral message.
//   * Commands only work inside GUILD_ID (your server). Optionally locked to
//     one channel via ALLOWED_CHANNEL_ID.
//   * The bot never runs arbitrary shell — it only calls specific `herdr`
//     subcommands with argv arrays (see herdr.js).

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ChannelType,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const path = require('node:path');

const herdr = require('./herdr');

// Where this bot itself lives — /run refuses to launch a second copy of it.
const SELF_ROOT = path.resolve(__dirname, '..');

const {
  DISCORD_TOKEN,
  OWNER_ID,
  GUILD_ID,
  ALLOWED_CHANNEL_ID, // optional
} = process.env;

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}
// Real bot tokens are ~59-72 chars; reject empty, the leftover placeholder, or
// anything too short so we fail with a clear message instead of a raw crash.
if (!DISCORD_TOKEN || /paste/i.test(DISCORD_TOKEN) || DISCORD_TOKEN.length < 50) {
  fail('DISCORD_TOKEN missing or still a placeholder in .env — paste your real bot token.');
}
if (!GUILD_ID) fail('GUILD_ID is not set (your server ID).');
// Discord user IDs are 17-20 digit snowflakes; treat anything else (blank or a
// leftover placeholder) as "not set" so we fall back to the server owner.
const OWNER_ID_VALID = /^\d{17,20}$/.test(OWNER_ID || '') ? OWNER_ID : null;
if (!OWNER_ID_VALID) {
  console.warn('[config] OWNER_ID not set/invalid — authorizing the server owner instead.');
}

// The authorized user: a valid OWNER_ID if provided, otherwise resolved to the
// guild owner at ready time (the person who created the server — see ClientReady).
let effectiveOwnerId = OWNER_ID_VALID;

const { STATUS_EMOJI } = require('./format');

function authorized(interaction) {
  if (interaction.guildId !== GUILD_ID) return false;
  if (!effectiveOwnerId || interaction.user.id !== effectiveOwnerId) return false;
  if (ALLOWED_CHANNEL_ID && interaction.channelId !== ALLOWED_CHANNEL_ID) {
    return false;
  }
  return true;
}

// Discord message content cap is 2000; keep headroom for code fences.
function codeBlock(text, lang = '') {
  const max = 1900;
  let body = text.length > max ? text.slice(-max) : text;
  body = body.replace(/```/g, '`​``'); // defuse fence-breaking
  return '```' + lang + '\n' + body + '\n```';
}

async function handleAgents(interaction) {
  const agents = await herdr.listAgents();
  if (!agents.length) {
    await interaction.reply({ content: 'No agents are running.', ephemeral: true });
    return;
  }
  // Sort: working/blocked first (things that may need you), then the rest.
  const rank = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
  agents.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));

  const lines = agents.map((a) => {
    const e = STATUS_EMOJI[a.status] || '⚪';
    const title = a.title || a.cwd.split('/').pop();
    return `${e} \`${a.paneId}\` **${a.agent}** · ${a.status} · ${title}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`herdr agents (${agents.length})`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setColor(0x5865f2)
    .setFooter({ text: 'Target commands by pane ID, e.g. /read wR:p2' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleStatus(interaction) {
  const target = interaction.options.getString('target', true);
  const a = await herdr.resolveTarget(target);
  const full = await herdr.getAgent(a.paneId);
  const e = STATUS_EMOJI[full.status] || '⚪';
  const embed = new EmbedBuilder()
    .setTitle(`${e} ${full.title || full.paneId}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Pane', value: `\`${full.paneId}\``, inline: true },
      { name: 'Agent', value: full.agent, inline: true },
      { name: 'Status', value: full.status, inline: true },
      { name: 'CWD', value: full.cwd || '—' },
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleRead(interaction) {
  const target = interaction.options.getString('target', true);
  const lines = interaction.options.getInteger('lines') || 40;
  const a = await herdr.resolveTarget(target);
  const out = await herdr.readAgent(a.paneId, Math.min(Math.max(lines, 1), 200));
  const header = `**${a.title || a.paneId}** \`${a.paneId}\` (${a.status})`;
  await interaction.reply({
    content: `${header}\n${codeBlock(out.trim() || '(no output)')}`,
    ephemeral: true,
  });
}

async function handlePrompt(interaction) {
  const target = interaction.options.getString('target', true);
  const text = interaction.options.getString('text', true);
  const a = await herdr.resolveTarget(target);
  await herdr.promptAgent(a.paneId, text);
  await interaction.reply({
    content: `📨 Sent to **${a.title || a.paneId}** \`${a.paneId}\`:\n${codeBlock(text)}`,
    ephemeral: true,
  });
}

// Bot-side server setup — this is the bot account acting as a bot (allowed),
// NOT automation of anyone's personal account.
const CONTROL_CHANNEL_NAME = process.env.CONTROL_CHANNEL_NAME || 'agent-control';

async function ensureControlChannel(guild) {
  const channels = await guild.channels.fetch();
  const existing = channels.find(
    (c) => c && c.type === ChannelType.GuildText && c.name === CONTROL_CHANNEL_NAME,
  );
  if (existing) return existing;
  return guild.channels.create({
    name: CONTROL_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: 'Control herdr agents — owner-only commands (/agents, /read, /prompt).',
  });
}

async function handleSetup(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const ch = await ensureControlChannel(interaction.guild);
  await interaction.editReply(`✅ Control channel ready: <#${ch.id}>. Try \`/agents\` there.`);
}

// Spawn a brand-new agent. herdr cannot create a pane and start an agent in one
// step, so herdr-extra does it in two and rolls the layout back if the start
// fails — a failed attempt never leaves an orphan pane behind.
async function handleNew(interaction) {
  const extra = require('./herdr-extra');
  const kind = interaction.options.getString('agent', true);
  const cwd = interaction.options.getString('cwd', true);
  const prompt = interaction.options.getString('prompt');

  if (extra.AGENT_KINDS && !extra.AGENT_KINDS.includes(kind)) {
    await interaction.reply({
      content: `⚠️ Unknown agent kind \`${kind}\`. Known: ${extra.AGENT_KINDS.join(', ')}`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  // Starting an agent waits for it to become interactive, so this is slow.
  const res = await extra.newAgent({ agentType: kind, cwd, focus: false });
  const paneId = res.paneId || res.agent?.paneId;

  if (prompt) {
    await herdr.promptAgent(paneId, prompt).catch(() => {});
  }

  await interaction.editReply(
    `🚀 Started **${kind}** in \`${cwd}\`\n` +
      `pane \`${paneId}\` · workspace \`${res.workspaceId}\`` +
      (prompt ? `\nSent your prompt.` : '') +
      `\n_Its channel and thread appear here within a few seconds._`,
  );
}

// --- GitHub ---------------------------------------------------------------
// A workspace channel maps to a project directory (its agents' cwd), so GitHub
// commands used inside one can infer the repo instead of making you type it.
async function repoForInteraction(interaction) {
  const explicit = interaction.options.getString('repo');
  if (explicit) return explicit;

  const gh = require('./github');
  // Prefer the agent thread we're in, else the project behind this channel.
  // sync.channels is keyed by project path (its git root), not by workspace id.
  const agents = await herdr.listAgents();
  let dir = null;

  if (sync) {
    const paneId = sync.paneForThread(interaction.channelId);
    if (paneId) dir = agents.find((a) => a.paneId === paneId)?.cwd || null;
  }
  if (!dir) dir = channelToProject(interaction.channelId);
  if (!dir) return null;
  return gh.repoForDir(dir);
}

async function handlePR(interaction) {
  const gh = require('./github');
  await interaction.deferReply({ ephemeral: true });
  const repo = await repoForInteraction(interaction);
  if (!repo) {
    await interaction.editReply(
      '⚠️ No GitHub repo for this channel. Pass `repo:` (e.g. `debpalash/Opal`) or run it in a workspace channel.',
    );
    return;
  }
  const prs = await gh.listPRs(repo, { state: 'open', limit: 15 });
  const embed = new EmbedBuilder()
    .setTitle(`${repo} — ${prs.length} open PR${prs.length === 1 ? '' : 's'}`)
    .setColor(prs.length ? 0x5865f2 : 0x57f287)
    .setDescription(prs.map(gh.prLine).join('\n').slice(0, 4000) || '_none open_');
  await interaction.editReply({ embeds: [embed] });
}

async function handleCI(interaction) {
  const gh = require('./github');
  await interaction.deferReply({ ephemeral: true });
  const repo = await repoForInteraction(interaction);
  if (!repo) {
    await interaction.editReply('⚠️ No GitHub repo for this channel. Pass `repo:`.');
    return;
  }
  const runs = await gh.listRuns(repo, { limit: 10 });
  const bad = runs.some((r) => r.conclusion === 'failure');
  const embed = new EmbedBuilder()
    .setTitle(`${repo} — recent CI`)
    .setColor(bad ? 0xed4245 : 0x57f287)
    .setDescription(runs.map(gh.runLine).join('\n').slice(0, 4000) || '_no runs_');
  await interaction.editReply({ embeds: [embed] });
}

async function handleIssues(interaction) {
  const gh = require('./github');
  await interaction.deferReply({ ephemeral: true });
  const repo = await repoForInteraction(interaction);
  if (!repo) {
    await interaction.editReply('⚠️ No GitHub repo for this channel. Pass `repo:`.');
    return;
  }
  const issues = await gh.listIssues(repo, { state: 'open', limit: 15 });
  const lines = issues.map(
    (i) => `🐛 [#${i.number}](${i.url}) ${gh.titleLine(i.title)} · _${i.author}_`,
  );
  const embed = new EmbedBuilder()
    .setTitle(`${repo} — ${issues.length} open issue${issues.length === 1 ? '' : 's'}`)
    .setColor(0xfaa61a)
    .setDescription(lines.join('\n').slice(0, 4000) || '_none open_');
  await interaction.editReply({ embeds: [embed] });
}

// --- browser testing --------------------------------------------------------
// Screenshot a running app. Accepts a full URL, a bare port, or nothing (in
// which case we offer whatever is actually listening).
async function handleScreenshot(interaction) {
  const browser = require('./browser');
  const raw = (interaction.options.getString('target') || '').trim();
  await interaction.deferReply();

  let url = raw;
  if (!raw) {
    const ports = await browser.listeningPorts();
    await interaction.editReply(
      ports.length
        ? `Which one? Re-run with a port or URL.\nListening now: ${ports
            .map((p) => `\`${p}\``)
            .join(' ')}`
        : 'Nothing is listening on this machine right now.',
    );
    return;
  }
  if (/^\d+$/.test(raw)) url = `http://127.0.0.1:${raw}/`;
  else if (!/^https?:\/\//i.test(raw)) url = `http://${raw}`;

  try {
    const shot = await browser.capture(url);
    const problems = [
      ...shot.consoleErrors.map((e) => `⚠️ ${e}`),
      ...shot.failedRequests.map((e) => `🚫 ${e}`),
    ].slice(0, 5);

    await interaction.editReply({
      content:
        `📸 **${shot.title || url}** · ${url} · ${shot.ms}ms` +
        (problems.length ? `\n${problems.join('\n').slice(0, 1500)}` : ''),
      files: [{ attachment: shot.png, name: 'screenshot.png' }],
    });
  } catch (e) {
    await interaction.editReply(`⚠️ Could not capture ${url}: ${e.message}`);
  }
}

// Walk a running app through real interactions and report each step. The URL
// resolves the same way /screenshot does, so a bare port works.
async function handleFlow(interaction) {
  const browser = require('./browser');
  const raw = (interaction.options.getString('url', true) || '').trim();
  const stepText = interaction.options.getString('steps', true);
  await interaction.deferReply();

  let url = raw;
  if (/^\d+$/.test(raw)) url = `http://127.0.0.1:${raw}/`;
  else if (!/^https?:\/\//i.test(raw)) url = `http://${raw}`;

  try {
    const run = await browser.drive(url, stepText);
    const lines = run.steps.map(
      (s) => `${s.ok ? '✅' : '❌'} \`${s.raw}\` — ${s.detail} · ${s.ms}ms`,
    );
    const skipped = browser.parseSteps(stepText).length - run.steps.length;
    if (skipped > 0) lines.push(`⏭️ ${skipped} step${skipped === 1 ? '' : 's'} not reached`);

    const problems = [
      ...run.consoleErrors.map((e) => `⚠️ ${e}`),
      ...run.failedRequests.map((e) => `🚫 ${e}`),
    ].slice(0, 5);

    const embed = new EmbedBuilder()
      .setTitle(`${run.ok ? '✅' : '❌'} ${run.title || url}`)
      .setColor(run.ok ? 0x57f287 : 0xed4245)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `${url} · ${run.ms}ms` });
    if (problems.length) {
      embed.addFields({ name: 'Page problems', value: problems.join('\n').slice(0, 1000) });
    }

    await interaction.editReply({
      embeds: [embed],
      files: [{ attachment: run.png, name: 'flow.png' }],
    });
  } catch (e) {
    await interaction.editReply(`⚠️ Could not run that flow against ${url}: ${e.message}`);
  }
}

// --- closing agents ---------------------------------------------------------
// Everything that starts an agent lives in Discord, so stopping one should too.
// Closing the workspace rather than the pane when it is the last pane keeps the
// sidebar from filling with empty shells.
async function closeAgentPane(agent) {
  const extra = require('./herdr-extra');
  const ws = agent.workspaceId
    ? await extra.getWorkspace(agent.workspaceId).catch(() => null)
    : null;
  if (ws && ws.paneCount <= 1) {
    await extra.closeWorkspace(agent.workspaceId);
    return `workspace \`${agent.workspaceId}\``;
  }
  await extra.closePane(agent.paneId);
  return `pane \`${agent.paneId}\``;
}

async function handleClose(interaction) {
  const target = interaction.options.getString('target');
  let paneId = target;
  if (!paneId && sync) paneId = sync.paneForThread(interaction.channelId);
  if (!paneId) {
    await interaction.reply({
      content: '⚠️ Run this inside an agent thread, or pass `target:` with a pane id.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const a = await herdr.resolveTarget(paneId);

  // An idle agent has nothing to lose. One mid-task does, so make that a
  // deliberate second action rather than a single mistyped command.
  if (a.status === 'working' || a.status === 'blocked') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`closeok:${a.paneId}`)
        .setLabel(`Close ${a.paneId} anyway`)
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({
      content:
        `⚠️ \`${a.paneId}\` **${a.agent}** is ${a.status} — ${a.title || 'no title'}\n` +
        'Closing now discards whatever it is in the middle of.',
      components: [row],
    });
    return;
  }

  const what = await closeAgentPane(a);
  await interaction.editReply(`⚫ Closed ${what} — \`${a.paneId}\` **${a.agent}** was ${a.status}.`);
}

// See or drop what is waiting for the agent whose thread you are in.
async function handleQueue(interaction) {
  const paneId =
    interaction.options.getString('target') || sync?.paneForThread(interaction.channelId);
  if (!paneId) {
    await interaction.reply({
      content: '⚠️ Run this inside an agent thread, or pass `target:` with a pane id.',
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  if (interaction.options.getBoolean('clear')) {
    const n = queue?.clear(paneId) || 0;
    await interaction.editReply(
      n ? `🗑️ Dropped ${n} queued prompt${n === 1 ? '' : 's'} for \`${paneId}\`.` : 'Nothing was queued.',
    );
    return;
  }

  const items = queue?.list(paneId) || [];
  if (!items.length) {
    await interaction.editReply(`Nothing queued for \`${paneId}\` — it takes prompts straight away.`);
    return;
  }
  const lines = items.map((q, i) => `**${i + 1}.** ${q.text.slice(0, 150)}`);
  await interaction.editReply(
    `⏳ **${items.length}** waiting for \`${paneId}\`\n${lines.join('\n').slice(0, 1800)}`,
  );
}

// --- worktrees --------------------------------------------------------------
// A worktree is how two agents work the same repo without fighting over the
// same files: separate checkout, separate branch, one workspace each.
async function handleWorktree(interaction) {
  const extra = require('./herdr-extra');
  const sub = interaction.options.getSubcommand();
  const root = interaction.options.getString('project') || (await projectRootFor(interaction));
  if (!root) {
    await interaction.reply({
      content: '⚠️ No project for this channel. Pass `project:` with an absolute path.',
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: sub !== 'list' });

  if (sub === 'list') {
    const trees = await extra.listWorktrees({ cwd: root });
    const lines = trees.map((w) => {
      const open = w.openWorkspaceId ? ` · open as \`${w.openWorkspaceId}\`` : '';
      return `${w.isLinked ? '🌿' : '🌳'} \`${w.branch || '(detached)'}\` — \`${w.path}\`${open}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`${trees[0]?.repoName || path.basename(root)} — ${trees.length} worktree${trees.length === 1 ? '' : 's'}`)
      .setColor(0x2ecc71)
      .setDescription(lines.join('\n').slice(0, 4000) || '_none_');
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === 'new') {
    const branch = interaction.options.getString('branch', true);
    const base = interaction.options.getString('base');
    const kind = interaction.options.getString('agent');

    const res = await extra.createWorktree({ cwd: root, branch, base, focus: false });
    let started = '';
    if (kind) {
      const agent = await extra.newAgent({ agentType: kind, cwd: res.path, focus: false });
      started = `\nStarted **${kind}** in it — pane \`${agent.paneId || agent.agent?.paneId}\`.`;
    }
    await interaction.editReply(
      `🌿 Worktree \`${res.branch || branch}\` at \`${res.path}\`\n` +
        `workspace \`${res.workspaceId}\`${base ? ` · based on \`${base}\`` : ''}${started}`,
    );
    return;
  }

  if (sub === 'remove') {
    const workspaceId = interaction.options.getString('workspace', true);
    const force = interaction.options.getBoolean('force') || false;
    const res = await extra.removeWorktree(workspaceId, { force });
    // Removing a worktree does not delete its branch, and shouldn't — the
    // commits on it are the whole point. Say so rather than let it look lost.
    await interaction.editReply(
      `🗑️ Removed worktree \`${res.path || workspaceId}\`${res.forced ? ' (forced)' : ''} and closed its workspace.\n` +
        `_The branch itself is untouched — delete it with git if you want it gone._`,
    );
  }
}

// --- project run / test -----------------------------------------------------
// Resolve which project a command refers to: an explicit path, else the project
// behind the channel it was typed in.
// Which project a command refers to: an explicit path, the agent whose thread
// we're in, or the project this channel stands for. The channel mapping is read
// from memory first and the store second, so a command still resolves before
// the first sync pass has run.
function channelToProject(channelId) {
  if (sync?.channels) {
    for (const [projectKey, chId] of sync.channels) {
      if (chId === channelId) return projectKey;
    }
  }
  try {
    const all = store?.allWorkspaceChannels?.() || [];
    for (const { workspaceId, channelId: chId } of all) {
      if (chId === channelId && String(workspaceId).startsWith('/')) return workspaceId;
    }
  } catch {
    /* store is optional */
  }
  return null;
}

async function projectRootFor(interaction) {
  const explicit = interaction.options.getString('project');
  if (explicit) return explicit;

  if (sync) {
    const paneId = sync.paneForThread(interaction.channelId);
    if (paneId) {
      const agents = await herdr.listAgents();
      const a = agents.find((x) => x.paneId === paneId);
      if (a) return a.cwd;
    }
  }
  return channelToProject(interaction.channelId);
}

async function handleTest(interaction) {
  const { detectDeep: detect, runBounded } = require('./project');
  await interaction.deferReply();

  const root = await projectRootFor(interaction);
  if (!root) {
    await interaction.editReply('⚠️ No project for this channel. Pass `project:` with an absolute path.');
    return;
  }
  const info = detect(root);
  if (!info.test) {
    await interaction.editReply(
      info.ambiguous
        ? `⚠️ **${info.name}** has several subprojects (${info.ambiguous.join(', ')}). ` +
            `Pass \`project:\` with the one you mean.`
        : `⚠️ No test command found for **${info.name}** (looked at ${info.evidence.join(', ') || 'nothing'}).`,
    );
    return;
  }

  // Run where the manifest lives, not at the repo root — detection may have
  // adopted a subproject (this repo keeps its app in herdr-discord-bot/).
  const cwd = info.root || root;
  await interaction.editReply(`🧪 Running \`${info.test}\` in **${info.name}**…`);
  const res = await runBounded(info.test, cwd);
  const tail = (res.stdout + '\n' + res.stderr).trim().split('\n').slice(-25).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${res.ok ? '✅' : '❌'} ${info.name} — ${info.test}`)
    .setColor(res.ok ? 0x57f287 : 0xed4245)
    .setDescription(codeBlock(tail || '(no output)'))
    .setFooter({
      text: res.timedOut ? `timed out after ${res.ms}ms` : `exit ${res.code} · ${res.ms}ms`,
    });
  await interaction.editReply({ content: '', embeds: [embed] });
}

async function handleRun(interaction) {
  const { detectDeep: detect, observeStart } = require('./project');
  const extra = require('./herdr-extra');
  await interaction.deferReply({ ephemeral: true });

  const root = await projectRootFor(interaction);
  if (!root) {
    await interaction.editReply('⚠️ No project for this channel. Pass `project:` with an absolute path.');
    return;
  }
  const info = detect(root);
  const explicit = interaction.options.getString('command');
  const cmd = explicit || info.run;
  if (!cmd) {
    await interaction.editReply(`⚠️ No run command found for **${info.name}**.`);
    return;
  }

  // A dev server is long-lived, so it belongs in a herdr pane where it keeps
  // running and its output streams into Discord like any other agent. Start it
  // where its manifest lives, which may be a subproject of the repo root.
  const cwd = info.root || root;

  // In this repo the detected run command starts this very bot. A second copy
  // on the same token would double every post in the server, so don't offer to
  // do it by accident — an explicit `command:` still runs.
  if (!explicit && path.resolve(cwd) === SELF_ROOT) {
    await interaction.editReply(
      `⚠️ \`${cmd}\` in **${info.name}** is this bot itself — a second copy on the same ` +
        'token would double every message here. Pass `command:` if you meant something else.',
    );
    return;
  }
  const ws = await extra.createWorkspace({ cwd, label: `run ${info.name}`, focus: false });
  const paneId = ws.pane.paneId || ws.pane.id;
  await extra.runInPane(paneId, cmd);
  await interaction.editReply(`▶️ Starting \`${cmd}\` in **${info.name}**…`);

  // `visible` is the screen itself. The `recent` sources track output since the
  // last marker and come back empty for a plain shell pane, which is this case.
  const seen = await observeStart(() => extra.readPane(paneId, { lines: 40, source: 'visible' }));

  if (seen.state === 'failed' || seen.state === 'exited') {
    // The pane is now an idle shell — nothing to keep, and leaving it behind
    // would litter the sidebar with dead workspaces.
    await extra.closeWorkspace(ws.workspace.workspaceId || ws.workspace.id).catch(() => {});
    const tail = seen.output.trim().split('\n').slice(-12).join('\n');
    const verb = seen.state === 'failed' ? '❌ failed' : '✅ finished';
    await interaction.editReply(
      `${verb} — \`${cmd}\` did not stay running in **${info.name}**\n${codeBlock(tail)}`,
    );
    return;
  }

  // Prefer the port the process actually announced over the one we guessed.
  const port = seen.port || info.port;
  await interaction.editReply(
    (seen.state === 'serving' ? `▶️ Serving ${seen.url}` : `▶️ Started \`${cmd}\``) +
      ` in **${info.name}**\npane \`${paneId}\`` +
      (port ? ` · \`/screenshot ${port}\`` : ''),
  );
}

// Move a task to a different agent/provider. See handoff.js on why this costs
// tokens rather than being free.
async function handleHandoff(interaction) {
  const { buildBrief } = require('./handoff');
  const extra = require('./herdr-extra');
  await interaction.deferReply({ ephemeral: true });

  const targetKind = interaction.options.getString('to', true);
  const note = interaction.options.getString('note');
  const fromArg = interaction.options.getString('from');

  let paneId = fromArg;
  if (!paneId && sync) paneId = sync.paneForThread(interaction.channelId);
  if (!paneId) {
    await interaction.editReply(
      '⚠️ Run this inside an agent thread, or pass `from:` with a pane id.',
    );
    return;
  }
  const resolved = await herdr.resolveTarget(paneId);

  const brief = await buildBrief(resolved.paneId, { note });
  const created = await extra.newAgent({
    agentType: targetKind,
    cwd: brief.agent.cwd,
    focus: false,
  });
  const newPane = created.paneId || created.agent?.paneId;
  await herdr.promptAgent(newPane, brief.text);

  await interaction.editReply(
    `🔀 Handed off **${brief.agent.agent} → ${targetKind}**\n` +
      `from \`${resolved.paneId}\` to \`${newPane}\` in \`${brief.agent.cwd}\`\n` +
      `brief ≈ **${brief.approxTokens} tokens** (a transcript replay would be far larger)\n` +
      `_The original agent is untouched — stop it yourself if you no longer need it._`,
  );
}

const HANDLERS = {
  agents: handleAgents,
  handoff: handleHandoff,
  screenshot: handleScreenshot,
  flow: handleFlow,
  close: handleClose,
  queue: handleQueue,
  worktree: handleWorktree,
  test: handleTest,
  run: handleRun,
  pr: handlePR,
  ci: handleCI,
  issues: handleIssues,
  status: handleStatus,
  read: handleRead,
  prompt: handlePrompt,
  setup: handleSetup,
  new: handleNew,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  // DM channels arrive uncached, so they must be requested as partials or the
  // message event never fires for them.
  partials: [Partials.Channel, Partials.Message],
});

// --- live sync: herdr workspaces/agents mirrored to channels/threads --------
const { Sync } = require('./sync');
const { Store } = require('./store');

let sync = null;
let store = null;
let ciWatch = null;
let queue = null;

async function startSync(guild) {
  try {
    store = new Store();
    if (typeof store.load === 'function') await store.load();
  } catch (e) {
    console.error('[sync] store unavailable, continuing without persistence:', e.message);
    store = null;
  }
  const { Queue } = require('./queue');
  queue = new Queue({ store, log: { info: console.log, error: console.error } });

  sync = new Sync({
    client,
    guildId: guild.id,
    store,
    log: { info: console.log, error: console.error },
    onSettled: (paneId, thread) => {
      drainQueue(paneId, thread).catch((e) =>
        console.error(`[queue] drain ${paneId} failed:`, e.message),
      );
    },
  });
  await sync.start(Number(process.env.SYNC_INTERVAL_MS || 5000));
  return sync;
}

// Hand a waiting prompt to an agent that has just gone quiet. One at a time:
// the next one goes when this one settles, which is what makes it a queue
// rather than a burst.
async function drainQueue(paneId, thread) {
  if (!queue?.size(paneId)) return;
  const next = queue.shift(paneId);
  if (!next) return;

  try {
    if (next.messageId) sync?.expectReply(paneId, next.messageId);
    await herdr.promptAgent(paneId, next.text);
    const left = queue.size(paneId);
    await thread
      ?.send(
        `📨 Sent the queued prompt${left ? ` · ${left} still waiting` : ''}:\n> ${next.text.slice(0, 300)}`,
      )
      .catch(() => {});
  } catch (e) {
    // Put it back rather than silently losing what was typed.
    queue.push(paneId, next);
    throw e;
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[ready] logged in as ${c.user.tag}`);
  try {
    const guild = await c.guilds.fetch(GUILD_ID);
    if (!effectiveOwnerId) {
      effectiveOwnerId = guild.ownerId;
      console.log(`[ready] authorized owner resolved from server owner: ${effectiveOwnerId}`);
    }
    console.log(`[ready] owner=${effectiveOwnerId} guild=${GUILD_ID} (${guild.name})`);
    const ch = await ensureControlChannel(guild);
    console.log(`[ready] control channel ready: #${ch.name}`);
    if (process.env.BOOT_SELFTEST === '1') {
      const agents = await herdr.listAgents();
      await ch.send(
        `✅ Boot self-test — herdr bridge reachable: **${agents.length}** agents detected. Try \`/agents\`.`,
      );
    }
    if (process.env.SYNC_DISABLED !== '1') {
      const s = await startSync(guild);
      // The live panel lives in the control channel and refreshes every tick.
      s.attachDashboard(ch);
      // Not awaited: a full pass over every project and thread can take a
      // while, and nothing below should wait on it.
      s.tick().catch(() => {});

      if (process.env.CI_WATCH !== '0') {
        const { CIWatch } = require('./ci-watch');
        ciWatch = new CIWatch({ sync: s, store, log: { info: console.log, error: console.error } });
        ciWatch.start().catch((e) => console.error('[ci] start failed:', e.message));
      }
    }
  } catch (e) {
    console.error('[ready] setup error:', e.message);
  }
});

// When the bot is invited to a server, auto-create its control channel.
client.on(Events.GuildCreate, async (guild) => {
  if (GUILD_ID && guild.id !== GUILD_ID) return;
  try {
    const ch = await ensureControlChannel(guild);
    console.log(`[setup] control channel ready: #${ch.name} in ${guild.name}`);
    await ch.send(
      '🟢 herdr control bridge online. Owner-only commands: `/agents`, `/status`, `/read`, `/prompt`.',
    );
  } catch (e) {
    console.error('[setup] could not create channel:', e.message);
  }
});

// A DM is a private console: no server, no threads, just talk to herdr.
// Supported: bare text -> overview; `<pane> <text>` -> prompt; `read <pane>`;
// `agents`; `help`.
async function handleDirectMessage(message) {
  const text = (message.content || '').trim();
  if (!text) return;

  const reply = (s) => message.reply(s.length > 1950 ? s.slice(0, 1950) + '…' : s);

  const [first, ...rest] = text.split(/\s+/);
  const cmd = first.toLowerCase();

  if (cmd === 'help') {
    await reply(
      '**herdr console**\n' +
        '`agents` — list every agent\n' +
        '`read <pane>` — recent output\n' +
        '`<pane> <text>` — send a prompt to that agent\n' +
        '`stop <pane>` — interrupt it\n' +
        'Anything else shows the overview.',
    );
    return;
  }

  if (cmd === 'agents' || cmd === 'ls') {
    const agents = await herdr.listAgents();
    const rank = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
    agents.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    const lines = agents.map(
      (a) =>
        `${STATUS_EMOJI[a.status] || '⚪'} \`${a.paneId}\` ${a.title || a.cwd.split('/').pop()}`,
    );
    await reply(`**${agents.length} agents**\n${lines.join('\n')}`);
    return;
  }

  if (cmd === 'read' && rest.length) {
    const a = await herdr.resolveTarget(rest.join(' '));
    const out = await herdr.readAgent(a.paneId, 30);
    await reply(`**${a.title || a.paneId}** (${a.status})\n${codeBlock(out.trim() || '(no output)')}`);
    return;
  }

  if (cmd === 'stop' && rest.length) {
    const a = await herdr.resolveTarget(rest.join(' '));
    await herdr.sendKeys(a.paneId, ['esc', 'esc']);
    await reply(`⛔ Interrupted \`${a.paneId}\`.`);
    return;
  }

  // "<pane> <prompt text>" — prompt a specific agent.
  if (rest.length) {
    try {
      const a = await herdr.resolveTarget(first);
      await herdr.promptAgent(a.paneId, rest.join(' '));
      await reply(`📨 Sent to **${a.title || a.paneId}** \`${a.paneId}\`.`);
      return;
    } catch {
      /* not a pane reference — fall through to the overview */
    }
  }

  const agents = await herdr.listAgents();
  const c = agents.reduce((m, a) => ((m[a.status] = (m[a.status] || 0) + 1), m), {});
  await reply(
    `🔴 ${c.blocked || 0} blocked · 🟡 ${c.working || 0} working · ` +
      `✅ ${c.done || 0} done · 🟢 ${c.idle || 0} idle\n_Send \`help\` for commands._`,
  );
}

// Typing inside an agent's thread sends that text to the agent as a prompt.
// `//` prefix = human note, ignored. Only the authorized owner is obeyed.
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // Direct message = private console. Owner only, same as everything else.
    if (!message.guildId) {
      if (message.author.id !== effectiveOwnerId) return;
      await handleDirectMessage(message).catch(async (e) => {
        await message.reply(`⚠️ ${e.message}`).catch(() => {});
      });
      return;
    }

    if (!sync) return;
    if (message.guildId !== GUILD_ID) return;
    if (!message.channel?.isThread?.()) return;

    const paneId = sync.paneForThread(message.channelId);
    if (!paneId) return;

    if (message.author.id !== effectiveOwnerId) {
      await message.react('⛔').catch(() => {});
      return;
    }

    const text = (message.content || '').trim();
    if (!text || text.startsWith('//')) return;

    // Talking over an agent that is mid-task derails it, so hold the prompt
    // and hand it over the moment it settles. `!` sends anyway.
    const urgent = text.startsWith('!');
    const body = urgent ? text.slice(1).trim() : text;
    if (!body) return;

    if (!urgent && queue) {
      const a = await herdr.getAgent(paneId).catch(() => null);
      // Blocked counts too: that agent is sitting on a permission prompt, and
      // free text typed at it answers the prompt rather than asking anything.
      // The approve/deny buttons are how you get past that.
      const busy = a && (a.status === 'working' || a.status === 'blocked');
      if (busy || (a && queue.size(paneId) > 0)) {
        const place = queue.push(paneId, { text: body, messageId: message.id });
        await message.react('⏳').catch(() => {});
        if (place > 1) {
          await message.reply(`⏳ Queued — ${place} in line behind what it's doing.`).catch(() => {});
        }
        return;
      }
    }

    await message.react('📨').catch(() => {});
    // Pair the answer with the question: the agent's next output replies here.
    sync.expectReply(paneId, message.id);
    await herdr.promptAgent(paneId, body);
    await message.react('✅').catch(() => {});
  } catch (e) {
    console.error('[thread-prompt] failed:', e.message);
    await message.reply(`⚠️ ${e.message}`).catch(() => {});
  }
});

// Buttons on blocked-agent notices: answer or interrupt without leaving Discord.
const BUTTON_KEYS = {
  approve: ['enter'],
  deny: ['esc'],
  interrupt: ['esc', 'esc'],
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  // Pane ids contain a colon themselves (`w1D:p1`), so split on the first one
  // only — splitting on all of them hands herdr a workspace id and it rightly
  // answers "agent target w1D not found".
  const raw = interaction.customId || '';
  const cut = raw.indexOf(':');
  const action = cut < 0 ? '' : raw.slice(0, cut);
  const paneId = cut < 0 ? '' : raw.slice(cut + 1);
  if (!action || !paneId) return;

  if (interaction.guildId !== GUILD_ID || interaction.user.id !== effectiveOwnerId) {
    await interaction.reply({ content: '⛔ Not authorized.', ephemeral: true }).catch(() => {});
    return;
  }

  try {
    if (action === 'read') {
      await interaction.deferReply({ ephemeral: true });
      const out = await herdr.readAgent(paneId, 40);
      await interaction.editReply(codeBlock(out.trim() || '(no output)'));
      return;
    }
    if (action === 'status') {
      await interaction.deferReply({ ephemeral: true });
      const a = await herdr.getAgent(paneId);
      const e = STATUS_EMOJI[a.status] || '⚪';
      await interaction.editReply(
        `${e} \`${a.paneId}\` **${a.agent}** · ${a.status}\n` +
          `${a.title || '(no title)'}\n\`${a.cwd}\``,
      );
      return;
    }
    if (action === 'closeok') {
      await interaction.deferReply({ ephemeral: true });
      const a = await herdr.resolveTarget(paneId);
      const what = await closeAgentPane(a);
      await interaction.editReply(`⚫ Closed ${what} — \`${a.paneId}\` **${a.agent}**.`);
      return;
    }
    const keys = BUTTON_KEYS[action];
    if (!keys) return;
    await interaction.deferReply({ ephemeral: true });
    await herdr.sendKeys(paneId, keys);
    const verb = { approve: '✅ Approved', deny: '🚫 Denied', interrupt: '⛔ Interrupted' }[action];
    await interaction.editReply(`${verb} — sent \`${keys.join(' ')}\` to \`${paneId}\`.`);
  } catch (e) {
    console.error(`[button] ${action} failed:`, e.message);
    const msg = { content: `⚠️ ${e.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!authorized(interaction)) {
    await interaction.reply({
      content: '⛔ Not authorized.',
      ephemeral: true,
    });
    console.warn(
      `[deny] user=${interaction.user.id} guild=${interaction.guildId} cmd=${interaction.commandName}`,
    );
    return;
  }

  const handler = HANDLERS[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (err) {
    console.error(`[error] ${interaction.commandName}:`, err.message);
    const payload = { content: `⚠️ ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
