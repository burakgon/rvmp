# Spike: Claude Code + Codex hook contract — live verification against the spec truth table

Date: 2026-07-19 · **claude 2.1.215 (Claude Code)** · **codex-cli 0.144.6** · Bun 1.3.14 · macOS (darwin arm64)
Method: interactive CLIs driven through a Bun native PTY (harness facts per `docs/research/bun-pty-spike.md`: `Bun.spawn` `terminal` option, `data` callback only, `env.TERM` set manually, `kill("SIGHUP")`); hooks registered via **externally supplied config only** (`claude --settings <tmpfile> --setting-sources project`; isolated `CODEX_HOME` mirror — `~/.claude/settings.json` and `~/.codex` never touched). Every hook = a `jq -c` JSONL appender (fail-open `|| true`), so payloads below are byte-exact captures. Raw PTY bytes + chunk timestamps recorded per scenario. Total spend: ~12 one-line haiku turns + 4 low-effort Codex turns.

**Headline: the spec's §4.1 completion truth table survives contact with reality — `Stop` fires at the end of every turn including question-only turns, `StopFailure` fires on API-error turns, interrupts (Esc *and* Ctrl+C, both CLIs) fire nothing. Two amendments earned: (1) CC's input-flag source is `PermissionRequest` + `PreToolUse(AskUserQuestion)`, not `Notification` (Notification is a *delayed derivative*: +6 s for permissions, +60 s for idle) — and answering AskUserQuestion IS hook-visible now (`PostToolUse` ~23 ms after the keystroke), so Orca's answer-inference is optional for CC ≥ 2.1.215. (2) herdr's CC OSC `9;4` progress claim is dead at 2.1.215 (no emitter in the binary); CC's title shows the *idle* glyph `✳` while a permission dialog is pending, so CC titles can never signal blocked. Codex 0.144.6 ships real Claude-compatible hooks (10 events, `hooks.json`, trust-review flow) and its `[ ! ] Action Required | <dir>` title is verified 4 ms after the `PermissionRequest` hook.**

## 1. Scenario → event-sequence table (all captured live)

| Scenario | Setup | Hook sequence observed |
|---|---|---|
| s1 trivial turn (interactive) | `claude --settings … --model haiku` | SessionStart(startup) → UserPromptSubmit → **Stop** → SessionEnd(prompt_input_exit) |
| p1 trivial turn (`-p`) | same, non-interactive | SessionStart → UserPromptSubmit → **Stop** → SessionEnd(other) — **hooks fire in `-p` too** |
| s2 text-question turn ×2 | "ask me one clarifying question, no tools" | UserPromptSubmit → **Stop** (last_assistant_message = the question) — per turn |
| s3 AskUserQuestion | default mode | UserPromptSubmit → PreToolUse(AskUserQuestion) → **PermissionRequest**(AskUserQuestion) +18 ms → [user answers] → **PostToolUse** +23 ms (answers in tool_response) → Stop |
| s4/s4b Bash permission | `--permission-mode manual`, focused & unfocused | UserPromptSubmit → PreToolUse(Bash) → **PermissionRequest** (+`permission_suggestions`) → [approve] → PostToolUse → Stop. **No Notification in either.** |
| s9b pending permission 6 s+ | unfocused | … PermissionRequest → **Notification(permission_prompt) at +6.0 s** → … |
| s9 idle after Stop | unfocused | Stop → **Notification(idle_prompt) at +60.0 s** |
| s5 Esc mid-turn / s5b Ctrl+C mid-turn | streaming a 1..40 count | UserPromptSubmit → *(interrupt)* → **nothing, ever** — no Stop, no StopFailure |
| s7 API-error turn | `ANTHROPIC_BASE_URL` → local HTTP 400 server | UserPromptSubmit → **StopFailure** (no Stop) |
| s6 resume | `claude --resume <id>` | SessionStart(**source:"resume"**, same session_id) |
| c1 Codex TUI approval | isolated CODEX_HOME, `approval_policy="untrusted"` | SessionStart(startup, **lazy: at first submit**) → UserPromptSubmit → PreToolUse(Bash) → PermissionRequest +13 ms → [approve] → PostToolUse → Stop |
| c2 Codex resume | `codex resume <id>` | *(nothing at TUI open)* → first submit → SessionStart(**source:"resume"**, same id) → UserPromptSubmit → Stop |
| c3 Codex Esc mid-turn | | UserPromptSubmit → *(“■ Conversation interrupted” on screen)* → **nothing** |

