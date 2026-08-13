# Handoff — herdr Discord control bridge

Status as of 2026-08-13, built while you slept. **One step left: paste the bot token.**

## ✅ Done (verified)

- **Bot code** written + `npm install`ed at `~/github/Cly/herdr-discord-bot/`.
- **Target server: AgentRoom** (`GUILD_ID=1537289642959699998`) — as you asked.
- **Bot invited to AgentRoom** — `agent_bot` is already a member (shows "Glad
  you're here, agent_bot"). It's offline until it has a token.
- **`CLIENT_ID` set** (`1537297247232851999`, the aagent_bot application).
- **herdr bridge tested live** — reads your running agents fine (23 detected).
- **Slash commands ready to register:** `/agents`, `/status`, `/read`, `/prompt`, `/setup`.
- On first start the bot **auto-creates `#agent-control`** in AgentRoom.
- `OWNER_ID` left blank on purpose → the bot authorizes **AgentRoom's owner
  (you)** automatically. Only you can run commands.

## ⛔ The one thing I could NOT do — get the token

Resetting the bot token pops a **password / Multi-Factor Authentication** prompt.
I don't have (and won't touch) your password, so this step is yours:

1. Open **Developer Portal → Applications → aagent_bot → Bot**
   (https://discord.com/developers/applications/1537297247232851999/bot).
2. Click **Reset Token** → enter your password/2FA → **Copy** the new token.
3. Put it in `.env`:
   ```
   DISCORD_TOKEN=<paste the token here>
   ```
   (Edit `~/github/Cly/herdr-discord-bot/.env`. The token is only shown once.)

## ▶️ Then start it

```bash
cd ~/github/Cly/herdr-discord-bot
./start.sh          # registers slash commands, then runs the bot
```
Expect: `[ready] logged in as agent_bot…`, then `#agent-control` appears in
AgentRoom. Type `/agents` there.

For 24/7, use the systemd unit (see `README.md` → "Run it 24/7").

## Notes

- If you are **not** AgentRoom's owner, set `OWNER_ID=<your user ID>` in `.env`.
- I also created a throwaway server **"herdr-control"** earlier before you said
  to use AgentRoom — you can delete it; nothing uses it.
- Security: the browser's remote-debugging port was **closed** after setup;
  Brave is running normally again.
