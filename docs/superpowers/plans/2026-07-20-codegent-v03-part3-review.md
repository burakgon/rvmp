# codegent v0.3 Part 3 — Review Queue, Diff View, Stale Cascade, Send-Back Comments & PR Tracking

> **For agentic workers:** executed ONE-PASS (no per-task review; single adversarial review at part end). Each task = one Codex dispatch on branch `feat/v03-p3-review` (single writer, sequential). Steps use checkbox syntax for tracking.

> **Scope context:** codegent is LOCAL-ONLY (2026-07-20 decision — no relay/E2E/push; see memory `relay-remote-cut-local-only`). Part 3 is entirely local: the review workflow around the existing localhost daemon. Spec: `docs/superpowers/specs/2026-07-19-codegent-design.md` §7.5 (Diff), §4.1 (card machine), §4.2 (worktree sync), §18 (naming). Heavy Web Push is CUT; a lightweight **in-tab browser Notification** ships here (T7).

**Goal:** A review-phase card gets a real diff view (queue strip → files → hunks), viewed-marks, queued line comments that return via Send back, stale/conflict/update lifecycle when the base moves, PR create/track via `gh`, and merge modes — all local.

**Architecture:** Diff computes on demand from the card's worktree (`git diff base...branch` structured to JSON, no cache — the v0.2 `compute-diffstat` effect stays a no-op). Stale cascade runs after every successful merge by recomputing sibling review worktrees' ahead/behind. Update = rebase in the worktree; conflicts are never auto-repaired — the user resolves in the worktree terminal and a daemon poll detects the outcome. PR tracking shells out to `gh` (guarded: absent gh/remote → 409 with reason enum).

**Tech Stack:** existing Bun + TS monorepo. No new runtime deps expected (git + gh CLIs via Bun.spawn, existing zod/react). Any dep added must be latest-stable (`bun pm view`) with version/license recorded.

## Global Constraints

- **Terminal content never leaves the terminal** (spec principle 1). Diff/PR/CI data is REPO metadata, not terminal content — allowed in UI. But no scraped terminal text anywhere; notices/enums stay content-free.
- **I1 intact:** nothing in Part 3 creates a new completion path; `complete` remains MCP `task_complete` only. External PR-merge / manual mark-merged drive an explicit `external-merged` event — a RECORDED FACT, never git-ancestry inference (VK-proven).
- Merge stays blocked unless `reviewSub === "ready"` (stale/conflict/updating/merging all naturally fail the existing `reviewReady` guard).
- Conflicts are NEVER auto-repaired (v1): user resolves in the worktree terminal; daemon only observes.
- All lifecycle mutations route through the per-card action-mutex (`runAction`) + existing `IllegalTransition`/`ActionInProgress` → 409 mapping. New actions: `update`, `pr-create`, `pr-mark-merged`.
- UI grammar: fonts 9.5/10/11/12/13; weights 400/500 (650 tiny-caps only); radii 6/8/999; `var(--…)` tokens; English; inline SVG icons (Lucide stroke); no emoji; no colored frames as state.
- Suite: bare `bun test` green from root; `bun run typecheck` exit 0. FOCUSED tests per task (lock contracts + the specific flows, no exhaustive tables). Full suite before each commit.
- Commits: plain conventional messages, NO attribution of any kind, author burakgon. Nothing under `.superpowers/` committed.
- Branch: `feat/v03-p3-review` off `main` (post-Part-1). One commit per task.
- Naming (§18): badge `READY FOR REVIEW`; actions `update / Send back / Open PR / Merge`; "review queue".
- Simplification (disclosed): "Open PR (AI-written description)" ships v1 as a TEMPLATED description (card title + body + commit list) — no AI call. AI-written descriptions are a later polish.

## File Structure (new / modified)

