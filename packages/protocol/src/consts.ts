/**
 * Cross-package wire + lifecycle constants shared by the daemon and the CLI.
 *
 * These are pure data (no zod, no runtime deps) so both `@agentconnect.md/cli`
 * and `@agentconnect.md/daemon` can import them without pulling in each other:
 * the daemon dials the CP with the subprotocol/path, and the CLI's login probe
 * dials the same way; both the daemon (planned-exit code) and the CLI (run
 * respawn shell + generated service units) must agree on the restart exit code.
 */

/** The daemon↔CP WebSocket subprotocol negotiated on `ClientTransport.dial`. */
export const CP_SUBPROTOCOL = 'agentconnect.v1'

/** The CP mount path the daemon↔CP WebSocket connects to. */
export const CP_WS_PATH = '/daemon/ws'

/** CP accepts metadata-only transcript activity invalidations from current daemons. */
export const SESSION_LIVE_TAIL_FEATURE = 'session-live-tail-v1'

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
