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

| Tab      | Icon                    | Badge              | Header action   | What it shows                                                                                                                   |
| -------- | ----------------------- | ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Sessions | `messages-square`       | —                  | `plus`          | today / yesterday / previous-7-days session groups + agent filter chips                                                         |
| Files    | `folder-tree`           | —                  | `refresh-cw`    | workspace tree with git status tags, path search, branch + workdir header                                                       |
| Git      | `git-commit-horizontal` | changed count      | `refresh-cw`    | branch + ahead/behind, staged / unstaged with `+/−` and per-row stage toggle, commit box with AI message generation, commit log |
| PR       | `git-pull-request`      | unresolved threads | `external-link` | PR state, head→base, checks, reviews, unresolved threads with a single Auto-fix action, merge box with auto-merge               |
| Tasks    | `list-checks`           | running count      | `refresh-cw`    | background tasks with state, elapsed, step, cancel/rerun                                                                        |

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
  state. None of these may take down the dock, the viewer, or the transcript.
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
| commit log vs base, unpushed markers                          | **missing** — needs a new read                                                                  |

Revision 2 **removed** the Fetch / Pull / Stash button row that revision 1 had.
`workspace/gitpull` therefore keeps no UI home in the dock, and the plan drops
the `sessionId` extension that revision 1 called for. Refresh is the tab's
`refresh-cw` header action, which re-reads status — not a network pull.

Consequence for sequencing: the Git panel's rows are _stage toggles_ in this
revision, so a read-only Git tab is a visibly amputated version of the design.
It is still worth shipping first — a reviewer reading what the agent changed is
the majority use — but the milestone must render the toggles absent rather than
inert, and say so.

### 3.4 PR — linkage exists, both the read projection and the write loop are new

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
- **Merge when ready** checkbox → GitHub auto-merge, flipping the button from
  "Merge" to "Auto-merge armed" and the hint from "Squash and merge" to
  "Squash · after checks + approvals".

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
question revision 1 left open: the panel renders state, elapsed, and a step line,
and does not invent a percentage the daemon cannot supply. The "Logs" link still
maps to nothing today and stays deferred.

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

- `task/list` REQ → `task/list/result`: `{ agentId, sessionId }` → `{ tasks: [{
id, description, state: 'queued'|'running'|'done'|'failed', startedAt,
endedAt?, detail? }], truncated }`.
- `task/cancel` REQ → `task/cancel/result`: `{ agentId, sessionId, taskId }` →
  `{ ok, detail? }`.

All of them follow the workspace convention: unknown agent → `BAD_PAYLOAD`,
unexpected failure → `INTERNAL`, everything else is data.

## 7. Control-plane BFF routes

All following the existing workspace-route shape in `agents.ts`: `getOrgAgent` →
`canReadWorkspaceScope` → `requireSessionWorkspaceRead` → `deps.control.X` →
`toDto`. Every route needs `tags`, `summary`, `description`, and a unique
`operationId` or it renders nameless in the OpenAPI docs.

| Method | Path                                                                         | Backing                              |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------ |
| GET    | `/agents/:id/workspace/gitdiff`                                              | `workspace/gitdiff`                  |
| GET    | `/agents/:id/workspace/gitlog`                                               | `workspace/gitlog`                   |
| POST   | `/agents/:id/workspace/gitstage` \| `gitunstage` \| `gitcommit` \| `gitpush` | write frames                         |
| POST   | `/agents/:id/workspace/gitmessage`                                           | `workspace/gitmessage`               |
| GET    | `/agents/:id/tasks`                                                          | `task/list`                          |
| POST   | `/agents/:id/tasks/:taskId/cancel`                                           | `task/cancel`                        |
| GET    | `/sessions/:id/pull-request`                                                 | GitHub API via installation token    |
| POST   | `/sessions/:id/pull-request/auto-merge`                                      | GraphQL `enablePullRequestAutoMerge` |

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
TasksPanel.tsx         task list + cancel
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
| `#fdeef5`                      | `--brand-soft`                                         | active tab badge, selected chip, armed auto-merge                   |
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
- The `isUnbornHead` guard's remaining purpose — telling a read timeout or a spawn failure apart from
  an empty history — has **no constructible fixture**. Measured: every filesystem corruption git can
  be handed (a missing or unreadable `.git/objects`) makes git itself answer "not a git repository",
  which the runner preflight now classifies correctly and earlier. The guard stays for the failures
  that do reach it; its coverage is the classification, not the timeout.

