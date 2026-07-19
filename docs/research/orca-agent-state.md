# Orca: TUI-agent state classification from outside (research)

Date: 2026-07-19 · Source: `github.com/stablyai/orca` (MIT, Lovecast Inc.) · Commit studied: `80e632282c87fce15ea80a7db4105ea68a509f6b` (2026-07-19) · Clone kept at `/Users/burakgon/.claude/jobs/b3095dd6/tmp/orca` (shallow, depth 50). All `file:line` refs below are relative to that repo root at that SHA.

**Headline: Orca is NOT tmux-based and does NOT rely on output scraping as its primary signal. It is an Electron app hosting one node-pty per pane in a restart-surviving daemon, and it classifies agent state {working, blocked, waiting, done} through a five-layer evidence stack: (1) managed native hooks installed into ~17 agents' own config files, POSTing to a loopback HTTP server; (2) OSC terminal-title classification (glyphs + spinner ranges + keyword regexes); (3) foreground-process polling of the PTY's process tree (`ps` stat `+`); (4) user-keystroke inference (Esc/Ctrl+C) for events agents never emit; (5) a 3s output-quiescence timer as the last-resort fallback. Content scanning of pane text exists but is deliberately narrow (Codex onboarding/trust prompts only). The layers have explicit precedence, veto rules, and quiet-window debounces — the numbers are the real IP.**

## 1. Process model

- One PTY per pane via **node-pty**, hosted in a background **daemon process** that outlives Electron restarts (`src/main/daemon/` — `daemon-server.ts`, `session.ts`, `pty-subprocess.ts`). No tmux anywhere in the hosting path.
- Each daemon session runs a server-side **`@xterm/headless` emulator + SerializeAddon** (`src/main/daemon/headless-emulator.ts:1-13`), default scrollback 5000 lines (`DEFAULT_SCROLLBACK`, headless-emulator.ts:59). Reattach = serialize the headless screen+scrollback to ANSI and replay into the renderer's xterm.js. The daemon's emulator is write-only — it never answers terminal queries (contract comment headless-emulator.ts:28-35).
- Agents keep their full interactive TUI; the renderer pane is a live xterm.js view of the same byte stream. Orca's own UI (sidebar dots, dashboard rows, worktree cards) is fed from the side channels below, not from pane content.
- The only tmux in the codebase is a **fake**: for Claude Code's experimental Agent Teams, Orca sets `TMUX=/tmp/orca-claude-agent-teams/<id>,0,1`, `TMUX_PANE=%1`, `TERM=screen-256color` and puts a shim `tmux` binary on PATH; Claude's `tmux split-window` calls are intercepted and turned into native Orca panes (`src/main/runtime/claude-agent-teams-service.ts:24-70`). If our prompt's "tmux-based" framing came from an early Orca, that architecture is gone at this SHA.

## 2. State detection — the layer stack

Canonical states: `AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done']` (`src/shared/agent-status-types.ts:18`). Explicit status "normally comes from hooks"; the file's header states outright: *"We still do not infer status from terminal titles anywhere in the data flow"* (agent-status-types.ts:1-6) — that claim covers the **explicit status pipeline** only; titles and process polling drive a parallel completion/attention pipeline (§2.2–2.3).

### 2.1 Layer 1 (primary): managed native hooks → loopback HTTP

