# codegent — Design Specification

**Date:** 2026-07-19 · **Status:** Draft for owner review · **Language:** Product UI is English. This spec is the single source of truth for v1.

> codegent is a browser-based AI coding-agent orchestrator: the terminal power of Orca, the kanban orchestration of Vibe Kanban, and zero-knowledge remote access via a relay — in one open-source product. Add a task card from any browser; an agent starts in a real terminal on your machine at home; you get a push when it needs input; you answer in the terminal, review the diff, merge.

---

## 1. Goals & positioning

- **Target:** 50k GitHub stars. Star mechanics: a killer README GIF (<15s), one-line install, works with the user's existing Claude Code/Codex subscription, a trustworthy "zero-knowledge relay, self-hostable" story.
- **Differentiation (July 2026 reality):** the durable combination is **E2E zero-knowledge remote + cross-agent kanban orchestration + real browser terminals** — first-party remotes (Claude Remote Control, Codex cloud) are not E2E and never orchestrate rivals; Orca is desktop-first; happy has no board; Vibe Kanban is orphaned. Positioning leads with what platforms won't do: multi-agent neutrality, privacy/self-host, your-hardware-your-subscription.
- **v1 scope (locked):** core loop with excellent polish, fast public launch, transparent roadmap. Feature parity with Orca is a roadmap, not a launch gate.
- **License:** AGPL-3.0. Free for everyone to use (including at work); anyone distributing modified versions or offering it as a service must publish their source — blocks closed-source forks and competing SaaS. Copyright stays with the owner; contributions accepted under a CLA, keeping a future enterprise/commercial licensing option open (no pricing model now). **Platforms:** macOS + Linux native; Windows via WSL (documented). **Agents in v1:** every agent runs interactively in its **own TUI inside a real PTY** — never as a protocol-rendered chat (decision 2026-07-19). Claude Code (deepest, hooks) + Codex (official hooks) are the premium tier; every other recognizable agent (Gemini CLI, Copilot CLI, Goose, OpenCode, …) gets the **universal terminal-state tier** (§6): content-free state detection plus our MCP task tools wherever the agent supports MCP. Unrecognized CLIs still run in plain terminal sessions without orchestration guarantees.

## 2. Product principles (locked)

1. **Terminal content never leaves the terminal.** The daemon classifies state from deterministic signals (hooks, process-tree identity, OSC title/progress codes, manifest-scoped screen patterns, exit codes) but the UI never displays scraped/derived content — no question previews, no error excerpts, no "exit 1". Surfaces show *state + elapsed time* only; clicking always routes to the terminal where the content lives.
2. **The board observes and routes; conversation happens in the terminal.** No custom answer UIs, no stdin-injection protocols. Fragility is designed out.
3. **Task is primary; worktree is its shadow.** Starting a card auto-creates `cg/<id>-<slug>` from a base branch; merging auto-archives it. Users never manage worktrees except for scratch work.
4. **Task title is the primary identity everywhere;** branch name is a secondary mono subline. Every surface uses the same title for the same object.
5. **Minimal chrome, no slop:** no emoji in chrome (Lucide stroke SVGs only), no left accent bars, no colored frames as state, no bouncing animations, no condensed fonts, weights ≤500 (650 only inside badge micro-caps). Hover-revealed affordances. Single accent (violet) + semantic amber/red/green + per-worktree identity colors as small dots only.
6. **Zero-friction defaults:** install asks nothing; hosted relay free and unlimited; no accounts.
7. **Latest stable everything.** Every dependency, toolchain component, and referenced technology is adopted at its **latest stable release** at integration time and kept current thereafter; version numbers in this spec and in plans are minimum floors / illustrations, never pins. Resolve real versions at execution time (`bun pm view <pkg> version`).
8. **No telemetry in v1.** The daemon phones home for nothing except self-update checks (opt-out flag). Stated plainly in the README — part of the trust story.

## 3. Architecture

```
┌──────────┐   E2E encrypted    ┌────────┐   outbound WSS    ┌───────────────────────────┐
│ Browser  │◄──────────────────►│ Relay  │◄─────────────────►│ Daemon (user's machine)   │
│ (Web UI) │  relay reads nothing│GCP/self│  no ports opened  │ PTYs · worktrees · engine │
└──────────┘                    └────────┘                   │ SQLite · MCP · adapters   │
      └── direct on localhost (no relay)                     └───────────────────────────┘
```