## 2. Per-claim verdicts — Claude Code 2.1.215

### Claim 1 — `Stop` fires at the end of EVERY turn, including question-only turns: **VERIFIED**

Text-question turn (s2) ends with a normal `Stop`; the question is only visible in `last_assistant_message`:

```json
{"hook_event_name":"Stop","session_id":"61f3…","prompt_id":"426c…","permission_mode":"default",
 "stop_hook_active":false,
 "last_assistant_message":"What is the favorite color task you'd like me to help with? …",
 "background_tasks":[],"session_crons":[]}
```

So Stop alone can never mean "task done" — the truth-table cornerstone holds. Full Stop key set: `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons`. **No `is_interrupt` field observed** (Orca reads one; in 2.1.215 interrupts simply fire no Stop at all — see claim d).

### Claim 2 — `StopFailure` fires on API-error turns: **VERIFIED**

Trigger: `ANTHROPIC_BASE_URL=http://127.0.0.1:45913` → a 6-line Bun server returning HTTP 400 `{"type":"error","error":{"type":"invalid_request_error",…}}`. Works under the user's normal OAuth login (base-URL override applies; no API key needed). The turn fires `StopFailure` and **not** `Stop`:

```json
{"hook_event_name":"StopFailure","session_id":"b1f2…","prompt_id":"aa0c…",
 "error":"unknown","last_assistant_message":"API Error: 400 cg-hookspike synthetic 400"}
```

Note the reduced shape: `error` (an enum-ish string; "unknown" here) + the UI error text; no `permission_mode`/`stop_hook_active`.

### Claim 3 — permission requests & questions surface as hook events: **VERIFIED** (via `PermissionRequest`, and `PreToolUse(AskUserQuestion)` marks questions)

