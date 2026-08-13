// sync.js — mirrors herdr's live state into Discord.
//
// Mapping:
//   herdr workspace  ->  a Discord text channel  (#ws-<id> under a category)
//   herdr agent/pane ->  a thread inside that channel
//
// Each agent's thread carries its status in the thread name, receives a message
// on every status transition, and (when the agent settles) a tail of its
// terminal output. Typing a plain message in an agent's thread sends that text
// to the agent as a prompt — the thread becomes the agent's console.

const {
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageType,
} = require('discord.js');
const { execFile } = require('node:child_process');
const herdr = require('./herdr');
const { Dashboard } = require('./dashboard');
const { extractAnswer } = require('./answer');

// Always-available controls, pinned in each agent's thread. Blocked agents get
// the answer buttons below; these work at any time, so a running agent can be
// interrupted without waiting for it to ask something.
function agentControls(paneId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`interrupt:${paneId}`)
      .setLabel('Interrupt')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`approve:${paneId}`)
      .setLabel('Enter')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`read:${paneId}`)
      .setLabel('Read output')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`status:${paneId}`)
      .setLabel('Status')
      .setEmoji('🔎')
      .setStyle(ButtonStyle.Secondary),
  );
}

// Buttons attached to a blocked agent so it can be answered from Discord.
function blockedActions(paneId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${paneId}`)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny:${paneId}`)
      .setLabel('Deny')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`interrupt:${paneId}`)
      .setLabel('Interrupt')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`read:${paneId}`)
      .setLabel('Read output')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Primary),
  );
}

const STATUS_EMOJI = {
  idle: '🟢',
  working: '🟡',
  blocked: '🔴',
  done: '✅',
  unknown: '⚪',
};

const STATUS_COLOR = {
  idle: 0x5865f2,
  working: 0xfaa61a,
  blocked: 0xed4245,
  done: 0x57f287,
  unknown: 0x99aab5,
};

// Statuses worth pushing an output tail for (the agent has settled).
const SETTLED = new Set(['idle', 'done', 'blocked']);

function clampName(s, max = 100) {
  const clean = String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    // strip control chars + the spinner glyphs herdr puts in titles
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧◐◑◒◓✳]/g, '')
    .trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function codeBlock(text, max = 1850) {
  let body = String(text || '');
  if (body.length > max) body = body.slice(-max); // keep the tail
  body = body.replace(/```/g, '`​``');
  return '```\n' + (body.trim() || '(no output)') + '\n```';
}

// Keep a real final answer within Discord's 2,000-character message limit.
// Prefer a word boundary when truncating so Markdown stays as readable as the
// terminal capture allowed it to be.
function answerText(text, max = 1850) {
  const body = String(text || '').trim();
  if (body.length <= max) return body;
  const cut = body.lastIndexOf(' ', max - 1);
  return `${body.slice(0, cut > max * 0.6 ? cut : max - 1).trimEnd()}…`;
}

function threadName(a) {
  const emoji = STATUS_EMOJI[a.status] || '⚪';
  const label = clampName(a.title) || a.cwd.split('/').pop() || a.paneId;
  return clampName(`${emoji} ${a.paneId} · ${label}`);
}

function channelNameForWorkspace(wsId, agents) {
  // Name the channel after the common project dir when we can infer one.
  const dirs = agents.map((a) => a.cwd.split('/').filter(Boolean).pop()).filter(Boolean);
  const common = dirs.length && dirs.every((d) => d === dirs[0]) ? dirs[0] : null;
  const base = common ? `${common}-${wsId}` : `workspace-${wsId}`;
  return clampName(base.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), 90);
}

