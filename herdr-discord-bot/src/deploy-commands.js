// Registers the bot's slash commands to your guild (instant, unlike global).
// Run once after changing commands:  npm run deploy

require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Need DISCORD_TOKEN, CLIENT_ID and GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create/verify the agent-control channel in this server'),

  new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start a new agent in a directory')
    .addStringOption((o) =>
      o
        .setName('agent')
        .setDescription('Which agent to run')
        .setRequired(true)
        .addChoices(
          { name: 'claude', value: 'claude' },
          { name: 'codex', value: 'codex' },
          { name: 'opencode', value: 'opencode' },
          { name: 'gemini', value: 'gemini' },
          { name: 'cursor', value: 'cursor' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('cwd')
        .setDescription('Absolute path to work in, e.g. /home/ubuntu/github/Cly')
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('prompt').setDescription('Optional first prompt to send').setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('screenshot')
    .setDescription('Screenshot a running app (URL, or just a port)')
    .addStringOption((o) =>
      o
        .setName('target')
        .setDescription('URL or port, e.g. 3900 or http://localhost:3901')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('pr')
    .setDescription('Open pull requests for this project')
    .addStringOption((o) =>
      o.setName('repo').setDescription('owner/name (inferred from the channel if omitted)'),
    ),

  new SlashCommandBuilder()
    .setName('ci')
    .setDescription('Recent CI runs for this project')
    .addStringOption((o) =>
      o.setName('repo').setDescription('owner/name (inferred from the channel if omitted)'),
    ),

  new SlashCommandBuilder()
    .setName('issues')
    .setDescription('Open issues for this project')
    .addStringOption((o) =>
      o.setName('repo').setDescription('owner/name (inferred from the channel if omitted)'),
    ),

  new SlashCommandBuilder()
    .setName('agents')
    .setDescription('List all herdr agents and their status'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show one agent in detail')
    .addStringOption((o) =>
      o
        .setName('target')
        .setDescription('Pane ID (e.g. wR:p2) or a title/path substring')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('read')
    .setDescription("Read an agent's recent terminal output")
    .addStringOption((o) =>
      o
        .setName('target')
        .setDescription('Pane ID or a title/path substring')
        .setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName('lines')
        .setDescription('How many lines (default 40, max 200)')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('Send a prompt to an agent')
    .addStringOption((o) =>
      o
        .setName('target')
        .setDescription('Pane ID or a title/path substring')
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('text').setDescription('The prompt to send').setRequired(true),
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} commands to guild ${GUILD_ID}...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('Done. Slash commands are live in your server.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
