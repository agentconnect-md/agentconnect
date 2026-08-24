/**
 * Cross-package wire + lifecycle constants shared by the daemon and the CLI.
 *
 * These are pure data (no zod, no runtime deps) so both `@agentconnect.md/cli`
 * and `@agentconnect.md/daemon` can import them without pulling in each other:
 * the daemon dials the CP with the subprotocol/path, and the CLI's login probe
 * dials the same way; both the daemon (planned-exit code) and the CLI (run
 * respawn shell + generated service units) must agree on the restart exit code.
 */

/**
 * Cap on agent→agent hop depth (agent-collaboration §2.4/§4.5), shared by every
 * component that can admit an agent-to-agent edge.
 *
 * It lives here because send-message-routing-rework.md §4.1 requires ONE budget across
 * transports: "the same `MAX_AGENT_CALL_HOPS`, whether it is a same-daemon internal
 * call, a relayed internal call, a direct-daemon platform mention, or a relayed platform
 * mention". Three independent copies (daemon, relay agent-msg router, relay ingress)
 * could drift, and a relay that allowed one more hop than the daemon would let a relayed
 * chain outlive the budget an internal chain gets — a loop-safety hole that no single
 * package's tests would catch.
 *
 * The value is a runaway-loop backstop, not a conversation-length policy: a healthy
 * exchange terminates because the agents are done, and every extra hop only costs one
 * more turn. It was raised from 8 to 20 because 8 cut ordinary human-started relay games
 * short (a thread rooted in one human message affords exactly this many agent→agent
 * edges), while 20 is still far below anything a real collaboration needs and keeps a
 * genuine A↔B ping-pong bounded within seconds.
 */
export const MAX_AGENT_CALL_HOPS = 20

/**
 * Whether an agent-to-agent delivery has reached the exclusive hop boundary.
 *
 * A delivery at the boundary is not admitted: when the cap is 20, hop 19 is the
 * last agent turn that may run and its reply closes the autonomous exchange.
 * Keeping the comparison beside the shared constant prevents daemon and relay
 * admission paths from drifting on the boundary semantics.
 */
export function hasReachedAgentCallHopLimit(deliveryHopCount: number): boolean {
  return deliveryHopCount >= MAX_AGENT_CALL_HOPS
}

/** The daemon↔CP WebSocket subprotocol negotiated on `ClientTransport.dial`. */
export const CP_SUBPROTOCOL = 'agentconnect.v1'

/** The CP mount path the daemon↔CP WebSocket connects to. */
export const CP_WS_PATH = '/daemon/ws'

/** CP accepts metadata-only transcript activity invalidations from current daemons. */
export const SESSION_LIVE_TAIL_FEATURE = 'session-live-tail-v1'

/** Daemon resolves workspace list/read/git-status requests against the isolated
 * worktree named by `sessionId` instead of silently falling back to primary. */
export const WORKSPACE_SESSION_READ_FEATURE = 'workspace-session-read-v1'

/** Daemon resolves every workspace read/git frame against the secondary root named by `repo` —
 * the checkout under `<agentRoot>/repos/<owner>/<repo>`, or that root's per-session worktree. The
 * CP must check this before forwarding a `repo`-scoped request: an older daemon ignores the field
 * and would answer for the PRIMARY workspace, which is the wrong repository's files. */
export const WORKSPACE_REPO_SCOPE_FEATURE = 'workspace-repo-scope-v1'

/** Daemon serves the console's git review reads — `workspace/gitdiff`,
 * `workspace/gitlog`, and per-file `additions`/`deletions` on `workspace/gitstatus`.
 * The CP must check this before sending either new frame: an older daemon ignores
 * an unknown frame silently, so the REQ would burn its whole retransmit budget and
 * then surface as an offline daemon. */
export const WORKSPACE_GIT_REVIEW_FEATURE = 'workspace-git-review-v1'

/** Daemon serves the console's git WRITES — `workspace/gitstage`, `workspace/gitunstage`,
 * `workspace/gitcommit` and `workspace/gitpush`. Checked before sending, for the same reason
 * as the review feature: an older daemon ignores an unknown frame silently, so the REQ would
 * burn its retransmit budget and then read as an offline daemon. The console renders the write
 * controls as ABSENT (not inert) on a daemon without it. */
export const WORKSPACE_GIT_WRITE_FEATURE = 'workspace-git-write-v1'