```
packages/protocol/src/entities.ts        # MOD: ReviewSub flows, WorktreeSync, Card PR/readySince fields, DiffPayload types
packages/protocol/src/events.ts          # MOD: no new event kinds needed (card events carry state); notice unchanged
apps/daemon/src/store/db.ts              # MOD: migration 8 (cards.ready_since, cards.pr_number/pr_url/pr_state/ci_status, worktrees.sync/behind_count, card_file_reviews table)
apps/daemon/src/store/cards.ts           # MOD: PATCHABLE += readySince, pr*, ciStatus
apps/daemon/src/store/reviews.ts         # NEW: viewed-marks store (list/set/unset/invalidate-by-paths)
apps/daemon/src/orchestrator/machine.ts  # MOD: events base-advanced/update-start/update-result/conflict-resolved/external-merged
apps/daemon/src/orchestrator/engine.ts   # MOD: stale cascade in merge R4, update action (rebase), conflict poll, merge modes, PR actions + 60s poll
apps/daemon/src/git/diff.ts              # NEW: structured worktree diff (files/hunks/stat) + ahead-behind helper
apps/daemon/src/git/pr.ts                # NEW: gh wrapper (create/view/poll) with availability guard
apps/daemon/src/http/server.ts           # MOD: GET /api/cards/:id/diff[?summary], GET/PUT /api/cards/:id/reviewed-files, POST /api/cards/:id/update, POST /api/cards/:id/pr, POST /api/cards/:id/pr/mark-merged, merge body {mode}
apps/web/src/components/DiffView.tsx     # NEW: the §7.5 view (strip/header/files/code)
apps/web/src/components/diff/*.tsx       # NEW: QueueStrip, DiffHeader, FilesPanel, HunkList (+ split view)
apps/web/src/components/{Shell,Board,Card,Details}.tsx  # MOD: routing to DiffView, readySince ordering, stale/conflict badges, PR badge/CI chip
apps/web/src/notify.ts                   # NEW: in-tab Notification (waiting/error/review-ready)
apps/web/src/projection.ts               # MOD: review cards route to diff; open-terminal-in-worktree for review
```

---

### Task 1: Protocol + store + machine foundations

**Files:** Modify `packages/protocol/src/entities.ts`, `apps/daemon/src/store/{db,cards}.ts`, `apps/daemon/src/orchestrator/machine.ts`; Create `apps/daemon/src/store/reviews.ts`; Test `apps/daemon/test/{machine,store}` extensions + new `apps/daemon/test/reviews-store.test.ts`.

**Interfaces (produces — later tasks rely on these EXACT names):**

```ts
// entities.ts
export const WorktreeSync = z.enum(["clean","behind","conflicted","updating","untracked"]);
// WorktreeSchema += { sync: WorktreeSync (default "clean"), behindCount: z.int().min(0).default(0) }
export const PrState = z.enum(["open","merged","closed"]);
export const CiStatus = z.enum(["pending","pass","fail"]);
// CardSchema += {
//   readySince: z.number().nullable(),           // set on complete; drives review-queue order
//   prNumber: z.int().nullable(), prUrl: z.string().nullable(),
//   prState: PrState.nullable(), ciStatus: CiStatus.nullable(),
// }
export const DiffFileStatus = z.enum(["M","A","D","R"]);
export type DiffHunk = { header: string; lines: Array<{ t: "ctx"|"add"|"del"; text: string; oldNo: number|null; newNo: number|null }> };
export type DiffFile = { path: string; oldPath: string|null; status: DiffFileStatus; additions: number; deletions: number; binary: boolean; truncated: boolean; hunks: DiffHunk[] };
export type DiffPayload = { branch: string; base: string; files: DiffFile[]; additions: number; deletions: number };
export type DiffSummary = { files: number; additions: number; deletions: number };
```

```ts
// machine.ts — new MachineEvent variants + rows (all others unchanged)
| { t: "base-advanced"; behind: number }   // review.ready|review.stale → review.stale (idempotent; records count)
| { t: "update-start" }                    // review.stale → review.updating
| { t: "update-result"; ok: boolean }      // review.updating → ok? review.ready : review.conflict
| { t: "conflict-resolved" }               // review.conflict → review.ready
| { t: "external-merged" }                 // review.* (any sub) → done; effects ["kill-sessions","archive-worktree"] (recorded fact: PR merged externally or manual mark-merged)
```
Guards: `base-advanced` legal from `ready` and `stale` only (updating/merging/conflict ignore it — engine defers recompute). `update-result{ok:true}` also RE-CHECKS behind: engine sends `base-advanced` again if still behind (machine stays dumb). `complete` row additionally sets `readySince: now`. `merged`/`external-merged`/`send-back`/`cancel` null out `readySince`.

```ts
// store/reviews.ts
export function listReviewedFiles(db, cardId): string[];
export function setReviewed(db, cardId, path, viewed: boolean): void;
export function invalidateReviewed(db, cardId, paths: string[]): void; // update cascade: un-view changed files
export function clearReviewed(db, cardId): void; // on send-back round++ and on merged
```

Migration 8 (single migration): `cards` += `ready_since INTEGER`, `pr_number INTEGER`, `pr_url TEXT`, `pr_state TEXT`, `ci_status TEXT`; `worktrees` += `sync TEXT NOT NULL DEFAULT 'clean'`, `behind_count INTEGER NOT NULL DEFAULT 0`; new table `card_file_reviews(card_id, path, viewed_at, PRIMARY KEY(card_id, path))`.

