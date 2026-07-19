# herdr: TUI-resident agent state detection (prior-art study)

Date: 2026-07-19 · Repo: github.com/ogulcancelik/herdr @ `b580103b956ef9cdf39798947a46ce4e8b78c322`
(v0.7.4, 2026-07-19, Rust, AGPL-3.0-or-later) · Clone kept at `.claude/jobs/b3095dd6/tmp/herdr`.
All `src/...` refs below are into that repo at that SHA.

**Headline: herdr classifies TUI agents from outside with a 3-layer stack — process-tree
identity probing → per-agent TOML screen/OSC pattern manifests → optional agent-side
lifecycle hooks over a unix socket — and it explicitly built, shipped, and then ripped out
(in 2 days) the output-quiescence/PTY-activity approach we were considering for our
universal tier.** Claude Code and Codex state is 100% screen+OSC regexes; their native
hooks are used only for session-resume identity, deliberately not for state.

## 1. Process model

- One real PTY per pane, spawned via a vendored `portable-pty =0.9.0` (`Cargo.toml:30,45-46`;
  unix: `src/pty/backend/unix.rs:12-42` — `openpty` + `spawn_command`, master fd dup'd
  CLOEXEC into an IO actor thread, `src/pty/actor/unix.rs`). No tmux anywhere; herdr *is*
  the multiplexer.
- Each pane runs the user's shell; agents are ordinary foreground jobs inside it (or a
  direct `launch_argv`). Agents keep their full interactive TUI — herdr renders the real
  screen and never re-renders a protocol.
- Terminal emulation is server-side **libghostty-vt** (vendored Zig lib + 4,240-line Rust
  bindings, `src/ghostty/bindings.rs`, built by `scripts/build_vendored_libghostty_vt.sh`).
  Full VT state machine per pane; default scrollback 10 MB/pane
  (`src/config.rs:39 DEFAULT_SCROLLBACK_LIMIT_BYTES = 10_000_000`).
- Headless server owns PTYs + terminal state; thin clients attach/detach over a unix
  socket (`src/server/headless.rs`, 9,420 lines). UI is ratatui in the client terminal.
- Same architecture shape as ours: real PTY + server-side VT + observers. Difference:
  their observer is a TUI, ours is a browser.

## 2. State model and arbitration

States (`src/detect/mod.rs:11-20`): `Idle` / `Working` / `Blocked` / `Unknown`. The public
API adds `Done` = Idle ∧ pane-not-yet-viewed-since-completion
(`src/app/api_helpers.rs:91-102`) — good kanban semantics for free.

Per-terminal arbitration (`src/terminal/state.rs:1485-1500` `recompute_effective_state`):

1. **Screen `visible_blocker` overrides everything** — even an active hook authority
   claiming "working" loses to visibly-rendered permission UI (guards stale/lying hooks).
2. Else **hook authority state** if an agent-side integration is live.
3. Else **screen fallback state** from the manifest engine.

Only 7 agents may be *full-lifecycle* hook authorities — pi, omp, mastracode, hermes,
opencode, kilo, kimi (`src/detect/mod.rs:284-295`). While one is live, the screen-scan
loop is paused entirely (`src/pane.rs:754-757`, toggled via
`src/app/api.rs:389-407`). Reports from `herdr:claude|codex|copilot|devin|droid|qodercli|cursor`
are "reserved native state sources" (`src/agent_resume.rs:81-92`): routed to
session-ref tracking only, **never** state (`src/app/actions.rs:2604-2632`).

## 3. Detection pipeline (the core answer)

A per-pane async task (`src/pane.rs:1962-2300`, restore-path twin at `:563-871`) ticks:

| Constant | Value | Ref |
|---|---|---|
| Tick, agent identified | **300 ms** | `src/pane.rs:1969` |
| Tick, no agent yet | 500 ms | `src/pane.rs:1968` |
| Tick, during pending-idle confirmation | 100 ms | `src/pane/agent_detection.rs:5-6` |
| Process re-probe when identified | every 5 s or on fg-pgid change | `src/pane.rs:249` |
| Process probe after output burst ("acquisition") | 500 ms for 1.5 s, then 2 s, inside an 8 s window | `src/pane.rs:252-255` |
| Agent considered gone after | **6 consecutive probe misses** | `src/pane.rs:248` |
| Startup grace after agent appears (publish Idle, suspend judgment) | **3 s** | `src/pane/agent_detection.rs:12-13`, `src/pane.rs:726-773` |
| Working→plain-Idle hold (anti-flicker) | 3 confirmations × 100 ms, cap 700 ms | `src/pane/agent_detection.rs:5-13,39-77` |
| Stable visible-blocker re-publish | every 800 ms | `src/pane/agent_detection.rs:10-11` |
| OSC title/progress retention cap | 256 chars | `src/pane/osc.rs:410` |

### 3a. Identity: process tree, not screen

`foreground_process_group_id(shell_pid)` → tpgid from `/proc/<pid>/stat` +
`tcgetpgrp` (Linux `src/platform/linux.rs:234-250`; macOS/Windows equivalents in
`src/platform/`). The whole foreground job's processes are name-normalized and matched
against 21 known agents (`src/detect/mod.rs:43-65`), with serious wrapper-unwrapping:
node/bun/python/sh/cmd/powershell `-c`/`-File` argv parsing, nix `.codex-wrapped` argv0,
symlink canonicalization, npm package paths (`src/detect/mod.rs:321-606`). Escape hatch
for sandboxes that hide /proc: `HERDR_AGENT=<label>` read from the child's environ
(`src/platform/mod.rs:254`, docs `website/src/content/docs/agents.mdx` "VMs and sandbox
wrappers").

### 3b. Classification: screen tail + OSC, per-agent TOML manifests

- Input text = `detection_text()` — the **bottom viewport-rows of the live buffer**
  (current row count, min 1, default 24; always the bottom even when the user scrolls)
  (`src/pane/terminal.rs:39,2200-2208`, test `:4244`).
- Scan-skip: an `AtomicU64` content sequence bumps on every non-empty PTY read
  (`src/pane.rs:1917-1919`, `src/pane/agent_detection.rs:319-327`); Idle + unchanged seq
  ⇒ skip the screen read entirely (`src/pane/agent_detection.rs:91-103`).
- OSC evidence: a passive byte-level scanner over the raw PTY stream retains the last
  **OSC 0/2 title** and **OSC 9 payload** (ConEmu progress, e.g. `4;3;`/`4;0;`),
  sanitized, cleared when the foreground agent changes so evidence can't leak across
  processes (`src/pane/osc.rs:408-528`, `src/pane.rs:722-724`).
- Engine (`src/detect/manifest.rs`): a manifest is a TOML list of rules
  `{id, state ∈ idle|working|blocked|unknown, priority: i32, region, visible_idle/
  visible_blocker/visible_working, skip_state_update, contains[] (lowercased substring),
  regex[], line_regex[], all[]/any[]/not[] gates nested ≤ 8 deep}`. **Highest-priority
  matching rule wins** (`src/detect/manifest.rs:423-446`). Complexity caps: ≤128 rules,
  ≤512 gates, ≤1024 matchers, ≤512 chars/matcher (`:264-269`).
- Regions (`src/detect/manifest.rs:1072-1095,1254-1292`): `whole_recent`,
  `bottom_lines(N)`, `bottom_non_empty_lines(N)`, `top_non_empty_lines(N)`,
  `prompt_box_body` (text between the last two `─` horizontal rules — i.e. inside the
  CC/gemini-style bordered input box), `above_prompt_box`, `after_last_horizontal_rule`,
  Codex-specific prompt-marker regions keyed on `›` prompt lines and `•■✗✓` block
  markers (`:1404-1421`), plus `osc_title` and `osc_progress` which match the retained
  OSC strings instead of the screen.
- **Fallback polarity: known agent + no rule matched ⇒ Idle**, tagged
  `default_known_agent_idle_fallback` (`src/detect/manifest.rs:14,526-541`). Blocked is
  deliberately strict — docs say unusual prompts "may initially show as idle instead of
  blocked until Herdr learns that screen shape."
- `skip_state_update` rules mark agent-owned *viewer* screens (CC ctrl+o transcript,
  Codex scroll viewer) whose content mustn't be interpreted as live state — detection
  freezes on them (`src/detect/manifest.rs:909-922`; claude.toml `transcript_viewer`).
- Process exit forces Idle (`src/pane/agent_detection.rs:305-312`).
- Debug tooling: `herdr agent explain <target>` dumps the full rule-evaluation trace as
  JSON — matched rule, per-rule evidence, region previews, fallback reason, manifest
  source/version (`src/detect/manifest.rs:799-852`). Fixture capture:
  `scripts/capture_agent_screen.py` records real pane reads labeled
  idle/working/blocked/done for manifest tests.

### 3c. The abandoned experiment: PTY-output activity as "working" ← read this twice

herdr tried exactly our "quiescence" idea and reverted it **after two days in tree**:

- `ee51c5e` (2026-06-08) "feat: use pty-first agent detection": recent PTY output ⇒
  Working, with constants `AGENT_PTY_ACTIVITY_WINDOW = 1800 ms` (output within the last
  1.8 s counts as work) and `AGENT_INPUT_TAINT_WINDOW = 1200 ms` (output within 1.2 s
  after a user keystroke is *discarded*, because echo/redraw looks like work), plus
  pending-working confirmation (100 ms rechecks for 500 ms, then 250 ms, cap 2 s)
  (pre-removal `src/pane/agent_detection.rs:5-22` via `git show 0efd8ea^:...`).
- `0efd8ea` (2026-06-10) "fix: remove pty taint from agent detection": −1,547 lines.
  Changelog: "user input, pane resizes, and redraw nudges no longer delay screen/OSC
  manifest state updates." The leftover doc comment at `src/detect/mod.rs:35-38` ("PTY
  activity is the normal working authority") is stale — nothing reads output-recency for
  state anymore.

Why it failed (from the taint machinery they had to build): spinner TUIs are never
byte-quiescent; user typing, resizes, and focus events all trigger redraw output
indistinguishable from work at the byte level; so byte-activity needs ever-growing taint
windows that delay *real* transitions. They kept the content-seq only for scan-skipping,
and moved "working" into screen/OSC pattern evidence (spinner glyphs, "esc to
interrupt" hints, OSC titles).

## 4. Input-needed classification

Binary at the state level: `Blocked` covers permission prompts, questions, and select
forms alike — there is **no exposed distinction** between "asked a question" and "wants
permission". But the *rule ids* distinguish them internally, e.g. claude.toml has
`bash_permission_prompt` (prio 850), `generic_permission_prompt` (840),
`live_blocked_form` (980, tab/arrow select UIs), `dynamic_workflow_prompt` (980),
`legacy_no_prompt_blocker` (300); codex.toml has `live_strong_blocker` (900) vs
`weak_blocker` (600). A finer-grained public state would be a manifest-schema change, not
new detection capability. Full-authority hooks may attach a free-text `message` to a
state report (`pane.report_agent` params, `src/app/api/panes.rs:1215-1242`) — pi uses it
for "blocked: rate-limited"-style reasons (`src/integration/assets/pi/herdr-agent-state.ts`,
retryable-error regex + `HERDR_PI_IDLE_DEBOUNCE_MS` default 250 ms, retry grace 2500 ms).
"Went quiet with an unrecognized screen" is Idle, never Blocked.

## 5. Per-agent specialization

Three adapter layers:

1. **Screen manifests** — one TOML per agent, 19 bundled via `include_str!`
   (`src/detect/manifest.rs:239-259`, files in `src/detect/manifests/*.toml`).
   Remote-updatable: startup thread fetches `https://herdr.dev/agent-detection/index.toml`
   (catalog of `{id, path}`), ≤256 KB per fetch, per-agent `version` (date-shaped, e.g.
   claude `2026.07.13.1`, codex `2026.07.18.1` — they really do churn weekly) and
   `min_engine_version` (engine = 3) gating; remote older than bundled is rejected; local
   override at `~/.config/herdr/agent-detection/<agent>.toml` always wins
   (`src/detect/manifest_update.rs:15-18`, `src/detect/manifest.rs:554-664,1097-1103`,
   `src/app/runtime.rs:531`). Adding a *new* agent still needs a binary release (process
   identification is compiled in).
2. **Integrations** (`herdr integration install <agent>`) — install hook scripts or
   native extensions into the agent's own config dir (`src/integration/targets.rs`),
   self-gated on herdr env. Env injected into every pane: `HERDR_ENV=1`,
   `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`
   (`src/integration/env.rs:8-22`, `src/api/mod.rs:20`, `src/main.rs:11-12`).
3. **Socket API self-reporting** — any process in a pane may call
   `pane.report_agent {source, agent, state, message?, seq?}` /
   `pane.report_agent_session` / `pane.report_metadata` (display-only tokens, TTL ≤ 24 h,
   `src/app/api_helpers.rs:115`). Custom sources (docs example `custom:indexer`) become
   state authority for unknown agents but don't pause screen detection; only the 7
   whitelisted `herdr:*` sources do.

The authority split per agent is documented in `website/src/content/docs/agents.mdx`
(table "State authority"): lifecycle hooks for pi/omp/kimi/hermes/opencode/kilo/
mastracode when installed; **screen manifest for Claude Code, Codex, Copilot, Devin,
Qoder, Droid, Cursor, Amp, Grok, Antigravity, Kiro, Maki** — with the explicit rationale:
"their hooks do not cover the whole lifecycle. They can miss permission approval
results, escape interrupts, or other transitions."

## 6. Claude Code specifically

- **State: screen manifest + OSC only. Not hooks.** `src/detect/manifests/claude.toml`:
  - `osc_title_working` (prio 1100): title matches `^[\x{2800}-\x{28FF}] ` — leading
    **braille spinner glyph** in CC's OSC 0/2 title.
  - `osc_title_idle` (250): title `^\x{2733} ` (the `✳` glyph CC uses at rest).
  - `osc_progress_idle` (250): OSC 9 payload `^4;0` — CC emits ConEmu progress
    `ESC]9;4;0` when done.
  - Blocked (850/840): "do you want to proceed?" + numbered `1. yes`/`2. no` option
    lines (`line_regex` like `(?i)^\s*❯?\s*1\.\s*yes\b`), scoped to
    `after_last_horizontal_rule`; select forms (980): "enter to select"+"esc to cancel"
    +navigation hints; weak legacy blockers (300): "waiting for permission",
    "tab to amend", "ctrl+e to explain", etc.
  - Idle (950): `^\s*❯` inside `prompt_box_body` (between the box borders), with
    `not` gates excluding select forms.
  - `transcript_viewer` (1000, `skip_state_update`): "showing detailed transcript" +
    ctrl+o/ctrl+e hints — the ctrl+o viewer must freeze state.
- **CC hooks: session identity only.** Integration v7 installs exactly one hook —
  `SessionStart` (matcher `"*"`, timeout 10) → `~/.claude/hooks/herdr-agent-state.sh
  session` → socket `pane.report_agent_session` with `session_id` + `transcript_path`
  (+ `startup|resume|clear|compact` source); skips subagents (`agent_id` present) and
  `SubagentStop` (`src/integration/targets.rs:98-157`,
  `src/integration/assets/claude/herdr-agent-state.sh:51-87`).
- **They retreated from CC-hook state**: the installer explicitly *removes* older
  herdr-installed hooks for `PostToolUse`, `PostToolUseFailure`, `SubagentStop`
  (→working), `PermissionRequest` (→blocked), `UserPromptSubmit`/`PreToolUse` (→working),
  `Stop`/`SessionStart` (→idle), `SessionEnd` (→release) (`src/integration/targets.rs:132-141`)
  — fossil record of a shipped hooks-for-state design they abandoned for the
  screen manifest. The stated reason is lifecycle coverage gaps (see §5 quote).
- Session ref powers restart resume: relaunch `claude --resume <id>`
  (`src/agent_resume.rs:121-127`), skipping scrollback replay (§7).
- Codex, for contrast, is even more OSC-driven: title contains `"Action Required"` ⇒
  Blocked at prio 1100 (top rule!), braille spinner in title ⇒ Working, any non-spinner
  title ⇒ Idle; screen fallback matches `^[•◦]\s+Working \([^)]*esc to interrupt\)`
  in `bottom_non_empty_lines(3)` (`src/detect/manifests/codex.toml`).

## 7. Session persistence / reattach

- Detach/reattach is free (server owns PTYs; clients are views).
- **In-place binary upgrade (handoff)**: per-pane VT metadata (keyboard protocol flags,
  input modes, title) is serialized and the terminal is rebuilt by replaying at most
  **8 KB** of recent unwrapped ANSI (`src/server/handoff.rs:28
  MAX_REPLAY_BYTES_PER_PANE = 8*1024`; capture skips alt-screen panes,
  `src/pane.rs:1518-1530`; re-seed at `:1735-1737`).
- **Cold restart**: session snapshot + (opt-in, `experimental.pane_history`,
  `src/config/model.rs:887`) per-pane scrollback saved as **unwrapped ANSI of the whole
  buffer** (`snapshot_history()` = `recent_unwrapped_ansi(usize::MAX)`,
  `src/pane.rs:2532-2535`; `src/persist/snapshot.rs:419-428`). On restore the ANSI is
  replayed into a fresh ghostty terminal — **except** when a native agent resume plan
  exists (claude/codex/... session ref), in which case replay is skipped and the agent is
  relaunched with `--resume` to regenerate its own TUI (`src/persist/restore.rs:740-773`).
  That interplay (replay for shells, native resume for agents) is directly relevant to
  our ring-replay design: replayed scrollback + a resumed TUI would double-print.
- Resize with blank bottom triggers an ANSI self-replay of up to rows×8 lines to
  recover content (`src/pane/terminal.rs:1381-1410`).

## 8. Plugin / extension architecture

- Plugin = directory with **`herdr-plugin.toml`**: `id`, `name`, `version`,
  `min_herdr_version`, `platforms`, `[[build]]` (command), `[[actions]]`
  (id/title/contexts/command — user-invokable), `[[events]]` (`on = "<event>"` +
  command), `[[panes]]` (plugin-owned pane UIs with placement/size), `[[link_handlers]]`
  (regex pattern → action) (`src/app/api/plugins/manifest.rs:109-190`,
  `src/api/schema/plugins.rs:227-281`).
- Event hooks may subscribe to workspace/tab/pane lifecycle **including
  `pane.agent_detected` and `pane.agent_status_changed`**; `pane.output_changed` is
  deliberately excluded from plugin hooks "until high-volume output-change hook semantics
  are implemented" (`src/api/schema/events.rs:281-323`). Event payload arrives in
  `HERDR_PLUGIN_EVENT_JSON` env (`src/app/api/plugins/runtime.rs:59-62`); everything else
  goes through the same JSON socket API (read pane text incl. `source=detection`, send
  input, report state/metadata). Command runs are logged with stdout/stderr/exit
  (`PluginCommandLogInfo`).
- Waits are first-class for orchestration: `herdr wait agent-status <pane> --status
  idle|working|blocked|done|unknown [--timeout MS]` and `herdr wait output <pane>
  --match/--regex` (`src/cli.rs:387-401,727-864`).
- Root `SKILL.md` ships an agent skill teaching LLM agents to drive herdr's CLI —
  agents-as-orchestrators is an intended use.
- Note: **agent state detection is NOT plugin-extensible** — detection extends via the
  manifest override dir / remote catalog and the report_agent API, not via plugins.

## 9. Verdict for codegent

### (a) Adopt for the universal "needs-attention" tier

- **Do not ship byte-quiescence as the working/waiting discriminator.** herdr's 2-day
  pty-first experiment (1.8 s activity window + 1.2 s input-taint, then full revert) is
  the strongest field evidence we'll get. Spinners defeat "silent = waiting"; typing and
  resizes defeat "output = working". If we keep a quiescence signal it must be
  *screen-state* quiescence (VT grid unchanged, which our server-side emulator can diff
  cheaply — herdr's content-seq skip is the primitive) plus pattern evidence, not raw
  byte flow.
- **OSC title + OSC 9;4 progress is an under-priced, content-free middle tier.** CC:
  braille-spinner title = working, `✳` = idle, `9;4;0` = done; Codex: literal
  "Action Required" title = blocked. Pattern-match the retained title server-side, never
  surface it (herdr caps at 256 chars, sanitizes control chars, clears on process
  change — copy all three). This gives working/idle (and blocked for Codex) with zero
  screen-text scraping and zero agent config mutation.
- **Process-tree identity probing** (foreground pgid + wrapper unwrapping + N-miss
  hysteresis + `HERDR_AGENT`-style env override) is cheap, robust, and content-free —
  exactly what our kanban needs to know *which* agent occupies a pane. Steal the
  numbers: 300 ms tick, 5 s identified recheck, 6-miss clear, 3 s startup grace,
  100 ms×3/700 ms idle-confirm hold, 800 ms blocker re-assert.
- **Fallback polarity: unknown ⇒ idle, blocked only on positive evidence.** False
  "needs attention" pings are the expensive failure; herdr optimizes accordingly.
- **`Done = idle ∧ not seen`** maps directly onto our board's review column.
- **Screen-blocker-overrides-hook arbitration** — whatever our premium tier reports, a
  local positive "permission UI visible" signal should win over a stale remote report.

### (b) Where herdr conflicts with our principles / what to avoid

- Its core mechanism for CC/Codex **is** content scraping: regexes over the rendered
  bottom screen. For herdr that's fine (state never leaves the box). For us the *matcher*
  can run server-side next to the PTY with only the enum crossing to the UI — compatible
  with no-content-in-UI, but it must be stated in our threat model that classification
  reads terminal content server-side. If we want a stricter "no content read at all"
  tier, OSC-only (see above) is the honest floor, and it can't do CC blocked-detection.
- The manifest fleet is a treadmill: 19 TOMLs, weekly date-versioned updates, a remote
  catalog, community PRs per agent-UI change, capture tooling, an explain command. That's
  the cost of universal screen detection done right. We should scope screen-manifests to
  at most CC+Codex (where we also have better options) and lean on MCP/hooks elsewhere —
  not rebuild herdr's catalog.
- Their hook integrations mutate user-global agent config (`~/.claude/settings.json`)
  with env-var self-gating. Our per-run injected MCP server / settings overlay is cleaner;
  keep it.
- Binary blocked state: herdr never distinguishes question vs permission. The rule ids
  prove the screens are distinguishable if we ever want `needs-input` vs
  `needs-approval` as separate board signals — but only in the scraping tier; don't
  promise it universally.

### (c) Tiering implications

- **Validates the premium/universal split, with one correction:** herdr classifies CC
  and Codex native hooks as *insufficient for full lifecycle* (miss permission
  outcomes, esc interrupts) and demoted them to session-identity-only. Our premium tier
  should therefore treat CC hooks/MCP `task_progress` as high-precision but incomplete:
  hook silence ≠ idle, and a server-side corrective (OSC or screen evidence, or at
  minimum process-exit) must be able to override. herdr's 7 full-authority agents earned
  that status only via in-process extensions (pi's TS extension with its own 250 ms idle
  debounce) — the analogue of our future per-agent plugin upgrade path.
- **Session-ref harvesting belongs in every tier.** Even where hooks can't do state,
  a single SessionStart-style hook capturing `session_id`/`transcript_path` enables
  `--resume`-based restore, which herdr prefers over scrollback replay for agent panes.
  Our ring-replay design should likewise skip replay when we're about to native-resume
  the agent TUI.
- **The universal tier's floor is:** process identity + exit + OSC title/progress
  patterns + strict-positive blocked never inferred from silence; anything more (CC/Codex
  blocked detection) requires either the scraping tier or per-agent hooks. Plan the
  "needs attention" copy accordingly — herdr's own docs admit new prompt shapes show as
  idle until rules learn them.