/** Daemon serves `workspace/gitmessage` — the AI commit-message draft, run on the AGENT's own
 * runtime. Separate from the write feature on purpose: it is not a write, and the console hides one
 * button (the wand) on a daemon without it while keeping stage/commit/push. Checked before sending,
 * like every other new frame: an older daemon ignores it silently and the REQ would burn its
 * retransmit budget before reading as an offline daemon. */
export const WORKSPACE_GIT_MESSAGE_FEATURE = 'workspace-git-message-v1'

/** Daemon serves `task/list` — the console Tasks panel's read of one ACP session's background-task
 * lease. Checked before sending, like every other new frame: an older daemon ignores it silently, so
 * the REQ would burn its whole retransmit budget and then read as an offline daemon. The console
 * hides the Tasks tab on a daemon without it rather than showing a tab that can never answer. */
export const TASK_LIST_FEATURE = 'task-list-v1'

/** Daemon serves `automerge/set` + `automerge/state` — the PR panel's merge-when-ready watcher, run at
 * the edge because GitHub's own auto-merge refuses every pull request that is not BLOCKED. Checked
 * before sending, like every other new frame: an older daemon ignores it silently, so the REQ would
 * burn its retransmit budget and then read as an offline daemon. The console disables the box on a
 * daemon without it rather than offering a control that can never arm. */
export const AUTO_MERGE_FEATURE = 'auto-merge-v1'

/** Daemon serves `sandbox/keepalive` — an open console page holding a cluster agent's pod against the
 * idle sweep while its worktree is dirty or a merge-when-ready watcher is armed in it. Checked before
 * sending, like every other new frame: an older daemon ignores it silently, so the REQ would burn its
 * retransmit budget and then read as an offline daemon. A console that gets no answer simply stops
 * renewing — the sweep's own rules then apply, which is the pre-feature behaviour. */
export const SANDBOX_KEEP_ALIVE_FEATURE = 'sandbox-keep-alive-v1'

/** Daemon serves `runtime/commands` — the slash commands an agent's ACP runtime advertised it can be
 * asked to run. Checked before sending: an older daemon ignores an unknown frame silently, so the REQ
 * would burn its retransmit budget and then read as an offline daemon. */
export const RUNTIME_COMMANDS_FEATURE = 'runtime-commands-v1'

/** Daemon serves `agent/wake` — the console's "start this agent's sandbox" for a Files/Memory read.
 * Advertised only by a daemon that runs agents in cluster sandboxes: on any other daemon there is
 * nothing to wake, and the CP answers `unsupported` without sending a frame it would ignore. */
export const AGENT_WAKE_FEATURE = 'agent-wake-v1'

/** How long the CP must let ONE `workspace/gitmessage` REQ run before giving up, and it must send it
 * single-shot (`{ ackTimeoutMs: WORKSPACE_GIT_MESSAGE_BUDGET_MS, maxTries: 1 }`). The default 5s ack
 * timeout would retransmit an in-flight model pass four times: identical frame ids, so the daemon
 * joins them into one pass, but the CP would still fail the request while the answer was coming.
 * The daemon's own budget is strictly smaller, so the REP always wins this race. */
export const WORKSPACE_GIT_MESSAGE_BUDGET_MS = 75_000

/**
 * CP accepts the `event/session-purged` retention-GC receipt (#485) and marks the
 * session's stored metadata content-purged. Advertised by the CP in
 * `register/ok.serverFeatures`; a daemon that does not see it KEEPS its durable
 * receipts instead of emitting a frame an older CP would reject as
 * `UNKNOWN_FRAME` — the report is re-tried once the CP is upgraded.
 */
export const SESSION_PURGE_FEATURE = 'session-purge-v1'

/**
 * CP accepts the correlated `event/session-sync` metadata snapshot. Daemons
 * keep one latest-wins snapshot per session until the CP acknowledges the
 * persistence commit; older CPs continue receiving best-effort `event/session`
 * events while the durable snapshot remains queued for a later upgrade.
 */
export const SESSION_METADATA_ACK_FEATURE = 'session-metadata-ack-v1'

/**
 * Daemon understands the `session/visibility` gate pushes + register-time
 * snapshot replay (session-visibility.md §5.1). Advertised by the daemon in
 * `RegisterReq.capabilities.features`; the CP gates all visibility pushes on
 * it so older daemons never see the frames.
 */
export const SESSION_VISIBILITY_FEATURE = 'session-visibility-v1'

/** Daemon/runtime support private, session-scoped remote MCP headers and stable invocation ids. */
export const WEBCHAT_REMOTE_MCP_FEATURE = 'webchat_remote_mcp_v1'

