# Task 9 Report: Engine hardening bundle

STATUS: COMPLETE

Branch: `feat/v03-p1-hardening`

Commit: `490a970eab33b4f77fcfbe1f8d620556a6a73363` — `fix: harden engine actions and process reaping`

## Original commit scope

Only the Task 9 engine/machine/reaper files and their direct tests changed in `490a970`:

- `apps/daemon/src/orchestrator/engine.ts`
- `apps/daemon/src/orchestrator/machine.ts`
- `apps/daemon/src/pty/reap.ts`
- `apps/daemon/test/engine.test.ts`
- `apps/daemon/test/machine.test.ts`
- `apps/daemon/test/reap.test.ts`

No `apps/daemon/src/detect/*` files or `.superpowers/` files were committed in that original Task 9 commit.

## 1. Per-card lifecycle action mutex

- Added a full-lifetime, per-card action lease covering `merge`, `start`, `resume`, `restart`, `cancel`, and `send-back`.
- A second same-card lifecycle action rejects with `ActionInProgress`, message `action in progress`. The error extends `IllegalTransition`, so the existing HTTP engine-error mapper returns 409 without changing the server surface.
- Leases are released in `finally`, including validation, git, spawn, and archive failures.
- R1 skips a card whose action lease is still held but can continue to another queued card. Slot wakes raised inside an action are replayed immediately after lease release, preserving the three-attempt breaker/retry behavior without treating an internal retry as a conflicting action.
- Regression: starts `merge()` and `cancel()` in the same event-loop turn. Merge owns the lease before its first git await; cancel loses with 409-class `ActionInProgress`. Exactly one squash lands, the card finishes `done`, main is clean, and the managed worktree is archived.
- Existing slow create/re-materialize race tests now lock the new contract: cancel is rejected while start/resume owns the card, then succeeds cleanly after that action settles.

## 2. Effect-interpreter totality

- Added `dispatchEffect(effect)` as an exhaustive switch over every `Effect` union member.
- Its default passes the value to a `never`-typed throw helper. Widening `Effect` without extending the switch is therefore a TypeScript error; an untyped/corrupt runtime value throws instead of silently no-oping.
- The engine wraps every `transition()` result and sends every returned effect through this dispatcher before existing per-call-site interpretation.
- Regression: a synthetic `future-effect` value throws `unhandled machine effect: future-effect`.

## 3. Real merge-conflict reset path

- Added a real git fixture where main and the card branch replace the same line of `a.txt` after diverging.
- The squash genuinely conflicts and exercises the existing `git reset --merge` catch path.
- Assertions lock all recovery invariants: main HEAD unchanged, tracked file restored to main's content, porcelain clean, cached diff empty, no `.git/MERGE_HEAD`, no `.git/SQUASH_MSG`, card remains `review.ready`, and its worktree remains active for retry/cancel.
- The existing reset implementation passed this new regression; no additional production change was required for this item.

## 4. T14 hard-daemon-kill vs process-group reap reconciliation

### Root cause

The ordinary reaper was attached to `sess.exited`. A graceful exit or daemon shutdown resolves that promise and runs the pgid reap. `SIGKILL` terminates the daemon before JavaScript callbacks can run, so HUP-immune agent/MCP children can survive with no next-boot cleanup. The T11 and T14 observations were both possible: PTY-master closure may HUP and terminate the whole group, but survival depends on each process's signal disposition and timing. Kernel PTY behavior was therefore not a cleanup guarantee.

### Fix

- Each real adapter records a process-group marker immediately after `ptys.open(...)` returns and exposes the PTY pid, before prompt-readiness and injection work can keep `spawn()` pending.
- The marker contains the pgid, dispatch id, timestamp, and the current group members' PID plus kernel `lstart` stamp.
- Successful engine spawn registration refreshes the marker's member snapshot. Normal session exit still reaps by pgid and then removes the marker.
- On the next boot, `bootReconcile` first makes old dispatches terminal as before. `sweepSettingsDirs` then checks each terminal/rowless dispatch directory for a marker, verifies that at least one live process still matches PID + pgid + start stamp, and SIGKILLs that exact group before deleting the directory.
- PID/PGID reuse cannot target an unrelated group: the boot sweep refuses a marker unless a recorded member's kernel start identity still matches, and it separately refuses the daemon's own process group.

### Reproduction

The regression launches a helper process that stands in for the daemon. It creates a real `PtySession` whose shell and two children ignore SIGHUP, persists the marker after all children exist, and is then killed with `SIGKILL`. The test confirms the group survived the daemon death, invokes the production `sweepSettingsDirs` next-boot path, and confirms the group reaches zero live PIDs and the terminal settings directory is removed. The focused hard-kill test was also repeated three consecutive times without failure.

