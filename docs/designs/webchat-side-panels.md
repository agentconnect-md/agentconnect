# Webchat Side Panels — the session detail right dock

**Design source.** `Webchat Side Panels.dc.html` in the _Agent Connect Design
Documentation_ Claude Design project (`dc5868f1-6c3f-4315-bac2-b983274e3192`),
built on the `design-system-agentconnect-b3cda91e` token bundle. The prototype is
a static composition with mock data; this document is the gap analysis between it
and the shipped console, plus the plan to close that gap.

This document tracks **revision 2** of the design. Revision 1 was a read-oriented
dock; revision 2 turns it into a working surface — an inline file/diff viewer
that takes over the conversation pane, per-file staging, AI commit messages, and
a one-click auto-fix on PR review threads. §11 records what moved between the
two, including the one place this plan deliberately narrows the design.

## 1. What the design changes

Today the session detail page is `[nav · body · rail]`, where the rail is a fixed
250px **session list** (`SessionRail.tsx`). The design turns that rail into a
**resizable, tabbed dock** — the session list becomes one of five panels:

| Tab      | Icon                    | Badge              | Header action   | What it shows                                                                                                                                                                                                                        |
| -------- | ----------------------- | ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions | `messages-square`       | —                  | `plus`          | today / yesterday / previous-7-days session groups + agent filter chips                                                                                                                                                              |
| Files    | `folder-tree`           | —                  | `refresh-cw`    | workspace tree with git status tags, path search, branch + workdir header                                                                                                                                                            |
| Git      | `git-commit-horizontal` | changed count      | `refresh-cw`    | branch + ahead/behind, staged / unstaged with `+/−` and per-row stage toggle, commit box with AI message generation, commit log                                                                                                      |
| PR       | `git-pull-request`      | unresolved threads | `external-link` | PR state, description, head→base, checks, reviews, unresolved threads with a single Auto-fix action, merge box with Merge + auto-merge — or, with no linked PR, the branch's upstream state and a Create-pull-request action (§12.6) |
| Tasks    | `list-checks`           | running count      | `refresh-cw`    | background tasks with state and elapsed, read-only (§3.5 — no per-task cancel exists to wire)                                                                                                                                        |

Dock geometry: width **380–760px, default 480px**, drag handle on the left edge
(brand-colored while dragging), tab strip with zero gap between tabs. Tab labels
collapse to icon-only for inactive tabs when the dock is narrow.

Beside the dock, the left pane is now **two mutually exclusive modes**:

- **Conversation** (`chatOpen`) — the transcript and composer that ship today.
- **Viewer** (`viewerOpen`) — a full-height file or diff view that _replaces_
  both. Opened from a Files tree row (File mode) or a Git panel row (Diff mode),
  closed by an `x` labelled "Back to conversation".

The session header above them (agent focus chip, human faces, Workspace link,
Details popover, Requests popover, copy-link) is **already what ships** and stays
put in both modes. No work is planned there.

## 2. Invariants this must not break

- **Body-locality.** The CP stores no workspace bytes, no diffs, no transcript
  bodies. Files / Git / Tasks data is pulled live from the owning daemon over the
  CP↔daemon WS request/reply frames and proxied, never persisted
  ([`daemon-centric-architecture.md`](daemon-centric-architecture.md)).
- **The CP never calls a model provider.** Provider API egress is daemon-owned.
  Both AI features in revision 2 — commit-message generation and review-thread
  auto-fix — must run on the daemon against the agent's own runtime. A CP route
  that calls Anthropic/OpenAI would put the control plane on the inference path
  and is not an option, however convenient.
- **The dock is session-scoped.** Every panel except Sessions reads the _open
  session's_ worktree. Session-isolated worktrees already exist —
  `WorkspaceListReq.sessionId` / `WorkspaceGitStatusReq.sessionId` select them,
  and the CP authorizes the session before forwarding (`canReadWorkspaceScope` +
  `requireSessionWorkspaceRead` in `control-plane/src/http/routes/agents.ts`).
- **A degraded panel is data, not an error.** An offline daemon is 503, a
  non-repo workspace is `isRepo:false`, a session with no linked PR is an empty
  state, and a cluster agent whose sandbox pod is not running is a 503 carrying
  `WORKSPACE_SANDBOX_UNAVAILABLE`. None of these may take down the dock, the
  viewer, or the transcript — and none may be drawn as another one. That last
  clause is not decoration: a suspended pod once answered `isRepo:false` and an
  empty file tree, so both panels described an intact workspace as absent, which
  is the one degraded answer a reader cannot act on.
- **No raw hex in console styles.** The prototype is written in inline hex; the
  console is Tailwind-utility-first over CSS variables
  ([`packages/web/STYLE.md`](../../packages/web/STYLE.md)). See §8 for the map.

## 3. Gap analysis — the dock

### 3.1 Sessions — ships today, needs re-hosting

`SessionRail.tsx` already has the agent filter chips, `groupSessionsByAge`
headings, localStorage pins, family/lineage rows, and the three responsive bands.
The work is structural: lift it out of its own fixed 250px `position: fixed`
panel into the dock's tab body, and let it breathe at 380–760px (the current row
shape was tuned for 224px of usable width — at 480px a per-row timestamp and
channel become affordable again).

### 3.2 Files — ships today, needs a narrow variant

`WorkspaceFiles.tsx` + `FileBrowser.tsx` already do tree + preview + editor and
already take `sessionId`. `GET /agents/:id/workspace/files` and
`/agents/:id/workspace/file` back them (`workspace/list` / `workspace/read`
frames). What the design adds:

- **Single-column layout.** The current component is a two-pane
  tree-plus-preview built for the agent detail page. In the dock the tree is
  alone and the preview moves out into the left-pane viewer (§4).
- **Git status tags on tree rows** (`M` / `A` / `D`). Derivable client-side by
  joining the tree against the existing `workspace/gitstatus` file list — no new
  wire field.
- **"Find file by path…".** No server-side path search exists; `workspace/list`
  is per-directory. **v1: filter the already-loaded tree** and label it as such.
  A `workspace/search` frame is a follow-up, not a blocker.
- **Footer "1,284 files · 62 MB · synced 2m ago".** `lastFetchAt` gives "synced
  2m ago". Total file count and size **do not exist** and would need a
  daemon-side walk. **v1 drops the count/size**, keeps the sync time.

### 3.3 Git — read model half-exists, staging is now a primary interaction

`WorkspaceGitStatus` already returns `isRepo`, `clean`, `branch`, `tracking`,
`ahead`, `behind`, `files[{path, index, workingDir}]`, `lastCommit`,
`lastFetchAt`, `truncated`. On top of that:

| Design element                                                | Status                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| branch + `↑3 ↓1`                                              | **exists** (`branch`, `ahead`, `behind`)                                                        |
| staged / unstaged split                                       | **exists** (XY chars in `files`)                                                                |
| per-file `+128 / −12`                                         | **missing** — needs `--numstat`                                                                 |
| row click → open diff in the viewer                           | **missing** — needs `workspace/gitdiff` (§4)                                                    |
| per-row hover `+` / `−` stage toggle, Stage all / Unstage all | **missing** — write ops                                                                         |
| commit box, "Commit N files", commit-and-push                 | **missing** — write ops. Identity is already solved: `register/ok` carries `gitCommitIdentity`. |
| **AI commit-message generation** (wand button, loading state) | **missing** — new capability, §5.1                                                              |
| commit log vs base, unpushed markers                          | **missing** — needs a new read (`<base>..HEAD`, collapsed below the working half — see below)   |

"Commit log **vs base**" is literal, and is what the log read answers: with the
checkout on any branch other than the configured one, `workspace/gitlog` lists
`<base>..HEAD` (base = `origin/<workspace branch>`, the ref a session worktree is
created from) and returns that ref as `base`, so the panel can name the range.
The base branch's own history is not this session's work. Three cases keep the
full history instead — no configured branch, HEAD already on it (the agent's
primary checkout), or a base ref this checkout never fetched, where excluding a
missing ref would fail the read.

The log also sits **last and collapsed**: the working half (changed files, then
the commit box) is what a reader acts on, and an expanded history pushed both off
a 480px dock. The closed row still carries the count — the read happens anyway —
with a `+` when the page is a floor.

Revision 2 **removed** the Fetch / Pull / Stash button row that revision 1 had.
`workspace/gitpull` therefore keeps no UI home in the dock, and the plan drops
the `sessionId` extension that revision 1 called for. Refresh is the tab's
`refresh-cw` header action, which re-reads status — not a network pull.

**The refresh cadence (landed after M6).** A pressed refresh is not the only one:
every panel here reads a LIVE surface, so one that re-read only on demand showed
the tree as it was when the page opened. `dock/auto-refresh.ts` owns the three
signals, and every panel bumps the same tick a press does — there is no second
read path to keep in step:

| signal                    | when                                              | who takes it                                                            |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| a turn's **falling edge** | the agent's own writes have landed                | Files, Git, PR, Tasks — the highest-value signal, and free of any timer |
| a **poll**                | the tab is selected AND the document is visible   | Files/Git 15s, PR 60s (§9's GitHub budget), Tasks 5s/20s as before      |
| the **reveal edge**       | a tab becoming active, or the browser coming back | whoever deferred a turn refresh while hidden                            |

A refresh is also no longer a RESET. `useWorkspaceTree` used to wipe its cache and
its expand set on every `refreshTick`, which was defensible for a press and is
not on a timer: it would close the reader's folders every 15 seconds and shrink
the path filter's corpus (derived from the same cache) to root-level hits with
them. A refresh now re-reads the root **and each open folder** in place, silently
— the rows stand until the new listing lands. Only a SCOPE change still resets,
because there the previous expand set names paths in another checkout. For the
same reason the Git panel draws its last SETTLED outcome while a re-read is in
flight, rather than repainting the branch line as "Git status unavailable" every
few seconds — the latch the commit box already used, applied to the header.

Two rules make the cost defensible. A background tab and a background BROWSER
both poll **nothing** — these reads reach a daemon, and for the PR panel an
installation's rate limit. The PR tab's 404 retry ladder is gated on document
visibility for the same reason, and that gate is new with §12.6's second identity
source: a runless session's 404 is no longer answered from CP tables alone — it
costs a `workspace/gitstatus` REQ and, for a pushed branch with no PR, a GitHub
list. It is deliberately NOT gated on the tab being active, because a held 404
REMOVES the tab, leaving no tab to reveal and no way back. And a turn's edge reaches a HIDDEN panel only where
that tab shows a badge whose numbers are on screen anyway (Git's changed count,
PR's unresolved threads); a panel without one defers the read to the reveal edge
rather than re-reading a worktree nobody is looking at. The Git panel also skips
an automatic read while one of its OWN writes is in flight — that write answers
with the fresh status, and a read racing it would land the pre-write tree over
the reply.

Which turn: the workspace panels follow HEADER FOCUS, so their edge is the
focused participant's turn — the PR tab, which is keyed to the open session
(§3.4), takes that session's.

Consequence for sequencing: the Git panel's rows are _stage toggles_ in this
revision, so a read-only Git tab is a visibly amputated version of the design.
It is still worth shipping first — a reviewer reading what the agent changed is
the majority use — but the milestone must render the toggles absent rather than
inert, and say so.

### 3.4 PR — linkage exists, both the read projection and the write loop are new

> Revised after M6: the run is no longer the ONLY identity source. A session
> with no pull-request run resolves its PR from the worktree's own head branch
> instead — see §12.6's "second identity source", which is where that contract
> and its five deliberate limits live.

`HookRun` already stores everything needed to _find_ the PR for a session:
`sessionId`, `repoFullName`, `repoId`, `pullNumber`, `headSha`, `baseSha`,
`sourceInstallationId`, plus `verdict` / `reviewEvent` / `reviewAttemptState`
from the review broker. Installation tokens are already minted
(`github/installation-token.service.ts`), rate limiting exists
(`github/rate-limit.ts`), and the GitHub App already declares
`pull_requests: write` + `contents: write` (`setup/src/github-app.ts`) — so
resolving a review thread and arming auto-merge are inside the declared
permission set. Note the clamp in `mint()`: every capability is narrowed to the
agent's `access` tier, so a read-only workspace never receives a write scope.

Missing: the **read projection** (no BFF route returns PR state, checks, reviews
or threads; the session DTO does not expose its GitHub subject — `hookMetadata`
on the session route carries the _hook_, not the _run_), and the entire
**write loop** revision 2 adds:

- **One Auto-fix action** over the whole unresolved set. The prototype draws a
  four-state machine per thread (`open` → `fixing` → `fixed` → `resolved`, with
  Cancel/Reopen and a per-row patch count); **that is deliberately not being
  built** — see §5.2. Threads render read-only; a single Auto-fix hands the set
  to the agent as one turn.
- **Merge when ready** checkbox → an EDGE watcher (not GitHub auto-merge — see
  the M6 decision below for why that mutation cannot back this control),
  labelling the box "Watching" and replacing the hint with what the watcher is
  holding for ("Squash · waiting on checks running: build").

§5.2 covers how auto-fix has to be built. Storage rule stays: cache PR **status
and counts** briefly in memory (rate-limit pressure), never persist **review
thread bodies** — those are user content and belong to body-locality the same way
transcripts do.

### 3.5 Tasks — the concept exists, the wire does not

The daemon runs real background tasks: leases, `bg-task lifecycle` logging,
completion announce, deferred wake with a re-arm budget
([`background-task-aware-reclaim.md`](background-task-aware-reclaim.md)). None of
it is exposed — there is no `task/*` frame, no CP route, no console surface.

Revision 2 **removed the progress bar** that revision 1 drew, which settles the
question revision 1 left open: the panel renders state and elapsed, and does not
invent a percentage the daemon cannot supply. The "Logs" link still maps to
nothing today and stays deferred.

**The step line is unbacked too, and the panel is read-only.** Measured against
the shipped daemon and `@agentclientprotocol/sdk@1.3.0` while building M4:

- The lease's per-task record was `{ description?, isSubagent }` — no start time,
  no step, no history of a finished task (`settle()` deleted the entry). M4 adds
  a `startedAt` and a bounded settled-task history; there is still no step text
  anywhere in the `_claude/sdkMessage` feed, so the panel renders the
  `description` and nothing beside it.
- There is no `queued` state to render. The feed's only start edge is
  `task_started`, so a task is either live in the lease or gone.
- **`task/cancel` is not implementable and is not built.** `CancelNotification`
  carries only `{ sessionId }` (`session/cancel` cancels a whole prompt turn),
  `AcpHost` has no ext-request sender so no `_claude/*` kill-by-id can be sent,
  and the daemon advertises no terminal capability so the agent owns its own
  shells. The only hard stop is `AcpHost.stop()`, which kills the agent's shared
  adapter and every session on it. Worse, `interruptTurn` is a no-op exactly when
  the panel matters: a background task outlives its turn, so there is no
  `pending` entry and no cancel is sent at all. A per-row control could therefore
  only cancel unrelated work or report a cancellation it did not perform. It
  becomes possible with upstream work (a task-addressed ACP cancel, or a Claude
  adapter `_claude/*` kill-by-id request) — see §12.8.
- An absent lease is a real answer, not an empty one: a non-Claude runtime, an
  adapter without the lifecycle extension, and a session that has emitted no
  accepted lifecycle event all have none. `task/list` reports it as
  `tracked:false` so the panel can say "not reported for this session" instead of
  "no background tasks".

## 4. Gap analysis — the inline viewer

The viewer is the largest single addition in revision 2 and the reason the dock
becomes useful rather than informational.

**Layout.** `viewerOpen` and `chatOpen` are mutually exclusive: the viewer takes
the transcript _and_ the composer. The session header stays. This is a new
layout mode for `SessionDetailView`, which today always renders the transcript
below the header.

**Header.** file/diff icon, mono path, a **Diff / File pill toggle**, right-side
meta (`+128 −12` in diff mode, `TypeScript · 214 lines · 6.8 KB` in file mode),
a **Stage file / Unstage file** action, and a close `x`.

**File mode.** Line-numbered, syntax-colored source. `workspace/read` already
supplies the bytes and `@/lib/highlight` (`highlight`, `loadHljs`) already does
the coloring for `WorkspaceFiles` — this half is assembly, not new capability.

**Diff mode.** Unified diff with `@@` hunk headers, old/new line numbers derived
from the hunk header, a sign column, and per-line tint.

The renderer for this **already exists**: `LineDiff.tsx` emits exactly this table
— `kind: 'context' | 'add' | 'delete' | 'meta'`, an `oldLine` column, a `newLine`
column, a marker column — over the right tokens (`--status-online-soft`,
`--status-error-soft`, `--surface-sunken`). What it does _not_ do is accept a
diff: it takes two full texts and computes an LCS client-side, capped at
`MAX_DETAILED_DIFF_LINES` (2,000). Feeding it a git diff means:

1. a new **`workspace/gitdiff`** frame returning unified-diff text for one path,
2. a **unified-diff parser** producing `LineDiffRow[]`, and
3. reusing the existing table verbatim.

Fetching both blobs and reusing the LCS path instead would work but is worse on
every axis — two round trips per file, quadratic matching on large files, and it
throws away git's own rename/whitespace handling.

**Deep-linking.** Settled in M1: the viewer is URL-addressable, `?file=<path>`
plus `agent=<id>` on the session route. "Look at this file" is a link people send,
so it has to survive a reload and name the workspace it was made from; §9's M1
entry records the mechanics and why `replace` beats `push`. M2 adds `mode` to the
same param set when the Diff view arrives.

## 5. Gap analysis — the two AI features

### 5.1 Commit-message generation

A wand button in the commit box; while running, the icon becomes a spinner and
the box shows muted "Generating from staged diff…", then fills with a
conventional-commit subject plus body.

This is a **bounded utility call, not an agent turn**: no tools, no transcript
entry, no session state change. It must run on the daemon (§2) against the
agent's configured runtime, over the staged diff the daemon can already compute.
Shape: a new `workspace/gitmessage` REQ → REP taking `{ agentId, sessionId }` and
returning `{ ok, message?, detail? }`, with the daemon capping the diff it feeds
the model and returning `ok:false` rather than an error frame when the runtime
declines. Cost is real and visible — the button is explicit, never automatic.

### 5.2 Review-thread auto-fix — one action, one turn

This is a **real agent turn**: it reads code, edits files in the session
worktree, and should appear in the transcript like any other work the agent did.
The console already has a channel for exactly that — a webchat post travels
browser → relay → daemon with a CP-minted token, and the CP stays off the path.
So Auto-fix posts one structured instruction listing the unresolved threads
(each `location` + comment body) into the open session, and the resulting turn is
ordinary work: streamed into the transcript, its edits visible in the Git panel,
cancellable by the composer's existing stop control.

**Scope decision: there is exactly one Auto-fix, not one per thread.** The
prototype's per-thread state machine looks like a small feature and is not. It
requires attributing worktree changes to a specific thread — snapshot git status
per dispatch, correlate a `turnId` back to a card, diff the delta — and that
attribution collapses the moment two threads are fixed concurrently, because
their deltas overlap and neither card can honestly claim its numbers. Fixing that
means either serialising the threads into a queue the UI has to explain, or
teaching the daemon to attribute file changes to a turn. Both buy a per-card
`+6 −2` that the Git panel already shows for the whole change set.

What this removes from the build:

- no thread↔turn correlation map, client-side or CP-side;
- no git-status snapshot around dispatch;
- no `fixing` / `fixed` / `resolved` per-card states, no Cancel/Reopen;
- no sequential auto-fix queue;
- **no `/threads/:threadId/resolve` CP route.** Resolving threads belongs to the
  agent, not the console: agents already write back to GitHub with `gh` using
  installation credentials carrying `issues` / `pull_requests` capabilities
  (`installation-token.service.ts`), so the same turn that fixes the code can
  resolve the threads it fixed, under the clamp that already governs it.

What remains is small: one button, one webchat post, and a panel that re-reads
its projection when the turn settles. The threads list is display only — the
authoritative view of what the agent did stays where it already is, the
transcript and the Git panel.

## 6. Wire protocol additions

New/changed frames in `packages/protocol/src/frames/`. Changing a frame means
rebuilding `protocol` and checking **both** daemon and CP.

**`workspace.ts` — extend**

- `WorkspaceGitFile` gains optional `additions` / `deletions` (integers).
  Optional so an older daemon keeps working; the console renders the counts only
  when present.
- New `workspace/gitdiff` REQ → `workspace/gitdiff/result`: `{ agentId,
sessionId?, path, staged: boolean }` → `{ isRepo, exists, diff?: string,
binary?: boolean, truncated?: boolean }`. Unified-diff text, bounded by the
  256 KiB frame cap the way `workspace/read` is.
- New `workspace/gitlog` REQ → `workspace/gitlog/result`: `{ agentId,
sessionId?, limit }` → `{ isRepo, commits: [{ sha, shortSha, subject, author,
committedAt, pushed }], truncated }`. `limit` max 50; `pushed` is computed
  against the tracking ref.

**`workspace.ts` — write frames**

- `workspace/gitstage` / `workspace/gitunstage`: `{ agentId, sessionId?, paths[]
}` → the fresh `WorkspaceGitStatus`, so the panel never re-polls.
- `workspace/gitcommit`: `{ agentId, sessionId?, message }` → `{ ok, sha?,
detail? }`. Failure is data, not an error frame.
- `workspace/gitpush`: `{ agentId, sessionId? }` → `{ ok, detail?, ahead? }`.
- `workspace/gitmessage`: `{ agentId, sessionId? }` → `{ ok, message?, detail? }`
  (§5.1).

**`task.ts` — new file**

- `task/list` REQ → `task/list/result`: `{ agentId, sessionId }` → `{ agentId,
sessionId, tracked, tasks: [{ id, description?, state:
'running'|'done'|'failed', subagent, startedAt, endedAt?, detail? }], truncated
}`. `sessionId` is REQUIRED (the lease is per (agent, ACP session) and there is
  no per-agent aggregate but a boolean). No `queued` — nothing upstream reports
  one. `done` means "settled with no reported failure", because most settle edges
  carry no status at all; `detail` carries the reported status when there was
  one, and a later status-bearing terminal edge refines a retained row without
  re-announcing. `subagent` rows are CARRIED, not filtered at the source: the
  same records fence host reclaim, so a panel that dropped them here would show
  "no tasks" beside a host refusing to be reclaimed. Filter at render.
- **No `task/cancel`.** §3.5 records why no ACP primitive can address one
  background task. The panel's escape hatch is the composer's existing
  turn-scoped stop.

All of them follow the workspace convention: unknown agent → `BAD_PAYLOAD`,
unexpected failure → `INTERNAL`, everything else is data.

## 7. Control-plane BFF routes

All following the existing workspace-route shape in `agents.ts`: `getOrgAgent` →
`canReadWorkspaceScope` → `requireSessionWorkspaceRead` → `deps.control.X` →
`toDto`. Every route needs `tags`, `summary`, `description`, and a unique
`operationId` or it renders nameless in the OpenAPI docs.

| Method | Path                                                                         | Backing                                                     |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/agents/:id/workspace/gitdiff`                                              | `workspace/gitdiff`                                         |
| GET    | `/agents/:id/workspace/gitlog`                                               | `workspace/gitlog`                                          |
| POST   | `/agents/:id/workspace/gitstage` \| `gitunstage` \| `gitcommit` \| `gitpush` | write frames                                                |
| POST   | `/agents/:id/workspace/gitmessage`                                           | `workspace/gitmessage`                                      |
| GET    | `/agents/:id/tasks`                                                          | `task/list`                                                 |
| GET    | `/sessions/:id/pull-request`                                                 | Postgres identity + GitHub REST/GraphQL + `automerge/state` |
| POST   | `/sessions/:id/pull-request/auto-merge`                                      | `automerge/set` (edge watcher)                              |
| POST   | `/sessions/:id/pull-request/merge`                                           | GraphQL `mergePullRequest`                                  |
| POST   | `/sessions/:id/sandbox-keep-alive`                                           | `sandbox/keepalive` (edge lease)                            |

**`GET /agents/:id/tasks` does NOT use `canReadWorkspaceScope`**, and this
paragraph's earlier claim that it would was wrong. That gate requires
`workspaceIsolation === 'session'`, because a shared checkout has no per-session
worktree and the daemon answers `BAD_PAYLOAD` for one. Background tasks are not a
checkout: a session on a shared workspace runs them exactly the same, so reusing
the worktree gate would have 404'd the Tasks panel for most sessions. M4 split the
session half of that gate out as `visibleAgentSession` — the row must be this
agent's, un-purged, and pass the session's own private/external visibility rule —
and `canReadWorkspaceScope` is now that plus the isolation check. The tasks route
uses `getOrgAgent` → `visibleAgentSession` (404 `session not found`) →
`agent.daemonId` (503) → `requireTasks` (409 `DAEMON_FEATURE_MISSING`, on the new
`task-list-v1` marker) → `deps.control.taskList` → `toAgentTasksDto`. `sessionId`
is a REQUIRED querystring parameter, so an unscoped list is a 400 rather than a
guess, and `requireSessionWorkspaceRead` does not appear at all — it gates
worktree browsing, which this read is not. A daemon-named `unknown-agent` maps to
404 under its own `TASK_` code prefix; there is no 409 arm, because the read
mutates nothing.

The two `/sessions/:id/pull-request*` routes are the odd ones out — they are not
daemon proxies. Each resolves the session's `HookRun`, checks the viewer can see
that session, mints an installation token clamped to the agent's access tier,
and calls GitHub. 404 when the session has no linked run; the console hides the
PR tab on 404. The write route additionally requires the token to actually carry
`pull_requests: write` after clamping — a read-tier agent gets a disabled
control, not a failed call.

Auto-fix gets **no CP route at all**: it is a webchat post on the existing relay
path, and thread resolution rides the agent's own GitHub write-back (§5.2).

## 8. Web structure and tokens

New `packages/web/src/components/console/dock/`:

```
SessionDock.tsx        tab strip, badges, per-tab action, resize handle, persistence
dock-width.ts          clamp/persist the 380–760px width (localStorage, per org — mirror lib/session-pins.ts)
SessionsPanel.tsx      the ex-SessionRail row / pin / filter body, re-hosted
FilesPanel.tsx         narrow single-column tree over WorkspaceFiles' read model
GitPanel.tsx           status + numstat + staging + commit box + log
PullRequestPanel.tsx   the /sessions/:id/pull-request projection + Auto-fix / auto-merge actions
TasksPanel.tsx         task list (read-only — §3.5); polls while visible, backed off when idle
auto-refresh.ts        the dock's shared cadence: turn edge / poll / reveal edge (§3.3)
```

and `packages/web/src/components/console/viewer/`:

```
SessionViewer.tsx      the left-pane file/diff mode, header + Diff/File toggle
unified-diff.ts        unified-diff text -> LineDiffRow[] (feeds the existing LineDiff table)
```

`SessionRail.tsx` is **deleted** as of M0 — do not look there for the shared
primitives. Its rows, pin toggles and agent-filter chips moved wholesale into
`SessionsPanel.tsx`, where they are module-private: that file exports only
`SessionsPanel` plus the two verdict helpers `sessionsPanelWouldHide` and
`sessionsTabStatus`. A later panel that wants a row or chip primitive therefore
extracts one out of `SessionsPanel.tsx`; there is nothing to import today. What
was already shared stayed shared and is still where it was: pins in
`lib/session-pins.ts`, seed/filter helpers in `lib/session-rail-filter.ts` (still
`rail`-named — the one rename M0 deliberately left alone). The rail's column,
collapsed bands and open latch are `SessionDock.tsx`; its slot is
`SessionDockSlot`, which reserves the **persisted** width, not a constant — the
whole reason a slot exists (a body whose horizontal position is a constant of the
route, not of a round-trip) still applies, so the persisted width has to be on the
**first painted frame**.

**How the width gets there.** Not from a render: in no-auth mode the console is
genuinely server-rendered (`Shell.tsx` gates on `useState(!isAuthConfigured())`,
true on both sides), the server has no localStorage, and the browser paints the
SSR markup before hydration begins. A width React owned in that markup would also
be stuck there — React 19 does not patch a mismatched inline style or attribute,
which is measured in `dock/SessionDock.hydration.test.tsx`. So the width travels
as the `--dock-width` custom property, exactly like the console's existing
no-FOUC theme init: `DOCK_WIDTH_INIT` (`dock-width.ts`) is a blocking script the
`(app)` layout renders ahead of the shell, which reads the MRU entry, fits it to
`innerWidth` — the viewport is the reason the server could not have computed this
even from a cookie — and sets the property before any dock markup is parsed. The
track and the panel are sized by `w-[var(--dock-width)]`, `globals.css` carries
the default for a page whose script never ran, and React only keeps the property
current (drag, resize, org resolve) from a layout effect. Nothing about the width
is in the markup, so hydration has nothing to leave stale.

Both the dock and its slot withhold that first publication until they have
something better than a guess — the dock until storage is read, the slot until the
viewport is measured — because at the seeded viewport of `0` the ceiling is the
760px maximum, so an unfitted width would land over the script's fitted one and
become a first-frame jump the moment anything defers that read.
`dock/SessionDock.test.tsx` pins the published _sequence_ for both, not just the
value it settles on, which is the only way that class of defect is visible.

**Persistence and the org.** Widths are keyed by org, and `activeOrg` lands after
first paint, so a drag can settle while the id is still `''`. It is not written
there — an entry under `''` would take one of the 20 remembered slots and then
outrank every real org as the MRU answer for the next pre-org paint. The dock
holds that width and stores it under the org that arrives, in preference to
reading that org's older entry back over the edge the reader just moved.

The org can also land **mid-drag**, and both halves of that matter: the live width
is the reader's answer for the arriving org, so the seed keeps it instead of
snapping the edge back to a stored preference under their finger; and the release
persists through a ref rather than the closure `pointerdown` captured, which still
believed the id was `''` — it wrote the release nowhere and then spent that stale
pending width on whichever org was switched to next, destroying that org's
remembered width.

**Responsive.** Bands as built: inline column ≥1316px (`wide:`), floating
top-right trigger 769–1315px, app-bar trigger ≤768px. (The rail's own `wide:` was
1240px; the threshold moved with the arithmetic below, and `--breakpoint-wide` in
`globals.css` carries the new value.) The chrome the two columns
never get is 296px — 240px nav rail (EXPANDED: a media query cannot see it
collapsed, so a reader who collapses it gains 176px above the floor) + 60px
`.content` padding + 26px column gap
− the 30px the dock track bleeds back over that padding — so a 380px minimum
dock beside the full 880px body would need 1556px, well past every laptop. The
`wide:` threshold is therefore set from a **transcript floor** rather than from
880px: 296 + 380 + 640 = **1316px**, and above it the dock's APPLIED width is
clamped to `viewport − 296 − 640` so the transcript never drops under the floor.
The stored preference is untouched by that clamp — it is the reader's number and
comes back with the space.

**The step at the threshold is real and was chosen, not missed.** At 1315px the
track is `display:none`, so the body renders at its full 880px; at 1316px the
dock becomes inline and the body drops to the 640px floor. That is a 240px step
across one pixel of viewport, and on a 1440px laptop the transcript stays at
640px permanently — it only climbs back to 880px at 1656px (default preference)
or 1936px (a 760px preference). The alternative was an 880px floor, i.e. a
`wide:` of 1556px, which removes the step entirely but puts every 1366px and
1440px laptop on the overlay drawer forever. The dock is meant to be a surface
you work _alongside_, and 640px is still ~70–75 characters, so the step is the
accepted cost. Revisit this by changing `DOCK_BODY_FLOOR` in `dock-width.ts` —
`DOCK_WIDE_MIN` and the `wide:` breakpoint derive from it.

Both collapsed bands open the **same dock** as an
overlay sheet with the same five tabs — right-side drawer on desktop, bottom
sheet on mobile. The viewer is full-width in every band; on mobile it is the
whole screen with the dock closed. Tab labels: every label above ~560px of
RENDERED dock width, active-only below — and always active-only in the ≤768px
sheet, whose width is the viewport's rather than the dock's. Width-derived, not a
user preference (the prototype's `tabLabels` prop is a prototype affordance).

**Nothing to draw.** A panel with no content is not the dock's business to
invent, so each tab carries a `DockTabStatus` — `ready`, `loading`, or `empty` —
and the two non-ready values are kept apart because they mean different things to
a reader. When **every** tab reports one of them the dock withholds all its
chrome — strip, both collapsed-band triggers, the app-bar action — so there is no
way to open a void on a phone.

The _track_, though, is reserved at the dock's width in **every** status, ready or
not. This was tried the other way first — give the column back once every tab has
settled `empty` — and it is wrong, for the reason the rail it replaces already
wrote down: the list's verdict is a round-trip behind the session, so a collapsible
column shifts the transcript sideways when that verdict lands (130px at a 1440px
viewport, measured), and because this view survives navigation rather than
remounting, the same jump fires again on every dock click that crosses from a busy
agent to a quiet one. Holding the column costs a lone-session view an empty gutter;
it buys a body whose horizontal position is a constant of the route. That was the
rail's bargain at a fixed 250px and it is still the right one at 380–760px — the
width is the reader's own choice, and the resize handle stays available in the
vacant state so it remains theirs to narrow. The cost also shrinks to nothing as
the dock fills out: with five tabs, Files, Git and Tasks essentially always have
something, so `vacant` stops being reachable outside M0.

Do not re-derive this. "Reserve nothing when empty" is a local improvement that
trades away the invariant the reserved track exists for, and it looks like a win
right up to the point where the body moves.

The hosted panel stays mounted throughout — it owns the fetch whose verdict put
the dock in that state, and its scroll position and any open picker are its own.
"Mounted" here means **one position in one tree**: the dock renders a single
return with conditional chrome rather than an early return for the vacant case,
because two returns put `body` at two different paths and React reconciled the
second against a `<button>` and tore the panel down — re-running its pin read and
up to `SESSION_PIN_HYDRATE_MAX` detail fetches on every session load.
`SessionDock.test.tsx` asserts mount IDENTITY for this (one mount, and the same
DOM node), not the panel's mere presence, which the two-return version also
satisfied.

When some other tab does have content the chrome is up and the body says
which kind of nothing the active tab has: a spinner for `loading`, an empty line
for `empty`. Sessions derives its status from the verdict the panel already
reports upward (`sessionsTabStatus`), so an unreported verdict, and a hide over
inputs still in flight, are both `loading` — only a settled hide is `empty`.

**Accessibility.** In the collapsed bands the panel is `role="dialog"`
`aria-modal="true"` with the dock's label — modal because a scrim already blocks
the page behind it, and a reader offered content no pointer can reach is being
lied to. It takes focus on open, keeps it (Tab and Shift+Tab wrap around the
panel's own stops, and focus that has escaped is pulled back), hands it back to
whatever opened it, and closes on Escape (a popover inside it marks the press
handled first, so one press closes the innermost thing). The restore fires when
the panel still holds focus **or** focus sits on `<body>` — which is where a scrim
click leaves it, since pressing a non-focusable element focuses nothing; focus a
reader deliberately moved into the page is left alone.

All of that is gated on the band, not on the latch alone: above `wide:` the same
node is an ordinary column whose close button and scrim are both `wide:hidden`, so
a resize across 1316px drops the latch and withholds `role="dialog"`,
`aria-modal`, the panel's `aria-label` and the Tab trap — a column a reader cannot
Tab out of, announced as a modal nothing dismisses, is the failure this avoids.
The withholding is in _render_, because the latch is cleared in a passive effect
one frame later, and focus is deliberately **not** handed back on that crossing:
nothing was dismissed, and the panel is still on screen.

The strip is the ARIA tabs pattern: one tab stop on
the active tab, ArrowLeft/ArrowRight moving selection and focus with wrap. A tab
is named by its own content wherever that content renders, so a count pill is
part of the name; only a label the width took away is restored as `aria-label`.
The resize separator exists only above 768px, where the width it reports is the
width in front of the reader, and it is driven by Pointer Events with pointer
capture — the 769px+ band includes touch tablets with no mouse at all. In the
vacant state it is the dock's only control, and it rides in the reserved track
rather than the withheld panel, so it is reachable in exactly the band where the
gutter costs the transcript anything. The bottom
sheet pads with `env(safe-area-inset-bottom)`, as `.mnav` does.

**Icons.** The prototype paints `<span data-lucide>` from a CDN; the console uses
`<Icon name=… size=… />` from `@/components/ui`. Confirm each glyph exists before
the panel that needs it lands — `messages-square`, `folder-tree`,
`git-commit-horizontal`, `git-pull-request`, `list-checks`, `circle-dashed`,
`loader`, `check-circle-2`, `x-circle`, `file-diff`, `wand-sparkles`.

**Token map.** The prototype's hex, and the variable that replaces it:

| Prototype                      | Token                                                  | Use                                                                 |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `#c62a78`                      | `--brand`                                              | active tab, indicator, links, resize handle, primary button         |
| `#fdeef5`                      | `--brand-soft`                                         | active tab badge, selected chip, watching merge-when-ready          |
| `#11161d`                      | `--text-primary`                                       | titles, row text                                                    |
| `#6c7480` / `#8a919c`          | `--text-secondary` / `--text-tertiary`                 | labels, meta                                                        |
| `#98a0ab` / `#c2c7cf`          | `--text-disabled` / `--border-strong`                  | eyebrows, line numbers, checkbox borders                            |
| `#e3e6ea` / `#eceef1`          | `--border-default` / `--border-subtle`                 | dock border, dividers                                               |
| `#fbfbfc` / `#fff` / `#f2f3f5` | `--surface-app` / `--surface-card` / `--surface-hover` | dock bg, cards, row hover                                           |
| `#1b7f4d` / `#c1272d`          | `--status-online` / `--status-error`                   | additions, deletions, check + review states                         |
| `#a8630a` / `#2f6feb`          | `--status-paused` / `--status-info`                    | modified, unpushed, running                                         |
| `#eefaf3` / `#fdefef`          | `--status-online-soft` / `--status-error-soft`         | diff add / delete row tint — already what `LineDiff` uses           |
| `#f6f4fa`                      | `--surface-sunken`                                     | diff hunk-header row — already what `LineDiff` uses                 |
| `#6b4a8f`                      | `--purple-500`                                         | hunk-header text, code strings (near, not equal — accept the token) |

Mono (`Geist Mono`) for every path, sha, count, branch, timestamp, diff line and
command — that mono/sans split is a defining trait of the system, and the
prototype follows it exactly. Keep it.

## 9. Plan

Each milestone ships on its own and leaves the console coherent.

**M0 — Dock shell.** No backend work. Extract `SessionDock`, tab strip with
badges and per-tab action, drag-to-resize with clamp + persistence, responsive
rework, Sessions as the only tab present. _Exit:_ the Sessions rail behaves
exactly as today at every width, plus resize. **Landed.**

Known M0 follow-ups, none of which change what the code does today:

- Focus on the **vacant** resize handle is lost when the Sessions verdict lands:
  the handle renders at two tree positions (inside the reserved track when
  vacant, inside the fixed panel when not), so crossing that boundary recreates
  its node. A keyboard reader arrow-keying the empty gutter's handle restarts
  from the top of the document. The drag itself survives, and there is no cheap
  fix — the ready handle needs the fixed panel as its positioning context.
- `aria-label="Resize panel"` on the handle names a panel that the vacant state
  withholds.
- ~~The separator's `aria-valuemin` / `aria-valuemax` are unasserted.~~ Closed in
  review: `aria-valuemax` now derives from the same viewport ceiling the drag
  stops at, and both bounds are asserted in both bands.
- The vacant handle rides `.content`'s inner edge while the ready handle rides a
  viewport-fixed panel, so the two may sit a scrollbar-width apart. Unmeasured —
  happy-dom has no layout engine, so this needs a real browser to confirm.
- The pre-paint script paints the **most recently used** org's width, so a cold
  load into a different org still corrects once after hydration. Inherent to
  delivering a per-org width from a script that cannot know the org; making the
  width per-device instead would remove it.

**M1 — Files + file viewer.** Narrow single-column tree over the existing
`WorkspaceFiles` read model, session-scoped, git tags joined from
`workspace/gitstatus`, in-tree path filter, `lastFetchAt` footer. Left-pane
viewer in File mode over `workspace/read` + `@/lib/highlight`, including the
conversation↔viewer mode switch and the deep-link decision. No protocol change.
_Exit:_ browse a session worktree and read any file without leaving the session.
**Landed.**

The deep-link question §12 Q1 left open is settled the addressable way: the
viewer is `?file=<path>` on the session route, written with `router.replace` —
it is a pane mode inside one route, not a place, so pushing would spend a history
entry per tree click and Back would stop meaning "leave this session". The link
carries `agent=<id>` beside the path, because a merged conversation's header focus
is component state that follows whichever participant is newest: without the
workspace identity, a link copied while focused on one agent reopens that path
against another's checkout.

The conversation pane is **concealed, not unmounted** (`hidden` vs `contents` on
one JSX slot) — every expanded tool body, the composer's caret and any open
@mention menu is state a file read must not spend.

Known M1 follow-ups, none of which change what the code does today:

- ~~A `?file=` naming a **directory** — or a path that escapes the workspace —
  reads as "the daemon may be offline".~~ Closed in M2, which touched all three
  layers: a directory read is now DATA (`type:'dir'`), every other bad request
  carries a `WorkspaceErrorReason` the CP projects as a `WORKSPACE_*` code on a
  400/404/409, and the viewer branches on it. A reasonless `BAD_PAYLOAD` from an
  older daemon still reads as 503, deliberately.
- The filter corpus is rebuilt and sorted on every folder expansion even while
  the box is empty. Harmless at today's tree sizes; gate the memo on the query.
- ~~Two app-wiring mutants still survive: dropping the Files tab when
  `filesAgentId` is null, and the `dockTabKey` existence fallback.~~ Both pinned
  in M2, by a session whose agent is absent and by dropping the open tab under
  the reader (`SessionDetailView.viewer.test.tsx`).
- Four review fixes are **unpinned by tests**, all for the same missing fixture —
  a multi-agent focus menu with a pending or rejected `extraHeaderDetail`, which
  this suite does not build: holding the Files surface while a related session's
  isolation is unknown, the unavailable state when that read is rejected outright,
  keying the viewer on the whole workspace scope rather than the path alone, and
  the focus menu rewriting the link's `agent` so it is not a no-op while a file is
  open. The code is right; the guard is missing, and a test that cannot construct
  the state would be worse than none.

- A pending **webchat MCP write approval** is concealed with the composer and has
  no header twin the way permission requests do (those stay reachable in the
  Requests popover). A reader with a file open sees the agent stall. Either that
  card needs a home above the viewer, or the viewer needs to surface a pending
  count.
- The reader's **place in the transcript is not preserved** across a viewer round
  trip: the concealed pane stops contributing height to `.content`, so the browser
  clamps `scrollTop`. Restoring it needs the offset captured _before_ the swap and
  keyed per session, which is more state than this seam carries.
- The viewer's own scroller is a class-level arrangement: an `overflow-auto` box
  under `min-h-0 flex-1`, inside the `min-h-full` body column. happy-dom has no
  layout engine, so "it never grows the page" is unmeasured and needs a real
  browser — the same caveat as M0's resize handle.
- `SessionDetailFrame` keeps its 880px cap, so a cold load straight into `?file=`
  paints the centred loading state at 880px for one round trip before the viewer
  takes the full width. Invisible for a centred spinner; it becomes visible the
  day that frame draws content.
- The Files panel is mounted on **every** session page, not on first visit to its
  tab. Its verdict is what keeps the dock out of `vacant`, and a lazily mounted
  panel makes the tab unreachable — both tabs non-ready withholds the strip that
  would mount it. Cost: one `workspace/list` and one or two `workspace/gitstatus`
  reads per session page view.

**M2 — Git read + diff viewer.** `WorkspaceGitFile.additions/deletions`, the
`workspace/gitdiff` and `workspace/gitlog` frames + routes, the unified-diff
parser feeding the existing `LineDiff` table, Diff/File toggle in the viewer.
Panel renders branch/ahead-behind, staged/unstaged with counts, and the commit
log with unpushed markers. **Stage toggles and the commit box are absent, not
disabled** — the tab is explicitly a review surface at this point. _Exit:_ a
reviewer can read exactly what the agent changed, file by file. **Landed.**

Known M2 follow-ups, none of which change what the code does today:

- An **untracked** file has no diff in either scope (`git diff` never shows one),
  so its Git-panel row opens a Diff view that says so. Opening untracked rows in
  File mode instead would read better, and costs nothing new on the wire.
- The viewer's `+`/`−` are counted from the **rows on screen**, not from
  `WorkspaceGitFile.additions/deletions`: those count both sides of the index
  against HEAD, so beside a one-scope diff they would disagree with it. The
  consequence is that a truncated diff undercounts, which is why the header says
  `partial` beside the numbers.
- Two wiring guards are unpinned for the Git panel for the same reason M1 left
  them unpinned for Files — this suite cannot build a multi-agent focus menu with
  a **pending or rejected** `extraHeaderDetail`: holding the panel until the
  checkout is known, and the copy shown when that read is rejected outright.
- The Git panel is mounted on every session page like Files, and the real read cost
  is higher than "one more read": FilesPanel and GitPanel each call the uncached
  status hook, which fires twice in session scope, so a session view now issues
  FOUR `workspace/gitstatus` reads — each spawning a `git diff HEAD --numstat`
  child — plus three children for the log. One shared cached hook would make it
  one. Lazily mounting the panel is not the fix: its verdict is what keeps the
  dock out of `vacant`, so a lazy panel makes the tab unreachable.
- The commit log is the branch's own history, capped at 20. "vs base" — the
  design's phrasing — needs a merge-base the daemon does not report yet.
- A conflicted path yields TWO numstat rows for one path; the join takes the last,
  so its `+/−` is an arbitrary one of the two. The diff itself is drawn unsided and
  says so, so the counts are the only thing left guessing.
- The 64 KiB ceiling on the numstat read is **unpinned**: constructing an overflow
  needs thousands of dirty files, which is too slow for this suite. The bound is
  the same `gitRead` every other metadata read goes through.
- `--no-relative` on that read is defence, not a fix for a reachable bug: `isRepo`
  requires `.git` directly under the workspace root, so the read always runs AT the
  repo root and `diff.relative` cannot make its paths disagree with
  `git status --porcelain`. A review round flagged it as a live defect and a test
  written for it turned out to assert an unreachable state; the flag stays because
  it costs nothing if that ever changes.
- A diff that changes only line endings paints as identical-looking add/delete
  pairs, because the parser strips a trailing `\r` from every line.
- The Git tab's refresh re-reads status and log but not the open diff, so the
  panel's counts and the viewer can disagree until the reader reopens the row.
- `requireSessionWorkspaceRead` on the gitlog route and the `openStaged` wiring are
  both unpinned. The daemon advertises session-read and git-review together, so the
  first is defensive; the second is cosmetic.
- `check-circle-2`, which §8's icon list names, does not exist in this lucide
  version. M5 and M6 need a substitute before they use it.

**M3 — Git write + AI commit message.** Stage / unstage / commit / push frames
and routes, daemon handlers using the registered `gitCommitIdentity`, the
`workspace/gitmessage` utility call, per-row toggles, Stage all / Unstage all,
the commit box with the wand button, and the viewer's Stage file / Unstage file
action. _Exit:_ an operator can stage, commit and push an agent's work from the
console.

Known M3 follow-ups:

- The **busy predicate is unpinned**: dropping both turn terms of `workspaceMutationBusy` leaves 162
  tests green, so the half of serialisation that stops a console commit landing mid-turn has no
  coverage for either coordinator. This predates M3 but M3 is what made it load-bearing.
- `git add` / `git commit` hold the turn-admission fence without a ceiling, and a push holds it for
  60s while cold-host turns fail hard.
- A staged RENAME cannot be partially unstaged — it needs a `from` field on `GitStatusSummary` and
  `WorkspaceGitFile` first.
- The subject truncation can split a surrogate pair.
- No concurrency cap on the wand across tabs or users, and each press rewrites the warm host's
  selector caches (harmless today: only the prober and the extraction passes read them).
- No audit record for a surface that commits and pushes as the agent.
- The commit identity is GitHub-App-only, so M3's exit criterion is unmet for a deployment without
  one. The refusal is correct and says so, but the capability is missing rather than degraded.
- The write wiring in `SessionDetailView` was reconstructed after being lost to a stray
  `git checkout` during review; two of its three parts were caught by existing tests and the third
  (keeping header focus when the viewer closes) is still **unpinned**.
- `CommitBox` holds **no component state at all**. Everything per checkout — the draft, what is in
  flight, and the last outcome — lives in one module-level record read through `useSyncExternalStore`.
  The panel above unmounts the box while a newly selected scope settles, so any of the three held in
  component state is lost across `A → B → A`, and a request resolving after the switch calls the
  setter of an instance that no longer exists. Review found that same bug once per value across four
  rounds, every time inside a mechanism written to keep component state and a store in step. The
  record's SHAPE is the guard: a new per-checkout value goes in it, not beside it. Three earlier attempts coordinated the two
  and each left a window open, the last being `A → B → A → resolve` — the remounted box read the store
  before the answer landed and the completion then called an unmounted instance's setter. If a future
  change reintroduces component state here, that class of bug comes back with it.
- The `isUnbornHead` guard's remaining purpose — telling a read timeout or a spawn failure apart from
  an empty history — has **no constructible fixture**. Measured: every filesystem corruption git can
  be handed (a missing or unreadable `.git/objects`) makes git itself answer "not a git repository",
  which the runner preflight now classifies correctly and earlier. The guard stays for the failures
  that do reach it; its coverage is the classification, not the timeout.

**M4 — Tasks.** `task/list` over the lease, which M4 first extends with a
`startedAt` and a bounded settled-task history (kept in a `settled` array, never
in `lease.tasks`, so no reclaim decision can see it —
[`background-task-aware-reclaim.md`](background-task-aware-reclaim.md) and §3.5),
plus `GET /agents/:id/tasks` and a panel with state and elapsed. No cancel frame,
route or control: §3.5 records that none can be built honestly. _Exit:_ background
tasks are visible, and a settled one is showable without holding a session,
a host, or a workspace mutation open.

Two scope choices the panel makes that the other tabs do not, both because a lease
is not a checkout:

- **No isolation gate.** Files and Git withhold their read until the focused
  session's `workspaceIsolation` has answered, because reading early reads the
  wrong worktree. Tasks needs neither that round trip nor the `hasSessionWorktree`
  gate `filesSessionId` applies — a session's background tasks exist whatever it
  is checked out into, which is what the CP route says too. What it does need is
  the CANONICAL session id the lease is keyed by, so a playground session the
  daemon has not created yet gets no tab rather than a 404 notice.
- **Polling is gated on VISIBILITY alone, backed off when idle, plus one read on
  the tab's own activation edge.** Visibility is the whole gate because a hidden
  panel is a request nobody is looking at, while a visible one always has
  something left to discover. The first version also required a running task, on
  the reasoning that a settled list has no transition left to reveal — that was
  wrong about what the panel watches. It watches a **session**, not the rows on
  screen, and a session starts new background tasks: most directly when the reader
  leaves this tab open and sends another prompt from the composer beside it.
  Nothing in that path bumps the panel's revision, so an idle panel that stopped
  polling never observed the `0 → running` edge and the new task stayed invisible
  until a manual refresh. Found in review of #854. The idle cadence is backed off
  (20s vs 5s) rather than equal, because an idle session usually stays idle. The
  activation read stays for a different reason: the panel is mounted from the
  moment the session page opens, so a tab opened ten minutes later would otherwise
  draw a ten-minute-old list until the next interval. Elapsed ticks client-side
  from `startedAt`, so the 1s redraw costs no request. The consequence, accepted:
  the tab's running badge is only as fresh as the last read while the tab is
  closed — exactly what the Git tab's changed-count badge already is.

Known M4 follow-ups, none of which change what the code does today:

- The panel counts its own rows for the header census rather than trusting a
  separate total, so a `truncated` history makes the census describe what is on
  screen instead of what the daemon holds. That is the honest reading of a bounded
  list, but it does mean "3 done" can undercount a long-running session.
- `subagent` rows are shown and marked rather than filtered, because the same
  records fence host reclaim and hiding them would show "no tasks" beside a host
  refusing to be reclaimed. If they turn out to be noise in practice, the filter
  belongs behind a toggle, not in the default render.
- The panel's read is one effect keyed by `(agentId, sessionId, revision)` whose
  answer is HELD PER SCOPE and whose pending state is derived from it, not reset
  from a second effect. That shape is not cosmetic: the first version kept the
  poll count in its own state and zeroed it whenever the scope or the refresh tick
  moved, and zeroing it re-triggered the read effect it was there to describe — so
  past the first poll, every session switch and every press of the tab's refresh
  action issued TWO reads of the lease. Measured with a probe, then pinned by
  "re-reads ONCE for a scope switch and ONCE for a refresh, even after a poll has
  fired". Any future per-scope value here belongs inside that record, not beside it
  — the same rule M3 wrote down for `CommitBox`.
- The 1s elapsed redraw is **unpinned**: the tests pin `formatTaskElapsed` and the
  read cadence, not the interval that re-renders the row. Breaking the tick leaves
  a frozen elapsed and a green suite.
- All three of the route's 404s — agent invisible, session invisible, and the
  daemon's own `TASK_UNKNOWN_AGENT` — fold into one sentence in the panel. They are
  three ways for the scope to be unreadable and the reader's next action is the
  same for each, but a future need to tell them apart has to start at the code, not
  at the status.

**M5 — PR read.** Session DTO exposes its GitHub subject; `GET
/sessions/:id/pull-request` projection with a short in-memory TTL cache for
status and counts; panel with checks, reviews and threads **read-only** (no
Auto-fix, no Merge-when-ready). Tab hidden when the session has no linked run.
_Exit:_ PR state is visible beside the conversation that is reviewing it.
**Landed.**

Three things measured against the shipped CP before writing any of it, each of
which changes what M5 has to build:

- **There is no GraphQL client in the control plane.** `github/api.ts` exposes
  `githubRequest`, which is REST-only. Review-thread _resolution state_ does not
  exist in REST at all — `/pulls/:n/comments` returns review comments with no
  `isResolved` — so the design's "unresolved threads" section and its badge are
  unbackable without one. M5 therefore adds a minimal `githubGraphql` helper
  beside `githubRequest` (same installation auth, same timeout, same error
  mapping, POST to `/graphql`). M6 needs it regardless for
  `resolveReviewThread` and `mergePullRequest`, so this is not
  speculative plumbing — but it was missing from this plan's route table, which
  named both mutations as though the capability already existed.
- **`HookRun.sessionId` is not indexed.** The lookup this route is built on — a
  session id to the run that created it — would be a sequential scan of every
  run in the deployment. M5 adds a migration for it. Nothing else in the plan
  needed that column as a search key, which is why no index exists yet.
- **The PR association is already persisted, so identity needs no GitHub call.**
  `HookReviewProjection` carries `repoId`, `repoFullName`, `headSha`,
  `reportSha` and `lastResolvedInstallationId`, and `HookReviewSubject` carries
  `pullNumber`, `headSha`, `baseSha` and `isOpen` per projection — maintained by
  the review broker's own commit→PR association pass. The route reads the PR's
  identity and open/closed state from Postgres and spends GitHub calls only on
  what is genuinely live: check runs, reviews, and threads. That also means a
  rate-limited or denied GitHub call degrades to a panel that still names the
  PR, rather than an empty tab.

Two deliberate departures from M5's original sentence, found and settled while
finishing the inherited wip:

- **"Session DTO exposes its GitHub subject" is descoped.** The console finds
  the tab by probing `GET /sessions/:id/pull-request` once per session view: the
  404 arm costs 2–3 indexed DB queries and never reaches GitHub, and a linked
  session's probe is the same read the panel needs anyway, deduplicated by the
  service's TTL cache. Putting the subject on the session DTO would burden the
  session LIST route with a per-row run lookup (or a batched join) to save a
  probe that is already cheap — the sentence predates the probe design.
- **Verdict precedence is fallback, not override.** GitHub's review list is
  authoritative whenever it answered, because it already contains the agent's
  own review. The run's `reviewEvent` surfaces as `agentReview` only on degraded
  answers, so a rate-limited panel still shows the one review state the
  deployment knows without GitHub. A GitHub 5xx reads as `unreachable`, not
  `denied` — an outage must not point operators at a nonexistent installation
  problem.
- **A 404 probe is provisional, on a bounded ladder.** `hook/report` (which
  writes `HookRun.sessionId`) and the terminal `event/session` snapshot are
  separate concurrently-dispatched frames, so the session→run link can commit
  after the status flip — or with no flip at all, when a reconnect restores an
  already-terminal session. The panel therefore retries a held 404 on a bounded
  backoff ladder (~2.5 min, then the absence is believed); a status transition
  re-asks immediately and refills the ladder. These retries never reach GitHub —
  the 404 arm is answered from the CP's own tables — so §9's rate-limit budget
  is untouched, and an answered probe schedules nothing. The view service's
  cache keys by `repoFullName` too (the name drives the query and URL, and
  historical runs keep pre-rename names), and caches only the shared GitHub
  projection: each caller's run facts (`knownIsOpen`/`knownIsDraft`/
  `knownAgentReview`) are overlaid per return path, in-flight merges included.

**M6 — PR actions.** The single Auto-fix button over the webchat turn path
(§5.2), a direct squash Merge, and `Merge when ready` over an edge-run watcher,
all gated on the clamped token actually carrying write. _Exit:_ the design's headline loop — read
the review, hand it to the agent, arm the merge — works end to end.
**Landed.**

Decisions recorded while building it:

- **A Merge button beside merge-when-ready, both under one write capability.**
  The merge box draws a direct Merge (squash, `mergePullRequest`) next to the
  Merge-when-ready checkbox, each backed by its own route —
  `POST /sessions/:id/pull-request/merge` and
  `POST /sessions/:id/pull-request/auto-merge`. Both are disabled below write
  tier via the read projection's per-caller `canArmAutoMerge` flag
  (Postgres-only, computed in the route like the overlay facts — never cached).
  The Merge route is idempotent on a fresh node read, pins `expectedHeadOid` to
  the head the operator was shown, and relays GitHub declining it as a 409 the
  box shows as data; the mint carries `contents: write` beside
  `pull_requests: write` because the merge needs both, and the additional-repo
  comment tier is deliberately excluded (merging code).
- **`enablePullRequestAutoMerge` cannot back Merge-when-ready, so the watcher is
  ours and it runs at the EDGE.** GitHub refuses that mutation for any pull
  request whose `mergeStateStatus` is not `BLOCKED` — "Pull request is in clean
  status" once the checks pass, "unstable status" while they run on a repository
  with no REQUIRED status checks. On such a repository (the common case, this
  one included) there is no state in which the box can be armed at all, which is
  what made the control look broken rather than unavailable. Merge-when-ready is
  therefore an AgentConnect watcher: it polls the pull request and squash-merges
  once it is open, undrafted, conflict-free, has no failing or running check and
  nobody has requested changes. `REVIEW_REQUIRED` deliberately does NOT block —
  the operator ticking the box is the approval, and a repository with no required
  reviewers reports it forever. Each tick judges the CURRENT head and pins the
  merge to it, because merge-when-ready must allow the fix commit that turns the
  checks green; a failing tick keeps the watcher ARMED and surfaces its reason
  (`autoMergeWaitingOn` / `autoMergeError`), since the usual cure is that next
  commit.
- **Where the watcher runs, and why nothing is stored.** A cluster-placed agent's
  watcher is a process IN ITS POD: a new `automerge` shim capability
  (`src/shim/auto-merge-handler.ts`) spawns one `/opt/agentconnect/shim/auto-merge.js`
  per armed pull request, which fetches its own clamped `gh` token per tick over
  the existing gitcred tunnel. A locally-placed agent has no pod, so the loop
  runs in its daemon (`github/auto-merge/watcher.ts` dispatches on `clusterPlaced`,
  for the reason the next bullet records). Its own capability rather than
  a widening of `exec`: that channel is git-only and enforced IN the pod on
  purpose, and reaching `gh` through it would convert a deliberate boundary into
  an arbitrary-execution surface. The armed set is IN MEMORY at both placements
  and is never persisted — a reclaimed sandbox or a restarted daemon genuinely
  stops watching, and the box must read back unchecked rather than claim an
  intent nothing will act on. The image ships the entry, so a pod created from an
  older image answers `unsupported-image`, which the CP relays as a 409 naming
  the resume rather than a 503 that would read as "try again".
- **One predicate decides where a watcher may live, for every op.** `sandboxFor`
  answers on channel ATTACHMENT (`runsInSandbox` is `sessionFor(id)?.isAttached()`)
  and a suspended sandbox is an ordinary state for a cluster agent, so dispatching
  on it would let "arm while detached, read while attached" split the armed set:
  a daemon-local loop nothing could later see or stop, still polling and
  eventually merging behind an unchecked box. The watcher therefore dispatches on
  `clusterPlaced` — a property of the DAEMON (`--k8s` runs every agent in a pod)
  — and a cluster agent with no live channel refuses to arm with `sandbox-asleep`
  rather than arming somewhere else; the console's own wake action is the fix.
- **Arming refuses a pull request that is mergeable NOW (`already-mergeable`).**
  The loop's first tick is immediate, so arming a green pull request would
  squash-merge it inside one round trip — irreversible, from a single click on a
  checkbox whose label promises a wait, while the box's own Merge button
  deliberately takes two presses. The refusal is evaluated with the same
  `readiness` the loop uses, so "ready" has one definition; a probe that cannot
  reach GitHub does not block arming, since refusing on it would make an
  unreachable GitHub unarmable.
- **A closed pull request ends the watch, like a merge does — and the ENTRY goes
  with it, not just its timer.** `CLOSED` is terminal rather than "waiting": the
  operator's intent expired with the pull request, and a watcher left polling
  would merge it if the branch were reopened weeks later. Stopping the loop is
  not enough at either placement: a stopped loop left in the daemon's map is what
  `arm`'s idempotent fast path would hand back forever, so a reopened pull request
  could never be armed again. The daemon drops the map entry on the terminal
  status; in the pod the child EXITS on it, and the exit is what drops the
  handler's entry — the same path a merge already took.
- **Disarm fences the tick already in flight; it does not race it.** A tick reads
  a snapshot and a token before it decides anything, and an unticked box arriving
  inside that window used to be invisible to it: the continuation went on to
  squash-merge a pull request the operator had just been told was no longer
  watched. `AutoMergeLoop.stop()` therefore moves a generation counter that
  `tick` re-reads synchronously in the instant before the merge mutation — so
  once `stop()` has returned, no merge can still BEGIN — and `disarm` awaits
  `settle()` before answering, so `armed: false` is never reported while one could
  still be in the air. That last check has to sit past the MERGE TOKEN's own
  await: fetching the token is a round trip of its own (over the gitcred tunnel,
  in a pod), so `squashMerge` resolves it FIRST and gates immediately before the
  POST — a fence placed before that await has already passed by the time the
  request goes out. The in-pod child runs the same fence off `SIGTERM`, and the
  handler's disarm waits for that exit (SIGKILL bounds a wedged child) rather than
  answering the moment the signal is sent.
- **Both status strings are clamped where they are PROJECTED, not per hop.**
  `AutoMergeState` bounds `waitingOn`/`lastError` at `MAX_AUTO_MERGE_DETAIL` and
  the daemon does not validate on send, so one long GitHub message (the
  OAuth-App-restriction one is ~350 chars) would fail the CP's strict decode —
  surfacing as a 503 on the arm and `null` on every read after, over a watcher
  that is armed and merging.
- **The CP relays merge-when-ready and stores none of it.** No table, no
  migration, no background loop, no register-time replay: `automerge/set` and
  `automerge/state` are scoped request/reply frames like `task/list`, gated on
  the daemon advertising `auto-merge-v1`. The GET overlays the live answer onto
  the projection per caller (never cached), and `autoMergeArmed: null` means
  nobody could be asked — an offline daemon, or one too old — which the panel
  draws differently from a confident "not armed". A lost overlay never fails the
  panel read; it costs the toggle its state and nothing else.
- **An open page holds its agent's sandbox, and the same reads decide it.** The
  dock's Files, Git and pull-request panels now poll while the DOCUMENT is
  visible rather than only while their own tab is selected (`pollWhileHidden` in
  `auto-refresh.ts`), because the page's whole state is what an operator leaves
  open — and because two of those reads are what the daemon holds the session's
  pod for: an uncommitted worktree, or an armed merge-when-ready watcher, which
  for a cluster agent is a process inside that pod. The hold itself is a separate
  lease the page renews (`POST /sessions/:id/sandbox-keep-alive`, 60 s inside the
  daemon's 180 s TTL); the DAEMON decides whether to hold, so the console asserts
  nothing, and the lease lapses on its own when the page closes. See
  [k8s-daemon-pool.md](k8s-daemon-pool.md) §4. **The lease is keyed by the page's
  SESSION, not by the agent**, because the dirty-tree fact is per session: two
  pages on one agent read two different worktrees, and a single agent-wide entry
  let the page polling a clean session erase the lease a page watching a dirty one
  was renewing — last poll wins, and the sweep could suspend the pod out from
  under it. Each page now renews and releases only its own holder, the sweep asks
  whether ANY is live and logs the deduped union of their reasons, and a pod found
  asleep drops every holder at once — the volume they were taken on is gone. The PR panel opts in only once a
  pull request is actually LINKED: re-asking a 404 behind a hidden tab costs a
  daemon read and, for a pushed branch, a GitHub list, and the bounded retry
  ladder already covers a pull request that appears later.
- **Auto-fix's only follow-up is one forced re-read on the turn's falling
  edge.** The panel never watches the turn; it takes a `turnActive` prop, and a
  pressed Auto-fix arms a per-scope wait that the next falling edge consumes —
  one `refresh=true` read, because the write-back it waits for (resolved
  threads) happened on GitHub inside the turn and the CP TTL would hide it. No
  `onAutoFix` prop (a hook session with no live composer) means no button.

**Sequencing rationale.** M0 unblocks everything and is pure front-end. M1 is
nearly free and proves the dock at width. M2 makes the dock genuinely useful
while touching nothing mutable. M3 and M4 are independent once M2 lands and can
run in parallel; M3 is placed before M4 because staging is a primary interaction
of the design, not an epilogue. M5 carries the only external dependency (GitHub
rate limits, token clamping, thread pagination). M6 is last because it writes to
GitHub, but with per-thread auto-fix dropped it is now the _smallest_ milestone
in the plan rather than the largest — one button, one post, one GraphQL
mutation.

## 10. Tests

- **protocol** — schema round-trips for every new frame, including the optional
  `additions`/`deletions` absent case (old daemon).
- **daemon** — numstat, unified-diff and log parsing against a fixture repo;
  stage/unstage/commit/push against a scratch worktree including the dirty and
  diverged paths; task list over a lease with running/done/failed members; and
  the reclaim-safety pair that the retention exists to keep true — a settled task
  retained for the panel neither keeps its session open nor spends the
  background-task wake budget.
- **web** — the unified-diff parser is the highest-value unit test in the whole
  plan (hunk-header line-number arithmetic, no-newline-at-EOF, renames, binary);
  dock width clamp and persistence; tab-label collapse threshold; the
  conversation↔viewer mode switch; each panel's offline / non-repo / empty
  state; Sessions parity against the rail's own tests, which moved to
  `dock/SessionsPanel*.test.tsx` and must keep passing unchanged.
- **control-plane `test:unit`** — DTO projections, the PR projection's
  verdict-vs-GitHub precedence (GitHub's review list is authoritative when it
  answered — it already contains the agent's review; the run's recorded
  `reviewEvent` surfaces as `agentReview` ONLY on a degraded answer, so the
  panel cannot double-draw it), the "no linked run" 404 path, write-capability
  clamping.
- **control-plane `test:int`** — the authorization matrix on every new route:
  cross-org agent, restricted agent, session the viewer cannot see, agent with
  no live daemon (503), read-tier agent attempting a write route.

## 11. What changed from revision 1

| Area           | Revision 1                   | Revision 2                                                                                           |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Left pane      | transcript only              | transcript **or** file/diff viewer, mutually exclusive                                               |
| Git header     | Fetch / Pull / Stash buttons | branch + ahead/behind only; pull has no UI home                                                      |
| Git rows       | static                       | click opens the diff; hover `+`/`−` stages the file                                                  |
| Commit box     | plain textarea               | AI generate button with loading state                                                                |
| PR threads     | static text                  | four-state auto-fix machine per thread — **scoped down to one Auto-fix action, §5.2**                |
| PR merge       | plain Merge button           | Merge button (squash) **and** Merge-when-ready checkbox → an edge watcher that says what it waits on |
| Tasks          | progress bar per task        | no progress bar                                                                                      |
| Dock min width | 360px                        | 380px                                                                                                |
| Tab gap        | 2px                          | 0px                                                                                                  |

Two revision-1 open questions are now settled by the design itself: the Tasks
progress bar is gone (it was unbackable), and `workspace/gitpull` no longer needs
a `sessionId` (the pull control was removed).

**One deliberate departure from revision 2.** The per-thread auto-fix machine is
not being built; the panel ships one Auto-fix action for the whole unresolved
set (§5.2). The prototype's thread cards are therefore implemented read-only —
location and body. The review state on thread cards comes from GitHub's own
list; `HookRun`'s recorded review appears only as the degraded-arm fallback
(`agentReview`), never beside GitHub's answer.

## 12. Open questions

1. ~~**Viewer deep-linking.**~~ Settled in M1 — addressable, `?file=` + `agent=`,
   written with `replace`. See §4 and §9's M1 entry.
2. **Thread resolution.** §5.2 leaves resolving GitHub threads to the agent's
   own write-back inside the Auto-fix turn. Is that reliable enough in practice,
   or does the panel eventually need its own resolve control? Worth revisiting
   after M6 ships, not before.
3. **Files footer.** Is total file count + size worth a daemon-side workspace
   walk, or does "synced 2m ago" alone carry the panel? (v1 assumes the latter.)
4. **Path search.** A client-side filter over the loaded tree is a visibly
   partial answer at 1,284 files. Does Files need a `workspace/search` frame in
   M1, or can it wait?
5. ~~**Tasks scope.**~~ Settled: per ACP session. `sdkLease` is keyed by
   `sdkLeaseKey(agentId, acpSessionId)` and the only per-agent aggregate is the
   `agentHasLiveSdkWork` boolean, so `task/list` requires a `sessionId`.
6. ~~**PR tab visibility.**~~ Settled: an EMPTY STATE, not a hidden tab. A
   session whose worktree is a checkout keeps its PR tab on a 404 and the panel
   says what it found: **No upstream configured** for a branch that tracks
   nothing, the sentence "Publish this branch to set its upstream before
   creating a pull request.", and a **Create pull request** action that posts
   one turn on §5.2's path (the agent publishes the branch and opens the PR;
   there is no CP route that could). The tab is dropped only where a pull
   request is not a thing the session could have: no probe-able session id, or
   a workspace that is not a checkout at all. The branch facts come from the
   Git tab's verdict, so the empty state costs no extra read — but ONLY when
   that verdict is about this panel's own session worktree. Files/Git follow
   header focus and the PR tab deliberately does not (§3.4), so a focused
   participant's branch, or a shared workspace's primary checkout, is a
   different branch and is not named here at all.

   **Both write actions are single-agent only.** They post through the
   conversation composer with no `@mention`, and the relay's default for an
   unnarrowed webchat turn is EVERY participant — so in a multi-agent
   conversation one press would have three agents each publishing their own
   worktree and opening their own pull request (and, for Auto-fix, each fixing
   the same threads). The panel is session-keyed and deliberately holds no agent
   identity to narrow to, so `onPostTurn` is withheld above one participant and
   both controls render absent; the composer's own mention chips are the surface
   for asking ONE agent. The no-PR state is likewise drawn only off a git read
   of this panel's own session worktree, so a focused participant's checkout can
   neither name its branch here nor make this action appear.

   **The base is the workspace's, not the repository's.** A workspace may be
   configured onto a branch that is not the repository default (`release` while
   the default is `main`), and §3.3's commit range already measures the session
   branch against exactly that base — `origin/<configured branch>`. The
   instruction therefore names that branch, carried on the same Git verdict as
   the branch facts and reduced to the branch a PR can target. Where the read
   names none — no configured branch, HEAD already on it, or a base ref this
   checkout never fetched — the turn has the agent derive its base rather than
   naming the repository default, which only the first of those three cases
   would make right.

   **What this action cannot do, and how the panel says so.** A PR the agent
   opens from a conversation creates no `HookRun`, so a tab whose identity came
   only from the owning run kept answering 404 after the pull request existed.
   That gap is now closed by the second identity source below; what remains is
   a timing statement, and the panel says exactly that: once asked, it says the
   agent replies with the URL in the conversation and that this tab links the PR
   once the branch is pushed and one exists for it, and the control becomes
   **Ask again**. The instruction itself is idempotent (open one, or report the
   existing one), so pressing again cannot yield a second PR for the branch.

   **The second identity source (landed).** With no pull-request run, the route
   resolves the PR from the session worktree's OWN head branch:
   `SessionPullRequestLinkService` reads the branch from the owning daemon
   (`workspace/gitstatus`, session-scoped), resolves the agent's primary
   workspace repo and live installation (`GithubService.resolveWorkspaceRepo`),
   and asks GitHub `GET /repos/{o}/{r}/pulls?state=all&head=<owner>:<branch>`.
   The chosen number then joins the SAME projection a run-linked PR takes, so
   checks, reviews, threads, Auto-fix and auto-merge all work unchanged. Five
   things this deliberately keeps:

   - **The run stays PREFERRED.** It carries the review facts a branch lookup
     cannot know — the subject's open state, the run's draft fact, the agent's
     own recorded review — which are exactly what a degraded answer falls back
     on. The branch is the fallback, never an override.
   - **The branch, not the head sha.** A session branch is amended and rebased;
     its sha is not stable and `commits/{sha}/pulls` would go blind on the next
     rewrite. `head=` is fork-blind by construction, which reads as the absence
     it is.
   - **Absence, not degradation.** An unreachable, denied or rate-limited
     lookup resolves `null` — the degraded arm needs a PR to NAME, and identity
     that never resolved has none. The panel keeps its no-PR state for all of
     them.
   - **Two checkouts, and the shared one only for the session using it.** A
     session worktree's branch IS that session's work. A shared-workspace agent
     has no per-session worktree at all, and refusing to read its primary tree
     left this tab permanently empty for every such agent — while reading it for
     ANY session would hand an old one the newest session's pull request, whose
     branch replaced the one that carried its work. So the primary tree is read
     for the agent's most recently active session only, and `linkScope: shared`
     records that the answering checkout is the agent's primary tree. A purged
     session, a non-checkout workspace, and no daemon serving the agent all skip
     the daemon read entirely, so a session that can never resolve a PR spends
     none of the installation's quota. The daemon comes from the PLACEMENT
     (`servingDaemon`), like every workspace route: a pool- or cluster-placed
     agent has no `agent.daemonId`, and reading that column resolved no branch at
     all for exactly the deployments where every agent is placed that way.
   - **The ambiguity is reported, not hidden.** Several open PRs on one head are
     all equally "this session's": the lowest number wins (the first opened for
     the branch is the canonical review) and `linkAmbiguous` makes the panel say
     so. With none open, the highest number wins instead — the newest attempt is
     what describes the branch's fate. Two TTLs bound the cost: 60s for a link,
     15s for a miss (a PR opened seconds ago must not stay invisible), both
     bypassed by the panel's own refresh.

   `linkedBy` (`run` | `head-branch`), `linkBranch` and `linkAmbiguous` are on
   the DTO so the console can say which question it answered.

7. **Write authorization.** Committing as the agent and resolving GitHub threads
   from the console are new classes of action. Does workspace-write access plus
   the existing token clamp cover them, or do they need their own permission?
8. **Per-task cancel.** Blocked upstream, not by this plan (§3.5). It needs either
   a task-addressed cancel in ACP or a Claude adapter `_claude/*` kill-by-id
   request; until one exists, the honest control is the composer's turn-scoped
   stop. Revisit when the adapter grows one.
9. **Task history depth.** Settled tasks are retained per lease, capped at 20, and
   are erased with the lease on TTL-close, host reclaim and retention GC — so the
   panel cannot show what a reclaimed host was doing. Durable task history would
   mean persisting model-authored strings, which body-locality puts on the daemon,
   not the CP. Worth revisiting only if operators actually ask for it.
