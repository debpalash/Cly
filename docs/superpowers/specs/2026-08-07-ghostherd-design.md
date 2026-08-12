# ghostherd — design doc

Date: 2026-08-07
Status: draft for review (research clones live in `research/`, gitignored)

## What ghostherd is

A Rust-based agentic terminal IDE: persistent multi-agent sessions with
TUI-first (and later GUI) presentation, multi-vendor LLM routing, token-efficient
tool output, remote browser access, and an in-terminal browser pane.

One sentence: **herdr's agent runtime + cc-switch's vendor routing + vibetunnel's
remote access + rtk's output compression, presented through ghostty.**

## The decision: orchestrator-first

Ghostherd is built **on herdr's architecture** (fork or upstream-tracking
dependency), not from scratch and not as a thin launcher script.

Why:

1. **herdr already solves the hardest 70%.** Persistent background server that
   owns PTYs (`portable-pty`), panes with working/blocked/idle agent detection,
   a typed socket API (`src/api/` — schema, event hub, subscriptions, wait
   primitives), session persistence across restarts, plugins, ratatui TUI.
   Rewriting this is years of work with no differentiation.
2. **The ghostty integration already exists.** herdr ships libghostty FFI
   bindings (`src/ghostty/bindings.rs`). Ghostty (Zig) can never be a "Rust
   base" — but it doesn't need to be: it's the host terminal and, via
   libghostty, the future native GUI shell.
3. **What's actually missing from herdr is exactly the rest of the repo list:**
   vendor routing, remote web access, output compression, browser pane. Each is
   a bounded module.

Rejected alternatives:

- **Unified from scratch** (embed libghostty, own runtime): multi-year solo
  effort competing with fast-moving projects; zero leverage from the research.
- **Thin composer/distro** (install + wire existing tools): shippable in weeks
  but no product identity, and the seams (7 configs, 4 languages) stay visible
  to the user forever.

## Role of each researched project