class Sync {
  constructor({ client, guildId, store, categoryName = 'herdr', log = console }) {
    this.client = client;
    this.guildId = guildId;
    this.store = store;
    this.categoryName = categoryName;
    this.log = log;
    this.timer = null;
    this.prev = new Map(); // paneId -> status
    this.threads = new Map(); // paneId -> threadId
    this.channels = new Map(); // workspaceId -> channelId
    this.running = false;
    this.names = new Map(); // paneId -> last thread name we set
    this.outputMsg = new Map(); // paneId -> id of its live output message
    this.outputText = new Map(); // paneId -> last body we rendered
    this.outLines = new Map(); // paneId -> last snapshot lines (for diffing)
    this.outBuf = new Map(); // paneId -> { id, text } message being appended to
    this.outputAt = new Map(); // paneId -> last edit time (throttle)
    this.outputPending = new Set(); // panes with a flush already scheduled
    this.outputThrottleMs = Number(process.env.OUTPUT_THROTTLE_MS || 2000);
    this.outputLines = Number(process.env.OUTPUT_LINES || 25);
    this.typing = new Set(); // paneIds currently shown as "typing"
    this.typingTimer = null;
    this.projectKeys = new Map(); // cwd -> git root (project identity)
    this.lastKeepAlive = 0; // last un-archive sweep
    this.keepAliveMs = Number(process.env.KEEPALIVE_MS || 300000); // 5 min
    this.parts = new Map(); // paneId -> last transcript part number
    this.renaming = new Set(); // panes with a rename in flight
    this.renameWant = new Map(); // paneId -> latest name we want
    this.replyTo = new Map(); // paneId -> message id to reply to (a question)
    this.answers = new Map(); // paneId -> most recently posted final answer
    this.answerLines = Math.min(Math.max(Number(process.env.ANSWER_LINES || 120), 1), 200);
    this.panelMsg = new Map(); // channelId -> its live panel message id
    this.panelSig = new Map(); // channelId -> last rendered signature
    this.swept = new Set(); // channels already cleaned of system noise
    this.events = null; // herdr event stream, when available
    this.inFlight = null; // in-progress tick, so bursts coalesce
    this.pending = false; // a change arrived while a tick was running
  }

