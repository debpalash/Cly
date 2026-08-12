# The Waves of AI Engineering, Until AGI

**Date:** 2026-08-07 · **Status:** thesis document (companion to the ghostherd design spec)

## The pattern

Every "engineering" discipline of the AI era is a workaround for the frontier
model's current deficiency. Each wave follows the same life cycle:

1. A model deficiency creates a bottleneck.
2. A hand-built discipline emerges to patch it. Tooling explodes; hundreds of
   startups build the wave's tool.
3. The labs absorb the patch into the model or the platform.
4. The discipline's tooling commoditizes to near-zero value; the discipline's
   *accumulated data* keeps its value.
5. The next bottleneck is exposed, one level up.

Two structural facts follow. **The waves are compressing** — prompt
engineering lasted roughly two years, RAG about eighteen months, loop
engineering about a year; later waves will overlap rather than succeed each
other cleanly. And **only substrates survive** — the tool of the current wave
is disposable, but the place where each wave's data accumulates (context,
memory, experience, specs, intent) compounds across waves.

Each wave below is described by the same four fields: the deficiency it
patched, the scarce skill it created, the artifact its practitioners produced,
and what absorbed it.

## Timeline at a glance

| # | Wave | Era (approx.) | Patched deficiency | Absorbed by |
|---|------|---------------|--------------------|-------------|
| 1 | Prompt engineering | 2022–2023 | Models misread intent | Instruction tuning, RLHF |
| 2 | RAG | 2023–2024 | Small context, frozen knowledge | Long context, native retrieval |
| 3 | Loop engineering | 2024–2025 | One-shot, no action | Agentic RL training, thin harnesses |
| 4 | Graph engineering | 2025–2026 (now) | Amnesia, unstructured state | Memory-native models/products (in progress) |
| 5 | Experience engineering | ~2026–2027 | Agents don't improve with use | Continual/online learning (partial) |
| 6 | Verification engineering | ~2027–2028 | Trust doesn't scale with output | Never fully — trust must stay external |
| 7 | Intent engineering | ~2028+ | Specs conform; wants don't | Cannot be absorbed — intent lives in humans |
| 8 | Organization engineering | overlapping 7 | One agent isn't an institution | Cannot be absorbed — it's governance |
| ∞ | The asymptote | — | Accountability, attention, atoms | The AGI boundary |

Dates past wave 5 are directional, not forecasts. Confidence decays roughly
one order of magnitude per row.

## Wave 1 — Prompt engineering (2022–2023)

- **Deficiency patched:** base models completed text instead of following
  intent; small wording changes swung output quality wildly.
- **Scarce skill:** phrasing — incantations, few-shot exemplars, role play,
  chain-of-thought triggers.
- **Artifact:** the prompt. Prompt libraries, prompt marketplaces, "prompt
  engineer" job listings.
- **Absorbed by:** instruction tuning and RLHF. Models learned to want what
  you meant. The residue that survived is not clever phrasing but *clear
  writing* — specification skill, which returns in wave 7 at a higher level.

## Wave 2 — RAG (2023–2024)

- **Deficiency patched:** context windows of 4–32k tokens and a frozen
  knowledge cutoff. The model couldn't see your data.
- **Scarce skill:** retrieval pipelines — chunking strategies, embedding
  model choice, hybrid lexical+semantic search, re-ranking.
- **Artifact:** the vector database and the retrieval pipeline. An entire
  funded industry.
- **Absorbed by:** 200k–1M+ context windows, native retrieval and web search
  built into the platforms, models trained to use search as a tool. Retrieval
  didn't die — it stopped being the product and became a built-in organ. The
  residue: your *corpus* still matters; the pipeline around it doesn't.

## Wave 3 — Loop engineering (2024–2025)

- **Deficiency patched:** models answered once and stopped. No tools, no
  iteration, no recovery from their own errors.
- **Scarce skill:** orchestration — tool schemas, agent loops, retry and
  recovery logic, sub-agent decomposition, harness design.
- **Artifact:** the harness. LangChain-era frameworks, then coding agents
  (Claude Code, Codex, OpenCode, and the hundreds that followed).
- **Absorbed by:** agentic RL training. Labs began training models *on the
  loop itself* — tool use, multi-step planning, and self-correction became
  model capabilities, and harnesses got thin. That thinness is exactly why
  hundreds of near-identical coding agents exist: the hard part moved into
  the weights, so the wrapper commoditized. The residue: tool *design* and
  environment quality still matter; loop control flow doesn't.