/**
 * Daemon understands multi-agent webchat conversations: `mentions`/`post` on
 * webchat turns, the transcript-only `context` op, agent-attributed
 * ack/output/done, and `rd/webchat-post` reply fan-out
 * (webchat-multi-agents.md). The CP refuses to CREATE a conversation with more
 * than one agent unless every selected agent's daemon advertises this.
 */
export const WEBCHAT_MULTI_AGENT_FEATURE = 'webchat_multi_agent_v1'

/**
 * Cross-surface session continuation (webchat-cross-integration-continuation.md):
 * the daemon accepts `RdMsgWebchat.targetSessionId` and dispatches the browser
 * turn onto the target session's own local coordinates; a relay advertises the
 * same feature in `rc/register.features` when it preserves the field end to end.
 * The CP refuses to mint a session-targeted webchat token unless the owning
 * daemon AND every live relay advertise it (fail-closed rollout).
 */
export const WEBCHAT_SESSION_CONTINUATION_FEATURE = 'webchat_session_continuation_v1'

/** Daemon and Control Plane support Organization Knowledge, Dream suggestions,
 * and immutable managed-skill bundle retrieval. */
export const ORGANIZATION_KNOWLEDGE_FEATURE = 'organization-knowledge-v1'

/** Daemon currently admits staged Dream suggestion content reads and owner
 * review decisions. Omitted while the staged-content security hold is active. */
export const ORGANIZATION_SUGGESTION_REVIEW_FEATURE = 'organization-suggestion-review-v1'

/** Daemon understands externally-bound Slack session audiences, including the
 * `external` visibility value and the stricter shared-memory exclusion bit. */
export const SLACK_SESSION_AUDIENCE_FEATURE = 'slack-session-audience-v1'

/**
 * Daemon persists `AgentSpec.configRevision` and enforces the monotonic
 * comparison before applying a CP-owned snapshot
 * (organization-secrets-and-variables.md §7). Organization environment entries
 * rely on full-map replacement semantics, so a bound agent may only be placed on
 * a daemon that advertises this: without the fence, an older full snapshot that
 * completes late could reinstate a rotated or deleted value.
 */
export const AGENT_CONFIG_REVISION_FEATURE = 'agent-config-revision-v1'

/** Auth-only recovery capability that permits CP to queue an offline daemon upgrade. */
export const DAEMON_BOOTSTRAP_UPGRADE_FEATURE = 'daemon-bootstrap-upgrade-v1'

/** Frozen version of the auth-only bootstrap handshake. */
export const DAEMON_BOOTSTRAP_PROTOCOL_VERSION = 1

/**
 * Per-value ceiling for an environment variable or secret, shared by the agent
 * and organization surfaces so one entry can never be sized past what any
 * resolved `AgentSpec` could carry.
 *
 * 64 KiB is a quarter of `MAX_FRAME_BYTES`: generous for the real payloads
 * (a PEM block, a kubeconfig, a service-account JSON) while leaving room for the
 * rest of the spec. It is a per-VALUE guard only — the authoritative check is the
 * transaction-time admission budget over the whole resolved environment, which
 * the Control Plane applies per affected agent before persisting.
 */
export const MAX_ENVIRONMENT_VALUE_LENGTH = 64 * 1024

/**
 * Exit code a daemon uses for a PLANNED lifecycle exit (drain-then-exit on a
 * `daemon/restart` or `daemon/upgrade`, cli-daemon-split.md §6). It must be
 * non-zero: launchd's `KeepAlive.SuccessfulExit=false` only relaunches on a
 * non-zero exit, so exit 0 would leave the daemon down on macOS. Both
 * supervisors relaunch on it (systemd `Restart=always` covers any code). 75 is
 * EX_TEMPFAIL from sysexits(3) — "temporary failure, retry" — which reads
 * correctly for "the daemon asked to be brought back up".
 *
 * The CLI's `run` respawn shell (§6.1) also keys off this exact code to decide
 * whether to relaunch vs propagate the child's exit.
 */
export const RESERVED_RESTART_CODE = 75

/**
 * `AGENTCONNECT_SUPERVISOR` value a pool member runs under: Kubernetes, where the
 * kubelet takes the place of launchd/systemd AND of the CLI's version store.
 *
 * It supervises restart — `restartPolicy: Always` brings the container back after
 * {@link RESERVED_RESTART_CODE}, in place and in the same pod, which is the same
 * shape as a systemd process restart — but not upgrade: the running version is the
 * image, so only whoever owns the Deployment can change it.
 */