  async start(intervalMs = 5000) {
    this.guild = await this.client.guilds.fetch(this.guildId);
    await this.#loadPersisted();
    this.running = true;
    // Prime in the background: the first pass walks every workspace and thread
    // and can take ~30s on a busy herdr. Awaiting it here would delay the event
    // subscription (and the rest of startup) for no benefit.
    this.tick().catch((e) => this.log.error('[sync] initial sync failed:', e.message));

    // Real-time path: herdr exposes an event stream over its unix socket, so
    // status changes land instantly instead of waiting for the next poll. The
    // interval below stays on as a slow safety net (and covers stream loss).
    try {
      const { createHerdrEvents } = require('./herdr-events');
      this.events = createHerdrEvents({ pollMs: intervalMs });
      const onChange = () => {
        this.tick().catch((e) => this.log.error('[sync] event tick failed:', e.message));
      };
      this.events.on('agent-status', onChange);
      this.events.on('agent-added', onChange);
      this.events.on('agent-removed', onChange);
      // New terminal output — stream it to the agent's thread as it happens,
      // independent of status. An agent that keeps working never transitions,
      // so status alone would never surface its output.
      this.events.on('agent-output', (a) => {
        this.streamOutput(a).catch((e) => this.log.error('[sync] output stream:', e.message));
      });
      this.events.on('stream-open', () => this.log.info?.('[sync] herdr event stream connected'));
      this.events.on('stream-closed', (i) =>
        this.log.info?.(`[sync] herdr event stream closed (${i?.reason || 'unknown'}) — polling`),
      );
      this.events.on('error', (e) => this.log.error('[sync] events:', e.message));
      await this.events.start();
      this.log.info?.(
        `[sync] events started (streaming=${this.events.isStreaming?.() ? 'yes' : 'no'})`,
      );
    } catch (e) {
      this.log.error('[sync] event stream unavailable, polling only:', e.message);
      this.events = null;
    }

    // Safety-net poll: slower when the live stream is healthy.
    const netMs = this.events?.isStreaming?.() ? Math.max(intervalMs * 6, 30000) : intervalMs;
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.error('[sync] tick error:', e.message));
    }, netMs);
    this.log.info?.(`[sync] started (safety poll ${netMs}ms)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
    this.typing.clear();
    try {
      this.events?.stop?.();
    } catch {
      /* ignore */
    }
    this.events = null;
  }

  async #loadPersisted() {
    if (!this.store) return;
    try {
      for (const { paneId, threadId } of this.store.allAgentThreads?.() || []) {
        this.threads.set(paneId, threadId);
      }
      const st = this.store.getMeta?.('statuses') || {};
      for (const [k, v] of Object.entries(st)) this.prev.set(k, v);
      const nm = this.store.getMeta?.('threadNames') || {};
      for (const [k, v] of Object.entries(nm)) this.names.set(k, v);
      const om = this.store.getMeta?.('outputMsgs') || {};
      for (const [k, v] of Object.entries(om)) this.outputMsg.set(k, v);
      const pm = this.store.getMeta?.('panelMsgs') || {};
      for (const [k, v] of Object.entries(pm)) this.panelMsg.set(k, v);
      const pt = this.store.getMeta?.('parts') || {};
      for (const [k, v] of Object.entries(pt)) this.parts.set(k, v);
    } catch (e) {
      this.log.error('[sync] could not load state:', e.message);
    }
  }

  #persist() {
    if (!this.store) return;
    try {
      for (const [paneId, threadId] of this.threads) {
        this.store.setThreadForAgent?.(paneId, threadId);
      }
      this.store.setMeta?.('statuses', Object.fromEntries(this.prev));
      this.store.setMeta?.('threadNames', Object.fromEntries(this.names));
      this.store.setMeta?.('parts', Object.fromEntries(this.parts));
    } catch (e) {
      this.log.error('[sync] persist failed:', e.message);
    }
  }

  async #ensureCategory() {
    const chans = await this.guild.channels.fetch();
    let cat = chans.find(
      (c) => c && c.type === ChannelType.GuildCategory && c.name === this.categoryName,
    );
    if (!cat) {
      cat = await this.guild.channels.create({
        name: this.categoryName,
        type: ChannelType.GuildCategory,
      });
    }
    return cat;
  }

  // A project is identified by its git root, so agents working in different
  // subdirectories of one repo still share a channel. Falls back to the cwd for
  // non-git directories. Cached: this shells out.
  async #projectKey(cwd) {
    if (!cwd) return 'unknown';
    if (this.projectKeys.has(cwd)) return this.projectKeys.get(cwd);
    const key = await new Promise((resolve) => {
      execFile(
        'git',
        ['-C', cwd, 'rev-parse', '--show-toplevel'],
        { timeout: 5000 },
        (err, stdout) => resolve(err ? cwd : stdout.trim() || cwd),
      );
    });
    this.projectKeys.set(cwd, key);
    return key;
  }

  async #ensureProjectChannel(projectKey, agents) {
    const cached = this.channels.get(projectKey);
    if (cached) {
      const ch = await this.guild.channels.fetch(cached).catch(() => null);
      if (ch) return ch;
      this.channels.delete(projectKey);
    }
    const persisted = this.store?.getChannelForWorkspace?.(projectKey);
    if (persisted) {
      const ch = await this.guild.channels.fetch(persisted).catch(() => null);
      if (ch) {
        this.channels.set(projectKey, ch.id);
        return ch;
      }
    }

    const name = clampName(
      (projectKey.split('/').filter(Boolean).pop() || 'project')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-'),
      90,
    );

    const all = await this.guild.channels.fetch();
    let ch = all.find((c) => c && c.type === ChannelType.GuildText && c.name === name);

    // Adopt a channel left over from the old per-workspace naming
    // ("opal-wt") instead of creating a duplicate beside it. Prefer the one
    // that already holds the most threads so the most history survives.
    if (!ch) {
      const cat = await this.#ensureCategory();
      const legacyRe = new RegExp(`^${name}-[a-z0-9]{1,3}$`, 'i');
      const legacy = [...all.values()].filter(
        (c) =>
          c &&
          c.type === ChannelType.GuildText &&
          c.parentId === cat.id &&
          legacyRe.test(c.name),
      );
      if (legacy.length) {
        let best = legacy[0];
        let bestCount = -1;
        for (const c of legacy) {
          const t = await c.threads.fetch().catch(() => null);
          const n = t ? t.threads.size : 0;
          if (n > bestCount) {
            bestCount = n;
            best = c;
          }
        }
        ch = await best.setName(name).catch(() => best);
        this.log.info?.(`[sync] adopted ${legacy.length} legacy channel(s) as #${name}`);
      }
    }

    if (!ch) {
      const cat = await this.#ensureCategory();
      ch = await this.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: cat.id,
        topic: `${projectKey} — one thread per agent. Type in a thread to prompt that agent.`,
      });
      this.log.info?.(`[sync] created channel #${name} for ${projectKey}`);
    }

    this.channels.set(projectKey, ch.id);
    this.store?.setChannelForWorkspace?.(projectKey, ch.id);
    return ch;
  }

  async #ensureWorkspaceChannel(wsId, agents) {
    if (this.channels.has(wsId)) {
      const cached = await this.guild.channels.fetch(this.channels.get(wsId)).catch(() => null);
      if (cached) return cached;
      this.channels.delete(wsId);
    }
    const persisted = this.store?.getChannelForWorkspace?.(wsId);
    if (persisted) {
      const ch = await this.guild.channels.fetch(persisted).catch(() => null);
      if (ch) {
        this.channels.set(wsId, ch.id);
        return ch;
      }
    }

    const name = channelNameForWorkspace(wsId, agents);
    const all = await this.guild.channels.fetch();
    let ch = all.find((c) => c && c.type === ChannelType.GuildText && c.name === name);
    if (!ch) {
      const cat = await this.#ensureCategory();
      ch = await this.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: cat.id,
        topic: `herdr workspace ${wsId} — one thread per agent. Type in a thread to prompt that agent.`,
      });
      this.log.info?.(`[sync] created channel #${name} for workspace ${wsId}`);
    }
    this.channels.set(wsId, ch.id);
    this.store?.setChannelForWorkspace?.(wsId, ch.id);
    return ch;
  }

  async #ensureThread(channel, agent) {
    const existingId = this.threads.get(agent.paneId);
    if (existingId) {
      const t = await channel.threads.fetch(existingId).catch(() => null);
      if (t) {
        if (t.archived) await t.setArchived(false).catch(() => {});
        // Clear any rename notices that accumulated before this run.
        if (!this.swept.has(t.id)) {
          this.swept.add(t.id);
          this.#sweepRenames(t).catch(() => {});
        }
        return t;
      }
      this.threads.delete(agent.paneId);
    }

    const thread = await channel.threads.create({
      name: threadName(agent),
      autoArchiveDuration: 10080, // 7 days
      reason: `herdr agent ${agent.paneId}`,
    });
    this.threads.set(agent.paneId, thread.id);
    this.store?.setThreadForAgent?.(agent.paneId, thread.id);

    await thread
      .send({
        embeds: [this.#agentEmbed(agent, 'Thread opened for this agent')],
        content:
          '💬 **Type any message here to send it as a prompt to this agent.** ' +
          'Prefix with `//` to leave a note without prompting.',
        components: [agentControls(agent.paneId)],
      })
      .then((m) => m.pin().catch(() => {}))
      .catch((e) => this.log.error('[sync] intro send failed:', e.message));

    this.log.info?.(`[sync] created thread for ${agent.paneId}`);
    return thread;
  }

  #agentEmbed(a, note) {
    const e = STATUS_EMOJI[a.status] || '⚪';
    const embed = new EmbedBuilder()
      .setTitle(`${e} ${clampName(a.title) || a.paneId}`)
      .setColor(STATUS_COLOR[a.status] ?? 0x99aab5)
      .addFields(
        { name: 'Pane', value: `\`${a.paneId}\``, inline: true },
        { name: 'Agent', value: a.agent || '—', inline: true },
        { name: 'Status', value: a.status || 'unknown', inline: true },
        { name: 'CWD', value: a.cwd || '—' },
      );
    if (note) embed.setFooter({ text: note });
    return embed;
  }

  // Events can arrive in bursts; never let two ticks interleave or we'd race on
  // thread creation. Concurrent callers share the in-flight run, then one
  // follow-up run covers anything that changed while it was busy.
  async tick() {
    if (!this.running) return;
    if (this.inFlight) {
      this.pending = true;
      return this.inFlight;
    }
    this.inFlight = this.#tickOnce()
      .catch((e) => {
        this.log.error('[sync] tick failed:', e.message);
      })
      .finally(() => {
        this.inFlight = null;
        if (this.pending) {
          this.pending = false;
          setTimeout(() => this.tick().catch(() => {}), 50);
        }
      });
    return this.inFlight;
  }

  async #tickOnce() {
    if (!this.running) return;
    // Phase timings, so a pass that stalls says where rather than going silent.
    const t0 = Date.now();
    const trace = (msg) => {
      if (process.env.SYNC_TRACE === '1') this.log.info?.(`[sync] ${Date.now() - t0}ms ${msg}`);
    };
    const agents = await herdr.listAgents();
    trace(`listAgents ${agents.length}`);
    const seen = new Set();

    // Group by PROJECT, not workspace. One project routinely spans several
    // herdr workspaces (Opal sits in wS and wT), and a channel per workspace
    // splits one project's agents across duplicate channels.
    const byProject = new Map();
    for (const a of agents) {
      seen.add(a.paneId);
      const key = await this.#projectKey(a.cwd);
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(a);
    }

    trace(`grouped into ${byProject.size} projects`);

    for (const [projectKey, list] of byProject) {
      let channel;
      try {
        channel = await this.#ensureProjectChannel(projectKey, list);
        trace(`channel ready ${projectKey}`);
      } catch (e) {
        this.log.error(`[sync] channel for ${projectKey} failed:`, e.message);
        continue;
      }

      // Clean the channel body once per run, then keep its panel current.
      if (!this.swept.has(channel.id)) {
        this.swept.add(channel.id);
        await this.#sweepNoise(channel);
      }

      for (const a of list) {
        // Keep the typing indicator in step with the agent, every pass.
        this.setTyping(a.paneId, a.status === 'working');

        const prev = this.prev.get(a.paneId);
        // Titles change independently of status (agents rename themselves as
        // they move between tasks), so track both or thread names go stale.
        const want = threadName(a);
        const nameDrifted = this.names.get(a.paneId) !== want;
        if (prev === a.status && !nameDrifted) continue; // nothing changed

        try {
          const thread = await this.#ensureThread(channel, a);

          // Keep the sidebar honest even when only the title moved.
          if (nameDrifted) {
            if (thread.name !== want) await thread.setName(want).catch(() => {});
            this.names.set(a.paneId, want);
          }

          if (prev === a.status) {
            continue; // title-only update; no transition message
          }

          if (prev !== undefined) {
            const pe = STATUS_EMOJI[prev] || '⚪';
            const ce = STATUS_EMOJI[a.status] || '⚪';
            // A blocked agent is waiting on a human — give it answer buttons.
            await thread.send({
              content: `${pe} → ${ce} **${a.status}**${prev ? ` (was ${prev})` : ''}`,
              components: a.status === 'blocked' ? [blockedActions(a.paneId)] : [],
            });
            // Rename the thread so the sidebar reflects live status — but never
            // await it. Discord allows only ~2 thread renames per 10 minutes,
            // and discord.js waits out that limit, which would hold up this
            // agent's status messages behind a purely cosmetic change.
            if (thread.name !== want) this.#renameLater(thread, want, a.paneId);
          }
          // On settle, make sure the live output message reflects the final
          // state. Streaming already keeps it current mid-run, so this just
          // forces one last refresh rather than posting a duplicate block.
          if (SETTLED.has(a.status) && prev !== undefined) {
            this.outputAt.delete(a.paneId); // bypass the throttle
            await this.streamOutput(a).catch(() => {});
            await this.#postAnswer(a, thread);
          }
          this.prev.set(a.paneId, a.status);
        } catch (e) {
          this.log.error(`[sync] agent ${a.paneId} update failed:`, e.message);
        }
      }

      // The channel's own index, refreshed after its agents are settled.
      await this.#renderPanel(channel, projectKey, list).catch(() => {});
      trace(`panel done ${projectKey}`);
    }
    trace('all projects done');

    // agents that disappeared
    for (const paneId of Array.from(this.prev.keys())) {
      if (seen.has(paneId)) continue;
      const threadId = this.threads.get(paneId);
      if (threadId) {
        const t = await this.guild.channels.fetch(threadId).catch(() => null);
        if (t) {
          await t.send({ content: '⚫ Agent is gone (pane closed).' }).catch(() => {});
          await t.setArchived(true).catch(() => {});
        }
      }
      this.prev.delete(paneId);
      this.threads.delete(paneId);
      this.names.delete(paneId);
      this.outputMsg.delete(paneId);
      this.outputText.delete(paneId);
      this.outputAt.delete(paneId);
      this.typing.delete(paneId);
      this.answers.delete(paneId);
      this.store?.deleteThreadForAgent?.(paneId);
    }

    // Discord archives a thread after 7 days without activity — and 7 days is
    // its maximum. Most agents sit idle, so without this their threads quietly
    // drop out of the sidebar and the panel decays with no error anywhere.
    // Keep every live agent's thread un-archived.
    trace('starting keepAlive');
    await this.#keepThreadsAlive(seen);
    trace('keepAlive done');

    // Refresh the live panel with the full picture.
    if (this.dashboard) {
      await this.dashboard.render(agents, this.threads).catch(() => {});
    }

    this.#persist();
  }

  // Discord posts a "started a thread" system message for every thread created.
  // With one thread per agent that is the entire channel body — pure noise that
  // also survives the thread being deleted. Sweep it so the channel holds only
  // the live panel.
  async #sweepNoise(channel) {
    try {
      const msgs = await channel.messages.fetch({ limit: 50 });
      const junk = msgs.filter(
        (m) => m.type === MessageType.ThreadCreated && m.id !== this.panelMsg.get(channel.id),
      );
      for (const [, m] of junk) await m.delete().catch(() => {});
      if (junk.size) this.log.info?.(`[sync] swept ${junk.size} thread-created notices`);
    } catch (e) {
      this.log.error('[sync] sweep failed:', e.message);
    }
  }

  // Un-archive threads whose agent is still alive. Checked at most once every
  // few minutes: archiving is a 7-day clock, so this never needs to be eager,
  // and each check costs an API call per thread.
  async #keepThreadsAlive(livePanes) {
    const now = Date.now();
    if (now - this.lastKeepAlive < this.keepAliveMs) return;
    this.lastKeepAlive = now;

    let revived = 0;
    for (const paneId of livePanes) {
      const threadId = this.threads.get(paneId);
      if (!threadId) continue;
      try {
        const t = await this.guild.channels.fetch(threadId).catch(() => null);
        if (t?.archived) {
          await t.setArchived(false);
          revived++;
        }
      } catch {
        /* a thread we cannot revive is picked up on the next pass */
      }
    }
    if (revived) this.log.info?.(`[sync] un-archived ${revived} live agent threads`);
  }

  // Rename a thread out of band. Only the newest requested name matters, so a
  // rename already in flight for this pane is simply superseded — that keeps us
  // from spending the scarce rename budget on stale intermediate states.
  #renameLater(thread, want, paneId) {
    this.renameWant.set(paneId, want);
    if (this.renaming.has(paneId)) return;
    this.renaming.add(paneId);

    (async () => {
      try {
        // Let rapid transitions settle before spending a rename.
        await new Promise((r) => setTimeout(r, 1500));
        const target = this.renameWant.get(paneId);
        if (!target || thread.name === target) return;
        await thread.setName(target);
        this.names.set(paneId, target);
        await this.#sweepRenames(thread);
      } catch {
        // Rate limited or gone: drop the recorded name so a later tick retries.
        this.names.delete(paneId);
      } finally {
        this.renaming.delete(paneId);
      }
    })();
  }

  // Remove the "changed the channel name" notices Discord posts inside a thread
  // each time we rename it to reflect status.
  async #sweepRenames(thread) {
    try {
      const msgs = await thread.messages.fetch({ limit: 25 });
      const junk = msgs.filter((m) => m.type === MessageType.ChannelNameChange);
      for (const [, m] of junk) await m.delete().catch(() => {});
    } catch {
      /* best effort — never block a status update on cosmetics */
    }
  }

  // One embed per workspace channel, edited in place: the channel's own live
  // index of its agents, so the channel body reads as a panel not a log.
  async #renderPanel(channel, projectKey, agents) {
    const rank = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
    const sorted = [...agents].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    const gid = this.guild.id;

    const lines = sorted.map((a) => {
      const e = STATUS_EMOJI[a.status] || '⚪';
      const tid = this.threads.get(a.paneId);
      const label = clampName(a.title, 46) || a.cwd.split('/').pop();
      const link = tid
        ? `[\`${a.paneId}\`](https://discord.com/channels/${gid}/${tid})`
        : `\`${a.paneId}\``;
      // Several workspaces can feed one project, so show which one an agent
      // lives in — otherwise two identical rows are indistinguishable.
      return `${e} ${link} · ${label} · \`${a.workspaceId}\``;
    });

    const counts = sorted.reduce((m, a) => ((m[a.status] = (m[a.status] || 0) + 1), m), {});
    const project = projectKey.split('/').filter(Boolean).pop() || 'project';
    const workspaces = [...new Set(sorted.map((a) => a.workspaceId))];
    const color = counts.blocked ? 0xed4245 : counts.working ? 0xfaa61a : 0x57f287;

    const embed = new EmbedBuilder()
      .setTitle(`${project} · ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`)
      .setDescription(lines.join('\n') || '_no agents_')
      .setColor(color)
      .setFooter({
        text: `${sorted.length} agents · open a thread and type to prompt that agent`,
      });

    const sig = lines.join('|') + color;
    if (this.panelSig.get(channel.id) === sig) return;
    this.panelSig.set(channel.id, sig);

    try {
      const existing = this.panelMsg.get(channel.id);
      if (existing) {
        const msg = await channel.messages.fetch(existing).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          return;
        }
        this.panelMsg.delete(channel.id);
      }
      const msg = await channel.send({ embeds: [embed] });
      this.panelMsg.set(channel.id, msg.id);
      this.store?.setMeta?.('panelMsgs', Object.fromEntries(this.panelMsg));
      await msg.pin().catch(() => {});
    } catch (e) {
      this.log.error(`[sync] panel for ${wsId} failed:`, e.message);
    }
  }

  // Discord's typing indicator lasts ~10s, so it has to be re-sent on a timer
  // for as long as the agent is still working. The effect is that a busy agent
  // shows "agent_bot is typing…" in its thread, exactly like a person writing.
  #startTypingLoop() {
    if (this.typingTimer) return;
    const pulse = async () => {
      for (const paneId of this.typing) {
        const threadId = this.threads.get(paneId);
        if (!threadId) continue;
        try {
          const t = await this.guild.channels.fetch(threadId).catch(() => null);
          if (t && !t.archived) await t.sendTyping().catch(() => {});
        } catch {
          /* a failed indicator is never worth surfacing */
        }
      }
    };
    this.typingTimer = setInterval(() => {
      pulse().catch(() => {});
    }, 8000);
    pulse().catch(() => {});
  }

  // Called whenever an agent's status is known; drives the indicator on/off.
  setTyping(paneId, isWorking) {
    if (isWorking) {
      this.typing.add(paneId);
      this.#startTypingLoop();
    } else {
      this.typing.delete(paneId);
    }
  }

  // Agent TUIs repaint their whole screen: a spinner, elapsed time, token
  // counters, the input box and the status bar all change every frame. Left in,
  // no two reads ever match and every frame looks like new output. Strip that
  // chrome so only real transcript lines are compared and posted.
  static isChrome(line) {
    const s = line.trim();
    if (!s) return true;
    if (/^[\s─-╿_=~-]+$/.test(s)) return true; // rules / box drawing
    if (/^[❯>»]\s*$/.test(s)) return true; // empty input prompt
    if (/esc to interrupt|shift\+tab|bypass permissions|auto mode on|for agents/i.test(s)) {
      return true; // status bar
    }
    if (/^[✻✳✽◐◑◒◓⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧*+]\s/.test(s) && /tokens?\)/i.test(s)) return true; // spinner
    if (/\(\s*\d+[hms].*?(tokens|esc)\b/i.test(s)) return true; // "(1m 50s · ↓ 6.0k tokens)"
    if (/^Tip: Use|^⎿\s+Tip: Use/i.test(s)) return true; // rotating tips
    return false;
  }

  static stripChrome(lines) {
    return lines.filter((l) => !Sync.isChrome(l));
  }

  // Terminal reads return a rolling window of recent lines, not a feed of new
  // ones, so consecutive reads overlap heavily. Find the longest suffix of what
  // we already emitted that prefixes the new snapshot; everything past it is
  // genuinely new. Falls back to "all of it" when the windows don't overlap
  // (the agent scrolled further than one window between reads).
  static delta(prevLines, nextLines) {
    if (!prevLines.length) return nextLines;
    const max = Math.min(prevLines.length, nextLines.length);
    for (let k = max; k > 0; k--) {
      let match = true;
      for (let i = 0; i < k; i++) {
        if (prevLines[prevLines.length - k + i] !== nextLines[i]) {
          match = false;
          break;
        }
      }
      if (match) return nextLines.slice(k);
    }
    return nextLines;
  }

  // Stream an agent's terminal output into its thread as an append-only
  // transcript: new lines are appended to the current message until it nears
  // Discord's 2000-char limit, then a fresh message continues the log. This
  // keeps full history instead of overwriting a single window.
  async streamOutput(agent) {
    const paneId = agent.paneId;
    if (!this.running) return;

    const now = Date.now();
    const last = this.outputAt.get(paneId) || 0;
    if (now - last < this.outputThrottleMs) {
      // Coalesce: remember that more output arrived, and flush after the window.
      if (!this.outputPending.has(paneId)) {
        const wait = this.outputThrottleMs - (now - last);
        this.outputPending.add(paneId);
        setTimeout(() => {
          this.outputPending.delete(paneId);
          this.streamOutput(agent).catch(() => {});
        }, Math.max(wait, 250));
      }
      return;
    }
    this.outputAt.set(paneId, now);

    const threadId = this.threads.get(paneId);
    if (!threadId) return; // no thread yet; the next tick will create one

    let text;
    try {
      text = await herdr.readAgent(paneId, this.outputLines);
    } catch {
      return;
    }
    if (!text || !text.trim()) return;

    // Compare only real transcript lines, never the repainting TUI chrome.
    const nextLines = Sync.stripChrome(text.replace(/\s+$/, '').split('\n'));
    if (!nextLines.length) return;
    const prevLines = this.outLines.get(paneId) || [];
    const fresh = Sync.delta(prevLines, nextLines);
    if (!fresh.length) return;
    this.outLines.set(paneId, nextLines);

    const addition = fresh.join('\n');

    try {
      const thread = await this.guild.channels.fetch(threadId).catch(() => null);
      if (!thread) return;
      if (thread.archived) await thread.setArchived(false).catch(() => {});

      // Each post is numbered and labelled, so a long run reads as a thread of
      // parts rather than an anonymous wall of code blocks.
      const project = agent.cwd?.split('/').filter(Boolean).pop() || agent.workspaceId;
      const header = (n) =>
        `${STATUS_EMOJI[agent.status] || '⚪'} \`${paneId}\` · **${project}** · part ${n}\n`;

      const buf = this.outBuf.get(paneId);
      const budget = 1900;
      const fits =
        buf && header(buf.part).length + buf.text.length + addition.length + 10 < budget;

      if (fits) {
        const msg = await thread.messages.fetch(buf.id).catch(() => null);
        if (msg) {
          const merged = `${buf.text}\n${addition}`;
          await msg.edit({ content: header(buf.part) + codeBlock(merged, budget - 120) });
          this.outBuf.set(paneId, { ...buf, text: merged });
          return;
        }
        this.outBuf.delete(paneId); // message vanished; start a new one
      }

      // Start a new part: either the first, or the previous one filled up.
      // Numbering continues across restarts so a transcript does not reset to
      // "part 1" every redeploy.
      const part = (buf?.part ?? this.parts.get(paneId) ?? 0) + 1;
      this.parts.set(paneId, part);
      const body = addition.length > 1700 ? addition.slice(-1700) : addition;

      const payload = { content: header(part) + codeBlock(body, budget - 120) };
      const msg = await thread.send(payload);
      this.outBuf.set(paneId, { id: msg.id, text: body, part });
      this.outputMsg.set(paneId, msg.id);
      this.store?.setMeta?.('outputMsgs', Object.fromEntries(this.outputMsg));
    } catch (e) {
      this.log.error(`[sync] live output for ${paneId} failed:`, e.message);
    }
  }

  // A terminal transcript is useful for diagnosis, but it is not a chat
  // reply: tool cards, spinners and diffs overwhelm the one thing a human
  // asked for. On a settled turn, extract and post only the agent's final
  // prose. The raw stream above remains in the thread for full context.
  async #postAnswer(agent, thread) {
    let terminal;
    try {
      terminal = await herdr.readAgent(agent.paneId, this.answerLines);
    } catch {
      return;
    }

    const result = extractAnswer(terminal, { agent: agent.agent });
    const body = answerText(result.answer);
    if (!body || result.kind !== 'prose') return;
    if (this.answers.get(agent.paneId) === body) return;

    const payload = {
      content: `🤖 **${clampName(agent.title) || agent.paneId}**\n${body}`,
      // A model may mention @everyone or a role in its final answer. Never
      // turn terminal text into a notification.
      allowedMentions: { parse: [] },
    };
    const answering = this.replyTo.get(agent.paneId);
    if (answering) {
      payload.reply = { messageReference: answering, failIfNotExists: false };
    }

    try {
      await thread.send(payload);
      this.answers.set(agent.paneId, body);
      if (answering) this.replyTo.delete(agent.paneId);
    } catch (e) {
      this.log.error(`[sync] final answer for ${agent.paneId} failed:`, e.message);
    }
  }

  // Attach the live dashboard to a channel (normally #agent-control).
  attachDashboard(channel) {
    this.dashboard = new Dashboard({ channel, store: this.store, log: this.log });
  }

  // Remember that this Discord message asked the agent something, so the reply
  // can be attached to it. Also force the next output through the throttle so
  // the answer appears promptly rather than up to a window later.
  expectReply(paneId, messageId) {
    this.replyTo.set(paneId, messageId);
    this.outputAt.delete(paneId);
  }

  // Is this channel id a thread we own? -> returns the paneId it maps to.
  paneForThread(threadId) {
    for (const [paneId, tid] of this.threads) if (tid === threadId) return paneId;
    return null;
  }
}

module.exports = { Sync, threadName, codeBlock, STATUS_EMOJI, STATUS_COLOR };
