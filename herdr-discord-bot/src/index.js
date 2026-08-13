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
} = require('discord.js');

const herdr = require('./herdr');

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

const STATUS_EMOJI = {
  idle: '🟢',
  working: '🟡',
  blocked: '🔴',
  done: '✅',
  unknown: '⚪',
};

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

const HANDLERS = {
  agents: handleAgents,
  status: handleStatus,
  read: handleRead,
  prompt: handlePrompt,
  setup: handleSetup,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- live sync: herdr workspaces/agents mirrored to channels/threads --------
const { Sync } = require('./sync');
const { Store } = require('./store');

let sync = null;
let store = null;

async function startSync(guild) {
  try {
    store = new Store();
    if (typeof store.load === 'function') await store.load();
  } catch (e) {
    console.error('[sync] store unavailable, continuing without persistence:', e.message);
    store = null;
  }
  sync = new Sync({
    client,
    guildId: guild.id,
    store,
    log: { info: console.log, error: console.error },
  });
  await sync.start(Number(process.env.SYNC_INTERVAL_MS || 5000));
  return sync;
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
      await s.tick().catch(() => {});
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

// Typing inside an agent's thread sends that text to the agent as a prompt.
// `//` prefix = human note, ignored. Only the authorized owner is obeyed.
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
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

    await message.react('📨').catch(() => {});
    // Pair the answer with the question: the agent's next output replies here.
    sync.expectReply(paneId, message.id);
    await herdr.promptAgent(paneId, text);
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
  const [action, paneId] = (interaction.customId || '').split(':');
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