export const K8S_SUPERVISOR = 'k8s'

/**
 * Audience the projected ServiceAccount token an in-cluster daemon authenticates with is
 * restricted to. The shim handshake run one hop up: a sandbox proves itself to the daemon
 * with a token scoped to `SHIM_TOKEN_AUDIENCE`, and here the daemon proves itself to the
 * control plane the same way. The audiences differ, so neither token is accepted at the
 * other end.
 *
 * This and {@link CLOUD_DAEMON_SA_NAME} are the two names the deployment that stamps them and
 * the control plane that checks them must agree on exactly. They live here rather than
 * being configured on each side because a constant kept in two places eventually holds two
 * values: a rename passes every build and every test, since each side stays self-consistent,
 * and fails only at runtime when a real daemon's token is rejected. One definition makes that
 * a compile error instead.
 */
export const CP_TOKEN_AUDIENCE = 'ac-control-plane'

/**
 * ServiceAccount a pool member runs as, and the control plane's second check on a reviewed
 * token, so a later change cannot authenticate some other pod in the same namespace. A pool
 * member serves EVERY org, so it lives in the install's control namespace rather than in an
 * org namespace and no namespace⇒org mapping can name its org — the org is a per-connection
 * selector it declares in `auth`, which is safe precisely because this ServiceAccount is an
 * install-level principal. Shared for the same reason as {@link CP_TOKEN_AUDIENCE}.
 */
export const CLOUD_DAEMON_SA_NAME = 'ac-cloud-daemon'

/**
 * DEFAULT ServiceAccount name for the usage-report collector — the principal allowed to
 * post `gateway`-source session usage to the control plane's batch ingress. A default, not
 * a contract: the collector is not this codebase's pod, so the deployment that runs it
 * names it and tells the control plane through `USAGE_COLLECTOR_SERVICE_ACCOUNT`; this
 * value is what an unconfigured control plane expects. The name stays separate from
 * {@link CLOUD_DAEMON_SA_NAME} on purpose whatever it is set to: both tokens carry
 * {@link CP_TOKEN_AUDIENCE}, so the ServiceAccount is what keeps a daemon's token from
 * writing usage and a collector's token from claiming a daemon identity.
 */
export const USAGE_COLLECTOR_SA_NAME = 'ac-usage-collector'

/**
 * ServiceAccount the org-usage READER runs as — the principal allowed to read an org's
 * usage aggregate without a human's session visibility, so a settlement job can total a
 * closed period. A third name beside {@link USAGE_COLLECTOR_SA_NAME} because the two
 * capabilities are not the same risk: the collector's token can create spend records,
 * this one can only disclose them, and no workload should hold both by accident. They
 * are separate pods, so they are separate ServiceAccounts; if they ever merge, that is a
 * deliberate deployment decision and not something a shared constant did quietly.
 */
export const USAGE_READER_SA_NAME = 'ac-usage-reader'

/** Where the deployment projects that token into the daemon pod, and where the daemon reads it
 *  from. Not part of the verification, but the same two-sided agreement: the mounter and the
 *  reader are both in this repo, so one definition beats a comment asking them to match. */
export const CP_IDENTITY_TOKEN_PATH = '/var/run/ac-cp-identity/token'

/** Env var carrying the control plane's own WebSocket URL into an in-cluster daemon. The pod
 *  has no config file to read it from, and a URL is not a secret. Same two-sided agreement as
 *  the token path: the deployment sets it, the daemon reads it. */
export const CP_URL_ENV = 'AC_CP_URL'
/** Env var switching an in-cluster daemon's usage reporting off, for a deployment that meters
 *  upstream of the daemon and needs that plane to be the single writer. Same reason it is an
 *  env and not a config key alone: an in-cluster daemon has no config file to carry one. Read
 *  as a boolean — `false`/`0` disable, anything else leaves reporting on. */
export const USAGE_REPORTING_ENV = 'AC_USAGE_REPORTING'
/** Env var carrying the operator's workspace clone-origin allowlist into an in-cluster daemon,
 *  comma-separated. The policy is the OPERATOR's — a tenant can never widen it — and in a cluster
 *  the deployment is who that is, with no config file to say it in. Absent leaves the daemon's own
 *  default; a malformed entry is fatal rather than dropped, because a silently missing origin is a
 *  clone refused later with no trace of why. */