- [ ] Failing tests: each new machine row (legal + one illegal per event); complete sets readySince; external-merged from ready AND from stale both → done with kill/archive effects; reviews store round-trip + invalidate subset + clear.
- [ ] Implement; migration idempotent on existing DB fixture.
- [ ] Full suite + typecheck green. Commit `feat: review lifecycle foundations — stale/update/conflict/external-merge, readySince, PR fields, viewed-marks store`.

---

### Task 2: Daemon structured diff endpoint + reviewed-files routes

**Files:** Create `apps/daemon/src/git/diff.ts`; Modify `apps/daemon/src/http/server.ts`; Test `apps/daemon/test/git-diff.test.ts` + http extension.

**Interfaces (produces):**

```ts
// git/diff.ts (all via Bun.spawn git in the worktree path; never shell-interpolate)
export async function computeDiff(worktreePath: string, base: string, opts?: { maxFileBytes?: number }): Promise<DiffPayload>;
// three-dot semantics: diff merge-base(base, HEAD)..HEAD — the card's own changes only
export async function computeDiffSummary(worktreePath: string, base: string): Promise<DiffSummary>;
export async function aheadBehind(worktreePath: string, base: string): Promise<{ ahead: number; behind: number }>;
```

Routes: `GET /api/cards/:id/diff` → DiffPayload (404 no worktree; review/done phases only — 409 otherwise); `GET /api/cards/:id/diff?summary=1` → DiffSummary; `GET /api/cards/:id/reviewed-files` → `{ paths: string[] }`; `PUT /api/cards/:id/reviewed-files` body `{ path, viewed: boolean }`. Caps: per-file patch > 200KB or binary → `truncated/binary: true`, hunks `[]` (UI shows "file too large — open terminal"). Rename detection on (`-M`). Deleted/added files render normally.