- `AgentHookServer` (`src/main/agent-hooks/server.ts:492`) binds `127.0.0.1` on a **random port** (`listen(0, '127.0.0.1')`, server.ts:1646), auth via header `x-orca-agent-hook-token` = `randomUUID()` (server.ts:1567, 1584). Body cap **1 MB** (`HOOK_REQUEST_MAX_BYTES`, `src/shared/agent-hook-listener.ts:68`), slowloris timeout **5 s** (listener.ts:76).
- Per-agent installer services write a managed `/bin/sh` (or `.cmd`) script and register it in the agent's own hooks config. Claude's script (`src/main/claude/hook-service.ts:82-134`) POSTs the raw hook JSON as form fields with `curl --connect-timeout 0.5 --max-time 1.5` and always `exit 0` (fail-open). Pane identity comes from env vars injected at PTY spawn: `ORCA_PANE_KEY`, `ORCA_TAB_ID`, `ORCA_AGENT_LAUNCH_TOKEN` (`src/main/providers/local-pty-provider.ts:72-75`, `src/main/runtime/orca-runtime.ts:20608`, 18827).
- **Restart-survival trick:** the script first sources an **endpoint file** (`endpoint.env` / `endpoint.cmd`, dir mode 0700, file 0600, atomic tmp+rename, shell-safe-value validation) that always holds the *current* port/token — because a PTY that outlived an Orca restart has stale env baked in (hook-service.ts:94-110; `writeEndpointFile`, listener.ts:3996-4070).
- Events → state mapping is per-agent in `src/shared/agent-hook-listener.ts` (4,070 lines). Claude (`normalizeClaudeEvent`, listener.ts:2599-2611):
  - `UserPromptSubmit` | `PostToolUse` | `PostToolUseFailure` | `PreToolUse`(non-AskUserQuestion) → **working**
  - `PermissionRequest` | `PreToolUse` with tool `AskUserQuestion` → **waiting**
  - `Stop` | `StopFailure` → **done** (`is_interrupt: true` → `interrupted` flag, listener.ts:2694-2695)
  - A lead `Stop` while the tracked subagent roster still has a working child re-emits **working**, not done (listener.ts:2717-2723).
- Status entries carry `receivedAt` + `stateStartedAt`; freshness cutoff `AGENT_STATUS_STALE_AFTER_MS = 30 min` (agent-status-types.ts:258). Last statuses persist to `last-status.json` (250 ms trailing debounce, atomic write, file version 2; server.ts:110-127) and are replayed on restart flagged `isReplay`; a separate `runtimeObservedStatusPaneKeys` set distinguishes hydrated rows from live evidence (server.ts:515-517).

### 2.2 Layer 2: OSC terminal-title classification

`detectAgentStatusFromTitle` (`src/shared/agent-title-status.ts:137-203`) maps titles → `'working' | 'permission' | 'idle' | null`:

1. Gemini glyphs first (strongest): `✋` U+270B → permission, `✦` U+2726 / `⏲` U+23F2 → working, `◇` U+25C7 → idle (`src/shared/agent-title-core.ts:21-24`).
2. Claude idle prefix `✳` U+2733 (`CLAUDE_IDLE`, agent-title-core.ts:14).
3. **Braille spinner range U+2800–U+28FF → working** (agent-title-core.ts:48; Claude/Codex/Grok/Pi all animate braille spinners into their titles while busy).
4. Gate: title must contain a known agent name, else `null` (agent-title-status.ts:172-177).
5. Keyword regexes with path-safe boundaries (`(?<![\w./\\-])(ready|idle|done)(?![\w\-])`, same for `working|thinking|running`; agent-title-core.ts:31-41) — built to reject `~/codex/ready` and `reworking`.
6. Literals `action required` | `permission` | `waiting` → permission (agent-title-status.ts:179-181).
7. Prefix `". "` → working, `"* "` → idle (agent-title-status.ts:189-194).

