// dashboard.js — one message in #agent-control that always shows the whole
// herdr picture. It is edited in place on every change rather than reposted,
// so the channel stays a live panel instead of a scrolling log.

const { EmbedBuilder } = require('discord.js');

const STATUS_EMOJI = {
  idle: '🟢',
  working: '🟡',
  blocked: '🔴',
  done: '✅',
  unknown: '⚪',
};

const RANK = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

function shorten(s, n) {
  const t = String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧◐◑◒◓✳]/g, '')
    .trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function buildEmbed(agents, { threadsByPane = new Map(), stamp, guildId } = {}) {
  const counts = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  for (const a of agents) counts[a.status] = (counts[a.status] || 0) + 1;

  // group by workspace, most urgent workspace first
  const byWs = new Map();
  for (const a of agents) {
    if (!byWs.has(a.workspaceId)) byWs.set(a.workspaceId, []);
    byWs.get(a.workspaceId).push(a);
  }

  const wsBlocks = [...byWs.entries()]
    .map(([wsId, list]) => {
      list.sort((x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9));
      const urgency = Math.min(...list.map((a) => RANK[a.status] ?? 9));
      const project = shorten(list[0].cwd.split('/').filter(Boolean).pop() || wsId, 24);
      const lines = list.map((a) => {
        const e = STATUS_EMOJI[a.status] || '⚪';
        const tid = threadsByPane.get(a.paneId);
        const label = shorten(a.title || a.cwd.split('/').pop(), 42);
        // A <#id> mention renders as "unknown" for threads the reader hasn't
        // joined, so link by URL instead — always shows the pane id and jumps.
        const link =
          tid && guildId
            ? `[\`${a.paneId}\`](https://discord.com/channels/${guildId}/${tid})`
            : `\`${a.paneId}\``;
        return `${e} ${link} · ${label}`;
      });
      return { urgency, text: `**${project}** \`${wsId}\`\n${lines.join('\n')}` };
    })
    .sort((a, b) => a.urgency - b.urgency)
    .map((b) => b.text);

  let desc = wsBlocks.join('\n\n');
  if (desc.length > 3900) desc = desc.slice(0, 3890) + '\n…';

  const headline =
    `${STATUS_EMOJI.blocked} ${counts.blocked || 0} blocked · ` +
    `${STATUS_EMOJI.working} ${counts.working || 0} working · ` +
    `${STATUS_EMOJI.done} ${counts.done || 0} done · ` +
    `${STATUS_EMOJI.idle} ${counts.idle || 0} idle`;

  const color = counts.blocked ? 0xed4245 : counts.working ? 0xfaa61a : 0x57f287;

  return new EmbedBuilder()
    .setTitle(`herdr — ${agents.length} agents`)
    .setDescription(`${headline}\n\n${desc || '_no agents_'}`)
    .setColor(color)
    .setFooter({ text: `updated ${stamp || new Date().toTimeString().slice(0, 8)}` });
}

class Dashboard {
  constructor({ channel, store, log = console }) {
    this.channel = channel;
    this.store = store;
    this.log = log;
    this.messageId = store?.getMeta?.('dashboardMessageId') || null;
    this.last = '';
  }

  async render(agents, threadsByPane) {
    const embed = buildEmbed(agents, {
      threadsByPane,
      guildId: this.channel?.guildId || this.channel?.guild?.id,
    });
    // Skip the API call when nothing visible changed.
    const sig = JSON.stringify(embed.data.description) + embed.data.title;
    if (sig === this.last && this.messageId) return;
    this.last = sig;

    try {
      if (this.messageId) {
        const msg = await this.channel.messages.fetch(this.messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          return;
        }
        this.messageId = null; // it was deleted; fall through and repost
      }
      const msg = await this.channel.send({ embeds: [embed] });
      this.messageId = msg.id;
      this.store?.setMeta?.('dashboardMessageId', msg.id);
      await msg.pin().catch(() => {});
    } catch (e) {
      this.log.error('[dashboard] render failed:', e.message);
    }
  }
}

module.exports = { Dashboard, buildEmbed };
