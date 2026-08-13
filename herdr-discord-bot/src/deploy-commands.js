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