| Component | Stack | Notes |
|---|---|---|
| **Daemon** | Bun + TypeScript, single compiled binary | PTY manager (Bun-native `Bun.spawn({terminal})`, ≥1.3.5; Rust portable-pty sidecar as fallback — node-pty under Bun is a dead end), git worktree manager, orchestrator engine, SQLite (`bun:sqlite`) at `~/.codegent/`, MCP server, relay client, serves UI on localhost |
| **Web UI** | React + Vite + TS | **ghostty-web** (`coder/ghostty-web` — Ghostty VT core in WASM) as the terminal renderer — the only terminal engine; no xterm.js anywhere. **Consumed as a source build**: the npm release is stale, so we vendor the repo as a git submodule (`vendor/ghostty-web`) pinned to a recent `main` commit, build it ourselves (toolchain recorded in `docs/research/ghostty-web-spike.md`), and bump the pin deliberately — "latest stable" here means latest healthy main, not the old tag. Tailwind + Radix/shadcn, Motion (animations — library, never hand-rolled), Lucide icons, TanStack Query + one multiplexed WS |
| **Relay** | Bun, single binary + Docker image | Zero-knowledge frame router; serves the same UI build for remote; hosted at `relay.codegent.io` — GCP **c4a (Axion ARM) + Debian 13 "trixie"** in `europe-west4-a` (mirrors the owner's existing fleet; provisioned via gcloud, start at c4a-standard-1/2 and scale as needed), Caddy for TLS, relay via its Docker image; the **codegent.io website is served from the same VM** (Caddy static). Self-host = same binary |
| **Adapters** | in daemon | Claude Code (hooks+MCP), Codex (official hooks+MCP), universal terminal-state tier (process-tree + OSC classification + agent manifests, §6) |
| **Installer/CLI** | shell script + compiled CLI | see §14 |

**Study-first rule (build methodology):** before implementing any non-trivial subsystem, read how the best open-source prior art already does it and adapt proven approaches instead of reinventing — the goal is stolen wisdom, not stolen code. Where a proven implementation exists, adopt its mechanism **with its tested thresholds and polarity choices outright**; never re-enter the trial-and-error loop a reference project already paid for (canonical example: herdr shipped byte-quiescence-first agent detection and reverted it within two days — we inherit the conclusion, not the experiment). Primary references: **Orca** (MIT — PTY/terminal management, worktree lifecycle, unread state, session persistence), **Vibe Kanban** (task↔workspace model, worktree creation/cleanup, process supervision, PR flow), **herdr** (`ogulcancelik/herdr` — Rust agent terminal multiplexer: agent state detection blocked/working/done, detach/reattach sessions that survive restarts — key reference for our state capture + session persistence), claude-squad / happy / VibeTunnel (remote terminal + relay patterns), **sshx** (E2E-encrypted WS terminal sharing), VS Code (node-pty hardening), tmux (scrollback/attach semantics), Claude Code hooks + MCP reference docs. Each week-1 spike and each milestone workstream begins with a prior-art read; findings land as short notes in `docs/research/`. License hygiene: MIT/Apache → adapt with attribution where substantial; GPL/unclear → concepts only, never code.

**Monorepo:** `apps/daemon`, `apps/web`, `apps/relay`, `packages/protocol` (shared types + E2E frames + zod), `packages/adapters`, `install/install.sh`, `docs/`. Bun workspaces; releases via GitHub Releases binaries (macos-arm64/x64, linux-x64/arm64) + a Docker image for the relay only.

## 4. Domain model

**Core rule: column ≠ state.** A card has a `phase` plus orthogonal flags; board columns are projections.

### 4.1 Card state machine

- **Phases:** `queued` → `working` → `review` → `done` | `cancelled`
- **working sub-states:** `starting`, `running` (cycle n≥1), `stopped` (user), `error{start_failed | crashed | interrupted}` (interrupted = daemon restart)
- **review sub-states:** `ready`, `stale` (behind base), `conflict`, `updating` (rebase), `merging`
- **Flags (orthogonal):** `input-needed{question | permission | silent}`, `unread`, `pinned(worktree)`

Key transitions (trigger → side effects):

| Transition | Trigger | Side effects |
|---|---|---|
| queued → starting | user starts / orchestrator R1 (free slot, topmost auto:on) | create worktree from base; spawn agent session |
| starting → running | agent session-start hook | RUNNING badge, strip chip, counts |
| starting → error(start_failed) | git/spawn failure | partial worktree rolled back; card stays visually in Queue with ERROR badge + retry; **no stderr shown** (principle 1) |
| running → +input flag | CC Notification/PermissionRequest hooks / Codex hooks / §6 universal-stack idle classification (silent — screen-state evidence, never a byte-quiescence timer) | renders in Waiting column; push (question/permission only); timer |
| +input → running | PTY input received (prompt-submit) | auto-reversal |
| running → review.ready | completion truth table (below) | diffstat computed; enters review queue FIFO; push |
| running → stopped | user stop (Esc/⏹) | SIGINT; scrollback kept; no push |
| stopped → starting (resume) | user Resume on a stopped card (amendment 2026-07-20: live-verified same-conversation continuity) | same attempt + worktree, native conversation resume (`--resume <asid>`), fresh dispatch; requeue via drag stays legal as the queue-return alternative |
| running → error(crashed) | process exit ≠0 without Stop hook | scrollback kept; push; actions: resume/restart/discard (§9.1) |
| review.ready → running (cycle+1) | **Send back** (≥0 comments) | queued comments delivered as structured feedback; badge "RUNNING · round 2" |
| ready → stale | base advanced (merge cascade) | "N merges behind — update"; Merge disabled |
| stale → updating → ready / conflict | user update; rebase result | clean: silent diff refresh + invalidate reviewed-marks of changed files; conflict: push |
| conflict → ready | user resolves in the worktree terminal (one-click "open terminal"); daemon detects the clean state | conflicts are never auto-repaired in v1; queue position kept |
| ready → merging → done | user Merge (blocked while stale/conflict) | squash default; kill sessions; archive worktree (unless pinned); re-check all other reviews; R1 pulls next card |
| review/working → cancelled | user closes without merge | confirm; archive worktree; branch kept 14 days; collapsed "cancelled" section under Done |
| done → (new linked card) | reopen / revert | reopen = **new attempt, fresh worktree from current base** (never resurrect the stale branch); revert = pre-filled card ("git revert -m 1 <sha>") run like any card |

**Completion truth table (v2 — verified LIVE 2026-07-19 against CC 2.1.215 + Codex 0.144.6, every row reproduced: `docs/research/cc-codex-hook-contract.md`):** Claude Code fires `Stop` at the end of **every turn** (including question-only turns), so Stop alone never signals completion. Review is gated **only** by `task_complete`: `task_complete` (+ Stop) → review. Stop without `task_complete` → input-needed(question) — the ordinary mid-conversation state. `StopFailure` (API-error turns) → error. Permission-request notifications → input-needed(permission). User Esc emits no hook — covered by PTY-write tracking (the daemon knows it sent the interrupt). Codex maps through its official hooks; state fallback for both is the §6.1 stack (screen/OSC/process evidence — never byte-quiescence). **Contract-churn guard:** version probe at adapter start + nightly contract tests against real CLIs; unknown agent versions run in a flagged degraded mode.

**Drag map:** Queue→Running = start. Running→Queue legal only from stopped/error (re-queue, worktree kept+pinned). Running→Review = "early review" (stop + snapshot diff, confirm). Review→Running = Send back. Waiting column is derived — dragging in/out is illegal. Into Done illegal (Merge button only). Out of Done illegal (reopen action instead).

**Queue semantics (adopted):** Queue column is an ordered queue; R1 starts the topmost `auto:on` card while `running < worker limit` (default 1; setting lives in Settings). Cards show "QUEUE · n" position badges; the Running column header shows "n/m slots". `auto:off` cards are the backlog — no separate column. Reordering = drag within Queue. No preemption in v1: free a slot by stopping a running card.

**Input sub-kinds (adopted):** `question` and `permission` (distinct icon + push copy), `silent` (the agent is classified idle by the §6 detection stack while its card is still assigned — screen-state/OSC/process evidence, never a bare byte-quiescence timer; strip-only, never pushes). All three land the card in Waiting: ambiguity always degrades to "come look", never to a false done or to invisibility.

### 4.2 Worktree lifecycle

Two orthogonal axes + attachment:
- **lifecycle:** `none → creating → active → archiving → archived → deleted`, plus `broken` (dir missing/mangled; fs-scan detects) and `external` (pre-existing user worktree; listed read-only, attached, never managed).
- **sync (vs card.base):** `clean | behind | conflicted | updating | untracked` (scratch = untracked; no stale nagging).
- **attachment:** `task(attempt_id) | pinned-queue(ordered cards) | scratch`.

**Invariants:** exactly one active worktree per live card (I1); ≤1 active card per worktree (I2 — pinned-queue runs head card only; archive deferred until the pin list empties; worktree color belongs to the worktree and persists across the chain); sessions only in active worktrees or repo main (I3); archiving kills sessions (confirm if a foreground process is running); scratch worktrees never appear on the board (I5); **attempt entity reserved in schema** (`attempt(id, card_id, worktree_id, seq, status)`, v1 constraint: one per card) so future fan-out is a constraint lift, not a migration (I6).

**Naming:** `cg/<cardId>-<slug>` → collisions impossible for managed trees; scratch names user-chosen (exists → offer attach or auto-suffix). Worktrees live under `<repo>/.codegent/worktrees/` (gitignored) — configurable. Creation runs the project's setup script + copy-globs (§8) before the agent starts.

**Disk policy:** archive = `git worktree remove` immediately; branch ref kept **14 days** post-merge/cancel, then pruned (merged ⇒ recoverable from git objects; old diffs render from git forever). Scratch never auto-deleted. Settings shows "N active worktrees · size · archived branches: M · clean up"; warning chip under 10 GB free.

### 4.3 Sessions

- **Kinds:** `agent session` (adapter-managed; drives card state; stores adapter_session_id) vs `shell session` (plain PTY; only unread dot + running-process flag; never card state). One live agent session per attempt; unlimited shells (pane tabs).
- **Session states:** `opening → live → exited(code) | killed(user) | interrupted(daemon)`.
- **Persistence:** SQLite persists cards/worktrees/attempts/sessions, adapter_session_id, last `task_progress`, and a per-session scrollback ring file (~200KB, periodic flush). PTYs die with the daemon (accepted for v1; detached session hosts are roadmap). Daily SQLite backup rotation, keep 7.
- **Browser disconnect:** sessions are daemon-owned and survive browser close/refresh/network loss (tmux-like). Reattaching replays scrollback and resumes the live stream — closing the tab never kills an agent.
- **Daemon restart reconciliation:** on boot, reattach worktrees; mark live sessions `interrupted`; running/waiting cards → error(interrupted) with one-click **resume** (`claude --resume <id>` / `codex resume`; fallback = fresh session seeded with task_get + last task_progress + git status "where you left off" block). Resume **re-passes the execution-mode flags** (sandbox/host) — a resumed session must never silently change permission mode. Old scrollback renders frozen, labeled "previous session". Auto-resume: off by default.
- **Attempts:** no VK-style parallel attempts in v1. A card keeps an ordered session history (round 1, comment round 2, conflict round 3). Fan-out compare is roadmap via the reserved attempt entity.

## 5. Orchestrator

The engine inside the daemon that drives the card lifecycle — fixed product behavior, not user-configurable: R1 queue→start (topmost `auto:on` while running < worker limit), R2 input→Waiting+push, R3 completion→Review (per-board auto-done skips review), R4 merge→archive + cascade re-check + R1. Worker limit lives in Settings (default 1). A built-in runaway guard notifies when a card runs >30 minutes. Dispatches follow §6.1's envelope: card+attempt+dispatch ids on every message, completion dedup against the live dispatch, `task_progress` as heartbeat with a >10-min soft warning (never auto-fail), circuit breaker after 3 consecutive failed attempts → error(circuit-broken), R1 moves on.

> **Automation (trigger-based rules/actions system) is deliberately out of this spec.** It is a separate future product area and will get its own design pass later; nothing in v1 depends on it.

## 6. Agent adapters

**Claude Code (primary):** orchestrator spawns interactive `claude` in the worktree PTY with `--settings` + `--mcp-config` supplied externally (repo never dirtied). Hooks (verified live 2026-07-19, CC 2.1.215 — `docs/research/cc-codex-hook-contract.md`): `SessionStart` (context injection + `session_id` capture, `source: startup|resume`), `PermissionRequest` (→ permission flag, fires ~18ms after its PreToolUse, carries `permission_suggestions`), `PreToolUse(AskUserQuestion)` (→ question flag) with `PostToolUse(AskUserQuestion)` delivering the chosen answer (~23ms) — native flag-clear for CC, no inference needed; `Stop`/`StopFailure` (completion evaluation / error). The `Notification` hook is NOT used — verified redundant (only a delayed derivative: `permission_prompt` +6s, `idle_prompt` +60s). **Env hygiene (hard rule):** the daemon scrubs `CLAUDE*` vars from every agent PTY env — a leaked `CLAUDE_CODE_CHILD_SESSION` silently disables transcript persistence and breaks `--resume`. Prompt template = card title + description + instruction to call `task_complete` when done. **Sandboxed by default:** "automatic" mode runs agents inside their **native sandboxes** (Claude Code sandbox mode; Codex `workspace-write`) — autonomous and contained; the README line is "autonomous by default, sandboxed by default". **Host/YOLO mode** (dangerously-skip-permissions on the real machine) is a first-class, easily reachable switch — one click in the add-project sheet and per-card via ⋯, single confirm, clearly labeled, no digging. "ask" mode remains for the cautious; its permission events classify as `permission` input.

**Codex:** MCP via `config.toml`; lifecycle via Codex's **official hooks** — verified live (Codex 0.144.6): 10 Claude-compatible events in `CODEX_HOME/hooks.json` (no StopFailure/SessionEnd/Notification equivalents), `session_id` in every payload, `codex resume <id>` works (`source: resume`). Ops facts: hooks are configured through an **isolated managed `CODEX_HOME` mirror** (Orca's trick — user's `~/.codex` never touched); automation needs `--dangerously-bypass-hook-trust` (else a trust-review prompt gates first run); TUI session hooks fire lazily at first submit. The legacy `notify` interface is not used — it only reports turn completion and never surfaces approvals. State fallback = the §6.1 universal stack ("Action Required" title ⇒ blocked — verified, fires ~4ms after PermissionRequest; braille spinner ⇒ working), never byte-quiescence.

### 6.1 State detection & completion doctrine (the system's main line — decision 2026-07-19, stable)

Every mechanism below is **adopted from proven production systems, never invented here** — herdr `b580103`, Orca `80e6322`, Vibe Kanban `4deb7eca`; mechanisms, thresholds, and polarity are recorded with file:line evidence in `docs/research/herdr-agent-state.md`, `docs/research/orca-agent-state.md`, `docs/research/vibe-kanban-orchestration.md`, and the live-verified hook contract in `docs/research/cc-codex-hook-contract.md`. Those docs are the implementation reference; this section is the contract. When implementation and this section disagree, this section governs; when this section is silent, the research docs' recorded choice is the default.

**Two invariants (everything else serves these):**
- **I1 — "done" is declared, never inferred.** A card reaches In Review only on an explicit completion report (`task_complete` MCP call, or the CLI self-report below). No state classifier, timer, or idleness ever moves a card right past Waiting. Both references independently converged on this (Orca: prompt-taught `worker_done` CLI; herdr: refuses task-done entirely — its "Done" is only *idle ∧ not-yet-viewed*).
- **I2 — ambiguity degrades to attention, never to false progress.** Anything unclear (agent stopped without completing, unrecognized waiting screen, classifier conflict) lands the card in Waiting with the `silent` flag — worst case the user looks at a terminal that didn't need them. Unknown screens classify **idle, never blocked** (strict-positive polarity); a false "needs attention" ping is the expensive failure and is optimized against, but a *missed* one only ever costs latency, not correctness.

**Signal precedence (one arbitration for all tiers, herdr's `recompute_effective_state` + Orca's coordinator):**
1. **Visible screen blocker overrides everything** — a rendered permission/question UI beats even a live hook claiming "working" (guards stale/lying hooks).
2. **Fresh explicit report** — hook event, MCP/CLI self-report, or in-band OSC status — with a 30-min freshness cutoff; **hook silence ≠ idle**.
3. **OSC title/progress classification** (layer 2 below).
4. **Process-tree evidence** (layer 3 below); process exit forces idle.
5. **Quiescence is a readiness gate only** (prompt injection, "can I paste"), never user-facing state.
Cross-checks: a title "working" cancels a pending done; hook-`done` fires only after a 1.5s quiet window; process-exit completion needs two consecutive idle samples + a no-child-processes veto; completion identities dedup across sources and remounts.

**The four detection layers (universal tier = all four; premium adds hooks on top):**
1. **Process-tree identity** — foreground process group of the pane shell, wrapper-unwrapping (node/bun/python/sh/nix), agent registry match; env escape hatch (`CODEGENT_AGENT=<label>`) for sandboxes that hide /proc. Numbers: 300ms tick identified / 500ms unidentified, 5s recheck, 6 consecutive misses = gone, 3s startup grace, 100ms×3 (cap 700ms) idle-confirm hold.
2. **OSC title/progress classification** — braille-spinner range U+2800–U+28FF ⇒ working; per-agent glyphs (Claude `✳` idle; Gemini `✋` permission / `✦⏲` working / `◇` idle); OSC `9;4` progress where an agent emits it (live-REFUTED for CC 2.1.215 — no `]9;` in the binary); Codex literal "Action Required" title ⇒ blocked (top priority, verified ~4ms after PermissionRequest). **Caveat (live-verified): CC's `✳` also shows during a pending permission — CC titles can never signal blocked; CC blocked comes from hooks (premium) or screen rules (universal), titles only ever say working/idle.** Titles are volunteered metadata: retained ≤256 chars, sanitized, cleared on foreground-process change, matched server-side, never surfaced.
3. **Manifest-scoped blocked patterns** — narrow, priority-ordered `contains`/`regex`/`line_regex` rules over the bottom screenful (default 24 rows) with named regions (prompt-box body, after-last-horizontal-rule); `skip_state_update` rules freeze detection on agent-owned viewer screens (transcript/scroll viewers). Re-asserted every 800ms while visible.
4. **Quiescence (readiness only)** — screen-state quiet (VT grid unchanged — our server-side emulator diffs it cheaply) + non-shell foreground; never raw byte flow (herdr shipped byte-quiescence and reverted it in 2 days: spinners are never byte-quiet; typing/resize are indistinguishable from work).

**Board mapping:** `working` → Running · `blocked`/`waiting` → Waiting for Input (premium: `question` vs `permission` sub-kind from hook/rule identity; universal: generic input-needed unless the manifest rule carries a sub-kind tag) · classified-idle with an assigned card and no completion → Waiting + `silent` (I2) · In Review **only** via I1 · `done = idle ∧ not-yet-viewed` additionally drives the unread dot on sessions.

**Completion transports (I1), in preference order:**
1. **MCP `task_complete`** — premium and any MCP-capable agent (most modern agents).
2. **CLI self-report** — MCP-less agents are taught in the dispatch preamble to run `codegent task complete --card <id> --dispatch <id>` (Orca-proven; works for anything that can run a shell command).
3. **Neither** → plain terminal session; right-moves past Waiting stay manual.
**Dispatch envelope (Orca + VK proven, all transports):** every dispatch carries card + attempt + dispatch ids and records the worktree's **before-HEAD commit** per repo (change detection + rewind-retry, VK); completions are deduped against the *live* dispatch AND store-side (write-once terminal status, conditional on `status = running` — VK's latch) so a stale retry can never complete current work; the preamble instructs "report completion exactly once, even on failure"; **`task_complete` precondition: a dirty worktree rejects the completion with the git status echoed back into the agent's own conversation** (VK's stop-gate adapted — the agent commits, then completes; nothing surfaces in our UI); `task_progress` doubles as heartbeat — progress silence >10 min shows a soft warning on the card (never auto-fail; the §5 30-min runaway guard stands); 3 consecutive failed attempts → error(circuit-broken) and R1 moves on. Supervision timings (VK-proven): 30s spawn timeout; cancel = 5s grace then process-group escalation SIGHUP (PTY-native) → 2s → SIGTERM → 2s → SIGKILL, with post-exit reaping of leftover MCP-server children; startup marks every `running` dispatch row failed — nothing self-resumes (§4 reconciliation offers the resume).