- Ask mode: CLI flag is `--permission-mode manual` in 2.1.215 (choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`); hook payloads still report `permission_mode:"default"` for it.
- Bash in manual mode: `PreToolUse` → `PermissionRequest` (18 ms later) with the full tool input **plus** UI hints:

```json
{"hook_event_name":"PermissionRequest","tool_name":"Bash",
 "tool_input":{"command":"touch spike.txt","description":"Create an empty file named spike.txt"},
 "permission_suggestions":[{"type":"addDirectories","directories":["/private/tmp/…/proj"],"destination":"session"},
                           {"type":"setMode","mode":"acceptEdits","destination":"session"}]}
```

- `AskUserQuestion` fires `PreToolUse` **and** `PermissionRequest` (matcher = tool name), even in default mode.
- **New since Orca's study:** answering the question is hook-visible. 23 ms after the user's answer keystroke, `PostToolUse(AskUserQuestion)` fires with `tool_response.answers = {"Which color do you prefer?":"Red"}`. Orca's keystroke-inference for "question answered" (orca-agent-state.md §2.4) is no longer *required* for CC ≥ 2.1.215 — keep it only as a cross-version guard.

### Claim 4 — `Notification`: what it carries, and is it needed: **VERIFIED AS REDUNDANT — recommend dropping it from the CC adapter's primary set**

Notification is a *delayed derivative* of states we already get instantly:

| notification_type | message | fires |
|---|---|---|
| `permission_prompt` | "Claude needs your permission" | **+6.0 s** after `PermissionRequest`, only if still pending |
| `idle_prompt` | "Claude is waiting for your input" | **+60.0 s** after `Stop`, only if user hasn't typed |

It did **not** fire at dialog-open time in any scenario, focused or unfocused (focus events tested via CSI 1004 `\x1b[O`/`\x1b[I` — no effect on hook behavior). Payload adds nothing beyond `{message, notification_type}`. Orca's choice (skip Notification; use PermissionRequest + PreToolUse(AskUserQuestion)) is empirically right. Optional use: a free "still stuck" nag timer.

### Claim 5 — SessionStart carries `session_id`; captured id works with `--resume`: **VERIFIED** (with one landmine)

```json
{"hook_event_name":"SessionStart","session_id":"1c1a9491-…","source":"startup","model":"claude-haiku-4-5-20251001",
 "transcript_path":"~/.claude/projects/-private-tmp-cg-hookspike-proj/1c1a9491-….jsonl","cwd":"/private/tmp/…/proj"}
```

`claude --resume 1c1a9491-…` resumed the same `session_id` and fired `SessionStart` with `source:"resume"` (that payload omits `model`). Zero API cost until a prompt is sent.

**Landmine (operational, must go in the daemon):** with nested-Claude env leaking into the PTY (`CLAUDE_CODE_CHILD_SESSION=1` et al. — present because the spike itself ran inside a CC session), interactive sessions **never write their transcript** — `--resume` then fails with "No conversation found with session ID" even though every hook happily reported a `transcript_path`. Scrubbing `CLAUDE*`/`ANTHROPIC*` from the spawn env restored persistence (verified before/after). codegent's PTY spawner must scrub these. Bonus quirk: the *failed* resume attempt still fires `SessionEnd(reason:"other")` carrying the requested session_id — SessionEnd is not proof a session ever ran. Observed SessionEnd reasons: `prompt_input_exit` (/exit), `other` (SIGHUP, failed resume).

### Claim 6 — OSC title behavior: braille + `✳` **VERIFIED**, ConEmu `9;4` **REFUTED**, plus one new fact

All titles arrive as OSC 0 (`ESC]0;…BEL`). Captured stream (s4, timestamps = PTY chunk arrival):

```
1784476912.878  0;✳ Browser tabanlı AI orchestrator geliştirme planı   ← at rest (✳ U+2733)
1784476914.197  0;⠂ …    ← working (braille U+2802)
1784476915.158  0;⠐ …    ← working (U+2810; ~1 s alternation, title text = live task summary)
1784476916.353  0;✳ …    ← permission dialog opens (PermissionRequest hook at .357 — 4 ms)
1784476918.907  0;⠂ …    ← user approved, work resumes
1784476921.809  0;✳ …    ← Stop (hook at 921.79)
1784476924.332  0;       ← title cleared on exit
```

- **Braille spinner U+2800–U+28FF while working: VERIFIED** (frames ⠂/⠐ observed; title text is a live task summary, e.g. "⠐ Create spike4.txt file").
- **`✳` (U+2733) prefix at rest: VERIFIED** — but note it *also* shows while a permission/question dialog is pending. **A CC title can signal working vs not-working, never blocked** — blocked detection must come from the PermissionRequest hook (premium) or screen manifests (universal). Title flips track hook events within 2–5 ms.
- **OSC `9;4` progress (`ESC]9;4;0` when done): REFUTED at 2.1.215.** Zero OSC 9 sequences in any capture, including with the schema setting `terminalProgressBarEnabled: true` ("Emit OSC 9;4 progress sequences during long operations"). Binary check: `]0;` exists as a literal in the bundle (4 hits — the title emitter we saw fire); `]9;` has **zero** occurrences. The setting is schema-only in this build. herdr's `osc_progress_idle` rule for CC (herdr-agent-state.md §6) is stale/harmless — do not rely on it.

### Claim (d) — user Esc mid-turn emits no hook: **VERIFIED** (and Ctrl+C too)

Esc 1.1 s into a streaming turn: no hook of any kind between the interrupt and the next user action (5 s observation). Ctrl+C: same. The spec's PTY-write-tracking rule is the only coverage. **Detail worth knowing:** after Esc, CC restores the interrupted prompt text into the input box — a subsequent programmatic write appends to it (our "/exit" became a new prompt "Count from 1 to 40…/exit" and ran a full turn). Any daemon-injected input after an interrupt must first clear the line (Ctrl+U) or expect concatenation.

### Event inventory 2.1.215 (binary literals, all 15 accepted in `--settings`)

`SessionStart SessionEnd UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure PermissionRequest Notification Stop StopFailure SubagentStart SubagentStop TeammateIdle PreCompact PostCompact` — 10 observed firing in this spike; `PostToolUseFailure, SubagentStart/Stop, TeammateIdle, Pre/PostCompact` registered cleanly but weren't triggered (not needed for the truth table; Orca's §5 documents their semantics).

## 3. Per-claim verdicts — Codex 0.144.6

### Claim 7a — official hooks exist: **VERIFIED** (Claude-compatible, 10 events, trust-gated)

- **Events (from the binary's embedded JSON schemas, titles `*.command.input/output`):** `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, SubagentStart, SubagentStop, PreCompact, PostCompact`. **No SessionEnd, no Notification, no StopFailure.**
- **Config:** `$CODEX_HOME/hooks.json` (auto-discovered — verified live), or project `.codex/hooks.json`, or inline `[hooks]` tables in `config.toml`. hooks.json uses the CC structure: `{"hooks": {"Event": [{"matcher": …, "hooks": [{"type":"command","command":"…","timeout":30,"statusMessage":"…"}]}]}}`. Command runs via `$SHELL -lc`. Only `type:"command"` works (async parsed-but-skipped per docs).
- **Trust flow (new vs Orca's study):** non-managed hooks require interactive review ("Hooks need review" TUI dialog; trust persisted by definition hash in `hooks.state`). For automation: `--dangerously-bypass-hook-trust` (exists on both `codex` and `codex exec`; used throughout this spike — prints a warning, hooks then run). **A codegent Codex adapter must handle this or hooks silently never fire.**
- Stdin payload = CC schema + Codex extension `turn_id`, and `model` + `permission_mode` on every event (`permission_mode` enum: `default, acceptEdits, plan, dontAsk, bypassPermissions`). Stop input schema (carved from binary and matched live):

```json
{"hook_event_name":"Stop","session_id":"019f7b25-aea3-77e3-bd00-b93f27b81a84",
 "turn_id":"019f7b25-aed1-7283-ac82-90890d99c188",
 "transcript_path":"…/codex-home/sessions/2026/07/19/rollout-2026-07-19T19-11-34-019f7b25-….jsonl",
 "cwd":"/private/tmp/…/proj-codex","model":"gpt-5.6-sol","permission_mode":"bypassPermissions",
 "stop_hook_active":false,"last_assistant_message":"OK"}