This covers the T11/T14-observed topology: an already-running agent group whose HUP-immune survivors include at least one member captured in the durable identity snapshot can be verified and group-killed on the next boot. It is not universal or deterministic coverage for every possible survivor topology.

Known residual limitations:

- A hard kill can still land inside the narrow process-created-to-`ptys.open(...)`-return/marker-write window, before the adapter has a pid it can record.
- If every recorded member later dies but an unrecorded descendant forked into the same pgid survives, boot verification deliberately refuses the marker because it cannot distinguish that group from PGID reuse safely.
- On ordinary session exit, a transient `ps` failure is indistinguishable from a confirmed-empty group to the asynchronous reaper; the engine's unconditional `finally` cleanup can therefore remove the marker without positively confirming that the group is dead.

## TDD evidence

- Mutex regression initially failed because `ActionInProgress` did not exist; implementation made it green.
- Effect regression initially failed because the exhaustive dispatcher did not exist; implementation made it green.
- Conflict fixture was added test-first and passed the already-present `reset --merge` implementation, locking the previously uncovered failure path.
- Hard-kill regression initially failed because no durable recorded-group boot reaper existed; marker recording plus the production boot sweep made it green.

## Verification

- `bun test`: 300 pass, 2 skip, 0 fail; 6658 assertions across 26 files.
- `bun run typecheck`: exit 0 (protocol, daemon, daemon test config, and web).
- Focused engine/machine/reaper suite: 47 pass, 0 fail.
- `git diff --check`: clean.
- Commit scope: exactly the six original files; no trailers or attribution.

## Concerns

none

## Fix round (independent review findings)

### Finding 1 — deferred same-card wake suppressed the scheduler pass

- `slotReleased(cardId, failed)` now always calls `tick()`. If that card still owns an action lease, it also records `pendingSlotWake`, so the immediate pass can start other unlocked queued cards and the affected card receives the existing replay pass after lease release.
- The new regression makes A's first spawn fail while A's lease is held and proves B enters `working` during that same tick. The existing breaker regression was tightened to prove A's pending wake still replays three same-card attempts before auto mode is disabled.
- TDD: the regression first observed its only pass after A's lease release, with B still `queued`; the minimal `slotReleased` change made it green.

### Finding 2 — T14 marker window and residual topology claims

- Claude and Codex now persist the marker immediately after their respective `ptys.open(...)` calls, before `injectTaskPrompt(...)`. `AdapterPtySession` exposes the already-existing PTY pid for this purpose.
- Engine registration still refreshes the marker after readiness work and owns successful-spawn exit cleanup. A failed or timed-out post-open spawn can leave a marker until the next boot; the added dead-group regression proves `sweepSettingsDirs` sees no survivor identity, forgets the marker, and removes the terminal/rowless settings directory.
- Adapter regressions capture the pre-readiness point with zero prompt writes and prove the marker already exists there. Both were red before early recording and green afterward.
- No structural redesign was made for the identity-versus-completeness tradeoff or inconclusive ordinary reaps. Section 4 no longer claims universal/deterministic coverage and now states the exact covered topology and all three residual windows.
- The exact `reapRecordedProcessGroup` limitation comment is:

> KNOWN LIMITATION (T9 independent review): identity proof covers only group
> members present at the most recent marker write. If every recorded member
> exits but a later, unrecorded descendant survives in the same pgid, reuse
> safety wins: the marker is refused rather than risking an unrelated kill.
> Separately, ordinary-exit reaping currently cannot distinguish a confirmed
> empty group from a transient `ps` failure, and engine cleanup forgets the
> marker after either result; an inconclusive normal reap can therefore lose
> next-boot recovery coverage for survivors. Closing either gap requires a
> stronger observation/result contract without weakening the reuse guard.

### Minor 1 — dead lease token

- Removed the unread `token: Symbol(action)` field. Lease release safety remains reference equality against the lease object itself, and the comment now says so.
- The slow-worktree regression was extended to inspect the lease while held; it was red on the extra `token` key and green after removal.

### Minor 2 — exact synthetic-effect error assertion

- Replaced Bun's substring `toThrow(...)` assertion with a caught-error check and exact `toBe("unhandled machine effect: future-effect")` on `.message`.
- Mutation verification added a temporary suffix to the production message: the strengthened test went red, then returned green when the exact production message was restored. No machine transition or final production behavior changed.

### Fix-round verification

- `bun test`: 304 pass, 2 skip, 0 fail; 6670 assertions across 26 files.
- `bun run typecheck`: exit 0 (protocol, daemon, daemon test config, and web).
- Complete touched-surface suite: 111 pass, 0 fail; 1625 assertions across engine, machine, reaper, Claude adapter, and Codex adapter tests.
- `git diff --check`: clean.
