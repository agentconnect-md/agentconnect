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
<remote>` downloads a bundle, then fetches whatever is missing from the remote.
`git bundle create <file> --filter=blob:none <ref>` writes a v3 bundle that
records its filter (`@filter=blob:none`); a blobless `--bundle-uri` clone accepts
it, `git fsck` passes on the result, and a checkout fetches only the blobs it
needs. With `GIT_NO_LAZY_FETCH=1` a filtered bundle is written from a partial
clone without fetching anything (verified on Git 2.54).
The daemon image is `node:24-bookworm-slim` (Git 2.39). The runtime sandbox image
is built separately and its Git version must be confirmed (section 14).

## 4. Storage layout

One bucket (or one prefix of a bucket) per install:

```
<prefix>/
  src/<org>/<urlHash>/refs/<refHash>/<shape>/latest  pointer: JSON { bundle, commit, bytes, createdAt }
  src/<org>/<urlHash>/bundles/<uuid>.bundle          immutable Git bundle, exactly one ref, one shape
  files/<org>/<sha256>.tar                           reserved: digest-addressed file collection
  snapshots/…                                        reserved: Workspace Snapshot (not this design)
```

- `urlHash` is the SHA-256 of the canonical remote URL: lower-cased host,
  credentials, query and fragment stripped, trailing `.git` removed, standard SSH
  spellings rewritten to their HTTPS authority. The cache identifies a repository
  by URL only; anti-replacement is an admission and resolution concern (section 5).
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
  "is this repository public" branch from the key.
- Bundles are **immutable** and never overwritten; only `latest` moves.
- Source Cache lifecycle rules and access policy apply to `src/` (and later
  `files/`) only. Nothing in this design may match `snapshots/`.

## 5. Source resolution

Source resolution turns a Source's ref into the exact commit to use, with the
requesting agent's own access, and a success is the authorization to read that
Source's cache entries. A cache hit is never served without it. It touches only
metadata.

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

- **Anonymous Source:** shared across agents for 60 s, as `GitSkillRefTracker`
  does today. Anonymous content needs no proof of access.
- **Credentialed Source:** keyed by (agent, Source, ref) for 60 s. Revoked
  upstream access therefore stops cache reads within 60 s, the same order as
  today's tracker TTL.

On failure:

- A Source that was installed before keeps its installed commit, as today — but
  **no GET URL is issued for it**, because the failure may be exactly a revoked
  grant. The pod uses what its volume already holds or fetches upstream; if that
  also fails, the Source is skipped with a reason code (section 11).
- A Source that was never installed is skipped for this preparation.

A pinned ref (a commit SHA) still resolves: resolution proves access and the
commit is taken as given.

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
   requires the planned commit to be present and `git fsck`-clean after import.
   Git's bundle bootstrap is not a fallback: a bundle that advertises the right
   ref but omits objects the commit needs makes `git clone --bundle-uri` fail
   (`unable to parse commit`, "Clone succeeded, but checkout failed"; reproduced
   on 2.39 and 2.54) even though the origin is healthy. So every cached
   acquisition, workspace or skill, that fails for any reason discards its whole
   staging checkout and object database and retries **once without the bundle**
   before any origin error is surfaced (the retry contract, section 7). A
   poisoned bundle then costs one wasted download, never a failed session.
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

| Operation                                                                                | Path                                      | Inventory change and why it is a control                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace clone with `--bundle-uri`                                                      | Shim `exec`                               | `clone` is admitted. New per-subcommand rule: `--bundle-uri` is accepted only with an `https://` value, so the flag cannot read pod-local or cluster-internal files                                                                                                                                                                                                   |
| Workspace retry without the bundle                                                       | Shim `exec`                               | None: the same admitted `clone`                                                                                                                                                                                                                                                                                                                                       |
| Workspace write-back bundle                                                              | Shim `exec`                               | Narrow widening: `bundle` is admitted only as `bundle create <file> --filter=blob:none <ref>` (or without the filter for the `full` shape), with `<file>` inside the shim's staging root and `GIT_NO_LAZY_FETCH=1`; `unbundle`, `verify` and `list-heads` stay refused                                                                                                |
| Anonymous resolution                                                                     | Shim `exec`                               | None: `ls-remote` is admitted                                                                                                                                                                                                                                                                                                                                         |
| Skill acquisition: clone, fetch, subdirectory checkout, `fsck`, retry, write-back bundle | Shim-internal, inside the skill reconcile | Not the exec channel. The shim spawns Git itself with argv it composes from validated plan fields (origin policy on the URL, ref / SHA / subdirectory syntax), under the same refused-argument rules as `exec`, in a private staging directory; nothing the daemon sends is passed as free argv, and the runtime cannot invoke the operation. `fsck` exists only here |

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
   origin reports.