```

### Claim 7b — session id delivery & resume: **VERIFIED**, with a lazy-start caveat

- `session_id` is in **every** hook payload; `transcript_path` = rollout file under `CODEX_HOME/sessions/…`.
- **TUI fires session hooks lazily:** at TUI open, *nothing* fires; `SessionStart(source:"startup")` arrives at the **first prompt submit** (25 s+ observed gap, then SessionStart → UserPromptSubmit 8 ms apart). Same on resume: `codex resume <id>` fires nothing until a prompt is submitted, then `SessionStart` with `source:"resume"` and the same session_id. `codex exec` fires SessionStart immediately. On quit the TUI prints "To continue this session, run codex resume <id>" — and no hook fires (no SessionEnd event exists).
- `codex exec` reports `permission_mode:"bypassPermissions"`; hooks fire fine in exec mode (SessionStart → UserPromptSubmit → Stop, with per-hook status lines in the CLI output).
- SessionStart matchers per docs: `startup | resume | clear | compact`. PreToolUse tool naming is **Claude-style**: `tool_name:"Bash"`, `tool_input:{"command":"touch spike-codex.txt"}`, `tool_use_id:"exec-<uuid>"`.

### Claim 7c — "Action Required" OSC title: **VERIFIED** (exact format captured)

```
1784477544.046  0;proj-codex                              ← idle (bare workspace dir)
…               0;⠹ proj-codex                            ← working (braille U+2839, static frame, ~88 repeats)
1784477575.947  0;[ . ] Action Required | proj-codex      ← 4 ms after PermissionRequest hook (.943)
1784477576.949  0;[ ! ] Action Required | proj-codex      ← [ ! ]/[ . ] blink, ~1 s period
1784477581.519  0;proj-codex                              ← 2 ms after Stop (.517)
1784477584.518  0;                                        ← cleared on quit
```

herdr's top-priority codex rules (title contains "Action Required" ⇒ blocked; braille ⇒ working; other title ⇒ idle) all reproduce. Codex Esc-interrupt: screen shows "■ Conversation interrupted" and **no hook fires** — PTY-write tracking must cover Codex interrupts too.

### Codex gaps (negative results)

- No `StopFailure`/error-turn event exists; behavior of an API-error turn is **UNTESTED** (would need a fake model provider in the mirror config — deferred; the §6.1 fallback stack must catch it as silent/idle).
- No SessionEnd; no Notification. `notify` (legacy `agent-turn-complete` program) still exists but stays unused per spec.
- `PermissionRequest` hook *output* can auto-decide (`decision.behavior allow/deny`) — codegent must **not** emit a decision (exit 0, no output) so Codex's own approval UI still renders (Orca does the same).

## 4. Spec impact

- **§4.1 completion truth table: CONFIRMED as written.** "Stop fires at the end of every turn (including question-only turns)" — verified. "Stop without task_complete → input-needed(question)" — safe: text-question turns are indistinguishable from any other turn end (question only in `last_assistant_message`, which we don't surface), so the conservative mapping is right. "StopFailure (API-error turns) → error" — verified incl. payload. "User Esc emits no hook — covered by PTY-write tracking" — verified for Esc *and* Ctrl+C, on both CLIs. One enrichment: **input-flag *clear* for CC questions can additionally key off `PostToolUse(AskUserQuestion)`** (hook-visible answer), with keystroke-inference kept as the cross-agent/cross-version fallback.
- **§6 CC paragraph: AMEND.** Replace `Notification (permission/question → input flag)` with **`PermissionRequest` + `PreToolUse(AskUserQuestion)` (input flag)**; add `StopFailure` (error turns) and `SessionEnd` (exit reasons `prompt_input_exit`/`other`; fires even on failed resume) to the listed hooks. Notification is optional (+6 s/+60 s late nag only). `--settings <file> --setting-sources project` is a validated no-repo-dirty injection path; note `-p` mode fires the same hooks (cheap for contract tests). Ask-mode flag is `--permission-mode manual` in 2.x (payload still says `default`).
- **§6 Codex paragraph: CONFIRMED + two additions.** Official hooks are real in 0.144.6 with the 10-event list above and session id on stdin. Add: (1) **hook trust** — pass `--dangerously-bypass-hook-trust` (or manage trust) or hooks never run; (2) **lazy TUI session events** — session_id is not harvestable until the first prompt submit (fine for the orchestrator's dispatch flow, but "SessionStart = session opened" is false for Codex TUIs; `starting → running` should key on spawn+submit, not on the hook alone).
- **§6.1 layer 2 glyphs: AMEND one line.** Braille U+2800–U+28FF ⇒ working: confirmed both CLIs. Claude `✳` idle: confirmed **but ✳ also shows during pending permission/question — CC titles can never signal blocked** (state it; blocked comes from hooks or layer-3 manifests). Codex `[ ! ] Action Required | <dir>` ⇒ blocked: confirmed with exact format. **Drop/flag `OSC 9;4` (`4;0` = done) for CC** — no emitter in 2.1.215 (schema setting exists, does nothing); keep the rule only as a harmless legacy matcher for other agents.
- **§4.3 / daemon spawn (new operational rule):** scrub `CLAUDE*`/`ANTHROPIC*` env when spawning agent PTYs — nested-Claude markers (`CLAUDE_CODE_CHILD_SESSION`) silently disable session persistence and break `--resume` reconciliation. After any interrupt, clear the input line (Ctrl+U) before injecting text (CC restores the interrupted prompt into the composer).
- **Contract-churn guard (§4.1) validated in practice:** this spike is the template for the nightly contract test — the whole run is scripted, costs cents, and every assertion above is machine-checkable from the JSONL logs.

## 5. Reproduction

Everything lives in gitignored `docs/research/tmp/cc-hook-spike/`: `harness.ts` (Bun PTY driver + all scenarios), `gen-settings.sh` (emits the 15-event `--settings` file), `settings.json`, `codex-hooks.json` + `codex-config.toml` (the isolated `CODEX_HOME` mirror config; auth.json was copied from `~/.codex` at runtime and deleted after), and `logs/` (per-scenario `events-*.jsonl` hook captures, `osc-*.jsonl` title timelines, `steps-*.jsonl` action logs, `raw-*.bin` PTY bytes). Hook command shape:

```
jq -c --arg r <EventName> '{__r:$r,__t:now,p:.}' >> …/hooks.jsonl 2>>…/hookerr.log || true
```

Run: `bun harness.ts s1_trivial | s2_question_text | s3_askuserquestion | s4_permission | s5_esc | s6_resume <id> | s7_stopfailure | s9b_pending_permission | c1_codex_tui | c2_codex_resume <id> | c3_codex_esc`. The StopFailure server is 6 lines of `Bun.serve` returning a synthetic Anthropic-style 400 (never reads request headers). Codex runs need `CODEX_HOME=<mirror>` + `--dangerously-bypass-hook-trust`; the mirror's `config.toml` pre-trusts the temp project dir and pins `model_reasoning_effort = "low"`.