Titles feed (a) `createAgentStatusTracker` transitions working→idle (`onBecameIdle`) and idle/permission→null (`onAgentExited`) (agent-title-status.ts:51-92), consumed by both renderer and main (main re-parses every PTY chunk's OSC titles in byte order, orca-runtime.ts:6189-6217); (b) the completion coordinator (§2.6). High-churn titles are normalized to stable labels before storage (Pi animates every 80 ms; Grok rotates phrases; agent-title-status.ts:97-135).

### 2.3 Layer 3: foreground-process polling (the process-exit backstop)

- POSIX: one `ps` process-table snapshot shared across all panes with a **500 ms TTL** and single-flight dedup (`src/shared/process-table-snapshot.ts:13-22`). Per-pane logic walks descendants of the shell PID, scores candidates `(+10_000 if ps 'stat' contains '+') + depth` — `+` marks the foreground process group — and matches the command line against the agent registry (`src/main/providers/agent-foreground-process.ts:43-48, 108-132`). Windows uses a PowerShell CIM query (~10-40x costlier; noted at `agent-completion-coordinator.ts:48-50`).
- Command-line recognition handles interpreters: `node …/node_modules/@openai/codex/…`, `python -m <module>`, quoted/escaped tokens, packaged binary prefixes (`codex-aarch64-…`) (`src/shared/agent-process-recognition.ts:51-96, 284-320`). Headless one-shots (`claude -p …`) are filtered out of TUI recognition (recognition.ts:288-294).
- The daemon also exposes node-pty's cheap live `.process` name plus an optional `confirmForegroundProcess()` process-table confirmation (`src/main/daemon/session.ts:48-56`).

### 2.4 Layer 4: input-intent inference (watching the USER, not the agent)

For signals agents never emit, Orca watches renderer keystrokes and synthesizes state, guarded by a baseline check so any racing real hook wins:

- **Interrupt inference**: plain Esc or Ctrl+C while status is fresh-`working` arms a **500 ms settle timer** (`AGENT_INTERRUPT_SETTLE_MS`, `src/shared/agent-interrupt-intent.ts:5`); if no hook updated the exact baseline (same `updatedAt`, `stateStartedAt`, `prompt`, `agentType`), the server emits `done + interrupted: true` (`agent-interrupt-inference.ts:96-236`; server-side revalidation `server.ts:578-660`). Per-agent rules: Droid's Ctrl+C never interrupts (server.ts:596-600); opencode/copilot need a **double Esc** (first Esc is an editor cancel; server.ts:601-610); Gemini flushes immediately because it emits its own idle hook right after an accepted interrupt (agent-interrupt-inference.ts:43-50). Working panes with live subagent children refuse the inference (server.ts:624-630).
- **Question-answered inference**: Claude emits **no hook** when the user answers `AskUserQuestion`, so the amber wait would linger; the renderer reports the submit keystroke and the server restores the pre-wait state (`inferQuestionAnswered`, server.ts:662-723).

### 2.5 Layer 5: output quiescence (last resort only)

Used only by `waitForTerminal({condition: 'tui-idle'})` when no title/hook/ready-banner evidence exists: poll every **2 s** (`TUI_IDLE_POLL_INTERVAL_MS`), and if the foreground process is a non-shell and the PTY has been output-quiet for **≥ 3 s** (`TUI_IDLE_QUIESCENCE_MS`), resolve idle; overall default timeout **5 min** (`orca-runtime.ts:27794-27796`, fallback polls at 23493-23520, 23565-23587). Quiescence is never used to flip the primary status UI — only to gate prompt injection / readiness.

### 2.6 The completion coordinator: merging the layers

`src/renderer/src/components/terminal-pane/agent-completion-coordinator.ts` fuses three completion sources (`'hook' | 'title' | 'process-exit'`) per pane:

| Constant | Value | Meaning |
| --- | --- | --- |
| `ACTIVE_POLL_INTERVAL_MS` | 750 | process poll cadence while a recognized agent is foreground (line 41) |
| `IDLE_POLL_INTERVAL_MS` | 2 000 | cadence with agent evidence but no live foreground agent (line 40) |
| `HIDDEN_POLL_INTERVAL_MS` | 3 000 | hidden panes: backstop only (line 47) |
| `NO_EVIDENCE_POLL_INTERVAL_MS` | 15 000 | costly hosts (Windows CIM), no agent evidence (line 54) |
| `NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS` | 10 000 | any output/title/hook re-arms full cadence this long (line 58) |
| `INSPECTION_TIMEOUT_MS` | 15 000 | one inspection's budget (line 59) |
| `PENDING_TITLE_TTL_MS` / max | 15 500 / 30 000 | generic idle title held until a process probe proves an agent owns the pane (lines 60-61, 467-481) |
| `COMPLETION_REPLAY_GUARD_MS` | 1 000 | dedupe identical completion tokens (line 62) |
| `HOOK_DONE_QUIET_MS` | 1 500 | quiet window before a hook `done` fires — Pi/OMP emit milestone dones mid-mission; resumed work cancels it (lines 63, 381-412) |
| `CODEX_ATTENTION_QUIET_MS` | 1 500 | debounce Codex `PermissionRequest` OS-notification; "Approve for me" auto-resolves inside the window (issue #8387; lines 64-69) |
| poll jitter / backoff | ±10 % / ×2^errors capped 10 s | lines 669-681 |

Key rules: only hook-state `done` counts as completion; `waiting`/`blocked` are "attention", raised separately and never end the turn (lines 78-90). Process-exit completion needs **two consecutive idle samples** plus a `hasChildProcesses === false` veto (macOS transiently reports no foreground child during prompt handoff; Codex briefly shows shell foreground while children work — lines 506-560). Generic completion titles ("shell restored cwd title") are held pending until a fresh process inspection validates an agent still owns the pane (lines 758-830). A title "working" signal cancels a pending hook-done (lines 730-752). Completion identities are deduped across pane remounts via a module-scoped map (lines 30-38, 269-287).

`getTerminalAgentStatus` (main, `orca-runtime.ts:11408-11448`) shows the precedence for "can I inject a prompt": live title `permission` → permission; tail-text blocked-reason (unless a live title clears it) → permission; fresh explicit hook status → wins **unless** the title blocks it or a confirmed shell foreground contradicts it; else title status; else foreground-process recognition. Prompt sends re-check every **150 ms up to 1 050 ms** (`src/main/runtime/rpc/terminal-agent-send-guard.ts:3-4`).

### 2.7 Narrow content scanning (the only pane-text reading)

`WAIT_BLOCKED_KEYWORD_PATTERN = /press enter|press t to trust|do you trust|trust this|trusted workspace|update available|choose working directory|codex just got an upgrade|hooks need review/` — scanned per-chunk over the new bytes plus a **31-char carry**, min interval **50 ms**, against a retained tail of ≤ 2000 lines / 256 KB (`orca-runtime.ts:26324-26334`, 6252-6282). Confirmed hits classify a *reason* enum (`codex-trust-workspace`, `codex-update-prompt`, `codex-cwd-prompt`, `codex-model-migration-prompt`, `codex-hooks-review-prompt`, `codex-interactive-prompt` — `findTerminalWaitBlockedSignal`, orca-runtime.ts:27973+; `detectTerminalWaitBlockedReason` at 27843). Same tail powers per-agent **ready banners** (`OpenAI Codex` + `model:` + `directory:`; Antigravity header + `gemini` + a lone `>` line; Cursor prompt without busy spinner) used only as tui-idle readiness evidence (`isKnownReadyPromptPreview` orca-runtime.ts:27830, per-agent matchers 27905-27971). This is onboarding/injection plumbing, not the status pipeline.

### 2.8 OSC 9999: in-band status side channel

`\x1b]9999;{json}` (BEL or ST terminated) parsed statefully from the PTY stream and **stripped before display** (`src/shared/agent-status-osc.ts:4-86`; 64 KB pending cap). Payload = the same normalized status JSON as hooks. Used by *in-process* clients — OMP's Orca overlay prints it into its own stdout — zero-network and inherently pane-attributed, but "cannot replace the pipeline" because it carries status only, not the full hook vocabulary (`docs/agent-status-over-wsl.md:187-190`). Parsed in both main (orca-runtime.ts:2344, 6193-6224) and renderer transport, including for hidden/model-owned PTYs with no visible pane.

## 3. Input-needed classification

- **waiting** = permission requests and interactive questions: Claude `PermissionRequest` / `AskUserQuestion`-PreToolUse; Codex `PermissionRequest` (listener.ts:3207-3209); opencode/mimo `PermissionRequest`/`AskUserQuestion` (listener.ts:3245-3250); Droid ask-user or high-risk `PreToolUse`, permission Notifications (listener.ts:3479-3499).
- **blocked** = Copilot only at this SHA: `Notification` with `notification_type` ∈ {`permission_prompt`, `elicitation_dialog`}, plus `ask_user` tools (listener.ts:3359-3374). UI treats waiting and blocked identically as "attention" (coordinator.ts:84-90); the distinction is provenance, not severity.
- Notably **Claude's `Notification` hook is NOT registered** (comment at listener.ts:2593-2598); Claude's question-wait is derived from `PreToolUse` + tool name. Gemini has **no permission hook at all** — its ✋ title glyph is the only waiting signal (upstream limitation; `src/main/gemini/hook-service.ts:30-35`).
- **Content in UI — where Orca diverges hard from codegent:** hook payloads carry and Orca *displays* `prompt` (user's prompt text), `toolName` (≤60 chars), `toolInput` preview (≤160), `lastAssistantMessage` (≤8 000 chars, expanded inline in dashboard rows), and `interactivePrompt` — the **full AskUserQuestion JSON (≤16 000 chars) rendered as a live question card** (agent-status-types.ts:233-251). Some normalizers even read the agent's transcript files (`readLastAssistantFromTranscript`, listener.ts:969; 4 MB scan cap at :876) to recover the last assistant message. codegent must drop every one of these fields and keep only `{state, timestamps, interrupted}`.

## 4. Per-agent specialization

- **Launch registry** `TUI_AGENT_CONFIG` (`src/shared/tui-agent-config.ts:76-378`): ~35 agents with `detectCmd`/aliases, `launchCmd`, `expectedProcess`, `promptInjectionMode` (`argv` | `flag-prompt` | `flag-prompt-interactive` | `flag-interactive` | `hermes-query` | `stdin-after-start`), draft-prefill flags (`claude --prefill`; Pi via env `ORCA_PI_PREFILL` read by an injected extension), paste-readiness signals (Codex: wait for its composer `›` prompt after bracketed-paste enable), and **trust preflights** — Orca pre-writes the exact trust artifact the agent's first-run menu would write (Cursor `.workspace-trusted`, Copilot `trustedFolders` in `~/.copilot/config.json`, Codex `config.toml` project trust) so onboarding menus never swallow injected prompts.
- **Hook installers** exist for 17 sources (`HOOK_SOURCE_BY_PATHNAME`, listener.ts:3945-3963): claude, codex, gemini, antigravity, amp, opencode, mimo-code, cursor, pi, omp, droid, command-code, grok, copilot, hermes, devin, kimi. Formats vary: Claude-style `settings.json` hooks; Codex `hooks.json` + `config.toml` trust hashes; Kimi TOML; OpenCode a JS plugin; Pi/OMP a generated JS extension that subscribes to the agent's own event API in-process and POSTs (`src/main/pi/agent-status-handler-source.ts`).
- **Codex isolation trick:** rather than mutate the user's `~/.codex`, Orca launches Codex with `CODEX_HOME` pointed at an **Orca-managed mirror** of the system config with hooks and trust entries added (`src/main/ipc/pty.ts:999-1002`, `src/main/codex/codex-config-mirror.ts`, hook-service.ts:75-88 — events `SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop`; the PermissionRequest hook exits without a decision so Codex's own approval UI still renders).
- Env injected into every PTY: `ORCA_AGENT_HOOK_PORT/TOKEN/ENV/VERSION/ENDPOINT` + pane identity (orca-runtime.ts:1972-1976). Nothing is injected into the agent's *prompt* for status purposes (orchestration preambles are separate, §6).

## 5. Claude Code specifics

- Ten managed events (`CLAUDE_EVENTS`, `src/main/claude/hook-settings.ts:29-61`): `UserPromptSubmit, Stop, StopFailure, SubagentStart, SubagentStop, TeammateIdle, PreToolUse(*), PostToolUse(*), PostToolUseFailure(*), PermissionRequest(*)` in `~/.claude/settings.json` (idempotent add/remove of only Orca's managed command).
- Subagent/teammate roster per pane from `SubagentStart/SubagentStop/TeammateIdle` plus folding of `Stop`'s `background_tasks` field where unambiguous (listener.ts:2678-2693); lead `done` is suppressed to `working` while children run; child `PermissionRequest`/`AskUserQuestion` displaces the lead state and stashes it for restore (listener.ts:2617-2664). Roster cap 32 subagents (agent-status-types.ts:277).
- `is_interrupt` on Stop → `interrupted` (listener.ts:2694-2695); a post-interrupt late `working` within **15 s** is suppressed (`INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS`, server.ts:113).
- Session resume: hook payloads carry the provider `session_id`; Orca stores it (`providerSession`) and rebuilds exact CLIs — `['claude','--resume', id]`, `['codex','resume', id]`, `['gemini','--resume', id]`, droid/grok/devin likewise (`src/shared/agent-session-resume.ts:232-252`).
- The managed hook script skips itself when `DEVIN_PROJECT_DIR` is set (Devin imports `.claude` hooks by default; attribution guard, hook-service.ts:55-61, 85-93).

## 6. Task/queue orchestration

- SQLite-backed coordinator (`src/main/runtime/orchestration/coordinator.ts` + `db.ts`): task DAG pre-created via RPC; loop polls **every 2 s** (`DEFAULT_POLL_MS`, coordinator.ts:87), **max 4 concurrent** dispatches (line 88), creates at most one worker terminal per tick (lines 396-404).
- **Done-detection is worker self-report, not hooks:** dispatch injects the task prompt into the worker's TUI (`sendTerminalAgentPrompt`) prefixed by a generated preamble that teaches the agent to shell out to `orca orchestration send --type worker_done --task-id … --dispatch-id …` ("REQUIRED when done — even on failure … send worker_done exactly once"; `preamble.ts:57-80`), plus `heartbeat` every **5 min** (preamble.ts:39); the coordinator warns (never auto-fails) after **10 min** silence (`HUNG_THRESHOLD_MS`, coordinator.ts:90-95, 234-248). `dispatchId` in the payload stops a stale retry's completion from finishing the current dispatch (preamble.ts:6-12). Escalations fail the dispatch; **circuit breaker at 3 failures** → task `failed` (coordinator.ts:322-330). Decision gates block tasks for human resolution (coordinator.ts:333-357). Stale-base guard refuses dispatch when the worktree is > **20 commits** behind unless `allow-stale-base: true` (coordinator.ts:43, 436-460).
- The hook/status stack from §2 feeds orchestration *readiness*, not completion: `waitForTerminal('tui-idle')` (title-idle | explicit-idle | ready-banner | blocked-reason | quiescence; §2.5) gates prompt injection, and **push-on-idle** delivers queued inter-agent messages by pasting into the PTY then sending `\r` separately after **500 ms** (Claude treats large writes as paste and swallows an embedded `\r`; `deliverPendingMessages`, orca-runtime.ts:23611-23678). Cursor Agent gets the paste but never the synthetic Enter (submit stays user-owned, lines 23643-23649). Hook `done`/attention also drives OS notifications and the sidebar Kanban-ish dots ("smart-attention", coordinator.ts:84-90).

## 7. Session persistence / reattach (ring-replay relevance)

- PTYs live in the daemon; Electron reattaches by session id. Restore = `@xterm/headless` serialize (screen + scrollback ANSI, absolute-cursor variant) + incremental history log with **5 s checkpoints**; pending-output records capped at **2 MB** (overflow → fall back to one full snapshot) and NDJSON frames at **16 MB** (`src/main/daemon/session.ts:31-40`). Cold restore replays saved scrollback as scrollback-only so a dead TUI isn't revived as the live screen (`daemon-pty-adapter.ts:44-48`).
- Flow control: daemon can `pause()` node-pty reads so a flooding child blocks on the kernel buffer; a lost resume auto-heals after **5 s** (`PRODUCER_PAUSE_FAILSAFE_MS`, session.ts:41-45).
- Shell readiness uses an injected marker `\x1b]777;orca-shell-ready\x07` emitted by Orca's shell-startup env and scanned byte-wise out of the stream (`src/main/shell-ready-marker-scanner.ts:1-2`); timeout **15 s** (session.ts:23). Startup commands are held until the marker (post-ready flush gate).
- Status continuity across restart: `last-status.json` hydration (§2.1) + endpoint-file re-sourcing means a daemon-surviving agent resumes posting to the new server instance without relaunch — explicitly an acceptance criterion (`docs/agent-status-over-wsl.md:216-222`).
- Remote parity: the same shared listener runs inside an SSH relay on the remote host; events cross Orca's mux tagged with `connectionId` (server.ts header comment; agent-status-types.ts:216-221). Validation note worth stealing: per-event `curl --connect-timeout 0.5` **dropped 3/3 events to a healthy listener under load** on WSL; fine at 3 s — resident relays beat per-event process spawns (`docs/agent-status-over-wsl.md:196-199`).

## 8. Verdict for codegent

### (a) Adopt for the universal "needs-attention" tier

1. **Layered evidence with explicit precedence and vetoes** — fresh hook > title > process — plus *completion-identity dedup* and *quiet windows*. The specific numbers are battle-tested and portable: 1.5 s quiet window before trusting a `done`; 1 s replay guard; 2-consecutive-sample + no-children rule before believing process exit; 15.5 s pending-title validation against a process probe.
2. **Foreground-process classification is the strongest content-free universal signal**: descendant walk from the shell PID, `ps stat '+'` for the foreground group, depth-scored, one table snapshot shared across panes (500 ms TTL), tiered cadence 750/2000/3000/15000 ms with ±10 % jitter. It answers "did the agent exit" and "is an agent even here" without reading a byte of pane content. Caveats Orca already hit: macOS transient no-foreground blips, Codex shell-foreground blips while children work, Ctrl-Z leaving `+` on the shell, Windows scan cost.
3. **Title (OSC 0/2) classification as a middle layer**: titles are metadata the agent volunteers, not pane content — classifying them server-side and emitting only the enum is compatible with our no-content-in-UI principle so long as raw title strings never surface. The glyph/spinner/keyword table (§2.2) covers Claude (✳ + braille), Gemini (✋✦⏲◇), and keyworded titles for many others, with hard-won false-positive guards (agent-name gate, path-safe boundaries, spinner-only "generic" titles held for process validation).
4. **Input-intent inference (Esc/Ctrl+C + 500 ms settle, baseline revalidation)** — free, content-free, and fixes the two worst hook gaps (interrupts and answered questions). Directly applicable to both tiers since codegent already proxies keystrokes to the PTY.
5. **Quiescence only as the final fallback and only combined with a non-shell foreground check** (3 s quiet + 2 s poll). Orca never lets a bare timer drive user-facing state — that restraint is the lesson.
6. **Ops details worth copying verbatim:** endpoint-file indirection for restart-surviving PTYs; fail-open hook scripts (`exit 0` always, 0.5/1.5 s curl budgets locally — but ≥3 s or a resident relay across VM/WSL boundaries); loopback + random port + token header; 1 MB body cap + per-field truncation as second-line defense; last-status persistence with a "seen in this runtime" bit so hydrated rows don't count as live evidence.

### (b) What conflicts with codegent (or we'd do differently)

1. **Orca surfaces captured content aggressively** — prompt text, tool inputs, 8 KB assistant-message previews, full AskUserQuestion JSON cards, transcript-file reads. That is their product choice and our anti-goal; our hook receiver schema should structurally not have those fields (can't leak what can't be represented).
2. **Global config mutation:** hook install edits `~/.claude/settings.json` etc. (with careful idempotent add/remove). Codegent's per-session injection stance is cleaner; Orca's own Codex approach — a **managed mirrored `CODEX_HOME`** — is the template for zero-touch per-session hook injection, and Claude's `--settings`/project-scoped equivalents could achieve the same.
3. **The content-scanned "blocked reason" tail patterns** (§2.7) read pane text. If we ever need trust-menu detection, do it daemon-side and emit only the reason enum — Orca's pattern list and its 50 ms/31-char-carry scanning discipline are reusable; the alternative (Orca's own choice for Cursor/Copilot/Codex) is better: pre-write trust artifacts so the menus never appear.
4. **Orchestration completion is prompt-engineered CLI self-report**, with dispatch-id-scoped dedup, heartbeats, and a no-auto-fail stale policy. That's the same role as our `task_complete` MCP tool — MCP is the sturdier transport (no PATH/shell dependence), but copy their envelope: taskId + dispatchId on every message, worker_done-exactly-once-even-on-failure, 5 min heartbeat vs 10 min warn.

### (c) Tiering implications

1. Hook coverage is much wider than "Claude/Codex premium": Orca ships working hook integrations for **17 agents** (incl. Gemini, Droid, Cursor, Copilot, Amp, OpenCode, Grok, Kimi, Devin), several via plugin/extension APIs rather than hook configs. Our "premium" tier can grow per-agent exactly the way our planned plugin system intends — Orca's per-agent normalizers (~100 lines each over one shared listener) show the marginal cost is small; the per-agent quirk knowledge (Droid Ctrl+C, double-Esc agents, Codex auto-approve races, Pi milestone dones, Gemini's missing permission hook) is the actual moat.
2. The universal tier should be **process-classification + title-classification + input-intent + quiescence**, in that order — not quiescence alone. Orca demonstrates quiescence-only is too weak to ship as primary signal; they use it solely as a readiness gate.
3. OSC 9999 validates our side-channel philosophy in-band: a documented `codegent` OSC status escape would let any wrapped/instrumented agent report state with zero networking and automatic pane attribution — worth speccing alongside MCP for the plugin tier (Orca's caveat applies: status vocabulary only).
4. For Claude specifically: `PermissionRequest` + `PreToolUse(AskUserQuestion)` + `Stop(is_interrupt)` + `SubagentStart/Stop` is the complete signal set — the `Notification` hook is unnecessary (Orca deliberately skips it), and answered-question detection needs the input-side inference regardless.