3. **Retry contract.** If the bundled clone fails at any step — download,
   unbundle, fetch, connectivity, or checkout — the shim empties the checkout
   directory (object database included) and runs the same clone once without
   `--bundle-uri`. Only that second attempt's failure is an origin failure, and
   only it reaches the existing clear-and-rethrow path (`cloneSessionRootAt`,
   `cloneInSandbox`). The first
   failure is reported as a cache fallback (metric, and the bundle key in the
   log) and the pointer is not trusted again by this preparation.
4. The shim reports a write-back candidate when the clone missed the cache, the
   clone's origin fetch after the bundle exceeded a delta threshold (default:
   5,000 objects or 50 MiB; the checkout's lazy blob fetch is not counted), or
   the bundle is older than 7 days (section 9).

A resumed pod whose volume already holds the checkout is untouched: it pulls as
today and uses no cache.

Workspace resolution: the workspace keeps using the origin as its authority for
the branch head. When a GET URL is issued for a private repository, the daemon
first performs Source resolution (section 5), which adds one metadata round trip
to a workspace preparation that hits the cache.

## 8. Skill flow

A shim that advertises `skill-git-in-pod-v1` installs Git skill sources itself:

1. Every Git skill Source is resolved (section 5), concurrently: credentialed
   ones on the daemon, anonymous ones by `ls-remote` in this pod. The daemon then
   sends the shim one reconcile plan: for each Git Source its URL, ref, planned
   commit, subdirectory, selections, and a GET URL when a pointer exists; managed
   and Dream sources are uploaded exactly as today.
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
     not `fsck`-clean, discards the staging directory and repeats this step once
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

1. The shim's reply lists candidates: (Source, ref, shape, bundle size, bundle
   SHA-256). It creates the bundle in its staging root from the clone it just
   made, of that clone's shape (section 6.1), never from a shallow repository.
2. **Reserve before signing.** In one transaction the daemon checks the
   per-bundle cap and inserts a `pending` row for a fresh
   `bundles/<uuid>.bundle` carrying the declared size and an expiry (the PUT
   lifetime plus a grace, default 1 h), admitted only if the org's committed
   bytes plus every unexpired `pending` reservation plus this one stay within the
   quota (section 10). The org's usage row is locked for the check, so two pool
   members cannot both admit the last 2 GiB. A refused reservation means no
   write-back.
3. Only then does the daemon sign the PUT: the declared `Content-Length`, the
   declared SHA-256 (`x-amz-checksum-sha256`), and the object tag
   `ac-cache=pending` are all part of the signature, so the store rejects any
   other length or content and the pod cannot omit or change the tag.
4. The daemon sends a `writeback` shim operation carrying the URL. The shim
   uploads from its own process (the URL never appears on a command line).
5. On the shim's reply the daemon `HEAD`s the object, requires the reserved
   length and the signed checksum, marks the row `committed`, retags the object `ac-cache=live`, and
   replaces `latest` with a conditional write (`If-Match` on the ETag it read).
   Losing that race is dropped silently and the new bundle is marked
   unreferenced: any valid bundle of the ref is an acceptable pointer target. On
   a store without conditional writes the replacement is last-writer-wins, which
   is equally safe and only occasionally regresses to an older bundle.

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
issued after the agent's own resolution proved access, so this exposes nothing
the agent could not already read.

## 10. Capacity and eviction

Defaults, all Helm values:

| Limit                 | Default | Enforcement                                                                   |
| --------------------- | ------- | ----------------------------------------------------------------------------- |
| Bundle size           | 2 GiB   | The daemon refuses to reserve; the store enforces the signed length           |
| Org total             | 20 GiB  | Committed bytes plus unexpired reservations, checked under the org's row lock |
| Pending reservation   | 1 h     | Sweep deletes the object and the row, releasing the reservation               |
| Pending-tagged object | 2 days  | Bucket lifecycle rule on `ac-cache=pending`, independent of the database      |
| Unreferenced          | 7 days  | Bucket lifecycle rule on `ac-cache=unreferenced`                              |
| Unread pointer        | 30 days | Daemon background sweep deletes the pointer; lifecycle then collects          |

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
default): `endpoint`, `region`, `bucket`, `prefix`, `forcePathStyle` (MinIO), a
credential source (`serviceAccount` or a Secret reference), and the limits in
section 10. Only pool members receive them.

