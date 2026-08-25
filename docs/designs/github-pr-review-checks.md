# Formal GitHub PR Reviews + Durable Informational Checks

> Status: **R1 + R2a are implemented**: controlled formal PR reviews and
> CP-owned informational Checks. **R2b required gates, R2c required-safe
> fork/merge-queue support, and R3 commit statuses are not implemented.** The server fails
> closed for `gateMode=required` and `reportingMode=status`.
>
> The current design uses `AgentRepoAuthorization`, numeric repository identity,
> the repository-routed gitcred/gh wrapper, `GithubFinalPoster`, and HookRun.
> R2a includes the `projectionEpoch` configuration-binding fence,
> hook/repository-authorization lifecycle locks, live commit→PR association, a
> correlated `hook/report` ACK outbox, post-mint authority revalidation for
> review tokens, and installation-token epoch invalidation.
>
> Prerequisite:
> [webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md).
> A numbered GitHub hook turn publishes a bounded, single-attempt **final-only
> fallback ordinary comment** through `GithubFinalPoster.publish()` only when
> the turn never began a formal review attempt, or when its current/latest
> attempt is definitively `not_submitted` (no formal external write). The
> prompt forbids the agent from directly writing comments/reviews. Formal
> review and fallback ordinary comment are mutually exclusive; each turn
> produces at most one public top-level output.
>
> GitHub constraints follow official documentation: [review API](https://docs.github.com/en/rest/pulls/reviews), [Checks API](https://docs.github.com/en/rest/checks/runs), [App installation permissions](https://docs.github.com/en/rest/apps/apps), and [required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Current Safety Conclusions

Formal reviews, Checks, and legacy statuses share the GitHub-hook foundation,
subject to these constraints:

1. **Repository-routed `GH_TOKEN` cannot enforce a hard per-hook gate.** It resolves a fresh token for each `gh` call against the workspace/explicit additional repository, solving cross-installation access and 1h freshness. But the `comment` tier already grants `pull_requests:write`, shared by GitHub `COMMENT`, `REQUEST_CHANGES`, and `APPROVE`. A user-provided `GH_TOKEN` also bypasses the wrapper. A token therefore cannot express one hook's review tier.
2. **`external_id` is not a Checks API idempotency key.** Every `POST /check-runs` creates another run; `external_id` is only an integrator reference. If the check ID lives only in daemon `Pending`, a daemon crash leaves a required check `in_progress` until GitHub marks it stale, at most 14 days later.
3. **`GET /app` cannot tell whether an installation owner approved new permissions.** It returns the App registration's target permissions; an existing installation retains old permissions until its owner approves. Persist each installation's effective `permissions`.
4. **The CP cannot reuse poster body as Check summary.** Bodies are message
   content and must not pass through this reporting path. CP may publish only
   control metadata such as state, timestamps, enum verdict, and links. This is
   distinct from an authorized, bounded BFF transcript read.
5. **"One Check per turn" cannot directly be a required review gate.** A label/comment turn on the same head SHA could finish after a real code-review failure and turn the context green; concurrent/out-of-order completions can let stale results overwrite new ones. A required context must aggregate the `(hookId, revision)` review verdict with head/base/report SHA fences, not ordinary turn success.

## Current Delivery Scope

| Phase | Current state   | Boundary                                                                                                         |
| ----- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| R1    | Implemented     | Structured formal reviews, active-turn/action-time authority, durable attempt/result recovery                    |
| R2a   | Implemented     | `check + informational`; durable projection/reporter, epoch/lifecycle locks, ACK outbox, informational rerequest |
| R2b   | Not implemented | Required eligibility, test-merge acceptance, required-safe rerequest                                             |
| R2c   | Not implemented | Required-safe fork PRs and merge queue / `merge_group`                                                           |
| R3    | Not implemented | Legacy commit-status transport and `statuses:write` rollout                                                      |

Wire/schema retain `required` and `status` enum values for rolling compatibility, but they are not delivered capabilities. HTTP create/update returns a semantic conflict for both, and daemon/worker fail closed again. R2a accepts `check_run.rerequested`, `check_suite.rerequested`, `check_run.requested_action(request_review)`, `pull_request.review_requested`, and an approved pull-request workflow entering `workflow_run:in_progress`. These explicit events may start a new generation only for a current **informational** hook, and the explicit requester or workflow triggering actor must still hold a trigger-authorized repository role. Required-safe semantics remain R2b.

## Relationship to Dynamic Agent Repository Authorization

Dynamic repository authorization defines which repositories an agent may
access and how tokens are delivered. This design creates no hook-derived grant;
R1/R2a apply that authorization to reviews and Checks:

- **Numeric workspace identity is the durable source of truth.** `Agent.workspaceRepoId` persists GitHub's numeric repository ID for new GitHub workspaces; legacy rows lazily repair through live installation/repository lookup. Repair and grant create/delete share the `(agentId,repoId)` lock and atomically delete a legacy redundant grant for the same numeric repository. This does not revoke workspace authority, so it must not tombstone a still-valid workspace projection. Workspace/additional classification, hook validation, review authorization, and Checks minting are repository-ID-first. `gitRepo`/`repoFullName` are endpoint/display hints only. A rename therefore cannot misclassify a workspace as an additional grant or bypass workspace `gitAccess`.
- **Repository authorization is the first gate.** Workspace repository uses `gitAccess`; additional repositories require explicit `AgentRepoAuthorization` of `read|comment|write`. Workspace `gitAccess=write` permits all review events. Additional `comment` permits only formal `COMMENT`; additional `write` is required for `REQUEST_CHANGES|APPROVE`. Scratch has no implicit repository and treats explicit grants under the same additional rules. This avoids inflating the comment grant—which needs only operator GitHub-read identity—into App approval. Unauthorized, read-only, or grandfathered-but-unauthorized hooks cannot perform formal review/reporting. The ordinary poster is the existing **enabled-hook-owned** writer, not authorized by workspace `gitAccess`/additional grant, so a read-only workspace can still return a final comment. Do not rewrite this existing boundary as the R1/R2a repository-auth gate. Cross-owner works only with explicit additional-repository authorization.
- **Hook policy is the second gate.** The review-authorization RPC first verifies the HookRun fire snapshot/current policy/accepted `dispatchDaemonId + dispatchRevision + projectionEpoch`, current placement, and current dispatch revision, then reuses the repository-ID allowlist/installation/access resolver extracted from `GithubService.mintForAgent`. Formal review is a new external effect, not old-turn completion bookkeeping. An old daemon may use its persisted dispatch fence to complete a terminal `hook/report`, but cannot mint/expose a review token after reassignment. Review RPC requires both the persisted accepted tuple and current placement and otherwise fails closed. Resolver must explicitly return `pull_requests=write`; it cannot rely on current `mintForAgent` silently clamping the read tier and let GitHub POST fail with 403. It must not bypass `AgentRepoAuthorization` by reading HookDef.repo or revive implicit `extraRepos`.
- **Delivery surfaces are separate.** Formal-review tokens never enter `GitCredentialCache`, the gh wrapper, or agent environment. Daemon obtains one per action through a dedicated RPC and supplies it only to the broker client. CP may internally reuse `InstallationTokenService` repository-scoped cache/single-flight, but must rerun both authorization gates before every token exposure. Ordinary poster keeps using `getPostToken`.
- **Checks are a hook-owned system effect (status follows only in R3).** They do not expand the agent's `GitCredCapability`; CP publishes them with a distinct purpose token. Reporting still requires workspace/additional `write`; an additional-repository `comment` grant, based only on operator read identity, cannot expand into Checks, especially a required gate. Revoking agent repository authorization blocks the next action-time review immediately. Generic agent gh tokens retain the cache/revocation window (an already minted token lives up to ~1h), so do not claim immediate revocation. Poster authority is enabled HookDef, not the grant: revoking a grant does not stop poster; disable/delete the hook to stop later minting. Existing projections may use their retained target snapshot only once for canonical non-passing cleanup, never to publish pass or new informational output.
- **Repository-auth revoke and cleanup form one atomic authority mutation.** Additional-grant deletion takes the `(agentId, repoId)` lifecycle advisory lock in the same DB transaction, tombstones affected projections, queues non-passing cleanup, then deletes the grant. Projection create/upsert takes the same agent/repository lock after the hook lifecycle lock, so an empty candidate scan has no no-row phantom: a concurrent create is either seen and tombstoned before revoke or fails closed against live authority after revoke. Hook disable/delete, agent/repository binding, and reporting/gate mutation similarly perform cleanup under the hook-level lock before changing configuration binding.
- **Installation permission is an exact persisted fact.** `GithubInstallation.permissions` stores installation-effective permissions; `{}`/legacy means unknown and fails closed. Setup callback, sync, and installation doorbell update the same fact, invalidate the corresponding token cache, wake affected projections, and rerun dynamic repository/installation resolution. UI separately exposes exact `checksPermission=write|missing|unknown`. R1 requires persisted `pull_requests=write`; R2a mints Checks/association tokens only with persisted `checks=write` and `pull_requests=read|write`. Neither App registration targets nor coarse `permissionsStatus` suffice. Live-installation convergence prevents treating an old installation ID as permanent authority.
- **Token-cache invalidation also has an epoch fence.** Each installation's cache/single-flight has local `installationEpoch`. Callback/sync/doorbell/revoke/suspend and 401/403/422 refresh increment the epoch and clear cache/inflight. A stale mint returning later cannot repopulate cache; the serve-time epoch check returns a retryable invalidated error instead of exposing a superseded bearer to review/reporter.

## Goals

1. **R1—formal PR review:** agent decides semantics but submits `COMMENT`, `REQUEST_CHANGES`, or `APPROVE`, plus single/multiline inline comments, only through daemon-provided structured `submitGithubReview`. Repository, PR, head SHA, and policy come from the trusted active turn, never model input.
2. **R2a—informational Checks:** maintain a recoverable informational Check projection (`queued → in_progress → completed`) for a reviewed PR revision. HookRun stores delivery facts; a separate durable projection stores commit-scoped current state. It converges after daemon/CP restart, redelivery, reaper, and out-of-order completion. An explicit rerequest starts another generation on the same Check Run. R2a never publishes a required context.
3. **R2b—required-safe gate (future):** only hooks that unconditionally cover PR head and pass real fork/branch-protection/rerequest tests can be required-eligible. Ordinary conversational turns cannot write this context.
4. **R3—commit status (future):** repositories that only recognize legacy status get a reporting mode **mutually exclusive** with Checks, reusing the same generation fence rather than a separate agent pipeline.
5. Preserve invariants: message/body/inline-comment body does not enter CP; **review/check/status purpose tokens** do not enter agent environment (generic `GH_TOKEN` behavior is unchanged); CP remains off the webhook→agent message hot path.

## Non-Goals

- Replace CI, upload build logs, automatically merge, push auto-fixes, or configure branch protection.
- Give logical agents independent GitHub identities. Installation-token operations appear as the deployment-level App bot; no per-user OAuth reviewer.
- Let a numbered hook turn bypass controlled review through `gh pr review`, GraphQL/REST, GitHub MCP, or connector.
- Claim required-gate safety for fork PRs, merge queue, or App-bot-authored PRs before real acceptance tests.

## Configuration Model

```prisma
enum HookReviewPolicy {
  off
  comment
  request_changes
  full
}

enum HookReportingMode {
  off
  check
  status
}

enum HookGateMode {
  informational
  required
}

model HookDef {
  // ...existing fields...
  configRevision                BigInt            @default(1)
  dispatchRevision              BigInt            @default(1)
  projectionEpoch               BigInt            @default(1)
  reviewPolicy                  HookReviewPolicy  @default(off)
  reportingMode                 HookReportingMode @default(off)
  gateMode                      HookGateMode      @default(informational)
  requiredAcknowledgedAt        DateTime?
  requiredAcknowledgedByUserId  String?
  requiredAcknowledgedConfigRevision BigInt?
}
```

- The three policy fields apply only to **PR subjects**; issue/push turns from the same GitHub hook ignore them.
- `reviewPolicy` is a maximum: `off` exposes no action; `comment` permits only `COMMENT`; `request_changes` also permits `REQUEST_CHANGES`; only `full` permits `APPROVE`.
- Server validates semantic cap: `reviewPolicy=comment` accepts workspace write or explicit comment/write; `request_changes|full` requires workspace/explicit write. `reportingMode != off` requires workspace/additional write. UI reuses the repository authorize/upgrade flow. Repository-auth delete/tier downgrade and workspace `gitAccess` downgrade are security revocations and **must not be blocked with 409**. Commit the mutation, make the next live numeric resolver reject review auth immediately, queue canonical non-passing cleanup for related informational projections, then warn the operator about existing ≤1h poster/gh token windows and branch-rule cleanup responsibility.
- Existing and new hooks safely default/backfill to `off + off + informational`; upgrades must not suddenly request changes or create required contexts.
- `requiredAcknowledged*`, `gateMode=required`, and `reportingMode=status` are future schema reserves. R2a has no acknowledgement writer; HTTP returns 409 for required/status. R3 `status` replaces Checks transport rather than mirroring it.
- Increment `configRevision` transactionally on any mutation affecting compiled hook behavior. Fire/report snapshot it; timestamps are not revisions. Clear stale acknowledgement in the same transaction for any required-eligibility mutation. Confirmation binds only the post-mutation `requiredAcknowledgedConfigRevision`; dynamic permission/installation drift still revalidates.
- `dispatchRevision` is a CP-owned durable fence. Increment transactionally when compiled config or owning agent placement daemon changes. `RcHookAssign` carries `{agentId, daemonId, configRevision, dispatchRevision}`; relay cannot invent it. `rc/run-report accepted` creates authoritative HookRun only when the whole tuple matches current CP values. Once accepted, the persisted tuple may let the old daemon complete after replacement, but grants no new action/run authority.
- `projectionEpoch` fences configuration-binding lifecycle, not normal generations. Increment transactionally only on enable/disable, agent/repository binding, `reportingMode` transport, or `gateMode` changes. HookRun snapshots it; projection natural key is `(hookId, repoId, reportSha, projectionEpoch)`. Old-epoch tombstones are one-way but do not suppress a new explicit enable epoch. Global lock order is **organization lifecycle (shared producer/exclusive delete) → optional agent lifecycle → hook lifecycle → agent/repository authorization → epoch-qualified natural key → projection row `FOR UPDATE`**. Hook edit/delete, repo-auth revoke, and worker begin/complete use this order so config mutation, marker, pending intent, and tombstone cannot fork from stale reads.
- R2a retains `required` in schema but rejects it server-side until every R2b release gate passes. Minimum server-verifiable conditions are unconditional coverage of `pull_request:opened`, `pull_request:synchronize`, and base-changing `pull_request:edited` (normally via `pull_request:*`), plus `enabled=true`, `reviewPolicy != off`, `reportingMode != off`, `mentionOnly=false`, and `labelFilter=[]`. R2b permits only `reportingMode=check`; status needs R3's own required acceptance gate. Base retarget is now a trusted revision event, but its R2a head `reportSha` does not distinguish same-head base revisions and therefore is not sufficient for a required gate. Current App permissions cannot reliably read all branch-protection/ruleset/merge-queue facts, so editor must explicitly acknowledge strict-up-to-date, no merge queue, and fork support assumptions in `requiredAcknowledged*`. Do not market auto-detection. Disable/delete and mode changes show blocking warnings.

## Decisions

### 1. Agent Decides; Daemon Performs Formal Review

R1 does not invoke raw `gh pr review`. Daemon's session-bound MCP bridge adds `submitGithubReview`. Its descriptor is **statically attached to every long-lived ACP session** because a per-thread session spans ordinary messages and multiple hook deliveries. Descriptor visibility is capability discovery, **not authorization**. Every call must find a current PR-hook turn in daemon-private `activeGithubTurnMeta` that crossed the `hook/start` barrier, then obtain action-time CP authorization. Ordinary turns, non-PRs, policy off, stale/replayed authority, or unavailable CP fail closed. Agent submits only review body and semantic outcome:

```ts
submitGithubReview({
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE',
  verdict: 'pass' | 'fail' | 'neutral',
  body: string,
  comments?: Array<{
    path: string,
    body: string,
    line: number,
    side: 'LEFT' | 'RIGHT',
    startLine?: number,
    startSide?: 'LEFT' | 'RIGHT'
  }>
})
```

Target is **not** tool input. Daemon resolves current `activeGithubTurnMeta` by logical session key:

```ts
interface ActiveGithubTurnMeta {
  entry: QueueEntry
  hook: HookDispatchContext // durable ids, snapshot, revision, attempt/result
  snapshot: HookConfigSnapshot
  repoId: string
  repoFullName: string
  pullNumber: number
  expectedHeadSha: string
  expectedBaseSha: string
  reportSha: string
  reviewState: 'idle' | 'submitting' | 'done'
}
```

Set this metadata at turn start and clear it in `finally`. Never put it in the long-lived MCP `SessionContext` created at `session/new`; per-thread sessions span many deliveries and may be shared by multiple hooks on the same agent/repository.

Execution discipline:

1. Fail closed outside an active PR-hook turn, when policy=`off`, requested action exceeds policy, or this turn already submitted a review. Before any `await`, synchronously CAS turn-local `idle→submitting`; reject concurrent tool calls.
2. For each action, send dedicated `github/review-authorize` REQ—**not daemon `GitCredentialCache`**—with `attemptId/hookId/deliveryKey`, full config/dispatch snapshot, `requestedEvent`, and `requestedVerdict`. Using authenticated `conn.daemonId` and unique `(hookId, deliveryKey)`, CP finds the same accepted/started HookRun and verifies persisted fire snapshot, dispatch identity/fence, and request. It takes the lower of current HookDef policy and snapshot policy. In one short DB transaction, CAS HookRun `reviewAttemptId` from null and persist event + verdict. Reusing the same attempt is idempotent only when event/verdict are identical; recovery cannot change `COMMENT + neutral` into `APPROVE + pass`; another attempt/daemon is rejected. Any mismatch/missing row fails closed.
   - After reservation commits, resolve trusted HookRun `{agentId, repoId, repoFullName}` outside the transaction through `resolveAgentRepoAuthorization`, redoing workspace/additional classification, numeric ID, and live installation resolution. Additional `comment` permits only COMMENT; REQUEST_CHANGES/APPROVE require workspace/additional `write`. Then require `pull_requests=write` and mint a broker-only purpose token.
   - CP token cache may hit internally, but daemon retains the 1h bearer only within this action's lexical scope and never falls back to spawn-time/user `GH_TOKEN`.
   - **Do not return REP immediately after mint.** Broker rereads HookRun/HookDef/Agent, revalidates attempt/event/verdict reservation, dispatch/policy/placement, reruns numeric grant/live installation/exact `pull_requests=write`, and requires the installation ID to match the mint. Immediately before exposure, check reservation/current authority again. A grant revoke, hook downgrade/rebind, reaper result, or installation replacement committed during mint is observed before bearer leaves CP. A new reservation may be released only on proven-no-exposure failure; idempotent/blocked reservations remain pinned for marker recovery. Installation-token epoch prevents stale in-flight mint from crossing invalidation. This gives restart-safe reservation without GitHub I/O inside DB transaction.
3. Broker first uses purpose token to `GET pull` again and requires PR not closed/merged and current head/base equal expected revision; otherwise reject and tell agent to reread diff. Then `POST review` with explicit `commit_id=expectedHeadSha`; inline comments and verdict use one batched request.
4. Top-level `body` is required and non-empty for every event, including `APPROVE`, and must be a complete self-contained public summary. Validate model body before appending shared attribution: `sent by Agent (Runtime · Model) · open in session`. A daemon footer cannot disguise empty input.
5. Enforce `APPROVE ⇒ pass`, `REQUEST_CHANGES ⇒ fail`; only `COMMENT` accepts explicit `pass|fail|neutral`. One successful review action per turn. On the same revision, `review_action_only + COMMENT + neutral` means the turn did not alter code-review verdict and cannot overwrite existing `pass/fail`. Only generation-native neutral or a later explicit `pass/fail` changes Check projection.
6. Append an invisible correlation marker after attribution (`hookId + deliveryKey + attemptId + expectedHeadSha`). If REST outcome is uncertain, list reviews with full pagination and find the marker. Retry POST only after proving none exists and rerunning steps 2–3 authorization + revision fence. Review API has no `external_id`.
7. Immediately after GitHub effect, daemon sends body-free outcome through acknowledged `github/review-result`: `submitted` stores `{ reviewId: string, event, verdict, commitId }`; `not_submitted` releases reservation only when no external mutation is proven; `ambiguous` keeps reservation blocked. If request/ack is lost, terminal `hook/report` repeats the same attempt/result metadata for completion replay. Review and inline bodies never upload.
   - Insufficient repository access, unavailable CP, or unapproved cross-owner only fail closed for formal review; ordinary agent turn continues.
   - Fallback decision correlates with current/latest `attemptId`. `not_submitted` proves no formal external write, so final may use poster fallback; no formal attempt also permits fallback. `submitted|ambiguous`, current attempt without result, mismatched attempt/result IDs, or any unresolved state forbids ordinary POST because GitHub may already contain the review. Durably settle `posterPublishState`. Final always remains in session transcript.

Only validation failures known not to have reached the network, or GitHub 4xx proving no review was created, may CAS-release reservation for corrected retry in the same turn. Timeout/disconnect remains reserved/blocked. Before any possible POST, daemon persists attempt ID, requested event/verdict, and trusted hook context in the durable inbox. Restart replay does only GET/list marker reconciliation before reprompt: found marker → converge through `github/review-result` as submitted; read failure or marker invisibility remains ambiguous and never auto-POSTs. Only another explicit identical event/verdict call, after fresh action-time policy + revision fencing, may repeat marker check and potentially one POST. Daemon `finally` clears only active metadata, never durable reservation.

This is not poster-style decision-making for the agent. Agent still decides; daemon supplies a policy-constrained effect boundary. `GithubFinalPoster` exclusively owns fallback ordinary issue comments; `submitGithubReview` owns formal review/inline comments. Though they write different GitHub resources, outcomes are mutually exclusive within a turn to avoid publishing the same conclusion twice.

### 2. Actual Enforcement Boundary of Policy

Daemon deterministically checks policy on the supported review path, and the prompt forbids direct GitHub review mutation. But the gh wrapper mints `pull_requests:write` for `comment|write` repositories, the same OS user can call the helper socket directly, and user-provided `GH_TOKEN` passes through. These credentials cannot distinguish COMMENT / REQUEST_CHANGES / APPROVE. Therefore `reviewPolicy` is **not a cryptographic sandbox against a malicious or runaway model**. Until the runtime supports per-session native tool denial or all GitHub mutations move behind the broker, UI/audit must not describe it as unbypassable.

Use the lower authority of fire snapshot and action-time current HookDef. A downgrade immediately revokes an in-flight turn's next tool action; an upgrade cannot elevate a turn already started. Review tokens are never reused across actions, and unavailable CP rejects the tool. Raw `gh`/API/MCP review writes still violate numbered-turn contract.

### 3. PR Revision Must Be Trusted Metadata

Add top-level trusted `github` metadata to `RdMsgHook`; do not place it in `HookContext`, which also carries third-party body:

```ts
github?: {
  repoId: string // BigInt wire form; from matched rule and verified against payload repository.id
  repoFullName: string // payload canonical/display; repoId is authority
  sourceInstallationId: string
  subjectKind: 'issue' | 'pull_request'
  pullNumber?: number
  headSha?: string
  baseSha?: string
  reportSha?: string // R2a = headSha once authoritative revision is known
  headRepoFullName?: string
  mergeCommitSha?: string
  isDraft?: boolean
}
```

- Trim `pull_request` / `pull_request_review_comment` from signed webhook payload. For `issue_comment`, detect PR through `issue.pull_request`, but payload lacks head SHA. Before prompting, daemon uses repository-targeted token to fetch full revision and reports it through `hook/start`. **Daemon-resolved revision is the sole authority for that delivery**; CP must not independently choose SHA or create a required projection before `hook/start`. Fetch failure disables review/reporting only, not ordinary analysis or poster final.
- Relay generates trusted metadata only when signed payload `repository.id` equals matched rule `repoId`. `repoFullName` is endpoint/rename hint. HookRun/action authorization always uses persisted `{agentId, repoId}`, never daemon-reported name to choose repository. `sourceInstallationId` is ingress attribution/audit and permission-refresh hint, never mint authority; each effect dynamically resolves live installation.
- Put trusted `reviewPolicy` / `reportingMode` / `gateMode` at top level of `RcHookAssign` and `RdMsgHook`, not untrusted `HookContext`; missing fields in rolling upgrade mean `off`.
- `RcHookAssign` snapshot also carries opaque dispatch fence. Both relay `rc/run-report` and daemon `hook/start|report` carry `{subjectKind, pullNumber, head/base/report SHA?, policy/reporting snapshot, configRevision, dispatchRevision, dispatchDaemonId}`. Existing HookRun start/completion validates accepted identity/fence. `hook/start` is a pre-prompt barrier and also requires current definition/placement. After barrier succeeds, terminal completion is bookkeeping and may be repaired by accepted old daemon after reassignment, but cannot grant new review-effect authority. Completion-first without an accepted leg can upsert only if current fence/placement validates; otherwise fail closed.
- Use transactional/CAS monotonic transitions. `accepted` only creates/fills missing. Existing HookRun `startedAt` is relay ingest/fire time; add durable `turnStartedAt` when daemon serial queue enters `dispatchOne`. `hook/start` writes it and authoritative revision only once on nonterminal row. Completion may replace a reaper-orphaned result for same run but never a non-orphaned terminal. Late accepted/start never regresses terminal to queued/in-progress. External projection additionally needs generation CAS.
- `hook/start` is an acknowledged metadata barrier, not fire-and-forget EVT. Daemon may continue ordinary agent turn/poster while CP is down, but exposes review action only after CP ACK durably converges exact fire snapshot, authoritative revision, `turnStartedAt`, and R2a projection intent. Handler returns `hook/start/ok` only after coordinator convergence. This prevents comment-turn action authorization racing ahead of start metadata and distinguishes recoverable queued from in-progress facts.
- Terminal `hook/report` is also **correlated REQ → generic `ack`**, not fire-and-forget EVT. Daemon atomically redacts live inbox row into body-free terminal-report outbox receipt first. CP ACKs only after durable `recordReport` and R2a coordinator convergence. Unacked `terminalReport` never participates in capacity eviction; daemon replays immediately on CP READY and rescans on 5s backoff after temporary/local SQLite failure. One in-flight request per inbox ID; global correlated drain ≤100; settle then pump backlog. After ACK, clear report body but keep stable-ID dedup receipt; evict only **acked receipts** above 10,000 ordered by completedAt. A long CP outage never silently loses terminal outcome for local capacity, and late relay redelivery does not rerun model. Nonretryable dispatch conflict may dead-letter body while retaining same bounded receipt; CP persistence idempotent on `(hookId, deliveryKey)`. Agent pause/remove/host respawn/conversation-loop purge may delete ordinary inbox/acked receipts, never live hook rows or unacked terminal reports. A duty handoff retains an agent's ordinary unrun rows for its successor but **reports** a live hook row instead of handing it over: `hook/start` and every review action are fenced to the accepted `dispatchDaemonId`, so no other member can re-run that fire with authority. The interrupted holder therefore reports it even while draining, and a replay that finds a foreign accepted dispatch reports the handover rather than re-prompting — an immediate outcome with a retry, not a reaped `timed_out` after a degraded rerun. Original QueueEntry uniquely terminalizes runtime. A fresh hook already paused or loop-open is rejected before durable admission; retained hook converts from persisted context into failed receipt and never reruns after unpause/restart.
- Negotiate correlated ACK with `register/ok.serverFeatures=["hook-report-ack-v1"]`. New daemon against old CP sends each retained receipt once as legacy EVT per connection, no 5s hot loop and no local outbox deletion; reconnect to ACK-capable CP releases safely. Old daemon ignores additive feature and continues legacy EVT.
- Treat all GitHub-derived body/diff/tool output as untrusted. Existing `UNTRUSTED` fence covers only webhook excerpt and cannot be claimed to wrap diff fetched later by agent.

### 4. R2a Informational Checks Are a CP-Owned Durable Projection

CP owns App private key, installation source of truth, HookRun, and reaper, so `GithubRunReporter` converges external reporting—not daemon `Pending.github`. R2a worker has a double fail-closed guard: process only `mode=check` and `gateMode=informational`; reserved `status|required` never reach the network.

HookRun remains one historical row per delivery with added configuration/revision/start/review snapshot. Required current state lives in a distinct table:

```prisma
model HookReviewProjection {
  id             String @id @default(uuid()) @db.Uuid
  hookId         String @db.Uuid // snapshot key; intentionally no onDelete:Cascade FK
  orgId          String // resolve organization installation after HookDef deletion
  agentId        String @db.Uuid // repository-auth invalidation after HookDef deletion
  agentName      String? // stable slug snapshot for cleanup display after Agent deletion
  lastResolvedInstallationId BigInt? // observation/provenance, not permanent authority
  repoId         BigInt // rename-proof target
  repoFullName   String // refreshable endpoint/display snapshot
  headSha        String // live commit→PR association query key
  reportSha      String // SHA receiving check/status
  projectionEpoch BigInt // HookDef configuration-binding lifecycle snapshot

  generation       BigInt   @default(0)
  currentHookRunId String?  // existing HookRun.id is cuid(), not UUID
  externalId       String   @unique // stable correlation, not GitHub idempotency
  checkRunId       String?  // opaque 64-bit ID as TEXT

  mode             HookReportingMode // R2a accepts only check
  gateMode         HookGateMode       // R2a accepts only informational
  desiredState     String
  observedState    String?
  sealedThrough    BigInt   @default(0)

  subjectSyncGeneration BigInt @default(0) // terminal association checked once/generation
  subjectSyncErrorCode  String?

  leaseOwner       String?
  leaseUntil       DateTime?
  nextAttemptAt    DateTime?
  attempts         Int      @default(0)
  lastErrorCode    String?
  pendingIntent    Json?    // newer revision/rerun queued behind an external write
  writeMarker      String?  @unique
  writePhase       String?
  writeStartedAt   DateTime?
  tombstonedAt     DateTime?
  updatedAt        DateTime @updatedAt

  subjects HookReviewSubject[]

  @@unique([hookId, repoId, reportSha, projectionEpoch])
}

model HookReviewSubject {
  projectionId String @db.Uuid
  pullNumber   Int
  headSha      String
  baseSha      String?
  isOpen       Boolean @default(true)
  updatedAt    DateTime @updatedAt

  projection HookReviewProjection @relation(fields: [projectionId], references: [id], onDelete: Cascade)

  @@id([projectionId, pullNumber])
}
```

HookRun additionally stores `projectionId/projectionGeneration`, `projectionEpoch`, `projectionIntent`, policy/report snapshots, `pullNumber/head/base/reportSha`, relay-ingest `startedAt`, daemon-dispatch `turnStartedAt`, TEXT `reviewId`, `reviewAttemptId/reviewAttemptState`, `reviewEvent/verdict`, body-free fallback `publishedCommentKind/publishedCommentId`, and dispatch fence. Projection is GitHub commit/context granularity; subject rows hold PR revision. Unique key + transactional `generation` increments ensure one external current generation per hook/repository/report SHA. Every worker job carries `(projectionId, generation)` CAS; old epoch/generation can update history only.

Immediate reporter kick reduces latency; periodic scan supplies reliability. Before each claim, worker scans HookRun to repair crash windows where lifecycle mutation committed but projection convergence did not, then consumes projection outbox. Durable HookRun reconstructs any process gap around `accepted`, `hook/start`, `github/review-result`, or completion:

- Every generation rechecks current repository authorization. If workspace/additional write needed for reporting or semantic cap for review event disappeared, retain HookRun and ordinary analysis but allow only canonical non-passing `blocked(repo_authorization)` cleanup—never reuse old pass or publish new informational success.
- `rc/run-report(accepted)` with authoritative revision always transactionally creates/updates HookRun. R2a creates/increments projection generation to desired `queued` only for `projectionIntent=revision_event` on open, synchronize, or an edited PR with trusted `baseChanged=true`. If previous external effect remains in flight, store only `pendingIntent` until remote confirmation. Label events, unmentioned comments, draft/ready transitions, and other `review_action_only` turns do not create or advance a projection at accepted/start; only a successful structured review action establishes an informational generation and terminal verdict. For a PR-conversation comment that explicitly mentions the Agent/App and passes the permission gate, relay forwards `explicitReviewRequest=true` only when the accepted rule enables formal reviews (the body still never enters CP), and the comment then opens a generation as a `revision_event`. With review policy `off`, the same mention still dispatches through its configured trigger but remains `review_action_only`; this policy does not select or alter the reply/output path. `check_run:rerequested`, `check_suite:rerequested`, `check_run:requested_action`, `pull_request:review_requested`, and an authorized `workflow_run:in_progress` dispatch also produce `revision_event` and a new same-SHA generation. Automatic external-author PR revision events do not dispatch and converge to skipped projection `review_request_required` with requested action. PR `issue_comment` without SHA creates HookRun only; review action waits for daemon `hook/start` authoritative revision.
- When daemon serial queue enters `dispatchOne`, it sends metadata-only `hook/start`. Only a run already bound to a `revision_event` projection marks its current generation `in_progress`.
- Terminal `hook/report` converges only its bound generation. `review_action_only` without a successful review creates no projection.
- Successful structured review writes review metadata/verdict transactionally into HookRun through `github/review-result` and seals generation. Later generic turn/poster success/failure can add history/link but cannot overwrite published formal verdict. Only a `revision_event` without successful action settles "no verdict" at terminal report.
- Seal is repository-level CAS independent of coordinator's stale snapshot: `queued/in_progress` writes only when `sealedThrough < generation`; terminal write seals in same transaction. `setProjectionDesired(currentHookRunId)` locks/rereads durable HookRun and recomputes authoritative desired from event/verdict if formal review submitted, so stale generic terminal/nonterminal coordinator cannot even briefly overwrite it.
- HookRunReaper marks orphaned/failed, then same reporter converges external Check to `timed_out`/`failure`. A real late completion may replace orphaned desired for the same run, still under generation CAS.
- `details_url` points to `/<orgSlug>/sessions/<sessionId>` only when HookRun has `sessionId`; before that omit it, never fall back to agent page. Since GitHub hook is per-thread, PATCH that omits field preserves existing session deep link. If console URL/slug/session lookup unavailable, omit link without blocking projection.
- CP/worker crash, GitHub 5xx/429, and expired token use durable lease/retry without affecting agent turn.

An explicit review generation on the same `reportSha` creates a fresh Check Run after a terminal result, first sets it `queued`, then updates that run while the agent works. GitHub keeps a completed Check Run terminal: PATCHing it with `queued`/`in_progress` can update output while its top-level status, conclusion, and icon remain completed. The projection therefore detaches its previous `checkRunId` when a new HookRun owns the generation after a terminal observed state. If a newer request supersedes an incomplete generation, it keeps updating that active Check rather than abandoning a forever-incomplete run; a pending tombstone cleanup also retains the old ID so it can make that existing Check non-passing. The earlier terminal run remains historical, and marker recovery still distinguishes attempts by each generation's unique write marker even though they share `external_id=projection.id`. This rerun is **informational-only**. In required mode, if previous remote state may be success, a newly created queued Check does not prove GitHub atomically retracted the earlier result before webhook delivery and could fail open. R2b may remove global 409 only when every supported lifecycle event produces a fresh test-merge reportSha or a live GitHub test proves the event atomically makes the required context non-passing before webhook delivery. R3 status has no update ID; each generation targets pending + terminal and is not R2a behavior.

Generation CAS cannot retract an in-flight HTTP request, so external effects use durable mutex. While `writePhase + writeMarker` exists, no new worker writes even after lease expiry; takeover performs GET/list reconciliation first. New revision/rerun writes `pendingIntent` rather than switching generation. Each request carries readable marker (`details_url`/`target_url` + normalized output). Only after observing marker **and its original state** remotely may worker clear mutex, fold pending intent, increment generation, and send next. Never blindly retry uncertain Check create/PATCH. If unreconcilable, fail closed as `blocked(ambiguous_write)` and block later generations. This prevents stale request from turning green after new queued/failure. Required acceptance must also test irreducible GitHub event-delay window before webhook arrival.

Generation CAS/natural-key unique alone are insufficient. Projection create/upsert takes hook lifecycle and agent/repository locks, then epoch-qualified natural-key advisory lock, then `SELECT … FOR UPDATE` for existing row. Worker begin/complete/retry/block and tombstone cleanup share row lock. Only two legal interleavings:

- begin wins: old generation `writeMarker` durable; new revision/cleanup writes `pendingIntent`. complete/reconcile sees pending under lock, preserves cleanup `nextAttemptAt`, then advances generation and publishes cleanup;
- lifecycle/tombstone wins: bump `projectionEpoch` or generation and clear old lease; stale begin CAS fails and sends no old success. Tombstone candidate rereads under row lock instead of stale scan `writePhase`; delayed upsert sees tombstone and returns receipt without reviving passing desired.

After ambiguous create/update finds marker, decode `observedState` from that remote Check's output/status, never substitute current local `desiredState`. Advance pending generation only from **current persisted** `pendingIntent` after row lock; stale neutral caller snapshot cannot overwrite concurrent failure. Every HookRun result/report/reaper/coordinator projection write has `tombstonedAt IS NULL` CAS. On tombstone, worker may only reconcile existing marker or publish cleanup failure (`action_required` for association failure), never use cleanup-only token to create success/queued/in_progress.

HookDef/Agent delete must not cascade-delete projection/outbox. R2a lifecycle route first tombstones affected informational projections with full repository/installation snapshot and desired explicit `failure`, then deletes owner. Do not use GitHub `neutral`, which is passing, as non-passing cleanup. After owner disappears, worker still performs cleanup-only live resolution using durable `orgId + repoId`. If R2b makes context required, operator must remove/replace branch rule; local deletion cannot edit GitHub protection and cleanup failure cannot be silent.

Organization delete cannot use raw Prisma cascade. First DELETE, under organization-exclusive/agent/hook/HookRun/projection lock order, disables current hooks, writes one-way `failure` tombstones, retains Org + GithubInstallation for cleanup-only mint, and returns 409 asking retry. Only when every potentially external Check observes `failure` (or same-generation association `action_required`) with no marker/pending/lease/retry does second DELETE remove projection/HookRun metadata and Org in one transaction. Rows with no check ID/marker/observed/write phase provably never went out and may settle locally. Agent/Hook/projection producers take shared organization advisory lock; DELETE takes exclusive, preventing ownerless projections after final delete. In-transaction daemon recheck closes route-preflight TOCTOU.

Additional repository revoke is stricter: grant delete and `tombstoneReviewProjectionsForAgentRepo` share transaction + `(agentId,repoId)` lock. Hook-binding mutation uses hook lifecycle lock; projection upsert participates in both domains. Thus cleanup and authority removal are one commit with no window for "grant deleted but passing projection missed" or "phantom created after cleanup."

Check `output.summary` includes only normalized phase, agent name, revision, verdict, associated PR numbers, publication links, and association error. Link the live Agent name to console Agent detail. For the Check's current HookRun, link its matching PR number to the submitted formal review or, when formal submission did not own the response, the fallback issue/review comment; other associated PR numbers retain their normal PR link. The session link remains `details_url`. After Agent deletion, retain plain name without dead link. Never include poster final, inline bodies, daemon raw exception `reason`, or internal hook/projection IDs. Body remains daemon↔GitHub.

Checks/status permissions stay CP-local: no expanded `GitCredCapability`, no `checks`/`statuses` on daemon WebSocket or agent token. CP token service gets internal purpose/permission type and independent cache key. On 401/403, installation sync/doorbell permission changes, invalidate before retry. The reporter resolves the live installation from projection `orgId + repoFullName/repoId`, refreshes `lastResolvedInstallationId`, never treats the last-known ID as permanent, and never reuses a renamed/transferred name when repoId mismatches.

R2a terminal informational writes implement a **live commit→PR association barrier**, not only local subject history. Checks purpose token requires CP-local `checks:write + pull_requests:read`. Before any terminal POST/PATCH marker for each generation, reporter fully paginates `GET /repos/{owner}/{repo}/commits/{headSha}/pulls` until short page. Page-limit overflow, page failure, or incomplete schema becomes `pr_association_incomplete`; partial result is never authoritative.

Full result generation-CAS updates `HookReviewSubject`: upsert current open PRs, mark disappeared subjects closed, and write `subjectSyncGeneration/subjectSyncErrorCode`. Association sync and `beginProjectionWrite` share marker-empty CAS/row lock, forcing "freeze subjects for this generation, then external write." Any condition below publishes normalized non-passing `action_required`, retains canonical desired plus error, and never original success/neutral:

- no current open PR: `no_current_pull_request`;
- open PR exists but none still has projection `headSha`: `stale_head`;
- same head belongs to multiple current open PRs: `shared_head_multiple_prs`;
- incomplete read/pagination: `pr_association_incomplete`.

Association settles once per generation. A permission doorbell or normal retry cannot secretly revalidate and turn it green; recovery needs a new revision/generation review. Informational `reportSha=headSha`, and association always queries `headSha`, not a future R2b PR-specific test-merge `reportSha`.

### 5. R2b Future: Required Context Aggregates `(hookId, revision)` Verdict

Required context must be immutable and unique within repository. Informational uses a **different name** so it can never neutral→success a context still pinned by operator:

```text
Required Checks:        agentconnect/review/<hookId>
Informational Checks:   AgentConnect PR Review: <agent-name>
Required status:        agentconnect/status/<hookId>
Informational status:   agentconnect/info/status/<hookId>
```

R2a informational names use a fixed human-readable prefix plus the immutable agent slug; console does not manage them as required, and operators must not pin them manually in branch protection. Correlation uses `external_id + write marker`, keeping internal hook IDs out of final `name`/`output`. The agent qualifier keeps parallel review hooks on one SHA visible as independent Checks. Required context remains unique/immutable and pins expected source to AgentConnect App. required→informational/off, disable, HookDef/Agent delete first tombstone + queue non-passing cleanup for current required context, then informational uses its own name; console warns operator to remove branch rule. Transport/gate switches change context and never implicitly reuse.

Revision includes at least `{headSha, baseSha, reportSha}`. R2a informational may attach to `headSha`; R2b required **cannot** pretend a local base generation distinguishes revisions on the same head. Required `reportSha` must change when head or review-relevant base changes. Initial candidate: same-repository PR GitHub test-merge `mergeCommitSha`; each GET pull confirms it corresponds to current head/base, Check attaches to it, and live branch-protection acceptance proves GitHub counts it for this PR. Missing SHA, merge conflict, GitHub rejection, or race-test failure keeps `gateMode=required` at 409; never fall back to head.

Operator still confirms strict "branch up to date." Advancing base tip sends no per-PR `pull_request` delivery; strict protection blocks stale head, and update branch creates a `synchronize` new head/test-merge review. A target retarget produces `pull_request:edited` with signed `changes.base` and now opens an informational revision generation, but required remains unavailable until `reportSha` distinguishes that same-head base revision. Merge queue later uses `merge_group` synthetic SHA as `reportSha`. Until real repository E2E passes, all remain informational.

Only one **external current generation** per `(hookId, repoId, reportSha)`; subject rows hold each PR base/review revision:

- Event contract: `issues:reopened|closed` and `pull_request:reopened|closed` are silent—no agent turn or comment. Issue/PR title and body edits are silent. PR `synchronize` means head changed via push/force-push/rebase; PR `edited` with signed `changes.base` means the target changed. Both start a new revision review; draft/ready transitions are metadata-only and do not start a generation. Draft state does not change formal review eligibility; never edit/append old output.
- Opened and revision-changing deliveries establish/increment queued generation. A draft PR may pass through the same formal review path as a ready PR; conversion between draft and ready does not seal or reopen a generation.
- Non-code label/comment turn success never touches required context. A successful structured review can update informational verdict, but same-SHA turn cannot reopen required context.
- Generation fence prevents late old completion from changing current check/status even if HookRun history updates.
- `external_id=projection.id` is recovery correlation, **not GitHub idempotency**. The create POST publishes the agent-qualified human label directly, and every later state PATCH repeats it. Qualifying the name prevents GitHub's latest-per-name filtering from collapsing two review agents on the same revision into one misleading status. An earlier revision created Checks under the legacy recovery name `agentconnect/info/review/<hookId>` and repaired the label in a second request, but **GitHub drops requested actions omitted from an update** — verified directly against a live `skipped` Check, where re-asserting `actions` through one PATCH restored the button without changing the conclusion, proving the conclusion never suppressed it. That forced the repair request to carry presentation, which turned a cosmetic fence-free write into a stateful one racing the next generation, and it ran after `completeProjectionWrite` had already released the lease it would have needed to re-fence. Naming the Check correctly in the create removes the second request and the whole class of problem: a projection whose first write is already terminal never needs another, so nothing can strip the buttons it published. Ambiguous create lists runs by report SHA + App with pagination, matching `external_id + write marker`; it queries the display name first and the legacy name second, so a POST left in flight by the earlier binary stays recoverable. The residual exposure is a rollback that recovers a create made under the new name; the older binary searches the legacy name alone and may create a duplicate informational Check. Recovery itself writes nothing beyond settling the projection — it knows only what GitHub observed and must not invent presentation. R2a does not bulk-rename historical settled Checks.

Live commit→PR association above is **implemented R2a**, not R2b work. R2b still needs required/test-merge acceptance: required test-merge `reportSha` is allowed per PR only after live tests prove it belongs solely to current pullNumber and branch protection counts it. If two PRs receive same reportSha or association is nonunique, every affected required projection must be non-passing. Do not force distinct PR-specific test-merge SHAs through R2a head-based association merging.

Conclusion mapping:

| Local fact                                          | Check conclusion  | Commit status |
| --------------------------------------------------- | ----------------- | ------------- |
| Review verdict `pass`                               | `success`         | `success`     |
| Review verdict `fail` / request changes             | `action_required` | `failure`     |
| Review verdict `neutral` (informational only)       | `neutral`         | `success`     |
| Agent turn/runtime failure, no formal review result | `skipped`         | `success`     |
| Agent unavailable before dispatch                   | `skipped`         | `success`     |
| Turn interrupted by an agent handover               | `skipped`         | `success`     |
| GitHub review effect failed or uncertain            | `failure`         | `error`       |
| Required generation ended normally without verdict  | `action_required` | `failure`     |
| Reaper timeout                                      | `timed_out`       | `error`       |

Informational generation without verdict may use `neutral`; required generation never becomes `success` merely because model finished. `COMMENT + neutral` in required maps to `action_required`/`failure` and cannot open merge gate.

An ordinary, unmentioned PR conversation with `review_action_only` is not a new review generation. With no formal result or only `COMMENT + neutral`, current revision projection remains unchanged; later Q&A cannot wash existing `action_required` or `success` into neutral. An explicit Agent/App mention on an integration that enables formal reviews is a human review request: it opens a generation on the same SHA and enters `in_progress` at `hook/start`. With review policy `off`, the same mention is a non-review activation: it cannot publish a formal review and does not choose a different reply/output path. Inheritance occurs only within the same `reportSha` projection and never carries old-SHA approval to a new SHA.

Analysis-in-progress is not a conclusion. Check stays `status=in_progress` without `conclusion`/`completed_at` and displays `Analyzing this revision`. Only terminal review result updates to `completed`; neutral never means ongoing.

Use `skipped` for agent turn/runtime failure without formal verdict and relay-confirmed unavailable agent before dispatch (internally retain `daemon_offline`). The corresponding `HookRun.status` remains `failed` for history/observability. GitHub sees nonblocking skipped. Ordinary failure title may be `Review could not be completed`; unavailable title is `Agent unavailable`, hiding topology. Submitted formal verdict takes precedence over runtime terminal. Review-write failure/uncertainty remains `failure`; reaper timeout remains `timed_out`, never disguised as skip. Every active Check completed in a terminal state carries a `Request review` action; tombstoned cleanup Checks do not advertise an action they can no longer execute.

An admitted turn the daemon itself ended because it stopped serving the agent reports the normalized `agent_handover` instead of the interrupt vocabulary a user `!stop` produces (`packages/protocol/src/frames/hook.ts`). That is the duty teardown specifically — a revoke, a self-fence on an unrenewed lease, or a registry change that leaves the agent in no held group — not every way a turn can be cut short: a graceful shutdown interrupts the same way but deliberately reports nothing, retaining the row for the SAME daemon's restart replay, and a drain cancels through its own paths and keeps their reasons. That retention stops where the identity does — a duty-governed member releases its duties as it drains, and a handed-off hook row reports even mid-drain, because only the accepted `dispatchDaemonId` could ever re-run it. A verdict already submitted still takes precedence as above; without one this is the same nonblocking `skipped`, but it is not a runtime failure and must not borrow that title. Nothing about the revision was judged, so the title is the call to action `Comment @<app-slug> to retry the interrupted review` (falling back to `Review was interrupted before it finished`) and the summary adds a `How to run this review again` section pointing at the always-present `Request review` action. Recovery is that maintainer action, not an automatic re-fire: the run crossed `hook/start`, so it is outside the delivery-stage retry set, and its own durable delivery receipt makes a same-GUID redelivery a no-op at the daemon.

Automatic lifecycle for externally authored PRs uses the special delivery stage
`review_request_required`: it does not dispatch to the daemon and creates only a
`skipped` informational Check carrying a `Request review` requested action. Because
GitHub renders only `output.title` in the Conversation tab's Check list — its overflow
menu is fixed and the requested action renders on the Checks tab alone — the title is
the call to action `Comment @<app-slug> to start the review`, falling back to
`Review requires a maintainer request` when no App slug is configured. The summary adds
a `How to start this review` section naming the comment, Check action, and workflow-approval entry points plus the role
requirement, before the write marker. This HookRun failure is a durable control anchor
meaning "no agent turn was attempted," not a runtime failure. The relay remains
stateless and uses the ordinary fire-and-forget `rc/run-report`. When no HookRun
exists, GitHub delivery reconciliation redelivers. When only some hooks have durable
rows, the CP durably claims a one-time retry of the entire delivery only if all
existing siblings are no-agent-effect `review_request_required`. For every PR lifecycle
event, relay asks CP for the PR author's current repository role before
dispatching; webhook `author_association` is descriptive only and never authorizes the
trigger. A trigger-authorized role is `admin`, `write`, or `triage` — GitHub's legacy
`permission` field already collapses `maintain` into `write`, while `triage` appears only in
`role_name`, and it is the role GitHub gives a trusted non-committer to manage Issues and pull
requests. Repository authorization for binding a repository to an Agent is a separate, stricter
gate and stays at write/admin. The request is body-free and carries every matching hook's config/dispatch
fence, so CP validates the complete durable fan-out around one GitHub permission
lookup. Denial, incomplete metadata, rate limiting, or lookup failure fails the
complete fan-out closed into the external-author path; one delivery cannot mix the two
identity conclusions. A fan-out containing anything already executed or any other
failure fails closed. Activating the button or approving a pull-request workflow starts
a new queued generation; the button actor or workflow triggering actor must still pass
a live repository-role check.

### 6. Informational Rerequest and Future R2b/R2c Boundaries

- **Informational Check request/rerequest is implemented.** After verifying signatures, relay handles `check_run.rerequested`, `check_suite.rerequested`, and `check_run.requested_action` identifier `request_review`. A run request sends only `{checkRunId, repoId, headSha, deliveryKey}` metadata to CP; a suite request sends the signed App, installation, repository, and revision identities. CP either reverse-resolves the opaque Check Run or infers that App installation's existing suite projections for the revision, verifies every current `check + informational` hook/run, and returns metadata-only dispatch targets. Suite fan-out shares one live role authorization and fails closed if any returned rule fence changed. A requested action explicitly requests the base SHA persisted on the current HookRun. During rolling upgrade, old run `rerequested` derives base SHA from signed same-repository PR association. Relay dispatches a new delivery-key review generation that creates a fresh Check Run for each target and updates that run through completion. These paths bypass ordinary subscription cadence, and existing daemon/HookRun dedup absorbs the same GitHub delivery GUID per hook.
  - Reverse lookup consumes installation/repository-scoped authz budget before CP; unknown Check IDs cannot create unbounded DB lookup. A requested action does not depend on `check_run.pull_requests`, legitimately empty for fork heads; opaque Check reverse lookup is authority.
  - **Workflow approval is also implemented.** Relay handles only signed `workflow_run:in_progress` for `event=pull_request`, sends `{installationId, repoId, headSha, pullNumber?, deliveryKey}` to CP, and receives the latest still-waiting `review_request_required` run for each current hook and PR. It preserves a unique signed `workflow_run.pull_requests` association when GitHub supplies one, while fork runs may leave that list empty. It authorizes `workflow_run.triggering_actor`, never the bot sender, against its live repository role. Review-only hooks are eligible even without a Check. Without a trusted PR number, multiple candidates for one hook or candidates that disagree on the PR fail closed instead of guessing which PR owns the workflow. The dispatch key is stable per repository/pull/head, so simultaneous workflows and webhook redelivery converge on one HookRun/daemon message per hook.
  - Native GitHub `pull_request.review_requested` needs no Check reverse lookup: only if requested reviewer exactly equals current App `<app-slug>[bot]`, sender holds a trigger-authorized role, and hook covers PR family does it bypass cadence/mention/label as explicit request. **This path is not reachable from the reviewer picker.** GitHub resolves reviewers to users and teams only; the REST review-request endpoint takes `reviewers` (user logins) and `team_reviewers`, and an `<app-slug>[bot]` login fails to resolve. Only GraphQL `requestReviews.botIds` produces the event, and no first-party UI emits it, so treat this branch as a correct-but-rare authorization path rather than a user-facing entry point. First-party GitHub reviewers appear in that picker through a capability GitHub does not expose to third-party Apps. Requesting a placeholder team as a re-review handle would surface `requested_team`, which this design does not match today. App identity is repository-wide, so native request/`@<app-slug>` fans out matching hooks; Check action targets one hook by Check ID.
  - This explicit control action is unavailable while CP is down but does not change CP-offline semantics of ordinary hooks. Required rerequest needs proof that GitHub atomically makes required Check non-passing before webhook delivery. Until proven, rerequest is informational only; required UI must require new revision/reportSha so old success cannot remain.
- **Fork PR:** The base-repository commit→PR endpoint can return no association for a fork head, so the informational reporter falls back to a complete paginated scan of the base repository's open PRs and matches exact `head.sha`. The Check request action likewise does not trust fork-empty `check_run.pull_requests`. These paths support informational review, but whether a base-repository Check on a fork head satisfies protection still requires real acceptance testing and remains not required-compatible.
- **Merge queue:** required Check must handle `merge_group:checks_requested` synthetic SHA and App permission. Until R2b implements it, repositories using merge queue cannot configure AgentConnect context as required.
- **Filtered hooks:** mention/label filters or incomplete revision-event coverage can leave the newest revision without context; always informational.
- **Commit-status limit:** GitHub stores at most 1000 statuses per SHA/context. R3 reporter marks projection terminal `blocked(status_limit)` on validation error. Required cannot fake success or switch context automatically; wait for new report SHA, switch to Checks, or operator changes protection. Test error and boundary.

### 7. Explain GitHub App Identity Boundary in UI

Installation-token reviews are authored by one deployment-level App bot, not agent display name:

- Multiple AgentConnect agents cannot produce distinct reviewer identities; conflicting reviews share bot actor.
- App bot cannot approve its own PR. If last push is also by bot, it cannot satisfy "last push must be approved by someone else." No CODEOWNERS promise.
- Relay rejects bot comments/review-comments and unrelated bot events, so formal-review events cannot loop. Revision-bearing PR events authored by the configured App are the lifecycle exception: same-repository revisions are the internal CI lane and may start review without human-author authorization; fork revisions still require the maintainer workflow-approval path.
- On hook creation, PR review menu is collapsed by default and defaults to `Details` (`full` + informational Check). `None` maps to review/reporting `off` without changing trigger or output routing, while `Brief` permits only a formal `COMMENT` review and no Check. Expanded Details shows four side-by-side capability checkboxes projected from config: Inline comments → Request changes → Approve hierarchy, plus independent Status check.
- Put public-repo/untrusted-input, self-review, and CODEOWNERS limits in capability hover text rather than permanent warning stack. After repository selection, show repository-access blocker immediately in red with authorization entry; App-installation permission blocker shows settings link. Scratch may authorize any covered repository; manual GitHub workspace may explicitly authorize only its own workspace repository. Show nothing before repository selection.

## Per-Installation Permissions and Rollout

R2a requires App registration/installation `checks:write` and `pull_requests:read|write` for terminal commit→PR association. R1 formal review requires `pull_requests:write`. Add `statuses:write` only when starting R3. Every installation owner separately approves new permission; unapproved installations retain R1/poster while reporting alone is blocked.

`GithubInstallation.permissions Json` exists; unknown `{}` fails closed. Setup callback, Sync, and installation doorbell pull (including `new_permissions_accepted`) replace local facts with installation-effective permissions returned by GitHub. Selected repository/projection remains and dynamically refreshes provenance; console displays exact `checksPermission`. With `checks:write`, GitHub App automatically receives `check_run` and `check_suite` rerequests plus `check_run.requested_action`; relay handles only rerequested and `request_review`, returning 202 no-op for other actions. The App manifest also subscribes to `workflow_run`; existing Apps must add that webhook event, and Setup diagnostics report it when missing. Existing `actions:write` includes the read access needed for workflow-run metadata.

Installation-claim conflict update preserves original `orgId`; Sync refreshes only durable claims already belonging to its organization and cannot discover or move reporter authority.

After callback/Sync/doorbell writes permission/revoke/suspend, all pass through one convergence hook: `InstallationTokenService.invalidateInstallation(iid)` → immediately wake installation's `blocked(permission)`/nonterminal projections → recompile organization hooks. Per-installation invalidation exists; never merely update DB and wait for normal retry.

GitHub-write 401/403/422 first invalidates token, refreshes exact facts, and performs one persisted retry. Only repeated nonretryable denial converges normalized blocked; never swallow as warning. Hook turn/poster continue; console shows installation-owner approval link/instructions.

## Component Changes

**protocol / relay**

- `RcHookAssign.github` carries three config snapshots + durable `configRevision` + CP-owned `dispatchRevision`.
- GitHub envelope adds `subjectKind/headSha/baseSha/headRepoFullName/mergeCommitSha/isDraft/explicitReviewRequest`.
- `RcRunReport` and `HookReport` carry PR/report snapshot. Add metadata-only request/ack `hook/start`, `github/review-authorize|authorized`, and `github/review-result|ok`. CP derives `revision_event|review_action_only|none` `projectionIntent`; missing rolling fields fail closed.
- `hook/report` is correlated REQ; success REP reuses generic `ack{ok:true}`. CP ACKs only after durable HookRun + projection convergence. `register/ok.serverFeatures` negotiates `hook-report-ack-v1` for daemon/CP rolling upgrade.
- Relay distinguishes issue vs PR comment from payload. Check request/rerequest and workflow approval use separate metadata-only CP resolution + current-rule fences; App reviewer request uses an explicit write-permission gate. None depends on ordinary subscription cadence.

**daemon**

- Attach `submitGithubReview` descriptor statically to session MCP tools; maintain `activeGithubTurnMeta`; authorize only current PR-hook action time. Target is never model input; descriptor visibility cannot bypass active-turn/CP fail-closed gate.
- Review client uses dedicated daemon→CP REQ/REP action-time token only; no gitcred.sock/getPostToken/gh wrapper/env fallback. Recheck head/base, batch inline review, recover correlation.
- Keep existing `{ poster, collector }` in `Pending.github` and also record review result; do not lose `GithubReplyCollector`.
- Durable QueueEntry inbox adds local-only trusted `HookDispatchContext` (delivery, policy, revision, reply/report target). Restart replay reenters hook-aware dispatch and restores active metadata/start/completion; formal review uses hidden marker recovery. Only the accepted `dispatchDaemonId` may reenter: any other member (including a pool member whose restart minted a new Pod-bound id) reports a handover for that row instead of re-prompting a turn whose review authority it can never obtain. Poster keeps the single-attempt contract with `posterPublishState=not_started|in_flight|settled`; after crash, in_flight is unknown and never automatically POST-replayed. Fallback POST is allowed only when no formal attempt exists or the same-ID result for the current/latest attempt is `not_submitted`; submitted/ambiguous/no result/stale mismatch/other unresolved never calls poster and durably settles. A legacy inbox row without context fails/tombstones and relies on the CP reaper; it never silently reruns as a generic turn.
- Relay `rd/ack accepted` is **ACK-after-durable**: return accepted only after anchoring and SQLite persistence of admitted QueueEntry + trusted hook context. Durability failure returns rejected.
- Before execution, persist local `turnStartedAt`, then send acknowledged `hook/start`. Immediately after review effect send `github/review-result`; completion repeats same review enum/ID/commit metadata for loss recovery.
- Completion redacts inbox row into terminal-report outbox first. Unacked body never capacity-evicts; READY/reconnect and temporary-failure backoff resend. ACK clears body but retains stable-ID receipt; only acked receipts have 10k bounded GC.
- Prompt says ordinary fallback belongs only to poster; formal review only via `submitGithubReview`; review body complete/nonempty; review-generation guidance requires a non-`off` review-policy snapshot and names only verdict events allowed by that exact policy; after attempt starts, only same current attempt explicit `not_submitted` preserves ordinary fallback; submitted/ambiguous/unresolved do not post; direct mutation forbidden.

**control-plane**

- Wire HookDef fields through schema/SQL backfill, ports/repo, DTO/create/update, compile/broadcast. Increment `configRevision` atomically on config mutation and `dispatchRevision` on config/placement. PUT fields optional with stored fallback so old clients do not reset policy.
- Increment `projectionEpoch` for enablement, agent/repository binding, reporting/gate lifecycle. Snapshot in HookRun/projection; unique key includes epoch. Locks serialize configuration mutation, create, marker, pending, tombstone. Repo-auth revoke + cleanup commit in one transaction.
- `resolveAgentRepoAuthorization(agent, repoId, repoFullName)` returns trusted repoId, live installation, and capability levels. gitcred still uses current placement. Review RPC checks the persisted HookRun dispatch fence plus current placement/revision and semantic event cap + PR write before the token service. Numeric repoId recognizes a renamed workspace and prevents the additional-name fast path.
- After formal-review mint, reread reservation/current hook/agent, numeric grant, exact installation permission, compare installation ID, then final exposure check. Current hook `projectionEpoch` and `dispatchRevision` must equal accepted HookRun, so disable→enable, repo/agent A→B→A, daemon A→B→A cannot restore old authority. Per-installation epoch invalidation prevents stale inflight mint from cache/serve.
- Grant creation, hook create/edit, mint fast/slow paths, and policy validation are repository-ID-first. Repair duplicate `AgentRepoAuthorization.repoId == workspace repoId`, preserving the workspace `gitAccess` ceiling. Removing a redundant grant row does not queue revoke cleanup. Legacy workspace hook create/edit resolves numeric ID from the stored endpoint before stale-name fallback.
- HookRun stores configuration/PR/review/dispatch snapshot + `projectionIntent`. `HookReviewProjection` implements unique current generation, lease/retry/CAS, and delete tombstone.
- HookDef delete, Agent delete/cascade, disable, gate/report downgrade go through projection lifecycle: save target tombstone, queue canonical non-passing `failure`, then change/delete owner. Organization delete uses 409→retry two-phase barrier retaining installation authority; routes must not bypass with Prisma cascade.
- `GithubRunReporter` supplies durable retry, ambiguous-create recovery, generation fence, periodic HookRun repair, reaper convergence, terminal live commit→PR full pagination/subject sync, normalized association blocking, and monotonic transitions.
- Repository authorization create/delete/tier and workspace gitAccess mutation find affected hooks/projections. Revocation is not blocked; live resolver rejects next review immediately and projections converge canonical non-passing cleanup. Installation claim cannot move across organizations.
- Persist exact installation permissions; Checks tokens stay CP-local; token service has per-installation invalidation; doorbell/sync/callback wake blocked projections. No status token before R3.

**web**

- AddIntegration repository picker and edit surface configure review policy and `off|check`; gate fixed informational. Do not crowd dense desktop repository row with pills; use settings popover and mobile bottom sheet.
- Picker retains numeric repo ID and installation-permission provenance, computes effective access ID-first (name legacy fallback), enables Check only with exact `checksPermission=write` + `pullRequestsPermission=read|write`.
- With `reviewPolicy != off`, reuse the repository authorization modal: additional comment only `comment`; request_changes/full require workspace/additional write; reporting always write. Read/unauthorized shows a blocker plus authorization entry. Scratch explicit grants use the additional tier.
- Explain App bot identity, `full` warning, permission blocking, informational Check. R2a exposes no required selector/acknowledgement; R2b/R2c adds stable required context, strict/no-merge-queue acknowledgement, fork/merge-queue constraints.
- Whole-definition PUT preserves new fields; keep desktop/mobile trees synchronized.

## Phases

| Phase   | Implementation state | Scope                                                                                                                                                   | Delivery gate                                                                                                                                                                                               |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1**  | Implemented          | Safe schema backfill + active-turn metadata + `submitGithubReview` + prompt/single-writer contract + UI                                                 | Workspace/additional write supports all events; additional comment including scratch/cross-owner supports COMMENT only; read/unauthorized rejects; policy/head race/self-review errors visible              |
| **R2a** | Implemented          | Per-install permissions + epoch-qualified projection/lifecycle locks + live commit→PR association + correlated report ACK outbox + informational Checks | After daemon/CP crash, ambiguous POST, redelivery, config/repo-auth race, and same-revision disorder, only correct current projection remains; unacked terminal report retained; bodies never cross CP      |
| **R2b** | Not implemented      | Required eligibility + test-merge reportSha + operator assumption audit + same-repo/strict-protection acceptance                                        | Live GitHub tests prove test-merge Check counted, same-SHA lifecycle coexists with head-only CI, ordinary comment/old-base turn cannot green required context, no-verdict/timeout blocks, App source pinned |
| **R2c** | Not implemented      | Required-safe fork and merge-group support if acceptance spike proves feasible                                                                          | Real-repository E2E for external fork and merge-queue synthetic SHA; otherwise required mode remains explicitly unsupported                                                                                 |
| **R3**  | Not implemented      | Alternative `status` mode + statuses permission rollout                                                                                                 | Legacy protection works with separate stable status context; no same-name/double-send with Check                                                                                                            |

Boundary again: **R2a has no required gate, required-safe rerequest, required-safe fork/merge-group support, or commit-status transport**. They belong to R2b, R2c, and R3. Informational external-fork review does not imply those capabilities are enabled.

## Validation Matrix

The following defines regression/acceptance coverage; it does not claim every CI or live GitHub E2E has passed. R2b/R2c/R3 items are future gates.

- **Review action:** policy ladder; inactive turn; lower old/new policy; COMMENT/REQUEST_CHANGES body; multiline coordinates/422; head changes during analysis; closed/merged; draft approval; turn-local + durable HookRun attempt CAS against concurrent/restart double-submit; identical attempt requires identical event/verdict; string review ID + paginated marker ambiguous recovery; custom `GH_TOKEN` does not change broker actor; CP outage fails action closed; body absent from CP; dedicated RPC inaccessible through gitcred.sock/gh wrapper and no env-token fallback; workspace/additional write all events, additional comment only COMMENT, workspace/additional read/scratch without grant/grandfathered unauthorized reject; next action rejects after grant deletion while poster cached-token window tested separately; post-mint revalidation rejects revoke/rebind/permission/installation changes; installation epoch invalidation blocks stale mint serve/cache; lost `github/review-result` request/ack converges from terminal completion; same-value lifecycle/placement ABA rejected because HookRun epoch/revision differs.
- **Identity/live GitHub:** whether App review counts for classic protection/ruleset; self-review by same App; two-agent conflicts; last-push approval; bot veto on App/Dependabot PR; CODEOWNERS facts.
- **Protocol/relay:** PR vs issue `issue_comment`; authority for head/base/report SHA; reopened/closed and title/body edits silent; `synchronize` and signed base-changing `edited` as new revisions; rolling fail-closed configRevision/dispatch fence; reject stale relay accepted tuple; loss of either report leg; completion by accepted old dispatch after reassignment; no accepted `rd/ack` when durable inbox append fails; ACK `hook/report` only after CP convergence, retransmit after transient no-ACK, global inflight ≤100; old CP without ACK sends one legacy EVT per connection; rerequest signature gate, opaque Check reverse lookup, stale rule/unknown Check rejection, authz budget exhaustion, same-delivery dedup, CP-unavailable fail closed; workflow approval triggering-actor auth, review-only hook support, and same-head multi-workflow dedup.
- **Reporter:** queued→in_progress→completed; CP/daemon restart; reaper timeout; durable `turnStartedAt` + acknowledged start barrier; completion-first/delayed accepted/start monotonic CAS; periodic HookRun repair; 429/5xx/permission retry; crash after create before ID persist; `external_id` scan; unique projection generation/CAS; explicit rerun completed Check; old completion fence; terminal seal/nonterminal CAS; stale generic terminal cannot overwrite submitted formal verdict; `projectionEpoch` rebind; marker/upsert/tombstone row-lock races; terminal commit→PR full pagination, fork-head base-repository fallback, partial page, no-current/stale/shared-head block; hook-delete tombstone.
- **Permissions:** separate installation approval; `new_permissions_accepted` doorbell; sync/revoke/suspend; exact persisted `checksPermission`; token invalidation; picker provenance; uninstall→reinstall updates `lastResolvedInstallationId` while repoId stays; claim cannot move organizations.
- **Repository authorization:** read/unauthorized/comment cannot enable reporting; comment enables only COMMENT; write enables request changes/full/reporting. Delete/downgrade/gitAccess downgrade cannot be blocked by active hook, but grant delete + affected projection tombstone commit under shared agent/repository lock in one transaction, reject new review immediately, queue canonical non-passing cleanup, and no-row phantom cannot escape.
- **Rename authorization:** after workspace repository rename, numeric repoId still classifies workspace; read workspace cannot create additional comment grant under new canonical name; duplicate-grant repair never raises gitAccess; hook/policy/mint agree.
- **Future R2b required safety:** incomplete revision-event coverage; base advance; base retarget without a distinct trusted report SHA; strict-up-to-date assumption; label/mention filter; missing/unchanged test-merge SHA; multiple PR shared head; disable/delete; context mode switch; COMMENT+neutral/no verdict; distinct Check/status names; expected App source.
- **Lifecycle:** R2a covers durable informational tombstone/cleanup for disable/off, HookDef/Agent/Org delete, and repo-auth revoke. Future R2b/R3 verifies required→informational/off and transport switches never reuse context. Disable, HookDef delete, Agent cascade, two-phase Org delete, and repo-auth revoke retain target tombstone and queue failure cleanup; failures visible with operator branch-rule warning.
- **Daemon replay:** persisted HookDispatchContext; restart never degrades to generic turn; legacy inbox fail/tombstone; foreign accepted dispatch reports a handover instead of re-prompting, while a duty handoff reports its live hook row even mid-drain; marker recovery; poster not_started may publish, in_flight unknown never replayed, settled no duplicate; terminal `hook/report` unacked receipt never capacity-pruned and retries on READY/backoff; SQLite read/ACK-cleanup failure stays queued; stable-ID receipt bounded GC after ACK; accepted queued gate-drop has runLoop as sole durable terminal owner and still reports start/completion.
- **Future R2b/R2c acceptance:** whether same-repository test-merge SHA counts in branch protection, base tip/target races, rerequest, coexistence with at least one existing required CI reporting head SHA only, real external fork, merge queue `merge_group`. If test-merge precedence makes head-only context missing or any prerequisite fails, corresponding unsupported gate remains.
- **Web:** create/edit round-trip, preserve fields in old PUT, desktop popover/mobile bottom sheet, `full`/exact permission/informational-only warnings, no enabled required/status selector.

## Degradation Matrix

| Failure                                                   | Review / poster                                                                                                                                                                                                | R2a informational Check                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief CP outage                                           | Before formal attempt, poster cached token works until expiry. If attempt is recorded first but action-time reauth unavailable, unresolved fails closed and no fallback; agent turn/final transcript continues | Terminal metadata stays in daemon unacked outbox and retries on READY/backoff; existing HookRun/projection converges through periodic repair/reaper |
| Daemon crash                                              | Trusted HookDispatchContext replays; review marker recovery; no fallback if current attempt has no result or mismatches old result; unknown poster inflight never replays single POST                          | Redacted terminal receipt resends report after restart without rerunning model; CP projection/reaper converges queued/in-progress                   |
| Agent turn/runtime failure                                | No completed formal review; daemon preserves actionable error and session transcript                                                                                                                           | HookRun remains failed; informational Check ends `skipped` with session link                                                                        |
| Agent unavailable before dispatch                         | Relay sends no turn; internal placement/connection failure retained for operations                                                                                                                             | Periodic repair converges `skipped`, title only `Agent unavailable`; no auto-rerun                                                                  |
| Agent stops being served mid-turn                         | Admitted turn is interrupted as a handover and reports `agent_handover`; suppression stops the fallback comment, while a verdict already submitted keeps its own result                                        | `skipped` with the interrupted-review title and a `How to run this review again` summary, unless a submitted verdict already owns the projection    |
| GitHub pre-write failure / definitive 4xx (including 429) | Validation/marker/revision failure before POST, or explicit 4xx proving no review, becomes `not_submitted` and permits fallback; transcript retained                                                           | Durable retry; after policy window publish normalized failure without exception leak                                                                |
| GitHub review POST 5xx/timeout/disconnect                 | Uncertain outcome becomes `ambiguous` and forbids fallback, avoiding ordinary comment after possible review; transcript retained                                                                               | Durable retry + marker reconciliation; if unreconcilable publish normalized failure without exception leak                                          |
| Installation has not approved new permission              | R1 uses existing pull_requests permission; poster unaffected by new Checks permission                                                                                                                          | Exact `checksPermission` fails closed; console guides owner approval; turn unaffected                                                               |
| Head changes during turn                                  | Broker rejects old-revision review and asks retrigger/reread                                                                                                                                                   | Old-head generation cannot turn new head green                                                                                                      |
| PR association incomplete/conflicting                     | Formal review independently uses active-turn pull fence                                                                                                                                                        | Terminal Check publishes normalized non-passing association error; same generation never auto-greens                                                |

This implementation deliberately separates "agent analysis succeeded," "formal review verdict," and "informational Check" into different facts. R2b/R3 will further separate required verdict/status. Only then can review be a first-class GitHub participant without mistaking a successful chat turn for mergeable code.
