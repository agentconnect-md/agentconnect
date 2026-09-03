# The Host-Neutral Git Workspace Model

> **Status:** Implemented through rollout steps 1–3 plus the console tiles of
> step 4 (§8) — the wire `git` arm + `workspace-git-v1`, the daemon decoder,
> the storage migration with `gitCredentialProvider`, the unified input +
> derivation + resolve endpoint, and per-peer dual encoding. Still open: the
> picker's move onto the resolve endpoint (the browser-direct GitHub reads
> survive it for now), and step 5 — dropping the legacy arms and the dual
> encoding — waits for the fleet. This document re-models the workspace
> contract that [github-app-git-credentials.md](github-app-git-credentials.md)
> and [gitlab-com-integration.md](gitlab-com-integration.md) share implicitly;
> both keep describing their credential tracks and point here for the
> workspace shape.

## 1. Why

Today the workspace discriminant is the code host: `scratch | github | gitlab`.
That bakes a UI notion — which picker the repository came from — into the wire
contract, the database, and two independently written route validations. One
class of defect followed from it repeatedly:

- Replacing a workspace refused the anonymous public repository that creating
  an agent had always accepted, because the two routes validated the `github`
  arm independently and only one kept the anonymous branch (#1561).
- The console reported a public repository on a foreign account as App-backed,
  because the client — not the server — decided which installation vouched for
  a repository, and the write path then refused its own picker's choice (#1561).
- An unstated access tier meant `write` at creation and `read` on the next
  edit, because each route carried its own default (#1567).
- Public GitLab projects and bare Git servers are representable on the wire
  (the `github` arm's `gitRepo` is deliberately host-agnostic) but reachable
  from no console surface, because every surface is host-shaped.

The daemon never had this problem, because it never adopted the host-shaped
model. It collapses the wire modes on arrival (`write-agent.ts`,
`mapWorkspaceMode`) into `git-repo | from-scratch` plus an independent
`gitCredential: 'github-app' | 'gitlab' | absent`, and its ~2000-line workspace
manager branches on that pair exclusively. **This design promotes the daemon's
internal model to the wire, the control plane, and the console.**

## 2. The invariant

**`mode` answers "is there a repository"; `credential` answers "who vouches for
it".** Two orthogonal axes, never re-combined into one discriminant:

- A new code host is a new `credential` variant — never a new `mode`, so it
  cannot re-introduce per-host route arms or per-host console modules.
- "Anonymous + write" is unrepresentable: `access` lives inside the credential,
  and an anonymous workspace has no credential to carry it. The bug class
  #1561 fixed at runtime is gone structurally.

## 3. Wire contract (protocol `AgentWorkspace`)

```ts
{ mode: 'scratch', isolation, gitCredential?, additionalRepos }   // unchanged
{ mode: 'git',
  isolation,
  gitRepo,                    // FULL cloneable https/ssh address (normalizeGitCloneUrl)
  branch,
  agentDir?,
  credential?:                // absent ⇒ anonymous clone; the host's own policy
                              // (workspaceGitAllowedOrigins) still gates the origin
      { provider: 'github' }                    // minting re-resolves the live
                                                // installation by owner, as today
    | { provider: 'gitlab', projectId },        // rename-stable id; gitcred v2
                                                // verifies every echo against it
  additionalRepos }
```

The `git` arm is a near-identity mapping onto the daemon's internal model, so
the daemon-side change is essentially the decoder. `installationId` stays off
the wire (minting resolves live by owner, so uninstall→reinstall self-heals);
`access` stays off the wire (the CP clamps minted tokens server-side; the
daemon never reads it today either).

The `github` and `gitlab` arms remain decodable during the transition (§8).

## 4. Storage (control plane)

- `workspaceMode` collapses to `scratch | git`; a migration rewrites
  `github | gitlab → git`.
- New column `gitCredentialProvider: 'github' | 'gitlab' | null`. It cannot be
  derived from existing columns: `workspaceRepoId` is shared between GitHub's
  numeric repo id and GitLab's project id, so provider must be explicit.
  Backfill: `github` rows with an `installationId` → `'github'`; `gitlab` rows
  → `'gitlab'`; everything else → null.
- `installationId`, `workspaceRepoId`, `gitAccess`, `workspaceIsolation` stay.
  `gitAccess` is meaningful only where `gitCredentialProvider` is non-null.

## 5. API surface

One workspace input shape, shared verbatim by agent creation and workspace
replacement:

```ts
{ mode: 'scratch' }
{ mode: 'git', gitRepo, gitBranch?, agentDir?, worktree?, access?: 'read' | 'write' }
```

- **`installationId` and `projectId` are removed from input.** Provenance is a
  server-side fact derived from the address (§6). Every #1561-class bug shared
  the same root: the client reported provenance and two routes verified it
  independently.
- `access` on the input is a request; the derived credential records the
  result. Unstated `access` takes the highest tier the target carries (#1567):
  `write` where credentials are minted, `read` for an anonymous checkout, and
  an explicit `write` against an anonymous target is refused.
- Shorthand convention: bare `owner/repo` is GitHub-only sugar. Every other
  host is written as a full https/ssh URL; a dotted two-segment input is not
  reinterpreted as a bare host.

### The read shape

The agent DTO's workspace mirrors **persisted** state — the provenance fixed at
the last workspace write (§9), never a live re-derivation:

```ts
{ mode: 'scratch' }
{ mode: 'git', gitRepo, gitBranch, agentDir?, worktree,
  credential?: { provider: 'github', access: 'read' | 'write' }
             | { provider: 'gitlab', access: 'read' | 'write', projectId } }
```

The console renders an existing workspace from this shape alone. Rendering
through the live resolver instead would silently re-badge an anonymous
workspace the moment its owner installs the App — exactly the auto-upgrade §9
rules out. The resolve endpoint below exists for **picking**, i.e. previewing a
prospective write; it is never consulted to display a stored workspace.

### The resolve endpoint

`GET /orgs/:orgId/git/resolve?gitRepo=…` runs the same derivation the write
paths run — for the **authenticated caller**, since eligibility is per-user
(§6) — and returns the outcome: provider, that caller's access ceiling,
canonical address, default branch. The picker's badges and branch defaults come
from it, so the picker can no longer disagree with the write path about what a
pick means. It also replaces the console's browser-direct `api.github.com`
reads (rate-limited, unauthenticated, and a second implementation of the
server's rules) over time.

## 6. Credential derivation — one function, three callers

`deriveWorkspaceCredential(orgId, actorUserId, gitRepo, requestedAccess?)`,
called by the create route, the replace route, and the resolve endpoint. No
other code decides provenance.

The two inputs answer different questions and both are required. **Provenance**
depends only on `(orgId, gitRepo)` — which installation or binding vouches.
**Eligibility and tier** depend on the actor: where identity attestation is
configured, the GitHub outcome runs `githubUserAuthz.assertAccess(actorUserId,
installation, owner, repo, access)` inside the derivation, so two members of
one organization can legitimately receive different ceilings — or a refusal —
for the same address. The write paths pass the requested tier (unstated ⇒ the
target's highest, §5) and are refused when the actor does not hold it; the
resolve endpoint passes the authenticated caller and returns that caller's
ceiling instead of enforcing one. Keeping the gate inside the one function is
the point: an implementation that hoisted it back into a route would
re-introduce exactly the route-local divergence this design removes.

| Target                                                            | Outcome                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| github.com, a live installation covers the owner, repo resolves   | `{ provider: 'github' }` — catalog row converges, identity gate runs                                                                                                                                             |
| github.com, a live installation covers the owner, repo missing    | **refuse**: an installation token reads any public repository, so a miss under a covered owner is private-and-ungranted or absent; an anonymous clone cannot serve it, and the actionable answer names the grant |
| github.com, no covering installation, anonymous read says public  | anonymous                                                                                                                                                                                                        |
| github.com, no covering installation, not public                  | **refuse**                                                                                                                                                                                                       |
| the deployment's GitLab host, managed binding exists              | `{ provider: 'gitlab', projectId }`                                                                                                                                                                              |
| the deployment's GitLab host, unbound, anonymous read says public | anonymous                                                                                                                                                                                                        |
| the deployment's GitLab host, unbound, not public                 | **refuse** ("add the project first")                                                                                                                                                                             |
| any other host (bare Git, an unmanaged GitLab instance, GHE, …)   | anonymous — no preflight; the daemon's clone boundary reports failure, exactly as creation behaves today                                                                                                         |
| anonymous outcome + requested `access: 'write'`                   | **refuse** ("write requires managed credentials")                                                                                                                                                                |

Host comparison for the GitLab branch reuses `gitlabManagedHost` (§24.1 of the
GitLab design; the base URL may carry a path prefix an origin may not).

## 7. Console

Provider tiles stay — they carry the lexicon and the guidance a neutral input
cannot (`org/name` shorthand, "install the GitHub App", "connect GitLab",
provision-on-pick):

| Tile           | Accepts                                | Candidates                                                    |
| -------------- | -------------------------------------- | ------------------------------------------------------------- |
| From scratch   | —                                      | —                                                             |
| From GitHub    | `org/name`, full URL                   | installation roster, owner-scoped exact lookup, public search |
| From GitLab    | `group/project`, full URL              | bound projects, bindable projects, **public projects** (new)  |
| From a Git URL | full https/ssh URL only — no shorthand | none; static "host credentials" note                          |

- Every tile produces the same payload: one `gitRepo` address (plus branch,
  directory, worktree, access). The tile chooses how you type, never what is
  stored.
- The Git URL tile refuses github.com and the deployment's GitLab host with a
  switch-tile hint, so tile ↔ stored-shape stays injective by construction.
- **No `source` field is stored.** The displayed tile is derived from host +
  credential (`provider 'github'` → GitHub; `provider 'gitlab'` → GitLab;
  anonymous on a managed host → that host's tile with a `public` badge;
  anonymous elsewhere → Git URL with a `host credentials` note). A stored
  choice would contradict the derived credential and go stale as capabilities
  change; the derivation cannot.

## 8. Rollout — readers first

1. **protocol**: add the `git` arm and credential union; keep decoding the
   `github`/`gitlab` arms. Define the `workspace-git-v1` daemon feature.
2. **daemon**: decode the `git` arm (near-identity onto the internal model);
   advertise `workspace-git-v1`.
3. **control plane**: the derivation function, the storage migration, both
   routes on the unified input, the resolve endpoint. Spec assembly
   dual-encodes: the `git` arm to daemons advertising `workspace-git-v1`, the
   legacy arms to everyone else — an old daemon must never receive a frame it
   fatals on. Before dual encoding begins, every gate that branches on
   `workspace.mode === 'gitlab'` today (the `requiredGitlabFeatures` checks at
   direct placement and on the serving daemon, §17.3/§24.4 of the GitLab
   design) re-keys onto `credential.provider === 'gitlab'`, or a `git`-mode
   workspace would slip past the daemon-capability fence.
4. **web**: the four tiles over the resolve endpoint; delete the browser-direct
   GitHub reads.
5. **cleanup** once the fleet advertises the feature: drop the legacy arms and
   the dual encoding.

Each step ships independently; nothing observable changes before step 3.

## 9. Decided

- **Provenance is fixed at write time and re-derived on the next workspace
  write — never auto-upgraded.** An anonymous workspace whose owner later
  installs the App stays anonymous until someone edits it; silently escalating
  a workspace's credentials is worse than a stale anonymous checkout.
- **Bare Git rides the anonymous arm** ("host credentials"): the daemon
  installs no helper, so clone/push use whatever git credentials the machine
  itself holds. Works self-hosted; fails at clone time in a sandbox pool. A
  distinct `{ provider: 'host' }` variant — which would let placement refuse a
  pool for such a workspace up front — is future work, not this design.
- **A covered owner's ungranted repository refuses; it never degrades to
  anonymous** (from #1561 review): the miss proves the repo is
  private-and-ungranted or absent, and the useful error names the grant.

## 10. Non-goals

- New credential providers (GitHub Enterprise, Bitbucket, `host`). The union is
  where they land when wanted; this design only guarantees they will not need a
  new mode.
- Changing the `scratch` arm, additional repositories, gitcred v2, or the
  daemon's clone-origin policy (`workspaceGitAllowedOrigins` remains the
  operator's boundary and the only place the host list lives).
- Skill sources, which stay deliberately GitHub-only
  ([shared-skills.md](shared-skills.md)).

## 11. Session isolation under an OS boundary (decided 2026-09-02)

`isolation: 'session'` promises each logical session its own directory. How that
directory is made depends on whether an OS boundary encloses the runtime — the
promise is one, the implementation is not:

| Condition                                     | Per-session directory                     | ACP host                      | Console label       |
| --------------------------------------------- | ----------------------------------------- | ----------------------------- | ------------------- |
| no boundary (self-hosted daemon, sandbox off) | `git worktree` of the primary (unchanged) | one per agent                 | "worktree"          |
| self-hosted daemon, sandbox effective         | **per-session clone**                     | **one per session**           | "session isolation" |
| managed pool                                  | **per-session clone**                     | **one per session (its pod)** | "session isolation" |

"Boundary present" is `effectiveRunInSandbox(...)` on a self-hosted daemon and
always true on a pool member: a pool runtime is isolated by its own pod, the
daemon keeps the in-process sandbox off there and advertises no `sandbox`
capability, so `runInSandbox` is not a pool-side knob at all. The console label
derives from that effective value, never from the stored flag.

### Why the worktree cannot serve the confined case

A linked worktree keeps its index under the owner checkout's
`.git/worktrees/<sid>/` and writes every commit's objects and refs into the
owner's `.git`. A confined session can therefore commit only if that shared
`.git` is writable — and once it is, every session of the agent can rewrite every
other session's refs, index and objects, including the branch another session is
about to push. Unconfined, the runtime already owns the machine and the shared
`.git` adds nothing; confined, it defeats the boundary the agent asked for.

Nor can the confined case be rescued with a smarter grant. The Codex runtime's
inner sandbox pins the cwd's _resolved_ git directory read-only and resolves
conflicts by most-specific path; a subtree grant on the sessions parent never
reaches a clone's own `.git` (its `index.lock` stays on a read-only mount), a
glob grant is refused outright, and only an exact per-session path opens it.
An exact path exists only for a host that knows which session it serves — hence
one host per session, which is also what a private per-session `HOME` and a
per-session sandbox policy need.

### The clone

`git clone --filter=blob:none` — a blobless partial clone from the remote,
through the daemon's own credential path, exactly like the first clone of a
primary today. It checks out the tip and carries the **whole** commit history
(messages, authors, trees); old file contents are fetched lazily on `blame`,
`show` or `diff` of a past revision, which needs the session's read-tier fetch
credential. Measured on a ~1,500-commit repository: ~4 s and 17 MB against 12 MB
for a depth-1 clone and 30 MB for a full one; `--filter=tree:0` is rejected
(a path-scoped `git log` fetches trees one round trip at a time). The confined tier never clones by hardlink from a primary checkout on the same
disk: a hardlinked object file is the primary's own inode, and a session granted
write on its clone's `.git` could reach through it — `chmod`, truncate,
overwrite — to mutate the primary and every other clone sharing that inode,
which is exactly the cross-session channel this section removes. A copy or a
filesystem reflink is an acceptable local acceleration; alternates (`--shared`)
are never used, because a prune in the source breaks every clone that borrows
from it.

Layout, one directory per session, removed whole at retirement:

```
<agentDir>/sessions/<sid>/
├── workspace/            # primary clone — the session cwd
├── repos/<owner>/<repo>/ # one clone per secondary root (multi-repository-workspaces.md decision 4)
└── home/                 # private HOME, XDG_RUNTIME_DIR, runtime state
```

The primary checkout keeps its roles for `shared` isolation, the console's
workspace views and `pullOnNewSession`; for confined sessions it is no longer
the parent of anything.

### What changes for a confined session

- **Refs are a snapshot.** The clone's `refs/remotes/origin/*` are the remote's
  at clone time; what the daemon later fetches into the primary is not visible,
  and the session fetches for itself when it wants newer state. Session branches
  exist only in the clone.
- **Review sessions** fetch `refs/pull/<n>/merge` into the clone and verify the
  checked-out HEAD exactly as today. That fetch joins the class of daemon-run Git
  that must MATERIALIZE objects into a partial clone — with the clone itself, the
  branch checkout and a review reset — and so runs with lazy fetching permitted:
  resolving a fetched pack against objects the clone filtered out is a promisor
  fetch, and under the daemon's usual `GIT_NO_LAZY_FETCH=1` it dies in
  `unpack-objects`, which degraded every review in a confined session to
  revision-only. Retirement is deliberately not in that class: it judges a clone
  with no network target at all.
- **Retirement** applies the same dirty and unique-commit rules in the clone —
  every local ref counts, not only HEAD, because the directory is the object
  store and a side branch or a stash is work the checked-out branch cannot speak
  for — and then removes the directory; there is no worktree registry to prune
  and no branch to delete in the primary.
- **Console push and Git reads** resolve the session root as today.
- **Sandbox grants** are per session and exact: the clone's `.git` writable,
  its `hooks` and `config` read-only, for both the outer sandbox and a runtime's
  inner one. The session's `home/` is writable in both layers as well — a
  runtime's inner policy pins writes to the cwd, and HOME is its _sibling_, so
  the grant is named there too or no package manager can write the caches below
  it. `home/.codex` is carved back out of that grant and stays denied: its
  `auth.json` is a link to the shared host credential the outer layer keeps
  writable for the ACP parent, and the rest is that parent's own state, written
  from outside the inner sandbox.
- **HOME is per session.** `home/` is the runtime's private HOME — `HOME`,
  `XDG_*`, `CODEX_HOME` and the other runtime-state env point there — seeded
  from the host and protected exactly as the agent's `home/` is, and removed
  with the leaf. `TMPDIR` is the exception: a confined host's temp directory is
  `<agentDir>/t/<8 hex of the host key>`, granted read+write by the sandbox
  policy and removed with the host, because SRT opens its multiplexer socket
  directly under `TMPDIR` and AF_UNIX caps that path at 107 bytes, which a HOME
  below the daemon root, the agent name and this leaf overflows. That shape is
  short rather than bounded — a launch whose socket would still not fit is
  refused by name at preparation. Runtime-native cross-session state (Codex memories,
  goals and logs; Claude project state) is therefore per session; managed memory
  lives outside HOME and is unaffected. Package caches (`.npm`, `.cache`,
  `.local`) live there too, writable per session by construction and gone with
  it, which is what lets `pnpm` and corepack run inside a confined session — no
  per-agent cache is opened and no package manager is pre-provisioned.

The unconfined tier is untouched, and so is everything that made the worktree
tier commit under a boundary in the interim (#1695, #1698, #1703, #1715); those
grants stay for it and simply do not apply to a clone.

### On the pool

The same layout in the session pod's coordinates:
`<mount>/sessions/<leaf>/{workspace,repos,home}` on the volume of a pod claimed
for the session alone (`agent-<id>-<16 hex of the leaf>`, labelled by agent and
session; [k8s-daemon-pool.md](k8s-daemon-pool.md) §4). The agent pod stays —
primary checkout, secondary roots, managed memory, the console's workspace views,
`pullOnNewSession` for shared sessions — and a session runtime holds it beside its
own pod for the runtime's life, so managed memory and merge-when-ready keep the
reachability they have today. Console and Git reads route each path to the pod
that owns it. The claim lives as long as the session's row: idle suspension keeps
the volume, retention judges the dirty and unique-commit rules in the clone on its
own pod before the row goes, and the claim — volume and all — goes with the row,
with a removed agent, or with a replaced workspace once its conversion runs on
the volume, which is the same fail-closed gate that empties the primary checkout
and the first point after the edit at which anything is authoritative. HOME is
per pod by construction.

**Every Git of this tier runs inside the pod's closed inventory.** On a pool
member the daemon does not spawn Git at all: each invocation crosses the shim's
`exec` channel and is judged there against a deliberately small subcommand list
(`packages/daemon/src/shim/exec-handler.ts`), because the process that spawns
Git is the only one whose check is a control. So an operation this tier needs is
either expressed out of subcommands already admitted or it is a session that
fails on the pool and works self-hosted — the failure mode is silent everywhere
except the pool, since self-hosted Git never meets the list. Two operations are
phrased for that reason rather than for Git's convenience: the session branch is
made with `branch --no-track` + `symbolic-ref HEAD` + `reset --hard` instead of
`checkout -b` (same three steps, and the `reset` is the one that materializes,
so it keeps the lazy fetch a blobless clone needs), and retirement's
review-snapshot probe reads the head ref with `show-ref --verify` instead of
listing the ref root with `for-each-ref`. Widening the inventory is the other
way to close such a gap, and it is the one that costs something permanent:
`checkout` was left out.

### The tier a session is born in (decided 2026-09-03)

A tier is a property of **one session**, decided when it is created and kept for its whole
life. Changing an agent's `runInSandbox` or `workspaceIsolation` therefore reaches only
sessions created afterwards. Every side asks one question — the ACP host key, the pod a host
launches into, workspace preparation, the launch's HOME and sandbox grants, the console
reads, and retirement — so no half of the daemon can start serving a live session somewhere
the others do not address.

Two recorded values answer it, in order:

1. **Is this session isolated at all?** Its own `workspaceIsolation`, persisted on the
   session row. `SessionManager` decides it once at creation (`rec?.workspaceIsolation ??
agent.workspace.isolation`, and always `shared` for a from-scratch agent, whose primary is
   not a repository to clone) and keeps it. A shared session gets no host, pod, HOME or
   directory of its own. This is the value the console's workspace routing, retention and
   preparation already read, so the tier must come from it and nothing else.
2. **Which tier, then?** The clones or the worktree the session already stands in — the
   artifact of the original decision, not an inference about it. A session that stands
   nowhere yet takes what one created now would get: a boundary around the runtime (its own
   pod on a pool member, the effective OS sandbox on a self-hosted daemon) means clones, and
   no boundary means a worktree. A pool member has no local disk to ask, so its session pod
   holds that record.

An empty `worktrees/<sid>` directory is **absent**, never a worktree: it is what a failed or
degraded preparation leaves, it has no `.git` for anything to read, and counting it would pin
a session to a tier nothing on disk serves. That is not hypothetical — a session whose stub
was mistaken for its worktree ran with a cwd no checkout root contained and failed every turn
with `prepared workspace cwd … resolves outside its checkout root`, with no way to recover on
its own. Such a stub is reclaimed (by a single `rmdir`, which refuses anything not provably
empty) rather than counted, and a review with no trusted checkout stages its empty stand-in on
the session's **own** tier for the same reason.

The one deliberate exception is `forceWorkspaceIsolation`, which a formal review and the
webchat per-conversation choice use to re-pin a session's isolation mid-life. It is not a
silent overwrite: the same write retires the runtime session (`acpSessionId` cleared, state
and delivery cursor reset), so the next turn re-prepares from the new value. Which is also why
the row's upsert lets the incoming `workspaceIsolation` win over the stored one — that
precedence exists for this path alone, and every other writer either carries the stored value
or omits it. A session re-pinned to `shared` simply stops standing in its clones; they are
left on disk and judged by retirement under the usual dirty and unique-commit rules.

### Non-goals here

- Narrowing the model-side push credential, or a daemon-owned publish tool.
  Separate work; a clone changes who can write a `.git`, not who can push.
- Per-agent writable package caches. A shared cache feeds execution, so a
  session could poison what the next one runs; the per-session `home/` above is
  what makes a writable cache safe, and provisioning package managers into it is
  its own design.