**Input-flag lifecycle:** *set* by hook events (premium), manifest blocked-rules (universal), or the silent rule (I2). *Cleared* by arbitration, not hope: native answer events where they exist (CC's `PostToolUse(AskUserQuestion)` delivers the chosen answer — live-verified, no inference needed for CC questions), answered/interrupt keystroke inference for the rest (Esc/Ctrl+C or submit with ~500ms settle and baseline revalidation — real hook racing in wins; per-agent quirks like double-Esc live in manifests; Esc emits no hook on either CLI — live-verified — so PTY-write tracking is the interrupt source), screen re-classification when the dialog leaves the screen, or the next explicit report. Manual override (`mark state` on the card, §7) is the escape hatch; the §9.2 watchdog cross-checks overrides against detection and flags mismatches.

**Session-ref harvesting (every tier):** one SessionStart-class hook per agent captures `session_id` (+ transcript path where offered) for native resume — powering §4's restart reconciliation and the rule that a native-resumed agent pane **skips ring replay** (replay + resumed TUI would double-print; replay stays for shells).

**Operational pipeline (how detection stays correct without redesign):** agent manifests are plugin kind (a) (§12) — community-maintained, date-versioned, fetched from a remote catalog with engine-version gates, locally overridable; core never owns a per-agent pattern treadmill. New/changed prompt shapes surface as latency (card sits in Running/silent), fixed by a manifest update, not a release. Nightly agent contract tests run the real CLIs against the truth table (§4.1) and OSC/glyph expectations; unknown agent versions run in a flagged degraded mode. Manifest debug tooling (rule-trace explain + screen fixture capture, herdr model) ships with the manifest engine.

**In-band status channel (plugin tier, v0.4):** a documented `codegent` OSC escape (Orca's 9999 model — JSON status vocabulary only, parsed statefully and stripped before display) lets wrapped/instrumented agents self-report state with zero networking and automatic pane attribution. Status vocabulary only; it cannot carry content.

**What we never do:** byte-quiescence as a primary signal · captured text, previews, or question content in the UI (classification reads the screen daemon-side; only state enums cross to the UI — stated plainly in the threat model) · protocol-rendered chat: **ACP is demoted out of core** — ACP mode replaces the agent's own TUI with a protocol session, the opposite of principle 2, and both reference systems solved terminal-resident orchestration without it. Revisit only if agents adopt ACP natively with TUI-preserving semantics; a future ACP client would arrive as a plugin, not core.

**MCP server (in daemon), exactly three tools:** `task_get` (title, description, acceptance notes), `task_progress` (append note to card timeline — non-blocking, doubles as resume context), `task_complete` (summary → completion truth table). **No `task_ask_user`** — questions happen in the terminal (principle 2).

**Login flow:** daemon probes agent binaries. Missing → first-run row "codex: not installed — install". Logged-out is detected at first run failure → card shows "login required"; its single action opens a real terminal session running `claude /login` — login is a terminal flow on our own surface.

## 7. UI specification

Three views per project: **Board (1) · Terminal (2) · Diff (3)**. Global chrome: project sidebar, bottom attention strip, command palette (K), browser tab-title badge `(n) codegent` where n = errors+inputs.

**Keyboard map (v1):** `1/2/3` views · `K` palette · `n` new task · `t` new terminal · Diff: `j/k` file nav, `v` mark reviewed · `Esc` clears overlays/board focus · `⌘D` split, `⌘F` scrollback search (terminal).

### 7.1 Visual system ("Nebula")

- Base `#0d1117`/`#010409`/`#161b22`/`#21262d`; borders `#30363d`/`#21262d`/hairline `#1c2128`. Text ladder `#e6edf3 / #adbac7 / #9aa4b2 / #7d8590 / #57606a`. Accent violet `#6d28d9` (active) / `#8b5cf6` (alive). Semantics: amber `#e8c163` (waiting), red `#ffa198` (error), green `#7ee2a8` (review/success). Dim-amber `#9d8b4a`.
- **Worktree identity colors:** deterministic 8-color cycle; the dot (7px) is never the sole identifier — title/branch text always adjacent; middle-ellipsis rules for long titles in pills/chips/headers.
- Type: Inter (UI) + JetBrains Mono (terminal/code/branch/stat). Sizes 9.5/10/11/12/13 only; weights 400/500 (+650 badge caps). Tabular numerals for all times/stats.
- Radii: 6 (badges/inputs/inner segments), 8 (cards/rows/menus), 999 (round chips/pills). Badge grammar: tinted bg ~9% alpha + 1px ~28% border + 9.5px 650 letterspaced caps; icon-only soft pulse (2.2s) only where semantically alive.
- Card bottom grammar: hairline → status badge → right metric (tabular) → hover chevron. Motion: spring view transitions, card-move animations, hover lifts — via Motion library. A single celebratory moment on merge (confetti micro-burst) is allowed; everything else stays quiet.

### 7.2 Sidebar (projects only)

Project rows: name + input badge (keyboard icon + count) + meta line derived by priority: `error > input (oldest) > conflict > running(count) > review(count) > "quiet · last event"`. Same derivation feeds the palette — one source of truth. Footer: relay status + machine name. "+ add project".

### 7.3 Board

Columns **Queue / Running / Waiting for Input / In Review / Done** (Waiting is derived; Done hosts a collapsed "cancelled (n)" section). Cards: title, chips (agent, worktree color-dot + branch), bottom meta row. Queue position badges; slot counter in Running header; "+ task" ghost row opens the composer (title/prompt, agent, base branch, advanced: pin to existing worktree; "Enter → Queue"). Card click targets: Waiting/Running/Error → its terminal session; Review → its diff (queue pill preselected); Done → read-only diff. Hover ⋯ on cards: start now / edit / delete / **Details** / **mark state** (running · needs-input — manual override, the escape hatch when detection wedges; the §9.2 watchdog cross-checks and flags mismatches) (+ per-state extras). **Details drawer:** full prompt/description (editable), timeline of `task_progress` notes and round history (run → comment round → conflict round), session history, links to diff/terminal/PR — the only surface where agent progress notes render (never on the card face). Worktree chip click → board focus mode (matching cards highlighted in worktree color ring, others dimmed; clear via ×/Esc/reclick). Error cards carry the action row **resume · restart · discard** (§9.1). Same-file overlap between active worktrees shows a small ⚠ "may conflict with cg/N: file.ts" — signal only, never blocks. Columns are fixed-semantic (orchestration depends on them): users can hide (auto-done hides In Review) but never add or rename columns.

### 7.4 Terminal

- **Left rail = flat session list in task language,** ordered error > input > running > review > main/scratch. Row: worktree dot + title + status glyph; second line `agent · state · elapsed`. Filled row = focused session only. Shell sub-rows indent under their task; scratch/main shells at bottom with `shell · context` lines. Unread output = violet dot (row + pane tab). Review-phase tasks stay listed (click → diff; their worktree shells remain reachable).
- **Panes:** unfocused dimmed to 75% (hover restores); draggable dividers; 2-line headers (title + status badge / mono `branch · agent · elapsed`), hover controls (⏹ stop for agents, split ⌘D, ⋯ menu: open card, diff, merge/PR, archive, open folder, ⌘F search, close) — MoreHorizontal SVG, never text glyphs. In-pane session tabs (underline style) appear only when a worktree has >1 session; "+" tab opens a shell in that worktree.
- **"+ terminal · main"** at rail bottom: Enter = shell in main; picker lists worktrees + **"in a new worktree…"** (name + base branch inline) for scratch isolation.
- Deferred-to-build details: empty states (terminal: no sessions → pointers to "+ task"/"+ terminal"; board: no cards → composer spotlight; diff: nothing to review), ⌘F scrollback search, drag-drop files into prompt, copy mode.

### 7.5 Diff

- **Review queue strip:** one pill per pending review (dot, title, ready-since + stat), ordered by ready-since; stale pills carry an "update" chip (explicit action). Active pill = current review.
- Header: title, `branch ← base`, total stat, Unified|Split toggle, **open-terminal-in-worktree** button, **Send back · N**, **Open PR** (AI-written description), **Merge ▾** (squash default / merge / rebase; disabled while stale/conflicted with "update first" affordance, offered as one-click update→merge chain).
- Files panel: M/Y/S letters, per-file stats, viewed tracking ("n/m reviewed" + progress hairline).
- Code: hunk headers, hover `+` gutter → line comment; comments queue ("queued · edit · delete") and return in one batch via Send back (card → Running with structured feedback). Round-2 niceties (interdiff, thread resolution, hash-invalidated viewed marks) are **v1.1** — v1 review = diff + viewed marks + queued comments + Send back.
- **PR tracking:** after Open PR the card carries a PR badge + link. **Merges are recorded facts, never git-ancestry inference** (VK-proven — ancestry fails under squash/rebase): merges we perform are recorded as events at merge time; PR merges are detected by polling PR state via `gh` every 60s while a PR badge is live; after a squash merge the task branch ref is reset to the squash commit (zeroes ahead/behind → follow-up rounds stay conflict-free). Explicit **"mark merged"** on the card remains the manual fallback when `gh` is unavailable. A read-only **CI checks chip** (via `gh` when available) shows check status in the review header — merging blind to CI is the alternative. Full checks panel stays on the roadmap.
- Read-only mode for Done cards (no actions, "merged <date>").
- Conflict state: red banner in queue pill + card; the action is **"open terminal to resolve"** — conflicts are never auto-repaired in v1.

### 7.6 Attention strip & palette

- **Strip (desktop):** cross-project chips in task language: `[icon] PROJECT · Task title · elapsed`, ordered error > input > review > running; cap ~4 + "+n" overflow chip → opens palette pre-filtered; click = jump to (project, task, view) — always the specific object, never just a view.
- **Palette (K):** sections ERRORS > WAITING FOR INPUT > READY FOR REVIEW > PROJECTS > COMMANDS (New task `n`, Open terminal `t`, Add project); rows `project / task · agent · elapsed`; fuzzy search across tasks/worktrees/commands. Every row deep-links per the jump spec.

### 7.7 Jump targeting (global rule)

Every cross-surface click resolves to **(project, task, view, object)**: review clicks select that review's queue pill; terminal clicks focus-or-open that exact session (replace least-recently-focused pane when full); card clicks per §7.3. No jump ever lands on a view showing a different object.

## 8. Screens beyond the main app

- **First-run (browser):** relay status line ("remote access: hosted relay ✓ — change"), agent probe rows (claude ✓ · codex missing — install), link + QR, "add project" CTA. Disappears after first project.
- **Add project sheet:** daemon-side path autocomplete (browser may be remote — never a native picker) + "git clone URL" tab; base branch (default `origin/HEAD`, fallback current; remembered); default agent (composer preselects it); **worktree setup** — per-project setup script + copy-globs (e.g. `.env`, untracked configs) that run on every worktree creation before the agent spawns (a fresh worktree without node_modules/.env is unusable otherwise); execution mode (sandboxed-auto default / host-YOLO / ask); non-git folder → refuse with one-click "git init". Empty repo (no commits) blocks card start with "first commit required".
- **Settings (single page):** link + QR (permanent pairing QR), rotate link, paired devices list, relay choice (hosted/self-host URL/cloudflared/off), service status, notification types, worker limit, disk/archive management, agent versions, theme (v1 dark-only).
- **Event log:** the per-project ticker persists to SQLite (30-day retention); an expandable log surface (filterable by card) answers "what happened while I slept". Overnight attention also survives as unread strip chips.

## 9. Failure & recovery

### 9.1 Crashed/interrupted attempts — the action row
- **resume:** same worktree, same conversation (`claude --resume` / `codex resume`; fallback context block = task_get + last task_progress + git status). Card → Running.
- **restart:** same worktree, fresh conversation with original prompt + note "previous attempt stopped midway; worktree may contain partial work". **Never `git reset`.** Card → Running.
- **discard:** archive worktree (branch kept 14d), card → Queue as `auto:off` (won't auto-restart into the same failure); undo toast.
One click each, no dialogs, no error text shown anywhere (principle 1).

### 9.2 Other failures
- **Runaway agent:** built-in guard pushes "still running · 34m"; intervention = open pane, Esc, steer. Elapsed time on running chips.
- **Relay outage:** daemon keeps working; desktop footer flips "relay down · local OK" + thin banner; **Web Push goes daemon → push service directly (never via relay)**, so a "relay connection lost" push still arrives (2-min grace). On reconnect: event replay + digest push ("missed: 1 review ready, 1 question"). No action queuing over a dead relay (dangerous PTY writes).
- **Daemon restart:** §4.3 reconciliation + global banner listing interrupted cards.
- **Git failures at start:** name collisions auto-suffix silently; other failures → error(start_failed) with retry; details in the session terminal, not the card.
- **Broken worktree (external deletion):** `broken` state, offer re-create from branch.

## 10. Relay & security

- **Protocol:** browser ⇆ daemon E2E via libsodium — X25519 device keys, per-connection key exchange, XChaCha20-Poly1305 frames over WSS through the relay. Relay sees device IDs, frame sizes, timing — never content. README states it plainly; self-host = same binary (`docker run codegent/relay`).
- **Pairing:** the access link *is* the credential — `https://relay.codegent.io/d/<deviceID>#k=<key>` (fragment never reaches the server), trust-on-first-use. Settings lists paired browsers with **per-device revoke**; new-device pairing triggers a **confirmation notification** on already-paired surfaces; **rotate link** kills all old links. Frames use `crypto_secretstream` per direction (replay/reorder protection). On a shared LAN, traffic goes **LAN-direct** (relay brokers discovery only). No accounts in v1.
- **Hosted relay:** free, unlimited, no registration (locked). No public "forever" promises in messaging — self-host parity (same binary) is the stated guarantee. Protocol reserves a policy frame (rate/conn caps) so limits could ship later without breaking clients — defaults unlimited.
- **cloudflared option:** daemon already serves HTTP; setup writes a config for users who prefer their own tunnel.
- **Known boundary (documented):** remotely-served UI is trusted-on-first-use from the relay; mitigation: **signed UI manifest verified by a pinned bootstrap ships in v0.3**; the paranoid path is self-hosting the relay. The published threat model states "honest-but-curious relay" out loud.
- **Local:** daemon binds localhost; first-open token in URL fragment.

## 11. Notifications

- **Web Push (VAPID):** payloads use standard Web Push encryption and carry **no content** (principle 1) — only project, task title, kind, elapsed. Sent by the daemon directly to browser push services (never through the relay), so pushes survive relay outages.
- **Push types (only three):** waiting-for-input (question/permission — never silent), error, review-ready. Per-card notifications update in place, never stack. A "relay connection lost" push after a 2-minute grace. Reconnect sends one digest ("missed: 1 review ready, 1 question"). Nothing else pushes — no "running" spam.
- **Permission ask is contextual:** the first time any card enters Waiting, the strip shows a one-time "enable notifications" chip. Never a modal on load.
- **In-app:** toasts for merges and completed background actions; unread dots (rail rows, pane tabs); tab title badge `(n) codegent`; no sounds in v1.

## 12. Plugins

A first-class, **strong** extension system — modeled on what compounds at scale (herdr's zero-review marketplace and plugin panes, oh-my-zsh's topic registry, opencode's npm plugins). Concepts only from AGPL references — no code, preserving our CLA/dual-license option.

- **Kinds (v1, ships v0.4):** (a) **agent adapters** — declarative TOML manifest (binary + wrapper-unwrap hints, state-detection rules per §6's universal tier: OSC/title glyphs, blocked patterns; optional hooks wiring, badge color) + optional JS module for custom lifecycle mapping; manifests are remote-updatable and locally overridable (herdr model); the community adds agents without core PRs; (b) **event hooks / automations** — subscribe to the daemon's versioned event stream (card transitions, sessions, merges) and react via shell command or webhook; (c) **palette commands**.
- **v1.1 kinds:** UI panes (terminal-adjacent panels, herdr-style) and themes.
- **Distribution:** `codegent plugin install gh:user/repo`; the `codegent-plugin` GitHub topic is the zero-review registry, mirrored on a docs-site plugins page. Install = trust (oh-my-zsh model), stated plainly; plugins run in-daemon.
- **Stability contract:** the event schema and adapter manifest format are versioned with a compatibility guarantee from v1.

## 13. Mobile (phase 2 — starts immediately after desktop v1.0)

Deliberately sequenced after the desktop scope is complete; the design exists and returns as specced here. Rules: bottom tab bar **Board · Terminal · Diff** with badge counts; no sidebar/strip/palette (top-bar project sheet + search). **Board:** horizontal snap-paged kanban (one full-width column per page, column pill strip as jump nav, no cross-column drag — card actions carry state). **Terminal:** master→detail — sessions list (attention-first) → full-screen session with **keyboard accessory bar** (text field + Enter, Esc, Tab, ↑ ↓ into the PTY); title tap = quick-switch sheet. **Diff:** master→detail review queue → approve-oriented unified review with bottom action bar (Send back / Merge ▾). **PWA:** manifest + guided iOS install flow — Web Push on iOS only works from an installed PWA, so the install prompt is part of the first remote pairing. **Offline duo:** "can't reach relay" vs "machine offline · last state HH:MM" (cached read-only snapshot). Long-press = card action sheet.

## 14. Install & distribution

**Front door — zero commitment:** `npx codegent-cli` runs the daemon in the foreground with no service, no PATH changes — the README's first command. (npm package name is `codegent-cli` — the unscoped `codegent` is taken by an unrelated same-category package; the package's `bin` still installs the on-PATH command as `codegent`, so `codegent …` subcommands are unchanged. Primary install remains `curl … | sh`.) Making it permanent:

```
curl -fsSL https://codegent.io/install | sh
```
Zero questions: detect OS/arch → install binary to `~/.codegent/bin` → PATH → install user service (launchd/systemd; `--no-service` opt-out) → print + auto-open `http://localhost:4666` (default port 4666, auto-increments if busy) → everything else happens in the browser first-run (§8). Also: `brew install codegent`; WSL = same script. **No Docker anywhere in the daemon install** — Docker exists only for the relay server (so the hosted relay can move from GCP to any VM provider trivially). **Always-on recipe (first-class docs):** the SAME one-liner `curl … | sh` on any $5 VPS or home server installs the native service — agents run on the real machine (YOLO included) — then `codegent link` QR pairs it; agents keep working with the laptop closed. First-run shows a one-line pointer to the guide.

**CLI:** `codegent` (start + open), `codegent link [rotate]`, `codegent pair list|revoke`, `codegent service enable|disable`, `codegent task add "…"`, `codegent doctor`, `codegent update` (self-update; prompts when sessions active).

## 15. Testing strategy

- **Agent simulator:** a deterministic fake-agent binary (reads prompt; emits hook/notify events; asks a question; completes with a diff) → full lifecycle integration tests without burning tokens. Nightly optional real-agent smoke (`claude -p` trivial task).
- **Unit:** card/worktree state machines (every transition + illegal ones), completion truth table, crypto handshake vectors, adapters' hook payload parsing, derivation rules (sidebar/palette counts).
- **Integration:** real PTY spawn, worktree create/merge/archive cascade incl. stale/conflict, daemon-restart reconciliation, scrollback ring persistence.
- **E2E:** Playwright against daemon+UI — board drag, terminal typing, pairing flow with a local relay, review round-trip (comment → send back → round 2).
- **Relay:** loopback E2E roundtrip + chaos (disconnects, backoff, digest on reconnect).
- **CI:** Buildkite (free for OSS; our own fast runners — Linux on cloud VMs, macOS on a Mac mini) — macOS + Linux matrix; release builds in the same pipeline. GitHub Actions deliberately avoided (slow); Cirrus CI shut down 2026-06. Nightly **agent contract tests** run the real CLIs against the truth table (§4.1) to catch hook-contract churn.

## 16. Milestones & launch

> **Execution mapping:** each milestone ships via a dedicated implementation plan under `docs/superpowers/plans/` — Plan 1 = v0.1 (core, written: `2026-07-19-codegent-v01-core.md`), Plan 2 = v0.2 (orchestration + adapters), Plan 3 = v0.3 (relay + review + install), Plan 4 = v0.4→v1.0 (plugins + polish + launch). Mobile (§13) gets its own plan post-launch (v1.1). Plans 2–4 are written just-in-time, folding in learnings from the previous plan's execution.

- **v0.1:** daemon+UI localhost; terminal + worktrees + board manual mode (no orchestration).
- **v0.2:** orchestrator + Claude Code adapter end-to-end; completion truth table; error/recovery actions. Codex adapter.
- **v0.3:** relay + pairing (device confirm/revoke, signed UI manifest) + Web Push; review queue incl. stale cascade; **universal terminal-state tier** (process-tree + OSC classification + manifest patterns, §6); installer + `npx codegent-cli`; Settings + first-run.
- **v0.4:** **plugin system core** (adapter manifests, event hooks, `codegent plugin install`, topic registry) + polish pass — Motion animations, empty states, event log, docs site (incl. the always-on VPS guide).
- **v1.0 launch:** Show HN + X + r/ClaudeAI; README hero GIF (card added remotely → agent starts at home → push → answer in the terminal → merge confetti); honest comparison table incl. a **first-party row** (Claude Remote Control / Codex cloud) and Orca/VK; pinned **native-Windows tracking issue + milestone** in the README; Discord; weekly changelog with GIFs.
- **v1.1 (immediately after launch):** **Mobile phase** (§13) + review round-2 niceties + plugin panes/themes.

**Post-v1 roadmap (the "all of Orca, and further" promise, in rough order):**
1. Trigger-based automation system (own design pass — parked intact)
2. Fan-out: one prompt → N agents in N worktrees, compare diffs, merge the winner (attempt entity already reserved)
3. Design Mode, browser-native: dev server proxied through the daemon with an injected inspector — click an element, its HTML/CSS + screenshot goes into the agent prompt (our proxy-injection answer to Orca's embedded-Chromium mode)
4. GitHub & Linear import (issues → cards; PR checks panel)
5. Account switcher + usage/rate-limit tracking for Claude/Codex accounts
6. Machine switcher (multiple paired daemons in one UI)
7. SSH/remote worktree targets
8. File previews (markdown/image/PDF) and drag-drop files into the agent prompt
9. `codegent` CLI automation surface (agents driving codegent programmatically, like Orca's CLI)
10. detached session hosts (PTYs survive daemon updates) · signed UI builds + SRI · native Windows · light theme · computer use

**Deferred / cut from v1 (explicit):** trigger-based automation system (entire area — future spec) · fan-out N-agent compare (schema reserved) · machine switcher (one machine per link) · GitHub/Linear import · Design-Mode browser proxy · SSH targets · account usage tracking · parallel attempts UI · full PR-checks panel (read-only chip ships in v1) · preempt/pause · non-git folders · accounts · light theme · native Windows · agent conflict-resolution loop (v1 resolves conflicts in the terminal) · push types beyond waiting/error/review.

## 17. Risks & week-1 spikes

1. **Bun single-binary + native PTY:** validate `bun build --compile` with `Bun.spawn({terminal})` on macOS/Linux (the API shipped Dec 2025 — young); fallback = Rust portable-pty sidecar process.
2. **Hook reliability:** verify CC `Stop`/`Notification` firing patterns and Codex official-hook coverage against the truth table; validate the §6.1 stack (OSC glyphs/titles, process-probe cadences, blocked-rule polarity) against the real CLIs — adopted thresholds from the research docs are the defaults, changed only on contract-test evidence.
3. **`--resume` behavior:** confirm session-id capture and resume fidelity for both agents; fallback context block quality.
4. **Relay latency feel:** typing echo over hosted relay from a remote network; measure before promising.
5. **ghostty-web hardening (sole terminal engine):** Coder-backed and active (June 2026 burst: scrollback fixes, latency, Release Please setup; mouse tracking Jan 2026, IME Dec 2025). Our architecture needs no engine serialize/search APIs — reattach = daemon replays the raw scrollback ring through the parser; search runs over the ring text. Spike therefore targets exactly three risks with hard pass criteria: (a) 20-pane create/destroy soak against the open memory-corruption issue (#141), (b) throughput under `yes`/large-build output, (c) IME matrix (incl. Korean, #119) + ring-replay-on-reattach correctness. Gaps found are fixed by patching/contributing upstream, not by swapping engines.

## 18. Naming glossary (product = English)

task · card (board widget) · worktree (never "workspace") · session (agent session / shell session) · Queue / Running / Waiting for Input / In Review / Done / cancelled · badges: RUNNING / QUESTION / PERMISSION / ERROR / READY FOR REVIEW · actions: resume / restart / discard / update / Send back / Open PR / Merge · review queue · relay · pairing link.

---
*Design history: 43 interactive mockup iterations + 4 independent audits (IA, visual, journeys, domain model) — archived under `.superpowers/brainstorm/` (gitignored). The mockup is a reference sketch; every screen gets full-state treatment during implementation.*
