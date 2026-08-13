# herdr-discord-bot

Control your [herdr](https://herdr) agents from a Discord channel. This is a
**ChatOps bridge**: a proper *bot account* (not your personal account) that talks
to the herdr socket API running on this machine.

## What it does

Owner-only slash commands, usable only inside your server:

| Command | What it does |
|---|---|
| `/setup` | Create/verify the `#agent-control` channel (the bot makes it itself) |
| `/agents` | List every herdr agent with status (🟢 idle · 🟡 working · 🔴 blocked · ✅ done) |
| `/status <target>` | Show one agent in detail (agent type, status, cwd) |
| `/read <target> [lines]` | Read an agent's recent terminal output (default 40, max 200 lines) |
| `/prompt <target> <text>` | Send a prompt to an agent |

The bot also auto-creates its control channel the moment it's invited to your
server (via the `GuildCreate` event) — no manual channel setup needed.

Agent threads keep a raw, append-only terminal transcript for inspection. When
an agent settles, the bot also posts its final prose reply as normal Discord
Markdown; if the turn began with a message in that thread, the final reply is
threaded directly to that message. Set `ANSWER_LINES` (default `120`, maximum
`200`) to tune how much terminal history is considered for that final reply.

`<target>` is a herdr **pane ID** (e.g. `wR:p2`, shown by `/agents`) or a
substring of the agent's title/path (must be unambiguous).

## Security

- **Owner-locked:** only the user in `OWNER_ID` can run anything. Everyone else
  gets `⛔ Not authorized`.
- **Server-locked:** commands only work inside `GUILD_ID`. Optionally pin to one
  channel with `ALLOWED_CHANNEL_ID`.
- **No arbitrary shell:** the bot only calls specific `herdr` subcommands with
  argument arrays — Discord text can't inject shell commands.
- The token lives in `.env`, which is gitignored.

> ⚠️ `/prompt` lets you drive real agents that can change files and run code on
> this machine. Keep the server private and `OWNER_ID` correct.

## Setup (5 steps)

1. **Install deps** (already done if you ran the setup):
   ```bash
   npm install
   ```

2. **Fill in `.env`** (copy from `.env.example`):
   ```bash
   cp .env.example .env
   # then edit .env
   ```
   You need: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `OWNER_ID`.
   Enable Discord **Developer Mode** (Settings → Advanced) to copy the
   server/user IDs via right-click.

3. **Invite the bot to your server.** Open this URL (replace `CLIENT_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=85008
   ```
   `permissions=85008` = View Channels + Manage Channels + Send Messages +
   Embed Links + Read Message History. (Manage Channels lets the bot create its
   own `#agent-control` channel.) Pick your server and Authorize — this one
   consent click is the only thing that touches your personal account.

4. **Register slash commands** (once, and after any command change):
   ```bash
   npm run deploy
   ```

5. **Run the bot:**
   ```bash
   npm start
   ```
   You should see `[ready] logged in as <bot>#0000`. Type `/agents` in your
   server.

## Run it 24/7 (optional)

A user systemd unit is provided in `herdr-discord-bot.service`. Install with:
```bash
mkdir -p ~/.config/systemd/user
cp herdr-discord-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now herdr-discord-bot
systemctl --user status herdr-discord-bot
journalctl --user -u herdr-discord-bot -f   # logs
```
(You may want `loginctl enable-linger $USER` so it runs without an active login.)