## Wave 4 — Graph engineering (2025–2026, the current wave)

- **Deficiency patched:** amnesia. Agents re-derive the same understanding of
  a codebase, a user, an organization — every session, from zero. Context is
  paid for repeatedly and structure is thrown away on exit.
- **Scarce skill:** representation — knowledge graphs, code-intelligence
  graphs (call/reference/import edges), graph+vector hybrid stores,
  incremental indexing, GraphRAG.
- **Artifact:** the graph engine. The current Cambrian explosion is visible
  in this project's own research folder: compass, codeseek, tokensave,
  stack-graphs (code graphs); helix-db, cozo, grafeo, RuVector, FalkorDB
  (graph+vector stores); iwe, cocoindex, graphrag-rs (knowledge pipelines).
- **Will be absorbed by:** memory-native models and platform memory features.
  When "the agent remembers your codebase" is a checkbox on the model
  provider's product page, standalone graph engines commoditize the way
  vector databases did. The residue — and it is the most valuable residue of
  any wave so far — is the *accumulated graph itself*: what your systems are,
  how they connect, what changed and why. Structure is disposable; the
  recorded history is not.

## Wave 5 — Experience engineering (~2026–2027)

- **Deficiency it patches:** agents with memory still don't *improve*.
  Storage is not learning. An agent can recall that a deploy failed last
  Tuesday and still repeat the mistake, because nothing compiled that episode
  into behavior.
- **Scarce skill:** the learning loop on top of storage — compiling episodes
  into reusable skills, evaluating which learned behaviors actually helped,
  pruning what didn't, building a persistent model of the user and the org.
- **Artifact:** the self-improving agent. The earliest shipped example is
  hermes-agent (skills created from experience, self-nudged persistence, a
  deepening user model across sessions); manually-curated skill systems in
  today's coding agents are the human-powered version of the same loop.
- **Absorbed by:** continual and online learning at the model layer —
  partially. Labs will absorb the *mechanism*, but the *content* is private
  by construction: what works in your org, on your codebase, with your
  conventions, cannot be pretrained. This is the first wave whose residue is
  a genuine moat rather than a corpus: **accumulated private experience.**
  Data gravity applies to agents — the agent that has six months of compiled
  experience on your system outperforms a smarter fresh one, and that
  advantage cannot be cloned from GitHub.

## Wave 6 — Verification engineering (~2027–2028)

- **Deficiency it patches:** trust does not scale with output. Every prior
  wave made *generation* cheaper; none made *believing the output* cheaper.
  Fleets of self-improving agents produce more change than humans can review
  line-by-line, and review becomes the binding constraint on everything.