- [ ] Failing tests against a REAL fixture repo built in-test (temp dir, two branches, base moves): file statuses M/A/D/R, hunk line numbers, binary + oversize truncation flags, summary math, aheadBehind counts, three-dot isolation (base's own new commits do NOT appear in the card diff).
- [ ] Implement; full suite + typecheck. Commit `feat: structured worktree diff endpoint and viewed-marks routes`.

---

### Task 3: Stale cascade, update action, conflict detection, merge modes

**Files:** Modify `apps/daemon/src/orchestrator/engine.ts`, `apps/daemon/src/http/server.ts`; Test `apps/daemon/test/engine.test.ts` extensions (fixture-repo based).

**Behavior (consumes T1 machine events + T2 aheadBehind):**
- **Cascade:** in `mergeUnlocked()`'s R4 slot (engine.ts:1409-1417 today), after a successful merge: for every OTHER review-phase card in the project with a live worktree → `aheadBehind`; if behind>0 → drive `base-advanced{behind}`, set worktree `sync:"behind"`, `behindCount`; emit card events. Cards in `updating/merging/conflict` are skipped (recomputed on their next transition).
- **Update action:** `POST /api/cards/:id/update` → lifecycle action `update` through the action-mutex: machine `update-start` (→updating, worktree sync `updating`) → `git rebase <base>` in the worktree (Bun.spawn). Clean → recompute aheadBehind → `update-result{ok:true}` (+ another `base-advanced` if base moved again mid-rebase), worktree `clean`, `invalidateReviewed(changedPaths)` (paths from `git diff --name-only` pre/post rebase upstream delta — the files whose content changed by the rebase). Rebase exit≠0 with `.git/rebase-merge` present → LEAVE the rebase in progress, `update-result{ok:false}` (→conflict), worktree `conflicted`. NEVER auto-abort/auto-repair.
- **Conflict poll:** while ≥1 card is in `review.conflict` or `review.updating` (crash-recovery), a 5s engine poll checks each such worktree: rebase dir gone + clean status → `aheadBehind` → behind==0 ? `conflict-resolved` (→ready, sync clean) : `conflict-resolved` then `base-advanced` (→stale). User aborting the rebase lands in the same poll outcome. Poll stops when no conflict/updating cards remain.
- **Merge modes:** merge route body `{ mode?: "squash"|"merge"|"rebase" }` default squash. squash = current path (keep the update-ref branch-reset-to-squash). merge = `git merge --no-ff`. rebase = rebase worktree onto base then fast-forward base. All three keep kill/archive/R4 behavior; conflicts during ANY mode → clean abort of the merge attempt (restore pre-state, card stays ready, 409 `merge-conflict`) — the deliberate reset behavior proven in T9 hardening stays.
- Crash-safety: daemon restart with a card in `updating` → boot reconcile runs the same poll logic once (rebase dir present? conflict : recompute).

- [ ] Failing tests (fixture repos): merge A → sibling review card B goes stale with correct behind count; update clean → ready + viewed-marks of changed files invalidated (unchanged files stay viewed); update conflict → conflict + rebase left in progress; resolve (finish rebase in test) → poll → ready; abort → poll → stale; merge blocked 409 while stale; merge modes each produce correct git graph; mid-rebase base advance → ready then immediately stale again.
- [ ] Implement; full suite + typecheck. Commit `feat: stale cascade, worktree update flow, conflict detection, merge modes`.

---

### Task 4: PR tracking via gh

**Files:** Create `apps/daemon/src/git/pr.ts`; Modify `apps/daemon/src/orchestrator/engine.ts`, `apps/daemon/src/http/server.ts`; Test `apps/daemon/test/pr.test.ts` (gh mocked via injected runner; one guard test for absent gh).

**Interfaces:**

```ts
// git/pr.ts — all gh calls through an injectable CommandRunner (tests stub it)
export type PrInfo = { number: number; url: string; state: "open"|"merged"|"closed"; ci: "pending"|"pass"|"fail"|null };
export async function ghAvailable(run: CommandRunner, worktreePath: string): Promise<{ ok: true } | { ok: false; reason: "no-gh"|"no-remote"|"not-authed" }>;
export async function createPr(run, worktreePath, opts: { title: string; body: string; base: string; head: string }): Promise<PrInfo>; // pushes head first (git push -u origin <branch>)
export async function viewPr(run, worktreePath, number): Promise<PrInfo>;   // gh pr view --json state,statusCheckRollup,url,number
```

- `POST /api/cards/:id/pr` (action `pr-create`, review phase any sub except merging): guard `ghAvailable` → 409 `{reason}`; description = TEMPLATE (title + body + `git log --oneline base..HEAD`); persist prNumber/prUrl/prState:"open"/ciStatus; card event.
- **Poll:** while any project card has `prState:"open"` → every 60s `viewPr`; ciStatus updates emit card events; `state:"merged"` → drive `external-merged` (recorded fact → done, kill/archive, R4 cascade for siblings, R1 refill); `state:"closed"` → keep card in review, prState closed (badge shows closed).
- `POST /api/cards/:id/pr/mark-merged` (action `pr-mark-merged`) — manual fallback when gh unavailable: drives `external-merged` directly (confirm handled UI-side).
- CI chip data: `statusCheckRollup` → pass/fail/pending enum only.

- [ ] Failing tests: create persists + pushes; poll transition open→merged drives external-merged exactly once (idempotent across overlapping polls); closed keeps review; ciStatus change emits event; no-gh guard 409s; mark-merged works without gh; external-merged archives worktree + triggers sibling cascade.
- [ ] Implement; full suite + typecheck. Commit `feat: pull-request tracking and external-merge recording via gh`.

---

### Task 5: Web Diff view core (strip · header · files · hunks)

**Files:** Create `apps/web/src/components/DiffView.tsx`, `apps/web/src/components/diff/{QueueStrip,DiffHeader,FilesPanel,HunkList}.tsx`; Modify `apps/web/src/components/{Shell,Board,Card}.tsx`, `apps/web/src/projection.ts`, `apps/web/src/api.ts`; Test `apps/web/src/test/diff-view.test.tsx` (+projection).

**Behavior (consumes T2 endpoints; §7.5):**
- Shell's `view === "diff"` renders `<DiffView/>` (placeholder line replaced). Selecting review card (click on board) → diff view focused on that card. `projection.ts`: review-phase cards route to DIFF (new `cardRoutesToDiff`), done cards too (read-only).
- **QueueStrip:** one pill per review-phase card, ordered by `readySince` asc; dot (worktree identity color), title, ready-since relative time + `DiffSummary` stat (fetched `?summary=1`); stale pill → amber "update" chip (calls `/update`); conflict pill → red accent; active pill highlighted.
- **DiffHeader:** title; `branch ← base` mono subline; total ±stat; Unified|Split toggle (Unified implemented now; Split lands T6 — toggle present, split renders unified until T6 with a "split" class only); **open-terminal-in-worktree** button (opens/creates a plain worktree session via existing sessions API and switches to terminal view); `Send back · N` (N = queued comments, 0 until T6 — button routes to Details for now); `Open PR` (T4 route; hidden when prState set → replaced by PR badge `#N` link + CI chip); `Merge ▾` (squash/merge/rebase; disabled when reviewSub ≠ ready with reason tooltip; while stale ALSO offers "update, then merge" one-click chain = update → auto-merge on ready).
- **FilesPanel:** per file — status letter (M/A/D/R), path (renames `old → new`), ±stat, viewed checkbox (PUT reviewed-files; strikethrough-dim when viewed); header `n/m reviewed` + hairline progress. Truncated/binary rows show "open terminal" hint instead of checkbox.
- **HunkList (unified):** hunk header rows (`@@ …`), line rows with old/new numbers, add/del/ctx tones via tokens; mono 12px; virtualless (cap already server-side).
- Done cards: same view, read-only banner `merged <date>` (from timeline merge entry), all actions hidden.

- [ ] Failing tests: strip orders by readySince; stale pill exposes update chip; routes review card→diff / working card→terminal; files panel viewed toggle persists + n/m math; unified hunk renders numbers/tones; merge disabled while stale with chain affordance visible; done read-only hides actions.
- [ ] Implement (grammar tokens only); full suite + typecheck + `cd apps/web && bunx vite build` green. Commit `feat: diff review view — queue strip, files, unified hunks, viewed marks`.

---

### Task 6: Line comments queue → Send back batch · split view · review polish

**Files:** Modify `apps/web/src/components/diff/{HunkList,DiffHeader}.tsx`, `DiffView.tsx`, `apps/web/src/components/Details.tsx`; Test extensions.

**Behavior:**
- Hover a diff line → `+` gutter affordance → inline comment composer (textarea, Queue button). Queued comments: stored in web state per card (survives view switches via a module store; NOT persisted daemon-side in v1 — page reload drops them, acceptable v1, disclosed), rendered inline under their line with `queued · edit · delete`.
- `Send back · N` in header: N = queued count; click → confirm → serialize each comment as `"<path>:<newLine (or oldLine for deletions)>: <text>"` plus the Details free-text (if any) → existing `POST /api/cards/:id/send-back {comments: string[]}` → card → Running round+1; queued comments cleared; viewed-marks cleared (T1 clearReviewed on send-back — verify wired).
- Split view: two-column render of the same hunk data (old | new), toggle now functional.
- Details drawer send-back textarea remains (merges into the same batch as a final general comment).

- [ ] Failing tests: queue/edit/delete comment; send-back posts serialized batch incl. general comment; round increments (existing engine test covers transport — assert the web payload shape); split view renders both columns from one hunk; queued count badge.
- [ ] Implement; suite + typecheck + vite build. Commit `feat: queued line comments with batched send-back and split diff`.

---

### Task 7: In-tab notifications + board/queue polish

**Files:** Create `apps/web/src/notify.ts`; Modify `apps/web/src/components/{Shell,Board}.tsx`; Test `apps/web/src/test/notify.test.ts`.

**Behavior:**
- `notify.ts`: `initNotifications(): { enabled, toggle }` — bell toggle in Shell header; first enable → `Notification.requestPermission()`; preference in localStorage. On domain card events (existing ws feed): fire when a card ENTERS waiting (`inputKind` set), `working.error`, or `review.ready` — title = card title, body = state label + elapsed (NO terminal content — title/state only); click focuses the tab (window.focus). Deduplicate per card+state (no re-fire on reconnect replay/no-op updates). Tab visible (`document.visibilityState === "visible"`) → skip (user is looking).
- Board review column sorted by `readySince` (falls back position) — matches the strip.
- Card face: review cards get stale (`N behind · update`) / conflict badges + PR badge `#N` + CI chip (dot: pending amber pulse-free, pass green, fail red).

- [ ] Failing tests: notify fires on queued→waiting entry once, not on repeat events, not when visible; permission-denied → toggle off gracefully; review column order; badges render from card fields.
- [ ] Implement; suite + typecheck + vite build. Commit `feat: in-tab notifications and review queue polish`.

---

## Part-End Gate (controller)

1. Build-gate: full suite + typecheck + vite build.
2. ONE adversarial review wave (2 parallel read-only reviewers: A = state-machine/engine correctness — cascade/update/conflict/PR-poll races, action-mutex, crash-reconcile; B = API/web contract — diff correctness vs git truth, viewed/comment flows, grammar, I1/content-free) → single fix wave → focused verify → merge `feat/v03-p3-review` → main.
3. Live browser verification stays DEFERRED to project end (per standing directive).