export const WORKSPACE_GIT_ORIGINS_ENV = 'AC_WORKSPACE_GIT_ALLOWED_ORIGINS'
/** A pool member's rollout generation (its pod-template hash), reported on register (frames/register.ts). */
export const POD_TEMPLATE_HASH_ENV = 'AC_POD_TEMPLATE_HASH'

/** CP answers the `agent/exists` batch existence query the pool's orphan reconciler
 *  asks before collecting a leaked sandbox object; a daemon that does not see it
 *  skips the sweep rather than emit a frame an older CP rejects as `UNKNOWN_FRAME`. */
export const AGENT_EXISTS_FEATURE = 'agent-exists-v1'

// ── GitLab.com code-host features (gitlab-com-integration.md §17.3) ─────────
// Each string is advertised only when its COMPLETE slice is live; the CP must
// never place a GitLab-shaped workspace, grant, or hook on a peer without it.

/** Daemon/relay serves the complete GitLab.com slice: hook normalization, credential
 *  routing, poster, and (relay) signed ingress. Gate for placement, snapshot projection,
 *  and rule broadcast — a GitLab-shaped value sent without it is frame-fatal downstream. */
export const GITLAB_COM_V1_FEATURE = 'gitlab-com-v1'

/** The default value of the GitLab host axis (§24.1). An absent host on a replicated
 *  agent spec, a compiled hook rule, trusted hook metadata, or a credential grant means
 *  this — the default of one axis, never a separate mode. */
export const GITLAB_DEFAULT_BASE_URL = 'https://gitlab.com'

/** Daemon/relay serves the self-managed-instance slice: the host carried per agent rather
 *  than assumed (§24.4). Gates placement, snapshot projection, hook assignment, and hook
 *  dispatch ONLY when the configured host is not `GITLAB_DEFAULT_BASE_URL`; on GitLab.com
 *  nothing is gated. Fail-closed by omission — a peer without it never sees self-managed
 *  work, so it cannot fall back to GitLab.com for it. */
export const GITLAB_INSTANCE_V1_FEATURE = 'gitlab-instance-v1'

/** True when a carried host names an instance other than GitLab.com — the only case anything
 *  gates (§24.4). Absent is the default value of the axis, so it is never self-managed. Lives
 *  here, not in one consumer: the control plane, the relay, and the daemon all read it. */
export function isSelfManagedGitlabHost(host: string | undefined): boolean {
  return host !== undefined && host !== GITLAB_DEFAULT_BASE_URL
}

/** Relay decodes `rc/hook-rerun` and answers its correlated admission REP
 *  (§16.1 Console "Run again"). Strictly newer than `gitlab-com-v1`: a relay
 *  advertising only that one cannot decode the frame, so the CP must select
 *  rerun targets on THIS bit alone. */
export const GITLAB_RERUN_V1_FEATURE = 'gitlab-rerun-v1'

/** CP serves provider-qualified gitcred v2 request/grant fields. A daemon must not name a
 *  provider before seeing this, and must reject a grant whose provider or numeric repository
 *  id differs from its request (an older CP strips new fields and answers GitHub-shaped). */
export const GITCRED_PROVIDER_V2_FEATURE = 'gitcred-provider-v2'

/** CP accepts an explicitly github-qualified credential request and echoes `provider: 'github'` back. */
export const GITCRED_GITHUB_V2_FEATURE = 'gitcred-github-v2'

/** Provider-routed formal-review surface (`submitCodeReview` and the provider-neutral
 *  review authorization/result frames). */
export const CODEHOST_REVIEW_V1_FEATURE = 'codehost-review-v1'

/** Informational status-note projection, each side attesting to its own half: the daemon renders
 *  and updates the note (desired/result frame pair), the CP drives the ledger end to end including
 *  the gitlab arm of `hook/start` that records the started head and opens `running`. */
export const CODEHOST_NOTE_PROJECTION_V1_FEATURE = 'codehost-note-projection-v1'

/** CP mints the §14.2 broker effect lease — `purpose: 'gitlab_effect'` on a gitcred v2 request,
 *  authorized by the agent's GitLab workspace binding or an enabled gitlab hook and clamped by the
 *  grant's echoed access. A daemon must not name that purpose before seeing this: a new enum value
 *  in a daemon→CP frame is frame-fatal to an older CP (§17.3), not a stripped field. */
export const GITLAB_EFFECT_V1_FEATURE = 'gitlab-effect-v1'