- **Scarce skill:** making correctness checkable — writing properties and
  invariants instead of examples, adversarial checking (agents whose job is
  to break other agents' work), typed contracts at boundaries, proof-carrying
  changes, eval suites as first-class artifacts.
- **Artifact:** the verification harness — the spec plus the machinery that
  proves the spec holds. Precursors are already visible: judge models,
  adversarial multi-agent review, spec-first workflows, evals-as-product.
- **Absorbed by:** never fully, and this is the crucial asymmetry. A model
  attesting to its own output is not verification; trust must be anchored
  outside the thing being trusted. The *labor* of verification automates
  (checker agents, proof search), but the *authority* — deciding what counts
  as correct — cannot move into the same system that generates. Verification
  is the first wave that ends not by absorption but by becoming
  infrastructure, like compilers and type systems before it.

## Wave 7 — Intent engineering (~2028 onward)

- **Deficiency it patches:** verification proves the system conforms to
  intent-as-written; nothing proves intent-as-written matches
  intent-as-meant. This is the requirements problem, and it is also the
  outer-alignment problem wearing work clothes. Its failure mode has a name:
  Goodhart — the monstrous thing that satisfies the spec literally.
- **Scarce skill:** judgment — eliciting real goals from vague wants,
  red-teaming specs before any code exists ("what horrible system passes this
  spec?"), encoding taste and trade-offs that previously lived implicitly in
  a senior person's "no, not like that."
- **Artifact:** a *tested model of what you want* — spec corpora with
  adversarial counterexamples attached, preference and constraint libraries,
  organizational "we never do X, we always prefer Y" made explicit and
  machine-readable.
- **Absorbed by:** it cannot be, in principle. Models can help elicit and
  stress-test intent, but intent originates in humans and organizations; a
  system that generated its own goals would no longer be a tool. Intent
  engineering is where the human role stabilizes rather than shrinks. The
  clear-writing residue of wave 1 returns here as the core competence.

## Wave 8 — Organization engineering (overlapping wave 7)

- **Deficiency it patches:** a single reliable agent is not an institution.
  Once one agent can be pointed at a verified goal, the unit of engineering
  becomes the *system of agents*: how many, in what roles, with what budgets,
  what they may spend, how their outputs compose, when they must escalate to
  a human.
- **Scarce skill:** institution design — incentives, task and compute
  markets, audit trails, separation of powers between generator and checker
  agents, escalation policy. The engineer's toolkit converges with the
  economist's and the constitutional lawyer's.
- **Artifact:** the agent organization — org charts, charters, and budgets
  for fleets. Today's orchestrators (pane managers, control surfaces,
  workflow engines) are the primitive ancestors: pane layouts now, org
  charts of agents later.
- **Absorbed by:** it cannot be — this is governance, and governance of a
  system must sit outside the system for the same reason verification must.

## The asymptote — where engineering ends and AGI begins

Play the tape to the end: generation automated (waves 1–5), trust automated
(wave 6), goals explicit (wave 7), coordination designed (wave 8). What
remains is what cannot be automated even in principle, and the remainder
defines the boundary:

- **Accountability.** Someone must own consequences — a signature that means
  a person answers for what the machines did, legally and morally.
  Responsibility does not compile.
- **Trust between humans.** Reputation attaches to people and institutions;
  it does not transfer to a fleet you rented this morning.
- **The physical world.** Atoms lag bits by decades. Actuation, supply
  chains, and embodiment stay scarce long after cognition is cheap.
- **Attention.** The one resource that is finite by biology, not by
  engineering. In the limit, everything produced competes for it.

"AGI" in this frame is not a wave — it is the point at which the waves stop
being *disciplines humans practice* and become *capabilities the system has*.
The operational definition this document implies: AGI is reached when waves 1
through 6 need no human practitioners — when the system prompts, retrieves,
loops, remembers, learns, and verifies itself — leaving humans holding only
waves 7 and 8 and the asymptote: stating what we want, designing the
institutions that pursue it, and answering for the results. Software
engineering does not disappear; it dissolves upward into product judgment and
governance. "Software engineer" ends where "person accountable for what the
machines did" begins.

## What survives every wave

Extracting the residue column from every wave above gives the short list of
durable positions:

1. **Accumulated data, not tooling.** Corpus (wave 2), recorded structure
   (wave 4), compiled experience (wave 5), tested intent (wave 7). Every
   tool commoditized; no accumulation did.
2. **The environment.** Tests, types, lints, fast feedback, and legible docs
   are the standing prompt that every future model consumes. This never gets
   absorbed into models because it lives on the user's side of the API.
3. **The verification surface.** External trust anchors survive by
   construction (wave 6).
4. **The substrate that hosts the accumulation.** Whoever owns the local,
   private place where context, memory, experience, and intent pile up rides
   each wave instead of being obsoleted by it.

## Implications for ghostherd

- Orchestration (Phase 0), routing (Phase 1), compression (Phase 2), and
  remote access (Phase 3) are wave-3 artifacts — commodity delivery vehicles.
  Build them thin, expect them to be table stakes, never mistake them for the
  product.
- Phase 5 (memory) is the strategic phase, but only if it is built as waves
  4 *and* 5 together: the graph is storage; the learning loop on top of the
  graph is the moat. The six-way database bake-off matters far less than
  getting the experience-compilation loop right.
- The spec directory this project already keeps is a toy of the wave-7
  artifact. Treat it that way deliberately: accumulate tested intent —
  decisions, rejected alternatives, "never do X" constraints — in
  machine-readable form, and ghostherd becomes the local substrate for the
  two waves that can never be absorbed.
- Because waves compress, assume every technique named here is disposable
  within roughly a year of adoption, and design so that only the accumulated
  data and the verification surface need to survive.

## Caveats

Confidence decays with each step: waves 1–4 are history, wave 5 is
observably starting, wave 6 is a strong bet, wave 7 is a modest bet, wave 8
is informed speculation, and the asymptote is philosophy rather than
forecast. The waves will also blur — verification, intent, and organization
engineering will likely be practiced simultaneously and muddled together,
the way RAG and loop engineering were. Hold the sequence loosely; hold the
pattern (patch → absorb → residue) tightly.
