// ci-watch.js — push GitHub CI results into each project's channel.
//
// gh has no event stream, so this polls. It is deliberately quiet: a run is
// announced once, and only when it finishes. Successes are announced only if
// they follow a failure (a green run after red is news; the twentieth green in
// a row is not).

const gh = require('./github');

const POLL_MS = Number(process.env.CI_POLL_MS || 180000); // 3 min

class CIWatch {
  constructor({ sync, store, log = console }) {
    this.sync = sync;
    this.store = store;
    this.log = log;
    this.timer = null;
    this.seen = new Map(); // repo -> last announced run id
    this.lastState = new Map(); // repo -> 'success' | 'failure'
    this.repoFor = new Map(); // projectKey -> repo slug (or null)
  }

  async start() {
    if (!(await gh.isAvailable())) {
      this.log.info?.('[ci] gh is not authenticated — CI watch disabled');
      return false;
    }
    const persisted = this.store?.getMeta?.('ciSeen') || {};
    for (const [k, v] of Object.entries(persisted)) this.seen.set(k, v);
    const states = this.store?.getMeta?.('ciState') || {};
    for (const [k, v] of Object.entries(states)) this.lastState.set(k, v);

    await this.poll().catch((e) => this.log.error('[ci] first poll failed:', e.message));
    this.timer = setInterval(() => {
      this.poll().catch((e) => this.log.error('[ci] poll failed:', e.message));
    }, POLL_MS);
    this.log.info?.(`[ci] watching (every ${Math.round(POLL_MS / 1000)}s)`);
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (!this.sync?.channels?.size) return;

    for (const [projectKey, channelId] of this.sync.channels) {
      let repo = this.repoFor.get(projectKey);
      if (repo === undefined) {
        repo = await gh.repoForDir(projectKey).catch(() => null);
        this.repoFor.set(projectKey, repo);
      }
      if (!repo) continue;

      let runs;
      try {
        runs = await gh.listRuns(repo, { limit: 5 });
      } catch {
        continue; // a repo we cannot read is not worth retrying loudly
      }
      const latest = runs.find((r) => r.status === 'completed');
      if (!latest) continue;

      const already = this.seen.get(repo);
      if (already === latest.id) continue; // nothing new since last time
      const previous = this.lastState.get(repo);
      this.seen.set(repo, latest.id);
      this.lastState.set(repo, latest.conclusion);
      this.store?.setMeta?.('ciSeen', Object.fromEntries(this.seen));
      this.store?.setMeta?.('ciState', Object.fromEntries(this.lastState));

      // First sighting of a repo just establishes a baseline — announcing it
      // would spam every channel on the first boot.
      if (already === undefined) continue;

      const failed = latest.conclusion === 'failure';
      const recovered = !failed && previous === 'failure';
      if (!failed && !recovered) continue;

      const channel = await this.sync.guild?.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      await channel
        .send({
          content:
            (failed
              ? `❌ **CI failed** on \`${latest.branch}\``
              : `✅ **CI recovered** on \`${latest.branch}\``) +
            `\n${gh.runLine(latest)}`,
          allowedMentions: { parse: [] },
        })
        .catch((e) => this.log.error('[ci] send failed:', e.message));
      this.log.info?.(`[ci] announced ${latest.conclusion} for ${repo}`);
    }
  }
}

module.exports = { CIWatch };
