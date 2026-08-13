#!/usr/bin/env bash
# Deploy slash commands, then run the bot. Refuses to start without a token.
set -euo pipefail
cd "$(dirname "$0")"
if grep -q 'paste-bot-token-here' .env 2>/dev/null || ! grep -Eq '^DISCORD_TOKEN=.{20,}$' .env 2>/dev/null; then
  echo "❌ DISCORD_TOKEN is not set in .env. Paste your bot token, then re-run."
  exit 1
fi
echo "→ Registering slash commands to the guild..."
node src/deploy-commands.js
echo "→ Starting bot (Ctrl-C to stop)..."
exec node src/index.js
