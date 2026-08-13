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
 * `AGENTCONNECT_SUPERVISOR` value a cloud daemon runs under: Kubernetes, where the
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
 * This and {@link ENVELOPE_DAEMON_SA_NAME} are the two names the operator that stamps them
 * and the control plane that checks them must agree on exactly. They live here rather than
 * being configured on each side because a constant kept in two places eventually holds two
 * values: a rename passes every build and every test, since each side stays self-consistent,
 * and fails only at runtime when a real daemon's token is rejected. One definition makes that
 * a compile error instead.
 */
export const CP_TOKEN_AUDIENCE = 'ac-control-plane'

/** ServiceAccount the operator gives an envelope's daemon pod — the control plane's second
 *  check on a reviewed token, so a later change cannot authenticate some other pod in the
 *  same namespace. Shared for the same reason as {@link CP_TOKEN_AUDIENCE}. */
export const ENVELOPE_DAEMON_SA_NAME = 'ac-daemon'

/**
 * ServiceAccount a cloud daemon runs as. A cloud daemon serves EVERY org, so it lives in the
 * install's control namespace rather than in an org namespace, and no namespace⇒org mapping
 * can name its org — the org is a per-connection selector it declares in `auth`, which is
 * safe precisely because this ServiceAccount is an install-level principal. The
 * ServiceAccount name is therefore the discriminator between the two in-cluster identities:
 * an envelope daemon may only ever be its own namespace's org. Same two-sided agreement as
 * {@link ENVELOPE_DAEMON_SA_NAME}, except the party stamping it is the deployment rather
 * than the operator.
 */
export const CLOUD_DAEMON_SA_NAME = 'ac-cloud-daemon'

/** Where the operator projects that token into the daemon pod, and where the daemon reads it
 *  from. Not part of the verification, but the same two-sided agreement: the mounter and the
 *  reader are both in this repo, so one definition beats a comment asking them to match. */
export const CP_IDENTITY_TOKEN_PATH = '/var/run/ac-cp-identity/token'

/** Env var carrying the control plane's own WebSocket URL into an envelope daemon, from
 *  `spec.controlPlane.url`. The pod has no config file to read it from, and a URL is not a
 *  secret. Same two-sided agreement as the token path: the operator sets it, the daemon reads it. */
export const CP_URL_ENV = 'AC_CP_URL'
