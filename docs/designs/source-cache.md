# Source Cache: Object-Store Acceleration for In-Pod Git Materialization

> **Status:** Proposed.
>
> **Scope:** daemon (pool members and the in-sandbox shim) + control plane (skill
> source admission only) + Helm chart. Cluster daemons only: the Cloud pool and an
> OSS self-hosted pool. Self-hosted `srt`, microsandbox, and session executors are
> unchanged.
>
> **Requirement mapping:**
>
> 1. Workspace and skill Git installation both run inside the sandbox pod that owns
>    the session (an isolated session's own pod; the agent pod otherwise), exactly
>    as the workspace clone already does. See sections 7 and 8.
> 2. An S3-compatible object store serves as the Source Cache, so a new pod starts
>    from a Git bundle instead of fetching a repository whole. See sections 4, 6
>    and 9.
> 3. Workspace repositories and skill sources are no longer GitHub-only: GitLab
>    (public and private) and public repositories on any Git host. See sections 5
>    and 11.

Terms (**Source**, **Source Cache**, **Workspace Snapshot**, **Source
resolution**) are defined in the root [`CONTEXT.md`](../../CONTEXT.md).

## 1. Why

A session-isolated agent on the pool starts every new conversation in a fresh
pod ([k8s-daemon-pool.md](k8s-daemon-pool.md) "One pod per session",
[git-workspace-model.md](git-workspace-model.md) §11). Two things are then
repeated from scratch on every conversation:

- **The workspace clone.** An isolated session's own pod clones its roots with
  `cloneSessionRootAt`: a blobless partial clone
  ([git-workspace-model.md](git-workspace-model.md) §11), that is
  `--filter=blob:none --no-checkout` on one branch, whose checkout then fetches
  the tip's blobs lazily. The agent pod's primary checkout uses
  `cloneInSandbox`, a full `--single-branch` clone. Both run in the pod through
  `ShimGitRunner` against the upstream remote, with nothing reused between pods.
- **The skill install.** The daemon acquires each Git skill source through the
  GitHub REST API (identity check, commit resolution, archive redirect, whole
  repository tarball), extracts it in a temporary directory, hashes and uploads
  every file to the shim, and deletes the extraction
  ([shared-skills.md](shared-skills.md) §3, §6). A daemon-local cache keyed by
  (agent, repository id, commit) reduces the download on one member, but it does
  not survive a member restart, is not shared between members, and still relays
  every byte through the daemon.

Skill acquisition is also GitHub-only by construction: the acquisition path, the
anti-replacement check (numeric repository id) and Control Plane admission all
assume the GitHub REST API.

## 2. Goals and non-goals

Goals:

- One materialization model for workspace and skill Git content: `git` in the
  pod that owns the session.
- A shared, evictable Source Cache in an S3-compatible bucket that any pool
  member and any pod of the install can use, with no daemon relaying content.
- Host-neutral caching, so a non-GitHub Source is cached exactly like a GitHub
  one.
- No session ever fails because of the cache.

Non-goals:

- **Workspace Snapshot.** Durable capture of content that exists nowhere
  upstream (scratch workspaces, uncommitted edits) is a separate design. Its
  first use case is recorded here so the layout leaves room for it: surviving a
  claim deletion or an agent move between pools, which today is a hard cutover
  that does not migrate workspace bytes (`orchestrator/agentMove.ts`,
  [k8s-daemon-pool.md](k8s-daemon-pool.md) "possible permanent loss of retained
  pool-local workspace state"). This design reserves the `snapshots/` prefix
  (section 4) and nothing else.
- A shared starting point for isolated sessions other than the Source Cache. An
  isolated session still clones its own repository; it only starts from a bundle.
  No agent or user content crosses sessions.
- Non-Git skill sources in the cache. Managed `.skill` bundles (≤ 512 KiB,
  digest-pinned, CP-authorized per agent) and accepted Dream skills keep today's
  path: the daemon uploads them to the shim. A digest-addressed `files/` kind is
  reserved for future upstream file collections (section 4).
- Private repositories on arbitrary Git hosts (long-lived deploy tokens or SSH
  keys).
- Self-hosted, non-cluster daemons.

## 3. Current state this builds on

| Fact                                                                                                       | Where                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The workspace clone already runs in the pod, through the shim                                              | `workspace-manager.ts` `cloneSessionRootAt` (blobless), `cloneInSandbox` (full)         |
| On a pool member the daemon spawns no Git; every workspace Git crosses the shim's closed subcommand list   | [git-workspace-model.md](git-workspace-model.md) §11, `workspace/git-command-policy.ts` |
| Git in the pod gets credentials on demand from the daemon through the `gitcred` tunnel; nothing long-lived | `shim/git-credential.ts`, `shim/tunnel.ts` (`gitcred`, `mcp`)                           |
| GitHub and GitLab scoped tokens are already minted by the CP                                               | `gitlab/gitcred.service.ts`, `gitcred/glab-token-client.ts`                             |
| The runtime image bundles `skills@1.5.21`; the shim runs it in a per-source offline cell                   | `shim/skill-handler.ts`, `skills/skills-cli-cell.ts`                                    |
| Cluster skill ledgers are keyed by (agent, SandboxClaim UID)                                               | `daemon.ts` `reconcileClusterSkills`, `local-store.ts`                                  |
| The pool's durable store is the data-plane Postgres                                                        | [cloud-data-plane-postgres.md](cloud-data-plane-postgres.md)                            |
| Skill preview already degrades to `resolvable:false` (whole-source enablement only)                        | `control-plane/src/http/routes/skill-sources.ts`                                        |

Git has a native bundle bootstrap since 2.38: `git clone --bundle-uri=<url>
<remote>` downloads a bundle, then fetches whatever is missing from the remote
(measured working from 2.38.0). `git bundle create <file> --filter=blob:none
refs/heads/<branch>` writes a v3 bundle that records its filter
(`@filter=blob:none`); a blobless `--bundle-uri` clone accepts it, `git fsck`
passes on the result, and a checkout fetches only the blobs it needs.

- **Bundle the branch ref.** `--bundle-uri` applies a bundle only for the
  `refs/heads/*` refs it names; a `HEAD` or `refs/remotes/*` bundle is silently
  ignored, so every bundle this design writes names `refs/heads/<branch>`.
- **The imported ref moved in Git 2.50.** Through 2.49 a bundle's
  `refs/heads/<b>` lands as `refs/bundles/<b>`; from 2.50 as
  `refs/bundles/heads/<b>`. Nothing may name a fixed `refs/bundles/` ref; code
  enumerates every ref under `refs/bundles/`.
- **`GIT_NO_LAZY_FETCH` is a guard, not a correctness requirement.** A
  `bundle create --filter=blob:none refs/heads/<b>` from a blobless clone
  fetches nothing on every measured version (2.38.0 through 2.56.0). An
  unfiltered create from a partial clone does fetch lazily, and with the
  variable set it fails instead. Git honors the variable only from the 2024-05
  security releases (2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1, 2.45.1+);
  2.38.0 and 2.39.3 ignore it.

The daemon image is `node:24-bookworm-slim` (Git 2.39). The runtime sandbox image
is built separately. Its pinned dependency base was run on 2026-10-01 and ships
Git 2.39.5, which honors `GIT_NO_LAZY_FETCH`. The image verifier requires a
`GIT_NO_LAZY_FETCH`-honoring release and behaviorally pins `--bundle-uri`, a
`refs/heads` `git bundle create --filter=blob:none`, `fsck --connectivity-only`
and `GIT_NO_LAZY_FETCH`, so a later base bump fails the image build if any of
them regresses (section 14).

The P0 S3-compatible store matrix was also sampled on 2026-10-01. The archived
MinIO release `RELEASE.2025-10-15T17-29-55Z` passed conditional `If-Match`,
presigned PUT with signed `Content-Length`, `x-amz-checksum-sha256` and
`x-amz-tagging`, and a tag-filtered lifecycle rule. The community MinIO project
is archived and gets no further community releases, so it serves as a test
fixture and a target for existing deployments, not a recommended new store. AWS
S3 remains unverified until credentials are available; section 14 records the
exact results and gate.

## 4. Storage layout

One bucket (or one prefix of a bucket) per install:

```
<prefix>/
  src/<org>/<class>/<repo>/bundles/<uuid>.bundle           immutable Git bundle, exactly one ref, one shape
  files/<org>/<sha256>.tar                           reserved: digest-addressed file collection
  snapshots/…                                        reserved: Workspace Snapshot (not this design)
```

`latest` is a data-plane store row, not an object: a `source_cache_object` row
of kind `pointer` keyed `src/<org>/<class>/<repo>/refs/<refHash>/<shape>/latest`
whose `targetKey` names the bundle (section 10). Reads already resolve through
that row alone (section 7), the sweep is driven by the same table, and pointer
writes serialize under the org's usage-row lock, so an S3 pointer object would
be a second source of truth nobody reads, an extra PUT per write-back, and a
dependency on `If-Match` that AWS has not been verified for (section 14).

- `class` is the **access class** of the clone that wrote the entry, and a
  reader only ever takes entries of its own class:
  - `anon`, with `repo` the SHA-256 of the canonical remote URL (lower-cased
    host, credentials, query and fragment stripped, trailing `.git` removed,
    standard SSH spellings rewritten to their HTTPS authority). Written only from
    a clone the daemon instructed without a credential. An honest writer thus
    stores only what an anonymous fetch of that URL returns; what a hostile
    writer can add is bounded in the next bullet.
  - `cred`, with `repo` the provider-qualified numeric id (`github:<repoId>`,
    `gitlab:<projectId>`) of the Source's `CodeHostRepository`. Written only from
    a credentialed clone, and readable only after `resolveRef` succeeded on the
    daemon for the reading agent (section 5).
- An anonymous declaration of a private URL therefore never sees a credentialed
  agent's bundle: the two live under different classes and different
  identities. A hostile credentialed pod can write into the `anon` entry of its
  own URL, but only content its own agent can read, and a reader cannot be
  harmed by it (section 6). Anti-replacement stays an admission and resolution
  concern (section 5).
- `refHash` is the SHA-256 of the full ref name (`refs/heads/main`). A pointer per
  (repository, ref) matches the single-branch clone: two agents on different
  branches of one repository, or a skill tracking `release` beside a workspace on
  `main`, never evict each other's pointer. Shared history is stored once per
  ref; bundle lists are a later optimization, not a v1 format.
- `shape` is the bundle's object filter: `blobless` (`--filter=blob:none`:
  every commit and tree, no blobs) or `full`. A reader only takes a pointer of
  its own clone's shape. Session pods and skills read and write `blobless`; the
  agent pod's full primary clone reads and writes `full`. A blobless bundle
  saves the history download; the tip's blobs still come from the origin at
  checkout, which is the blobless clone's behavior today.
- Every key is **org-scoped**. A popular public repository is stored once per
  org. That duplication buys a blast radius confined to one org and removes any
  "is this repository public" judgment from the key: the class records how the
  entry was fetched, not what anyone believes about the repository.
- Bundles are **immutable** and never overwritten; only the pointer row moves.
- Source Cache lifecycle rules and access policy apply to `src/` (and later
  `files/`) only. Nothing in this design may match `snapshots/`.

## 5. Source resolution

Source resolution turns a Source's ref into the exact commit to use, with the
requesting agent's own access. For a credentialed Source a success is the
authorization to read that Source's `cred` entries, and no `cred` GET is issued
without it. An `anon` entry needs no authorization by construction (section 4).
Resolution touches only metadata.

A Source's identity follows the workspace model
([git-workspace-model.md](git-workspace-model.md) §2–§3): a full cloneable
address plus `credential?`, where absent means anonymous and a code host is a
credential variant (`{ provider: 'github' }` | `{ provider: 'gitlab',
projectId }`), never a new source kind. A credentialed Source references its
`CodeHostRepository` ([gitlab-com-integration.md](gitlab-com-integration.md)
§8.1), whose provider-qualified numeric id is the anti-replacement identity.
Resolution is a member of that seam, `CodeHostRepository.resolveRef`, not a
per-host table in this design:

| Source               | Resolution runs                         | How                                                           | Anti-replacement                   |
| -------------------- | --------------------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| `credential: github` | Daemon, `CodeHostRepository.resolveRef` | The existing REST identity check + commit lookup, conditional | Numeric repository id              |
| `credential: gitlab` | Daemon, `CodeHostRepository.resolveRef` | Project API: project id + ref → commit                        | Numeric project id                 |
| Anonymous (any host) | In the owning pod, `git ls-remote`      | Shim exec (section 6.1)                                       | None: trusted by URL, console says |

The daemon makes no network request to a user-typed Git URL: an anonymous
Source is resolved by the pod that will fetch it, so a member serving many
organizations never contacts an arbitrary host. An anonymous GitHub address
still passes the anonymous REST identity check when it names github.com, as
today.

Result caching:

- **Only trusted results are shared.** A result the daemon computed itself —
  `resolveRef`, or the anonymous REST check for a github.com address — may be
  cached for 60 s, as `GitSkillRefTracker` does today: across agents for an
  anonymous github.com Source, and per (agent, Source, ref) for a credentialed
  one, so revoked upstream access stops `cred` reads within 60 s.
- **A pod's `ls-remote` answer is never shared.** It is used only by the
  preparation of the pod that produced it and is not cached, not coalesced with
  another pod's in-flight resolution, and never becomes another agent's planned
  commit. An untrusted pod can mislead only its own agent, which the known
  boundary (section 6.1) already allows.

On failure:

- A Source that was installed before keeps its installed commit, as today — but
  **no GET URL is issued for it**, because the failure may be exactly a revoked
  grant. The pod uses what its volume already holds or fetches upstream; if that
  also fails, the Source is skipped with a reason code (section 11).
- A Source that was never installed is skipped for this preparation.

A pinned ref (a commit SHA) still resolves: resolution proves access and the
commit is taken as given.

Daemon implementation (P1, CP1.4):

- Resolution reads only with CP-minted tokens, never a spawned Git helper: a
  GitHub workspace uses its `git`-plane installation token, a GitLab workspace
  the binding's read PAT on the `glab` plane (`read_api` + `read_repository`).
- A GitHub workspace's spec carries no numeric repository id
  ([git-workspace-model.md](git-workspace-model.md) §3), so the id behind
  `github:<repoId>` comes from the github-qualified `gitcred` grant echo; with no
  echo the `cred` read is refused (`identity_unknown`) and the clone goes to the
  origin.
- Identity requires both the numeric id and the current path (GitHub
  `full_name`, GitLab `path_with_namespace`) to match the spec; a rename fails
  closed as `replaced` until the spec catches up, costing only a cache miss.
- The cache key also carries the API base, so an instance change never reuses
  an answer. A failure is cached with backoff (5 s doubling to 60 s, extended by
  the host's `Retry-After` or rate-limit reset up to 15 min), replaces any cached
  success at once, and a success is never served past its 60 s.
- `authorizeCredentialedCacheRead(agent, workspace)` in
  `source-cache/authorize-read.ts` is the one gate the workspace read path calls
  before a `cred` GET.

## 6. Trust model

Pods run agent code and are not trusted. They may still write the shared cache,
because nothing in the cache decides what a reader ends up with:

1. **Content addressing.** Git verifies every object's hash on clone and fetch. A
   bundle can add objects; it cannot change what a commit id names.
2. **Resolution decides the revision.** The commit a reader wants comes from
   Source resolution (skills) or from the origin fetch that
   `--bundle-uri` always performs (workspace). A bundle never decides which
   commit is used.
3. **Readers verify, and always keep a clean origin retry.** A skill reader
   requires the planned commit to be present and `fsck --connectivity-only` to pass after import.
   Git's bundle bootstrap is not a fallback, and an incomplete bundle (one that
   advertises the right ref but omits objects the commit needs) fails
   differently by clone shape even though the origin is healthy. A full clone
   exits 128 (`unable to parse commit`, "Clone succeeded, but checkout failed";
   reproduced on 2.39 and 2.54). A blobless `--no-checkout` clone exits 0
   silently; a later `git fsck --connectivity-only` fails and a checkout lazily
   fetches the missing trees. A full clone can also exit 0 when the bundle holds
   the tip but omits an older commit's tree, leaving history that fails
   `git diff HEAD~1 HEAD` (reproduced on 2.39.5). So every bundled clone, of
   either shape, runs that `fsck` itself. A blobless bundle given to a full clone exited 128
   (`unresolved deltas`) or was ignored. So every cached acquisition, workspace
   or skill, that fails for any reason discards its whole staging checkout and
   object database and retries **once without the bundle** before any origin
   error is surfaced (the retry contract, section 7). A poisoned bundle then
   costs one wasted download, never a failed session.
4. **No bucket credentials in pods.** The pool daemon holds the only S3
   credentials (IRSA / Workload Identity preferred; a static key Secret
   otherwise). A pod only ever receives presigned URLs, each for one key, one
   verb, and a short lifetime (defaults: GET 5 min, PUT 15 min).
5. **Runtime cannot ask for URLs.** URLs travel only inside shim operations the
   daemon initiates (section 9). No tunnel exposes a signing endpoint, so the
   runtime process in the pod cannot request a URL for another key.

What a hostile pod can still do: write a useless, incomplete, or oversized bundle
(bounded by section 10, and survived by the retry contract), or move a pointer to
an older valid bundle of the same ref (costs a larger origin fetch, never wrong
content).

### 6.1 Where each Git operation runs

A pool member spawns no Git; the process that spawns Git is the only one whose
check is a control ([git-workspace-model.md](git-workspace-model.md) §11). Each
operation this design adds is placed against that rule:

| Operation                                                                                | Path                                      | Inventory change and why it is a control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace clone with `--bundle-uri`                                                      | Shim `exec`                               | `clone` is admitted. New per-subcommand rule: only the exact spelling `--bundle-uri=https://…` is accepted, so the flag cannot read pod-local or cluster-internal files; every unique-prefix abbreviation Git accepts (`--bundle=`, `--bun=`) is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Workspace retry without the bundle                                                       | Shim `exec`                               | None: the same admitted `clone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Removing `refs/bundles/*` after a clone                                                  | Shim `exec`                               | None: `show-ref` and `update-ref -d` are admitted. The daemon's bundled-clone wrapper, over shim `exec`, lists refs with `show-ref`, keeps those under `refs/bundles/`, and deletes each one, never a fixed name, because Git 2.50 moved the imported ref from `refs/bundles/<b>` to `refs/bundles/heads/<b>`; `for-each-ref` stays outside the inventory ([git-workspace-model.md](git-workspace-model.md) §11)                                                                                                                                                                                                                                                                                                                    |
| Connectivity check after a bundled clone                                                 | Shim `exec`                               | Narrow widening: `fsck` is admitted only as exactly `fsck --connectivity-only` with no other argument, because an incomplete bundle can leave a clone of either shape exit 0 (a blobless clone before checkout, a full clone with broken history) and only this read-only check detects it                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Workspace write-back bundle                                                              | Shim `bundle` operation (shim-internal)   | Not the exec channel, which admits no form of `bundle`. The shim composes `bundle create -q <file> [--filter=blob:none] refs/heads/<branch>` itself, with `<file>` named by a handle it mints (a UUID) inside its 0700 `<runtimeRoot>/bundle-staging`; the daemon sends the checkout, the branch, the origin commit and the shape, never a path. The shim refuses a shallow checkout and a branch that no longer names that commit, forces `GIT_NO_LAZY_FETCH=1` last into an environment it builds (hooks and fsmonitor off, no system or global config), and checks with `bundle list-heads` that the file names exactly that ref at that commit; a `HEAD` or `refs/remotes/*` bundle would be silently ignored by `--bundle-uri` |
| Anonymous resolution                                                                     | Shim `exec`                               | None: `ls-remote` is admitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Skill acquisition: clone, fetch, subdirectory checkout, `fsck`, retry, write-back bundle | Shim-internal, inside the skill reconcile | Not the exec channel. The shim spawns Git itself with argv it composes from validated plan fields (origin policy on the URL, ref / SHA / subdirectory syntax), under the same refused-argument rules as `exec`, in a private staging directory; nothing the daemon sends is passed as free argv, and the runtime cannot invoke the operation. Its connectivity check is the same `fsck --connectivity-only` as the workspace path                                                                                                                                                                                                                                                                                                   |

**Refused options include their abbreviations.** Git accepts any unique prefix
of a long option and runs it as the full option: `clone --upload=<cmd>`,
`--upl=<cmd>` and `push --receive=<cmd>` run as `--upload-pack` /
`--receive-pack`. `REFUSED_LONG_OPTIONS` therefore refuses any option name,
in the `--opt=value` or `--opt value` form, that is a prefix of a refused long
name (`--upload-pack`, `--receive-pack`, `--exec`, `--exec-path`, `--config`,
`--config-env`, `--bundle-uri`) or starts with one. Two further spellings were measured executing and are refused
with them: the hidden exact alias `--exec=<cmd>`, which `ls-remote` runs as
`--upload-pack` and `push` as `--receive-pack`, and clone's grouped short
options (`-qu<cmd>`, `-qc<key=value>`), which are walked letter by letter. The
skill-acquisition row inherits the same rule.

**Acquisition hardening carries over.** A staged skill subdirectory reaches the
CLI cell only through the existing bounded no-follow snapshot
(`inspectLocalSkillSource` with the Git snapshot limits): links and special files
are rejected, file, byte and path limits apply, and `.git` never enters the
snapshot ([shared-skills.md](shared-skills.md) §6.2). The pod replaces the
daemon's archive acquisition; it does not replace the snapshot.

**Known boundary.** Git skill bytes no longer pass through the daemon, so the
receipt digests in the cluster skill ledger are computed by the shim, not checked
against digests the daemon computed. On an isolated pod the install completes
before any runtime starts. On the shared agent pod a same-UID runtime could race
the install's temporary directory; that runtime can rewrite its own installed
skills anyway. The same applies to an anonymous Source's commit, which that pod
resolves. Integrity against the agent's own runtime is not a guarantee of this
system ([shared-skills.md](shared-skills.md) §8 "Authority-domain runtime
trust").

## 7. Workspace flow

An optional bundle argument, a clean retry, and one follow-up. The clone keeps
its shape: a session root stays blobless, the agent pod's primary stays full.

1. The daemon prepares the workspace as today. When a Source Cache is configured
   and `latest` exists for (org, repository, branch, the clone's shape), the
   clone instruction gains `--bundle-uri=<presigned GET of the bundle>`.
2. The pod clones; Git downloads the bundle, fetches the remainder from the
   origin with the usual `gitcred` credential, and checks out the branch head the
   origin reports. A bundle's own refs land under `refs/bundles/*` and never
   reach the checkout (verified: a foreign bundle advertising a different
   `main` leaves `refs/heads/main` and `origin/main` at the origin's commit), and
   right after the clone the daemon, over shim `exec`, deletes every ref under `refs/bundles/` that
   `show-ref` lists (`refs/bundles/<b>` through Git 2.49, `refs/bundles/heads/<b>` from
   2.50) so no bundle-supplied commit stays reachable by name in the workspace.
3. **Retry contract.** If the bundled clone fails at any step — download,
   unbundle, fetch, connectivity, or checkout — the daemon empties the checkout
   directory (object database included) through the shim and runs the same clone once without
   `--bundle-uri`. Only that second attempt's failure is an origin failure, and
   only it reaches the existing clear-and-rethrow path (`cloneSessionRootAt`,
   `cloneInSandbox`). The first
   failure is reported as a cache fallback (metric, and the bundle key in the
   log) and the pointer is not trusted again by this preparation.
   - Every bundled clone runs `git fsck --connectivity-only` after the clone,
     because an incomplete bundle can exit 0 with either shape (section 6); a
     failure is a cache fallback.
   - A bundle download failure (HTTP error, untrusted certificate) also exits
     0, with either `warning: failed to download bundle from URI` or
     `failed to fetch objects from bundle URI` on stderr. A bundled attempt is
     therefore a fallback on a non-zero exit, on either warning, or when
     `refs/bundles` is empty after the clone; only the last also catches a
     bundle that names no `refs/heads` ref.
4. The clone is a write-back candidate when it missed the cache, when the
   bundled attempt fell back, when the origin delta after the bundle exceeded a
   threshold (default: 5,000 objects or 50 MiB; the checkout's lazy blob fetch
   is not counted), or when the bundle is older than 7 days (section 9).
   Only a fallback that shows the bundle bad or unusable (`clone-failed`,
   `no-bundle-refs`, `inspect-failed`, `connectivity`, `cleanup-failed`) is a
   candidate; `download-warning` and `stderr-unavailable` may be transient
   (an expired GET, a network blip) and skip, so the pointer is not churned.

A resumed pod whose volume already holds the checkout is untouched: it pulls as
today and uses no cache.

Daemon implementation (P1, CP1.5):

- The daemon, not the shim, drives the bundled clone, its checks, the
  `refs/bundles/*` cleanup and the retry, over the existing shim `exec` and
  materialize `clear` operations, so no new shim operation or capability is
  needed. `source-cache/read-plan.ts` picks the bundle and
  `workspace/bundled-clone.ts` runs the retry contract.
- The pointer row's `targetKey` in the data-plane store names the bundle, so a
  read makes no object-store request to find it. The plan needs a committed,
  unclaimed pointer and bundle of the same class, repository, ref and shape. Any
  planning failure (store, signer, refused resolution) is a miss and an origin
  clone. A GET issuance stamps `lastReadAt` on both rows.
- Only the primary root reads the cache. Secondary roots and on-demand clones
  never do, because they are always credentialed and the read gate covers only
  the primary workspace.
- Transport loss, a shim request timeout, an abort or shutdown is not a cache
  fallback and propagates without the bundle-less retry, because the pod-side
  clone may still be running. Every in-band failure is a fallback, including an
  older shim refusing `fsck`.
- A shim older than the `fsck` rule therefore wastes one download per bundled
  blobless clone until its image ages out.
- A bundle is planned only on a plane that can empty the checkout, and its
  clone runner must return stderr: a bundled attempt whose runner reports none
  is a fallback (`stderr-unavailable`), since a failed download would otherwise
  read as a hit. Planning runs inside the startup `clone` phase, so a
  credentialed `resolveRef` shows in startup progress.

Daemon implementation (P1, CP1.6):

- The daemon, not the shim, decides candidacy, because it drives the clone over
  `exec` (CP1.5). A hit reports the bundle's tip, read from `show-ref` before
  `refs/bundles/*` is deleted, and the delta is
  `rev-list --objects --missing=allow-any [--filter=blob:none] <tip>..<origin commit>`
  with `--count` and `--disk-usage`; the filter on a blobless clone keeps lazy
  checkout blobs out. Git's "objects received" progress is not used: it needs a
  tty or `--progress` and would count lazy blob fetches. Age is the bundle row's
  `createdAt`. A measuring error skips the write-back.
- Only the origin's commit is ever cached: `refs/heads/<branch>` must equal
  `refs/remotes/origin/<branch>` when the daemon looks, and the shim re-checks
  it before bundling, so an agent's local commits never reach the cache.
- The class is the one the daemon's own clone instruction used (the managed
  credential or none), cross-checked against the planned target; a mismatch
  skips. A `cred` target exists only after `resolveRef` authorized the read.
- The write-back is fire-and-forget after the clone is published at its final
  path (a session clone after its rename), on the primary root only, and only
  for a shim granted `bundle`. One write per pointer runs at a time, two per
  member.
- For CP1.7: the writer's pointer compare-and-set can retarget a pointer row the
  sweep has already claimed as unread, so the sweep must re-check that row's
  `targetKey`/`updatedAt` under its claim before deleting the pointer. CP1.7
  does this inside the delete (section 10).

Workspace resolution: the workspace keeps using the origin as its authority for
the branch head. The GET URL's class follows the workspace's own
`credential?`: an anonymous workspace reads only `anon`; a credentialed one reads
only `cred`, and the daemon first performs `resolveRef` for that agent (section
5), which adds one metadata round trip to a credentialed preparation that hits
the cache. Write-back lands in the class the clone was fetched under.

## 8. Skill flow

A shim that advertises `skill-git-in-pod-v1` installs Git skill sources itself:

1. Every Git skill Source is resolved (section 5), concurrently: credentialed
   ones on the daemon, anonymous ones by `ls-remote` in this pod. The daemon then
   sends the shim one reconcile plan: for each Git Source its URL, ref, planned
   commit, subdirectory, selections, and a GET URL when a pointer of the
   Source's own access class exists (section 4); managed and Dream sources are
   uploaded exactly as today. The planned commit is always either a trusted
   daemon result or this pod's own `ls-remote` answer (section 5), never a value
   another pod supplied; a bundle supplies objects, never the commit, so a bundle
   that already contains the planned commit needs no further ref check.
2. The daemon opens a **credential window** on the pod's `gitcred` for this
   reconcile: a token for an enabled private skill repository (`contents:read`,
   that repository only) is minted only while the window is open. On an isolated
   pod no runtime is running yet; on the agent pod the residual exposure is the
   unselected content of an enabled repository for the token's lifetime.
3. For each Git Source the shim, in a private temporary directory:
   - clones blobless (`--filter=blob:none --no-checkout`), with `--bundle-uri`
     when a URL was given, so a skill shares the `blobless` pointer with the
     repository's session workspaces. Never shallow: a bundle written from a
     shallow repository omits the shallow boundary and yields a repository that
     fails `fsck`, so it can never serve as a clone base;
   - when the bundle lacks the planned commit: for a tracked ref, fetches that
     ref and requires it to equal the planned commit, else skips the Source for
     this run (the ref moved after resolution; the next preparation re-resolves);
     for a pinned SHA, fetches the SHA, and when the host refuses a SHA want
     (`uploadpack.allowReachableSHA1InWant` is off by default outside GitHub and
     GitLab) fetches all branches and tags and looks for the commit, else skips
     the Source with that reason;
   - on any failure of a bundled attempt, or when the imported repository is
     not `fsck`-clean (the same `fsck --connectivity-only` check as a workspace
     clone, with the same download-warning and empty-`refs/bundles`
     classification), discards the staging directory and repeats this step once
     without the bundle (the retry contract, section 7);
   - checks out only the subdirectory at the planned commit, which fetches only
     that subtree's blobs, and passes it through the bounded no-follow snapshot
     (section 6.1); `.git` is dropped.
4. The shim runs the same per-source offline CLI cell on each staged directory,
   merges the Git candidates with the uploaded managed and Dream candidates in
   source order, and publishes through the existing ledger and mutation helper.
   Source order, per-source skipping, the manifest budget and the receipt reply
   are unchanged.
5. The daemon closes the credential window, records the ledger with the resolved
   commits, and later handles write-back candidates (section 9).

A shim without `skill-git-in-pod-v1` keeps today's path: the daemon acquires and
uploads. This decision does not depend on whether a bucket is configured.

## 9. Write-back

Write-back is asynchronous and best-effort; the runtime may start before it
finishes, and a failure is a log line and a metric.

1. The daemon asks the shim's `bundle` `create` operation for a bundle of the
   clone it just made, of that clone's shape (section 6.1), never from a shallow
   repository; the reply is a shim-minted handle, the size and the SHA-256. The
   bundle names `refs/heads/<branch>`, the only kind of ref `--bundle-uri`
   applies; shape correctness comes from bundling only the shape the clone has,
   and `GIT_NO_LAZY_FETCH=1` only guards against a lazy fetch.
2. **Reserve before signing.** In one transaction the daemon checks the
   per-bundle cap and inserts a `pending` row for a fresh
   `bundles/<uuid>.bundle` under the access class of the clone the daemon itself
   instructed — never one the pod names: an anonymous clone instruction carries
   no credential helper, so its bundle can only land in `anon` — carrying the declared size and an expiry (the PUT
   lifetime plus a grace, default 1 h), admitted only if the org's committed
   bytes plus every unexpired `pending` reservation plus this one stay within the
   quota (section 10). The org's usage row is locked for the check, so two pool
   members cannot both admit the last 2 GiB. A refused reservation means no
   write-back.
3. Only then does the daemon sign the PUT: the declared `Content-Length`, the
   declared SHA-256 (`x-amz-checksum-sha256`), and the object tag
   `ac-cache=pending` are all part of the signature, so the store rejects any
   other length or content and the pod cannot omit or change the tag.
4. The daemon sends the shim's `bundle` `upload` operation the handle, the URL
   and the signed headers. The shim refuses any header set other than exactly
   those three with the values it recorded for the handle, and uploads from its
   own process (the URL never appears on a command line), re-hashing as it
   streams. The daemon then `discard`s the handle on every path; the shim also
   drops handles past a lifetime and empties its staging directory at start.
5. On the shim's reply the daemon `HEAD`s the object with
   `x-amz-checksum-mode: ENABLED` and requires the reserved length and the
   signed checksum (a store that omits the checksum fails closed), marks the row
   `committed`, retags the object `ac-cache=live`, and moves the pointer row
   with a compare-and-set on the target it read when planning. Losing that race
   is dropped silently: the new bundle stays committed and unpointed, so it ages
   out like any replaced bundle, since any valid bundle of the ref is an
   acceptable pointer target. A failed retag skips the pointer, so a pointer
   never names a `pending`-tagged object.

**Abandoned uploads.** An upload the store accepted but no reply confirmed —
the pod died, the channel dropped, the member restarted — keeps its `pending`
row. The sweep (section 10) takes every expired `pending` row, `HEAD`s its key,
deletes the object if present, and deletes the row, which releases the
reservation. Independently of the database, the lifecycle rule expires any
object still tagged `ac-cache=pending` after 2 days, so an upload whose row was
lost is collected too. No object reaches the bucket without either a row or a
`pending` tag.

The GET URL passed to `git clone` is visible to other processes in a shared pod
through `/proc/<pid>/cmdline`. It reads one bundle for a few minutes and is only
either an `anon` entry, whose content any anonymous fetch of that URL returns,
or a `cred` entry issued only after the agent's own `resolveRef` proved access,
so this exposes nothing the agent could not already read.

## 10. Capacity and eviction

Defaults, all Helm values:

| Limit                 | Default | Enforcement                                                                   |
| --------------------- | ------- | ----------------------------------------------------------------------------- |
| Bundle size           | 2 GiB   | The daemon refuses to reserve; the store enforces the signed length           |
| Org total             | 20 GiB  | Committed bytes plus unexpired reservations, checked under the org's row lock |
| Pending reservation   | 1 h     | Sweep deletes the object and the row, releasing the reservation               |
| Pending-tagged object | 2 days  | Bucket lifecycle rule on `ac-cache=pending`, independent of the database      |
| Unreferenced          | 7 days  | Bucket lifecycle rule on `ac-cache=unreferenced`                              |
| Unread pointer        | 30 days | Daemon background sweep deletes the pointer row; its bundle then ages out     |

A bundle over the cap is not written, and that repository keeps cloning from the
origin.

Accounting lives in the data-plane Postgres, in a new pool-store table
`source_cache_object`: org, key, kind (`bundle` | `pointer`), state (`pending` |
`committed`), bytes (reserved or actual), repository URL hash, ref hash, created,
expiry and last-read timestamps, and whether a pointer references it, plus a
per-org usage row that reservations lock. Reservation inserts a `pending` row;
commit flips it; GET issuance updates last-read; the sweep reads and deletes. The
table is org-scoped like every pool table
([k8s-daemon-pool.md](k8s-daemon-pool.md) §11). The bucket is never listed to
compute usage.

The store surface (`LocalStore`, both drivers) makes these choices concrete.
"Referenced" is not a stored flag: a pointer row's `targetKey` names its bundle,
and the bundle carries `unpointedAt`, the time no pointer has named it since.
Commit sets it, so a bundle that lost the pointer race ages out like any other,
and the sweep retags a bundle only once `unpointedAt` is older than the GET
lifetime. Repository identity is `repoClass` plus `repoId`, the section 4 key
segments, because a `cred` id is not a URL hash. Usage counts committed bundles
the database still tracks: the sweep deletes a bundle's row, releasing its
bytes, once it has retagged it `unreferenced`, while the object waits out the
lifecycle rule. Each lock site takes the org's usage row, then the pointer, then
the bundle, so PostgreSQL cannot deadlock between them. Sweep claims pick rows
with `FOR UPDATE SKIP LOCKED` and stamp a `claimedBy`/`claimedAt` lease, because
the object-store steps that follow must not run inside an open transaction. A
member that dies mid-pass leaves rows that become claimable again once the lease
lapses, and a delete fenced on a lost claim changes nothing. Naming a bundle the
sweep has claimed is refused, even after the claim's lease lapses, which closes
the race between a new pointer and the `unreferenced` retag; committing a
reservation the sweep has claimed is refused for the same reason. These tables
are excluded from generic store retention, which would delete rows without
their objects.

Lifecycle tagging: every bundle carries `ac-cache=pending`, `live`, or
`unreferenced`. The upload signs `pending`; commit retags `live`; the sweep
retags `unreferenced` when a bundle's pointer moves or is deleted. Lifecycle
rules filter only on `pending` (2 days) and `unreferenced` (7 days), so a bundle
is never collected while a pointer names it. S3 expiration counts from object
creation, not from tagging, so a bundle older than 7 days is collectable as soon
as it is retagged; the sweep therefore retags a bundle only once the pointer has
not named it for longer than the GET lifetime (5 min), after which no URL issued
for it is still valid.

**Who runs the sweep.** Every pool member, idempotently. The sweep is not agent
work and holds no duty: each pass claims due rows with `FOR UPDATE SKIP LOCKED`,
and every object-store step it takes (retag, delete, `HEAD`) is safe to repeat,
so two members never double-count and a member that dies mid-pass leaves rows the
next pass finishes.

Daemon implementation (P1, CP1.7):

- `source-cache/sweep.ts` runs on every member that has a Source Cache, and on
  no other daemon. The first pass starts at a random point within the first
  5 minutes, and later passes follow every 5 minutes ±25%. The timers are
  unref'd and ticks are skipped while the daemon drains. A member runs one pass
  at a time. Its claims carry the owner `<memberId>/<boot nonce>` and a 15-minute
  lease, and each step claims at most 25 rows. No new row starts once half the
  lease has passed. After 3 object-store failures in a row the pass skips its
  remaining object steps. Shutdown stops the pass between rows and waits for the
  row in flight.
- Expired reservations: the pass `HEAD`s the key, deletes the object with a
  header-signed `DELETE` if it exists, and then deletes the row under the claim
  fence. A missing object counts as already gone. An object-store error leaves
  the row claimed, and a later pass retries it once the lease lapses.
- Unreferenced bundles are claimed once `unpointedAt` is older than the GET
  lifetime plus the 5-minute grace margin that every other lifetime in this
  design carries. The pass retags the object `ac-cache=unreferenced` and only
  then deletes the row, which releases its bytes. A failed retag leaves the row
  and its bytes. The claim already makes the bundle terminal, so a later pass
  retries the retag. A `404` on the key means the object is gone, and the row
  goes too. A delete refused as `referenced` cannot happen while the claim
  holds; if it does, the pass restores the `live` tag on a best-effort basis
  and leaves the row.
- Unread pointers: `deleteSourceCacheObject` takes an `unchanged` guard of the
  claimed row's `targetKey`, `updatedAt` and `lastReadAt`. It checks the guard
  under the row lock and refuses with `changed`. The claim fence already
  catches a retarget, because the compare-and-set clears `claimedBy`. A GET
  issued after the claim stamps `lastReadAt` without clearing the claim, so only
  the guard catches it.
- Lifecycle rules: members check them and never write them. S3 has no merge
  API: `PutBucketLifecycleConfiguration` replaces the bucket's whole
  configuration. Daemon-managed rules would therefore turn into a
  read-modify-write between every member, the operator's infrastructure code,
  and any foreign rule on a bucket that may also hold `snapshots/`. They would
  also widen every member's role to `s3:PutLifecycleConfiguration`. A check
  needs only `s3:GetLifecycleConfiguration`. The chart README ships the
  two-rule document, and a member logs it for its own prefix.
- `source-cache/lifecycle.ts` accepts a rule for a tag only when all of these
  hold:
  - it is enabled;
  - it expires by days;
  - its tag filter is exactly `ac-cache=<tag>`;
  - its prefix is empty or a prefix of `<prefix>/src/`;
  - it has no size filter.

  The check warns on a rule that also covers `snapshots/`, on one that keeps
  objects longer than the defaults, and on an untagged rule that would expire
  live bundles.

- Each member runs the check at start and every 6 hours. When the bucket
  affirmatively lacks either rule, the member warns at every check and turns
  write-back off, following the section 14 fallback. Reads continue. Write-back
  turns back on at the first check that finds both rules. A configuration the
  member cannot read only warns. The sweep keeps running either way.
- The member's credentials need `s3:GetObject`, `s3:PutObject`,
  `s3:PutObjectTagging` and `s3:DeleteObject` on `<prefix>/src/*`, plus
  `s3:GetLifecycleConfiguration` on the bucket.

## 11. Non-GitHub Sources

**Hosts supported by this design:**

- GitHub: public and private (GitHub App), unchanged.
- GitLab (gitlab.com and configured instances): public and private, with the
  existing GitLab credential minting behind `gitcred`.
- Any other Git host over HTTPS: public repositories only, no credential. The
  canonical origin must pass the daemon's Git-origin policy.

**Admission (Control Plane):**

- GitHub keeps its current admission and preview scan.
- GitLab admission records the numeric project id and the private flag and scans
  `SKILL.md` through the GitLab API, at parity with GitHub.
- Other hosts are admitted on syntax and origin policy alone. **The CP makes no
  network request to a URL a user typed** (no SSRF, no content through the CP).
  Preview answers `resolvable:false`, so the console offers whole-source
  enablement or a manual skill filter, which the UI already supports.
- Whether the Source works is learned at the first reconcile in a pod. The
  daemon reports each skipped Source to the CP as agent skill status metadata:
  the Source's name and an enumerated reason code — `resolution_failed`,
  `access_denied`, `ref_moved`, `commit_unavailable`, `sha_fetch_refused`,
  `fetch_failed`, `limits_exceeded`, `cli_failed` — never Git's or the CLI's raw
  output. The console shows the latest code beside the Source; detail stays in
  the member's log.

The `AgentSkillEntry` wire shape follows section 5: the full address, ref,
subdirectory and selections, plus `credential?` as in the workspace contract and
the `CodeHostRepository` reference for a credentialed Source. `githubRepoId`
stays decodable during migration, as the workspace contract's `github` and
`gitlab` arms do ([git-workspace-model.md](git-workspace-model.md) §8).

## 12. Configuration and degradation

The Source Cache is optional. The Helm chart gains `sourceCache.*` values (off by
default): `endpoint`, `region`, `bucket`, `prefix`, `forcePathStyle` (e.g.
MinIO, whose community edition is archived), a credential source
(`serviceAccount` or a Secret reference), and the limits in section 10. Only
pool members receive them.

The chart renders them as one JSON variable, `AC_SOURCE_CACHE`, on the member
container. The member reads it only under `--k8s` and refuses to start on an
invalid document. The endpoint must be `https://`, because the shim admits only
`--bundle-uri=https://` (section 6.1). Static keys arrive as read-only files,
not environment variables, so no process the daemon spawns inherits them
through the environment. The 0400 mount stays readable by any process running
as the member's own uid; sandbox pods remain isolated from it (section 6, item
4). With a role ARN set, the web identity token is projected onto the member
container alone, because the reconciler shares its ServiceAccount. Temporary credentials
are refreshed while they still outlive the URL lifetime plus 5 minutes, since
a presigned URL dies with its session token. The pending reservation must be at
least the PUT lifetime plus 5 minutes, and the bundle cap at most the org quota
and the 5 GiB single-PUT ceiling.

| Condition                                     | Behavior                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| No bucket configured                          | No URLs issued; pods clone from upstream (the OSS default)                                     |
| Signing fails                                 | Treated as a miss for that Source; origin fetch; `reads{outcome=miss,reason=error\|not-https}` |
| Any bundled attempt fails                     | Clean retry without the bundle (section 7); `reads{outcome=fallback,reason=<fallback reason>}` |
| Write-back fails, quota exceeded, or over cap | Nothing written; logged; `write_backs{outcome=failed\|skipped}`; the session is unaffected     |
| Bucket lifecycle rules missing                | Write-back off with a warning; reads continue (section 10); `lifecycle.status{status=missing}` |
| Resolution fails                              | Section 5                                                                                      |

Session startup never depends on the object store.

**Metrics (P1).** `source-cache/metrics.ts` records these on the daemon's
OpenTelemetry meter `@agentconnect.md/daemon-source-cache`, which the daemon's
existing SDK exports. Every name is prefixed `agentconnect.source_cache.`.

| Instrument             | Kind / unit          | Labels                                | Recorded                                                                                                                                      |
| ---------------------- | -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `reads`                | counter `{read}`     | `outcome`, `reason`, `shape`, `class` | Every clone's cache outcome: `hit` (reason `none`), `miss` and `fallback` with their reason                                                   |
| `read_bytes`           | counter `By`         | `shape`, `class`                      | On a hit, the bundle row's size; a fallback's partial download is not knowable and not counted                                                |
| `write_backs`          | counter `{write}`    | `outcome`, `reason`, `shape`, `class` | `written` (reason = trigger), `skipped` (closed skip reason), `failed` (reason = stage), `lost_race`                                          |
| `write_bytes`          | counter `By`         | `trigger`, `shape`, `class`           | The staged and verified size of each written bundle                                                                                           |
| `sweep.passes`         | counter `{pass}`     | none                                  | Each completed sweep pass                                                                                                                     |
| `sweep.rows`           | counter `{row}`      | `step`, `result`                      | Non-zero per-step row results (`claimed`, `deleted`, `object_deleted`, `already_gone`, `retagged`, `failed`, `lost`, `changed`, `referenced`) |
| `sweep.released_bytes` | counter `By`         | `step`                                | Bytes a pass released from org usage                                                                                                          |
| `lifecycle.checks`     | counter `{check}`    | `status`                              | Each lifecycle check's result                                                                                                                 |
| `lifecycle.status`     | observable gauge `1` | `status`                              | A state set (1 for the current status, 0 for the others); nothing before the first check                                                      |

Labels are closed daemon-authored values; anything outside a label's allowlist
is recorded as `other`, and a miss before the access class resolved has
`class=unknown`. An org id, object key, URL, repository id or error detail is
never a label. Per-org usage is therefore not a metric: the daemon's metrics
carry no org dimension, so it stays the store query `LocalStore.sourceCacheUsage`
over `source_cache_usage`, and quota pressure surfaces as
`write_backs{reason=reservation-over-quota}`.

## 13. Shim protocol

- **Capability:** `skill-git-in-pod-v1`, advertised by the shim.
- **Reconcile plan:** a Git Source entry (URL, ref, planned commit, subdirectory,
  selections, optional GET URL) beside the existing uploaded sources; the reply
  keeps its receipts and `skipped` list and gains write-back candidates.
- **Workspace clone:** the existing clone instruction accepts an optional bundle
  URL, passed as `--bundle-uri`. It needs the new `https://`-only rule for that
  flag in the exec inventory, so it ships with shims that carry the rule; any
  such image whose Git is ≥ 2.38 benefits. Write-back additionally wants a Git
  that honors `GIT_NO_LAZY_FETCH` (2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4,
  2.44.1, 2.45.1+), which the runtime image verifier requires.
- **Exec inventory:** the `--bundle-uri` rule; no form of `bundle` (section
  6.1).
- **`bundle` capability:** granted only to a shim advertising
  `source-cache-bundle-v1`, which a shim does only when its staging directory
  is usable, so older images never write back. Operations: `create` (checkout,
  `refs/heads/<branch>`, origin commit, shape, size cap) → (handle, bytes,
  SHA-256); `upload` (handle, presigned PUT URL, signed headers) → (bytes,
  SHA-256); `discard` (handle). No field carries a filesystem path.
- **Credential window:** `gitcred` issuance for skill repositories is admitted
  only while the daemon holds a reconcile open for that pod.

All operations are daemon-initiated, as today's `begin` / `upload` / `reconcile`.

## 14. Rollout

Each phase ships and rolls back alone.

- **P1 — workspace cache.** S3 configuration and signing on pool members, the
  `source_cache_object` table, `CodeHostRepository.resolveRef` for credentialed
  workspaces (section 7), `--bundle-uri` on the workspace clone, workspace
  write-back, the lifecycle sweep, metrics (hit, miss, fallback, write-back,
  bytes) as the `agentconnect.source_cache.*` instruments in section 12. The
  end-to-end cluster verification of CP1.8 is still open.
- **P2 — skills in the pod.** `resolveRef` for skill Sources, in-pod anonymous
  resolution, the credential window,
  `skill-git-in-pod-v1` and the in-pod Git skill install, skill write-back.
  Images without the capability keep the daemon-acquisition path, including its
  daemon-local cache (#2697), which is removed once those images age out.
- **P3 — non-GitHub admission.** `credential?` skill identity on the wire, GitLab
  admission and preview, arbitrary-host public Sources, skipped-Source status in
  the console.

### P0 prerequisites and baseline (2026-10-01)

**Runtime image Git.** The runtime sandbox dependency base pinned by that day's
Dockerfile (`RUNTIME_SANDBOX_BASE`) ran Git 2.39.5. The pinned digest was
`sha256:bc7614a2d7de40b77e03ac8cfdd09b738efbf93391122cb54ca4d1233c68f5cb`.
In that exact image:

- a blobless `--filter=blob:none` bundle of `refs/heads/main` was created and
  `git bundle verify` reported filter `blob:none`;
- `GIT_NO_LAZY_FETCH=1` stopped a missing promisor object without invoking the
  configured lazy-fetch helper and reported `lazy fetching disabled` (newer
  releases such as 2.54 block it without that warning);
- a blobless clone consumed a bundle through `--bundle-uri`, and
  `fsck --connectivity-only` passed on the result.

`docker/runtime-sandbox/verify-image.mjs` (its probe lives in
`docker/runtime-sandbox/source-cache-git.mjs`) now fails either runtime image
build on a Git that does not honor `GIT_NO_LAZY_FETCH` (below 2.39.4, 2.40.2,
2.41.1, 2.42.2, 2.43.4, 2.44.1 or 2.45.1), or when any of these regresses: the
bundle names exactly `refs/heads/main`, every ref `for-each-ref refs/bundles`
lists after the clone is the source commit (so the Git 2.50 rename passes),
`fsck --connectivity-only` passes, and `GIT_NO_LAZY_FETCH=1` keeps the
lazy-fetch helper from running while the same read without it reaches the
helper.

**S3-compatible store matrix.** MinIO
`RELEASE.2025-10-15T17-29-55Z` was tested locally on 2026-10-01. The community
MinIO project is archived and source-only since 2025-10-23, so this is a
fixture result, not a store recommendation. The project no longer publishes
images, so CI builds the MinIO server from the pinned
`RELEASE.2025-10-15T17-29-55Z` commit (`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`)
and runs that binary. MinIO enforced `Content-Length`, `x-amz-checksum-sha256` and
`x-amz-tagging` only when they were signed headers, not when hoisted into the
query or left unsigned:

| Primitive                                         | MinIO result | Evidence                                                                                                                       |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Conditional `PutObject` with `If-Match`           | Pass         | A wrong ETag was rejected; the matching ETag replaced the pointer. No longer used: the pointer is a store row (section 4).     |
| Presigned PUT with signed `Content-Length`        | Pass         | `X-Amz-SignedHeaders` included `content-length`; the exact request stored the declared length.                                 |
| Presigned PUT with signed `x-amz-checksum-sha256` | Pass         | The correct checksum stored; a body/checksum mismatch returned `XAmzContentChecksumMismatch`.                                  |
| Presigned PUT with signed `x-amz-tagging`         | Pass         | The stored tag was `ac-cache=pending`; omitting a signed header was refused as an unsigned-header request.                     |
| Tag-filtered lifecycle expiration                 | Pass         | Lifecycle readback contained `Filter.Tag { ac-cache = pending }`, `Expiration.Days = 2`; the tagged object reported that rule. |

AWS S3 was **not verified**: this workstation had no AWS credentials. Its
conditional-write and signing capabilities therefore remain unassumed for P1.
The pointer is a store row since CP1.6 (section 4), so `If-Match` is no longer
required. The fallbacks are: do not enable write-back when the store cannot enforce the
declared length/checksum/tag on a presigned PUT; and keep write-back disabled
where the lifecycle cannot select `ac-cache=pending`, because the database sweep
alone loses the no-row orphan guarantee.

**Bundle behavior.** The pinned runtime base container, not a test-app pod, was
used for a local Git 2.39.5 spike:

- a bundle URL with an HTTPS query string was fetched successfully;
- the blobless `cloneSessionRootAt` shape used `--filter=blob:none`,
  `--no-checkout`, `--single-branch` and a `--bundle-uri=<url>`; `reset --hard`
  fetched the missing blob;
- a foreign `refs/heads/main` bundle left `refs/bundles/main`
  (`refs/bundles/heads/main` from Git 2.50) at the foreign commit while the
  clone's branch and `origin/main` stayed at the origin commit;
- a `tree:0` bundle used by a full clone exited 128 with
  `unable to parse commit` and `Clone succeeded, but checkout failed`; it left
  `refs/bundles/main` for the retry path to remove;
- a presigned-style HTTPS URL with a 1.5 KB query string worked as a
  `--bundle-uri` value.

A Docker version matrix (Git 2.38.0, 2.39.3, 2.39.4, 2.39.5, 2.47.3, 2.49.0,
2.50.0 and 2.56.0) then measured:

- `--bundle-uri` worked on every version, and a blobless
  `bundle create --filter=blob:none refs/heads/<b>` from a blobless clone did no
  lazy fetch on any of them;
- `GIT_NO_LAZY_FETCH` was ignored by 2.38.0 and 2.39.3 and honored from 2.39.4;
  an unfiltered create from a partial clone fetched lazily, and failed with the
  variable set;
- a bundle was applied only for the `refs/heads/*` refs it named; a `HEAD` or
  `refs/remotes/*` bundle was silently ignored;
- the imported ref was `refs/bundles/<b>` through 2.49 and
  `refs/bundles/heads/<b>` from 2.50;
- an incomplete bundle failed a full clone (rc 128) but let a blobless
  `--no-checkout` clone exit 0, after which `fsck --connectivity-only` failed
  and a checkout lazily fetched the missing trees;
- a bundle download failure (HTTP error, untrusted certificate) exited 0 with
  either `warning: failed to download bundle from URI` or
  `failed to fetch objects from bundle URI`.

This reproduces the §6/§7 behavior at the container layer, but it does not
replace the required test-app pod run.

**Baseline timings.** Not measured. This workstation had no test-app kubeconfig,
so the cold workspace clone, skill install and claim → runtime-ready numbers are
still missing and must not be inferred from local runs.

**Go/no-go.** Go for P1 implementation against the pinned runtime base and
MinIO, with the regressions above pinned. No-go for claiming AWS S3 support,
enabling Source Cache by default, or treating CP0.3 as complete until the AWS
matrix and test-app pod/timing checks run. The chart default remains off while
`sourceCache` is unimplemented.

## 15. Change index

| Package       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon        | Source Cache client and signer, `CodeHostRepository.resolveRef` (`codehost/repository.ts`, `codehost/ref-resolver.ts`, `github/repository.ts`, `gitlab/repository.ts`) and its read gate `source-cache/authorize-read.ts`, the workspace read planner `source-cache/read-plan.ts` and retry contract `workspace/bundled-clone.ts` behind `workspace-manager.ts`, workspace write-back `source-cache/write-back.ts` with the header-signed HEAD/retag/DELETE/lifecycle-read client `source-cache/object-client.ts`, the sweep `source-cache/sweep.ts` and lifecycle check `source-cache/lifecycle.ts`, the metrics recorder `source-cache/metrics.ts`, reconcile plan and write-back in `reconcileSandboxSkills` |
| daemon (shim) | In-pod Git skill acquisition in `shim/skill-handler.ts`, the `bundle` operations (`shim/bundle-handler.ts`, `shim/bundle-protocol.ts`, daemon side `shim/bundle-client.ts`), credential window in the `gitcred` tunnel, the `--bundle-uri` rule in `workspace/git-command-policy.ts`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| daemon store  | `source_cache_object` table on both drivers, with `canonicalColumns` entries for the Postgres dialect; the pointer row's compare-and-set in `setSourceCachePointer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| protocol      | `credential?` `AgentSkillEntry` identity; shim capability and operation schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| control-plane | GitLab skill admission and preview; arbitrary-host admission without network access; skipped-Source reason codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| docs          | [shared-skills.md](shared-skills.md) §3, §6.2 and §8 marked relocated for the in-pod path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| web           | Non-GitHub import form and the per-Source failure display                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| chart         | `sourceCache.*` values, member credentials, the bucket lifecycle rule document in the chart README                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
