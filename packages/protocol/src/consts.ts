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