**M4 — Tasks.** `task/list` + `task/cancel` frames over the existing lease
bookkeeping, `GET /agents/:id/tasks` + cancel route, panel with state, elapsed
and step. _Exit:_ background tasks are visible and cancellable.

**M5 — PR read.** Session DTO exposes its GitHub subject; `GET
/sessions/:id/pull-request` projection with a short in-memory TTL cache for
status and counts; panel with checks, reviews and threads **read-only** (no
Auto-fix, no Merge-when-ready). Tab hidden when the session has no linked run.
_Exit:_ PR state is visible beside the conversation that is reviewing it.

**M6 — PR actions.** The single Auto-fix button over the webchat turn path
(§5.2), and `Merge when ready` (`enablePullRequestAutoMerge`) gated on the
clamped token actually carrying write. _Exit:_ the design's headline loop — read
the review, hand it to the agent, arm the merge — works end to end.

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
  diverged paths; task list over a lease with queued/running/done/failed
  members; cancel of an already-settled task is a no-op, not an error.
- **web** — the unified-diff parser is the highest-value unit test in the whole
  plan (hunk-header line-number arithmetic, no-newline-at-EOF, renames, binary);
  dock width clamp and persistence; tab-label collapse threshold; the
  conversation↔viewer mode switch; each panel's offline / non-repo / empty
  state; Sessions parity against the rail's own tests, which moved to
  `dock/SessionsPanel*.test.tsx` and must keep passing unchanged.
- **control-plane `test:unit`** — DTO projections, the PR projection's
  verdict-vs-GitHub precedence, the "no linked run" 404 path, write-capability
  clamping.
- **control-plane `test:int`** — the authorization matrix on every new route:
  cross-org agent, restricted agent, session the viewer cannot see, agent with
  no live daemon (503), read-tier agent attempting a write route.

## 11. What changed from revision 1

| Area           | Revision 1                   | Revision 2                                                                            |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| Left pane      | transcript only              | transcript **or** file/diff viewer, mutually exclusive                                |
| Git header     | Fetch / Pull / Stash buttons | branch + ahead/behind only; pull has no UI home                                       |
| Git rows       | static                       | click opens the diff; hover `+`/`−` stages the file                                   |
| Commit box     | plain textarea               | AI generate button with loading state                                                 |
| PR threads     | static text                  | four-state auto-fix machine per thread — **scoped down to one Auto-fix action, §5.2** |
| PR merge       | plain Merge button           | Merge-when-ready checkbox → armed auto-merge                                          |
| Tasks          | progress bar per task        | no progress bar                                                                       |
| Dock min width | 360px                        | 380px                                                                                 |
| Tab gap        | 2px                          | 0px                                                                                   |

Two revision-1 open questions are now settled by the design itself: the Tasks
progress bar is gone (it was unbackable), and `workspace/gitpull` no longer needs
a `sessionId` (the pull control was removed).

**One deliberate departure from revision 2.** The per-thread auto-fix machine is
not being built; the panel ships one Auto-fix action for the whole unresolved
set (§5.2). The prototype's thread cards are therefore implemented read-only —
location, body, and the review state that already comes from `HookRun.verdict`.

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
5. **Tasks scope.** Per _agent_ or per open _session_? The design implies
   session and the daemon's leases are per ACP session, so session is the cheap
   answer — confirm it is the useful one.
6. **PR tab visibility.** Hide entirely for non-PR sessions, or show an empty
   state? Hiding keeps the dock honest but makes the tab strip change shape
   between sessions.
7. **Write authorization.** Committing as the agent and resolving GitHub threads
   from the console are new classes of action. Does workspace-write access plus
   the existing token clamp cover them, or do they need their own permission?