| Project | Role in ghostherd | How |
|---|---|---|
| herdr (Rust) | **Core runtime** — sessions, panes, agent status, socket API, TUI | Fork or depend; Apache-2.0 |
| ghostty (Zig) | Host terminal (v0); native GUI shell via libghostty (later) | herdr's existing bindings; MIT |
| cc-switch (Tauri/Rust) | Reference for **vendor routing module** | Port concepts (provider profiles, config switching for Claude Code/Codex/Gemini CLI) into a Rust `router` module; don't embed the Tauri app |
| rtk (Rust) | **Output compression** | It's a CLI proxy — integrate as a per-pane exec wrapper or library dep; near-zero work |
| vibetunnel (Swift/TS) | Reference for **remote web access** | Reimplement the concept in Rust: herdr's API + PTY streams already exist; add an axum/websocket server + minimal xterm.js frontend |
| terminal-browser (TS + Rust engine) | **Optional browser pane** | v0: launch it as a pane process (it's already a terminal program). Deep embedding of its Rust engine is a later maybe |
| tailscale | **Not integrated** (default), **or replaced by iroh** (see below) | Remote web server binds to localhost/tailnet interface; docs tell users "run tailscale". `tsnet` is Go — fighting it into Rust buys nothing. iroh is the Rust-native alternative if embedded P2P is preferred over an external dependency |
| openinterpreter | One of many agents ghostherd runs | It's a coding agent (codex-rs lineage); ghostherd hosts agents, it doesn't become one. Useful as reference for low-cost-model routing heuristics |
| helix (Rust, MPL-2.0) | **Editor pane** in the default toolkit | Run as a pane process — zero integration. Later maybe: embed helix core crates as an editor widget (MPL is file-level copyleft, compatible) |
| yazi (Rust, MIT) | **File-manager pane** in the default toolkit | Run as a pane process. Its kitty-graphics preview stack pairs with herdr's existing `kitty_graphics.rs` |
| starship (Rust, ISC) | Recommended prompt in shipped shell config | Pure composition — no integration |
| sniffnet (Rust, Apache/MIT) | Optional **agent-observability pane** | Network monitor as oversight for what agents touch on the network. Nice-to-have, not core |
| zed (Rust; GPL core, **GPUI is Apache-2.0**) | Reference + two strategic options | (a) GPUI as the native GUI shell candidate (vs libghostty) in Phase 4; (b) adopt Zed's **Agent Client Protocol (ACP)** so ghostherd panes speak to ACP-compatible agents. Never copy GPL editor code unless ghostherd goes GPL |
| spacedrive (Rust, **FSL-1.1 — not open source**) | Reference only | Source-available license forbids competing use for 2 years per release. Read for VDFS ideas; port nothing |
| gitui (Rust, MIT) | **Git pane** in the default toolkit | Run as a pane process — zero integration |
| atuin (Rust, MIT) | Toolkit item + **sync-architecture reference** | Shared shell history across sessions/machines out of the box; its encrypted client/server sync + daemon design is the blueprint for ghostherd's multiplayer state sync |
| chroma (Rust core, Apache-2.0) | **Shared agent memory** (the "multi-player" feature) | Embedded or sidecar vector store: agents and teammates share a workspace knowledge base — decisions, context, past runs — queried by any pane's agent |
| yew (Rust→WASM, Apache/MIT) | Candidate frontend for the **remote web UI** | Keeps Phase 3 all-Rust (yew + xterm.js bridge) instead of a TS frontend. Decide at Phase 3 |
| fish-shell (Rust, **GPL-2.0**) | Default shell in the toolkit | Composition only — never embed/port code |
| eza (Rust, **EUPL/MIT**) | Toolkit garnish (modern `ls`) | Composition only |
| meetily (Tauri, MIT) | Reference for a far-future **voice/meeting → agent context** pipeline | Local Whisper + LLM meeting notes feeding the shared memory. Explicitly YAGNI for now |
| ratatui (Rust, MIT) | **Already the TUI foundation** | herdr is built on ratatui 0.30 — inherited as a direct dependency, nothing to decide |
| leptos (Rust→WASM, MIT) | Second candidate for the **remote web UI** frontend | Decide leptos vs yew (vs plain TS) at Phase 3; leptos is the more actively developed of the two Rust options |
| wasmer (Rust, MIT) | Candidate **sandboxed plugin runtime** | WASM-sandboxed third-party plugins (Zed does this with wasmtime). Only if/when herdr's native plugin system proves insufficient — flagged, not scheduled |
| sonic (Rust, MPL-2.0) | Candidate **lexical search** for Phase 5 memory | Complements chroma: chroma answers "what did we learn about X" (semantic), sonic answers "find the exact line" (keyword) over session scrollback/logs. Evaluate at Phase 5 |
| obscura (Rust, Apache-2.0) | Candidate **headless-browser backend** for agent web automation | V8-based, CDP-compatible, drop-in for Puppeteer/Playwright — an agent-facing alternative or complement to the terminal-browser pane for scripted scraping/automation tasks rather than human browsing |
| RustScan (Rust, GPL-3.0) | Reference only for an **agent-observability pane** alongside sniffnet | Fast port scanner; useful concept for "what's actually listening on this box/network" oversight. GPL-3.0 — reference only, never embed |
| wgpu (Rust, MIT/Apache) | Candidate GPU backend if GUI shell goes GPUI-style | Cross-platform Vulkan/Metal/D3D12 abstraction — what GPUI itself is built on. Only relevant if Phase 4 builds a custom renderer instead of adopting GPUI wholesale |
| tantivy (Rust, MIT) | **Stronger candidate than sonic** for Phase 5 lexical search | Embedded Rust search library (no separate server process, unlike sonic) — powers Quickwit. Prefer this over sonic for in-process scrollback/log search; sonic only if a standalone search service is wanted instead |
| sqlx (Rust, Apache/MIT) | **Persistence layer** for router profiles, session metadata, memory index | Async, compile-time-checked SQL — natural fit for ghostherd's own config/state storage (SQLite locally, Postgres for Phase 5 multiplayer sync) |
| navi (Rust, Apache-2.0) | **Cheatsheet pane** in the default toolkit | Interactive command cheatsheets — pairs naturally with agent panes for human-in-the-loop command lookup. Zero integration |
| openfang (Rust, Apache-2.0) | **Direct competitor/architecture reference** | A single-binary "Agent OS" — closest thing in this list to what ghostherd's own runtime layer is trying to be. Read its crate boundaries (14 crates) before finalizing the router/shrink/remote module split; don't build blind |
| jcode (Rust, MIT) | One of many agent harnesses ghostherd hosts | Like openinterpreter — a coding-agent CLI ghostherd runs as a pane, not something it's built from |
| iii (Apache-2.0 AND Elastic-2.0) | Reference for **the integration problem itself** | "Zero-integration via shared runtime" — a connector runtime for state/observability/agents/sandboxes. Directly validates ghostherd's own thesis (one runtime instead of N point integrations). Elastic-2.0 component restricts building a competing hosted service — reference only, don't vendor |
| mattpocock/skills (MIT) | Not a Rust dependency — a **content reference** | A curated skills/agent-workflow library (already loaded as the `mattpocock-skills` plugin in this session). Useful for shaping what ghostherd's own bundled agent skills/prompts should look like, not for code |
| tokei (Rust, MIT) | **Codebase-stats module**, near-zero effort | Line/language counter library — surface repo stats in the TUI status bar or a workspace-overview pane. Small, embeddable, no design decision needed |
| turbovec (Rust, MIT) | **Alternative to chroma** for Phase 5 vector memory | Local vector index (Google's TurboQuant algorithm), no server, Python+Rust — lighter-weight than chroma if full server-mode vector DB features aren't needed. Evaluate turbovec vs. chroma at Phase 5 based on whether multi-client sync (chroma) or pure local speed (turbovec) matters more |
| espanso (Rust, **GPL-3.0**) | Reference only for a **text-expansion pane** | Cross-platform text expander — snippet/shortcut expansion while typing to agents or in editor panes. GPL-3.0 — reference only, reimplement the concept rather than embed if wanted |
| harper (Rust, Apache-2.0) | **Grammar/prose-lint module**, real candidate to embed | Fast, fully offline English grammar checker built for developers (commit messages, docs, comments) — the anti-Grammarly. Apache-2.0, embeddable as a library; a natural fit for a ghostherd pane or inline check on agent-authored text |
| bottom (Rust, MIT) | **System-monitor pane** in the default toolkit | Cross-platform process/resource monitor (htop-style) — joins sniffnet/RustScan as the oversight-pane family. Zero integration |
| stalwart (Rust, **AGPL-3.0**) | **Out of core scope** — reference only, if ever | Mail/collaboration server (IMAP/JMAP/SMTP/CalDAV/CardDAV/WebDAV). No clear tie to a terminal agentic IDE beyond a speculative "agent sends me an email when blocked" notification channel. AGPL's network-use copyleft rules out embedding regardless. Flagged as the first item that doesn't obviously belong — see scope-discipline risk |
| dbx (Rust, Apache-2.0) | **Database pane** in the toolkit, plus an architecture reference | Universal client for 70+ databases (CLI, Tauri desktop, Docker) with a built-in `dbx-mcp` crate exposing database access as an MCP server. Run as a pane as-is; the MCP server also means agents can query project databases directly through dbx without ghostherd writing any DB-access code. Its `core / web / mcp / cli` crate split is a second good reference (alongside openfang) for how to expose one Rust core through multiple surfaces — directly relevant to ghostherd's own daemon+TUI+web+socket-API shape |
| rust-clippy (Rust, MIT/Apache-2.0) | **Not a product component — ghostherd's own lint gate** | The linter, not a library to integrate. herdr and openfang both advertise "zero clippy warnings" as a quality bar; ghostherd's CI should hold the same standard from the first commit. Listed here for completeness, not the composition/reference/dependency taxonomy the rest of the table uses |
| broot (Rust, MIT) | **Alternative to yazi** for the file-nav pane | Tree-based fuzzy directory navigator (`cd` replacement) rather than yazi's full file-manager/preview approach — lighter-weight, different interaction model. Toolkit default stays yazi; broot is the pick if a user wants fast tree-jump navigation instead |
| gping (Rust, MIT) | **Network-graph pane**, joins the oversight family | `ping` with a live terminal graph — small addition alongside sniffnet/bottom/RustScan for at-a-glance connectivity checks. Zero integration |
| ironclaw (Rust, MIT OR Apache-2.0) | **Strongest architecture reference in the list — validates three deferred designs at once** | A security-first personal AI assistant: WASM-sandboxed tools with capability permissions (the exact wasmer-based plugin sandbox flagged earlier as "not scheduled"), hybrid full-text+vector memory search via Reciprocal Rank Fusion (the exact tantivy+chroma/turbovec pairing already planned for Phase 5), and multi-channel serving (REPL/HTTP/web gateway/SSE — the exact shape of Phase 3's remote access). Read its `channels`, `sandbox`, and `memory` module boundaries before designing the corresponding ghostherd modules — don't design any of the three blind |
| iroh (Rust, MIT/Apache-2.0) | **Strong tailscale alternative for Phase 5 multiplayer** | QUIC-based P2P connectivity library ("less net work for networks") — direct encrypted connections with NAT traversal, hole-punching, and relay fallback, as a Rust *library* rather than a separate daemon users must run. Where the design currently says "bind to tailnet, tell users to run tailscale," iroh is the option to embed peer connectivity directly into ghostherd's `remote`/multiplayer module instead of depending on an external tool. Evaluate at Phase 5 alongside chroma vs. turbovec |
| anydoc (Rust, MIT) | **Document-ingestion module** for agent context / Phase 5 memory | Converts Word/PowerPoint/Excel/OpenDocument/RTF/EPUB/CSV/PDF into clean Markdown, single-digit milliseconds, WASM-capable (runs fully local). Feeds the shared workspace memory (chroma/turbovec) with real documents, not just chat/code — turns "agent memory" into "agent memory of everything in the project," including files no agent could otherwise read |
| pdf-inspector (Rust, MIT) | **PDF-specific companion to anydoc** | Text-based vs. scanned classification + position-aware text extraction without OCR. Use where anydoc's PDF path needs finer control (coordinates, font info, reading order) than a straight-to-Markdown conversion gives |
| git-cliff (Rust, Apache-2.0) | **Changelog-generator pane/tool**, pairs with gitui | Generates changelogs from conventional-commit git history. Toolkit addition — zero integration, useful for agents drafting release notes |
| grpc-rust / tonic (Rust, MIT) | **Candidate RPC transport** for the socket API | This is actually the `tonic` gRPC implementation (the `grpc` org's Rust repo redirects to it). herdr's socket API is presumably a custom protocol; tonic is the standard choice if ghostherd ever needs typed, cross-language RPC (e.g. non-Rust clients talking to the daemon) instead of a bespoke socket protocol. Not needed unless that requirement appears — flagged, not scheduled |
| onefetch (Rust, MIT) | **Repo-summary pane**, near-zero effort | neofetch-style git repo info card (languages, commits, contributors). Pairs with tokei; a nice default landing view when opening a workspace |
| fff (Rust, MIT) | **Real candidate for the agent-facing file-search backend** | Purpose-built "file search toolkit for humans and AI agents" — typo-resistant path/content search, frequency-ranked results, background watcher, in-memory index; already powers file search in opencode and nushell. Stronger fit than a raw ripgrep/fzf wrapper for agent tool-calls that search the workspace repeatedly in a long-running process (exactly ghostherd's daemon shape). Complements tantivy: fff for fast interactive/agent file+content lookup, tantivy for the heavier Phase 5 memory/log index |
| claurst (Rust, **GPL-3.0**) | One of many agent harnesses ghostherd hosts | Clean-room Claude-Code-alike terminal coding agent — same bucket as openinterpreter/jcode: a pane guest, not a component. GPL-3.0 — never embed, run as a subprocess only |
| cocoindex (Rust core, Apache-2.0) | **Strong candidate to replace ad-hoc Phase 5 wiring** | Incremental indexing engine purpose-built for agent memory: reprocesses only the delta when source content (codebase, docs, notes) changes, keeping retrieval always fresh. This is the orchestration layer ghostherd's Phase 5 memory design was missing — sits between ingestion (anydoc/pdf-inspector/xberg) and storage (chroma/turbovec/tantivy) instead of ghostherd hand-rolling that sync logic |
| xberg (Rust core, MIT) | **Supersedes anydoc/pdf-inspector as the ingestion module** | Universal document-intelligence engine: 101 formats, OCR, audio/video transcription, layout/table reconstruction, code-symbol extraction, embeddings, and a built-in MCP server — callable as library, CLI, REST API, or MCP. Where anydoc/pdf-inspector cover Office+PDF cleanly, xberg is the fuller pipeline (URLs, archives, audio); its MCP server means agents can call it directly without ghostherd wiring anything. Re-evaluate anydoc/pdf-inspector vs. xberg at Phase 5 — likely xberg alone is enough |
| microsandbox (Rust, Apache-2.0) | **Stronger sandbox candidate than wasmer/WASM for untrusted agent code** | Hardware-isolated microVMs, <100ms boot, OCI-image compatible, embeddable with no server setup, secrets that never enter the VM, and its own MCP server for agents to spawn their own sandboxes. Where ironclaw uses WASM sandboxing and wasmer was flagged as a WASM option, microsandbox is the microVM alternative — stronger isolation (hardware vs. WASM) at the cost of needing virtualization support. Compare against ironclaw's WASM approach when Phase 4's plugin-sandbox design is written |
| boa (Rust, MIT/Unlicense) | **Embeddable JS engine**, minor candidate | A JavaScript engine in Rust (boajs.dev) — could run JS-based plugins or agent-generated scripts without shelling out to Node.js. Lower priority than the sandbox question above; relevant only if ghostherd ever wants a JS plugin surface |

**Graph-based AIDE sweep** (from a targeted search of `graph language:rust stars:>500`,
44 total results reviewed; the 11 below are the ones with a real tie to an
agentic IDE — general-purpose graph DBs/visualizers with no agent angle were
left out):

| Project | Role in ghostherd | Notes |
|---|---|---|
| iwe (Rust, Apache-2.0) | **Direct hit — candidate to replace the ad-hoc Phase 5 memory design entirely** | Markdown knowledge graph with an LSP for editors and a CLI + **MCP memory server** for AI agents. This is close to a ready-made version of what Phase 5's chroma/tantivy/cocoindex stack was being assembled to build — evaluate depending on iwe directly for note/knowledge-graph memory before building a bespoke one |
| codeseek (Rust, MIT) | **Direct hit — code-intelligence module for agent panes** | "Code intelligence CLI for AI coding agents. Builds call graphs and hybrid semantic..." — exactly the capability an agentic IDE needs to let agents reason about codebase structure rather than grep blindly |
| tokensave (Rust, MIT) | **Direct hit — alternative/complement to codeseek** | Positioned as "the most comprehensive code intelligence MCP server for AI coding agents. 40+ tools, 30+ languages." Compare against codeseek at Phase 1/5 — may only need one of the two |
| helix-db (Rust, Apache-2.0) | **Strong Phase 5 memory candidate — graph+vector in one engine** | OLTP graph-vector database built on object storage. Where the design currently pairs chroma (vector) with a separate graph/relational layer, helix-db does both natively — fewer moving parts than chroma+sqlx+tantivy stitched together |
| cozo (Rust, MPL-2.0) | **Second strong Phase 5 memory candidate** | Transactional relational-graph-vector database using Datalog, explicitly pitched as an AI agent's "hippocampus." MPL-2.0 is embeddable (same category as helix). Evaluate helix-db vs. cozo vs. chroma+sqlx+tantivy as three competing Phase 5 persistence designs rather than assuming the original stitched-together plan |
| graphrag-rs (Rust, MIT) | **GraphRAG candidate** — graph-structured retrieval, not just vector similarity | Rust implementation of GraphRAG (Microsoft's approach: build a knowledge graph from documents, retrieve via graph traversal + community summarization). Relevant if Phase 5 memory needs relationship-aware retrieval, not just nearest-neighbor |
| edgequake (Rust, Apache-2.0) | **Second GraphRAG candidate**, higher-throughput framing | "High-performance GraphRAG inspired from LightRAG" — compare against graphrag-rs at Phase 5; both solve the same problem, pick one rather than both |
| stack-graphs (Rust, Apache-2.0) | **Cross-language go-to-definition**, from GitHub itself | Powers precise code navigation (the same tech behind GitHub's code navigation) — a possible foundation for an agent-facing "jump to definition across the whole workspace" tool, independent of any single language server |
| petgraph (Rust, Apache-2.0) | **Foundational dependency**, near-zero decision cost | The base in-memory graph data-structure library for Rust. Whatever ghostherd builds itself — agent dependency graphs, pane relationship graphs, pipeline DAGs — likely sits on top of petgraph rather than reinventing graph algorithms |
| graphbit (Rust, Apache-2.0) | **Another live competitor**, same bucket as openfang/ironclaw | Self-described "enterprise-grade Agentic AI framework, built on a Rust core." Lower star count (573) than openfang/ironclaw so lower priority to read deeply, but same pattern: a working Rust agent framework worth a glance before finalizing router/memory design |
| serie (Rust, MIT) | **Git commit-graph pane**, joins gitui/git-cliff/onefetch | "A rich git commit graph in your terminal, like magic" — visual commit-graph pane, rounds out the git toolkit family. (git-graph and keifu do the same job — serie had the highest stars of the three, picked as the default) |

Explicitly excluded from the table (reviewed, no clear agentic-IDE tie): general
graph databases with no agent/AI framing (oxigraph, indradb, Raphtory,
rustworkx, omnigraph, grapl-security), GUI-only graph tools (GraphiteEditor,
egui_graphs, egui-snarl — relevant only if a future GPUI/egui GUI path wants a
node-graph widget), and domain-specific tools (dora-rs robotics middleware,
glicol audio DSP, ezkl zero-knowledge ML, mev-bundle-generator, rustc-perf,
pg_graphql, graphql-rust, embedded-graphics, rustgym). surrealdb (32.8k★,
document-graph-realtime DB) was excluded for now as too large/opinionated a
dependency to adopt just for this — worth a second look only if helix-db and
cozo both fail Phase 5 evaluation.

**Follow-up additions** (user-requested, some previously excluded/mentioned in
passing above — re-evaluated on closer look):

| Project | Role in ghostherd | Notes |
|---|---|---|
| compass (Rust, Apache-2.0) | **Direct hit — third code-intelligence-graph candidate** | "A fast, local-first knowledge graph for understanding codebases" — searches/queries/visualizes source as a graph, tracks CALLS/IMPORTS_FROM/USES/CONTAINS relationships with provenance, compares across git history, ships native MCP serving. Now a three-way choice with codeseek and tokensave for the code-intelligence module — compass's explicit provenance tracking and git-history-aware queries may be the most complete of the three. Evaluate all three together, don't default to whichever was found first |
| coyote (Rust, **AGPL-3.0**) | One of many agent harnesses ghostherd hosts | All-in-one LLM CLI: shell assistant, REPL, RAG, AI tools. Same bucket as claurst/jcode/openinterpreter — a pane guest. AGPL-3.0 — never embed |
| RuVector (Rust, MIT) | **Third Phase 5 memory candidate** | Self-learning vector GNN memory DB (graph neural network over vector memory) — adds to the helix-db/cozo/iwe set of competing Phase 5 designs rather than the original chroma+sqlx+tantivy stitched stack. Now four embeddable alternatives to bake off, not just two |
| git-graph (Rust, MIT) | **Alternative to serie** for the git commit-graph pane | Same job as serie (already the toolkit default) and keifu — three implementations of the same idea now cataloged. Not additive; keep serie as default unless a specific feature here (branching-model-aware layout) is wanted |
| FalkorDB (C/Rust, **SSPL — not OSI open source**) | **Reference only, do not embed** | Fast GraphBLAS-backed graph database explicitly marketed for "Agent Memory" — relevant framing, but the Server Side Public License restricts offering it as a service and is generally treated as source-available rather than open source (same caution class as spacedrive's FSL and stalwart's AGPL). Use only as a design reference for what an agent-memory graph DB API should look like; helix-db/cozo/RuVector are the actually-embeddable options for the same job |
| grafeo (Rust, Apache-2.0) | **Fifth Phase 5 memory candidate** | Embedded-or-standalone graph database with ACID transactions, vector as a first-class value type, and built-in quantization (scalar/binary/product) for compact storage — graph + vector + AI algorithms in one engine, same category as helix-db/cozo/RuVector. Its explicit ACID guarantee is the differentiator worth weighing against the others at the Phase 5 bake-off |
| orca (TypeScript/Electron, MIT) | **Live competitor — the GUI orchestrator play** | "The AI Orchestrator for 100x builders": runs Codex/Claude Code/OpenCode/Pi side-by-side, each in its own git worktree, tracked in one desktop app. This is ghostherd's Phase 0 thesis already shipped as an Electron GUI. Study its worktree-per-agent model and session-tracking UX; ghostherd's differentiation must come from being terminal-native (real PTY substrate, not a wrapper UI) and from the layers orca lacks (router, shrink, memory) |
| t3code (TypeScript, MIT) | **Live competitor — the remote control-surface play** | Self-described "agent harness control surface": drives Claude Code/Codex/Cursor/Grok/OpenCode running on your machine from best-in-class mobile (iOS/Android), web, and Electron apps. This is ghostherd's Phase 3 `remote` module already shipped, with mobile apps ghostherd will never match short-term. Read its server/client protocol before designing `remote` — and consider whether Phase 3 should interoperate with it rather than compete |
| hermes-agent (Python/TS, MIT) | **Live competitor — the self-improving memory play** | Nous Research's agent with a built-in learning loop: creates skills from experience, searches its own past conversations, builds a persistent user model across sessions, runs on a $5 VPS controlled via Telegram. This is ghostherd's Phase 5 memory thesis already working in production. Its skill-creation-from-experience loop and self-nudging persistence are mandatory reading before the Phase 5 memory bake-off — the six candidate databases are storage; hermes shows what the loop *on top of* storage should do |

## Architecture

```
┌─ ghostty (host terminal / future GUI shell via libghostty) ─┐
│  ┌─ ghostherd server (Rust daemon, forked from herdr) ────┐ │
│  │  runtime: PTY panes, persistence, agent status         │ │
│  │  api:     typed socket API, event hub, wait/subscribe  │ │
│  │  NEW router:  provider profiles, per-agent vendor       │ │
│  │               config injection, failover/auto-routing   │ │
│  │  NEW shrink:  rtk-style output proxy per pane           │ │
│  │  NEW remote:  axum + websocket → xterm.js web UI        │ │
│  │               (secure remote via user-run tailscale)    │ │
│  └────────────────────────────────────────────────────────┘ │
│  TUI client (ratatui) ── web client (browser) ── CLI        │
│  panes run: claude code / codex / opencode / open-          │
│  interpreter / terminal-browser / anything                  │
└─────────────────────────────────────────────────────────────┘
```

Module boundaries: `router`, `shrink`, and `remote` each talk to the core only
through the existing socket API + pane spawn hooks, so they can be built and
tested independently, and rebased when upstream herdr moves.

## Phased roadmap

- **Phase 0 — compose, no code (days):** run herdr inside ghostty, wire rtk as
  an exec wrapper, cc-switch as-is for provider switching, tailscale + herdr's
  reattach for remote. Add the pane toolkit as preconfigured layouts: helix
  (editor), yazi (files), terminal-browser (web), starship prompt, optional
  sniffnet. Validates the workflow before writing anything.
- **Phase 1 — router (first real code):** Rust module + TUI surface for provider
  profiles and per-pane vendor selection (port cc-switch's config-management
  concepts; support Claude Code, Codex, Gemini CLI first). This is ghostherd's
  first differentiating feature.
- **Phase 2 — shrink:** rtk integration as a per-pane option (wrap agent-spawned
  shells), measured by tokens saved.
- **Phase 3 — remote:** axum websocket server streaming panes to a minimal web
  UI; localhost/tailnet binding only, no auth of our own in v1.
- **Phase 4 — browser pane + GUI shell:** terminal-browser as a first-class
  pane type; GUI shell — decide **libghostty (Zig FFI, terminal-native) vs
  GPUI (Zed's Apache-2.0 Rust framework, full app UI)** when we get here.
- **Phase 5 — memory & multiplayer:** chroma-backed shared workspace memory
  (agents read/write a common knowledge base) + atuin-style encrypted sync so
  multiple humans and machines share one ghostherd workspace. Combined with
  Phase 3's remote access, this is the true "multi-player" mode: see, drive,
  and share context in the same session from anywhere.

Each phase is its own spec → plan → implementation cycle. Phase 1 is the first
one to spec in detail.

## Licensing

herdr, cc-switch, rtk, vibetunnel, sniffnet, chroma, GPUI: Apache-2.0. yew:
Apache/MIT. ghostty, yazi, atuin, gitui, meetily: MIT. starship: ISC. helix:
MPL-2.0 (file-level copyleft — embeddable). All of the above are fork/derive
friendly with attribution + license retention; keep NOTICE files when porting
code (vs concepts). **Zed's editor core is GPL-3.0** and **fish-shell is
GPL-2.0** — reference/composition only unless ghostherd adopts GPL. **eza is
EUPL-1.2** — composition only. **Spacedrive is FSL-1.1** (not open source;
anti-compete clause) — reference only, port nothing.

## Positioning: what "next" means

The coding-agent space is saturated — hundreds of harnesses exist, and each of
ghostherd's individual layers now has a shipped, popular competitor: orca is
the GUI orchestrator, t3code is the remote control surface, herdr itself is
the terminal orchestrator, hermes-agent is the self-improving memory loop.
Building "another orchestrator" is no longer a differentiator on its own.

What none of them are is the **combination**: a terminal-native, local-first
substrate where orchestration (herdr), vendor routing (router), token-cost
compression (shrink), remote access (remote), and graph-backed persistent
memory (Phase 5) live in one Rust daemon under one socket API — with the
agents themselves treated as replaceable guests, never the product. The
competitors each own one layer and wrap the others; ghostherd's bet is that
owning the substrate all layers share is the durable position when individual
agents churn every few months. Every phase decision below should be tested
against this: does it deepen the substrate, or does it just re-implement a
layer someone already ships?

## Risks & open questions

- **Fork vs depend on herdr:** forking risks drift from a fast-moving upstream;
  depending risks their internals not being a stable library surface. Phase 0/1
  should answer whether the socket API + plugin system is enough (prefer
  plugin/API integration; fork only if blocked).
- **cc-switch overlap:** it manages the same config files ghostherd's router
  would; running both could clobber configs. Router must own or detect this.
- **Windows:** herdr targets Unix-y environments; ghostty has no Windows build.
  Out of scope for now — macOS/Linux only.
- **Scope discipline:** the reference list has grown to 34 repos. The phase
  gates are the defense: Phases 0–1 ship value with only the router written
  from scratch; everything else stays composition until a phase explicitly
  promotes it. Any new repo idea lands in this table, not in the roadmap.
- **Every layer now has a shipped competitor** (orca = GUI orchestration,
  t3code = remote control surface + mobile apps, hermes-agent = self-improving
  memory, openfang/ironclaw = Rust agent runtimes). All MIT-licensed, all
  study-able. The Positioning section above is the answer; the risk is
  forgetting it and burning a phase re-implementing a layer that should be
  studied, interoperated with, or composed instead.
- **openfang is a live competitor** building the same "single-binary Agent OS"
  thesis in Rust. Before Phase 1 locks the router/shrink/remote module split,
  read openfang's 14-crate boundary design — either it validates the split or
  it shows a better one. Re-evaluate orchestrator-first vs. depending on
  openfang directly the same way we're depending on herdr.
- **Phase 5 memory now has six competing designs, not one** — the original
  chroma+sqlx+tantivy stitched stack, iwe (ready-made MCP knowledge-graph
  memory), helix-db, cozo, RuVector, and grafeo (graph+vector, ACID, in one
  embedded engine each). Do not default to the first option just because it
  was written down first; a short bake-off belongs at the start of Phase 5,
  before any memory code is written. FalkorDB is a reference for API shape
  only — its SSPL license rules it out as a dependency.
- **Code-intelligence graph is now a three-way choice**: codeseek, tokensave,
  and compass all claim to build call/reference graphs for AI agents from a
  codebase. Read all three before Phase 1/5 picks one — compass's explicit
  provenance tracking and git-history-aware queries look like the most
  complete feature set on paper, but that's untested against the others.
- **ironclaw independently solves three of ghostherd's deferred problems**
  (WASM plugin sandboxing, hybrid semantic+lexical memory, multi-channel
  serving) with a working, security-audited implementation. Before writing
  the `shrink`/Phase 4 sandbox design or the Phase 5 memory/remote modules,
  read ironclaw's `sandbox`, `memory`, and `channels` crates — reinventing
  any of the three without reading this first would be wasted effort.
- **Name/identity:** "ghostherd" implies a ghostty+herdr derivative; if the
  project is published, upstream trademark/branding courtesy applies (ghostty
  has an explicit AI policy and brand guidelines — read before shipping).