| Condition                                     | Behavior                                                   |
| --------------------------------------------- | ---------------------------------------------------------- |
| No bucket configured                          | No URLs issued; pods clone from upstream (the OSS default) |
| Signing fails                                 | Treated as a miss for that Source; origin fetch; metric    |
| Any bundled attempt fails                     | Clean retry without the bundle (section 7); metric         |
| Write-back fails, quota exceeded, or over cap | Nothing written; logged; the session is unaffected         |
| Resolution fails                              | Section 5                                                  |

Session startup never depends on the object store.

## 13. Shim protocol

- **Capability:** `skill-git-in-pod-v1`, advertised by the shim.
- **Reconcile plan:** a Git Source entry (URL, ref, planned commit, subdirectory,
  selections, optional GET URL) beside the existing uploaded sources; the reply
  keeps its receipts and `skipped` list and gains write-back candidates.
- **Workspace clone:** the existing clone instruction accepts an optional bundle
  URL, passed as `--bundle-uri`. It needs the new `https://`-only rule for that
  flag in the exec inventory, so it ships with shims that carry the rule; any
  such image whose Git is ≥ 2.38 benefits.
- **Exec inventory:** the `--bundle-uri` rule and the narrow `bundle create`
  admission (section 6.1).
- **`writeback` operation:** (Source or workspace, ref, local bundle handle,
  presigned PUT URL) → (uploaded bytes, SHA-256).
- **Credential window:** `gitcred` issuance for skill repositories is admitted
  only while the daemon holds a reconcile open for that pod.

All operations are daemon-initiated, as today's `begin` / `upload` / `reconcile`.

## 14. Rollout

Each phase ships and rolls back alone.

- **P1 — workspace cache.** S3 configuration and signing on pool members, the
  `source_cache_object` table, `--bundle-uri` on the workspace clone, workspace
  write-back, the lifecycle sweep, metrics (hit, miss, fallback, write-back,
  bytes).
- **P2 — skills in the pod.** `CodeHostRepository.resolveRef`, in-pod anonymous
  resolution, the credential window,
  `skill-git-in-pod-v1` and the in-pod Git skill install, skill write-back.
  Images without the capability keep the daemon-acquisition path, including its
  daemon-local cache (#2697), which is removed once those images age out.
- **P3 — non-GitHub admission.** `credential?` skill identity on the wire, GitLab
  admission and preview, arbitrary-host public Sources, skipped-Source status in
  the console.

Before P1: confirm the runtime image's Git version (≥ 2.38 for `--bundle-uri`;
filtered bundles and `GIT_NO_LAZY_FETCH` need a recent Git and should be pinned
by the image test), and which S3-compatible stores the chart supports for
conditional writes, signed `Content-Length`, `x-amz-checksum-sha256` and
`x-amz-tagging` on presigned PUTs, and tag-filtered lifecycle rules (AWS S3 and
MinIO at least).

## 15. Change index

| Package       | Change                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| daemon        | Source Cache client and signer, `CodeHostRepository.resolveRef`, `workspace-manager.ts` clone bundle URL, reconcile plan and write-back in `reconcileSandboxSkills`                                          |
| daemon (shim) | In-pod Git skill acquisition in `shim/skill-handler.ts`, `writeback` operation, credential window in the `gitcred` tunnel, the `--bundle-uri` and `bundle create` rules in `workspace/git-command-policy.ts` |
| daemon store  | `source_cache_object` table on both drivers, with `canonicalColumns` entries for the Postgres dialect                                                                                                        |
| protocol      | `credential?` `AgentSkillEntry` identity; shim capability and operation schemas                                                                                                                              |
| control-plane | GitLab skill admission and preview; arbitrary-host admission without network access; skipped-Source reason codes                                                                                             |
| docs          | [shared-skills.md](shared-skills.md) §3, §6.2 and §8 marked relocated for the in-pod path                                                                                                                    |
| web           | Non-GitHub import form and the per-Source failure display                                                                                                                                                    |
| chart         | `sourceCache.*` values, member credentials, bucket lifecycle rule template                                                                                                                                   |
